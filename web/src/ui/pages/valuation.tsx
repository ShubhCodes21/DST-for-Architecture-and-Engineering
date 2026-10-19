import React from "react";
import { useApp, Kpi, Provenance } from "../app";
import { saveFile } from "../api";
import { gbp, gbpFull, n0, pct, toCsv } from "../format";
import { NoRun } from "./overview";

const GROUP: Record<string, string> = { AVF_Bridge: "Bridges", AVF_RetainingWall: "Retaining walls", AVF_SmallCulvert: "Culverts", AVF_SignGantry: "Sign/signal gantries", AVF_HighMast: "High mast lighting", AVF_Tunnel: "Tunnels and vehicular underpasses", AVF_Other: "Other" };

export function Valuation() {
  const { st, caps, toast } = useApp();
  if (!st.run) return <NoRun />;
  const v = st.valuation;
  const groups = Object.entries(v.by_avf_group).filter(([, g]: any) => g.structures > 0) as [string, any][];
  const types = Object.entries(v.by_structure_type).filter(([, g]: any) => g.structures > 0).sort((a: any, b: any) => b[1].grc - a[1].grc) as [string, any][];
  const exportCsv = async () => {
    const rows = [
      ...groups.map(([k, g]) => ({ level: "asset group", name: GROUP[k] ?? k, structures: g.structures, grc: g.grc.toFixed(2), accumulated_depreciation: (g.grc - g.drc).toFixed(2), drc: g.drc.toFixed(2) })),
      ...types.map(([k, g]) => ({ level: "structure type", name: k, structures: g.structures, grc: g.grc.toFixed(2), accumulated_depreciation: (g.grc - g.drc).toFixed(2), drc: g.drc.toFixed(2) })),
      { level: "total", name: "All structures", structures: groups.reduce((a, [, g]) => a + g.structures, 0), grc: v.grc.toFixed(2), accumulated_depreciation: v.accumulated_depreciation.toFixed(2), drc: v.drc.toFixed(2) },
    ];
    const e = await saveFile(caps, `wga-valuation-${st.meta.price_year.replace("/", "-")}-${st.run.run_id}.csv`, toCsv(rows));
    if (e) toast(e);
  };
  return (
    <div className="stack lg">
      <div className="grid g4">
        <Kpi label="Gross replacement cost" value={gbp(v.grc)} sub={gbpFull(v.grc)} />
        <Kpi label="Accumulated depreciation" value={gbp(v.accumulated_depreciation)} sub={gbpFull(v.accumulated_depreciation)} />
        <Kpi label="Depreciated replacement cost" value={gbp(v.drc)} sub={`${gbpFull(v.drc)} · ${pct(v.drc_pct_of_grc)} of GRC`} />
        <Kpi label="Annual depreciation" value={gbp(v.annual_depreciation, 2)} sub={gbpFull(v.annual_depreciation)} />
      </div>
      <div className="grid g-main">
        <div className="card">
          <header><h2>Valuation by asset group</h2><button className="btn sm" onClick={exportCsv}>Export CSV</button></header>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Asset group</th><th className="r">Structures</th><th className="r">GRC</th><th className="r">Accum. depreciation</th><th className="r">DRC</th><th className="r">DRC / GRC</th></tr></thead>
              <tbody>
                {groups.map(([k, g]) => <tr key={k}><td>{GROUP[k] ?? k}</td><td className="r">{n0(g.structures)}</td><td className="r">{gbp(g.grc, 2)}</td><td className="r">{gbp(g.grc - g.drc, 2)}</td><td className="r">{gbp(g.drc, 2)}</td><td className="r">{pct(g.grc ? g.drc / g.grc : 0)}</td></tr>)}
                <tr><td><b>Total</b></td><td className="r"><b>{n0(groups.reduce((a, [, g]) => a + g.structures, 0))}</b></td><td className="r"><b>{gbp(v.grc, 2)}</b></td><td className="r"><b>{gbp(v.accumulated_depreciation, 2)}</b></td><td className="r"><b>{gbp(v.drc, 2)}</b></td><td className="r"><b>{pct(v.drc_pct_of_grc)}</b></td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="card tint">
          <h2>Basis of valuation</h2>
          <div className="stack small" style={{ marginTop: 10 }}>
            <p><b>Gross replacement cost</b>: the cost of a modern equivalent structure at {st.meta.price_year} prices: unit rate by structure type × key dimension × adjustment factors (heritage, environment, location, route and obstacle).</p>
            <p><b>Depreciated replacement cost</b>: GRC less accumulated depreciation, where each element is depreciated by the share of its life used up, taken from its reported condition and its material's deterioration curve. Element costs are scaled so they sum to the structure's GRC.</p>
            <p><b>Annual depreciation</b>: each element's replacement cost over its time to failure, on the same scale.</p>
            <p>This is the depreciated-replacement-cost method SAVI v1.10 uses for the CIPFA Code of Practice on Transport Infrastructure Assets and the WGA return. On SAVI's reference workbook these figures match SAVI's own (see Evaluation & trust).</p>
            <p className="muted">Deterministic only: the Monte Carlo runs on the planning pages never touch this valuation.</p>
          </div>
        </div>
      </div>
      <div className="card">
        <header><h2>By structure type</h2><span className="muted small">{types.length} types present</span></header>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Structure type</th><th className="r">Structures</th><th className="r">GRC</th><th className="r">DRC</th><th className="r">DRC / GRC</th><th style={{ width: "30%" }}>Share of GRC</th></tr></thead>
            <tbody>{types.map(([k, g]) => <tr key={k}><td>{k}</td><td className="r">{n0(g.structures)}</td><td className="r">{gbp(g.grc, 2)}</td><td className="r">{gbp(g.drc, 2)}</td><td className="r">{pct(g.grc ? g.drc / g.grc : 0)}</td><td><div className="stackbar"><div className="bar" style={{ height: 8 }}><span style={{ width: `${(g.grc / v.grc) * 100}%`, background: "var(--s1)" }} /></div></div></td></tr>)}</tbody>
          </table>
        </div>
      </div>
      <Provenance extra={`${n0(st.inventory.elements)} elements valued`} />
    </div>
  );
}
