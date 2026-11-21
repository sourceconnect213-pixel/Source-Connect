import { describe, it, expect, beforeAll } from 'vitest';
import { anon, staff, customer, rpc, q1, db, cfg, setStock, stock, placeOrder } from './helpers.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Return / refund requests after delivery: who may ask, what, until when; staff steps; money and stock.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const deliver = async (num: string, daysAgo = 0) => {
  await db().query(`UPDATE app.orders SET status = 'delivered' WHERE order_number = $1`, [num]);
  await db().query(`INSERT INTO app.order_status_history (order_id, from_status, to_status, actor, created_at)
                    SELECT id, 'shipped', 'delivered', 'staff:test', now() - make_interval(days => $2) FROM app.orders WHERE order_number = $1`, [num, daysAgo]);
};
const items = async (num: string) => (await db().query(`SELECT oi.id, oi.product_slug, oi.quantity FROM app.order_items oi JOIN app.orders o ON o.id = oi.order_id WHERE o.order_number = $1 ORDER BY oi.product_slug`, [num])).rows;
const photo = (num: string, token: string | null, image: string, auth?: string) => fetch(`${cfg().url}/functions/v1/return-photo`, { method: 'POST',
  headers: { 'content-type': 'application/json', apikey: cfg().anon, authorization: `Bearer ${auth ?? cfg().anon}` }, body: JSON.stringify({ number: num, token, image }) });
const okData = (extra: Record<string, unknown> = {}) => ({ reason: 'damaged', details: 'The zip is broken on arrival.', wants: 'refund',
  bank: { bank: 'Commercial Bank', branch: 'Kandy', accountName: 'Nimal Perera', accountNumber: '8001234567' }, ...extra });
let o: { orderNumber: string; trackingToken: string };
let lines: any[];

beforeAll(async () => {
  await setStock('BAGS-6', 50); await setStock('BAGS-7', 50);
  await db().query(`UPDATE app.rate_limits SET hits = 0 WHERE key LIKE 'return%'`);
  const r = await placeOrder([{ id: 'bags-6', size: '', qty: 3 }, { id: 'bags-7', size: '', qty: 1 }]);
  expect(r.error).toBeNull(); o = r.data; lines = await items(o.orderNumber);
});

