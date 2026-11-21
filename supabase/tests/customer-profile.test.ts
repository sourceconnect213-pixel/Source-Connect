import { describe, it, expect, beforeAll } from 'vitest';
import { anon, staff, rpc, q1, db, cfg, setStock, placeOrder } from './helpers.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Sign-up with phones + address (no email needed), profile photo (2 MB, own folder, max 3 files), staff password reset.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const uuid = () => crypto.randomUUID();
let c: SupabaseClient, id: string, email: string;

async function signUp(meta: Record<string, unknown>, password = 'colombo7') {
  const cl = anon(); const em = `prof-${Date.now()}-${Math.random().toString(16).slice(2, 6)}@example.com`;
  const { data, error } = await cl.auth.signUp({ email: em, password, options: { data: meta } });
  if (error) throw error;
  return { cl, id: data.user!.id, em, session: data.session };
}

beforeAll(async () => {
  await db().query(`UPDATE app.rate_limits SET hits = 0 WHERE key LIKE 'admin-staff:%'`);   // other test files used the per-minute allowance
  const s = await signUp({ name: 'Sunil Jayasinghe', phone: '0771234567', phone2: '0112345678', address: { line1: '12 Temple Road', city: 'Kandy', district: 'Kandy' } });
  c = s.cl; id = s.id; email = s.em;
  expect(s.session).toBeTruthy();   // no email confirmation step
});

