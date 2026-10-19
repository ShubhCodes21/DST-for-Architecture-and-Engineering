import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { call, Caps, loadCaps, onEngineEvent, startEngine, storageGet, storageSet } from "./api";
import { initAudit, record } from "./audit";
import { gbp, n1, pct, when } from "./format";
import { Overview } from "./pages/overview";
import { Programme } from "./pages/programme";
import { LongTerm } from "./pages/longterm";
import { Inventory } from "./pages/inventory";
import { Valuation } from "./pages/valuation";
import { Assistant } from "./pages/assistant";
import { Workflow } from "./pages/workflow";
import { Governance } from "./pages/governance";
import { Evaluation } from "./pages/evaluation";
import { StructureDrawer } from "./pages/structure";
import { DataEntry } from "./pages/dataentry";

export interface Me { id: string | null; name: string; canEdit: boolean; isOwner: boolean }
interface Ctx {
  st: any; setSt: (s: any) => void; busy: string | null; caps: Caps; me: Me; engineMode: string;
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>; toast: (m: string) => void;
  go: (tab: string) => void; openStructure: (id: string) => void;
  uncertainty: any; setUncertainty: (u: any) => void; progress: any;
  review: any; setReview: (r: any) => void; refresh: () => Promise<void>;
  audit: (action: string, target: string, detail: string, extra?: any) => Promise<void>;
}
const C = createContext<Ctx>(null as any);
export const useApp = () => useContext(C);

const TABS: { id: string; label: string; group: string; icon: string }[] = [
  { id: "overview", label: "Overview", group: "Decide", icon: "M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z" },
  { id: "programme", label: "5-year programme", group: "Decide", icon: "M4 5h16v15H4zM4 9h16M9 3v4M15 3v4" },
  { id: "longterm", label: "Long-term plan", group: "Decide", icon: "M3 20h18M5 16l4-5 4 3 6-8" },
  { id: "inventory", label: "Inventory & condition", group: "Assets", icon: "M4 6h16M4 12h16M4 18h10" },
  { id: "dataentry", label: "Data entry", group: "Assets", icon: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4" },
  { id: "valuation", label: "Valuation (WGA)", group: "Assets", icon: "M7 20h11M9 20V9a4 4 0 0 1 8 0M6 13h8" },
  { id: "assistant", label: "Ask the data", group: "AI", icon: "M4 5h16v11H9l-5 4z" },
  { id: "workflow", label: "Inspection workflow", group: "AI", icon: "M6 4v16M6 8h8l-2 3h6M6 16h8" },
  { id: "governance", label: "Audit & agent ops", group: "Govern", icon: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" },
  { id: "evaluation", label: "Evaluation & trust", group: "Govern", icon: "M5 12l4 4 10-10" },
];

export function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

export function App() {
  const [st, setSt] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>("Starting the engine");
  const [msg, setMsg] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps>({ sample: null, db: null, user: null, downloads: null, tools: false });
  const [me, setMe] = useState<Me>({ id: null, name: "", canEdit: true, isOwner: false });
  const [tab, setTab] = useState<string>(() => { const h = location.hash.slice(1); return TABS.some((t) => t.id === h) ? h : storageGet("dst.tab") || "overview"; });
  const [drawer, setDrawer] = useState<string | null>(null);
  const [uncertainty, setUncertainty] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);
  const [review, setReview] = useState<any>(null);
  const [engineMode, setEngineMode] = useState("");
  const toastT = useRef<any>(null);
  const toast = useCallback((m: string) => { setMsg(m); clearTimeout(toastT.current); toastT.current = setTimeout(() => setMsg(null), 4200); }, []);
  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    try { return await fn(); } catch (e: any) { toast(String(e?.message ?? e)); return undefined; } finally { setBusy(null); }
  }, [toast]);
  const refresh = useCallback(async () => { setSt(await call("state")); }, []);
  const go = useCallback((t: string) => { setTab(t); storageSet("dst.tab", t); try { history.replaceState(null, "", "#" + t); } catch { /* sandboxed */ } window.scrollTo(0, 0); }, []);
  const audit = useCallback(async (action: string, target: string, detail: string, extra: any = {}) => {
    const s = await call("state");
    await record({ action, target, detail, run_after: s.run?.run_id ?? null, source: "person", ...extra });
  }, []);

  useEffect(() => {
    setEngineMode(startEngine());
    const off = onEngineEvent((ev, data) => { if (ev === "progress") setProgress(data.done >= data.of ? null : data); });
    (async () => {
      try {
        const s = await call("loadSample");
        setSt(s); setBusy("Checking the engine against SAVI v1.10");
        await call("verify");
        setSt(await call("state"));
      } catch (e: any) { toast(String(e?.message ?? e)); }
      finally { setBusy(null); }
    })();
    loadCaps().then(async (c) => {
      setCaps(c);
      let m: Me = { id: null, name: "", canEdit: true, isOwner: false };
      if (c.user) {
        try { const v = await c.user.me(); m = { id: v.id, name: v.name || "", canEdit: !!v.canEdit, isOwner: !!v.isOwner }; } catch { /* anonymous */ }
      }
      setMe(m); initAudit(c, m.id);
    });
    return () => { off(); };
  }, [toast]);

  const ctx: Ctx = { st, setSt, busy, caps, me, engineMode, run, toast, go, openStructure: setDrawer, uncertainty, setUncertainty, progress, review, setReview, refresh, audit };
  const current = TABS.find((t) => t.id === tab)!;
  const groups = [...new Set(TABS.map((t) => t.group))];
  const ver = st?.verification;

  return (
    <C.Provider value={ctx}>
      <div className="app">
        <aside className="side">
          <div className="brand">
            <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 22h28M4 22c0-6.6 5.4-12 12-12s12 5.4 12 12" fill="none" stroke="currentColor" strokeWidth="2.4" /><path d="M9 22v-6M16 22v-9M23 22v-6" stroke="currentColor" strokeWidth="1.6" /></svg>
            <div><b>Structures DST</b><span>SAMPT method · SAVI v1.10 parity</span></div>
          </div>
          <nav className="nav" aria-label="Sections">
            {groups.map((g) => (
              <React.Fragment key={g}>
                <div className="label">{g}</div>
                {TABS.filter((t) => t.group === g).map((t) => (
                  <button key={t.id} aria-current={t.id === tab ? "page" : undefined} onClick={() => go(t.id)}><Icon d={t.icon} />{t.label}</button>
                ))}
              </React.Fragment>
            ))}
          </nav>
          <div className="foot">
            {st?.meta && <span>Rule set {st.meta.ruleset} · prices {st.meta.price_year}</span>}
            {st?.meta && <span>Engine {st.meta.engine_version} · {engineMode === "worker" ? "runs in a background thread" : "runs on the page"}</span>}
            <span>Planning figures are SAVI-compatible estimates, not a works order.</span>
          </div>
        </aside>
        <div className="main">
          <div className="top">
            <div className="ctx">
              <h1>{current.label}</h1>
              <span className="muted">{st?.inventory ? `${st.inventory.organisation || st.inventory.name} · ${st.inventory.structures.toLocaleString()} structure records · ${st.inventory.elements.toLocaleString()} elements` : "Loading inventory"}</span>
            </div>
            <div className="row tight">
              {st?.run && <span className="chip" title={`Input hash ${st.run.input_hash} · ${st.run.label} · ${when(st.run.created)}`}>Run {st.run.run_id}</span>}
              {ver && <button className={`badge ${ver.passed ? "ok" : "bad"}`} style={{ cursor: "pointer" }} onClick={() => go("evaluation")} title="Open the verification report">{ver.passed ? "✓ Matches SAVI v1.10" : "✗ SAVI check failed"}</button>}
              <span className={`badge ${caps.sample ? "ai" : ""}`} title={caps.sample ? "Claude is available for questions and decision notes" : "AI features need the claude.ai viewer; the engine works without them"}>{caps.sample ? "AI ready" : "AI off"}</span>
            </div>
          </div>
          <main className="content">
            {!st ? <div className="empty"><span className="spin" /> {busy}</div> :
              tab === "overview" ? <Overview /> : tab === "programme" ? <Programme /> : tab === "longterm" ? <LongTerm /> :
              tab === "inventory" ? <Inventory /> : tab === "dataentry" ? <DataEntry /> : tab === "valuation" ? <Valuation /> : tab === "assistant" ? <Assistant /> :
              tab === "workflow" ? <Workflow /> : tab === "governance" ? <Governance /> : <Evaluation />}
          </main>
        </div>
      </div>
      {drawer && <StructureDrawer id={drawer} onClose={() => setDrawer(null)} />}
      {(busy && st) || progress ? <div className="busy badge info" role="status"><span className="spin" /> {progress ? `${progress.task === "uncertainty" ? "Monte Carlo run" : progress.task} ${progress.done}/${progress.of}` : busy}</div> : null}
      {msg && <div className="toast" role="status">{msg}</div>}
    </C.Provider>
  );
}

