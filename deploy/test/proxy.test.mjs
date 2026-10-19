import { test } from "node:test";
import assert from "node:assert/strict";
import { handleClaude } from "../lib/claude-proxy.js";

const okFetch = (capture) => async (url, init) => { capture.url = url; capture.init = init; return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", model: "m", usage: {} }) }; };
const body = { tier: "quick", messages: [{ role: "user", content: "hello" }] };

test("missing key -> 503, never calls upstream", async () => {
  const r = await handleClaude(body, {}, "1", {}, () => { throw new Error("called"); });
  assert.equal(r.status, 503);
});
test("fails closed: key without an access code never reaches Claude", async () => {
  const r = await handleClaude(body, { "x-dst-access": "" }, "9", { ANTHROPIC_API_KEY: "k" }, () => { throw new Error("called"); });
  assert.equal(r.status, 503); assert.match(r.json.error, /access code/);
  const short = await handleClaude(body, { "x-dst-access": "abc" }, "9", { ANTHROPIC_API_KEY: "k", DST_ACCESS_CODE: "abc" }, () => { throw new Error("called"); });
  assert.equal(short.status, 503);
});
test("access code enforced", async () => {
  const env = { ANTHROPIC_API_KEY: "k", DST_ACCESS_CODE: "s3cret" };
  assert.equal((await handleClaude(body, {}, "2", env, okFetch({}))).status, 401);
  assert.equal((await handleClaude(body, { "x-dst-access": "wrong!" }, "2", env, okFetch({}))).status, 401);
  assert.equal((await handleClaude(body, { "x-dst-access": "s3cret" }, "2", env, okFetch({}))).status, 200);
});
test("forwards with key header, model by tier, capped tokens; key never returned", async () => {
  const cap = {};
  const r = await handleClaude({ ...body, tools: [{ name: "t", description: "d", input_schema: { type: "object" } }] }, { "x-dst-access": "code-123" }, "3", { ANTHROPIC_API_KEY: "sk-test", DST_ACCESS_CODE: "code-123" }, okFetch(cap));
  assert.equal(r.status, 200);
  assert.equal(cap.init.headers["x-api-key"], "sk-test");
  assert.equal(cap.init.headers["anthropic-version"], "2023-06-01");
  const sent = JSON.parse(cap.init.body);
  assert.equal(sent.model, "claude-haiku-5-5"); assert.equal(sent.max_tokens, 4096); assert.equal(sent.tools.length, 1);
  assert.ok(!JSON.stringify(r.json).includes("sk-test"));
});
test("validation and rate limiting", async () => {
  const env = { ANTHROPIC_API_KEY: "k", DST_ACCESS_CODE: "code-123" }, h = { "x-dst-access": "code-123" };
  assert.equal((await handleClaude({}, h, "4", env, okFetch({}))).status, 400);
  assert.equal((await handleClaude({ messages: [{ role: "user", content: "x".repeat(500000) }] }, h, "4", env, okFetch({}))).status, 413);
  let last;
  for (let i = 0; i < 31; i++) last = await handleClaude(body, h, "5", env, okFetch({}));
  assert.equal(last.status, 429);
});
test("upstream errors are mapped, not leaked raw", async () => {
  const bad = async () => ({ ok: false, status: 529, json: async () => ({ error: { message: "Overloaded" } }) });
  const r = await handleClaude(body, { "x-dst-access": "code-123" }, "6", { ANTHROPIC_API_KEY: "k", DST_ACCESS_CODE: "code-123" }, bad);
  assert.equal(r.status, 429); assert.match(r.json.error, /Overloaded/);
});

import { configStatus } from "../lib/claude-proxy.js";
test("config status never exposes secrets", () => {
  const c = configStatus({ ANTHROPIC_API_KEY: "sk-secret", DST_ACCESS_CODE: "code-123" });
  assert.deepEqual(c, { apiKey: true, accessCode: true, aiEnabled: true });
  assert.equal(configStatus({ ANTHROPIC_API_KEY: "sk-secret" }).aiEnabled, false);
});
