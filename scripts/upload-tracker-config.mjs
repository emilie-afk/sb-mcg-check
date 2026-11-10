// Uploads the private tracker configuration (the supplier products to leave
// out of the report) to this site's Netlify Blobs store "tracker-config".
//
// This changes production configuration: run it only with the owner's approval.
//
//   NETLIFY_SITE_ID=<site id> NETLIFY_AUTH_TOKEN=<token> \
//     node scripts/upload-tracker-config.mjs path/to/tracker-config.json
//
// Keep the JSON file outside this repository (it is git-ignored by name).
// Prints only counts, never the list itself.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getStore } from "@netlify/blobs";

const require = createRequire(import.meta.url);
const { parseConfig, CONFIG_STORE, CONFIG_KEY } = require("../netlify/lib/tracker-config.js");

const file = process.argv[2];
const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!file || !siteID || !token) {
  console.error("Usage: NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node scripts/upload-tracker-config.mjs <file>");
  process.exit(2);
}
const raw = readFileSync(file, "utf8");
const parsed = parseConfig(raw);
if (!parsed) { console.error("Invalid configuration file (expected { excludedProducts: [strings] })."); process.exit(1); }

const store = getStore({ name: CONFIG_STORE, siteID, token });
await store.set(CONFIG_KEY, JSON.stringify({ version: 1, excludedProducts: parsed.names }));
const back = parseConfig(await store.get(CONFIG_KEY, { type: "text" }));
if (!back || back.fingerprint !== parsed.fingerprint) { console.error("Uploaded, but read-back did not match."); process.exit(1); }
console.log(`Uploaded ${parsed.names.length} excluded products (fingerprint ${parsed.fingerprint}).`);
