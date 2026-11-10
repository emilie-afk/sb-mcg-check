// token.js — signed, expiring access tokens ("<timestamp>.<hmac>").
// The format is unchanged, so tokens already held by callers (the browser and
// Plant Breakdown's tracker gateway) stay valid across this change.

const crypto = require("crypto");

const TOKEN_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h

function makeToken(secret, now = Date.now()) {
  const ts = String(now);
  const sig = crypto.createHmac("sha256", secret).update(ts).digest("hex");
  return `${ts}.${sig}`;
}

function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || !secret) return false;
  const m = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const [, ts, sig] = m;
  const age = now - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > TOKEN_MAX_AGE_MS) return false;
  const expected = crypto.createHmac("sha256", secret).update(ts).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
}

// Constant-time string comparison (hashes first so lengths never leak).
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

module.exports = { makeToken, verifyToken, safeEqual, TOKEN_MAX_AGE_MS };
