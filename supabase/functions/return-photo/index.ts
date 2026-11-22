// POST /functions/v1/return-photo — {number, token?, image: "data:image/jpeg;base64,..."} -> {path}
// Stores one photo for a return request in the PRIVATE "return-photos" bucket. Who may: the signed-in buyer (their own
// token) or a guest holding the order's secret tracking token; the order must be delivered and inside the return window
// (checked by the database: return_photo_check). Only real JPEG / PNG / WebP files up to 2 MB; at most 12 per order.
import { clientIp, dbError, env, json, keyHeaders, preflight, rateLimited, readBody, rpc, SERVICE_KEY, userFrom } from '../_shared/common.ts';

const URL_ = env('SUPABASE_URL');
const MAX = 2 * 1024 * 1024;

// what the bytes really are (the name or the browser's claim is not trusted)
function realType(b: Uint8Array): 'jpeg' | 'png' | 'webp' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'png';
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'webp';
  return null;
}

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json(req, 405, { error: 'method_not_allowed' });
  if (await rateLimited('return-photo:' + clientIp(req), 20, 600)) return json(req, 429, { error: 'rate_limited', message: 'Too many photos. Please wait a few minutes.' });
  const caller = await userFrom(req);
  if (caller === 'invalid') return json(req, 401, { error: 'unauthorized', message: 'Please sign in again.' });
  const raw = await readBody(req, 3_000_000);
  if (raw === null) return json(req, 413, { error: 'too_large', message: 'The photo is larger than 2 MB. Choose a smaller photo.' });
  let b: any; try { b = JSON.parse(raw); } catch { return json(req, 400, { error: 'bad_request', message: 'The request could not be read.' }); }
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b?.image ?? ''));
  if (!m) return json(req, 400, { error: 'bad_request', message: 'Use a JPEG, PNG or WebP photo.' });
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch { return json(req, 400, { error: 'bad_request', message: 'The photo could not be read.' }); }
  if (bytes.length > MAX) return json(req, 400, { error: 'too_large', message: 'The photo is larger than 2 MB. Choose a smaller photo.' });
  const t = realType(bytes);
  if (!t || t !== m[1]) return json(req, 400, { error: 'bad_request', message: 'Use a JPEG, PNG or WebP photo.' });

  const chk = await rpc('return_photo_check', { p_number: String(b?.number ?? '').slice(0, 30), p_token: b?.token ? String(b.token).slice(0, 100) : null }, caller ? caller.token : undefined);
  if (!chk.ok) return dbError(req, chk);
  if (Number(chk.data?.photos ?? 0) >= 12) return json(req, 400, { error: 'bad_request', message: 'Too many photos for this order. Please call us.' });

  const path = `returns/${chk.data.orderId}/${crypto.randomUUID()}.${t === 'jpeg' ? 'jpg' : t}`;
  const up = await fetch(`${URL_}/storage/v1/object/return-photos/${path}`, {
    method: 'POST', headers: { ...keyHeaders(SERVICE_KEY), 'content-type': `image/${t}`, 'x-upsert': 'false' }, body: bytes,
  });
  if (!up.ok) { console.error('return photo upload failed', up.status, await up.text()); return json(req, 500, { error: 'server_error', message: 'The photo could not be saved. Please try again.' }); }
  return json(req, 200, { path });
});
