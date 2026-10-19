import React, { useEffect, useState } from "react";
import { useApp, Kpi, Provenance, Delta } from "../app";
import { call, saveFile } from "../api";
import { Bars } from "../charts";
import { gbp, gbpFull, n0, n1, n2, pct, toCsv } from "../format";
const n2c = (v: number) => v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
import { NoRun } from "./overview";

export function DecisionControls({ sid, compact }: { sid: string; compact?: boolean }) {
  const { st, run, setSt, toast, audit } = useApp();
  const current = st.decisions.find((d: any) => d.structure_id === sid);
  const [mode, setMode] = useState<null | "rejected" | "deferred" | "approved">(null);
  const [note, setNote] = useState("");
  const apply = async (status: string) => {
    const before = st.run.run_id;
    const r: any = await run(status === "clear" ? "Clearing decision" : `Re-planning with ${sid} ${status}`, () => call("decide", { structure_id: sid, status, note, at: new Date().toISOString() }));
    if (!r) return;
    setSt(r.state);
    const moved = [r.entered.length ? `${r.entered.length} entered (${r.entered.slice(0, 4).join(", ")}${r.entered.length > 4 ? "…" : ""})` : "", r.left.length ? `${r.left.length} left` : ""].filter(Boolean).join("; ");
    toast(`${sid}: ${status === "clear" ? "decision cleared" : status}. ${moved ? "Programme: " + moved + "." : "Programme unchanged."}`);
    await audit(status === "clear" ? "Decision cleared" : `Programme item ${status}`, sid, note || "(no note)", { run_before: before });
    setMode(null); setNote("");
  };
  if (mode) {
    return (
      <form className="row tight" onSubmit={(e) => { e.preventDefault(); if (mode !== "approved" && !note.trim()) { toast("Give a reason - it goes in the audit log."); return; } apply(mode); }}>
        <input type="text" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === "approved" ? "Note (optional)" : "Reason (required)"} style={{ width: compact ? 150 : 220 }} aria-label="Reason" />
        <button className="btn sm primary" type="submit">Confirm {mode === "approved" ? "approve" : mode === "deferred" ? "defer" : "reject"}</button>
        <button className="btn sm ghost" type="button" onClick={() => setMode(null)}>Cancel</button>
      </form>
    );
  }
  if (current) return (
    <span className="row tight"><span className={`badge ${current.status === "approved" ? "ok" : current.status === "rejected" ? "bad" : "warn"}`} title={current.note}>{current.status}</span>
      <button className="btn sm ghost" onClick={() => apply("clear")}>Undo</button></span>
  );
  return (
    <span className="row tight">
      <button className="btn sm ok" onClick={() => setMode("approved")} title="Accept the engine's proposal">Approve</button>
      <button className="btn sm" onClick={() => setMode("deferred")} title="Push beyond year 5: removed from the 5-year programme and from years 1-5 of the long-term plan">Defer</button>
      <button className="btn sm bad" onClick={() => setMode("rejected")} title="Remove from the 5-year programme (engineering judgement); the long-term need stays">Reject</button>
    </span>
  );
}

