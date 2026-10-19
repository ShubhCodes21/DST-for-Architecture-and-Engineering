// Control layer record: every decision, inspection approval, settings change and evaluation run.
// Kept in the artifact's shared database when available (so a reviewer sees it), else for this session only.
import type { Caps } from "./api";

export interface AuditEntry {
  id?: string; at: string; actor: string | null; action: string; target: string; detail: string;
  run_before?: string | null; run_after?: string | null; source: "person" | "assistant-prepared" | "system";
}

let mem: AuditEntry[] = [];
const subs = new Set<(rows: AuditEntry[], mode: "shared" | "session") => void>();
let mode: "shared" | "session" = "session";
let caps: Caps | null = null;
let me: string | null = null;
let unsub: (() => void) | null = null;

export function initAudit(c: Caps, myId: string | null) {
  caps = c; me = myId;
  if (!c.db || unsub) return;
  try {
    unsub = c.db.collection("audit").orderBy("at", "desc").limit(300).onSnapshot((snap: any) => {
      mode = "shared";
      const shared = snap.docs.map((d: any) => ({ id: d.id, ...(d.data() as any) }));
      const local = mem.filter((m) => !m.id);
      emit([...local, ...shared].sort((a, b) => (a.at < b.at ? 1 : -1)));
    }, () => { mode = "session"; emit(mem); });
  } catch { mode = "session"; }
}

let last: AuditEntry[] = [];
function emit(rows: AuditEntry[]) { last = rows; subs.forEach((f) => f(rows, mode)); }
export function onAudit(f: (rows: AuditEntry[], m: "shared" | "session") => void) { subs.add(f); f(last.length ? last : mem, mode); return () => subs.delete(f); }

export async function record(e: Omit<AuditEntry, "at" | "actor"> & { at?: string }) {
  const entry: AuditEntry = { at: e.at ?? new Date().toISOString(), actor: me, ...e } as AuditEntry;
  if (caps?.db) {
    try { await caps.db.collection("audit").add(entry as any); return "shared"; }
    catch { /* viewers without write access, or offline: keep it for this session */ }
  }
  mem = [entry, ...mem];
  emit([entry, ...last.filter((x) => x !== entry)]);
  return "session";
}

export async function saveEvalRun(summary: any, results: any[]) {
  if (!caps?.db) return false;
  try {
    await caps.db.collection("evals").add({ at: new Date().toISOString(), actor: me, summary, results: results.map((r) => ({ id: r.id, category: r.category, passed: r.passed, accurate: r.accurate, toolsOk: r.toolsOk, hallucinated: r.hallucinated, ms: Math.round(r.ms), error: r.error ?? null, untraced: r.grounding?.untraced ?? null, figures: r.grounding?.checked ?? null, answer: String(r.answer ?? "").slice(0, 1200) })) });
    return true;
  } catch { return false; }
}
