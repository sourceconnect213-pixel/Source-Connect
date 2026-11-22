// POST /functions/v1/admin-staff — staff accounts (needs the caller's Supabase Auth token).
// The caller's permission (staff.manage) is checked by the DATABASE using the caller's own token;
// the service role is used only for the Supabase Auth admin calls that a browser can never make.
//   {action:"create", username, displayName, email?, roles[], shops[], temporaryPassword, secondStep?: "pin"|"totp", pin?}
//   {action:"update", id, username?, displayName?, roles?, shops?, status?, secondStep?, resetPassword?}
//   {action:"change-own-password", currentPassword, newPassword}   (any staff member, clears the temporary-password flag)
//   {action:"delete", id}   (main admin; rules checked in the database first, then the sign-in account is removed)
//   {action:"customer-password", id, newPassword}   (customers.write; a customer forgot their password and no email is sent)
import { ANON_KEY, clientIp, dbError, env, json, keyHeaders, preflight, rateLimited, readBody, rpc, SERVICE_KEY, userFrom } from '../_shared/common.ts';

const AUTH = `${env('SUPABASE_URL')}/auth/v1`;
const admin = (path: string, method: string, body?: unknown) =>
  fetch(`${AUTH}/admin${path}`, { method, headers: { ...keyHeaders(SERVICE_KEY), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
function passwordProblem(pw: unknown, username = ''): string | null {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use letters and numbers.';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'Do not include the username in the password.';
  if (new Set(pw).size < 6) return 'Use a mix of different characters.';
  return null;
}

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json(req, 405, { error: 'method_not_allowed' });
  if (await rateLimited('admin-staff:' + clientIp(req), 20, 60)) return json(req, 429, { error: 'rate_limited', message: 'Too many requests.' });
  const caller = await userFrom(req);
  if (!caller || caller === 'invalid') return json(req, 401, { error: 'unauthorized', message: 'Please sign in.' });
  let b: any; try { b = JSON.parse((await readBody(req, 10_000)) ?? ''); } catch { return json(req, 400, { error: 'bad_request', message: 'The request could not be read.' }); }

  if (b?.action === 'change-own-password') {
    const me = await (await fetch(`${AUTH}/user`, { headers: keyHeaders(ANON_KEY, caller.token) })).json();
    if (me?.app_metadata?.kind !== 'staff') return json(req, 403, { error: 'forbidden', message: 'Not a staff account.' });
    const problem = passwordProblem(b.newPassword, String(me.email ?? '').split('@')[0]);
    if (problem) return json(req, 400, { error: 'bad_request', message: problem });
    if (b.newPassword === b.currentPassword) return json(req, 400, { error: 'bad_request', message: 'Choose a different password.' });
    const check = await fetch(`${AUTH}/token?grant_type=password`, { method: 'POST', headers: { ...keyHeaders(ANON_KEY), 'content-type': 'application/json' }, body: JSON.stringify({ email: me.email, password: String(b.currentPassword ?? '') }) });
    if (!check.ok) return json(req, 400, { error: 'bad_request', message: 'Your current password is not correct.' });
    const u = await admin(`/users/${me.id}`, 'PUT', { password: b.newPassword, app_metadata: { ...me.app_metadata, must_change_password: false } });
    if (!u.ok) return json(req, 400, { error: 'bad_request', message: (await u.json())?.msg ?? 'Password not accepted.' });
    return json(req, 200, { ok: true, message: 'Password changed. Sign in again.' });
  }

  if (b?.action === 'create') {
    // permission check first (database, caller's token), before anything is created
    const pre = await rpc('admin_staff_list', {}, caller.token);
    if (!pre.ok) return dbError(req, pre);
    const problem = passwordProblem(b.temporaryPassword, b.username);
    if (problem) return json(req, 400, { error: 'bad_request', message: problem });
    if (b.secondStep !== undefined && b.secondStep !== 'pin' && b.secondStep !== 'totp') return json(req, 400, { error: 'bad_request', message: 'Choose PIN or authenticator app.' });
    if (b.secondStep === 'pin') {   // checked before anything is created (the database checks the same again)
      const pin = String(b.pin ?? '');
      if (!/^[0-9]{4,8}$/.test(pin)) return json(req, 400, { error: 'bad_request', message: 'The PIN must be 4 to 8 digits.' });
      if (/^(.)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return json(req, 400, { error: 'bad_request', message: 'That PIN is too easy to guess (same digit or 1234-style). Choose another.' });
    }
    const email = String(b.email || `${b.username}@staff.invalid`).trim().toLowerCase();
    const cu = await admin('/users', 'POST', { email, password: b.temporaryPassword, email_confirm: true, app_metadata: { kind: 'staff', must_change_password: true } });
    const created = await cu.json();
    if (!cu.ok) {
      const taken = cu.status === 422 && /already|exists|registered/i.test(String(created?.msg ?? created?.error_code ?? ''));
      return json(req, cu.status === 422 ? 409 : 400, { error: taken ? 'conflict' : 'bad_request', message: taken
        ? 'That email is already used by another account. One email can have only one account. For a second account that arrives in the same Gmail inbox, add + and a word before the @, for example yourname+coadmin@gmail.com. Or leave the email empty: the person then signs in with the username.'
        : created?.msg ?? 'Could not create the sign-in account.' });
    }
    const data: Record<string, unknown> = { username: b.username, displayName: b.displayName, email: b.email || '', roles: b.roles, shops: b.shops ?? [] };
    if (b.secondStep) data.secondStep = b.secondStep;
    const s = await rpc('admin_staff_save', { p_staff_id: created.id, p_data: data }, caller.token);
    if (!s.ok) { await admin(`/users/${created.id}`, 'DELETE'); return dbError(req, s); }   // undo: no half-created accounts
    if (b.secondStep === 'pin') {
      const p = await rpc('admin_set_staff_pin', { p_staff_id: created.id, p_pin: String(b.pin) }, caller.token);
      if (!p.ok) {   // undo everything, so the owner can simply try again
        await rpc('admin_staff_delete', { p_staff_id: created.id }, caller.token);
        await admin(`/users/${created.id}`, 'DELETE');
        return dbError(req, p);
      }
    }
    return json(req, 200, { id: created.id });
  }

  if (b?.action === 'update' && typeof b.id === 'string') {
    const data: Record<string, unknown> = {};
    for (const k of ['username', 'displayName', 'roles', 'shops', 'status', 'secondStep']) if (b[k] !== undefined) data[k] = b[k];
    let oldName: string | undefined;   // to undo a username change if the sign-in address cannot follow
    if (data.username !== undefined) {
      const l = await rpc('admin_staff_list', {}, caller.token);
      if (!l.ok) return dbError(req, l);
      oldName = (l.data?.staff ?? []).find((x: any) => x.id === b.id)?.username;
    }
    const s = await rpc('admin_staff_save', { p_staff_id: b.id, p_data: data }, caller.token);   // permission + validation in the database
    if (!s.ok) return dbError(req, s);
    const cur = await (await admin(`/users/${b.id}`, 'GET')).json();
    // accounts without an email sign in with the username: their sign-in address is <username>@staff.invalid
    if (oldName !== undefined && /@staff\.invalid$/i.test(String(cur?.email ?? ''))) {
      const want = `${String(b.username).trim().toLowerCase()}@staff.invalid`;
      if (String(cur.email).toLowerCase() !== want) {
        const e = await admin(`/users/${b.id}`, 'PUT', { email: want, email_confirm: true });
        if (!e.ok) {
          await rpc('admin_staff_save', { p_staff_id: b.id, p_data: { username: oldName } }, caller.token);
          return json(req, 409, { error: 'conflict', message: 'That username cannot be used for signing in. The username was not changed.' });
        }
      }
    }
    if (b.resetPassword) {
      const problem = passwordProblem(b.resetPassword); if (problem) return json(req, 400, { error: 'bad_request', message: problem });
      await admin(`/users/${b.id}`, 'PUT', { password: b.resetPassword, app_metadata: { ...cur.app_metadata, must_change_password: true } });
    }
    // disabled staff: blocked in the database at once (status check) and cannot sign in or refresh any more
    if (b.status === 'disabled') await admin(`/users/${b.id}`, 'PUT', { ban_duration: '876000h' });
    if (b.status === 'active') await admin(`/users/${b.id}`, 'PUT', { ban_duration: 'none' });
    return json(req, 200, { ok: true });
  }
  if (b?.action === 'delete' && typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id)) {
    const s = await rpc('admin_staff_delete', { p_staff_id: b.id }, caller.token);   // permission + "not yourself" + "keep an owner" in the database
    if (!s.ok) return dbError(req, s);
    const d = await admin(`/users/${b.id}`, 'DELETE');
    if (!d.ok && d.status !== 404) return json(req, 500, { error: 'server_error', message: 'The staff account was removed and can no longer open the admin, but its sign-in record could not be deleted. Remove it in the Supabase dashboard (Authentication → Users).' });
    return json(req, 200, { ok: true });
  }
  if (b?.action === 'customer-password' && typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id)) {
    const pw = b.newPassword;
    if (typeof pw !== 'string' || pw.length < 8) return json(req, 400, { error: 'bad_request', message: 'Use at least 8 characters.' });
    if (pw.length > 72) return json(req, 400, { error: 'bad_request', message: 'Password is too long.' });
    const s = await rpc('admin_customer_password_check', { p_id: b.id }, caller.token);   // permission + "is a customer" + audit, in the database
    if (!s.ok) return dbError(req, s);
    const u = await admin(`/users/${b.id}`, 'PUT', { password: pw });
    if (!u.ok) return json(req, 400, { error: 'bad_request', message: (await u.json())?.msg ?? 'Password not accepted.' });
    return json(req, 200, { ok: true });
  }
  return json(req, 400, { error: 'bad_request', message: 'Unknown action.' });
});
