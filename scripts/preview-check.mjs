// Preview check for the plant tracker — run against a Netlify deploy preview (or
// production) after the exclusion list is uploaded. No paid services are used;
// one scrape of the public storefront pages runs (about 30 s on a cold cache).
//
//   PREVIEW_PASSWORD='<SITE_PASSWORD>' node scripts/preview-check.mjs https://deploy-preview-N--<site>.netlify.app \
//     [--prb-core /path/to/sb-plant-breakdown/server/tracker-core.mjs]
//
// Checks: unauthenticated scrape refused; sign-in returns a token; the function
// reads the protected list (200, not 503) and answers in the shape Plant
// Breakdown expects; optionally runs Plant Breakdown's own gateway code
// (trackerCore) against this URL, exactly as the Edge Function would.
const base = (process.argv[2] || '').replace(/\/+$/, '');
const pi = process.argv.indexOf('--prb-core');
const prbCore = pi > 0 ? process.argv[pi + 1] : null;
const password = process.env.PREVIEW_PASSWORD || '';
if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(base + '/') || !password) {
  console.error('Usage: PREVIEW_PASSWORD=... node scripts/preview-check.mjs https://<preview-url> [--prb-core path]');
  process.exit(2);
}
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };
const scrapeUrl = base + '/.netlify/functions/scrape';

let r = await fetch(scrapeUrl);
check('unauthenticated scrape refused', r.status === 401, `status ${r.status}`);
r = await fetch(scrapeUrl, { headers: { authorization: 'Bearer 1.' + '0'.repeat(64) } });
check('forged token refused', r.status === 401, `status ${r.status}`);

r = await fetch(base + '/.netlify/functions/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
const j = await r.json().catch(() => ({}));
check('sign-in returns a token', r.status === 200 && j.ok === true && typeof j.token === 'string', `status ${r.status}`);

if (j.token) {
  const t0 = Date.now();
  r = await fetch(scrapeUrl, { headers: { authorization: 'Bearer ' + j.token } });
  const body = await r.json().catch(() => ({}));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check('protected list readable (scrape answers 200, not 503)', r.status === 200, r.status === 503 ? 'exclusion list missing or unreadable (503)' : `status ${r.status}`);
  const shape = Array.isArray(body.mcgOnly) && Array.isArray(body.sbOos) && typeof body.cachedAt === 'number' && typeof body.fromCache === 'boolean';
  check('response shape unchanged', shape, shape ? `${body.mcgOnly.length} supplier-only, ${body.sbOos.length} out of stock, fromCache=${body.fromCache}, ${secs}s` : JSON.stringify(Object.keys(body)));
}

if (prbCore) {
  const { trackerCore, _resetTrackerToken } = await import(prbCore);
  _resetTrackerToken();
  const env = { STOCK_TRACKER_URL: base + '/', STOCK_TRACKER_PASSWORD: password };
  const res = await trackerCore(new Request('https://plant-breakdown.example/api/stock-tracker'), { env, authorize: async () => ({ ok: true }) });
  const b = await res.json().catch(() => ({}));
  check("Plant Breakdown's gateway loads the tracker", res.status === 200 && Array.isArray(b.supplierOnly) && Array.isArray(b.sbOos), `status ${res.status}${b.error ? ' ' + b.error : ''}`);
}
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
