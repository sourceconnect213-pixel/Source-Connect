import { describe, it, expect, beforeAll } from 'vitest';
import { anon, staff, customer, rpc, q1, db, setStock, placeOrder } from './helpers.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Product reviews: only the buyer of a DELIVERED order can rate an item; staff with reviews.manage hide / reply.
const deliver = (num: string) => db().query(`UPDATE app.orders SET status = 'delivered' WHERE order_number = $1`, [num]);
const prod = (slug: string) => q1(`SELECT rating::text r, reviews_count n FROM app.products WHERE slug = $1`, [slug]);
let guestOrder: { orderNumber: string; trackingToken: string };

beforeAll(async () => {
  await setStock('BAGS-4', 50); await setStock('BAGS-5', 50);
  await db().query(`DELETE FROM app.rate_limits WHERE key LIKE 'review:%'`);
  const r = await placeOrder([{ id: 'bags-4', size: '', qty: 1 }, { id: 'bags-5', size: '', qty: 1 }]);
  expect(r.error).toBeNull(); guestOrder = r.data;
});

describe('product reviews', () => {
  it('nobody can review before delivery, without the order token, or a product that is not in the order', async () => {
    const a = anon(), o = guestOrder;
    const early = await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: o.trackingToken, p_product: 'bags-4', p_rating: 5, p_comment: 'x' });
    expect(early.error?.message).toMatch(/after the order is delivered/);
    expect((await rpc(a, 'order_reviews', { p_number: o.orderNumber, p_token: o.trackingToken })).data.canReview).toBe(false);
    await deliver(o.orderNumber);
    expect((await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: 'wrong-token-1234567890', p_product: 'bags-4', p_rating: 5 })).error?.message).toMatch(/Order not found/);
    expect((await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: null, p_product: 'bags-4', p_rating: 5 })).error?.message).toMatch(/Order not found/);
    expect((await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: o.trackingToken, p_product: 'mens-1', p_rating: 5 })).error?.message).toMatch(/not in this order/);
    for (const bad of [0, 6, null]) expect((await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: o.trackingToken, p_product: 'bags-4', p_rating: bad })).error?.message).toMatch(/1 to 5 stars/);
    expect((await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: o.trackingToken, p_product: 'bags-4', p_rating: 5, p_comment: 'buy at www.cheap.example' })).error?.message).toMatch(/links/);
    expect((await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: o.trackingToken, p_product: 'bags-4', p_rating: 5, p_comment: 'x'.repeat(1001) })).error?.message).toMatch(/1000/);
    expect((await prod('bags-4')).n).toBe(0);
  });

  it('the buyer rates; the public sees a short name, the average and the star counts; one review per item, which can be changed', async () => {
    const a = anon(), o = guestOrder;
    expect((await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: o.trackingToken, p_product: 'bags-4', p_rating: 4, p_comment: '  Good bag, strong zip.  ' })).data).toEqual({ ok: true });
    expect((await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: o.trackingToken, p_product: 'bags-5', p_rating: 2 })).data).toEqual({ ok: true });   // stars only
    expect(await prod('bags-4')).toEqual({ r: '4.0', n: 1 });
    const mine = (await rpc(a, 'order_reviews', { p_number: o.orderNumber, p_token: o.trackingToken })).data;
    expect(mine.canReview).toBe(true);
    expect(mine.items.find((i: any) => i.id === 'bags-4').review).toMatchObject({ rating: 4, comment: 'Good bag, strong zip.', status: 'visible' });
    // change it: still one review
    expect((await rpc(a, 'submit_review', { p_number: o.orderNumber, p_token: o.trackingToken, p_product: 'bags-4', p_rating: 5, p_comment: 'Even better after a month.' })).error).toBeNull();
    expect((await q1(`SELECT count(*)::int n FROM app.product_reviews r JOIN app.products p ON p.id = r.product_id WHERE p.slug = 'bags-4'`)).n).toBe(1);
    // a second delivered order of the same product: a second review, and the average follows
    const r2 = await placeOrder([{ id: 'bags-4', size: '', qty: 1 }]); await deliver(r2.data.orderNumber);
    expect((await rpc(a, 'submit_review', { p_number: r2.data.orderNumber, p_token: r2.data.trackingToken, p_product: 'bags-4', p_rating: 2, p_comment: 'Strap broke.' })).error).toBeNull();
    expect(await prod('bags-4')).toEqual({ r: '3.5', n: 2 });
    const pub = (await rpc(a, 'product_reviews', { p_product: 'bags-4' })).data;
    expect(pub).toMatchObject({ count: 2, average: 3.5, stars: { '5': 1, '4': 0, '3': 0, '2': 1, '1': 0 }, matching: 2 });
    expect(pub.reviews[0]).toMatchObject({ name: 'Nimal P.', rating: 2, comment: 'Strap broke.' });   // newest first
    const json = JSON.stringify(pub);
    for (const secret of ['Perera', '0771234567', 'nimal@example.com', o.orderNumber, 'Temple']) expect(json).not.toContain(secret);
    expect((await rpc(a, 'product_reviews', { p_product: 'bags-4', p_stars: 5 })).data).toMatchObject({ matching: 1, reviews: [{ rating: 5 }] });
    expect((await rpc(a, 'product_reviews', { p_product: 'no-such-product' })).data).toBeNull();
    // the browser cannot read or write the table directly
    expect((await a.schema('app' as any).from('product_reviews').select('*')).error).not.toBeNull();
  });

  it('a signed-in customer reviews their own order without a token; another customer cannot', async () => {
    const me = await customer('Kamala Silva'), other = await customer('Someone Else');
    const r = await placeOrder([{ id: 'bags-5', size: '', qty: 1 }], 'cod', {}, me.id); await deliver(r.data.orderNumber);
    expect((await rpc(other.c, 'submit_review', { p_number: r.data.orderNumber, p_token: null, p_product: 'bags-5', p_rating: 1 })).error?.message).toMatch(/Order not found/);
    expect((await rpc(me.c, 'submit_review', { p_number: r.data.orderNumber, p_token: null, p_product: 'bags-5', p_rating: 5, p_comment: 'Lovely' })).error).toBeNull();
    expect((await q1(`SELECT customer_id FROM app.product_reviews WHERE order_id = (SELECT id FROM app.orders WHERE order_number = $1)`, [r.data.orderNumber])).customer_id).toBe(me.id);
  });

  it('staff hide and reply; a hidden review leaves the average and stays hidden when the buyer edits it; others are refused', async () => {
    const co = await staff('owner1');
    const list = (await rpc(co, 'admin_reviews', { p_filter: 'low' })).data;
    const bad = list.reviews.find((x: any) => x.product === 'bags-4');
    expect(bad).toMatchObject({ rating: 2, buyer: 'Nimal Perera', name: 'Nimal P.' }); expect(bad.order).toMatch(/^SC-/);
    expect((await rpc(co, 'admin_review_update', { p_id: bad.id, p_reply: 'Sorry! We will send a new strap.' })).error).toBeNull();
    expect((await rpc(anon(), 'product_reviews', { p_product: 'bags-4' })).data.reviews[0].reply).toBe('Sorry! We will send a new strap.');
    expect((await rpc(co, 'admin_review_update', { p_id: bad.id, p_status: 'hidden' })).error).toBeNull();
    expect(await prod('bags-4')).toEqual({ r: '5.0', n: 1 });
    expect((await rpc(anon(), 'product_reviews', { p_product: 'bags-4' })).data.count).toBe(1);
    expect((await rpc(co, 'admin_reviews', { p_filter: 'hidden' })).data.reviews.map((x: any) => x.id)).toContain(bad.id);
    // the buyer edits it: it stays hidden, the reply is kept
    const num = bad.order, tok = null;
    await db().query(`UPDATE app.orders SET tracking_token_hash = app.sha256_hex('edit-test-token-123') WHERE order_number = $1`, [num]);
    expect((await rpc(anon(), 'submit_review', { p_number: num, p_token: 'edit-test-token-123', p_product: 'bags-4', p_rating: 1, p_comment: 'Still bad' })).error).toBeNull();
    expect((await q1(`SELECT status, reply FROM app.product_reviews WHERE id = $1`, [bad.id]))).toEqual({ status: 'hidden', reply: 'Sorry! We will send a new strap.' });
    expect(await prod('bags-4')).toEqual({ r: '5.0', n: 1 });
    expect((await rpc(co, 'admin_review_update', { p_id: bad.id, p_status: 'visible', p_reply: '' })).error).toBeNull();
    expect((await q1(`SELECT status, reply, replied_at FROM app.product_reviews WHERE id = $1`, [bad.id]))).toEqual({ status: 'visible', reply: '', replied_at: null });
    expect(await prod('bags-4')).toEqual({ r: '3.0', n: 2 });
    expect((await q1(`SELECT count(*)::int n FROM app.audit_logs WHERE entity_type = 'review' AND entity_id = $1`, [String(bad.id)])).n).toBe(3);
    expect((await rpc(co, 'admin_review_update', { p_id: bad.id, p_status: 'deleted' })).error).not.toBeNull();
    // co-admin may moderate; a catalog editor and visitors may not
    const fin = await staff('editor1');
    expect((await rpc(fin, 'admin_reviews', {})).error?.code).toBe('42501');
    expect((await rpc(fin, 'admin_review_update', { p_id: bad.id, p_status: 'hidden' })).error?.code).toBe('42501');
    expect((await rpc(anon(), 'admin_reviews', {})).error).not.toBeNull();
    expect((await q1(`SELECT count(*)::int n FROM app.role_permissions rp JOIN app.roles r ON r.id = rp.role_id WHERE rp.permission = 'reviews.manage' AND r.code = 'co_admin'`)).n).toBe(1);
    void tok;
  });

  it('too many changes from one order are refused for a while', async () => {
    const o = guestOrder;
    await db().query(`DELETE FROM app.rate_limits WHERE key LIKE 'review:%'`);
    let last: any;
    for (let i = 0; i < 31; i++) last = await rpc(anon(), 'submit_review', { p_number: o.orderNumber, p_token: o.trackingToken, p_product: 'bags-5', p_rating: 3 });
    expect(last.error?.message).toMatch(/Too many changes/);
    await db().query(`DELETE FROM app.rate_limits WHERE key LIKE 'review:%'`);
  });
});