// ------------------------------------------------------------------ shared bits
export function Kpi({ label, value, sub, title }: { label: string; value: React.ReactNode; sub?: React.ReactNode; title?: string }) {
  return <div className="card kpi" title={title}><span className="label">{label}</span><span className="v">{value}</span>{sub && <span className="s">{sub}</span>}</div>;
}

export function Provenance({ extra }: { extra?: string }) {
  const { st } = useApp();
  if (!st?.run) return null;
  return <div className="prov"><span className="chip">Run {st.run.run_id}</span><span>{st.meta.ruleset} · {st.meta.price_year} prices</span><span>· {st.run.label}</span>{extra && <span>· {extra}</span>}</div>;
}

export function Delta({ before, after, fmt, goodUp = true }: { before: number; after: number; fmt: (v: number) => string; goodUp?: boolean }) {
  const d = after - before;
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return <span className="delta muted">no change</span>;
  const good = goodUp ? d > 0 : d < 0;
  return <span className={`delta ${good ? "up" : "down"}`}>{d > 0 ? "▲ +" : "▼ −"}{fmt(Math.abs(d))}</span>;
}

export function Cond({ code, ecs }: { code?: string; ecs?: number }) {
  const e = ecs ?? 0;
  const col = e <= 0 ? "var(--muted)" : e < 2 ? "var(--c-vg)" : e < 3 ? "var(--c-g)" : e < 4 ? "var(--c-f)" : e < 5 ? "var(--c-p)" : "var(--c-vp)";
  return <span className="condpill"><i style={{ background: col }} /><span className="mono">{code ?? e.toFixed(1)}</span></span>;
}

export function Sci({ v }: { v: number }) {
  const col = v >= 90 ? "var(--c-vg)" : v >= 80 ? "var(--c-g)" : v >= 65 ? "var(--c-f)" : v >= 40 ? "var(--c-p)" : "var(--c-vp)";
  return <span className="condpill num"><i style={{ background: col }} />{n1(v)}</span>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: any[]): [T | null, boolean, () => void] {
  const [v, setV] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [k, setK] = useState(0);
  useEffect(() => { let live = true; setLoading(true); fn().then((r) => { if (live) setV(r); }).catch(() => {}).finally(() => live && setLoading(false)); return () => { live = false; }; }, [...deps, k]);
  return [v, loading, () => setK((x) => x + 1)];
}

export { gbp, pct };
