// auth.js — password is checked here, server-side only.
// SITE_PASSWORD and TOKEN_SECRET live in Netlify environment variables.
// Neither value is ever sent to the browser.

const crypto = require("crypto");

function makeToken(secret) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac("sha256", secret).update(ts).digest("hex");
  return `${ts}.${sig}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const sitePassword = process.env.SITE_PASSWORD;
  const tokenSecret  = process.env.TOKEN_SECRET;

  if (!sitePassword || !tokenSecret) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server not configured. Set SITE_PASSWORD and TOKEN_SECRET in Netlify environment variables." }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  if (body.password !== sitePassword) {
    // Constant-time comparison to prevent timing attacks
    const dummy = crypto.createHmac("sha256", tokenSecret).update("dummy").digest("hex");
    void dummy;
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false }),
    };
  }

  const token = makeToken(tokenSecret);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, token }),
  };
};
