// Run: npm test   (node:test; no network, no real data, no Netlify account)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createHandler } = require("../netlify/functions/scrape.js");
const auth = require("../netlify/functions/auth.js");
const { makeToken, verifyToken } = require("../netlify/lib/token");
const { compare, keyWords } = require("../netlify/lib/matching");
const { parseConfig } = require("../netlify/lib/tracker-config");

const SECRET = "test-secret-not-real-0123456789abcdef";
const NOW = 1_800_000_000_000;
const FICTIONAL_CONFIG = JSON.stringify({
  version: 1,
  excludedProducts: ["Examplea fictiva 'Moonbeam' [large]", "Placeholderia demo - Sample Cactus [bare root]"],
});

// In-memory stand-in for @netlify/blobs getStore, with call recording.
function fakeBlobs({ config = FICTIONAL_CONFIG } = {}) {
  const stores = new Map();
  const calls = [];
  const getStore = (name) => {
    calls.push(name);
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    if (name === "tracker-config" && config != null && !m.has("exclusions")) m.set("exclusions", { data: config });
    return {
      async get(k) { return m.has(k) ? m.get(k).data : null; },
      async getWithMetadata(k) { return m.has(k) ? { data: JSON.parse(m.get(k).data), metadata: m.get(k).metadata } : null; },
      async setJSON(k, v, o = {}) { m.set(k, { data: JSON.stringify(v), metadata: o.metadata }); },
    };
  };
  return { getStore, calls, stores };
}

function fixtureScrape() {
  let n = 0;
  const fn = async () => {
    n++;
    return [
      { inStock: ["Echeveria Lumina Rosette", "Ghostly Demo"], outOfStock: ["Sedum Testus Groundcover"] },
      [
        { name: "Echeveria lumina - Rosette [large]", url: "https://supplier.example/a" },
        { name: "Sedum testus 'Groundcover'", url: "https://supplier.example/b" },
        { name: "Examplea fictiva 'Moonbeam'", url: "https://supplier.example/c" },   // excluded by config
        { name: "Novella imaginaria - Brand New", url: "https://supplier.example/d" },
        { name: "Hoya demo vine", url: "https://supplier.example/e" },                 // houseplant skip
      ],
    ];
  };
  fn.count = () => n;
  return fn;
}
const noEnrich = async (items) => items.map((i) => ({ ...i, sku: "SKU-" + i.name.length }));

function setup(over = {}) {
  const blobs = fakeBlobs(over.blobs);
  const scrape = fixtureScrape();
  const handler = createHandler({
    getStore: blobs.getStore, now: () => over.now ?? NOW, scrape, enrich: noEnrich,
    env: { TOKEN_SECRET: SECRET, ...(over.env || {}) },
  });
  return { handler, blobs, scrape };
}
const bearer = (t) => ({ headers: { authorization: "Bearer " + t }, queryStringParameters: {} });

test("unauthorized requests stop before config, cache or scraping", async () => {
  const valid = makeToken(SECRET, NOW);
  const cases = [
    { headers: {} },
    bearer(""),
    bearer("garbage"),
    bearer(valid.split(".")[0] + ".abc"),                      // short signature (used to throw)
    bearer(makeToken("other-secret", NOW)),
    bearer(makeToken(SECRET, NOW - 9 * 3600 * 1000)),          // expired
    bearer(makeToken(SECRET, NOW + 60 * 1000)),                // from the future
  ];
  for (const ev of cases) {
    const { handler, blobs, scrape } = setup();
    const r = await handler(ev);
    assert.equal(r.statusCode, 401);
    assert.equal(blobs.calls.length, 0, "no Blobs access");
    assert.equal(scrape.count(), 0, "no scraping");
  }
});

test("missing TOKEN_SECRET denies every request", async () => {
  const { handler, scrape } = setup({ env: { TOKEN_SECRET: "" } });
  const r = await handler(bearer(makeToken(SECRET, NOW)));
  assert.equal(r.statusCode, 401);
  assert.equal(scrape.count(), 0);
});

test("missing or invalid exclusion config fails closed (503) without scraping", async () => {
  for (const config of [null, "not json", JSON.stringify({ excludedProducts: "x" }), JSON.stringify({ excludedProducts: [1] })]) {
    const { handler, scrape } = setup({ blobs: { config } });
    const r = await handler(bearer(makeToken(SECRET, NOW)));
    assert.equal(r.statusCode, 503);
    assert.deepEqual(JSON.parse(r.body), { error: "Not configured" });
    assert.equal(scrape.count(), 0);
  }
});

test("authorized request returns the same response contract, applies the protected list", async () => {
  const { handler } = setup();
  const r = await handler(bearer(makeToken(SECRET, NOW)));
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body).sort(), ["cachedAt", "fromCache", "mcgOnly", "sbOos"]);
  assert.equal(body.fromCache, false);
  const names = [...body.mcgOnly, ...body.sbOos].map((x) => x.name);
  assert.ok(!names.some((n) => /fictiva/.test(n)), "excluded product left out");
  assert.ok(!names.some((n) => /^Hoya/.test(n)), "houseplant left out");
  assert.deepEqual(body.mcgOnly.map((x) => x.name), ["Novella imaginaria - Brand New"]);
  assert.deepEqual(body.sbOos.map((x) => x.name), ["Sedum testus 'Groundcover'"]);
  for (const x of [...body.mcgOnly, ...body.sbOos]) assert.deepEqual(Object.keys(x).sort(), ["name", "sku", "url"]);
  assert.ok(!r.body.includes("excludedProducts"), "config never echoed");
});

