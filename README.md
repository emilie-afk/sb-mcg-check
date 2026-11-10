# Plant tracker (sb-mcg-check)

Compares the supplier catalogue with the Succulents Box storefront and lists
plants the supplier carries that the store does not (or has out of stock).
Plant Breakdown's tracker gateway reads the same endpoints server-side.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /.netlify/functions/auth` `{ "password": "…" }` | site password | Returns `{ ok: true, token }`, a signed token valid for 8 hours |
| `GET /.netlify/functions/scrape[?refresh=true]` | `Authorization: Bearer <token>` | Returns `{ mcgOnly, sbOos, cachedAt, fromCache }`; cached 12 h |

Requests without a valid token get `401` before any configuration, cache or
network access. If the protected configuration below is missing, `scrape`
answers `503` instead of reporting without it.

## Configuration (Netlify, never in Git)

| Setting | Where | Notes |
|---|---|---|
| `SITE_PASSWORD` | environment variable | Shared password for the page and the gateway |
| `TOKEN_SECRET` | environment variable | Random, at least 32 characters |
| Exclusion list | Netlify Blobs store `tracker-config`, key `exclusions` | Supplier products to leave out of the report. Shape: `docs/tracker-config.example.json` (fictional). Upload with `scripts/upload-tracker-config.mjs`; keep the real file outside this repository. Changing it invalidates the cached result automatically. |

For `netlify dev`, `TRACKER_CONFIG_FILE=/path/to/local.json` can point at a
local file instead of Blobs.

## Tests

`npm install` first (cheerio, @netlify/blobs), then `npm test` (fictional fixtures only; no network or
Netlify account needed).

## Preview check

After uploading the exclusion list, check a deploy preview (no paid services; one public scrape):

`PREVIEW_PASSWORD=<SITE_PASSWORD> node scripts/preview-check.mjs https://deploy-preview-N--<site>.netlify.app --prb-core ../sb-plant-breakdown/server/tracker-core.mjs`

It confirms unauthenticated requests are refused, the function reads the protected list
through Blobs (200, not 503), the response shape is unchanged, and Plant Breakdown's own
gateway code can load the tracker from that URL.
