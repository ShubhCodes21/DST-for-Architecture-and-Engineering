import React, { useEffect, useRef, useState } from "react";
import { useApp } from "../app";
import { call } from "../api";
import { buildEvalCases, EvalCase, EvalResult, getTraces, runEvalCase, summariseEval, Tier } from "../ai";
import { record, saveEvalRun } from "../audit";
import { gbpFull, n0, pct, when } from "../format";

declare const __QA__: any;
const QA = typeof __QA__ !== "undefined" ? __QA__ : null;

const TARGETS = { accuracy: 0.9, tool_correctness: 0.9, grounding: 0.95, hallucination_rate: 0.05, task_completion: 0.8, latency_p95_ms: 60000 };
const QUICK = ["A01", "A05", "A07", "E01", "H01", "H05", "T02", "T04"];

function Verification() {
  const { st, run, setSt } = useApp();
  const v = st.verification;
  return (
    <div className="stack lg">
      <div className="card">
        <header><h2>Engine vs SAVI v1.10, re-checked in this browser</h2>
          <div className="row tight">{v && <span className={`badge ${v.passed ? "ok" : "bad"}`}>{v.passed ? "All checks pass" : "Mismatch found"}</span>}
            <button className="btn sm" onClick={async () => { const r = await run("Re-running the SAVI check", () => call("verify")); if (r) setSt(await call("state")); }}>Run again</button></div></header>
        {v ? (
          <div className="stack">
            <p className="small">The bundled reference inventory ({v.reference}) is valued and planned from scratch with default settings, then compared with the figures SAVI itself produced. <b>{n0(v.lamp_cells - v.lamp_mismatches)} of {n0(v.lamp_cells)}</b> LAMP Results cells (58 columns × every year) agree to 1 part in 10⁹. Took {(v.ms / 1000).toFixed(1)} s at {when(v.at)}.</p>
            <div className="tablewrap"><table><thead><tr><th>Check</th><th className="r">This engine</th><th className="r">SAVI v1.10</th><th>Result</th></tr></thead>
              <tbody>{v.checks.map((c: any) => <tr key={c.name}><td>{c.name}</td><td className="r">{c.name.startsWith("SSCI") ? c.ours.toFixed(6) : gbpFull(c.ours)}</td><td className="r">{c.name.startsWith("SSCI") ? c.savi.toFixed(6) : gbpFull(c.savi)}</td><td><span className={`badge ${c.match ? "ok" : "bad"}`}>{c.match ? "match" : "differs"}</span></td></tr>)}</tbody></table></div>
            <p className="tiny muted">This check uses the reference data whatever inventory is loaded, so it proves the engine, not your data. Your data is checked by the validation rules on the Inventory page.</p>
          </div>
        ) : <div className="empty"><span className="spin" /> Running…</div>}
      </div>
      <div className="card">
        <header><h2>QA framework results at build time</h2><span className="muted small">pytest · pandera · node tests · playwright</span></header>
        {QA ? (
          <div className="tablewrap"><table><thead><tr><th>Stage</th><th>Suite</th><th className="r">Tests</th><th className="r">Passed</th><th className="wrap">What it covers</th></tr></thead>
            <tbody>{QA.suites.map((s: any) => <tr key={s.name}><td>{s.family}</td><td className="mono">{s.name}</td><td className="r">{n0(s.tests)}</td><td className="r"><span className={`badge ${s.passed === s.tests ? "ok" : "bad"}`}>{n0(s.passed)}</span></td><td className="wrap small">{s.covers}</td></tr>)}</tbody></table></div>
        ) : <p className="small muted">Not available in this build.</p>}
        {QA && <p className="tiny muted" style={{ marginTop: 6 }}>Built {when(QA.built)} · Python engine coverage {QA.coverage ?? "–"}</p>}
      </div>
    </div>
  );
}

