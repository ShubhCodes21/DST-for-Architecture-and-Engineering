import React, { useEffect, useState } from "react";
import { useApp } from "../app";
import { engineCalls, saveFile } from "../api";
import { getTraces, onTraces, Trace } from "../ai";
import { AuditEntry, onAudit } from "../audit";
import { gbp, n0, n1, when, toCsv } from "../format";

function useAudit() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [mode, setMode] = useState<"shared" | "session">("session");
  useEffect(() => onAudit((r, m) => { setRows(r); setMode(m); }) as any, []);
  return { rows, mode };
}

function useNames(ids: (string | null)[]) {
  const { caps, me } = useApp();
  const [names, setNames] = useState<Record<string, string>>({});
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");
  useEffect(() => {
    if (!caps.user || !key) return;
    caps.user.profiles(key.split(",")).then((p: any) => setNames(Object.fromEntries(Object.entries(p).map(([k, v]: any) => [k, v.name || ""])))).catch(() => {});
  }, [key, caps.user]);
  return (id: string | null) => (!id ? "Anonymous viewer" : id === me.id ? "You" : names[id] || "A colleague");
}

function AuditLog() {
  const { caps, toast } = useApp();
  const { rows, mode } = useAudit();
  const who = useNames(rows.map((r) => r.actor));
  return (
    <div className="card">
      <header><h2>Audit log</h2>
        <div className="row tight">
          <span className={`badge ${mode === "shared" ? "ok" : "warn"}`} title={mode === "shared" ? "Stored with the artifact; everyone with access sees the same log" : "Kept in this browser session only (no shared store, or no write access)"}>{mode === "shared" ? "Shared, persistent" : "This session only"}</span>
          <button className="btn sm" disabled={!rows.length} onClick={async () => { const e = await saveFile(caps, "audit-log.csv", toCsv(rows.map((r) => ({ ...r, actor: who(r.actor) })))); if (e) toast(e); }}>Export CSV</button>
        </div>
      </header>
      <div className="tablewrap tall">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th className="wrap">Detail</th><th>Runs</th><th>Origin</th></tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={r.id ?? i}><td>{when(r.at)}</td><td>{who(r.actor)}</td><td><b>{r.action}</b></td><td className="mono">{r.target}</td><td className="wrap small">{r.detail}</td><td className="mono tiny">{r.run_before && r.run_before !== r.run_after ? `${r.run_before} → ` : ""}{r.run_after ?? ""}</td><td>{r.source === "assistant-prepared" ? <span className="badge ai">AI-prepared</span> : <span className="badge">{r.source}</span>}</td></tr>)}
            {!rows.length && <tr><td colSpan={7} className="empty">No decisions yet. Approvals, deferrals, rejections, inspection decisions, setting changes and evaluation runs appear here.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Traces() {
  const [, setK] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => onTraces(() => setK((k) => k + 1)) as any, []);
  const T = getTraces();
  const done = T.filter((t) => t.status !== "running");
  const ok = done.filter((t) => t.status === "ok");
  const lat = ok.map((t) => t.ms).sort((a, b) => a - b);
  const p = (q: number) => (lat.length ? lat[Math.floor(q * (lat.length - 1))] : 0);
  const toolN = T.reduce((a, t) => a + t.tools.length, 0), toolErr = T.reduce((a, t) => a + t.tools.filter((x) => !x.ok).length, 0);
  const figs = ok.reduce((a, t) => a + (t.grounding?.checked ?? 0), 0), untr = ok.reduce((a, t) => a + (t.grounding?.untraced ?? 0), 0);
  return (
    <div className="stack">
      <div className="grid g4">
        <div className="card flat kpi"><span className="label">AI calls</span><span className="v">{n0(T.length)}</span><span className="s">{n0(ok.length)} ok · {n0(done.length - ok.length)} failed or stopped</span></div>
        <div className="card flat kpi"><span className="label">Latency p50 / p95</span><span className="v">{(p(0.5) / 1000).toFixed(1)}s</span><span className="s">p95 {(p(0.95) / 1000).toFixed(1)} s</span></div>
        <div className="card flat kpi"><span className="label">Tool calls</span><span className="v">{n0(toolN)}</span><span className="s">{n0(toolErr)} raised an error</span></div>
        <div className="card flat kpi"><span className="label">Figures traced</span><span className="v">{figs ? `${(((figs - untr) / figs) * 100).toFixed(0)}%` : "–"}</span><span className="s">{n0(untr)} untraced of {n0(figs)}</span></div>
      </div>
      <div className="card">
        <header><h2>Traces</h2><span className="muted small">This session · newest first</span></header>
        <div className="tablewrap tall">
          <table>
            <thead><tr><th>Id</th><th>Kind</th><th className="wrap">Question</th><th>Status</th><th className="r">Time</th><th>Tools</th><th>Grounding</th><th>Run</th></tr></thead>
            <tbody>
              {T.map((t: Trace) => (
                <React.Fragment key={t.id}>
                  <tr className="click" onClick={() => setOpen(open === t.id ? null : t.id)}>
                    <td className="mono">{t.id}</td><td><span className="badge">{t.kind}</span></td><td className="wrap small">{t.question}</td>
                    <td><span className={`badge ${t.status === "ok" ? "ok" : t.status === "running" ? "info" : t.status === "cancelled" ? "" : "bad"}`}>{t.status}{t.error ? ` · ${t.error}` : ""}</span></td>
                    <td className="r">{t.ms ? `${(t.ms / 1000).toFixed(1)} s` : ""}</td><td className="small">{t.tools.map((x) => x.name).join(", ")}</td>
                    <td>{t.grounding ? <span className={`badge ${t.grounding.untraced ? "bad" : "ok"}`}>{t.grounding.traced + t.grounding.derived}/{t.grounding.checked}</span> : ""}</td><td className="mono tiny">{t.run_id ?? ""}</td>
                  </tr>
                  {open === t.id && <tr><td colSpan={8}>
                    <div className="stack small">
                      {t.tools.map((x, i) => <div key={i}><b className="mono">{x.name}</b> · {Math.round(x.ms)} ms · {n0(x.bytes)} bytes {x.ok ? "" : <span className="badge bad">{x.error}</span>}<pre className="json">{JSON.stringify(x.args, null, 1)}</pre></div>)}
                      {t.answer && <div><span className="label">Answer</span><p style={{ whiteSpace: "pre-wrap" }}>{t.answer}</p></div>}
                      {t.grounding && t.grounding.untraced > 0 && <div className="note bad">Untraced: {t.grounding.figures.filter((f) => f.status === "untraced").map((f) => f.text).join(", ")}</div>}
                    </div>
                  </td></tr>}
                </React.Fragment>
              ))}
              {!T.length && <tr><td colSpan={8} className="empty">No AI calls yet in this session.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Runs() {
  const { st } = useApp();
  const calls = engineCalls.slice(-200);
  const by: Record<string, number[]> = {};
  calls.forEach((c) => (by[c.method] ??= []).push(c.ms));
  return (
    <div className="grid g-main">
      <div className="card">
        <header><h2>Run registry</h2><span className="muted small">Every committed run; same inputs give the same input hash</span></header>
        <div className="tablewrap tall">
          <table><thead><tr><th>Run</th><th>When</th><th className="wrap">What changed</th><th className="r">5-yr spend</th><th className="r">Workbank end</th><th className="r">SSCIav end</th><th className="r">Time</th><th>Input hash</th></tr></thead>
            <tbody>{[...(st.runs ?? [])].reverse().map((r: any) => <tr key={r.run_id} className={r.run_id === st.run?.run_id ? "sel" : ""}><td className="mono">{r.run_id}</td><td>{when(r.created)}</td><td className="wrap small">{r.label}</td><td className="r">{gbp(r.five_year.expenditure)}</td><td className="r">{gbp(r.totals.workbank_end)}</td><td className="r">{n1(r.totals.ssci_av_end)}</td><td className="r">{(r.duration_ms / 1000).toFixed(1)} s</td><td className="mono tiny">{r.input_hash}</td></tr>)}</tbody></table>
        </div>
      </div>
      <div className="card">
        <header><h2>Engine calls</h2><span className="muted small">Latency in this browser</span></header>
        <div className="tablewrap"><table><thead><tr><th>Method</th><th className="r">Calls</th><th className="r">Median</th><th className="r">Max</th></tr></thead>
          <tbody>{Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([m, v]) => { const s = [...v].sort((a, b) => a - b); return <tr key={m}><td className="mono">{m}</td><td className="r">{v.length}</td><td className="r">{Math.round(s[Math.floor(s.length / 2)])} ms</td><td className="r">{Math.round(s[s.length - 1])} ms</td></tr>; })}</tbody></table></div>
      </div>
    </div>
  );
}

export function Governance() {
  const [t, setT] = useState("audit");
  return (
    <div className="stack lg">
      <div className="tabs" role="tablist">
        {[["audit", "Audit log"], ["traces", "Agent traces"], ["runs", "Runs & engine"]].map(([k, l]) => <button key={k} role="tab" aria-selected={t === k} onClick={() => setT(k)}>{l}</button>)}
      </div>
      {t === "audit" ? <AuditLog /> : t === "traces" ? <Traces /> : <Runs />}
    </div>
  );
}
