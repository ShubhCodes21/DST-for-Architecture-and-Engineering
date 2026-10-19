import React, { useEffect, useRef, useState } from "react";
import { useApp, Provenance, Sci } from "../app";
import { call, saveFile } from "../api";
import { record } from "../audit";
import { StackBar } from "../charts";
import { gbp, n0, n1, pct, bandVar, toCsv } from "../format";

const GROUPS = ["Bridges", "Retaining Walls", "Culverts", "Sign/Signal Gantries", "High Mast Lighting", "Tunnels and Vehicular Underpasses", "Other"];
const TEMPLATES: Record<string, string[]> = {
  "structures.csv": ["structure_seq", "structure_id", "name", "reference", "structure_type", "number_in_group", "length_m", "width_m", "headroom_m", "spans", "location", "route_supported", "route_salted", "traffic", "obstacle_crossed", "obstacle_salted", "pf_heritage", "pf_2", "pf_3", "pf_4", "pf_5", "pf_6", "adj_heritage", "adj_conservation_area", "adj_environmentally_sensitive", "adj_river_coastal_wall", "adj_substandard", "adj_spare_1", "adj_spare_2", "adj_spare_3", "adj_spare_4", "adj_spare_5", "adj_spare_6"],
  "elements.csv": ["element_seq", "structure_id", "element_type", "material", "condition_code", "spray_proximity", "pf_heritage", "pf_2", "pf_3", "pf_4", "pf_5", "pf_6", "intervention_threshold"],
  "planned.csv": ["element_seq", "structure_id", "structure_name", "element_type", "material", "year_of_work", "maintenance_action", "total_cost", "condition_after"],
  "routine.csv": ["year", "routine_maintenance", "general_inspections", "principal_inspections", "structural_assessments", "other_regular_maintenance"],
};

function DataSource() {
  const { st, run, setSt, toast, caps } = useApp();
  const ref = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const load = async (files: FileList | File[]) => {
    const fs = [...files];
    if (!fs.length) return;
    const before = st.run?.run_id ?? null;
    const r: any = await run(`Reading ${fs.map((f) => f.name).join(", ")}`, async () => {
      if (fs.length === 1 && /\.(xlsm|xlsx|xls)$/i.test(fs[0].name)) return call("importFile", await fs[0].arrayBuffer(), fs[0].name);
      if (fs.every((f) => /\.csv$/i.test(f.name))) return call("importCsvs", await Promise.all(fs.map(async (f) => ({ name: f.name, text: await f.text() }))));
      throw new Error("Upload one SAVI .xlsm/.xlsx workbook, or CSV files (structures.csv and elements.csv, optionally planned.csv and routine.csv).");
    });
    if (!r) return;
    if (!r.validation.valid) { setSt(r); toast(`Loaded with ${r.validation.errors} blocking errors - see the validation report.`); }
    else { await call("verify").catch(() => null); setSt(await call("state")); toast(`Loaded ${n0(r.inventory.structures)} structures and ${n0(r.inventory.elements)} elements in ${(r.load_ms / 1000).toFixed(1)} s.`); }
    await record({ action: "Inventory loaded", target: r.inventory?.name ?? "upload", detail: `${r.validation.errors} errors, ${r.validation.warnings} warnings`, run_before: before, run_after: r.run?.run_id ?? null, source: "person" });
  };
  return (
    <div className="card">
      <header><h2>Data source</h2><span className={`badge ${st.source === "sample" ? "info" : "ok"}`}>{({ sample: "Sample data", upload: "Your upload", manual: "Entered by hand", edited: "Sample, edited" } as Record<string, string>)[st.source] ?? "Your data"}</span></header>
      <div className="stack">
        <p className="small"><b>{st.inventory?.name}</b>{st.inventory?.organisation ? ` · ${st.inventory.organisation}` : ""} · {st.inventory?.authority_type} · input hash <span className="mono">{st.inventory?.hash}</span></p>
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); load(e.dataTransfer.files); }}
          className="note" style={{ borderStyle: drag ? "dashed" : "solid", textAlign: "center", padding: 18 }}>
          <p className="small">Drop a <b>SAVI v1.10 workbook</b> (.xlsm) or <b>CSV files</b> here, or</p>
          <div className="row tight" style={{ justifyContent: "center", marginTop: 8 }}>
            <button className="btn primary" onClick={() => ref.current?.click()}>Choose files</button>
            {st.source !== "sample" && <button className="btn" onClick={async () => { const r = await run("Loading the sample", () => call("loadSample")); if (r) setSt(await call("state")); }}>Reload Hertfordshire sample</button>}
          </div>
          <input ref={ref} type="file" multiple accept=".xlsm,.xlsx,.csv" hidden onChange={(e) => e.target.files && load(e.target.files)} />
        </div>
        <p className="tiny muted">Files are read in this browser only; nothing is uploaded to a server. A workbook in SAVI's layout is read from its Structures, Elements, Planned, Routine and Main Page sheets.</p>
        <div className="row tight"><span className="tiny muted">CSV templates:</span>{Object.entries(TEMPLATES).map(([f, cols]) => <button key={f} className="btn sm ghost" onClick={async () => { const e = await saveFile(caps, f, cols.join(",") + "\n"); if (e) toast(e); }}>{f}</button>)}</div>
      </div>
    </div>
  );
}