describe('customer profile', () => {
  it('sign-up saves both phones and the address; a bad address never blocks the sign-up', async () => {
    const p = (await rpc(c, 'my_profile')).data;
    expect(p).toMatchObject({ name: 'Sunil Jayasinghe', phone: '0771234567', phone2: '0112345678', avatar: null, address: { line1: '12 Temple Road', city: 'Kandy', district: 'Kandy' } });
    const bad = await signUp({ name: 'No Address', phone: '0770000000', address: { line1: 'x', city: '', district: 'Atlantis' } });
    expect((await rpc(bad.cl, 'my_profile')).data).toMatchObject({ name: 'No Address', address: null });
    expect((await rpc(c, 'update_my_profile', { p_data: { name: 'Sunil Jayasinghe', phone: '0771234567', phone2: '0719998887' } })).data.phone2).toBe('0719998887');
    expect((await rpc(c, 'update_my_profile', { p_data: { name: 'Sunil Jayasinghe', phone: '0771234567', phone2: 'x'.repeat(21) } })).error).not.toBeNull();
  });

  it('profile photo: only into your own folder, JPEG/PNG/WebP up to 2 MB, at most 3 files; must exist before it is used', async () => {
    const own = `${id}/${uuid()}.png`;
    expect((await c.storage.from('avatars').upload(`${uuid()}/${uuid()}.png`, PNG, { contentType: 'image/png' })).error).not.toBeNull();   // someone else's folder
    expect((await c.storage.from('avatars').upload(`${id}/${uuid()}.png`, Buffer.from('<html>'), { contentType: 'text/html' })).error).not.toBeNull();
    expect((await c.storage.from('avatars').upload(`${id}/${uuid()}.jpg`, Buffer.alloc(2 * 1024 * 1024 + 10), { contentType: 'image/jpeg' })).error).not.toBeNull();
    expect((await anon().storage.from('avatars').upload(`${id}/${uuid()}.png`, PNG, { contentType: 'image/png' })).error).not.toBeNull();   // visitors
    expect((await rpc(c, 'set_my_avatar', { p_path: `${id}/${uuid()}.png` })).error?.message).toMatch(/Upload the photo first/);
    expect((await rpc(c, 'set_my_avatar', { p_path: `../${id}/x.png` })).error?.message).toMatch(/cannot be used/);
    expect((await c.storage.from('avatars').upload(own, PNG, { contentType: 'image/png' })).error).toBeNull();
    expect((await rpc(c, 'set_my_avatar', { p_path: own })).data.avatar).toBe(own);
    // the file is public (shown next to reviews)
    expect((await fetch(`${cfg().url}/storage/v1/object/public/avatars/${own}`)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await c.storage.from('avatars').upload(`${id}/${uuid()}.png`, PNG, { contentType: 'image/png' })).error).toBeNull();
    expect((await c.storage.from('avatars').upload(`${id}/${uuid()}.png`, PNG, { contentType: 'image/png' })).error).not.toBeNull();   // 4th file
    // a different signed-in person cannot use or delete this file
    const other = await signUp({ name: 'Other Person' });
    expect((await rpc(other.cl, 'set_my_avatar', { p_path: own })).error).not.toBeNull();
    await other.cl.storage.from('avatars').remove([own]);
    expect((await q1(`SELECT count(*)::int n FROM storage.objects WHERE bucket_id = 'avatars' AND name = $1`, [own])).n).toBe(1);
    // the owner can delete their old files and remove the photo
    const mine = (await db().query(`SELECT name FROM storage.objects WHERE bucket_id = 'avatars' AND name LIKE $1 AND name <> $2`, [id + '/%', own])).rows.map(r => r.name);
    expect((await c.storage.from('avatars').remove(mine)).error).toBeNull();
    expect((await q1(`SELECT count(*)::int n FROM storage.objects WHERE bucket_id = 'avatars' AND name LIKE $1`, [id + '/%'])).n).toBe(1);
  });

  it('the reviewer photo shows with their review', async () => {
    await setStock('BAGS-5', 50);
    const r = await placeOrder([{ id: 'bags-5', size: '', qty: 1 }], 'cod', {}, id);
    await db().query(`UPDATE app.orders SET status = 'delivered' WHERE order_number = $1`, [r.data.orderNumber]);
    expect((await rpc(c, 'submit_review', { p_number: r.data.orderNumber, p_token: null, p_product: 'bags-5', p_rating: 5, p_comment: 'Great' })).error).toBeNull();
    const pub = (await rpc(anon(), 'product_reviews', { p_product: 'bags-5' })).data;
    const mineRev = pub.reviews.find((x: any) => x.comment === 'Great');
    expect(mineRev.avatar).toMatch(new RegExp('^' + id + '/'));
    expect(JSON.stringify(pub)).not.toContain(email);
    expect((await rpc(c, 'set_my_avatar', { p_path: null })).data.avatar).toBeNull();
    expect((await rpc(anon(), 'product_reviews', { p_product: 'bags-5' })).data.reviews.find((x: any) => x.comment === 'Great').avatar).toBeNull();
  });

  it('staff: accounts list (customers.read); a new password only with customers.write; never for staff accounts', async () => {
    const owner = await staff('owner1'), sup = await staff('support1');
    const list = (await rpc(sup, 'admin_customer_accounts', { p_q: 'Jayasinghe' })).data;
    expect(list[0]).toMatchObject({ id, name: 'Sunil Jayasinghe', phone: '0771234567', address: '12 Temple Road, Kandy, Kandy' });
    expect((await rpc(c, 'admin_customer_accounts', {})).error).not.toBeNull();
    const call = async (cl: SupabaseClient, body: unknown) => fetch(`${cfg().url}/functions/v1/admin-staff`, { method: 'POST',
      headers: { 'content-type': 'application/json', apikey: cfg().anon, authorization: `Bearer ${(await cl.auth.getSession()).data.session!.access_token}` }, body: JSON.stringify(body) });
    expect((await call(sup, { action: 'customer-password', id, newPassword: 'newpass88' })).status).toBe(403);
    expect((await call(owner, { action: 'customer-password', id, newPassword: 'short' })).status).toBe(400);
    const ownerId = (await q1(`SELECT id FROM app.staff_users WHERE username = 'owner1'`)).id;
    expect((await call(owner, { action: 'customer-password', id: ownerId, newPassword: 'newpass88' })).status).toBe(404);
    expect((await call(owner, { action: 'customer-password', id, newPassword: 'newpass88' })).status).toBe(200);
    expect((await anon().auth.signInWithPassword({ email, password: 'newpass88' })).error).toBeNull();
    expect((await anon().auth.signInWithPassword({ email, password: 'colombo7' })).error).not.toBeNull();
    expect((await q1(`SELECT count(*)::int n FROM app.audit_logs WHERE action = 'customer.password_reset' AND entity_id = $1`, [id])).n).toBe(1);
  });
});
