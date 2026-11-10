// auth.js — password is checked here, server-side only.
// SITE_PASSWORD and TOKEN_SECRET live in Netlify environment variables.
// Neither value is ever sent to the browser.

const { makeToken, safeEqual } = require("../lib/token");

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
      body: JSON.stringify({ error: "Server not configured." }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  // Constant-time comparison
  if (!safeEqual(typeof body.password === "string" ? body.password : "", sitePassword)) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false }),
    };
  }

  const token = makeToken(tokenSecret);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ ok: true, token }),
  };
};
