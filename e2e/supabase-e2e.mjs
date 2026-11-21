// Browser end-to-end test of the storefront + admin against a LOCAL Supabase stack (never production).
// Prereqs: `supabase start` + `supabase db reset`, Edge Functions served with supabase/functions/.env (test values),
// the repository served on $SITE (default http://127.0.0.1:8000).
// Usage: node e2e/supabase-e2e.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
const req = createRequire(import.meta.url);
const { chromium, devices } = req('playwright');
const { authenticator } = createRequire(new URL('../supabase/tests/package.json', import.meta.url))('otplib');
const env = Object.fromEntries(execSync('npx -y supabase@2 status -o env', { cwd: new URL('..', import.meta.url).pathname }).toString().split('\n')
  .map(l => /^([A-Z_]+)="(.*)"$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
const SB = env.API_URL, ANON = env.ANON_KEY, SERVICE = env.SERVICE_ROLE_KEY;
if (!/^http:\/\/127\.0\.0\.1/.test(SB)) throw new Error('refusing to run against a non-local Supabase');
const SITE = process.env.SITE || 'http://127.0.0.1:8000';
const MID = '1211149', SECRET = 'local-test-secret-not-real';   // supabase/functions/.env test values
const OUT = 'e2e/out'; fs.mkdirSync(OUT, { recursive: true });
const results = []; let failed = 0; const errors = [];
const check = (name, ok, extra = '') => { results.push((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); if (!ok) failed++; };
const md5U = s => crypto.createHash('md5').update(s).digest('hex').toUpperCase();
process.on('uncaughtException', e => { console.log(results.join('\n')); console.log('CRASH: ' + String(e && e.message || e).split('\n')[0]); console.log('errors: ' + errors.join(' | ')); process.exit(1); });
process.on('unhandledRejection', e => { console.log(results.join('\n')); console.log('CRASH: ' + String(e && e.message || e).split('\n')[0]); console.log('errors: ' + errors.join(' | ')); process.exit(1); });
const rpc = async (fn, args = {}) => (await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify(args) })).json();

// ---- owner account for the test (Supabase Auth + staff row), MFA required as in production ----
const OWNER = { email: 'owner-e2e@staff.test', password: 'Owner-E2e-Pass-2026' };
const sql = (q) => execSync(`psql "${env.DB_URL}" -tAc "${q.replace(/"/g, '\\"')}"`).toString().trim();
let ownerId = sql(`SELECT id FROM auth.users WHERE email = '${OWNER.email}'`);
if (!ownerId) {
  const r = await (await fetch(`${SB}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password, email_confirm: true, app_metadata: { kind: 'staff' } }) })).json();
  ownerId = r.id;
  sql(`INSERT INTO app.staff_users (id, username, email, display_name) VALUES ('${ownerId}', 'ownere2e', '${OWNER.email}', 'E2E Owner')`);
  sql(`INSERT INTO app.staff_roles (staff_id, role_id) SELECT '${ownerId}', id FROM app.roles WHERE code = 'owner'`);
}
sql(`DELETE FROM auth.mfa_factors WHERE user_id = '${ownerId}'`);   // enrol a fresh authenticator every run
sql(`DELETE FROM app.rate_limits`);
sql(`DELETE FROM app.product_costs WHERE product_id = (SELECT id FROM app.products WHERE slug = 'mens-1')`);   // the report test enters this cost itself   // the API tests and this browser share one local gateway IP, so start with clean limiter counters
sql(`UPDATE app.security_settings SET require_staff_mfa = true`);
sql(`UPDATE app.ops_settings SET payhere_configured = true`);

const b = await chromium.launch();
async function ctx(opts = {}) {
  const c = await b.newContext({ viewport: { width: 1366, height: 860 }, ...opts });
  await c.addInitScript(() => { try { sessionStorage.setItem('scg_intro_seen', '1'); localStorage.setItem('scg_intro_seen', '1'); } catch (e) {} });
  await c.route('https://sandbox.payhere.lk/**', async r => { c._payhere = r.request().postData(); await r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayHere sandbox (stub)</h1>' }); });
  return c;
}
const page = async (c, name) => { const p = await c.newPage(); p.on('pageerror', e => errors.push(name + ': ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 160)); }); return p; };
const withSb = (path) => { const i = path.indexOf('#'); const p = i < 0 ? path : path.slice(0, i), h = i < 0 ? '' : path.slice(i); return `${SITE}/${p}${p.includes('?') ? '&' : '?'}supabase=${encodeURIComponent(SB)}&anon=${encodeURIComponent(ANON)}${h}`; };
const inStock = async (slug) => { const p = await rpc('get_product', { p_slug: slug }); const v = (p.variants || []).slice().sort((a, b) => b.stock - a.stock)[0]; return v ? v.size : ''; };
const cartWith = async (pg, slug) => { const size = await inStock(slug); await pg.evaluate(([id, sz]) => { SCG.saveCart([{ id, size: sz, qty: 1, sel: true }]); location.hash = 'checkout'; }, [slug, size]); };

// 1. storefront from Supabase
const shopper = await ctx(); const sp = await page(shopper, 'shop');
await sp.goto(withSb('')); await sp.waitForSelector('.card', { timeout: 20000 });
check('storefront renders products from Supabase', (await sp.$$('.card')).length > 10);
await sp.screenshot({ path: OUT + '/sb-home-desktop.jpg', type: 'jpeg', quality: 70 });

// 2. admin: password, then two-step sign-in (QR/secret shown, code from an authenticator)
const adminC = await ctx(); const ap = await page(adminC, 'admin');
const toasts = []; await ap.exposeFunction('__toast', t => toasts.push(t)); await ap.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { new MutationObserver(() => { const t = document.getElementById('toast'); if (t && t.textContent) window.__toast(t.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true }); }); });
await ap.goto(withSb('admin/'));
await ap.fill('input[name=user]', 'admin'); await ap.fill('input[name=pass]', 'admin123'); await ap.click('#loginForm button:not(.pw-eye)'); await ap.waitForTimeout(1200);
check('old default login is refused', /incorrect/i.test(await ap.textContent('#loginErr')));
await ap.fill('input[name=user]', OWNER.email); await ap.fill('input[name=pass]', OWNER.password); await ap.click('#loginForm button:not(.pw-eye)');
await ap.waitForSelector('#mfaHelp', { timeout: 15000 });
await ap.waitForFunction(() => /scan|authenticator/i.test(document.querySelector('#mfaHelp')?.textContent || ''), null, { timeout: 15000 });
let secret = (await ap.textContent('#mfaQr').catch(() => '')).match(/key:\s*([A-Z2-7]{16,})/)?.[1];
check('staff must set up two-step sign-in (QR + key shown)', !!secret || /authenticator app/i.test(await ap.textContent('#mfaHelp')));
await ap.fill('input[name=code]', authenticator.generate(secret)); await ap.click('#loginForm button.primary');
await ap.waitForSelector('#shell:not([hidden])', { timeout: 20000 }); await ap.waitForTimeout(1500);
check('owner reaches the dashboard after the 6-digit code', await ap.isVisible('#shell'));
await ap.screenshot({ path: OUT + '/sb-admin-dashboard.jpg', type: 'jpeg', quality: 70 });

// 3. inline price edit saved in Supabase and seen on ANOTHER device
const before = await rpc('get_product', { p_slug: 'mens-12' });
const newPrice = before.price + 10;
await ap.evaluate(() => { location.hash = 'products'; }); await ap.waitForTimeout(1000);
await ap.fill('#pq', before.name); await ap.waitForTimeout(500);
const priceInput = ap.locator('#ptb tr[data-id="mens-12"] [data-f=price]');
await priceInput.fill(String(newPrice)); await priceInput.press('Tab');
await ap.waitForFunction(() => !SCG.syncing(), null, { timeout: 20000 }); await ap.waitForTimeout(400);
check('admin price edit saved in Supabase', (await rpc('get_product', { p_slug: 'mens-12' })).price === newPrice);
const other = await ctx(); const op = await page(other, 'other-device');
await op.goto(withSb('#p/mens-12')); await op.waitForTimeout(2500);
check('a different browser sees the new price', (await op.textContent('body')).includes(newPrice.toLocaleString('en-US')));

// 4. product form: stock per size, no fake ratings, photo to Supabase Storage
await ap.evaluate(() => { location.hash = 'products/edit:mens-12'; }); await ap.waitForSelector('#modal.open form', { timeout: 15000 });
check('product form shows stock per size', (await ap.$$('#modal input[data-size]')).length >= 3);
check('rating/reviews/sold cannot be typed in', !(await ap.isVisible('#modal input[name=rating]')));
await ap.fill('#modal input[name=name]', before.name + ' (Edited)');
fs.writeFileSync(OUT + '/pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const fileInput = await ap.$('#modal input[type=file]');
if (fileInput) { await fileInput.setInputFiles(OUT + '/pixel.png'); await ap.waitForTimeout(1000); }
await ap.click('#modal button:has-text("Save Changes")');
await ap.waitForFunction(() => !SCG.syncing(), null, { timeout: 25000 }); await ap.waitForTimeout(600);
const edited = await rpc('get_product', { p_slug: 'mens-12' });
check('product form edit saved (name)', edited.name === before.name + ' (Edited)');
check('photo stored in Supabase Storage (not base64)', !!edited.images[0] && edited.images[0].includes('/storage/v1/object/public/product-images/'), edited.images[0] || 'none');
check('uploaded photo is served', !!edited.images[0] && (await fetch(edited.images[0])).status === 200);

// 5. guest COD order through the checkout Edge Function
await sp.goto(withSb('#p/mens-1')); await sp.waitForTimeout(1500);
await cartWith(sp, 'mens-1');
await sp.waitForSelector('#placeBtn:not([disabled])', { timeout: 20000 });
await sp.fill('#co [name=name]', 'Test Buyer'); await sp.fill('#co [name=phone]', '0771234567'); await sp.fill('#co [name=address]', '12 Temple Road'); await sp.fill('#co [name=city]', 'Kandy');
await sp.selectOption('#co [name=district]', 'Kandy'); await sp.check('#co input[value="Cash on Delivery"]');
await sp.click('#placeBtn'); await sp.waitForSelector('.success', { timeout: 20000 });
const codNo = (await sp.textContent('.success')).match(/SC-\d{6}-[A-Z0-9]{6}/)?.[0];
check('guest COD order placed', !!codNo, codNo);
await sp.click('a:has-text("Track order")'); await sp.waitForSelector('#ordBox h2', { timeout: 20000 }); await sp.waitForTimeout(1500);
check('buyer sees the order on this device (private token)', (await sp.textContent('#ordBox')).includes('Pay on delivery'));
const third = await ctx(); const tp = await page(third, 'stranger');
await tp.goto(withSb('#order/' + codNo)); await tp.waitForTimeout(2500);
check('another device cannot open the order by number alone', !(await tp.textContent('#app')).includes('12 Temple Road'));
await ap.keyboard.press('Escape'); await ap.evaluate(() => { document.getElementById('modal').classList.remove('open'); location.hash = 'orders'; }); await ap.waitForTimeout(1800);
check('the order appears in the admin panel', (await ap.textContent('#olist')).includes(codNo));

// 5b. the order pop-up in the admin: tidy rows, plain-language labels, and a shipment FORM (no typed status codes)
check('order filter tabs look like tabs and show which one is chosen', await ap.evaluate(() => { const on = document.querySelector('#otabs .chip.on'), off = document.querySelector('#otabs .chip:not(.on)');
  return !!on && !!off && on.getBoundingClientRect().height >= 28 && getComputedStyle(on).backgroundColor !== getComputedStyle(off).backgroundColor; }));
await ap.click(`#olist tr[data-n="${codNo}"]`); await ap.waitForSelector('#modalBody .sum-row.total', { timeout: 15000 });
const odRows = await ap.evaluate(() => [...document.querySelectorAll('#modalBody .sum-row')].map(r => ({ gap: r.lastElementChild.getBoundingClientRect().left - r.firstElementChild.getBoundingClientRect().right, text: r.textContent })));
check('order pop-up: every label and its amount are apart (not run together)', odRows.length >= 4 && odRows.every(r => r.gap >= 8), JSON.stringify(odRows.map(r => Math.round(r.gap))));
check('order pop-up: payment status in plain words, not a code', odRows.some(r => /COD – not collected/.test(r.text)) && !odRows.some(r => /cod_pending/.test(r.text)));
let asked = 0; const noPrompt = d => { asked++; d.dismiss(); }; ap.on('dialog', noPrompt);
await ap.click('#modalBody [data-act=ship]'); await ap.waitForSelector('#shipBox', { timeout: 5000 });
check('shipment: a form with a list of statuses (staff do not type a code)', asked === 0 && (await ap.$$eval('#shipBox select[name=st] option', o => o.map(x => x.textContent).join('|'))) === 'Being prepared|Shipped from abroad|Arrived in Sri Lanka|Out for delivery|Delivered|Returned to us');
await ap.fill('#shipBox [name=carrier]', 'Domex'); await ap.fill('#shipBox [name=trk]', 'E2E-TRK-1'); await ap.selectOption('#shipBox [name=st]', 'out_for_delivery');
await ap.click('#shipBox button.primary'); await ap.waitForFunction(() => !document.querySelector('#modal.open'), null, { timeout: 15000 });
ap.off('dialog', noPrompt);
check('shipment saved in the database', sql(`SELECT s.carrier || ' ' || s.tracking_number || ' ' || s.status FROM app.shipments s JOIN app.orders o ON o.id = s.order_id WHERE o.order_number = '${codNo}'`) === 'Domex E2E-TRK-1 out_for_delivery');
await ap.waitForTimeout(900); await ap.click(`#olist tr[data-n="${codNo}"]`); await ap.waitForSelector('#modalBody .sum-row.total', { timeout: 15000 });
check('order pop-up shows the shipment in plain words', /Domex · tracking E2E-TRK-1\s*Out for delivery/.test(await ap.textContent('#modalBody')));
await ap.evaluate(() => document.getElementById('modal').classList.remove('open'));

// 6. card payment: redirect is not payment; only the signed notification is
await ap.evaluate(() => { location.hash = 'settings'; }); await ap.waitForSelector('#dform input[name=payOnline]', { timeout: 15000 });
await ap.check('#dform input[name=payOnline]', { force: true }); await ap.click('#dform button.primary');
await ap.waitForFunction(() => !SCG.syncing(), null, { timeout: 20000 }); await ap.waitForTimeout(500);
console.log('admin toasts:', [...new Set(toasts)].slice(-8).join(' | '));
check('owner switches on card payments', (await rpc('storefront_snapshot')).settings.payOnline === true);
await sp.goto(withSb('')); await sp.waitForSelector('.card', { timeout: 20000 });
await cartWith(sp, 'womens-5');
await sp.waitForSelector('#placeBtn:not([disabled])', { timeout: 20000 });
await sp.fill('#co [name=name]', 'Card Buyer'); await sp.fill('#co [name=phone]', '0771234568'); await sp.fill('#co [name=email]', 'card@example.com');
await sp.fill('#co [name=address]', '5 Lake Road'); await sp.fill('#co [name=city]', 'Galle'); await sp.selectOption('#co [name=district]', 'Galle');
await sp.check('#co input[value="Card"]');
await sp.click('#placeBtn'); await sp.waitForURL(/payhere\.lk/, { timeout: 20000 });
const f = Object.fromEntries(new URLSearchParams(shopper._payhere || ''));
check('sent to PayHere sandbox with the server-made hash', f.hash === md5U(MID + f.order_id + f.amount + 'LKR' + md5U(SECRET)));
check('merchant secret is not in the browser', !(shopper._payhere || '').includes(SECRET));
await sp.goto(withSb('#order/' + f.order_id)); await sp.waitForSelector('#ordBox h2', { timeout: 20000 }); await sp.waitForTimeout(1500);
check('return page waits for PayHere (not paid)', /Waiting for PayHere/i.test(await sp.textContent('#ordBox')));
const nr = await fetch(`${SB}/functions/v1/payhere-notify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ merchant_id: MID, order_id: f.order_id, payment_id: String(Date.now()).slice(-9), payhere_amount: f.amount, payhere_currency: 'LKR', status_code: '2', md5sig: md5U(MID + f.order_id + f.amount + 'LKR2' + md5U(SECRET)), method: 'VISA', card_no: '************1292' }) });
check('signed notification accepted by the Edge Function', nr.status === 200);
await sp.waitForFunction(() => /Payment received/.test(document.querySelector('#ordBox')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
check('order page turns to paid', /Payment received/.test(await sp.textContent('#ordBox')));

// 6b. sales & profit report (owner): cost price entry, numbers match the database, best/least sellers, CSV
await ap.evaluate(() => { location.hash = 'reports/costs'; }); await ap.waitForSelector('[data-cost="mens-1"]', { timeout: 15000 });
check('owner sees the Sales & Profit menu', await ap.isVisible('#sideNav a[data-v=reports]'));
await ap.fill('[data-cost="mens-1"]', '800'); await ap.check('#cPast'); await ap.click('[data-save="mens-1"]');
await ap.waitForFunction(() => /Cost saved/.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
check('cost price saved by the owner', sql(`SELECT c.cost_cents FROM app.product_costs c JOIN app.products p ON p.id = c.product_id WHERE p.slug = 'mens-1'`) === '80000');
check('cost used for the earlier COD sale that had none', sql(`SELECT count(*) FROM app.order_item_cost_fills f JOIN app.order_items i ON i.id = f.order_item_id JOIN app.orders o ON o.id = i.order_id WHERE o.order_number = '${codNo}'`) === '1');
await ap.evaluate(() => { location.hash = 'reports'; }); await ap.waitForSelector('#rpPre [data-pre=today]', { timeout: 15000 });
await ap.click('#rpPre [data-pre=today]'); await ap.waitForSelector('#rpOut .stats', { timeout: 20000 });
// expected values straight from the order tables (independent of the report function)
const exp = JSON.parse(sql(`SELECT json_build_object('orders', count(*), 'net', coalesce(sum(subtotal_cents - discount_cents), 0), 'received', coalesce(sum(total_cents) FILTER (WHERE payment_status IN ('paid','cod_collected')), 0)) FROM app.orders WHERE (placed_at AT TIME ZONE 'Asia/Colombo')::date = (now() AT TIME ZONE 'Asia/Colombo')::date AND status NOT IN ('pending_payment','cancelled','expired','refunded')`));
const fmt = (cents) => { const n = cents / 100; return 'Rs. ' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
const statText = await ap.$$eval('#rpOut .stat', els => Object.fromEntries(els.map(e => [e.querySelector('small').textContent.replace(/ \(-?[0-9.]+%\)$/, ''), e.querySelector('b').textContent.trim()])));
check('report: number of orders today matches the database', statText['Orders'] === String(exp.orders), `${statText['Orders']} vs ${exp.orders}`);
check('report: sales after discounts match the database', statText['Sales (after discounts)'] === fmt(exp.net), `${statText['Sales (after discounts)']} vs ${fmt(exp.net)}`);
check('report: money received matches the database', statText['Money received'] === fmt(exp.received), `${statText['Money received']} vs ${fmt(exp.received)}`);
check('report: best sellers and least sold are listed', (await ap.$$('#rpTop tbody tr a')).length >= 2 && (await ap.$$('#rpLeast tbody tr')).length === 10);
const [dl] = await Promise.all([ap.waitForEvent('download', { timeout: 15000 }), ap.click('#rpCsv')]);
const csv = fs.readFileSync(await dl.path(), 'utf8');
check('report downloads as a spreadsheet (CSV)', csv.includes('Sales after discounts') && csv.includes(exp.orders ? 'Best seller' : 'Orders'));
await ap.screenshot({ path: OUT + '/sb-admin-reports.jpg', type: 'jpeg', quality: 70, fullPage: true });
await ap.setViewportSize({ width: 390, height: 844 }); await ap.waitForTimeout(500);
check('report page on a phone: no sideways scrolling', (await ap.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1,
  await ap.evaluate(() => [...document.querySelectorAll('#view *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.table-wrap'))
    .slice(0, 5).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().width)).join(' | ')));
await ap.setViewportSize({ width: 1366, height: 900 });

// 6c. service renewal reminder (owner): warning on every admin page from the day before
sql(`DELETE FROM app.service_renewals`);   // local test database: start with no reminders, so the banner can only come from this step
const tomorrow = sql(`SELECT (app.colombo_today() + 1)::text`);
await ap.goto(SITE + '/admin/#renewals'); await ap.waitForSelector('#addRn', { timeout: 15000 });
check('owner sees the Renewals menu', await ap.isVisible('#sideNav a[data-v=renewals]'));
await ap.click('#addRn'); await ap.fill('#rnf [name=name]', 'E2E Supabase Pro'); await ap.fill('#rnf [name=provider]', 'Supabase');
await ap.fill('#rnf [name=due]', tomorrow); await ap.selectOption('#rnf [name=cycle]', 'monthly'); await ap.fill('#rnf [name=remind]', '1');
check('no warning while there are no reminders', await ap.isHidden('#rnBanner'));
await ap.click('#rnf button.primary'); await ap.waitForFunction(() => /E2E Supabase Pro/.test(document.querySelector('#rnBanner:not([hidden])')?.textContent || ''), null, { timeout: 15000 });
check('reminder saved in the database', sql(`SELECT first_due::text || ' ' || cycle FROM app.service_renewals WHERE name = 'E2E Supabase Pro'`) === tomorrow + ' monthly');
check('warning banner shows the day before', /E2E Supabase Pro[\s\S]*renews[\s\S]*tomorrow/.test(await ap.textContent('#rnBanner')));
check('Renewals menu shows the count', (await ap.textContent('#rnPill')).trim() !== '');
await ap.click('#sideNav a[data-v=dashboard]'); await ap.waitForTimeout(800);
check('warning stays on other admin pages', await ap.isVisible('#rnBanner'));
await ap.setViewportSize({ width: 390, height: 844 }); await ap.goto(SITE + '/admin/#renewals'); await ap.waitForSelector('#view table', { timeout: 15000 });
check('renewals page on a phone: no sideways scrolling', (await ap.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
await ap.screenshot({ path: OUT + '/sb-admin-renewals.jpg', type: 'jpeg', quality: 70, fullPage: true });
await ap.setViewportSize({ width: 1366, height: 900 });
sql(`DELETE FROM app.service_renewals WHERE name = 'E2E Supabase Pro'`);

// 6d. admin PIN instead of the authenticator app (owner's choice): set own PIN, switch, sign in elsewhere with password + PIN
await ap.goto(SITE + '/admin/#staff'); await ap.waitForSelector('#siF', { timeout: 15000 });
const ownerRow = await ap.$(`tr:has-text("ownere2e") [data-pin]`);
await ownerRow.click(); await ap.fill('#pinF [name=pin]', '0722'); await ap.fill('#pinF [name=pin2]', '0722'); await ap.click('#pinF button.primary');
await ap.waitForTimeout(1200);
check('owner sets an admin PIN (stored only as a hash)', sql(`SELECT left(p.pin_hash, 2) FROM app.staff_pins p JOIN app.staff_users u ON u.id = p.staff_id WHERE u.username = 'ownere2e'`) === '$2');
await ap.waitForSelector('#siF', { timeout: 15000 }); await ap.check('#siF input[value=pin]'); await ap.click('#siF button.primary'); await ap.waitForTimeout(1200);
check('owner switches the second step to PIN', sql(`SELECT staff_second_step FROM app.security_settings`) === 'pin');
const pinC = await ctx(); const pp = await page(pinC, 'admin-pin');
await pp.goto(withSb('admin/'));
await pp.fill('input[name=user]', OWNER.email); await pp.fill('input[name=pass]', OWNER.password); await pp.click('#loginForm button:not(.pw-eye)');
await pp.waitForSelector('#loginForm input[name=pin]', { timeout: 15000 });
check('after the password, the PIN is asked (no QR code / app)', !(await pp.$('#mfaQr')));
await pp.fill('#loginForm input[name=pin]', '1111'); await pp.click('#pinGo'); await pp.waitForTimeout(1200);
check('a wrong PIN is refused with tries left', /Wrong PIN\. 4 tries left/.test(await pp.textContent('#loginErr')));
await pp.fill('#loginForm input[name=pin]', '0722'); await pp.click('#pinGo');
await pp.waitForSelector('#shell:not([hidden])', { timeout: 20000 }); await pp.waitForTimeout(1200);
check('the right PIN opens the admin', await pp.isVisible('#sideNav a[data-v=orders]'));
await pinC.close();
sql(`UPDATE app.security_settings SET staff_second_step = 'totp'`); sql(`DELETE FROM app.staff_pins`); sql(`DELETE FROM app.staff_pin_sessions`);

// 6e. poster banner (a finished picture with its own words): uploaded in the admin, shown WHOLE on the website at its own shape
await ap.goto(SITE + '/admin/#banners'); await ap.waitForSelector('#addHero', { timeout: 15000 });
const posterPng = Buffer.from(await ap.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1600; c.height = 900; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 1600, 900); x.fillStyle = '#d7141a'; x.font = 'bold 220px sans-serif'; x.fillText('11:11', 120, 520);
  x.fillStyle = '#0b2a6f'; x.fillRect(0, 0, 1600, 24); x.fillRect(0, 876, 1600, 24);   // edge bars: visible only if nothing is cut off
  return c.toDataURL('image/png').split(',')[1];
}), 'base64');
await ap.click('#addHero'); await ap.selectOption('#hform [name=style]', 'poster');
check('poster form hides the text-banner fields', await ap.isHidden('#hform [name=eyebrow]'));
await ap.setInputFiles('#pup input[type=file]', { name: 'offer.png', mimeType: 'image/png', buffer: posterPng });
await ap.waitForFunction(() => /1600 × 900/.test(document.querySelector('#pupInfo')?.textContent || ''), null, { timeout: 15000 });
await ap.fill('#hform [name=title]', 'E2E 11:11 Offer'); await ap.fill('#hform [name=link]', '#flash');
await ap.click('#hform button.primary');
await ap.waitForFunction(() => /POSTER · FULL-WIDTH SLIDER/.test(document.querySelector('#view')?.textContent || ''), null, { timeout: 20000 });
await ap.waitForTimeout(2500);
const posterRow = JSON.parse(sql(`SELECT json_build_object('style', style, 'img', image_url, 'link', link)::text FROM app.banners WHERE title = 'E2E 11:11 Offer'`) || '{}');
check('poster saved with its picture in Supabase Storage', posterRow.style === 'poster' && /\/storage\/v1\/object\/public\/product-images\//.test(posterRow.img || ''), posterRow.img);
for (const [vw, vh] of [[1366, 860], [390, 844]]) {
  const pc = await ctx({ viewport: { width: vw, height: vh } }); const pg = await page(pc, 'shop-poster');
  await pg.goto(withSb('')); await pg.waitForSelector('#posters img', { timeout: 20000 });
  await pg.waitForFunction(() => { const i = document.querySelector('#posters img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 }); await pg.waitForTimeout(400);
  const fit = await pg.evaluate(() => { const box = document.querySelector('#posters'), img = box.querySelector('img'), r = box.getBoundingClientRect();
    return { box: r.width / r.height, img: img.naturalWidth / img.naturalHeight, w: img.naturalWidth, fit: getComputedStyle(img).objectFit, alt: img.alt, href: box.querySelector('a').getAttribute('href') }; });
  check(`poster shown whole at its own shape (${vw}px wide)`, Math.abs(fit.box - fit.img) < 0.01 && fit.fit === 'contain' && fit.w === 1600, JSON.stringify(fit));
  check(`poster has its description and link (${vw}px wide)`, fit.alt === 'E2E 11:11 Offer' && fit.href === '#flash');
  await pg.$eval('#posters', e => e.scrollIntoView({ block: 'center' })); await pg.waitForTimeout(1500);   // on a phone the poster is below the globe
  const anim = await pg.evaluate(() => { const vis = [...document.querySelectorAll('#app img:not(.alt)')].filter(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; });
    return { n: vis.length, done: vis.filter(i => i.classList.contains('ia-in') && getComputedStyle(i).opacity === '1').length }; });
  check(`every picture on screen has played its entrance animation and is fully shown (${vw}px wide)`, anim.n > 0 && anim.done === anim.n, JSON.stringify(anim));
  check(`poster page: no sideways scrolling (${vw}px wide)`, (await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
  if (vw < 500) { await pg.$eval('#posters', e => e.scrollIntoView({ block: 'center' })); await pg.screenshot({ path: OUT + '/sb-poster-phone.jpg', type: 'jpeg', quality: 70 }); }
  await pc.close();
}
sql(`DELETE FROM app.banners WHERE title = 'E2E 11:11 Offer'`);

// 6f. a new product with sizes: the admin asks for the stock of each size; the website follows it per size
await ap.goto(SITE + '/admin/#products/new'); await ap.waitForSelector('#pform', { timeout: 15000 });
await ap.fill('#pform [name=name]', 'E2E Size Stock Tee'); await ap.fill('#pform [name=price]', '1900'); await ap.fill('#pform [name=sizes]', 'S, M, L');
check('new product form asks for the stock of each size', (await ap.$$('#pform input[data-nsize]')).length === 3 && await ap.isHidden('#pform [name=stock]'));
await ap.fill('#pform input[data-nsize="S"]', '0'); await ap.fill('#pform input[data-nsize="M"]', '4'); await ap.fill('#pform input[data-nsize="L"]', '2');
check('the form shows the total of the sizes', /Total: 6/.test(await ap.textContent('#newStockSum')));
await ap.click('#pform button.primary');
await ap.waitForFunction(() => !SCG.syncing(), null, { timeout: 25000 }); await ap.waitForTimeout(800);
const sizeSlug = sql(`SELECT slug FROM app.products WHERE name = 'E2E Size Stock Tee'`);
const sizeStock = sql(`SELECT string_agg(v.size || '=' || i.on_hand, ',' ORDER BY v.sort_order) FROM app.product_variants v JOIN app.inventory i ON i.variant_id = v.id JOIN app.products p ON p.id = v.product_id WHERE p.slug = '${sizeSlug}'`);
check('each size is saved with its own stock', sizeStock === 'S=0,M=4,L=2', sizeStock);
const zc = await ctx({ viewport: { width: 400, height: 860 } }); const zp = await page(zc, 'shop-sizes');
await zp.goto(withSb('#p/' + sizeSlug)); await zp.waitForSelector('#sz', { timeout: 20000 }); await zp.waitForTimeout(600);
const pdp = await zp.evaluate(() => ({ on: document.querySelector('#sz button.on')?.textContent, out: [...document.querySelectorAll('#sz button')].filter(b => b.disabled).map(b => b.textContent).join(','), avail: document.querySelector('#avail').textContent, buyOff: document.querySelector('#buyNow').disabled }));
check('product page starts on a size that is in stock; sold-out sizes cannot be picked', pdp.on === 'M' && pdp.out === 'S' && !pdp.buyOff, JSON.stringify(pdp));
check('product page shows what is left in the chosen size', pdp.avail === '4 available in size M', pdp.avail);
for (let i = 0; i < 8; i++) await zp.click('[data-q="1"]');
check('quantity stops at the stock of the chosen size', (await zp.textContent('#qv')) === '4');
await zp.click('#sz button[data-s="L"]'); await zp.waitForTimeout(200);
check('changing size updates the note and lowers the quantity', (await zp.textContent('#avail')) === '2 available in size L' && (await zp.textContent('#qv')) === '2');
await zp.evaluate(id => SCG.saveCart([{ id, size: 'S', qty: 1, sel: true }, { id, size: 'L', qty: 2, sel: true }]), sizeSlug);
await zp.goto(withSb('#cart')); await zp.waitForSelector('.cart-row .qty', { timeout: 15000 }); await zp.waitForTimeout(500);
check('cart warns about the sold-out size only', (await zp.$$eval('.stock-warn', l => l.map(e => e.textContent).join('|'))) === 'Size S is out of stock. Please remove it.');
await zp.click('.cart-row:has-text("Size: L") [data-cq="1"]'); await zp.waitForTimeout(400);
check('cart + button stops at the stock of that size', /Only 2 in stock in size L/.test(await zp.textContent('#toast')) && (await zp.evaluate(() => SCG.getCart().find(l => l.size === 'L').qty)) === 2);
await zc.close();
sql(`UPDATE app.products SET status = 'archived' WHERE slug = '${sizeSlug}'`);

// 7. customer account (Supabase Auth)
const acc = await ctx(); const cp = await page(acc, 'customer');
await cp.goto(withSb('#account')); await cp.waitForSelector('#regF', { timeout: 20000 });
await cp.fill('#regF [name=name]', 'E2E Customer'); await cp.fill('#regF [name=email]', `e2e-${Date.now()}@example.com`); check('create account: password needs 8+ characters only', (await cp.getAttribute('#regF [name=password]', 'minlength')) === '8' && /8\+ characters/.test(await cp.textContent('#regF')));
await cp.fill('#regF [name=password]', 'lankatea');   // 8 letters, no numbers: allowed for customers
check('create account asks for phone, second phone, address, city, district and an optional photo',
  !!(await cp.$('#regF [name=phone][required]')) && !!(await cp.$('#regF [name=phone2]:not([required])')) &&
  !!(await cp.$('#regF [name=line1][required]')) && !!(await cp.$('#regF [name=city][required]')) && !!(await cp.$('#regF select[name=district][required]')) && !!(await cp.$('#regPhoto')));
check('no "forgot password" email link (no email is sent); it says to call the shop', !(await cp.$('#forgot')) && /Forgot your password\? Call/.test(await cp.textContent('#loginF')));
await cp.fill('#regF [name=phone]', '0771234567'); await cp.fill('#regF [name=phone2]', '0112223344');
await cp.fill('#regF [name=line1]', '45 Galle Road'); await cp.fill('#regF [name=city]', 'Dehiwala'); await cp.selectOption('#regF [name=district]', 'Colombo');
await cp.setInputFiles('#regPhoto', { name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(2 * 1024 * 1024 + 100) });
check('a photo over 2 MB is refused at once with its size', /2\.0 MB\. Choose one up to 2 MB/.test(await cp.textContent('#regPhotoErr')));
const avatarPng = Buffer.from(await cp.evaluate(() => { const c = document.createElement('canvas'); c.width = 900; c.height = 700; const x = c.getContext('2d'); x.fillStyle = '#0b2a6f'; x.fillRect(0, 0, 900, 700); x.fillStyle = '#d7141a'; x.beginPath(); x.arc(450, 350, 220, 0, 7); x.fill(); return Array.from(new Uint8Array(atob(c.toDataURL('image/png').split(',')[1]).split('').map(ch => ch.charCodeAt(0)))); }));
await cp.setInputFiles('#regPhoto', { name: 'me.png', mimeType: 'image/png', buffer: avatarPng });
check('the chosen photo is previewed', !!(await cp.$('#regPhotoPrev img')) && (await cp.textContent('#regPhotoErr')) === '');
await cp.screenshot({ path: OUT + '/sb-register.jpg', type: 'jpeg', quality: 70, fullPage: true });
await cp.click('#regF button.btn.full'); await cp.waitForSelector('#profForm', { timeout: 20000 }); await cp.waitForTimeout(800);
check('customer can create an account (no email confirmation)', (await cp.textContent('.acct-head')).includes('E2E'));
const custRow = sql(`SELECT c.phone || '|' || c.phone2 || '|' || a.line1 || '|' || a.city || '|' || a.district_code || '|' || (c.avatar_path ~ ('^' || c.id || '/')) FROM app.customers c JOIN app.customer_addresses a ON a.customer_id = c.id AND a.is_default WHERE c.name = 'E2E Customer' ORDER BY c.created_at DESC LIMIT 1`);
check('saved: both phones, the address and the photo', custRow === '0771234567|0112223344|45 Galle Road|Dehiwala|colombo|true', custRow);
check('the photo was made smaller before upload (max 512 px)', await cp.evaluate(async () => { const i = document.querySelector('.acct-head .avatar img'); if (!i) return false; await i.decode(); return Math.max(i.naturalWidth, i.naturalHeight) <= 512; }));
check('My details shows the second phone and the photo', (await cp.inputValue('#profForm [name=phone2]')) === '0112223344' && !!(await cp.$('#mePPrev img')));
await cp.reload(); await cp.waitForTimeout(2500); await cp.evaluate(() => { location.hash = 'account'; }); await cp.waitForTimeout(1500);
check('customer stays signed in after reload', !!(await cp.$('#profForm')));

// 8. mobile
const mob = await ctx({ ...devices['iPhone 13'] }); const mp = await page(mob, 'mobile');
await mp.goto(withSb('')); await mp.waitForSelector('.card', { timeout: 20000 }); await mp.waitForTimeout(800);
check('every product card shows stars', await mp.evaluate(() => { const cards = [...document.querySelectorAll('.card')]; return cards.length > 0 && cards.every(c => !!c.querySelector('.stars')); }));
check('mobile home: no sideways scrolling', (await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
await mp.screenshot({ path: OUT + '/sb-home-mobile.jpg', type: 'jpeg', quality: 70 });
await cartWith(mp, 'mens-2'); await mp.waitForSelector('#placeBtn:not([disabled])', { timeout: 20000 });
check('mobile checkout: no sideways scrolling', (await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);

// 9. when something goes wrong the visitor still sees something sensible (never a black or broken page)
const dn = await b.newContext({ viewport: { width: 400, height: 860 } });   // a FIRST visit: the welcome intro would play
await dn.route('**/rest/v1/rpc/storefront_snapshot', r => r.abort());
const dp = await dn.newPage(); await dp.goto(withSb('')); await dp.waitForSelector('#app h2', { timeout: 20000 });
const seen = await dp.evaluate(() => { const h = document.querySelector('#app h2'), r = h.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { text: h.textContent, onTop: top === h || h.contains(top), cover: document.documentElement.classList.contains('intro-on') }; });
check('shop server unreachable on a first visit: a clear message is on screen (not the dark intro cover)', seen.onTop && !seen.cover && /short break/.test(seen.text), JSON.stringify(seen));
check('…with a Try again button', await dp.isVisible('#app button'));
await dn.close();
const bk = await ctx({ viewport: { width: 400, height: 860 } }); await bk.route('**/storage/v1/object/public/product-images/**', r => r.abort());
const bp = await bk.newPage();   // (not page(): the refused picture request is expected here)
await bp.goto(withSb('#p/mens-12')); await bp.waitForSelector('#addCart', { timeout: 20000 }); await bp.waitForTimeout(1500);
const pic = await bp.evaluate(() => ({ drawn: !!document.querySelector('#big svg.pic'), broken: [...document.images].filter(i => i.complete && !i.naturalWidth && getComputedStyle(i).visibility !== 'hidden').length }));
check('a product photo that cannot be loaded is replaced by the drawn product (no broken-picture mark)', pic.drawn && pic.broken === 0, JSON.stringify(pic));
await bk.close();

// 10. co-admin: only the store work; more only after the main admin approves
const CO = { email: 'coadmin-e2e@staff.test', password: 'Co-Admin-Pass-2026!' };
let coId = sql(`SELECT id FROM auth.users WHERE email = '${CO.email}'`);
if (!coId) {
  const r = await (await fetch(`${SB}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: CO.email, password: CO.password, email_confirm: true, app_metadata: { kind: 'staff' } }) })).json();
  coId = r.id;
  sql(`INSERT INTO app.staff_users (id, username, email, display_name) VALUES ('${coId}', 'coadmine2e', '${CO.email}', 'E2E Co Admin')`);
  sql(`INSERT INTO app.staff_roles (staff_id, role_id) SELECT '${coId}', id FROM app.roles WHERE code = 'co_admin'`);
}
sql(`DELETE FROM app.staff_extra_permissions WHERE staff_id = '${coId}'`); sql(`DELETE FROM app.access_requests WHERE staff_id = '${coId}'`);
sql(`UPDATE app.security_settings SET require_staff_mfa = false`);   // this account's second sign-in step is tested elsewhere
const coCtx = await ctx(); const kp = await page(coCtx, 'co-admin');
await kp.goto(withSb('admin/')); await kp.waitForSelector('input[name=user]');
await kp.fill('input[name=user]', CO.email); await kp.fill('input[name=pass]', CO.password); await kp.click('#loginForm button:not(.pw-eye)');
await kp.waitForSelector('#shell:not([hidden])', { timeout: 20000 }); await kp.waitForTimeout(1200);
const coMenu = await kp.$$eval('#sideNav a[data-v]', l => l.filter(a => !a.hidden).map(a => a.dataset.v));
check('co-admin menu: sales & profit, products, banners, offers, promo codes', ['reports', 'products', 'banners', 'flash', 'coupons', 'access'].every(x => coMenu.includes(x)), coMenu.join(','));
check('co-admin menu: no orders, customers, staff, settings of fees, audit, backups, renewals', !['orders', 'customers', 'staff', 'origins', 'audit', 'backups', 'renewals'].some(x => coMenu.includes(x)), coMenu.join(','));
check('co-admin is labelled as co-admin', /CO-ADMIN/.test(await kp.textContent('.side-brand small')));
await kp.goto(withSb('admin/#orders')); await kp.waitForTimeout(1500);
check('co-admin typing the orders address is sent elsewhere', !(await kp.evaluate(() => location.hash)).includes('orders'));
await kp.goto(withSb('admin/#access')); await kp.waitForSelector('[data-ask="orders.read"]', { timeout: 15000 });
kp.once('dialog', d => d.accept('to pack orders'));
await kp.click('[data-ask="orders.read"]'); await kp.waitForTimeout(1500);
check('co-admin asks for access; it waits for approval', sql(`SELECT status FROM app.access_requests WHERE staff_id = '${coId}' AND permission = 'orders.read'`) === 'pending');
await ap.evaluate(() => { location.hash = 'staff'; }); await ap.waitForSelector('#acReq [data-acc]', { timeout: 15000 });
check('main admin sees the request with the reason', /E2E Co Admin[\s\S]*See orders[\s\S]*to pack orders/.test(await ap.textContent('#acReq')));
ap.once('dialog', d => d.accept('ok')); await ap.click('#acReq [data-acc]'); await ap.waitForTimeout(1500);
check('approved in the database', sql(`SELECT count(*) FROM app.staff_extra_permissions WHERE staff_id = '${coId}' AND permission = 'orders.read'`) === '1');
await kp.reload(); await kp.waitForSelector('#shell:not([hidden])', { timeout: 20000 }); await kp.waitForTimeout(1200);
check('after approval the co-admin sees Orders', await kp.isVisible('#sideNav a[data-v=orders]'));
await coCtx.close();