describe('return / refund requests', () => {
  it('not before delivery, not without the order token, not after the return window', async () => {
    const a = anon();
    const before = (await rpc(a, 'order_returns', { p_number: o.orderNumber, p_token: o.trackingToken })).data;
    expect(before).toMatchObject({ eligible: false, message: expect.stringMatching(/after the order is delivered/), windowDays: 7 });
    expect((await rpc(a, 'return_request_create', { p_number: o.orderNumber, p_token: o.trackingToken, p_data: okData({ items: [{ id: lines[0].id, qty: 1 }] }) })).error?.message).toMatch(/after the order is delivered/);
    const old = (await placeOrder([{ id: 'bags-7', size: '', qty: 1 }])).data; await deliver(old.orderNumber, 8);
    expect((await rpc(a, 'order_returns', { p_number: old.orderNumber, p_token: old.trackingToken })).data.message).toMatch(/7-day return period .* has ended/);
    expect((await photo(old.orderNumber, old.trackingToken, 'data:image/png;base64,' + PNG.toString('base64'))).status).toBe(400);
    await deliver(o.orderNumber, 1);
    expect((await rpc(a, 'order_returns', { p_number: o.orderNumber, p_token: 'wrong-token-1234567890' })).error?.message).toMatch(/Order not found/);
    expect((await rpc(a, 'order_returns', { p_number: o.orderNumber, p_token: null })).error?.message).toMatch(/Order not found/);
    const d = (await rpc(a, 'order_returns', { p_number: o.orderNumber, p_token: o.trackingToken })).data;
    expect(d).toMatchObject({ eligible: true, message: '', paymentMethod: 'cod', requests: [] });
    expect(d.items.map((i: any) => i.returnable).sort()).toEqual([1, 3]);
  });

  it('checks every field; never more than was bought; bank account needed for a Cash on Delivery refund', async () => {
    const a = anon(), call = (data: any) => rpc(a, 'return_request_create', { p_number: o.orderNumber, p_token: o.trackingToken, p_data: data });
    const one = [{ id: lines[0].id, qty: 1 }];
    expect((await call(okData({ items: one, reason: 'changed_my_mind' }))).error?.message).toMatch(/reason/);
    expect((await call(okData({ items: one, details: 'bad' }))).error?.message).toMatch(/10 to 1000/);
    expect((await call(okData({ items: one, wants: 'cash' }))).error?.message).toMatch(/refund or replacement/);
    expect((await call(okData({ items: [] }))).error?.message).toMatch(/at least one item/);
    expect((await call(okData({ items: [{ id: lines[0].id, qty: 4 }] }))).error?.message).toMatch(/at most 3/);
    expect((await call(okData({ items: [{ id: '00000000-0000-0000-0000-000000000000', qty: 1 }] }))).error?.message).toMatch(/not in this order/);
    expect((await call(okData({ items: one, bank: null }))).error).not.toBeNull();
    expect((await call(okData({ items: one, bank: { bank: 'BOC', accountName: 'N P', accountNumber: 'abcd' } }))).error?.message).toMatch(/account number/);
    expect((await call(okData({ items: one, photos: [`returns/${'0'.repeat(8)}-0000-0000-0000-000000000000/${'1'.repeat(8)}-1111-1111-1111-111111111111.jpg`] }))).error?.message).toMatch(/photo/);
    expect((await q1(`SELECT count(*)::int n FROM app.return_requests`)).n).toBe(0);   // nothing half-saved
    // replacement needs no bank account
    expect((await call({ reason: 'wrong_item', details: 'Got a blue one, ordered red.', wants: 'replacement', items: [{ id: lines[1].id, qty: 1 }] })).error).toBeNull();
  });

  it('photos: real JPEG/PNG/WebP only, 2 MB, stored privately, used once, only for this order', async () => {
    const good = await photo(o.orderNumber, o.trackingToken, 'data:image/png;base64,' + PNG.toString('base64'));
    expect(good.status).toBe(200); const { path } = await good.json();
    expect(path).toMatch(/^returns\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
    expect((await photo(o.orderNumber, o.trackingToken, 'data:image/png;base64,' + Buffer.from('<html>not an image').toString('base64'))).status).toBe(400);
    expect((await photo(o.orderNumber, o.trackingToken, 'data:image/jpeg;base64,' + PNG.toString('base64'))).status).toBe(400);   // says jpeg, is png
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)]);
    expect([400, 413]).toContain((await photo(o.orderNumber, o.trackingToken, 'data:image/jpeg;base64,' + big.toString('base64'))).status);
    expect((await photo(o.orderNumber, 'wrong-token-1234567890', 'data:image/png;base64,' + PNG.toString('base64'))).status).toBe(404);
    // the bucket is private: no public link, visitors cannot read it
    expect((await fetch(`${cfg().url}/storage/v1/object/public/return-photos/${path}`)).status).not.toBe(200);
    expect((await anon().storage.from('return-photos').createSignedUrl(path, 60)).error).not.toBeNull();
    const r = await rpc(anon(), 'return_request_create', { p_number: o.orderNumber, p_token: o.trackingToken, p_data: okData({ items: [{ id: lines[0].id, qty: 2 }], photos: [path] }) });
    expect(r.error).toBeNull();
    expect((await rpc(anon(), 'return_request_create', { p_number: o.orderNumber, p_token: o.trackingToken, p_data: okData({ items: [{ id: lines[0].id, qty: 1 }], photos: [path] }) })).error?.message).toMatch(/photo/);   // used once
    // the customer sees the count, not the file names, and never the bank details back
    const mine = (await rpc(anon(), 'order_returns', { p_number: o.orderNumber, p_token: o.trackingToken })).data;
    const req = mine.requests.find((x: any) => x.id === r.data.id);
    expect(req).toMatchObject({ status: 'requested', photos: 1, wants: 'refund', items: [{ qty: 2 }] });
    expect(JSON.stringify(mine)).not.toContain('8001234567');
    expect(mine.items.find((i: any) => i.id === lines[0].id).returnable).toBe(1);   // 3 bought, 2 asked for
    // staff who handle returns get a short link to the photo
    const sup = await staff('support1');
    const signed = await sup.storage.from('return-photos').createSignedUrl(path, 60);
    expect(signed.error).toBeNull(); expect((await fetch(signed.data!.signedUrl)).status).toBe(200);
    const ed = await staff('editor1');
    expect((await ed.storage.from('return-photos').createSignedUrl(path, 60)).error).not.toBeNull();
  });

  it('the customer withdraws a waiting request; not once it is approved', async () => {
    const a = anon(), base = { p_number: o.orderNumber, p_token: o.trackingToken };
    const r = await rpc(a, 'return_request_create', { ...base, p_data: okData({ items: [{ id: lines[0].id, qty: 1 }] }) });
    expect(r.error).toBeNull();
    expect((await rpc(a, 'return_request_cancel', { ...base, p_id: r.data.id })).error).toBeNull();
    expect((await rpc(a, 'order_returns', base)).data.items.find((i: any) => i.id === lines[0].id).returnable).toBe(1);   // freed again
    const sup = await staff('support1');
    const first = (await rpc(sup, 'admin_returns', { p_filter: 'requested' })).data.requests.find((x: any) => x.wants === 'refund' && x.order === o.orderNumber);
    expect((await rpc(sup, 'admin_return_update', { p_id: first.id, p_action: 'approve', p_note: 'Our courier will collect it.' })).error).toBeNull();
    expect((await rpc(a, 'return_request_cancel', { ...base, p_id: first.id })).error?.message).toMatch(/already being handled/);
  });

  it('staff steps in order; reject needs a reason; stock goes back; money needs refunds.create and a collected payment', async () => {
    const sup = await staff('support1'), owner = await staff('owner1');
    const list = (await rpc(sup, 'admin_returns', { p_filter: 'all' })).data;
    expect(list.canRefund).toBe(false);
    const refundReq = list.requests.find((x: any) => x.order === o.orderNumber && x.status === 'approved');
    const replReq = list.requests.find((x: any) => x.order === o.orderNumber && x.wants === 'replacement');
    expect(refundReq.bank).toBeNull();   // bank account only for people who pay refunds
    expect((await rpc(owner, 'admin_returns', { p_filter: 'all' })).data.requests.find((x: any) => x.id === refundReq.id).bank.accountNumber).toBe('8001234567');
    expect((await rpc(sup, 'admin_return_update', { p_id: replReq.id, p_action: 'reject', p_note: 'no' })).error?.message).toMatch(/why/);
    expect((await rpc(sup, 'admin_return_update', { p_id: replReq.id, p_action: 'receive' })).error?.message).toMatch(/not possible/);   // must be approved first
    expect((await rpc(sup, 'admin_return_update', { p_id: replReq.id, p_action: 'approve' })).error).toBeNull();
    const s0 = (await stock('BAGS-7')).on_hand;
    expect((await rpc(sup, 'admin_return_update', { p_id: replReq.id, p_action: 'receive', p_data: { restock: true } })).error).toBeNull();
    expect((await stock('BAGS-7')).on_hand).toBe(s0 + 1);
    expect((await rpc(sup, 'admin_return_update', { p_id: replReq.id, p_action: 'replace', p_note: 'New one sent, tracking ABC123.' })).error).toBeNull();
    // refund: support may not; owner only after the cash was collected; never more than paid
    expect((await rpc(sup, 'admin_return_update', { p_id: refundReq.id, p_action: 'refund', p_data: { amount: 100, reference: 'TRX-1' } })).error?.code).toBe('42501');
    expect((await rpc(owner, 'admin_return_update', { p_id: refundReq.id, p_action: 'refund', p_data: { amount: 100, reference: 'TRX-1' } })).error?.message).toMatch(/not recorded as received/);
    expect((await rpc(owner, 'admin_cod_collected', { p_number: o.orderNumber })).error).toBeNull();
    const total = Number((await q1(`SELECT total_cents FROM app.orders WHERE order_number = $1`, [o.orderNumber])).total_cents) / 100;
    expect((await rpc(owner, 'admin_return_update', { p_id: refundReq.id, p_action: 'refund', p_data: { amount: total + 1, reference: 'TRX-1' } })).error?.message).toMatch(/at most/);
    expect((await rpc(owner, 'admin_return_update', { p_id: refundReq.id, p_action: 'refund', p_data: { amount: 100, reference: 'x' } })).error?.message).toMatch(/reference/);
    expect((await rpc(owner, 'admin_return_update', { p_id: refundReq.id, p_action: 'refund', p_data: { amount: 100, reference: 'TRX-1' } })).error).toBeNull();
    expect(await q1(`SELECT status, payment_status FROM app.orders WHERE order_number = $1`, [o.orderNumber])).toEqual({ status: 'delivered', payment_status: 'partially_refunded' });
    expect((await q1(`SELECT amount_cents::int a FROM app.refunds WHERE reason LIKE $1`, [`return request #${refundReq.id}%`])).a).toBe(10000);
    expect((await rpc(owner, 'admin_return_update', { p_id: refundReq.id, p_action: 'refund', p_data: { amount: 1, reference: 'TRX-2' } })).error?.message).toMatch(/not possible/);   // once
    expect((await q1(`SELECT count(*)::int n FROM app.audit_logs WHERE entity_type = 'return' AND entity_id = $1`, [String(refundReq.id)])).n).toBe(2);
    // the customer sees the outcome and the shop's message
    const mine = (await rpc(anon(), 'order_returns', { p_number: o.orderNumber, p_token: o.trackingToken })).data.requests;
    expect(mine.find((x: any) => x.id === replReq.id)).toMatchObject({ status: 'replaced', staffNote: 'New one sent, tracking ABC123.' });
    expect(mine.find((x: any) => x.id === refundReq.id)).toMatchObject({ status: 'refunded', refund: 100, staffNote: 'Our courier will collect it.' });
  });

  it('a full refund closes the order as refunded; a signed-in buyer needs no token; others are refused', async () => {
    const me = await customer('Ruwan Silva'), other = await customer('Other Person'), owner = await staff('owner1');
    const r = await placeOrder([{ id: 'bags-6', size: '', qty: 1 }], 'cod', {}, me.id); await deliver(r.data.orderNumber);
    const it = (await items(r.data.orderNumber))[0];
    expect((await rpc(other.c, 'order_returns', { p_number: r.data.orderNumber, p_token: null })).error?.message).toMatch(/Order not found/);
    const q = await rpc(me.c, 'return_request_create', { p_number: r.data.orderNumber, p_token: null, p_data: okData({ items: [{ id: it.id, qty: 1 }] }) });
    expect(q.error).toBeNull();
    expect((await rpc(me.c, 'order_returns', { p_number: r.data.orderNumber, p_token: null })).data.eligible).toBe(false);   // nothing left to ask for
    await rpc(owner, 'admin_cod_collected', { p_number: r.data.orderNumber });
    await rpc(owner, 'admin_return_update', { p_id: q.data.id, p_action: 'approve' });
    const total = Number((await q1(`SELECT total_cents FROM app.orders WHERE order_number = $1`, [r.data.orderNumber])).total_cents) / 100;
    expect((await rpc(owner, 'admin_return_update', { p_id: q.data.id, p_action: 'refund', p_data: { amount: total, reference: 'TRX-FULL' } })).error).toBeNull();
    expect(await q1(`SELECT status, payment_status FROM app.orders WHERE order_number = $1`, [r.data.orderNumber])).toEqual({ status: 'refunded', payment_status: 'refunded' });
    // visitors and customers cannot use the staff functions
    expect((await rpc(anon(), 'admin_returns', {})).error).not.toBeNull();
    expect((await rpc(me.c, 'admin_returns', {})).error).not.toBeNull();
    expect((await rpc(me.c, 'admin_return_update', { p_id: q.data.id, p_action: 'approve' })).error).not.toBeNull();
  });
});
