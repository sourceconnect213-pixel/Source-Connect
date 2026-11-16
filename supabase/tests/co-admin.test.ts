// Two kinds of admin: the main admin (owner) can do everything; a co-admin runs the store and gets more only when
// the main admin approves it.
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, db, q1, rpc, service, staff, PW } from './helpers.js';
import type { SupabaseClient } from '@supabase/supabase-js';

let owner: SupabaseClient, co: SupabaseClient, coId: string;

beforeAll(async () => {
  // a co-admin account, made the same way as the other test staff (real Supabase Auth user)
  const email = `coadmin${Date.now()}@staff.test`;
  const { data, error } = await service().auth.admin.createUser({ email, password: PW, email_confirm: true, app_metadata: { kind: 'staff' } });
  if (error) throw error;
  coId = data.user!.id;
  await db().query(`INSERT INTO app.staff_users (id, username, email, display_name) VALUES ($1, $2, $3, 'Co Admin')`, [coId, email.split('@')[0], email]);
  await db().query(`INSERT INTO app.staff_roles (staff_id, role_id) SELECT $1, id FROM app.roles WHERE code = 'co_admin'`, [coId]);
  owner = await staff('owner1');
  co = await staff(email.split('@')[0]);
});

describe('co-admin: only the store work', () => {
  it('sees sales & profit, can set cost prices, products, stock, banners and promo codes', async () => {
    const me = (await rpc(co, 'admin_me')).data;
    expect(me.mainAdmin).toBe(false);
    expect(me.permissions).toEqual(expect.arrayContaining(['reports.view', 'costs.write', 'catalog.write', 'inventory.adjust', 'content.write', 'coupons.manage']));
    expect((await rpc(co, 'admin_sales_report', { p_from: '2026-01-01', p_to: '2026-12-31' })).error).toBeNull();
    expect((await rpc(co, 'admin_set_product_cost', { p_slug: 'mens-2', p_cost: 500, p_apply_to_past: false })).error).toBeNull();
    expect((await rpc(co, 'admin_coupons')).error).toBeNull();
    const banners = (await rpc(anon(), 'storefront_snapshot')).data.hero;
    expect((await rpc(co, 'admin_save_banners', { p_list: banners })).error).toBeNull();
  });
  it('cannot see orders, customers, payments, settings, staff, audit log, backups or renewals', async () => {
    for (const [fn, args] of [['admin_orders', {}], ['admin_customers', {}], ['admin_staff_list', {}], ['admin_audit', {}], ['admin_backups', {}],
      ['admin_renewals', {}], ['admin_access_overview', {}], ['admin_save_settings', { p_data: { shippingFee: 1 } }]] as const) {
      expect((await rpc(co, fn, args as any)).error?.code, fn).toBe('42501');
    }
  });
  it('the main admin keeps promo codes (they no longer need the shipping/payment setting permission)', async () => {
    expect((await rpc(owner, 'admin_coupons')).error).toBeNull();
    expect((await rpc(await staff('editor1'), 'admin_coupons')).error?.code).toBe('42501');
    expect((await rpc(owner, 'admin_me')).data.mainAdmin).toBe(true);
  });
});

