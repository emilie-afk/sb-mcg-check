// tracker-config.js — loads the protected, business-specific tracker settings.
//
// The list of supplier products to leave out of the report is business
// configuration, not code, so it is NOT kept in this public repository. It is
// stored in the site's Netlify Blobs store "tracker-config" under the key
// "exclusions" (readable only by this site's functions and by people with
// access to the Netlify site). Upload it with scripts/upload-tracker-config.mjs.
//
// Expected JSON shape (see docs/tracker-config.example.json):
//   { "version": 1, "excludedProducts": ["Product name as listed by the supplier", ...] }
//
// If the configuration is missing or invalid the scrape endpoint refuses to
// answer (503) instead of silently reporting without exclusions.
//
// Local development only: set TRACKER_CONFIG_FILE to a local JSON file path
// to use instead of Blobs.

const crypto = require("crypto");
const fs = require("fs");
const { keyWords } = require("./matching");

const CONFIG_STORE = "tracker-config";
const CONFIG_KEY = "exclusions";
const MAX_ENTRIES = 5000;
const MAX_NAME = 300;

function parseConfig(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const list = obj.excludedProducts;
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) return null;
  const names = [];
  for (const n of list) {
    if (typeof n !== "string") return null;
    const t = n.trim();
    if (!t || t.length > MAX_NAME) return null;
    names.push(t);
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(names)).digest("hex").slice(0, 16);
  return { names, exclusionKw: names.map(keyWords), fingerprint };
}

// getStore: the @netlify/blobs getStore function (injected for tests).
async function loadTrackerConfig({ getStore, env = process.env }) {
  try {
    if (env.TRACKER_CONFIG_FILE) {
      return parseConfig(fs.readFileSync(env.TRACKER_CONFIG_FILE, "utf8"));
    }
    const store = getStore(CONFIG_STORE);
    const raw = await store.get(CONFIG_KEY, { type: "text" });   // default (eventual) consistency: strong reads are unavailable in classic functions
    if (raw == null) return null;
    return parseConfig(raw);
  } catch {
    return null;
  }
}

module.exports = { loadTrackerConfig, parseConfig, CONFIG_STORE, CONFIG_KEY };
