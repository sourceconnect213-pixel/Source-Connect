import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { anon, db } from './helpers.js';

// Google sign-in must never take over an account that already exists (customer sign-ups are not email-verified),
// and staff accounts never take an OAuth sign-in at all. Inserts below are what Supabase Auth does on a Google sign-in.
describe('Google sign-in: linking guard', () => {
  const googleIdentity = (userId: string, email: string) => db().query(
    `INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at) VALUES ($1, $2, $3, 'google', now(), now())`,
    ['g-' + randomUUID(), userId, JSON.stringify({ sub: 'g', email, email_verified: true })]);

  it('a new Google person gets a customer account with their Google name', async () => {
    const id = randomUUID(), email = `g-new-${Date.now()}@example.com`;
    await db().query(`INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), '{"provider":"google","providers":["google"]}', $3, now(), now())`,
      [id, email, JSON.stringify({ name: 'Kamal Perera', full_name: 'Kamal Perera', email, email_verified: true })]);
    await googleIdentity(id, email);
    const c = await db().query(`SELECT name, email, phone FROM app.customers WHERE id = $1`, [id]);
    expect(c.rows[0]).toEqual({ name: 'Kamal Perera', email, phone: null });
  });

  it('Google is refused for an email that already has a password account', async () => {
    const email = `g-taken-${Date.now()}@example.com`;
    const su = await anon().auth.signUp({ email, password: 'lankatea-' + Date.now() });
    expect(su.error).toBeNull();
    await expect(googleIdentity(su.data.user!.id, email)).rejects.toThrow(/account_exists_use_password/);
    const ids = await db().query(`SELECT provider FROM auth.identities WHERE user_id = $1 ORDER BY provider`, [su.data.user!.id]);
    expect(ids.rows.map((r: any) => r.provider)).toEqual(['email']);
  });

  it('a staff account never takes a Google sign-in', async () => {
    const s = await db().query(`SELECT u.id, u.email FROM auth.users u WHERE u.raw_app_meta_data ->> 'kind' = 'staff' LIMIT 1`);
    expect(s.rows.length).toBe(1);
    await expect(googleIdentity(s.rows[0].id, s.rows[0].email)).rejects.toThrow(/account_exists_use_password/);
  });
});