describe('more access only when the main admin approves', () => {
  it('request -> nothing changes until approved -> approved -> works -> taken away -> blocked again', async () => {
    const r = await rpc(co, 'admin_request_access', { p_permission: 'orders.read', p_note: 'I need to see orders' });
    expect(r.error).toBeNull();
    // asking twice keeps one open request
    expect((await rpc(co, 'admin_request_access', { p_permission: 'orders.read' })).data.id).toBe(r.data.id);
    expect((await rpc(co, 'admin_orders')).error?.code).toBe('42501');
    const mine = (await rpc(co, 'admin_my_access')).data;
    expect(mine.permissions.find((p: any) => p.code === 'orders.read')).toMatchObject({ have: false, pending: true });

    // a co-admin cannot answer requests (not even their own)
    expect((await rpc(co, 'admin_decide_access', { p_id: r.data.id, p_approve: true })).error?.code).toBe('42501');

    const ov = (await rpc(owner, 'admin_access_overview')).data;
    expect(ov.pending).toBeGreaterThanOrEqual(1);
    expect(ov.requests.find((x: any) => x.id === r.data.id)).toMatchObject({ permission: 'orders.read', status: 'pending', note: 'I need to see orders' });
    expect((await rpc(owner, 'admin_decide_access', { p_id: r.data.id, p_approve: true, p_note: 'ok' })).error).toBeNull();
    expect((await rpc(owner, 'admin_decide_access', { p_id: r.data.id, p_approve: true })).code).toBe('conflict');

    expect((await rpc(co, 'admin_orders')).error).toBeNull();
    expect((await rpc(co, 'admin_me')).data.permissions).toContain('orders.read');
    expect((await q1(`SELECT count(*)::int n FROM app.audit_logs WHERE action = 'access.approve' AND entity_id = $1`, [coId])).n).toBe(1);

    // the main admin takes it away again
    expect((await rpc(owner, 'admin_set_extra_access', { p_staff_id: coId, p_permissions: [] })).error).toBeNull();
    expect((await rpc(co, 'admin_orders')).error?.code).toBe('42501');
  });
  it('a rejected request gives nothing', async () => {
    const r = await rpc(co, 'admin_request_access', { p_permission: 'customers.read' });
    expect((await rpc(owner, 'admin_decide_access', { p_id: r.data.id, p_approve: false, p_note: 'not needed' })).error).toBeNull();
    expect((await rpc(co, 'admin_customers')).error?.code).toBe('42501');
    expect((await rpc(co, 'admin_my_access')).data.requests[0]).toMatchObject({ permission: 'customers.read', status: 'rejected', decisionNote: 'not needed' });
  });
  it('giving access to other people can never be given or asked for', async () => {
    expect((await rpc(co, 'admin_request_access', { p_permission: 'staff.manage' })).code).toBe('bad_request');
    expect((await rpc(owner, 'admin_set_extra_access', { p_staff_id: coId, p_permissions: ['staff.manage'] })).code).toBe('bad_request');
    expect((await rpc(co, 'admin_set_extra_access', { p_staff_id: coId, p_permissions: ['orders.read'] })).error?.code).toBe('42501');
    expect((await rpc(co, 'admin_request_access', { p_permission: 'no.such' })).code).toBe('bad_request');
    expect((await rpc(co, 'admin_request_access', { p_permission: 'reports.view' })).code).toBe('bad_request');   // already has it
  });
  it('the main admin can give access directly; a disabled account loses everything', async () => {
    expect((await rpc(owner, 'admin_set_extra_access', { p_staff_id: coId, p_permissions: ['orders.read', 'settings.write'] })).error).toBeNull();
    expect((await rpc(co, 'admin_orders')).error).toBeNull();
    await db().query(`UPDATE app.staff_users SET status = 'disabled' WHERE id = $1`, [coId]);
    try { expect((await rpc(co, 'admin_orders')).error?.code).toBe('42501'); expect((await rpc(co, 'admin_sales_report', { p_from: '2026-01-01', p_to: '2026-01-02' })).error?.code).toBe('42501'); }
    finally { await db().query(`UPDATE app.staff_users SET status = 'active' WHERE id = $1`, [coId]); await rpc(owner, 'admin_set_extra_access', { p_staff_id: coId, p_permissions: [] }); }
  });
  it('visitors cannot call any of it', async () => {
    for (const fn of ['admin_request_access', 'admin_my_access', 'admin_access_overview', 'admin_decide_access', 'admin_set_extra_access'])
      expect((await anon().rpc(fn, {})).error, fn).not.toBeNull();
    const t = await q1(`SELECT has_table_privilege('authenticated', 'app.staff_extra_permissions', 'SELECT') a, has_table_privilege('anon', 'app.access_requests', 'SELECT') b`);
    expect(t).toEqual({ a: false, b: false });
  });
});
