// The only server-side code: forwards the page's AI requests to the Claude API with the key held here.
// The page sends messages and tool definitions; tools themselves run in the browser against the engine.
const MODELS = {
  quick: process.env.DST_MODEL_QUICK || "claude-haiku-5-5",
  default: process.env.DST_MODEL_DEFAULT || "claude-sonnet-5-5",
  complex: process.env.DST_MODEL_COMPLEX || "claude-opus-5-5",
};
const MAX_BODY = 400_000;          // bytes of conversation per request
const MAX_TOKENS = 4096;
const LIMIT_PER_MIN = Number(process.env.DST_RATE_PER_MIN || 30);
const hits = new Map();            // best-effort per-IP rate limit (per server instance)

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Pure request handler: (body, headers, ip) -> {status, json}. Used by the Vercel function and server.mjs. */
export async function handleClaude(body, headers, ip, env = process.env, fetchImpl = fetch) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { status: 503, json: { error: "AI is not configured on this server (ANTHROPIC_API_KEY is missing)." } };
  // Fail closed: AI never runs on an open link. Both the key and an access code must be configured.
  if (!env.DST_ACCESS_CODE || String(env.DST_ACCESS_CODE).length < 6)
    return { status: 503, json: { error: "AI is switched off on this server: no access code is configured (DST_ACCESS_CODE, at least 6 characters)." } };
  if (!safeEqual(String(headers["x-dst-access"] || ""), String(env.DST_ACCESS_CODE)))
    return { status: 401, json: { error: "An access code is needed for the AI features." } };
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (h.length >= LIMIT_PER_MIN) return { status: 429, json: { error: "Too many AI requests - wait a minute." } };
  h.push(now); hits.set(ip, h);
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return { status: 400, json: { error: "messages are required" } };
  if (JSON.stringify(body).length > MAX_BODY) return { status: 413, json: { error: "Request too large." } };
  if (body.tools && (!Array.isArray(body.tools) || body.tools.length > 20)) return { status: 400, json: { error: "Too many tools." } };
  const model = MODELS[body.tier] || MODELS.default;
  const upstream = env.DST_ANTHROPIC_URL || "https://api.anthropic.com/v1/messages";
  let r;
  try {
    r = await fetchImpl(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: body.messages, ...(body.tools ? { tools: body.tools } : {}) }),
    });
  } catch {
    return { status: 502, json: { error: "The Claude API could not be reached." } };
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const status = r.status === 429 || r.status === 529 ? 429 : r.status === 400 ? 400 : 502;
    return { status, json: { error: j?.error?.message ? `Claude API: ${j.error.message}` : `Claude API error ${r.status}` } };
  }
  return { status: 200, json: { content: j.content, stop_reason: j.stop_reason, model: j.model, usage: j.usage } };
}

/** Configuration status, for start-up logs and deployment checks (never prints the secrets). */
export function configStatus(env = process.env) {
  const key = !!env.ANTHROPIC_API_KEY, code = !!env.DST_ACCESS_CODE && String(env.DST_ACCESS_CODE).length >= 6;
  return { apiKey: key, accessCode: code, aiEnabled: key && code };
}
