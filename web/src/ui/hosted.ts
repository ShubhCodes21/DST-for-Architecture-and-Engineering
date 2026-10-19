// Hosted mode: when the page runs outside claude.ai there is no `window.claude` runtime.
// If the page declares an AI endpoint (<meta name="dst-ai-endpoint" content="/api/claude">), this installs a
// small runtime with the same `use("sample")` contract the page already relies on, backed by the server
// function in deploy/api/claude.js (which holds the Anthropic API key). Tools still run here in the browser,
// so every figure still comes from the engine and the grounding check is unchanged.
declare global { interface Window { claude?: any; __dstHosted?: boolean } }

const ACCESS_KEY = "dst.accessCode";
export const getAccessCode = () => { try { return localStorage.getItem(ACCESS_KEY) ?? ""; } catch { return ""; } };
export const setAccessCode = (c: string) => { try { localStorage.setItem(ACCESS_KEY, c); } catch { /* per-viewer convenience */ } };

const err = (code: string, message: string, text?: string) => ({ code, message, text });

function toMessages(input: any): any[] {
  const turns = typeof input === "string" ? [{ role: "user", content: input }] : input;
  const out: any[] = [];
  for (const t of turns) {
    if (out.length && out[out.length - 1].role === t.role) out[out.length - 1].content += "\n\n" + t.content;
    else out.push({ role: t.role, content: t.content });
  }
  return out;
}

async function post(endpoint: string, body: any, signal?: AbortSignal) {
  let r: Response;
  try {
    r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-dst-access": getAccessCode() }, body: JSON.stringify(body), signal });
  } catch (e: any) {
    if (e?.name === "AbortError") throw err("cancelled", "Stopped");
    throw err("upstream_error", "The AI service could not be reached.");
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw err("not_granted", j?.error ?? "An access code is needed for the AI features.");
  if (r.status === 503) throw err("sampling_disabled", j?.error ?? "AI is switched off on this server.");
  if (r.status === 429) throw err("rate_limited", j?.error ?? "Too many requests.");
  if (!r.ok) throw err("upstream_error", j?.error ?? `AI service error ${r.status}`);
  return j;
}

export function installHostedRuntime() {
  if (window.claude) return false;                       // inside claude.ai: the real runtime is used
  const endpoint = document.querySelector('meta[name="dst-ai-endpoint"]')?.getAttribute("content");
  window.__dstHosted = true;
  const sample: any = async (input: any, opts: any = {}) => {
    if (!endpoint) throw err("sampling_disabled", "AI is not configured for this deployment.");
    const messages = toMessages(input);
    const tools = (opts.tools ?? []).map((t: any) => ({ name: t.name, description: t.description, input_schema: t.inputSchema ?? { type: "object", properties: {} } }));
    const byName = new Map((opts.tools ?? []).map((t: any) => [t.name, t]));
    let text = "";
    for (let round = 0; round < 8; round++) {
      if (opts.signal?.aborted) throw err("cancelled", "Stopped", text);
      const res = await post(endpoint, { tier: opts.modelTier ?? "default", messages, tools: tools.length ? tools : undefined, json: !!opts.__json }, opts.signal)
        .catch((e) => { throw { ...e, text: text || undefined }; });
      const blocks: any[] = res.content ?? [];
      const said = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (said.trim()) { text = text ? `${text}\n\n${said}` : said; opts.onText?.({ text, delta: said }); }
      const uses = blocks.filter((b) => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !uses.length) {
        if (!text.trim()) throw err("empty_completion", "No answer was produced.");
        return { text, truncated: res.stop_reason === "max_tokens" };
      }
      messages.push({ role: "assistant", content: blocks });
      const results = await Promise.all(uses.map(async (u) => {
        const tool: any = byName.get(u.name);
        try {
          if (!tool) throw new Error(`Unknown tool ${u.name}`);
          const out = await tool.execute(u.input ?? {}, { signal: opts.signal ?? new AbortController().signal });
          return { type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out) };
        } catch (e: any) {
          return { type: "tool_result", tool_use_id: u.id, content: `Error: ${e?.message ?? e}`, is_error: true };
        }
      }));
      messages.push({ role: "user", content: results });
    }
    return { text: text || "(stopped after the maximum number of tool rounds)", truncated: true };
  };
  sample.json = async (input: any, opts: any = {}) => {
    const add = "\n\nReply with only the JSON value, no other text.";
    const inp = typeof input === "string" ? input + add : [...input.slice(0, -1), { ...input[input.length - 1], content: input[input.length - 1].content + add }];
    const { text } = await sample(inp, { ...opts, __json: true });
    const tries = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], text.slice(Math.min(...["{", "["].map((c) => (text.indexOf(c) < 0 ? Infinity : text.indexOf(c)))), Math.max(text.lastIndexOf("}"), text.lastIndexOf("]")) + 1)];
    for (const t of tries) { if (!t) continue; try { return JSON.parse(t); } catch { /* next */ } }
    throw err("invalid_json", "The answer was not valid JSON.", text);
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 20 } });
  window.claude = { use: async (name: string) => (name === "sample" && endpoint ? sample : null) };
  return true;
}