function AiEval() {
  const { caps, st, toast } = useApp();
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [results, setResults] = useState<EvalResult[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [tier, setTier] = useState<Tier>("default");
  const [history, setHistory] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null), stop = useRef(false);
  useEffect(() => { buildEvalCases().then(setCases); }, [st.run?.run_id]);
  useEffect(() => {
    if (!caps.db) return;
    try { return caps.db.collection("evals").orderBy("at", "desc").limit(10).onSnapshot((s: any) => setHistory(s.docs.map((d: any) => ({ id: d.id, ...d.data() }))), () => {}); } catch { return; }
  }, [caps.db]);
  const go = async (which: "quick" | "full") => {
    if (!caps.sample) return;
    const set = which === "quick" ? cases.filter((c) => QUICK.includes(c.id)) : cases;
    stop.current = false; setResults([]);
    const out: EvalResult[] = [];
    for (const c of set) {
      if (stop.current) break;
      setRunning(c.id);
      ctl.current = new AbortController();
      const r = await runEvalCase(caps.sample, c, tier, ctl.current.signal, caps.tools);
      if (r.error === "not_granted" || r.error === "rate_limited") { toast(r.error === "not_granted" ? "Claude was not allowed for this page." : "Rate limited - stopping the run."); out.push(r); setResults([...out]); break; }
      out.push(r); setResults([...out]);
    }
    setRunning(null);
    if (out.length) {
      const s = summariseEval(out);
      const saved = await saveEvalRun({ ...s, tier, run_id: st.run.run_id, set: which }, out);
      await record({ action: "AI evaluation run", target: `${out.length} cases (${which}, ${tier})`, detail: `passed ${s.passed}/${s.cases} · accuracy ${pct(s.accuracy, 0)} · grounding ${pct(s.grounding, 0)} · hallucination ${pct(s.hallucination_rate, 0)}${saved ? "" : " · results kept in this session"}`, run_before: st.run.run_id, run_after: st.run.run_id, source: "system" });
    }
  };
  const s = results.length ? summariseEval(results) : null;
  const metric = (label: string, v: number, target: number, lowerBetter = false, fmt = (x: number) => pct(x, 0)) => {
    const ok = lowerBetter ? v <= target : v >= target;
    return <div className="card flat kpi" key={label}><span className="label">{label}</span><span className="v" style={{ color: ok ? "var(--ok)" : "var(--bad)" }}>{fmt(v)}</span><span className="s">target {lowerBetter ? "≤" : "≥"} {fmt(target)}</span></div>;
  };
  return (
    <div className="stack lg">
      <div className="card">
        <header><h2>AI evaluation set</h2><span className="muted small">{cases.length} cases · expected answers computed live from run {st.run?.run_id}</span></header>
        <p className="small" style={{ marginBottom: 10 }}>Each case sends one question through the same assistant path as "Ask the data", then grades the answer: <b>accuracy</b> (the expected figure or id is present), <b>tool correctness</b> (the right engine tool was used), <b>grounding</b> (every figure traced to a tool result), <b>hallucination</b> (any untraced figure, or a trap question answered instead of declined), <b>task completion</b> and <b>latency</b>.</p>
        {caps.sample ? (
          <div className="row tight">
            <button className="btn primary" disabled={!!running || !cases.length} onClick={() => go("quick")}>Run quick set (8)</button>
            <button className="btn" disabled={!!running || !cases.length} onClick={() => go("full")}>Run full set ({cases.length})</button>
            {running && <button className="btn" onClick={() => { stop.current = true; ctl.current?.abort(); }}>Stop</button>}
            <label className="small muted">Model <select value={tier} onChange={(e) => setTier(e.target.value as Tier)} disabled={!!running}><option value="quick">Fast</option><option value="default">Balanced</option><option value="complex">Most capable</option></select></label>
            {running && <span className="small"><span className="spin" /> Case {running} ({results.length + 1})…</span>}
            <span className="tiny muted">Uses your Claude usage; the full set takes roughly 10–30 minutes on Balanced.</span>
          </div>
        ) : <div className="note warn small">Running the evaluation needs Claude, which is not available in this view. The cases and grading rules are listed below.</div>}
      </div>
      {s && (
        <div className="grid g3">
          {metric("Accuracy", s.accuracy, TARGETS.accuracy)}
          {metric("Grounding", s.grounding, TARGETS.grounding)}
          {metric("Hallucination rate", s.hallucination_rate, TARGETS.hallucination_rate, true)}
          {metric("Tool correctness", s.tool_correctness, TARGETS.tool_correctness)}
          {metric("Task completion", s.task_completion, TARGETS.task_completion)}
          {metric("Latency p95", s.latency_p95_ms, TARGETS.latency_p95_ms, true, (x) => `${(x / 1000).toFixed(0)} s`)}
        </div>
      )}
      <div className="card">
        <header><h2>Cases</h2>{s && <span className="badge">{s.passed}/{s.cases} passed</span>}</header>
        <div className="tablewrap tall">
          <table><thead><tr><th>Id</th><th>Category</th><th className="wrap">Question</th><th className="wrap">Expected</th><th>Result</th><th className="r">Time</th></tr></thead>
            <tbody>{cases.map((c) => { const r = results.find((x) => x.id === c.id); return (
              <React.Fragment key={c.id}>
                <tr className={r ? "click" : ""} onClick={() => r && setOpen(open === c.id ? null : c.id)}>
                  <td className="mono">{c.id}</td><td><span className="badge">{c.category}</span></td><td className="wrap small">{c.question}</td><td className="wrap small muted">{c.expect}{c.tools ? ` · tool: ${c.tools.join(" | ")}` : ""}</td>
                  <td>{r ? <span className={`badge ${r.passed ? "ok" : "bad"}`}>{r.passed ? "pass" : r.error ? r.error : !r.accurate ? "wrong" : r.hallucinated ? "untraced" : "tool"}</span> : running === c.id ? <span className="spin" /> : ""}</td>
                  <td className="r">{r ? `${(r.ms / 1000).toFixed(1)} s` : ""}</td>
                </tr>
                {open === c.id && r && <tr><td colSpan={6}><div className="stack small"><span>Tools: {r.toolNames.join(", ") || "none"} · figures {r.grounding?.checked ?? 0}, untraced {r.grounding?.untraced ?? 0}</span><p style={{ whiteSpace: "pre-wrap" }}>{r.answer}</p></div></td></tr>}
              </React.Fragment>); })}</tbody></table>
        </div>
      </div>
      {history.length > 0 && (
        <div className="card">
          <header><h2>Previous runs</h2><span className="muted small">Shared with everyone who can open this page</span></header>
          <div className="tablewrap"><table><thead><tr><th>When</th><th>Set</th><th>Model</th><th className="r">Passed</th><th className="r">Accuracy</th><th className="r">Grounding</th><th className="r">Hallucination</th><th className="r">p95</th></tr></thead>
            <tbody>{history.map((h) => <tr key={h.id}><td>{when(h.at)}</td><td>{h.summary.set}</td><td>{h.summary.tier}</td><td className="r">{h.summary.passed}/{h.summary.cases}</td><td className="r">{pct(h.summary.accuracy, 0)}</td><td className="r">{pct(h.summary.grounding, 0)}</td><td className="r">{pct(h.summary.hallucination_rate, 0)}</td><td className="r">{(h.summary.latency_p95_ms / 1000).toFixed(0)} s</td></tr>)}</tbody></table></div>
        </div>
      )}
    </div>
  );
}

