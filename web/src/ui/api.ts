// Page <-> engine (Web Worker) RPC, plus the claude.ai runtime capabilities (all optional).
declare global { interface Window { claude?: any; __engineShim?: any } }

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; method: string; t: number };
const pending = new Map<number, Pending>();
const listeners = new Set<(event: string, data: any) => void>();
let seq = 0;
let port: { postMessage: (m: any) => void } | null = null;
export const engineCalls: { method: string; ms: number; ok: boolean; at: number }[] = [];

function onMessage(m: any) {
  if (m?.event) { listeners.forEach((l) => l(m.event, m.data)); return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  engineCalls.push({ method: p.method, ms: m.ms ?? performance.now() - p.t, ok: m.ok, at: Date.now() });
  if (engineCalls.length > 500) engineCalls.shift();
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
}

export function startEngine(): "worker" | "inline" {
  const el = document.getElementById("engine-src");
  const src = el?.textContent ?? "";
  try {
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);
    w.onmessage = (e) => onMessage(e.data);
    w.onerror = (e) => console.error("engine worker error", e);
    port = w;
    return "worker";
  } catch {
    // Fallback: run the engine on the page itself (slower UI during runs, same numbers).
    const shim: any = { postMessage: (m: any) => setTimeout(() => onMessage(m), 0), onmessage: null };
    window.__engineShim = shim;
    const s = document.createElement("script");
    s.textContent = src;
    document.body.appendChild(s);
    port = { postMessage: (m: any) => setTimeout(() => shim.onmessage?.({ data: m }), 0) };
    return "inline";
  }
}

export function call<T = any>(method: string, ...args: any[]): Promise<T> {
  if (!port) throw new Error("Engine not started");
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject, method, t: performance.now() });
    const transfer = args.filter((a) => a instanceof ArrayBuffer);
    (port as any).postMessage({ id, method, args }, transfer.length ? transfer : undefined);
  });
}

export function onEngineEvent(fn: (event: string, data: any) => void) { listeners.add(fn); return () => listeners.delete(fn); }

// ------------------------------------------------------------------ capabilities
export interface Caps { sample: any | null; db: any | null; user: any | null; downloads: any | null; tools: boolean }
export async function loadCaps(): Promise<Caps> {
  const c = window.claude;
  if (!c?.use) return { sample: null, db: null, user: null, downloads: null, tools: false };
  const [sample, db, user, downloads] = await Promise.all(["sample", "db", "user", "downloads"].map((n) => c.use(n).catch(() => null)));
  let tools = false;
  if (sample) { try { tools = !!(await sample.limits())?.tools; } catch { tools = false; } }
  return { sample, db, user, downloads, tools };
}

export async function saveFile(caps: Caps, filename: string, data: string): Promise<string> {
  if (!caps.downloads) {
    // Hosted outside claude.ai: an ordinary browser download.
    try {
      const url = URL.createObjectURL(new Blob([data], { type: filename.endsWith(".csv") ? "text/csv" : "text/plain" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return "";
    } catch { return "Downloads are not available in this view."; }
  }
  try { await caps.downloads.save({ filename, data }); return ""; }
  catch (e: any) { return e?.code === "declined" ? "" : `Could not save the file (${e?.code ?? "error"}).`; }
}

export function storageGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
export function storageSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* per-viewer convenience only */ } }
