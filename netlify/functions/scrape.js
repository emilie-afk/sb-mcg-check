// scrape.js — server-side scraping of SB and MCG.
// Token is verified before any data is returned.
// Results are cached in Netlify Blobs for 12 hours to stay within function timeouts.

const cheerio = require("cheerio");
const { getStore, connectLambda } = require("@netlify/blobs");
const { verifyToken } = require("../lib/token");
const { compare } = require("../lib/matching");
const { loadTrackerConfig } = require("../lib/tracker-config");

const CACHE_KEY    = "scrape-results";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Business-specific settings (the supplier products left out of the report)
// are protected configuration, loaded at run time; see ../lib/tracker-config.js.

// ── Scrape Succulents Box (Shopify JSON API) ──────────────────────────────────
async function scrapeSB() {
  const inStock = [], outOfStock = [];
  const seenTitles = new Set();
  // Use /products.json (all collections) so we don't miss plants in cacti,
  // agave, or other sub-collections that aren't under /collections/succulents.
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://succulentsbox.com/products.json?limit=250&page=${page}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) break;
    const data = await res.json();
    if (!data.products || data.products.length === 0) break;
    for (const p of data.products) {
      if (seenTitles.has(p.title)) continue;
      seenTitles.add(p.title);
      const available = p.variants.some(v => v.available);
      if (available) inStock.push(p.title);
      else outOfStock.push(p.title);
    }
    page++;
  }
  // User-confirmed plants that may be missed by the API
  if (!inStock.some(n => /aurora/i.test(n) && /echeveria/i.test(n))) {
    inStock.push("Echeveria Aurora");
  }
  if (!inStock.some(n => /delosperma/i.test(n) && /echinatum/i.test(n))) {
    inStock.push("Delosperma echinatum Pickle Plant");
  }
  return { inStock, outOfStock };
}

// ── Scrape Mountain Crest Gardens (HTML, parallel) ────────────────────────────
async function scrapeMCG() {
  const MAX_PAGES = 30;
  const results = await Promise.all(
    Array.from({ length: MAX_PAGES }, (_, i) =>
      fetch(`https://mountaincrestgardens.com/explore-all/?page=${i + 1}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      })
        .then(r => (r.ok ? r.text() : ""))
        .catch(() => "")
    )
  );

  // Use a Map keyed by name to store {name, url}
  const products = new Map();
  for (const html of results) {
    if (!html) continue;
    const $ = cheerio.load(html);
    $(".card").each((_, card) => {
      const $card = $(card);
      const name = $card.find("h3").text().trim();
      const url  = $card.find("a").first().attr("href") || "";
      if (name && !products.has(name)) products.set(name, { name, url });
    });
  }
  return [...products.values()];
}

// ── Fetch SKU from individual MCG product page ────────────────────────────────
async function fetchSKU(url) {
  if (!url) return "";
  try {
    const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return "";
    const html = await res.text();
    // Extract productGroupID from JSON-LD (fastest, most reliable)
    const match = html.match(/"productGroupID"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
    // Fallback: data-product-sku attribute
    const skuMatch = html.match(/data-product-sku="([^"]+)"/);
    return skuMatch ? skuMatch[1] : "";
  } catch {
    return "";
  }
}

// ── Enrich results with SKUs (parallel fetch of product pages) ────────────────
async function enrichWithSKUs(items) {
  const enriched = await Promise.all(
    items.map(async item => {
      const sku = await fetchSKU(item.url);
      return { ...item, sku };
    })
  );
  return enriched;
}

// ── Handler ───────────────────────────────────────────────────────────────────
// deps are injectable for tests; production uses the real ones.
function createHandler(deps = {}) {
  const blobs  = deps.getStore || getStore;
  const now    = deps.now || Date.now;
  const env    = deps.env || process.env;
  const scrape = deps.scrape || (() => Promise.all([scrapeSB(), scrapeMCG()]));
  const enrich = deps.enrich || enrichWithSKUs;

  return async (event) => {
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

    // 1. Authorization — before any configuration, cache or network access.
    const auth   = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
    const token  = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!verifyToken(token, env.TOKEN_SECRET, now())) {
      return reply(401, { error: "Unauthorized" });
    }

    // Classic (Lambda-style) functions must connect Blobs from the event first.
    if (!deps.getStore && event.blobs) {
      try { connectLambda(event); } catch { /* treated as unavailable below */ }
    }

    // 2. Protected configuration. Missing or invalid → refuse (fail closed).
    const config = await loadTrackerConfig({ getStore: blobs, env });
    if (!config) return reply(503, { error: "Not configured" });

    const forceRefresh = event.queryStringParameters?.refresh === "true";

    // 3. Cache (only results computed with the current configuration).
    let store;
    try {
      store = blobs("plant-data");
      if (!forceRefresh) {
        const cached = await store.getWithMetadata(CACHE_KEY, { type: "json" });
        const meta = cached?.metadata;
        if (meta?.cachedAt && meta.configFingerprint === config.fingerprint) {
          const age = now() - meta.cachedAt;
          if (age >= 0 && age < CACHE_TTL_MS) {
            return reply(200, { ...cached.data, cachedAt: meta.cachedAt, fromCache: true });
          }
        }
      }
    } catch {
      // Blobs unavailable (local dev) — proceed without cache
    }

    // 4. Scrape both public sites in parallel
    let sbIn, sbOut, mcgRaw;
    try {
      const [sb, mcg] = await scrape();
      sbIn   = sb.inStock;
      sbOut  = sb.outOfStock;
      mcgRaw = mcg;
    } catch {
      return reply(502, { error: "Scraping failed" });
    }

    let { mcgOnly, sbOos } = compare(sbIn, sbOut, mcgRaw, config.exclusionKw);

    // Fetch SKUs for all result plants in parallel
    [mcgOnly, sbOos] = await Promise.all([enrich(mcgOnly), enrich(sbOos)]);

    const result = { mcgOnly, sbOos, cachedAt: now(), fromCache: false };

    // Save to cache
    try {
      if (store) {
        await store.setJSON(CACHE_KEY, result, {
          metadata: { cachedAt: result.cachedAt, configFingerprint: config.fingerprint },
        });
      }
    } catch { /* ignore cache write errors */ }

    return reply(200, result);
  };
}

exports.handler = createHandler();
exports.createHandler = createHandler;