function Rai() {
  const { st, caps } = useApp();
  const traces = getTraces();
  const untraced = traces.reduce((a, t) => a + (t.grounding?.untraced ?? 0), 0);
  const items: [string, string, "ok" | "warn" | "info", string][] = [
    ["Deterministic calculations", "Every value, priority and plan figure comes from the SAMPT/SAVI engine, never from the language model.", "ok", "Enforced: the AI has read-only tools"],
    ["Verified against the reference tool", "The engine reproduces SAVI v1.10 on its own sample, re-checked on every page load.", st.verification?.passed ? "ok" : "warn", st.verification?.passed ? "Passing" : "Not yet run"],
    ["Human approval for every change", "Programme decisions, plan settings and inspections change the plan only when a person confirms; the AI can prepare but not approve.", "ok", "Enforced in the control layer"],
    ["Audit trail", "Each decision records who, when, what, why and the run ids before and after.", caps.db ? "ok" : "warn", caps.db ? "Shared and persistent" : "This session only"],
    ["Grounding check on AI output", "Each number in an AI answer is traced to a tool result; untraced figures are highlighted.", untraced ? "warn" : "ok", untraced ? `${untraced} untraced so far this session` : "No untraced figures this session"],
    ["Evaluation before reliance", "A 26-case set measures accuracy, grounding, hallucination, tool use, task completion and latency.", "info", "Run it on the Evaluation tab"],
    ["Uncertainty shown, not hidden", "P10–P90 bands from Monte Carlo runs on planning pages; the valuation stays deterministic.", "ok", "Available on demand"],
    ["Transparent prioritisation", "Formula, weights and per-element contributions are shown for every scheme.", "ok", "'Why this priority' panels"],
    ["Data handling", "The inventory stays in the browser. AI calls send only tool results to Claude, on the viewer's own account and with their consent. No personal data is processed.", "ok", "No server-side storage of inputs"],
    ["Works without AI", "If Claude is unavailable or declined, every engine feature still works and the workflow uses a rule-based note.", "ok", caps.sample ? "AI available" : "AI off: degraded mode active"],
    ["Known limits stated", "Planning outputs are SAVI-compatible estimates for budgeting, not a works order; condition forecasts follow SAMPT curves, not site-specific models.", "info", "Shown in the footer and method notes"],
    ["Fairness and access", "Priority uses published SAMPT network factors (route, traffic, obstacle) and user priority factors only; layouts work on phones and with keyboard.", "info", "Review factor weights with stakeholders"],
  ];
  return (
    <div className="card">
      <header><h2>Responsible-AI checklist</h2><span className="muted small">Live status where it can be measured</span></header>
      <div>{items.map(([t, d, tone, status]) => (
        <div className="check" key={t}><span className={`dot`} style={{ background: tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--accent)" : "var(--primary)", marginTop: 6, width: 10, height: 10 }} /><div><b>{t}</b><p className="small muted">{d}</p></div><span className={`badge ${tone}`}>{status}</span></div>
      ))}</div>
    </div>
  );
}

function Layers() {
  return (
    <div className="grid g2">
      <div className="card">
        <h2>Trust layer</h2>
        <ul className="small" style={{ paddingLeft: 18, marginTop: 8, display: "grid", gap: 6 }}>
          <li><b>Provenance</b> on every page: run id, rule set, price year, what changed.</li>
          <li><b>Verification</b> against SAVI v1.10 in the browser, plus the build-time QA suites.</li>
          <li><b>Explanations</b>: priority formula and element contributions; repair-versus-replace test; budget test.</li>
          <li><b>Grounding</b>: AI figures traced to tool results, untraced ones flagged.</li>
          <li><b>Uncertainty</b>: P10–P90 bands; confidence stated in AI decision notes.</li>
        </ul>
      </div>
      <div className="card">
        <h2>Control layer</h2>
        <ul className="small" style={{ paddingLeft: 18, marginTop: 8, display: "grid", gap: 6 }}>
          <li><b>Approve / defer / reject</b> any scheme with a reason; the plan re-runs and shows what moved.</li>
          <li><b>Inspection workflow</b>: six steps with retry and cancel; nothing changes until approval.</li>
          <li><b>Settings</b>: budgets, strategy and deterioration are applied only on confirmation; scenarios never commit.</li>
          <li><b>Audit log</b> of every decision with the run ids before and after.</li>
          <li><b>Agent ops</b>: every AI call's tools, latency, errors and grounding.</li>
        </ul>
      </div>
    </div>
  );
}

export function Evaluation() {
  const [t, setT] = useState("verify");
  return (
    <div className="stack lg">
      <div className="tabs" role="tablist">{[["verify", "Verification"], ["eval", "AI evaluation"], ["rai", "Responsible AI"], ["layers", "Trust & control"]].map(([k, l]) => <button key={k} role="tab" aria-selected={t === k} onClick={() => setT(k)}>{l}</button>)}</div>
      {t === "verify" ? <Verification /> : t === "eval" ? <AiEval /> : t === "rai" ? <Rai /> : <Layers />}
    </div>
  );
}
