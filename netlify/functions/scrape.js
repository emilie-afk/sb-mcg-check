// scrape.js — server-side scraping of SB and MCG.
// Token is verified before any data is returned.
// Results are cached in Netlify Blobs for 12 hours to stay within function timeouts.

const crypto  = require("crypto");
const cheerio = require("cheerio");
const { getStore } = require("@netlify/blobs");

const CACHE_KEY    = "scrape-results";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ── Token verification ────────────────────────────────────────────────────────
function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [ts, sig] = parts;
  const age = Date.now() - parseInt(ts, 10);
  if (isNaN(age) || age < 0 || age > 8 * 60 * 60 * 1000) return false; // 8h max
  const expected = crypto.createHmac("sha256", secret).update(ts).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── Text cleaning & keyword matching (mirrors compare_final.py logic) ─────────
const STOPS = new Set([
  "the","and","for","plant","succulent","cactus","live","large","small","extra",
  "bare","root","plug","limited","exclusive","unrooted","landscape","quality",
  "var","ssp","spp","from","with","type","form",
]);

function clean(name) {
  return name
    .replace(/\[.*?\]/g, "")
    .replace(/[™®©]/g, "")
    .replace(/[''\"']/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keyWords(name) {
  return new Set(
    clean(name).split(" ").filter(w => w.length > 3 && !STOPS.has(w))
  );
}

function matchScore(kwA, kwB) {
  let n = 0;
  for (const w of kwA) if (kwB.has(w)) n++;
  return n;
}

// ── Exclusion list (Over $19 from MCG_exclusion_products.xlsx) ───────────────
const EXCLUSION_RAW = [
  "Cereus forbesii 'Spiralis' - Spiral Cactus [extra large]",
  "Myrtillocactus geometrizans - Boobie Cactus [extra large] [unrooted]",
  "Cereus forbesii 'Spiralis' - Spiral Cactus [bare root] [extra large]",
  "Eulychnia castanea f. spiralis - Unicorn Cactus [bare root] [pre-spiral]",
  "Air Plant - Tillandsia xerographica  [7.0-8.0\"]",
  "Ceropegia woodii f. variegata - Variegated String of Hearts [extra large]",
  "Eulychnia castanea f. spiralis - Unicorn Cactus [bare root] [limited]",
  "Echeveria 'Rainbow' [extra large]",
  "Myrtillocactus geometrizans - Boobie Cactus [landscape quality] [limited]",
  "Myrtillocactus geometrizans - Boobie Cactus [large] [limited]",
  "Dudleya gnoma 'White Sprite' [large] [limited]",
  "Adromischus marianae f. herrei [large] [limited]",
  "Trichodiadema bulbosum - African Bonsai [caudex] [extra large]",
  "Adenium obesum 'CF 31' [12\"-14\"] [bare root]",
  "Adenium obesum 'Milkyway' [13\"-15\"] [bare root]",
  "Adenium 'White Jade Peony' [13\"-15\"] [bare root]",
  "Opuntia 'Sunburst' [extra large] [bare root]",
  "Ceropegia woodii f. variegata - Variegated String of Hearts [large] [limited]",
  "Tephrocactus subterraneus [bare root]",
  "Air Plant - Tillandsia tectorum 'Ecuador' [6.0\"] [large]",
  "Echeveria 'Rainbow' [large]",
  "Mangave 'Praying Hands' [large]",
  "Myrtillocactus geometrizans - Boobie Cactus [bare root]",
  "Cereus forbesii 'Spiralis' - Spiral Cactus [large] [bare root]",
  "Aeonium 'Pink Witch' [extra large]",
  "Aeonium 'Medusa' [large]",
  "Mammillaria bocasana f. monstruosa 'Fred' [bare root]",
  "Cereus spegazzinii f. cristata [bare root]",
  "Greenovia aurea [large] [fragile]",
  "Conophytum ficiforme [large] [limited]",
  "Hoya kerrii - Heart Plant (full vine, 4+ leaves) [large] [painted]",
  "Senecio candicans - Angel Wings [GIANT]",
  "Hoya kerrii f. variegata - Outer Variegated Sweetheart Hoya [large]",
  "Echeveria laui [large] [limited]",
  "Echeveria 'Lilac Frost' [large]",
  "Peperomia asperula [large]",
  "Hoya kerrii f. variegata - Inner Variegated Sweetheart Hoya [large]",
  "Euphorbia lactea crested [extra large] [bare root]",
  "Euphorbia meloformis f. variegata [cutting] [limited]",
  "Gymnocalycium mihanovichii f. variegata - Variegated Moon Cactus [large]",
  "Myrtillocactus geometrizans f. cristatus - Dinosaur Back [extra large]",
  "Trichocereus bridgesii - Penis Cactus [bare root] [limited]",
  "Myrtillocactus geometrizans f. cristatus - Dinosaur Back [large] [bare root]",
  "Euphorbia meloformis f. variegata [limited] - Offsets",
  "Aloe polyphylla - Spiral Aloe [large] [limited]",
  "Ceropegia woodii - String of Hearts [extra large] [limited]",
  "Crassula 'Buddha's Temple' [4\" premium] [cutting]",
  "Extra Large Cutting - Echeveria 'Baron Bold'",
  "Agave victoriae-reginae f. variegata - Variegated Queen Victoria Agave [extra large] [bare root]",
  "Agave victoriae-reginae - Queen Victoria Agave [extra large] [bare root]",
  "Mangave 'Night Owl' [extra large] [bare root]",
  "Euphorbia meloformis f. variegata [bare root] - With offsets",
  "Tephrocactus alexanderi - Indian Ball Cactus [bare root]",
  "Gymnocalycium mihanovichii f. variegata - Variegated Moon Cactus [2.5-3\"] [bare root]",
  "Fockea edulis [large]",
  "Euphorbia lactea crested [large]",
  "Aeonium 'Pink Witch' [large]",
  "Fockea capensis [large]",
  "Euphorbia obesa - Baseball Plant",
  "Echeveria 'Lilac Frost' [limited]",
  "Echeveria 'Fire and Ice' [large]",
  "Adromischus marianae 'Clanwilliam' [large]",
  "Adenia viridiflora [7.0-10.0\"] [unrooted]",
  "Euphorbia meloformis f. variegata [limited] - Standard",
  "Agave isthmensis 'Gold Sprite'",
  "Extra Large Cutting - Echeveria 'Rainbow'",
  "Euphorbia meloformis f. variegata [bare root] - Standard",
  "Aloe polyphylla - Spiral Aloe [plug]",
  "Astrophytum asterias 'Super Kabuto' [small] [limited]",
  "Air Plant - Tillandsia 'Houston' Clump [7.0-8.0\"]",
  "Adromischus marianae f. immaculatus [limited]",
  "Echeveria agavoides 'Romeo' [large] [limited]",
  "Agave albopilosa 'Tufts' [large]",
  "Agave isthmensis 'Rum Runner' [extra large]",
  "Dudleya pachyphytum [large] [minor bruising]",
  "Hoya kerrii 'Super Splash' (vine, 4+ leaves) [large]",
  "Sansevieria trifasciata 'Futura Superba' [extra large]",
  "Cotyledon orbiculata 'Undulata' - Silver Ruffles [large] [limited]",
  "Agave applanata 'Cream Spike' [extra large]",
  "Aloe humilis x erinacea [bare root]",
  "Dioscorea elephantipes - Elephant's Foot [limited]",
  "Graptoveria 'Titubans Variegata' [large] [limited]",
  "Extra Large Cutting - Echeveria agavoides 'Frank Reinelt'",
  "Extra Large Cutting - Echeveria 'Dick's Pink'",
  "Extra Large Cutting - Echeveria 'Fire and Ice'",
  "Gymnocalycium mihanovichii f. variegata - Variegated Moon Cactus",
  "Echinocactus grusonii var. brevispinus [large] [bare root]",
  "Senecio rowleyanus f. variegatus - Variegated String of Pearls [extra large] [limited]",
  "Aeonium 'King Kong' [extra large]",
  "Euphorbia obesa - Baseball Plant [bare root] [limited]",
];
const EXCLUSION_KW = EXCLUSION_RAW.map(keyWords);

// Skip houseplants and air plants
const HOUSEPLANT_PREFIXES = ["hoya ", "air plant", "peperomia ", "ledebouria ", "plectranthus "];

function isHouseplant(name) {
  const lower = name.toLowerCase();
  return HOUSEPLANT_PREFIXES.some(p => lower.startsWith(p));
}

function isExcluded(mcgKw) {
  for (const ekw of EXCLUSION_KW) {
    if (matchScore(mcgKw, ekw) >= 2) return true;
  }
  return false;
}

// ── Scrape Succulents Box (Shopify JSON API) ──────────────────────────────────
async function scrapeSB() {
  const inStock = [], outOfStock = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://succulentsbox.com/collections/succulents/products.json?limit=250&page=${page}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) break;
    const data = await res.json();
    if (!data.products || data.products.length === 0) break;
    for (const p of data.products) {
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

// ── De-duplicate MCG by base scientific name ──────────────────────────────────
function deduplicateMCG(products) {
  const seen = new Set();
  const out  = [];
  for (const item of products) {
    const name = item.name || item;
    const base = name.replace(/\[.*?\]/g, "").trim();
    const sci  = base.split(" - ")[0].trim().toLowerCase().replace(/[''\"'™®©]/g, "").trim();
    if (!seen.has(sci)) {
      seen.add(sci);
      out.push(item);
    }
  }
  return out;
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

// ── Compare ───────────────────────────────────────────────────────────────────
function compare(sbIn, sbOut, mcgRaw) {
  const sbInWords  = sbIn.map(n  => [n,  keyWords(n)]);
  const sbOutWords = sbOut.map(n => [n,  keyWords(n)]);

  function findSBStatus(mcgName) {
    const mcgKw = keyWords(mcgName);
    if (mcgKw.size === 0) return null;
    let bestIn = 0, bestOut = 0;
    for (const [, kw] of sbInWords)  bestIn  = Math.max(bestIn,  matchScore(mcgKw, kw));
    for (const [, kw] of sbOutWords) bestOut = Math.max(bestOut, matchScore(mcgKw, kw));
    if (bestIn  >= 2) return "IN";
    if (bestOut >= 2) return "OUT";
    return null;
  }

  const mcgDeduped = deduplicateMCG(mcgRaw);
  const skip = new Set(["mystery", "individual succulent plug"]);

  const mcgOnly = [], sbOos = [];
  for (const item of mcgDeduped) {
    const name  = item.name || item;
    const url   = item.url  || "";
    const lower = name.toLowerCase();
    if ([...skip].some(s => lower.startsWith(s))) continue;
    if (isHouseplant(name)) continue;
    const mcgKw = keyWords(name);
    if (isExcluded(mcgKw)) continue;
    const status = findSBStatus(name);
    if (status === "IN") continue;
    if (status === "OUT") sbOos.push({ name, url, sku: "" });
    else mcgOnly.push({ name, url, sku: "" });
  }

  mcgOnly.sort((a, b) => a.name.localeCompare(b.name));
  sbOos.sort((a,  b) => a.name.localeCompare(b.name));
  return { mcgOnly, sbOos };
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
exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  // Token check
  const token  = (event.headers.authorization || "").replace("Bearer ", "");
  const secret = process.env.TOKEN_SECRET;
  if (!verifyToken(token, secret)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const forceRefresh = event.queryStringParameters?.refresh === "true";

  // Try cache
  let store;
  try {
    store = getStore("plant-data");
    if (!forceRefresh) {
      const cached = await store.getWithMetadata(CACHE_KEY, { type: "json" });
      if (cached?.metadata?.cachedAt) {
        const age = Date.now() - cached.metadata.cachedAt;
        if (age < CACHE_TTL_MS) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ ...cached.data, cachedAt: cached.metadata.cachedAt, fromCache: true }),
          };
        }
      }
    }
  } catch {
    // Blobs unavailable (local dev) — proceed without cache
  }

  // Scrape both sites in parallel
  let sbIn, sbOut, mcgRaw;
  try {
    const [sb, mcg] = await Promise.all([scrapeSB(), scrapeMCG()]);
    sbIn   = sb.inStock;
    sbOut  = sb.outOfStock;
    mcgRaw = mcg;
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Scraping failed: " + err.message }),
    };
  }

  let { mcgOnly, sbOos } = compare(sbIn, sbOut, mcgRaw);

  // Fetch SKUs for all result plants in parallel
  [mcgOnly, sbOos] = await Promise.all([
    enrichWithSKUs(mcgOnly),
    enrichWithSKUs(sbOos),
  ]);

  const result = { mcgOnly, sbOos, cachedAt: Date.now(), fromCache: false };

  // Save to cache
  try {
    if (store) {
      await store.setJSON(CACHE_KEY, result, { metadata: { cachedAt: result.cachedAt } });
    }
  } catch { /* ignore cache write errors */ }

  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