test("cache is used, and invalidated when the protected list changes", async () => {
  const blobs = fakeBlobs();
  const scrape = fixtureScrape();
  const mk = () => createHandler({ getStore: blobs.getStore, now: () => NOW, scrape, enrich: noEnrich, env: { TOKEN_SECRET: SECRET } });
  const t = makeToken(SECRET, NOW);
  await mk()(bearer(t));
  const second = JSON.parse((await mk()(bearer(t))).body);
  assert.equal(second.fromCache, true);
  assert.equal(scrape.count(), 1);
  // refresh=true bypasses the cache
  await mk()({ ...bearer(t), queryStringParameters: { refresh: "true" } });
  assert.equal(scrape.count(), 2);
  // config change → cached result no longer used
  blobs.stores.get("tracker-config").set("exclusions", { data: JSON.stringify({ excludedProducts: ["Other fictional thing"] }) });
  const third = JSON.parse((await mk()(bearer(t))).body);
  assert.equal(third.fromCache, false);
  assert.equal(scrape.count(), 3);
  assert.ok(third.mcgOnly.some((x) => /fictiva/.test(x.name)));
});

test("scrape failure does not leak error details", async () => {
  const handler = createHandler({
    getStore: fakeBlobs().getStore, now: () => NOW, env: { TOKEN_SECRET: SECRET },
    scrape: async () => { throw new Error("internal detail https://example.invalid/secret-path"); },
  });
  const r = await handler(bearer(makeToken(SECRET, NOW)));
  assert.equal(r.statusCode, 502);
  assert.deepEqual(JSON.parse(r.body), { error: "Scraping failed" });
});

test("auth endpoint: contract kept, fails closed, constant-time compare", async () => {
  const saved = { ...process.env };
  try {
    process.env.SITE_PASSWORD = "fictional-password";
    process.env.TOKEN_SECRET = SECRET;
    const ok = await auth.handler({ httpMethod: "POST", body: JSON.stringify({ password: "fictional-password" }) });
    assert.equal(ok.statusCode, 200);
    const j = JSON.parse(ok.body);
    assert.equal(j.ok, true);
    assert.ok(verifyToken(j.token, SECRET));
    for (const pw of ["wrong", "", undefined, 123, "fictional-password "]) {
      const bad = await auth.handler({ httpMethod: "POST", body: JSON.stringify({ password: pw }) });
      assert.equal(bad.statusCode, 401);
      assert.deepEqual(JSON.parse(bad.body), { ok: false });
    }
    assert.equal((await auth.handler({ httpMethod: "GET" })).statusCode, 405);
    delete process.env.SITE_PASSWORD;
    const off = await auth.handler({ httpMethod: "POST", body: JSON.stringify({ password: "" }) });
    assert.equal(off.statusCode, 500);
    assert.ok(!off.body.includes("SITE_PASSWORD"));
  } finally {
    process.env = saved;
  }
});

test("config parser and fictional example", () => {
  const ex = require("fs").readFileSync(path.join(__dirname, "../docs/tracker-config.example.json"), "utf8");
  const c = parseConfig(ex);
  assert.equal(c.names.length, 2);
  assert.equal(parseConfig({ excludedProducts: [] }).names.length, 0);
  assert.equal(parseConfig([]), null);
});

test("generic matching: exclusion uses keyword overlap", () => {
  const ex = [keyWords("Examplea fictiva 'Moonbeam' [large]")];
  const r = compare([], [], [{ name: "Examplea fictiva Moonbeam [small]", url: "" }, { name: "Unrelated thing", url: "" }], ex);
  assert.deepEqual(r.mcgOnly.map((x) => x.name), ["Unrelated thing"]);
});

test("production Blobs path: connects from the event and reads the list without strong consistency", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); const method = String(init.method || "GET").toUpperCase();
    seen.push(method + " " + u.replace(/^https:\/\/edge\.blobs\.example/, ""));
    if (method === "GET" && /tracker-config.*exclusions/.test(u)) return new Response(FICTIONAL_CONFIG, { status: 200 });
    if (method === "GET") return new Response(null, { status: 404 });
    return new Response(null, { status: 200 });
  };
  try {
    const handler = createHandler({ now: () => NOW, scrape: fixtureScrape(), enrich: noEnrich, env: { TOKEN_SECRET: SECRET } });
    const blobs = Buffer.from(JSON.stringify({ url: "https://edge.blobs.example", token: "fictional-blobs-token" })).toString("base64");
    const r = await handler({ ...bearer(makeToken(SECRET, NOW)), blobs, headers: { authorization: "Bearer " + makeToken(SECRET, NOW), "x-nf-site-id": "site-123", "x-nf-deploy-id": "deploy-1" } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(JSON.parse(r.body).mcgOnly.map((x) => x.name), ["Novella imaginaria - Brand New"]);
    assert.ok(seen.some((s) => /exclusions/.test(s)), "list read through Blobs");
  } finally {
    globalThis.fetch = realFetch;
  }
});