// 10b. main admin deletes the co-admin account from Staff & Roles (typing the username to confirm)
await ap.evaluate(() => { location.hash = 'dashboard'; }); await ap.waitForTimeout(600);
await ap.evaluate(() => { location.hash = 'staff'; }); await ap.waitForSelector('tr:has-text("coadmine2e") [data-edit]', { timeout: 15000 });
await ap.click('tr:has-text("coadmine2e") [data-edit]'); await ap.waitForSelector('#stDel');
ap.once('dialog', d => d.accept('wrong-name')); await ap.click('#stDel'); await ap.waitForTimeout(800);
check('delete with a wrong username does nothing', sql(`SELECT count(*) FROM app.staff_users WHERE id = '${coId}'`) === '1');
ap.once('dialog', d => d.accept('coadmine2e')); await ap.click('#stDel'); await ap.waitForTimeout(2500);
check('main admin deletes a staff account (sign-in account removed too)', sql(`SELECT count(*) FROM app.staff_users WHERE id = '${coId}'`) === '0' && sql(`SELECT count(*) FROM auth.users WHERE id = '${coId}'`) === '0');
check('own account has no delete button', await ap.evaluate(async () => { location.hash = 'staff'; await new Promise(r => setTimeout(r, 1500));
  const row = [...document.querySelectorAll('#view tr')].find(tr => /ownere2e/.test(tr.textContent)); row.querySelector('[data-edit]').click(); await new Promise(r => setTimeout(r, 500));
  const none = !document.getElementById('stDel'); document.getElementById('modal').classList.remove('open'); return none; }));