export function PriorityExplain({ sid }: { sid: string }) {
  const [x, setX] = useState<any>(null);
  const { st } = useApp();
  useEffect(() => { setX(null); call("explainPriority", sid).then(setX).catch((e) => setX({ error: String(e.message ?? e) })); }, [sid, st.run.run_id]);
  if (!x) return <div className="muted small"><span className="spin" /> Explaining…</div>;
  if (x.error) return <div className="note bad">{x.error}</div>;
  const b = x.budget;
  return (
    <div className="stack">
      <div className="row tight"><span className="badge info">Why this priority</span><span className="chip">Run {x.run_id}</span></div>
      <div className="grid g3">
        <div><span className="label">Structure priority</span><div className="kpi"><span className="v" style={{ fontSize: "1.3rem" }}>{n2c(x.structure_priority)}</span></div><span className="tiny muted">rank {x.rank ?? "–"} of {x.of_ranked}</span></div>
        <div><span className="label">Scheme</span><div className="kpi"><span className="v" style={{ fontSize: "1.3rem" }}>{x.scheme.action}</span></div><span className="tiny muted">repair {gbp(x.scheme.repair_cost)} · replace {gbp(x.scheme.replace_cost)}</span></div>
        <div><span className="label">Budget test</span><div className="kpi"><span className="v" style={{ fontSize: "1.3rem" }}>{b.funded ? `Year ${b.programme_year}` : "Not funded"}</span></div><span className="tiny muted">cumulative {gbp(b.cumulative_cost_at_rank)} vs {gbp(b.available_5yr)} available</span></div>
      </div>
      <p className="small">{x.scheme.action === "Replace" ? `Replacement is chosen: 1.5 × GRC (${gbp(x.scheme.replace_cost)}) is below the repair scheme cost (${gbp(x.scheme.repair_cost)}).` : x.scheme.action === "Maintain" ? `Repair is cheaper than replacement (${gbp(x.scheme.repair_cost)} vs ${gbp(x.scheme.replace_cost)}).` : "No element needs work under the current strategy."}
        {" "}{b.funded ? `Funded because the cumulative cost of all higher-ranked schemes plus this one stays within the 5-year budget.` : `Not funded: the cumulative cost at this rank exceeds the budget available after planned and routine work.`}</p>
      <details>
        <summary className="small">Formula and element breakdown ({x.elements.length} elements with a need)</summary>
        <p className="tiny muted" style={{ margin: "8px 0" }}>{x.formula} Weights f1 {x.weights.f1}, f2 {x.weights.f2}, f3 {x.weights.f3}; route {x.factors.route}, traffic {x.factors.traffic}, obstacle {x.factors.obstacle}, structure type {x.factors.structure_type} → network score {n2(x.network_score)}.</p>
        <div className="tablewrap"><table><thead><tr><th>Element</th><th>Cond.</th><th className="r">ECI</th><th className="r">Condition</th><th className="r">Network</th><th className="r">Extra</th><th className="r">Priority</th><th>Action</th><th className="r">Cost</th><th>In scheme</th></tr></thead>
          <tbody>{x.elements.map((e: any) => <tr key={e.element_seq}><td>{e.element_type}</td><td className="mono">{e.condition}</td><td className="r">{n2(e.eci)}</td><td className="r">{n2(e.condition_score)}</td><td className="r">{n2(e.network_score)}</td><td className="r">{n0(e.extra)}</td><td className="r"><b>{n2(e.priority)}</b></td><td className="wrap">{e.action}</td><td className="r">{gbp(e.cost)}</td><td>{e.considered ? "yes" : "no"}</td></tr>)}</tbody></table></div>
      </details>
    </div>
  );
}

