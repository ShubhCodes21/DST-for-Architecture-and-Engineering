import React, { useState } from "react";
import { useApp, Kpi, Provenance } from "../app";
import { call } from "../api";
import { LineChart, StackBar } from "../charts";
import { gbp, n0, n1, pct, bandVar } from "../format";
import { setPendingQuestion } from "./assistant";

export function UncertaintyButton({ compact }: { compact?: boolean }) {
  const { uncertainty, setUncertainty, run, st, progress } = useApp();
  const stale = uncertainty && uncertainty.run_id !== st.run.run_id;
  return (
    <button className="btn sm" disabled={!!progress} onClick={() => run("Running 20 Monte Carlo plans", async () => setUncertainty(await call("uncertainty", 20, 0)))}
      title="20 runs with each element's time to failure varied ±20% and a random start inside its condition band (SAMPT Part A 2.13.7)">
      {uncertainty && !stale ? "Re-run uncertainty" : compact ? "Add P10–P90 band" : "Show uncertainty (P10–P90, 20 runs)"}
    </button>
  );
}

export function Overview() {
  const { st, go, openStructure, uncertainty } = useApp();
  const [q, setQ] = useState("");
  if (!st.run) return <NoRun />;
  const v = st.valuation, c = st.condition_y0, s5 = st.five_year.summary, lt = st.long_term, T = lt.table;
  const stock = c.ssci_table.Stock;
  const years = T.map((r: any) => r.year);
  const u = uncertainty && uncertainty.run_id === st.run.run_id ? uncertainty : null;
  const top = st.five_year.projects[0];
  const unfunded = st.five_year.unfunded;
  const wb1 = T[1]?.workbank ?? 0, wbN = T[T.length - 1]?.workbank ?? 0;
  const sEnd = lt.totals.ssci_av_end;
  const alerts: { tone: string; text: React.ReactNode; action?: () => void; cta?: string }[] = [];
  if (c.structures_at_risk > 0) alerts.push({ tone: "bad", text: <><b>{n0(c.structures_at_risk)} structures</b> have a very-high or high importance element at condition 4 or worse, so traffic restrictions are likely (daily delay cost {gbp(c.traffic_delay_cost)} if all were restricted).</>, action: () => go("inventory"), cta: "See them" });
  if (top) alerts.push({ tone: "warn", text: <>Top priority: <b className="mono">{top.structure_id}</b> {top.structure_name} — {top.action.toLowerCase()} in year {top.year} for {gbp(top.cost)}.</>, action: () => openStructure(top.structure_id), cta: "Open" });
  if (unfunded.length) alerts.push({ tone: "warn", text: <><b>{unfunded.length}{unfunded.length >= 60 ? "+" : ""} structures</b> need a scheme the 5-year budget cannot reach (next in line: <span className="mono">{unfunded[0].structure_id}</span>, {gbp(unfunded[0].cost)}).</>, action: () => go("programme"), cta: "Review" });
  if (wbN > wb1 * 1.1) alerts.push({ tone: "bad", text: <>The outstanding workbank grows from {gbp(wb1)} in year 1 to {gbp(wbN)} by year {T.length - 1} at current budgets.</>, action: () => go("longterm"), cta: "Test budgets" });
  else alerts.push({ tone: "ok", text: <>Current budgets hold the workbank at {gbp(wbN)} by year {T.length - 1} (from {gbp(wb1)} in year 1).</>, action: () => go("longterm"), cta: "Plan" });
  if (sEnd < stock.ssci_av - 1) alerts.push({ tone: "warn", text: <>Average condition (SSCIav) falls from {n1(stock.ssci_av)} today to {n1(sEnd)} by the final year.</>, action: () => go("longterm"), cta: "Why" });
  if (st.decisions.length) alerts.push({ tone: "info", text: <>{st.decisions.length} programme decision{st.decisions.length > 1 ? "s" : ""} recorded in this run ({st.decisions.map((d: any) => `${d.structure_id} ${d.status}`).slice(0, 3).join(", ")}).</>, action: () => go("governance"), cta: "Audit" });

  const bands = ["Very Good", "Good", "Fair", "Poor", "Very Poor"].map((b) => ({ name: b, value: c.bands[b] ?? 0, color: bandVar(b) }));
  return (
    <div className="stack lg">
      {st.verification && (
        <div className="hero-strip">
          <span className={`badge ${st.verification.passed ? "ok" : "bad"}`}>{st.verification.passed ? "Verified" : "Check failed"}</span>
          <span className="small">This engine re-ran SAVI v1.10's sample in your browser and matched <b>{n0(st.verification.lamp_cells - st.verification.lamp_mismatches)} of {n0(st.verification.lamp_cells)}</b> published plan figures and all {st.verification.checks.length} headline checks.</span>
          <button className="btn sm ghost" onClick={() => go("evaluation")}>Details</button>
        </div>
      )}
      <div className="grid g4">
        <Kpi label="Gross replacement cost" value={gbp(v.grc)} sub={`${n0(st.inventory.structures)} records · ${st.meta.price_year} prices`} />
        <Kpi label="Depreciated replacement cost" value={gbp(v.drc)} sub={`${pct(v.drc_pct_of_grc)} of GRC · depreciation ${gbp(v.annual_depreciation, 2)}/yr`} />
        <Kpi label="Average condition · SSCIav" value={n1(stock.ssci_av)} sub={<>Critical {n1(stock.ssci_crit)} · after 5 yrs {n1(s5["ssci_av|Full Stock"])}</>} />
        <Kpi label="In good repair" value={pct(stock.sss)} sub={`${n0(c.structures_at_risk)} structures at traffic risk`} />
      </div>
      <div className="grid g-main">
        <div className="card">
          <header><h2>Condition over the plan</h2><div className="row tight"><span className="muted small">Full stock, AVF-weighted</span><UncertaintyButton compact /></div></header>
          <LineChart ariaLabel="Stock condition index by year" labels={years} xTitle="Year" height={270} yMin={Math.max(0, Math.floor(Math.min(...T.map((r: any) => r["ssci_crit|Full Stock"]), ...(u ? u["ssci_crit|Full Stock"].p10 : [])) / 10) * 10 - 10)} yMax={100} yFmt={(x) => x.toFixed(0)}
            series={[
              { name: "SSCIav", values: T.map((r: any) => r["ssci_av|Full Stock"]), color: "var(--s1)", band: u ? { lo: u["ssci_av|Full Stock"].p10, hi: u["ssci_av|Full Stock"].p90 } : undefined },
              { name: "SSCIcrit", values: T.map((r: any) => r["ssci_crit|Full Stock"]), color: "var(--s2)", band: u ? { lo: u["ssci_crit|Full Stock"].p10, hi: u["ssci_crit|Full Stock"].p90 } : undefined },
            ]} />
          <p className="tiny muted" style={{ marginTop: 6 }}>{u ? `Shaded: P10–P90 of ${u.runs} Monte Carlo runs (time to failure ±${u.spread * 100}%, random start in band). The line is the SAVI-compatible run.` : "The line is the SAVI-compatible deterministic run. Add the band to see how sensitive it is to deterioration rates."}</p>
        </div>
        <div className="stack">
          <div className="card">
            <header><h2>Needs attention</h2><span className="badge">Rules, not AI</span></header>
            <div className="stack">
              {alerts.map((a, i) => (
                <div key={i} className={`note ${a.tone === "bad" ? "bad" : a.tone === "warn" ? "warn" : a.tone === "ok" ? "ok" : ""}`}>
                  <div className="row spread" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}><span>{a.text}</span>{a.action && <button className="btn sm" onClick={a.action}>{a.cta}</button>}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="grid g3">
        <div className="card">
          <header><h2>5-year programme</h2><button className="btn sm ghost" onClick={() => go("programme")}>Open →</button></header>
          <div className="stack">
            <div className="kpi"><span className="v">{gbp(s5.expenditure)}</span><span className="s">of {gbp(s5.total_budget)} · {n0(s5.schemes_funded)} schemes · {n0(s5.elements_maintained)} elements</span></div>
            <StackBar parts={[{ name: "Schemes", value: s5.expenditure, color: "var(--s1)" }, { name: "Planned", value: s5.planned, color: "var(--s4)" }, { name: "Routine", value: s5.routine, color: "var(--s3)" }, { name: "Unallocated", value: Math.max(0, s5.remaining), color: "var(--surface-3)" }]} fmt={(x) => gbp(x)} />
          </div>
        </div>
        <div className="card">
          <header><h2>Structures by condition</h2><span className="muted small">SCIav band, today</span></header>
          <StackBar parts={bands} />
        </div>
        <div className="card">
          <header><h2>Long-term plan</h2><button className="btn sm ghost" onClick={() => go("longterm")}>Open →</button></header>
          <div className="stack">
            <div className="kpi"><span className="v">{gbp(lt.totals.workbank_end)}</span><span className="s">outstanding workbank after year {lt.totals.years}</span></div>
            <span className="small muted">Spend {gbp(lt.totals.expenditure)} of {gbp(lt.totals.total_budget)} over {lt.totals.years} years · discounted {gbp(lt.totals.discounted_expenditure)}</span>
          </div>
        </div>
      </div>
      <div className="card tint">
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { setPendingQuestion(q.trim()); go("assistant"); } }}>
          <span className="badge ai">Ask</span>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Why is ST423 first? What if the budget were £4m a year?" style={{ flex: 1, minWidth: 200 }} aria-label="Ask a question about this data" />
          <button className="btn primary" type="submit">Ask</button>
        </form>
      </div>
      <Provenance />
    </div>
  );
}

export function NoRun() {
  const { st, go } = useApp();
  return (
    <div className="card">
      <h2>No plan yet</h2>
      <p className="muted" style={{ marginTop: 6 }}>{st.validation && !st.validation.valid ? `The loaded inventory has ${st.validation.errors} blocking validation errors. Fix them and load it again, or load the sample.` : "Load an inventory to start."}</p>
      <div className="row" style={{ marginTop: 12 }}><button className="btn primary" onClick={() => go("inventory")}>Go to inventory</button></div>
    </div>
  );
}
