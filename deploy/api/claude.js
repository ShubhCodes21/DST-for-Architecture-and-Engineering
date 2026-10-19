// Vercel serverless function: POST /api/claude
import { handleClaude } from "../lib/claude-proxy.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  const { status, json } = await handleClaude(req.body, req.headers, ip);
  res.status(status).json(json);
}