// 10c. Add staff: only full name, username, password, role and how to verify (PIN here). The person signs in with the username.
sql(`DELETE FROM app.staff_users WHERE username = 'shopstaff'`); sql(`DELETE FROM auth.users WHERE email = 'shopstaff@staff.invalid'`);
sql(`UPDATE app.security_settings SET require_staff_mfa = true, staff_second_step = 'totp'`);   // shop default stays the app; this person gets PIN
await ap.evaluate(() => { location.hash = 'dashboard'; }); await ap.waitForTimeout(600);
await ap.evaluate(() => { location.hash = 'staff'; }); await ap.waitForSelector('#addStaff', { timeout: 15000 }); await ap.waitForSelector('#view table');
await ap.click('#addStaff'); await ap.waitForSelector('#stf [name=displayName]');
check('add staff form: no email field', !(await ap.$('#stf [name=email]')));
check('add staff form: co-admin is the default role', (await ap.inputValue('#stf [name=role]')) === 'co_admin');
await ap.check('#stf input[name=step][value=totp]');
check('PIN boxes hidden when the authenticator app is chosen', await ap.isHidden('#stf [name=pin]'));
await ap.check('#stf input[name=step][value=pin]');
check('PIN boxes shown when PIN is chosen', await ap.isVisible('#stf [name=pin]'));
await ap.screenshot({ path: OUT + '/sb-admin-add-staff.jpg', type: 'jpeg', quality: 70 });
await ap.setViewportSize({ width: 390, height: 844 }); await ap.waitForTimeout(300);
check('add staff form on a phone: no sideways scrolling', (await ap.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
await ap.screenshot({ path: OUT + '/sb-admin-add-staff-phone.jpg', type: 'jpeg', quality: 70 });
await ap.setViewportSize({ width: 1366, height: 900 });
await ap.fill('#stf [name=displayName]', 'Shop Staff Person'); await ap.fill('#stf [name=username]', 'shopstaff'); await ap.fill('#stf [name=pw]', 'Temp-Shop-2026x');
await ap.fill('#stf [name=pin]', '4826'); await ap.fill('#stf [name=pin2]', '4827'); await ap.click('#stf button.primary'); await ap.waitForTimeout(800);
check('two different PINs: nothing is created', sql(`SELECT count(*) FROM app.staff_users WHERE username = 'shopstaff'`) === '0');
await ap.fill('#stf [name=pin2]', '4826'); await ap.click('#stf button.primary'); await ap.waitForTimeout(3000);
check('staff created with full name, co-admin role and PIN sign-in',
  sql(`SELECT u.display_name || '|' || u.second_step || '|' || (SELECT string_agg(r.code, ',') FROM app.staff_roles sr JOIN app.roles r ON r.id = sr.role_id WHERE sr.staff_id = u.id) || '|' || (SELECT count(*) FROM app.staff_pins p WHERE p.staff_id = u.id) FROM app.staff_users u WHERE u.username = 'shopstaff'`) === 'Shop Staff Person|pin|co_admin|1');
check('staff list shows how the person verifies', /shopstaff · PIN/.test(await ap.textContent('#view')));
const nsC = await ctx(); const np = await page(nsC, 'new-staff');
await np.goto(withSb('admin/')); await np.waitForSelector('input[name=user]');
await np.fill('input[name=user]', 'shopstaff'); await np.fill('input[name=pass]', 'Temp-Shop-2026x'); await np.click('#loginForm button:not(.pw-eye)');
await np.waitForSelector('#loginForm input[name=cur]', { timeout: 15000 });
check('new staff signs in with the username (then sets their own password)', true);
await np.fill('#loginForm [name=cur]', 'Temp-Shop-2026x'); await np.fill('#loginForm [name=pw]', 'Own-Shop-Pass-77'); await np.click('#loginForm button.primary');
await np.waitForSelector('input[name=user]', { timeout: 20000 });
await np.fill('input[name=user]', 'shopstaff'); await np.fill('input[name=pass]', 'Own-Shop-Pass-77'); await np.click('#loginForm button:not(.pw-eye)');
await np.waitForSelector('#loginForm input[name=pin]', { timeout: 15000 });
check('this person is asked for the PIN (shop default is the app)', !(await np.$('#mfaQr')));
await np.fill('#loginForm input[name=pin]', '4826'); await np.click('#pinGo');
await np.waitForSelector('#shell:not([hidden])', { timeout: 20000 }); await np.waitForTimeout(1200);
check('PIN opens the admin with the co-admin menu', await np.isVisible('#sideNav a[data-v=reports]') && !(await np.isVisible('#sideNav a[data-v=staff]')));
await nsC.close();
sql(`UPDATE app.security_settings SET require_staff_mfa = false`);

// 10d. main admin changes a username in Staff & Roles -> Edit; the person signs in with the new name
await ap.evaluate(() => { location.hash = 'dashboard'; }); await ap.waitForTimeout(600);
await ap.evaluate(() => { location.hash = 'staff'; }); await ap.waitForSelector('tr:has-text("shopstaff") [data-edit]', { timeout: 15000 });
await ap.click('tr:has-text("shopstaff") [data-edit]'); await ap.waitForSelector('#stf [name=username]');
check('edit form shows the username', (await ap.inputValue('#stf [name=username]')) === 'shopstaff');
await ap.fill('#stf [name=username]', 'ownere2e'); await ap.click('#stf button.primary'); await ap.waitForTimeout(2000);
check('a username already in use is refused', sql(`SELECT count(*) FROM app.staff_users WHERE username = 'shopstaff'`) === '1');
await ap.fill('#stf [name=username]', 'shopkeeper'); await ap.click('#stf button.primary'); await ap.waitForTimeout(2500);
check('username changed (and the sign-in name with it)', sql(`SELECT u.username || ' ' || a.email FROM app.staff_users u JOIN auth.users a ON a.id = u.id WHERE u.display_name = 'Shop Staff Person'`) === 'shopkeeper shopkeeper@staff.invalid');
sql(`UPDATE app.security_settings SET require_staff_mfa = true`);
const rnC = await ctx(); const rp = await page(rnC, 'renamed-staff');
await rp.goto(withSb('admin/')); await rp.waitForSelector('input[name=user]');
await rp.fill('input[name=user]', 'shopkeeper'); await rp.fill('input[name=pass]', 'Own-Shop-Pass-77'); await rp.click('#loginForm button:not(.pw-eye)');
await rp.waitForSelector('#loginForm input[name=pin]', { timeout: 15000 });
check('the person signs in with the new username', true);
check('login page: "Powered by Hexora Private Limited"', /Powered by Hexora Private Limited/.test(await rp.textContent('#login')) && await rp.isVisible('.login-powered'));
const lgC = await ctx({ viewport: { width: 390, height: 844 } }); const lp = await page(lgC, 'login-phone');   // signed out: the normal login card
await lp.goto(withSb('admin/')); await lp.waitForSelector('input[name=user]'); await lp.waitForTimeout(900);
check('login page on a phone: credit below the card, not over it', await lp.evaluate(() => document.querySelector('.login-powered').getBoundingClientRect().top >= document.querySelector('.login-card').getBoundingClientRect().bottom));
await lp.screenshot({ path: OUT + '/sb-admin-login-phone.jpg', type: 'jpeg', quality: 70 }); await lgC.close();
await rnC.close();
sql(`UPDATE app.security_settings SET require_staff_mfa = false`);
check('admin side menu: "Powered by Hexora Private Limited"', /Powered by Hexora Private Limited/.test(await ap.textContent('.side-foot')));
const ftC = await ctx(); const fp = await page(ftC, 'footer');
await fp.goto(withSb('')); await fp.waitForSelector('.card', { timeout: 20000 });
check('website footer: "Powered by Hexora Private Limited"', /Powered by Hexora Private Limited/.test(await fp.textContent('.footer-bottom')));
await fp.evaluate(() => document.querySelector('.footer-bottom').scrollIntoView()); await fp.waitForTimeout(400);
await fp.screenshot({ path: OUT + '/sb-footer-desktop.jpg', type: 'jpeg', quality: 70 });
await fp.setViewportSize({ width: 390, height: 844 }); await fp.waitForTimeout(400);
check('website footer on a phone: no sideways scrolling', (await fp.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
await fp.evaluate(() => document.querySelector('.footer-bottom').scrollIntoView()); await fp.waitForTimeout(400);
await fp.screenshot({ path: OUT + '/sb-footer-phone.jpg', type: 'jpeg', quality: 70 });
await ftC.close();

// 10e. product reviews: the buyer rates a delivered order on the order page; it shows on the product page; staff reply and hide
sql(`UPDATE app.inventory SET on_hand = 50, reserved = 0 FROM app.product_variants v WHERE v.id = inventory.variant_id AND v.sku = 'BAGS-4'`);
sql(`TRUNCATE app.product_reviews`); sql(`UPDATE app.rate_limits SET hits = 0 WHERE key LIKE 'review:%'`);
sql(`UPDATE app.products SET rating = 0, reviews_count = 0 WHERE slug = 'bags-4'`);   // the database tests left their own reviews' totals here
const rvOrder = await (await fetch(`${SB}/rest/v1/rpc/place_order`, { method: 'POST', headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
  body: JSON.stringify({ p_input: { items: [{ id: 'bags-4', size: '', qty: 1 }], customer: { name: 'Ruwani Fernando', phone: '0771112233', email: 'ruwani@example.com', address: '5 Lake Road', city: 'Galle', district: 'Galle', note: '' }, payment: 'cod' }, p_customer_id: null, p_idempotency_key: null }) })).json();
check('review test order placed', /^SC-/.test(rvOrder.orderNumber || ''), JSON.stringify(rvOrder).slice(0, 120));
const rvC = await ctx(); const rv = await page(rvC, 'review');
await rv.goto(withSb('')); await rv.waitForSelector('.card', { timeout: 20000 });
await rv.evaluate(([n, t]) => SCG.rememberOrder(n, t), [rvOrder.orderNumber, rvOrder.trackingToken]);
await rv.evaluate((n) => { location.hash = 'order/' + n; }, rvOrder.orderNumber); await rv.waitForSelector('#ordBox h2', { timeout: 15000 }); await rv.waitForTimeout(1200);
check('no review box before delivery', !(await rv.$('#ordRev .rev-form')));
sql(`UPDATE app.orders SET status = 'delivered' WHERE order_number = '${rvOrder.orderNumber}'`);
await rv.reload(); await rv.waitForSelector('#ordRev .rev-form', { timeout: 15000 });
check('delivered order: "Rate your items" with stars', /Rate your items/.test(await rv.textContent('#ordRev')) && (await rv.$$('#ordRev .star-pick button')).length === 5);
await rv.click('#ordRev .rev-form button.btn'); await rv.waitForTimeout(500);
check('submit without stars: asks for stars, nothing saved', sql(`SELECT count(*) FROM app.product_reviews`) === '0');
await rv.click('#ordRev .star-pick button[data-n="4"]');
check('4 stars light up', (await rv.$$('#ordRev .star-pick button.on')).length === 4);
await rv.fill('#ordRev textarea', 'Nice leather, came in 9 days.'); await rv.click('#ordRev .rev-form button.btn');
await rv.waitForFunction(() => /Update review/.test(document.querySelector('#ordRev')?.textContent || ''), null, { timeout: 15000 });
check('review saved (4 stars, text) and shown as "Ruwani F."', sql(`SELECT rating || ' ' || author_name || ' ' || comment FROM app.product_reviews`) === '4 Ruwani F. Nice leather, came in 9 days.');
await rv.setViewportSize({ width: 390, height: 844 }); await rv.waitForTimeout(300);
check('review form on a phone: no sideways scrolling', (await rv.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
await rv.evaluate(() => document.getElementById('ordRev').scrollIntoView()); await rv.screenshot({ path: OUT + '/sb-review-form-phone.jpg', type: 'jpeg', quality: 70 });
await rv.setViewportSize({ width: 1366, height: 860 });
await rv.evaluate(() => { location.hash = 'p/bags-4'; }); await rv.waitForSelector('#ptabs', { timeout: 15000 });
await rv.waitForSelector('#revBox .rev', { timeout: 15000 });
const revTxt = await rv.textContent('#revBox');
check('product page: "Ratings & Reviews" is shown under the product without opening a tab', await rv.isVisible('#revPanel') && !(await rv.$('#ptabs button[data-t=r]')));
check('product page: average, count, the review with "Verified purchase"', /4\/5/.test(revTxt.replace(/\s/g, '')) && /1 rating/.test(revTxt) && /Ruwani F\./.test(revTxt) && /Verified purchase/.test(revTxt) && /Nice leather/.test(revTxt), revTxt.slice(0, 160));
check('product page never shows the full name or phone', !/Fernando|0771112233/.test(revTxt));
await rv.evaluate(() => document.getElementById('revBox').scrollIntoView()); await rv.screenshot({ path: OUT + '/sb-reviews-pdp.jpg', type: 'jpeg', quality: 70 });
// staff: Reviews page, reply, hide
await ap.evaluate(() => { location.hash = 'dashboard'; }); await ap.waitForTimeout(600);
check('Reviews menu for the main admin', await ap.isVisible('#sideNav a[data-v=reviews]'));
await ap.evaluate(() => { location.hash = 'reviews'; }); await ap.waitForSelector('.rv-card', { timeout: 15000 });
check('admin sees the buyer, order and review', /Ruwani F\.[\s\S]*Ruwani Fernando|Ruwani Fernando[\s\S]*Ruwani F\./.test(await ap.textContent('#view')) && /SC-[\s\S]*Nice leather|Nice leather[\s\S]*SC-/.test(await ap.textContent('#view')));
await ap.screenshot({ path: OUT + '/sb-admin-reviews.jpg', type: 'jpeg', quality: 70 });
await ap.fill('.rv-card textarea', 'Thank you, Ruwani!'); await ap.click('.rv-card [data-act=reply]'); await ap.waitForTimeout(1500);
check('reply saved', sql(`SELECT reply FROM app.product_reviews`) === 'Thank you, Ruwani!');
await rv.reload(); await rv.waitForSelector('#revBox .rev-reply', { timeout: 15000 });
check('the reply shows under the review on the website', /Response from Source Connect[\s\S]*Thank you, Ruwani!/.test(await rv.textContent('#revBox')));
ap.once('dialog', d => d.accept()); await ap.click('.rv-card [data-act=hide]'); await ap.waitForTimeout(1500);
check('hidden: off the website and out of the average', sql(`SELECT status FROM app.product_reviews`) === 'hidden' && sql(`SELECT reviews_count FROM app.products WHERE slug = 'bags-4'`) === '0');
await rv.reload(); await rv.waitForSelector('#revBox p', { timeout: 15000 }); await rv.waitForTimeout(800);
check('product page shows no reviews after hiding', /No reviews yet/.test(await rv.textContent('#revBox')));
await rvC.close();
// a signed-in customer reviews from My orders, with the profile photo next to the review
const cust = await ctx(); const kp2 = await page(cust, 'my-orders');
const cemail = `rev-${Date.now()}@example.com`;
await kp2.goto(withSb('#account')); await kp2.waitForSelector('#regF', { timeout: 20000 });
await kp2.fill('#regF [name=name]', 'Dilani Perera'); await kp2.fill('#regF [name=email]', cemail); await kp2.fill('#regF [name=password]', 'galleface');
await kp2.fill('#regF [name=phone]', '0779876543'); await kp2.fill('#regF [name=line1]', '8 Sea Street'); await kp2.fill('#regF [name=city]', 'Galle'); await kp2.selectOption('#regF [name=district]', 'Galle');
await kp2.setInputFiles('#regPhoto', { name: 'd.png', mimeType: 'image/png', buffer: avatarPng });
await kp2.click('#regF button.btn.full'); await kp2.waitForSelector('#profForm', { timeout: 20000 });
const custId = sql(`SELECT id FROM app.customers WHERE email = '${cemail}'`);
const myOrder = await (await fetch(`${SB}/rest/v1/rpc/place_order`, { method: 'POST', headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
  body: JSON.stringify({ p_input: { items: [{ id: 'bags-4', size: '', qty: 1 }], customer: { name: 'Dilani Perera', phone: '0779876543', email: cemail, address: '8 Sea Street', city: 'Galle', district: 'Galle', note: '' }, payment: 'cod' }, p_customer_id: custId, p_idempotency_key: null }) })).json();
sql(`UPDATE app.orders SET status = 'delivered' WHERE order_number = '${myOrder.orderNumber}'`);
await kp2.reload(); await kp2.waitForSelector(`[data-rev="${myOrder.orderNumber}"]`, { timeout: 20000 });
await kp2.click(`[data-rev="${myOrder.orderNumber}"]`); await kp2.waitForSelector(`#rev-${myOrder.orderNumber} .rev-form`, { timeout: 15000 });
check('My orders: "Rate & review" opens the stars and comment under the order', (await kp2.$$(`#rev-${myOrder.orderNumber} .star-pick button`)).length === 5);
await kp2.click(`#rev-${myOrder.orderNumber} .star-pick button[data-n="5"]`); await kp2.fill(`#rev-${myOrder.orderNumber} textarea`, 'Perfect size for my phone.');
await kp2.click(`#rev-${myOrder.orderNumber} .rev-form button.btn`);
await kp2.waitForFunction((n) => /Update review/.test(document.getElementById('rev-' + n)?.textContent || ''), myOrder.orderNumber, { timeout: 15000 });
check('review from My orders saved', sql(`SELECT rating || ' ' || comment FROM app.product_reviews WHERE customer_id = '${custId}'`) === '5 Perfect size for my phone.');
await kp2.setViewportSize({ width: 390, height: 844 }); await kp2.waitForTimeout(300);
check('My orders review on a phone: no sideways scrolling', (await kp2.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
await kp2.evaluate((n) => document.getElementById('rev-' + n).scrollIntoView(), myOrder.orderNumber); await kp2.screenshot({ path: OUT + '/sb-myorders-review-phone.jpg', type: 'jpeg', quality: 70 });
await kp2.setViewportSize({ width: 1366, height: 860 });
await kp2.evaluate(() => { location.hash = 'p/bags-4'; }); await kp2.waitForSelector('#revBox .rev', { timeout: 15000 });
check('the review shows the customer photo', await kp2.evaluate(() => { const i = [...document.querySelectorAll('#revBox .rev')].find(r => /Dilani P\./.test(r.textContent))?.querySelector('.avatar img'); return !!i && i.complete && i.naturalWidth > 0; }));
check('the rating at the top of the product page follows the live reviews', /5 · 1 rating/.test(await kp2.textContent('.rev-jump')));
await kp2.locator('#revPanel .rev').first().scrollIntoViewIfNeeded(); await kp2.waitForTimeout(1200);   // pictures fade in when they come into view
await kp2.waitForFunction(() => { const l = [...document.querySelectorAll('#revPanel img')]; return l.length > 0 && l.every(i => i.complete && i.naturalWidth > 0); }, null, { timeout: 15000 });
await kp2.locator('#revPanel').screenshot({ path: OUT + '/sb-reviews-photo.jpg', type: 'jpeg', quality: 70 });
await cust.close();
// staff: registered accounts and a new password for a customer who forgot it
await ap.evaluate(() => { location.hash = 'dashboard'; }); await ap.waitForTimeout(600);
await ap.evaluate(() => { location.hash = 'customers'; }); await ap.waitForSelector('#alist table', { timeout: 15000 });
check('admin: registered accounts with both phones and the address', /Dilani Perera[\s\S]*0779876543[\s\S]*8 Sea Street, Galle, Galle/.test(await ap.textContent('#alist')));
await ap.click(`#alist [data-cpw="${custId}"]`); await ap.fill('#cpwF [name=pw]', 'newgalle9'); await ap.click('#cpwF button.primary'); await ap.waitForTimeout(1500);
const relog = await (await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email: cemail, password: 'newgalle9' }) })).json();
check('staff set a new password; the customer signs in with it', !!relog.access_token);

// 11. usage page (main admin)
await ap.evaluate(() => { location.hash = 'usage'; }); await ap.waitForSelector('.use-row', { timeout: 15000 });
const use = await ap.$$eval('.use-row .use-head', l => l.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
check('usage page shows database, photos, monthly users and connections against the plan', use.length === 4 && /Database.* of 8 GB/.test(use[0]) && /of 100 GB/.test(use[1]) && /of 100,000/.test(use[2]) && /allowed/.test(use[3]), use.join(' | '));
check('usage page: orders in total match the database', (await ap.textContent('#view')).includes(Number(sql(`SELECT count(*) FROM app.orders`)).toLocaleString('en-US')));

check('no JavaScript errors in any page', errors.length === 0, errors.slice(0, 5).join(' | '));
await b.close();
sql(`UPDATE app.security_settings SET require_staff_mfa = false`);
console.log(results.join('\n'));
console.log(failed ? `\n${failed} FAILED` : `\nALL ${results.length} PASSED`);
process.exit(failed ? 1 : 0);