function ValidationReport() {
  const { st, caps, toast } = useApp();
  const v = st.validation;
  const [f, setF] = useState<string>("");
  if (!v) return null;
  const rules = Object.entries(v.byRule as Record<string, number>).sort();
  const issues = v.issues.filter((i: any) => !f || `${i.severity}:${i.rule}` === f);
  return (
    <div className="card">
      <header><h2>Validation</h2><span className={`badge ${v.valid ? "ok" : "bad"}`}>{v.valid ? "Valid - runs allowed" : `${v.errors} blocking errors`}</span></header>
      <p className="small muted" style={{ marginBottom: 10 }}>The same checks SAVI's input sheets apply (structure types, dimensions, routes, element/material combinations, condition codes), plus warnings for things SAVI tolerates. QA family 1.</p>
      <div className="row tight" style={{ marginBottom: 10 }}>
        <button className={`btn sm ${!f ? "on" : ""}`} onClick={() => setF("")}>All ({v.errors + v.warnings})</button>
        {rules.map(([k, n]) => <button key={k} className={`btn sm ${f === k ? "on" : ""}`} onClick={() => setF(k)}><i className="dot" style={{ background: k.startsWith("error") ? "var(--bad)" : "var(--accent)" }} /> {k.split(":")[1]} ({n0(n)})</button>)}
        <button className="btn sm ghost" onClick={async () => { const all = await call("validationIssues"); const e = await saveFile(caps, "validation-report.csv", toCsv(all)); if (e) toast(e); }}>Export all</button>
      </div>
      <div className="tablewrap" style={{ maxHeight: 280, overflowY: "auto" }}>
        <table><thead><tr><th>Severity</th><th>Table</th><th className="r">Row</th><th>Record</th><th>Field</th><th>Rule</th><th>Message</th></tr></thead>
          <tbody>{issues.slice(0, 200).map((i: any, k: number) => <tr key={k}><td><span className={`badge ${i.severity === "error" ? "bad" : "warn"}`}>{i.severity}</span></td><td>{i.table}</td><td className="r">{i.row >= 0 ? i.row + 1 : ""}</td><td className="mono">{i.record_id}</td><td className="mono">{i.field}</td><td className="mono">{i.rule}</td><td className="wrap">{i.message}</td></tr>)}
            {!issues.length && <tr><td colSpan={7} className="empty">No issues.</td></tr>}</tbody></table>
      </div>
      {issues.length > 200 && <p className="tiny muted" style={{ marginTop: 6 }}>Showing 200 of {n0(issues.length)}; export for the full list.</p>}
    </div>
  );
}

