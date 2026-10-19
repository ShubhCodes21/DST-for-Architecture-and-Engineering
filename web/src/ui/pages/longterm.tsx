import React, { useEffect, useState } from "react";
import { useApp, Kpi, Provenance, Delta } from "../app";
import { call, saveFile } from "../api";
import { Bars, LineChart } from "../charts";
import { gbp, gbpFull, n0, n1, pct, toCsv } from "../format";
import { NoRun, UncertaintyButton } from "./overview";

type Band = [number, number, number];

export function LongTerm() {
  const { st, run, setSt, toast, audit, uncertainty, caps } = useApp();
  const [bands, setBands] = useState<Band[]>([]);
  const [strategy, setStrategy] = useState("");
  const [det, setDet] = useState(1);
  const [carry, setCarry] = useState(true);
  const [years, setYears] = useState(30);
  const [scen, setScen] = useState<any[]>([]);
  const [showTable, setShowTable] = useState(false);
  useEffect(() => { if (st.settings) { setBands(st.settings.budgetBands.map((b: Band) => [...b] as Band)); setStrategy(st.settings.strategy); setDet(st.settings.deteriorationFactor); setCarry(st.settings.carryForward); setYears(st.settings.years); } }, [st.run?.run_id]);
  if (!st.run) return <NoRun />;
  const T = st.long_term.table, tot = st.long_term.totals, yrs = T.map((r: any) => r.year), Ty = T.slice(1);
  const u = uncertainty && uncertainty.run_id === st.run.run_id ? uncertainty : null;
  const patch = () => ({ budgetBands: bands.filter((b) => b[0] > 0 && b[1] >= b[0]).map((b) => [Math.round(b[0]), Math.round(b[1]), Number(b[2])]), strategy, deteriorationFactor: det, carryForward: carry, years });
  const describe = (p: any) => [`${p.strategy.replace(/ \(.*\)/, "")}`, p.budgetBands.map((b: Band) => `yrs ${b[0]}-${b[1]} ${gbp(b[2])}`).join(", "), p.deteriorationFactor !== 1 ? `deterioration ×${p.deteriorationFactor}` : "", p.carryForward ? "" : "no carry-forward"].filter(Boolean).join(" · ");
  const changed = JSON.stringify(patch()) !== JSON.stringify({ budgetBands: st.settings.budgetBands, strategy: st.settings.strategy, deteriorationFactor: st.settings.deteriorationFactor, carryForward: st.settings.carryForward, years: st.settings.years });
  const commit = async () => {
    const p = patch(), before = st.run.run_id, old = describe(st.settings);
    const r = await run("Re-running the long-term plan", () => call("setSettings", p, `Plan settings: ${describe(p)}`));
    if (r) { setSt(r); await audit("Plan settings changed", "Long-term plan", `${old} → ${describe(p)}`, { run_before: before }); toast("Plan re-run with the new settings."); }
  };
  const compare = async () => {
    const p = patch();
    const r = await run("Running scenario", () => call("scenario", p, describe(p)));
    if (r) setScen((s) => [r, ...s].slice(0, 4));
  };
  const colors = ["var(--s3)", "var(--s4)", "var(--accent)", "var(--muted)"];
  return (
    <div className="stack lg">
      <div className="grid g4">
        <Kpi label={`Spend over ${tot.years} years`} value={gbp(tot.expenditure)} sub={`of ${gbp(tot.total_budget)} budget · discounted ${gbp(tot.discounted_expenditure)} at ${pct(st.meta.discount_rate, 1)}`} />
        <Kpi label="Workbank after final year" value={gbp(tot.workbank_end)} sub="cost of all needs still outstanding" />
        <Kpi label={`SSCIav in year ${tot.years}`} value={n1(tot.ssci_av_end)} sub={<>today {n1(T[0]["ssci_av|Full Stock"])} · <Delta before={T[0]["ssci_av|Full Stock"]} after={tot.ssci_av_end} fmt={n1} /></>} />
        <Kpi label={`At traffic risk in year ${tot.years}`} value={n0(T[T.length - 1]["at_risk|Stock"])} sub={`today ${n0(T[0]["at_risk|Stock"])} structures`} />
      </div>
      <div className="grid g-main">
        <div className="stack">
          <div className="card">
            <header><h2>Condition</h2><UncertaintyButton /></header>
            <LineChart ariaLabel="Condition indices by year" labels={yrs} xTitle="Year" yMax={100} yMin={Math.max(0, Math.floor(Math.min(...T.map((r: any) => r["ssci_crit|Full Stock"]), ...scen.flatMap((s) => s.series.ssci_crit)) / 10) * 10 - 10)} yFmt={(x) => x.toFixed(0)}
              series={[
                { name: "SSCIav", values: T.map((r: any) => r["ssci_av|Full Stock"]), color: "var(--s1)", band: u ? { lo: u["ssci_av|Full Stock"].p10, hi: u["ssci_av|Full Stock"].p90 } : undefined },
                { name: "SSCIcrit", values: T.map((r: any) => r["ssci_crit|Full Stock"]), color: "var(--s2)", band: u ? { lo: u["ssci_crit|Full Stock"].p10, hi: u["ssci_crit|Full Stock"].p90 } : undefined },
                ...scen.map((s, i) => ({ name: `Scenario ${s.scenario_id} SSCIav`, values: s.series.ssci_av, color: colors[i], dashed: true })),
              ]} />
          </div>
          <div className="card">
            <header><h2>Spend against budget</h2><span className="muted small">Unspent budget carries forward {st.settings.carryForward ? "(on, as SAVI)" : "(off)"}</span></header>
            <Bars ariaLabel="Spend by year" labels={Ty.map((r: any) => r.year)} yFmt={(x) => gbp(x, 1)}
              groups={[{ name: "Condition-triggered", values: Ty.map((r: any) => r.expenditure), color: "var(--s1)" }, { name: "Planned", values: Ty.map((r: any) => r.planned), color: "var(--s4)" }, { name: "Routine", values: Ty.map((r: any) => r.routine), color: "var(--s3)" }]}
              line={{ name: "Budget incl. carry-forward", values: Ty.map((r: any) => r.budget), color: "var(--s2)" }} />
          </div>
          <div className="card">
            <header><h2>Outstanding workbank</h2></header>
            <LineChart ariaLabel="Workbank by year" labels={Ty.map((r: any) => r.year)} xTitle="Year" yFmt={(x) => gbp(x, 0)}
              series={[{ name: "Workbank", values: Ty.map((r: any) => r.workbank), color: "var(--s1)", band: u ? { lo: u.workbank.p10.slice(1), hi: u.workbank.p90.slice(1) } : undefined }, ...scen.map((s, i) => ({ name: `Scenario ${s.scenario_id}`, values: s.series.workbank.slice(1), color: colors[i], dashed: true }))]} height={190} />
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <header><h2>Plan settings</h2><span className="badge">Control</span></header>
            <div className="stack">
              <label className="field"><span>Intervention strategy (default for elements without their own)</span>
                <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>{st.meta.strategies.map((s: string) => <option key={s}>{s}</option>)}</select></label>
              <div className="field"><span>Annual budget bands (£ per year)</span>
                {bands.map((b, i) => (
                  <div className="row tight" key={i}>
                    <input type="number" min={1} value={b[0]} onChange={(e) => setBands(bands.map((x, k) => (k === i ? [+e.target.value, x[1], x[2]] : x)))} style={{ width: 60 }} aria-label="From year" />–
                    <input type="number" min={1} value={b[1]} onChange={(e) => setBands(bands.map((x, k) => (k === i ? [x[0], +e.target.value, x[2]] : x)))} style={{ width: 60 }} aria-label="To year" />
                    <input type="number" min={0} step={100000} value={b[2]} onChange={(e) => setBands(bands.map((x, k) => (k === i ? [x[0], x[1], +e.target.value] : x)))} style={{ width: 130 }} aria-label="Annual budget" />
                    <button className="btn sm ghost" onClick={() => setBands(bands.filter((_, k) => k !== i))} aria-label="Remove band">✕</button>
                  </div>
                ))}
                <div><button className="btn sm" onClick={() => setBands([...bands, [bands.length ? bands[bands.length - 1][1] + 1 : 1, years, bands.length ? bands[bands.length - 1][2] : 3e6]])}>Add band</button></div>
              </div>
              <label className="field"><span>Deterioration rate ×{det.toFixed(2)} (below 1 = faster than the SAMPT curves)</span><input type="range" min={0.7} max={1.3} step={0.05} value={det} onChange={(e) => setDet(+e.target.value)} /></label>
              <div className="row">
                <label className="row tight small"><input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} /> Carry unspent budget forward</label>
                <label className="row tight small">Years <input type="number" min={5} max={60} value={years} onChange={(e) => setYears(Math.max(5, Math.min(60, +e.target.value)))} style={{ width: 64 }} /></label>
              </div>
              <div className="row tight">
                <button className="btn" onClick={compare}>Compare as scenario</button>
                <button className="btn primary" disabled={!changed} onClick={commit}>Apply to plan</button>
              </div>
              <p className="tiny muted">A scenario is a what-if and changes nothing. Applying re-runs both plans, creates a new run id and is logged.</p>
            </div>
          </div>
          {scen.length > 0 && (
            <div className="card">
              <header><h2>Scenarios vs run {st.run.run_id}</h2><button className="btn sm ghost" onClick={() => setScen([])}>Clear</button></header>
              <div className="stack">
                {scen.map((s, i) => (
                  <div key={s.scenario_id} className="stack" style={{ gap: 6 }}>
                    <div className="row tight"><i className="dot" style={{ background: colors[i] }} /><b className="mono">{s.scenario_id}</b><span className="tiny muted">{s.label}</span></div>
                    <div className="ba">
                      <span className="h" /><span className="h">Run</span><span className="h">Scenario</span><span className="h">Change</span>
                      <span>Spend</span><span className="num">{gbp(s.base_totals.expenditure)}</span><span className="num">{gbp(s.totals.expenditure)}</span><Delta before={s.base_totals.expenditure} after={s.totals.expenditure} fmt={(x) => gbp(x)} goodUp={false} />
                      <span>Workbank end</span><span className="num">{gbp(s.base_totals.workbank_end)}</span><span className="num">{gbp(s.totals.workbank_end)}</span><Delta before={s.base_totals.workbank_end} after={s.totals.workbank_end} fmt={(x) => gbp(x)} goodUp={false} />
                      <span>SSCIav end</span><span className="num">{n1(s.base_totals.ssci_av_end)}</span><span className="num">{n1(s.totals.ssci_av_end)}</span><Delta before={s.base_totals.ssci_av_end} after={s.totals.ssci_av_end} fmt={n1} />
                      <span>SSCIcrit end</span><span className="num">{n1(s.base_totals.ssci_crit_end)}</span><span className="num">{n1(s.totals.ssci_crit_end)}</span><Delta before={s.base_totals.ssci_crit_end} after={s.totals.ssci_crit_end} fmt={n1} />
                      <span>5-yr schemes</span><span className="num">{n0(s.base_five_year.schemes_funded)}</span><span className="num">{n0(s.five_year.schemes_funded)}</span><Delta before={s.base_five_year.schemes_funded} after={s.five_year.schemes_funded} fmt={n0} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {u && (
            <div className="card tint">
              <h3>Uncertainty (forecasting tier 2)</h3>
              <p className="small" style={{ marginTop: 6 }}>{u.runs} runs, time to failure ±{u.spread * 100}% per element, random start inside each condition band. Final-year SSCIav P10–P90: <b>{n1(u["ssci_av|Full Stock"].p10.at(-1))}–{n1(u["ssci_av|Full Stock"].p90.at(-1))}</b>; workbank <b>{gbp(u.workbank.p10.at(-1))}–{gbp(u.workbank.p90.at(-1))}</b>. Planning only: the WGA valuation never uses these runs.</p>
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <header><h2>LAMP results</h2>
          <div className="row tight">
            <button className="btn sm" onClick={() => setShowTable(!showTable)}>{showTable ? "Hide" : "Show"} year-by-year table</button>
            <button className="btn sm" onClick={async () => { const e = await saveFile(caps, `lamp-results-${st.run.run_id}.csv`, toCsv(T)); if (e) toast(e); }}>Export CSV</button>
            <button className="btn sm" onClick={async () => { const rows = await call("workPlanCsvRows"); const e = await saveFile(caps, `forward-work-plan-${st.run.run_id}.csv`, toCsv(rows)); if (e) toast(e); }}>Export work plan ({n0(st.long_term.works_count)} items)</button>
          </div>
        </header>
        {showTable && (
          <div className="tablewrap tall">
            <table>
              <thead><tr><th className="r">Year</th><th className="r">Budget</th><th className="r">Carry-in</th><th className="r">Spend</th><th className="r">Planned</th><th className="r">Routine</th><th className="r">Remaining</th><th className="r">Workbank</th><th className="r">SSCIav</th><th className="r">SSCIcrit</th><th className="r">Good repair</th><th className="r">At risk</th></tr></thead>
              <tbody>{T.map((r: any) => <tr key={r.year}><td className="r">{r.year}</td><td className="r">{r.year ? gbp(r.start_budget) : ""}</td><td className="r">{r.year ? gbp(r.carry_in) : ""}</td><td className="r">{r.year ? gbp(r.expenditure) : ""}</td><td className="r">{r.year ? gbp(r.planned) : ""}</td><td className="r">{r.year ? gbp(r.routine) : ""}</td><td className="r">{r.year ? gbp(r.remaining) : ""}</td><td className="r">{r.year ? gbp(r.workbank) : ""}</td><td className="r">{n1(r["ssci_av|Full Stock"])}</td><td className="r">{n1(r["ssci_crit|Full Stock"])}</td><td className="r">{pct(r["sss|Full Stock"])}</td><td className="r">{n0(r["at_risk|Stock"])}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
      <Provenance extra={`${describe(st.settings)} · ${gbpFull(tot.total_budget)} total budget`} />
    </div>
  );
}