export function Programme() {
  const { st, run, setSt, openStructure, caps, toast, audit } = useApp();
  const [sel, setSel] = useState<string | null>(null);
  const [yr, setYr] = useState(0);
  const [budget, setBudget] = useState<string>("");
  const [view, setView] = useState<"funded" | "unfunded">("funded");
  if (!st.run) return <NoRun />;
  const s = st.five_year.summary, P = st.five_year.projects as any[], U = st.five_year.unfunded as any[];
  const byYear = [1, 2, 3, 4, 5].map((y) => P.filter((p) => p.year === y).reduce((a, p) => a + p.cost, 0));
  const rows = (view === "funded" ? P : U).filter((p) => !yr || p.year === yr);
  const selected = sel ?? P[0]?.structure_id;
  const decided = Object.fromEntries(st.decisions.map((d: any) => [d.structure_id, d.status]));
  const outside = st.decisions.filter((d: any) => !P.some((p) => p.structure_id === d.structure_id));
  const apply = async () => {
    const v = Number(budget.replace(/[£,\s]/g, ""));
    if (!(v > 0)) { toast("Enter an annual budget in pounds, e.g. 3500000"); return; }
    const before = st.run.run_id, old = st.settings.fiveYearAnnualBudget;
    const r = await run("Re-planning the 5-year programme", () => call("setSettings", { fiveYearAnnualBudget: v }, `5-year budget ${gbp(v)}/yr`));
    if (r) { setSt(r); setBudget(""); await audit("5-year budget changed", "Programme", `${gbpFull(old)} → ${gbpFull(v)} per year`, { run_before: before }); }
  };
  return (
    <div className="stack lg">
      <div className="grid g4">
        <Kpi label="5-year budget" value={gbp(s.total_budget)} sub={`${gbp(s.annual_budget)} a year · factor ${s.budget_factor}`} />
        <Kpi label="Programme spend" value={gbp(s.expenditure)} sub={`${pct(s.expenditure / s.total_budget)} of budget · ${gbp(s.remaining)} unallocated`} />
        <Kpi label="Schemes funded" value={n0(s.schemes_funded)} sub={`${n0(s.elements_maintained)} elements maintained · planned ${gbp(s.planned)} · routine ${gbp(s.routine)}`} />
        <Kpi label="SSCIav after 5 years" value={n1(s["ssci_av|Full Stock"])} sub={<>today {n1(st.condition_y0.ssci_table.Stock.ssci_av)} · <Delta before={st.condition_y0.ssci_table.Stock.ssci_av} after={s["ssci_av|Full Stock"]} fmt={n1} /></>} />
      </div>
      <div className="grid g-main">
        <div className="card">
          <header><h2>Spend by programme year</h2><span className="muted small">Schemes are scheduled by cumulative cost against fifths of the budget</span></header>
          <Bars ariaLabel="Programme cost by year" labels={[1, 2, 3, 4, 5]} yFmt={(x) => gbp(x, 1)} groups={[{ name: "Scheme cost", values: byYear, color: "var(--s1)" }]} line={{ name: "Annual budget", values: [1, 2, 3, 4, 5].map(() => s.annual_budget), color: "var(--s2)" }} height={180} />
        </div>
        <div className="card">
          <header><h2>Budget</h2><span className="badge">Control</span></header>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); apply(); }}>
            <label className="field"><span>Annual budget for years 1–5 (£)</span><input type="text" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={String(s.annual_budget)} /></label>
            <div className="row tight"><button className="btn primary" type="submit">Re-plan</button><span className="tiny muted">Recorded in the audit log with both run ids.</span></div>
          </form>
          {outside.length > 0 && <div className="note warn small" style={{ marginTop: 12 }}>Not in the programme because of a decision: {outside.map((d: any) => <span key={d.structure_id}><button className="btn sm ghost mono" onClick={() => setSel(d.structure_id)}>{d.structure_id}</button> {d.status}</span>)}</div>}
        </div>
      </div>
      <div className="grid g-main">
        <div className="card">
          <header>
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={view === "funded"} onClick={() => setView("funded")}>Funded ({P.length})</button>
              <button role="tab" aria-selected={view === "unfunded"} onClick={() => setView("unfunded")}>Needed, not funded ({U.length}{U.length >= 60 ? "+" : ""})</button>
            </div>
            <div className="row tight">
              {view === "funded" && <select value={yr} onChange={(e) => setYr(+e.target.value)} aria-label="Year"><option value={0}>All years</option>{[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>Year {y}</option>)}</select>}
              <button className="btn sm" onClick={async () => { const rows = await call("programmeCsvRows"); const e = await saveFile(caps, `programme-${st.run.run_id}.csv`, toCsv(rows)); if (e) toast(e); }}>Export CSV</button>
            </div>
          </header>
          <div className="tablewrap tall">
            <table>
              <thead><tr><th className="r">Rank</th>{view === "funded" && <th>Year</th>}<th>Structure</th><th>Action</th><th className="r">Priority</th><th className="r">Cost</th><th>Decision</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.structure_id} className={`click ${selected === p.structure_id ? "sel" : ""}`} onClick={() => setSel(p.structure_id)}>
                    <td className="r">{p.rank}</td>{view === "funded" && <td>{p.year}</td>}
                    <td><span className="mono">{p.structure_id}</span> {p.structure_name}<div className="tiny muted">{p.structure_type}</div></td>
                    <td><span className={`badge ${p.action === "Replace" ? "warn" : "info"}`}>{p.action}</span></td>
                    <td className="r">{n2c(p.priority_score)}</td><td className="r">{gbp(p.cost)}</td>
                    <td>{decided[p.structure_id] ? <span className={`badge ${decided[p.structure_id] === "approved" ? "ok" : "warn"}`}>{decided[p.structure_id]}</span> : <span className="muted tiny">proposed</span>}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={7} className="empty">Nothing here.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card" style={{ alignSelf: "start" }}>
          {selected ? (
            <div className="stack">
              <div className="row spread"><h2><span className="mono">{selected}</span></h2><button className="btn sm" onClick={() => openStructure(selected)}>Structure record</button></div>
              <DecisionControls sid={selected} />
              <hr className="sep" />
              <PriorityExplain sid={selected} />
            </div>
          ) : <div className="empty">Select a scheme to see why it is ranked where it is.</div>}
        </div>
      </div>
      <Provenance extra="Approve keeps the proposal; Defer and Reject re-run the plan so the next schemes move up." />
    </div>
  );
}
