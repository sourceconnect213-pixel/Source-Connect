import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { anon, staff, rpc, db } from './helpers.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// A new product with several sizes: the admin sends the stock of EACH size. (A single total goes to the first size only,
// which left the other sizes sold out on the website: the reason the admin form now asks per size.)
let editor: SupabaseClient;
const base = { category: 'mens', brand: 'Test', price: 1500, sizes: ['S', 'M', 'L'], collections: [], images: [], origin: 'local' };
const stockOf = async (slug: string) => {
  const p = (await rpc(anon(), 'get_product', { p_slug: slug })).data;
  return Object.fromEntries(p.variants.map((v: any) => [v.size, v.stock]));
};

beforeAll(async () => { editor = await staff('editor1'); });
afterAll(async () => { await db().query(`UPDATE app.products SET status = 'archived' WHERE slug IN ('size-stock-a', 'size-stock-b')`); });

describe('stock per size for a new product', () => {
  it('stockBySize gives each size its own stock; the website sees it per size', async () => {
    const r = await rpc(editor, 'admin_save_product', { p_slug: null, p_data: { ...base, id: 'size-stock-a', name: 'Size stock A', stockBySize: { S: 0, M: 4, L: 7 } } });
    expect(r.error).toBeNull();
    expect(await stockOf('size-stock-a')).toEqual({ S: 0, M: 4, L: 7 });
    const snap = (await rpc(anon(), 'storefront_snapshot')).data.products.find((p: any) => p.id === 'size-stock-a');
    expect(snap.stock).toBe(11);
    expect(snap.variants.map((v: any) => [v.size, v.stock])).toEqual([['S', 0], ['M', 4], ['L', 7]]);
  });

  it('a single total goes to the first size only (so the form must ask per size)', async () => {
    const r = await rpc(editor, 'admin_save_product', { p_slug: null, p_data: { ...base, id: 'size-stock-b', name: 'Size stock B', stock: 20 } });
    expect(r.error).toBeNull();
    expect(await stockOf('size-stock-b')).toEqual({ S: 20, M: 0, L: 0 });
  });

  it('refuses bad per-size numbers', async () => {
    const bad = await rpc(editor, 'admin_save_product', { p_slug: null, p_data: { ...base, id: 'size-stock-c', name: 'Size stock C', stockBySize: { S: -1, M: 2, L: 2 } } });
    expect(bad.error).not.toBeNull();
    expect((await rpc(anon(), 'get_product', { p_slug: 'size-stock-c' })).data).toBeFalsy();
  });
});
