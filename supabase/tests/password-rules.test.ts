import { describe, it, expect } from 'vitest';
import { beforeAll } from 'vitest';
import { anon, staff, cfg, db } from './helpers.js';
beforeAll(async () => { await db().query(`UPDATE app.rate_limits SET hits = 0 WHERE key LIKE 'admin-staff:%'`); });

// Customers: 8+ characters, any mix (the owner's choice). Staff: still 12+ with letters and digits (admin-staff function).
describe('password rules', () => {
  const email = (t: string) => `pw-${t}-${Date.now()}@example.com`;
  // The 8-character minimum is a Supabase Auth project setting (hosted). The local CLI stack always runs with its own
  // minimum of 6, so "7 characters is refused" is checked on the hosted project, not here.
  it('a customer can create an account with 8 letters and no numbers', async () => {
    const ok = await anon().auth.signUp({ email: email('ok'), password: 'lankatea' });
    expect(ok.error).toBeNull(); expect(ok.data.user?.id).toBeTruthy();
  });
  it('staff passwords still need 12+ characters with letters and numbers', async () => {
    const owner = await staff('owner1');
    const tok = (await owner.auth.getSession()).data.session!.access_token;
    const call = (pw: string) => fetch(`${cfg().url}/functions/v1/admin-staff`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: cfg().anon, authorization: `Bearer ${tok}` },
      body: JSON.stringify({ action: 'create', username: 'pwrule' + Date.now().toString().slice(-6), displayName: 'X', roles: ['support'], temporaryPassword: pw }) });
    const r1 = await call('lankatea'); expect(r1.status).toBe(400); expect((await r1.json()).message).toMatch(/12 characters/);
    const r2 = await call('lankateaislands'); expect(r2.status).toBe(400); expect((await r2.json()).message).toMatch(/letters and numbers/);
  });
});
