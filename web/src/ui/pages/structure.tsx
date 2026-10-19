import React, { useEffect, useState } from "react";
import { useApp, Cond, Sci, Delta } from "../app";
import { call } from "../api";
import { EcsStrip } from "../charts";
import { gbp, n1, n2, n0 } from "../format";
import { DecisionControls, PriorityExplain } from "./programme";
import { setWorkflowStructure } from "./workflow";

export function StructureDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { st, go } = useApp();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState("");
  useEffect(() => { setD(null); setErr(""); call("structure", id).then(setD).catch((e) => setErr(String(e.message ?? e))); }, [id, st.run?.run_id]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const byYear: Record<number, number> = {};
  d?.long_term_works.forEach((w: any) => (byYear[w.year] = (byYear[w.year] || 0) + w.cost));
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Structure ${id}`}>
        <div className="row spread" style={{ marginBottom: 14 }}>
          <div className="stack" style={{ gap: 2 }}><span className="label">Structure record</span><h1><span className="mono">{id}</span> {d?.name}</h1>{d && <span className="muted small">{d.structure_type} · {d.group} · {d.route} over {d.obstacle} · {d.traffic} traffic · {n1(d.length_m)} m</span>}</div>
          <button className="btn" onClick={onClose} aria-label="Close">Close</button>
        </div>
        {err && <div className="note bad">{err}</div>}
        {!d && !err && <div className="empty"><span className="spin" /></div>}
        {d && (
          <div className="stack lg">
            <div className="grid g4">
              <div className="card flat kpi"><span className="label">SCIav now → yr 5</span><span className="v" style={{ fontSize: "1.35rem" }}><Sci v={d.sci_av} /></span><span className="s">→ {n1(d.sci_av_y5)} <Delta before={d.sci_av} after={d.sci_av_y5} fmt={n1} /></span></div>
              <div className="card flat kpi"><span className="label">SCIcrit now → yr 5</span><span className="v" style={{ fontSize: "1.35rem" }}><Sci v={d.sci_crit} /></span><span className="s">→ {n1(d.sci_crit_y5)} <Delta before={d.sci_crit} after={d.sci_crit_y5} fmt={n1} /></span></div>
              <div className="card flat kpi"><span className="label">GRC / DRC</span><span className="v" style={{ fontSize: "1.35rem" }}>{gbp(d.grc)}</span><span className="s">DRC {gbp(d.drc)}</span></div>
              <div className="card flat kpi"><span className="label">5-year programme</span><span className="v" style={{ fontSize: "1.35rem" }}>{d.in_programme ? `Year ${d.programme_year}` : d.rank ? "Unfunded" : "No need"}</span><span className="s">{d.in_programme ? `${d.programme_action} · ${gbp(d.programme_cost)}` : d.rank ? `rank ${d.rank} · ${d.need} ${gbp(d.scheme_cost)}` : "nothing triggered"}</span></div>
            </div>
            <div className="row">
              {d.rank && <DecisionControls sid={d.structure_id} />}
              <button className="btn" onClick={() => { setWorkflowStructure(d.structure_id); onClose(); go("workflow"); }}>Record a new inspection</button>
              {d.at_risk_y0 && <span className="badge bad">Traffic restriction risk now · {gbp(d.delay_cost_y0)}/day</span>}
              {!d.good_repair && <span className="badge warn">Not in good repair</span>}
            </div>
            {d.rank && <div className="card"><PriorityExplain sid={d.structure_id} /></div>}
            <div className="card">
              <header><h2>Elements</h2><span className="muted small">{d.elements.length} elements · strip shows condition each year of the plan</span></header>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Element</th><th>Material</th><th>Cond.</th><th>Importance</th><th>Exposure</th><th className="r">Need cost</th><th>Status</th><th>Years 0–{d.elements[0]?.profile.length - 1}</th></tr></thead>
                  <tbody>{d.elements.map((e: any) => (
                    <tr key={e.index}>
                      <td>{e.element_type}</td><td className="muted">{e.material}</td><td><Cond code={e.condition} ecs={e.ecs} /></td><td>{e.importance}</td><td>{e.exposure ?? ""}</td>
                      <td className="r">{e.need ? gbp(e.need_cost) : ""}</td><td>{e.status !== "-" ? <span className="badge info">{e.status}</span> : e.need ? <span className="tiny muted" title={e.need}>need, not in scheme</span> : ""}</td>
                      <td><EcsStrip values={e.profile} /></td>
                    </tr>))}</tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <header><h2>Long-term works on this structure</h2><span className="muted small">{Object.keys(byYear).length ? `${Object.keys(byYear).length} years with works · ${gbp(Object.values(byYear).reduce((a, b) => a + b, 0))} total` : "none in the plan"}</span></header>
              <div className="row tight">{Object.entries(byYear).map(([y, c]) => <span key={y} className="chip">Yr {y}: {gbp(c)}</span>)}</div>
            </div>
            <p className="tiny muted">Run {d.run_id} · {d.reference ? `Ref ${d.reference} · ` : ""}{n0(d.number_in_group)} in group · {d.location}</p>
          </div>
        )}
      </aside>
    </>
  );
}
