// Plain Node server for any host (Render, Railway, Azure App Service, a VM, Docker):
// serves public/ and POST /api/claude.   Run: ANTHROPIC_API_KEY=... node server.mjs   (PORT defaults to 8080)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handleClaude, configStatus } from "./lib/claude-proxy.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const SECURITY = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "SAMEORIGIN" };

createServer(async (req, res) => {
  try {
    if (req.url === "/api/claude") {
      if (req.method !== "POST") { res.writeHead(405, SECURITY).end(); return; }
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > 1_000_000) { res.writeHead(413, SECURITY).end(); return; } }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      const { status, json } = await handleClaude(body, req.headers, ip);
      res.writeHead(status, { ...SECURITY, "content-type": "application/json" }).end(JSON.stringify(json));
      return;
    }
    if (req.url === "/healthz") { res.writeHead(200, SECURITY).end("ok"); return; }
    const path = normalize(decodeURIComponent((req.url || "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const file = join(ROOT, path === "/" ? "index.html" : path);
    if (!file.startsWith(ROOT)) { res.writeHead(403, SECURITY).end(); return; }
    const data = await readFile(file).catch(() => null);
    if (!data) { res.writeHead(404, SECURITY).end("Not found"); return; }
    res.writeHead(200, { ...SECURITY, "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(500, SECURITY).end();
  }
}).listen(Number(process.env.PORT || 8080), () => {
  const c = configStatus();
  console.log(`Structures DST on http://localhost:${process.env.PORT || 8080}`);
  console.log(`AI: ${c.aiEnabled ? "enabled (access code required)" : `OFF - ${!c.apiKey ? "ANTHROPIC_API_KEY missing" : "DST_ACCESS_CODE missing or shorter than 6 characters"}`}`);
});
