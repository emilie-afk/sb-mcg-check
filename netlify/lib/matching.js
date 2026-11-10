// matching.js — generic name matching between the supplier catalogue and the
// Succulents Box storefront. Contains no business-specific lists: the products
// to leave out of the report are passed in from protected configuration
// (see tracker-config.js).

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

// Two keyword sets "overlap" if they share ≥2 words, OR if either side
// has only 1 keyword and that keyword appears in the other set.
// This catches common-name plants like "Ghost Plant" (→ {"ghost"}) that
// have only one meaningful token after stopword filtering.
function overlaps(kwA, kwB) {
  const score = matchScore(kwA, kwB);
  if (score >= 2) return true;
  if (score === 1 && (kwA.size === 1 || kwB.size === 1)) return true;
  return false;
}

// Skip houseplants and air plants
const HOUSEPLANT_PREFIXES = ["hoya ", "air plant", "peperomia ", "ledebouria ", "plectranthus "];

function isHouseplant(name) {
  const lower = name.toLowerCase();
  return HOUSEPLANT_PREFIXES.some(p => lower.startsWith(p));
}

function isExcluded(mcgKw, exclusionKw) {
  for (const ekw of exclusionKw) {
    if (overlaps(mcgKw, ekw)) return true;
  }
  return false;
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

// ── Compare ───────────────────────────────────────────────────────────────────
// exclusionKw: array of keyword sets built with keyWords() from the protected
// exclusion list.
function compare(sbIn, sbOut, mcgRaw, exclusionKw) {
  const sbInWords  = sbIn.map(n  => [n,  keyWords(n)]);
  const sbOutWords = sbOut.map(n => [n,  keyWords(n)]);

  function findSBStatus(mcgName) {
    const mcgKw = keyWords(mcgName);
    if (mcgKw.size === 0) return null;
    for (const [, kw] of sbInWords)  if (overlaps(mcgKw, kw))  return "IN";
    for (const [, kw] of sbOutWords) if (overlaps(mcgKw, kw))  return "OUT";
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
    if (isExcluded(mcgKw, exclusionKw)) continue;
    const status = findSBStatus(name);
    if (status === "IN") continue;
    if (status === "OUT") sbOos.push({ name, url, sku: "" });
    else mcgOnly.push({ name, url, sku: "" });
  }

  mcgOnly.sort((a, b) => a.name.localeCompare(b.name));
  sbOos.sort((a,  b) => a.name.localeCompare(b.name));
  return { mcgOnly, sbOos };
}

module.exports = { clean, keyWords, overlaps, isHouseplant, isExcluded, deduplicateMCG, compare };