function Explorer() {
  const { st, openStructure } = useApp();
  const [text, setText] = useState(""), [group, setGroup] = useState(""), [only, setOnly] = useState(""), [sort, setSort] = useState("rank"), [desc, setDesc] = useState(false), [page, setPage] = useState(0);
  const [res, setRes] = useState<any>(null);
  useEffect(() => { const t = setTimeout(() => call("structures", { text, group, only, sort, desc, limit: 50, offset: page * 50 }).then(setRes).catch(() => setRes(null)), 120); return () => clearTimeout(t); }, [text, group, only, sort, desc, page, st.run?.run_id]);
  const th = (k: string, label: string, r = false) => <th className={r ? "r" : ""}><button onClick={() => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(["grc", "priority", "scheme_cost"].includes(k)); } setPage(0); }}>{label}{sort === k ? (desc ? " ↓" : " ↑") : ""}</button></th>;
  return (
    <div className="card">
      <header><h2>Structures</h2><span className="muted small">{res ? `${n0(res.total)} match` : ""}</span></header>
      <div className="row tight" style={{ marginBottom: 10 }}>
        <input type="search" placeholder="Search id, name or type" value={text} onChange={(e) => { setText(e.target.value); setPage(0); }} style={{ flex: "1 1 200px" }} aria-label="Search structures" />
        <select value={group} onChange={(e) => { setGroup(e.target.value); setPage(0); }} aria-label="Asset group"><option value="">All groups</option>{GROUPS.map((g) => <option key={g}>{g}</option>)}</select>
        <select value={only} onChange={(e) => { setOnly(e.target.value); setPage(0); }} aria-label="Filter"><option value="">Any status</option><option value="programme">In 5-year programme</option><option value="unfunded">Needed, not funded</option><option value="at_risk">At traffic risk now</option><option value="not_good_repair">Not in good repair</option><option value="decided">With a decision</option></select>
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr>{th("structure_id", "Id")}<th>Name</th>{th("structure_type", "Type")}{th("sci_av", "SCIav", true)}{th("sci_crit", "SCIcrit", true)}{th("grc", "GRC", true)}{th("rank", "Rank", true)}<th>Programme</th><th>Risk</th></tr></thead>
          <tbody>
            {res?.rows.map((r: any) => (
              <tr key={r.structure_id} className="click" onClick={() => openStructure(r.structure_id)}>
                <td className="mono">{r.structure_id}</td><td>{r.name}</td><td className="muted">{r.structure_type}</td>
                <td className="r"><Sci v={r.sci_av} /></td><td className="r"><Sci v={r.sci_crit} /></td><td className="r">{gbp(r.grc)}</td><td className="r">{r.rank ?? ""}</td>
                <td>{r.in_programme ? <span className={`badge ${r.programme_action === "Replace" ? "warn" : "info"}`}>Yr {r.programme_year} · {r.programme_action}</span> : r.rank ? <span className="badge">unfunded</span> : ""}{r.decision && <span className="badge" style={{ marginLeft: 4 }}>{r.decision}</span>}</td>
                <td>{r.at_risk_y0 ? <span className="badge bad">traffic</span> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {res && res.total > 50 && (
        <div className="row tight" style={{ marginTop: 8, justifyContent: "flex-end" }}>
          <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="small muted">{page * 50 + 1}–{Math.min(res.total, (page + 1) * 50)} of {n0(res.total)}</span>
          <button className="btn sm" disabled={(page + 1) * 50 >= res.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

export function Inventory() {
  const { st } = useApp();
  const c = st.condition_y0;
  return (
    <div className="stack lg">
      <div className="grid g-main">
        <ValidationReport />
        <DataSource />
      </div>
      {st.run && (
        <>
          <div className="card">
            <header><h2>Condition today by asset group</h2><span className="muted small">Weighted by key dimension (SAMPT Part A)</span></header>
            <div className="grid g-main">
              <div className="tablewrap">
                <table><thead><tr><th>Group</th><th className="r">Structures</th><th className="r">SSCIav</th><th className="r">SSCIcrit</th><th className="r">Good repair</th></tr></thead>
                  <tbody>
                    {GROUPS.filter((g) => g !== "Other").map((g) => { const r = c.ssci_table[g]; const n = Object.entries(st.valuation.by_avf_group).find(([k]) => ({ AVF_Bridge: "Bridges", AVF_RetainingWall: "Retaining Walls", AVF_SmallCulvert: "Culverts", AVF_SignGantry: "Sign/Signal Gantries", AVF_HighMast: "High Mast Lighting", AVF_Tunnel: "Tunnels and Vehicular Underpasses" } as any)[k] === g)?.[1] as any;
                      return <tr key={g}><td>{g}</td><td className="r">{n0(n?.structures)}</td><td className="r">{r.ssci_av ? <Sci v={r.ssci_av} /> : "–"}</td><td className="r">{r.ssci_crit ? <Sci v={r.ssci_crit} /> : "–"}</td><td className="r">{r.ssci_av ? pct(r.sss) : "–"}</td></tr>; })}
                    <tr><td><b>Full stock</b> (AVF-weighted)</td><td className="r"><b>{n0(st.valuation.by_avf_group ? Object.values(st.valuation.by_avf_group).reduce((a: number, x: any) => a + x.structures, 0) : 0)}</b></td><td className="r"><b>{n1(c.ssci_table.Stock.ssci_av)}</b></td><td className="r"><b>{n1(c.ssci_table.Stock.ssci_crit)}</b></td><td className="r"><b>{pct(c.ssci_table.Stock.sss)}</b></td></tr>
                  </tbody></table>
              </div>
              <div className="stack">
                <span className="label">Structures by SCIav band</span>
                <StackBar parts={["Very Good", "Good", "Fair", "Poor", "Very Poor"].map((b) => ({ name: b, value: c.bands[b] ?? 0, color: bandVar(b) }))} />
                <p className="tiny muted">Bands: very good ≥ 90, good ≥ 80, fair ≥ 65, poor ≥ 40. A structure is in a state of good repair when SCIav &gt; 60 and SCIcrit &gt; 45.</p>
              </div>
            </div>
          </div>
          <Explorer />
        </>
      )}
      <Provenance />
    </div>
  );
}
