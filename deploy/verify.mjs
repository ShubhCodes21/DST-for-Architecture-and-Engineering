// Post-deployment check (no secrets needed):  node verify.mjs https://your-site.example
// Confirms the page is served and that the AI endpoint is protected by the access code.
const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base) { console.error("usage: node verify.mjs <site url>"); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`); };
const page = await fetch(base + "/").catch(() => null);
const html = page ? await page.text() : "";
check("page is served", !!page && page.ok && html.includes("Structures DST"), page ? `HTTP ${page.status}, ${(html.length / 1e6).toFixed(1)} MB` : "no response");
check("page declares the AI endpoint", html.includes('name="dst-ai-endpoint"'));
check("page does not contain an API key", !/sk-ant-[A-Za-z0-9_-]{10,}/.test(html));
const ask = (code) => fetch(base + "/api/claude", { method: "POST", headers: { "content-type": "application/json", ...(code ? { "x-dst-access": code } : {}) }, body: JSON.stringify({ tier: "quick", messages: [{ role: "user", content: "ping" }] }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })).catch(() => ({ status: 0, body: {} }));
const none = await ask(""), wrong = await ask("definitely-wrong-code");
check("AI endpoint is configured (API key + access code set)", none.status !== 503, none.status === 503 ? none.body.error : `HTTP ${none.status}`);
check("AI refused without an access code", none.status === 401);
check("AI refused with a wrong access code", wrong.status === 401);
if (process.argv[3]) {
  const right = await ask(process.argv[3]);
  check("AI answers with the right access code", right.status === 200, `HTTP ${right.status}${right.body.error ? " " + right.body.error : ""}`);
}
console.log(results.every(Boolean) ? "\nAll checks passed." : "\nSome checks failed.");
process.exit(results.every(Boolean) ? 0 : 1);
