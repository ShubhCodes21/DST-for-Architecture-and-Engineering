// Data entry: add and edit structures, elements, planned works, routine costs and weights record by record,
// the way a user types into SAVI's blank workbook. Every record is checked against the same rules before it is saved.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApp, Cond } from "../app";
import { call, saveFile } from "../api";
import { record } from "../audit";
import { gbp, n0, toCsv } from "../format";

type Row = Record<string, any>;
interface Issue { field: string; rule: string; message: string; severity: string }

const S_FIELDS: { k: string; label: string; kind: "text" | "num" | "flag" | "pick"; list?: string; help?: string }[] = [
  { k: "structure_id", label: "Structure id", kind: "text", help: "Unique, e.g. ST1600" },
  { k: "name", label: "Name", kind: "text" },
  { k: "reference", label: "Reference", kind: "text" },
  { k: "structure_type", label: "Structure type", kind: "pick", list: "structure_types" },
  { k: "number_in_group", label: "Number in group", kind: "num" },
  { k: "length_m", label: "Length (m)", kind: "num" },
  { k: "width_m", label: "Average width (m)", kind: "num" },
  { k: "headroom_m", label: "Headroom / height (m)", kind: "num" },
  { k: "spans", label: "Number of spans", kind: "num" },
  { k: "location", label: "Location", kind: "pick", list: "locations" },
  { k: "route_supported", label: "Route supported", kind: "pick", list: "routes" },
  { k: "route_salted", label: "Route salted", kind: "flag" },
  { k: "traffic", label: "Traffic", kind: "pick", list: "traffic" },
  { k: "obstacle_crossed", label: "Obstacle crossed", kind: "pick", list: "obstacles" },
  { k: "obstacle_salted", label: "Obstacle salted", kind: "flag" },
];
const PF = ["pf_heritage", "pf_2", "pf_3", "pf_4", "pf_5", "pf_6"];
const PF_LABEL: Record<string, string> = { pf_heritage: "Heritage", pf_2: "Factor 2", pf_3: "Factor 3", pf_4: "Factor 4", pf_5: "Factor 5", pf_6: "Factor 6" };
const ROUTINE = ["routine_maintenance", "general_inspections", "principal_inspections", "structural_assessments", "other_regular_maintenance"];
const ROUTINE_LABEL: Record<string, string> = { routine_maintenance: "Routine maintenance", general_inspections: "General inspections", principal_inspections: "Principal inspections", structural_assessments: "Structural assessments", other_regular_maintenance: "Other regular" };
const EMPTY_S: Row = { number_in_group: 1, route_salted: 0, obstacle_salted: 0 };

/** SAVI ignores letter case in its lookups; the forms do too, and save the official spelling. */
const canon = (list: string[] | undefined, v: any) => (v == null ? v : list?.find((o) => o.toLowerCase() === String(v).toLowerCase()) ?? v);
const ciGet = (m: Record<string, string[]>, k: any) => (k == null ? undefined : m[canon(Object.keys(m), k)]);
const S_PICKS = ["structure_type", "location", "route_supported", "traffic", "obstacle_crossed"];
const S_LIST: Record<string, string> = { structure_type: "structure_types", location: "locations", route_supported: "routes", traffic: "traffic", obstacle_crossed: "obstacles" };
const canonStructure = (L: any, r: Row) => { const o = { ...r }; for (const k of S_PICKS) o[k] = canon(L[S_LIST[k]], o[k]); return o; };
const canonElement = (L: any, stype: string, r: Row) => {
  const o = { ...r };
  o.element_type = canon(ciGet(L.elements_for, stype), o.element_type);
  o.material = canon(ciGet(L.materials_for, o.element_type), o.material);
  o.spray_proximity = canon(L.spray, o.spray_proximity);
  o.condition_code = canon(L.condition_codes, o.condition_code);
  return o;
};

function useLookups() {
  const { st } = useApp();
  const [L, setL] = useState<any>(null);
  useEffect(() => { call("lookups").then(setL); }, [st.inventory?.hash]);
  return L;
}

function Issues({ issues, field }: { issues: Issue[]; field?: string }) {
  const list = field ? issues.filter((i) => i.field === field || (field.startsWith("adj") && i.field === "adj_*")) : issues;
  if (!list.length) return null;
  return <>{list.map((i, k) => <span key={k} className={`tiny`} style={{ color: i.severity === "error" ? "var(--bad)" : "var(--accent)" }}>{i.message}</span>)}</>;
}

function Field({ f, row, set, L, issues }: { f: typeof S_FIELDS[number]; row: Row; set: (k: string, v: any) => void; L: any; issues: Issue[] }) {
  const bad = issues.some((i) => i.field === f.k && i.severity === "error");
  const style = bad ? { borderColor: "var(--bad)" } : undefined;
  return (
    <label className="field">
      <span>{f.label}</span>
      {f.kind === "pick" ? (
        <select value={row[f.k] ?? ""} onChange={(e) => set(f.k, e.target.value || null)} style={style} aria-label={f.label}>
          <option value="">Choose…</option>{(L[f.list!] as string[]).map((o) => <option key={o} value={o}>{o}</option>)}
          {row[f.k] && !(L[f.list!] as string[]).includes(row[f.k]) && <option value={row[f.k]}>{row[f.k]} (as entered)</option>}
        </select>
      ) : f.kind === "flag" ? (
        <select value={String(row[f.k] ?? 0)} onChange={(e) => set(f.k, Number(e.target.value))} aria-label={f.label}><option value="0">No</option><option value="1">Yes</option></select>
      ) : (
        <input type={f.kind === "num" ? "number" : "text"} step="any" value={row[f.k] ?? ""} placeholder={f.help} style={style} aria-label={f.label}
          onChange={(e) => set(f.k, f.kind === "num" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)} />
      )}
      <Issues issues={issues} field={f.k} />
    </label>
  );
}

function StructureForm({ L, original, initial, onSaved, onDeleted, onCancel }: { L: any; original: string | null; initial: Row; onSaved: (id: string) => void; onDeleted: () => void; onCancel: () => void }) {
  const { run, setSt, toast, st } = useApp();
  const [row, setRow] = useState<Row>(initial);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { setRow(canonStructure(L, initial)); setIssues([]); setConfirmDel(false); }, [original, initial]);
  const set = (k: string, v: any) => setRow((r) => ({ ...r, [k]: v }));
  useEffect(() => { const t = setTimeout(() => { if (row.structure_id) call("checkRecord", "structures", row, original).then(setIssues).catch(() => {}); }, 250); return () => clearTimeout(t); }, [row]);
  const errors = issues.filter((i) => i.severity === "error");
  const save = async () => {
    const before = st.run?.run_id ?? null;
    const r: any = await run(original ? "Saving structure and re-running" : "Adding structure", () => call("saveStructure", row, original));
    if (!r) return;
    if (!r.saved) { setIssues(r.issues); toast("Not saved: fix the highlighted fields."); return; }
    setSt(r.state); toast(`${row.structure_id} saved.${r.state.validation.valid ? "" : " Add its elements before plans can run."}`);
    await record({ action: original ? "Structure edited" : "Structure added", target: String(row.structure_id), detail: `${row.structure_type ?? ""}${original && original !== row.structure_id ? ` (was ${original})` : ""}`, run_before: before, run_after: r.state.run?.run_id ?? null, source: "person" });
    onSaved(String(row.structure_id));
  };
  const del = async () => {
    const before = st.run?.run_id ?? null;
    const r: any = await run("Deleting structure", () => call("deleteStructure", original));
    if (!r) return;
    setSt(r.state); toast(`${original} and its elements deleted.`);
    await record({ action: "Structure deleted", target: String(original), detail: "with its elements and planned works", run_before: before, run_after: r.state.run?.run_id ?? null, source: "person" });
    onDeleted();
  };
  return (
    <div className="card">
      <header><h2>{original ? <>Structure <span className="mono">{original}</span></> : "New structure"}</h2>
        <span className={`badge ${errors.length ? "bad" : row.structure_id ? "ok" : ""}`}>{errors.length ? `${errors.length} problem${errors.length > 1 ? "s" : ""}` : row.structure_id ? "Passes the input checks" : "Fill in the fields"}</span></header>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="stack">
        <div className="grid g3">{S_FIELDS.map((f) => <Field key={f.k} f={f} row={row} set={set} L={L} issues={issues} />)}</div>
        <details>
          <summary className="small">Priority factors and GRC adjustment flags</summary>
          <div className="grid g3" style={{ marginTop: 10 }}>
            {PF.map((k) => <label key={k} className="field"><span>Priority: {PF_LABEL[k]}</span><input type="number" step="any" value={row[k] ?? ""} onChange={(e) => set(k, e.target.value === "" ? null : Number(e.target.value))} aria-label={`Structure priority ${PF_LABEL[k]}`} /></label>)}
            {L.adjustment_flags.map((a: any) => <label key={a.column} className="field"><span>{a.label} (×{a.factor})</span><select value={String(row[a.column] ?? "")} onChange={(e) => set(a.column, e.target.value === "" ? null : Number(e.target.value))} aria-label={a.label}><option value="">Blank</option><option value="0">No</option><option value="1">Yes</option></select></label>)}
          </div>
          <Issues issues={issues} field="adj_*" />
        </details>
        <div className="row tight">
          <button className="btn primary" type="submit" disabled={!row.structure_id || errors.length > 0}>{original ? "Save changes" : "Add structure"}</button>
          <button className="btn" type="button" onClick={onCancel}>Cancel</button>
          {original && (confirmDel
            ? <><span className="small">Delete {original}, its elements and planned works?</span><button className="btn bad" type="button" onClick={del}>Yes, delete</button><button className="btn ghost" type="button" onClick={() => setConfirmDel(false)}>Keep</button></>
            : <button className="btn bad" type="button" onClick={() => setConfirmDel(true)}>Delete structure</button>)}
        </div>
      </form>
    </div>
  );
}

function ElementEditor({ L, sid, stype, elements, onChanged }: { L: any; sid: string; stype: string; elements: Row[]; onChanged: () => void }) {
  const { run, setSt, toast, st } = useApp();
  const blank = (): Row => ({ structure_id: sid, element_type: null, material: null, condition_code: "1A", spray_proximity: L.spray[1] ?? null, intervention_threshold: null });
  const [edit, setEdit] = useState<{ original: any; row: Row } | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const allowedEls: string[] = ciGet(L.elements_for, stype) ?? [];
  const mats: string[] = edit?.row.element_type ? ciGet(L.materials_for, edit.row.element_type) ?? [] : [];
  const used = new Set(elements.map((e) => e.element_type));
  useEffect(() => { if (!edit) return; const t = setTimeout(() => { if (edit.row.element_type) call("checkRecord", "elements", edit.row, edit.original).then(setIssues).catch(() => {}); }, 250); return () => clearTimeout(t); }, [edit]);
  const set = (k: string, v: any) => setEdit((e) => e && ({ ...e, row: { ...e.row, [k]: v, ...(k === "element_type" ? { material: null } : {}) } }));
  const save = async () => {
    if (!edit) return;
    const before = st.run?.run_id ?? null;
    const r: any = await run("Saving element and re-running", () => call("saveElement", edit.row, edit.original));
    if (!r) return;
    if (!r.saved) { setIssues(r.issues); toast("Not saved: fix the highlighted fields."); return; }
    setSt(r.state);
    await record({ action: edit.original != null ? "Element edited" : "Element added", target: `${sid} · ${r.element_seq}`, detail: `${edit.row.element_type} · ${edit.row.material} · ${edit.row.condition_code}`, run_before: before, run_after: r.state.run?.run_id ?? null, source: "person" });
    toast(`Element ${r.element_seq} saved.${r.state.validation.valid ? " Plans re-ran." : ""}`); setEdit(null); setIssues([]); onChanged();
  };
  const del = async (seq: any) => {
    const before = st.run?.run_id ?? null;
    const r: any = await run("Deleting element", () => call("deleteElement", seq));
    if (!r) return;
    setSt(r.state); await record({ action: "Element deleted", target: `${sid} · ${seq}`, detail: "", run_before: before, run_after: r.state.run?.run_id ?? null, source: "person" });
    onChanged();
  };
  const errors = issues.filter((i) => i.severity === "error");
  return (
    <div className="card">
      <header><h2>Elements of <span className="mono">{sid}</span></h2>
        <div className="row tight"><span className="muted small">{elements.length} element{elements.length === 1 ? "" : "s"} · {allowedEls.length} types allowed for this structure type</span>
          <button className="btn sm primary" disabled={!!edit || !stype} onClick={() => { setEdit({ original: null, row: blank() }); setIssues([]); }}>Add element</button></div></header>
      {!stype && <div className="note warn small">Choose and save a structure type first; it decides which elements are allowed.</div>}
      {edit && (
        <form className="card tint stack" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); save(); }}>
          <h3>{edit.original != null ? `Element ${edit.original}` : "New element"}</h3>
          <div className="grid g2">
            <label className="field"><span>Element type</span>
              <select value={edit.row.element_type ?? ""} onChange={(e) => set("element_type", e.target.value || null)} aria-label="Element type">
                <option value="">Choose…</option>{allowedEls.map((o) => <option key={o} value={o}>{o}{used.has(o) && o !== edit.row.element_type ? " (already recorded)" : ""}</option>)}</select>
              <Issues issues={issues} field="element_type" /></label>
            <label className="field"><span>Material</span>
              <select value={edit.row.material ?? ""} onChange={(e) => set("material", e.target.value || null)} disabled={!edit.row.element_type} aria-label="Material">
                <option value="">Choose…</option>{mats.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              <Issues issues={issues} field="material" /></label>
            <label className="field"><span>Condition (severity + extent)</span>
              <select value={edit.row.condition_code ?? ""} onChange={(e) => set("condition_code", e.target.value)} aria-label="Condition">{L.condition_codes.map((c: string) => <option key={c} value={c}>{c}</option>)}</select>
              <span className="tiny muted">For a new inspection that should be approved and logged as such, use the Inspection workflow.</span></label>
            <label className="field"><span>Proximity to traffic spray</span>
              <select value={edit.row.spray_proximity ?? ""} onChange={(e) => set("spray_proximity", e.target.value || null)} aria-label="Spray proximity"><option value="">Choose…</option>{L.spray.map((o: string) => <option key={o} value={o}>{o}</option>)}</select>
              <Issues issues={issues} field="spray_proximity" /></label>
            <label className="field"><span>Intervention strategy (blank = plan default)</span>
              <select value={edit.row.intervention_threshold ?? ""} onChange={(e) => set("intervention_threshold", e.target.value || null)} aria-label="Intervention strategy"><option value="">Plan default</option>{L.strategies.map((o: string) => <option key={o} value={o}>{o}</option>)}</select></label>
            <label className="field"><span>Element number</span><input type="number" value={edit.row.element_seq ?? ""} placeholder="next free number" onChange={(e) => set("element_seq", e.target.value === "" ? null : Number(e.target.value))} aria-label="Element number" /></label>
          </div>
          <details><summary className="small">Element priority factors</summary>
            <div className="grid g3" style={{ marginTop: 8 }}>{PF.map((k) => <label key={k} className="field"><span>{PF_LABEL[k]}</span><input type="number" step="any" value={edit.row[k] ?? ""} onChange={(e) => set(k, e.target.value === "" ? null : Number(e.target.value))} aria-label={`Element priority ${PF_LABEL[k]}`} /></label>)}</div></details>
          <Issues issues={issues.filter((i) => !["element_type", "material", "spray_proximity"].includes(i.field))} />
          <div className="row tight">
            <button className="btn primary" type="submit" disabled={!edit.row.element_type || !edit.row.material || errors.length > 0}>{edit.original != null ? "Save element" : "Add element"}</button>
            <button className="btn" type="button" onClick={() => { setEdit(null); setIssues([]); }}>Cancel</button>
          </div>
        </form>
      )}
      <div className="tablewrap">
        <table>
          <thead><tr><th className="r">No.</th><th>Element</th><th>Material</th><th>Condition</th><th>Importance</th><th>Strategy</th><th /></tr></thead>
          <tbody>
            {elements.map((e) => (
              <tr key={e.element_seq}>
                <td className="r mono">{e.element_seq}</td><td>{e.element_type}</td><td className="muted">{e.material}</td><td><Cond code={e.condition_code} ecs={L.condition_ecs?.[canon(L.condition_codes, e.condition_code)]} /></td><td>{L.importance[canon(Object.keys(L.importance), e.element_type)] ?? ""}</td><td className="tiny">{e.intervention_threshold ?? "default"}</td>
                <td style={{ whiteSpace: "nowrap" }}><span className="row tight" style={{ flexWrap: "nowrap" }}><button className="btn sm" disabled={!!edit} onClick={() => { setEdit({ original: e.element_seq, row: canonElement(L, stype, e) }); setIssues([]); }}>Edit</button><button className="btn sm ghost" disabled={!!edit} onClick={() => del(e.element_seq)} aria-label={`Delete element ${e.element_seq}`}>Delete</button></span></td>
              </tr>
            ))}
            {!elements.length && <tr><td colSpan={7} className="empty">No elements yet. A structure needs at least one element before plans can run.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StructuresTab({ L, tables, reload }: { L: any; tables: any; reload: () => void }) {
  const { openStructure, st } = useApp();
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const S: Row[] = tables.structures, E: Row[] = tables.elements;
  const errs = useMemo(() => new Set((st.validation?.issues ?? []).filter((i: any) => i.severity === "error").map((i: any) => i.table === "structures" ? String(i.record_id).toLowerCase() : "")), [st.validation]);
  const list = S.filter((s) => !q || `${s.structure_id} ${s.name ?? ""} ${s.structure_type ?? ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  const cur = sel ? S.find((s) => String(s.structure_id).toLowerCase() === sel.toLowerCase()) : null;
  const els = cur ? E.filter((e) => String(e.structure_id).toLowerCase() === String(cur.structure_id).toLowerCase()) : [];
  const nextId = useMemo(() => { const n = Math.max(0, ...S.map((s) => Number(String(s.structure_id).replace(/\D/g, "")) || 0)) + 1; return `ST${n}`; }, [S]);
  const initial = useMemo(() => (adding ? { ...EMPTY_S, structure_id: nextId } : cur ? { ...cur } : null), [adding, cur, nextId]);
  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)" }} data-split>
      <div className="card" style={{ alignSelf: "start" }}>
        <header><h2>Structures</h2><button className="btn sm primary" onClick={() => { setAdding(true); setSel(null); }}>Add structure</button></header>
        <input type="search" placeholder="Search id, name or type" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search structures to edit" style={{ width: "100%", marginBottom: 8 }} />
        <div className="tablewrap" style={{ maxHeight: 620, overflowY: "auto" }}>
          <table><tbody>
            {list.map((s) => (
              <tr key={s.structure_id} className={`click ${cur && s.structure_id === cur.structure_id ? "sel" : ""}`} onClick={() => { setSel(String(s.structure_id)); setAdding(false); }}>
                <td><span className="mono">{s.structure_id}</span> {s.name}<div className="tiny muted">{s.structure_type ?? "type missing"} · {E.filter((e) => e.structure_id === s.structure_id).length} el.</div></td>
                <td>{errs.has(String(s.structure_id).toLowerCase()) && <span className="badge bad">!</span>}</td>
              </tr>))}
            {!S.length && <tr><td className="empty">No structures yet. Add the first one.</td></tr>}
          </tbody></table>
        </div>
        {S.length > list.length && <p className="tiny muted" style={{ marginTop: 6 }}>Showing {list.length} of {n0(S.length)}; search to find others.</p>}
      </div>
      <div className="stack lg">
        {initial ? (
          <>
            <StructureForm L={L} original={adding ? null : String(cur!.structure_id)} initial={initial}
              onSaved={(id) => { setAdding(false); setSel(id); reload(); }} onDeleted={() => { setSel(null); reload(); }} onCancel={() => { setAdding(false); setSel(null); }} />
            {!adding && cur && <ElementEditor L={L} sid={String(cur.structure_id)} stype={cur.structure_type ?? ""} elements={els} onChanged={reload} />}
            {!adding && cur && st.run && <div className="row"><button className="btn" onClick={() => openStructure(String(cur.structure_id))}>See its valuation and plan</button></div>}
          </>
        ) : <div className="card empty">Pick a structure to edit, or add a new one. Each record is checked against SAVI's input rules as you type; plans re-run when you save.</div>}
      </div>
    </div>
  );
}

function PlannedTab({ tables, reload }: { tables: any; reload: () => void }) {
  const { run, setSt, toast, st } = useApp();
  const [rows, setRows] = useState<Row[]>(() => tables.planned.map((r: Row) => ({ ...r })));
  useEffect(() => setRows(tables.planned.map((r: Row) => ({ ...r }))), [tables]);
  const codes: string[] = st.meta.condition_codes;
  const set = (i: number, k: string, v: any) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    const r: any = await run("Saving planned works", () => call("savePlanned", rows));
    if (r) { setSt(r.state); toast(`${rows.length} planned work${rows.length === 1 ? "" : "s"} saved.`); await record({ action: "Planned works updated", target: "Planned", detail: `${rows.length} items, ${gbp(rows.reduce((a, x) => a + (Number(x.total_cost) || 0), 0))}`, run_before: null, run_after: r.state.run?.run_id ?? null, source: "person" }); reload(); }
  };
  return (
    <div className="card">
      <header><h2>Planned works</h2><span className="muted small">Committed schemes (SAVI 'Planned' sheet). They replace condition-triggered work on that element in that year.</span></header>
      <div className="tablewrap">
        <table><thead><tr><th>Element no.</th><th>Structure</th><th>Year</th><th>Action</th><th className="r">Total cost (£)</th><th>Condition after</th><th /></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>
              <td><input type="number" value={r.element_seq ?? ""} onChange={(e) => set(i, "element_seq", e.target.value === "" ? null : Number(e.target.value))} style={{ width: 90 }} aria-label="Element number" /></td>
              <td className="mono small">{r.structure_id ?? "–"}</td>
              <td><input type="number" min={1} value={r.year_of_work ?? ""} onChange={(e) => set(i, "year_of_work", Number(e.target.value))} style={{ width: 64 }} aria-label="Year of work" /></td>
              <td><input type="text" value={r.maintenance_action ?? ""} onChange={(e) => set(i, "maintenance_action", e.target.value)} style={{ width: 200 }} aria-label="Action" /></td>
              <td className="r"><input type="number" min={0} value={r.total_cost ?? ""} onChange={(e) => set(i, "total_cost", Number(e.target.value))} style={{ width: 110 }} aria-label="Total cost" /></td>
              <td><select value={r.condition_after ?? "1A"} onChange={(e) => set(i, "condition_after", e.target.value)} aria-label="Condition after">{codes.map((c) => <option key={c}>{c}</option>)}</select></td>
              <td><button className="btn sm ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove planned work">✕</button></td>
            </tr>))}
            {!rows.length && <tr><td colSpan={7} className="empty">No planned works.</td></tr>}</tbody></table>
      </div>
      <div className="row tight" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => setRows([...rows, { element_seq: null, year_of_work: 1, maintenance_action: "", total_cost: 0, condition_after: "1A" }])}>Add planned work</button>
        <button className="btn primary" onClick={save}>Save planned works</button>
      </div>
    </div>
  );
}

function RoutineTab({ tables, reload }: { tables: any; reload: () => void }) {
  const { run, setSt, toast, st } = useApp();
  const years = Math.max(st.settings?.years ?? 30, 30);
  const init = () => { const by = new Map(tables.routine.map((r: Row) => [Number(r.year), r])); return [...Array(years)].map((_, i) => ({ year: i + 1, ...(by.get(i + 1) as Row ?? {}) })); };
  const [rows, setRows] = useState<Row[]>(init);
  useEffect(() => setRows(init()), [tables]);
  const set = (i: number, k: string, v: any) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const fill = () => setRows(rows.map((r) => ({ ...rows[0], year: r.year })));
  const save = async () => {
    const r: any = await run("Saving routine costs", () => call("saveRoutine", rows));
    if (r) { setSt(r.state); toast("Routine costs saved."); await record({ action: "Routine costs updated", target: "Routine", detail: `${rows.length} years`, run_before: null, run_after: r.state.run?.run_id ?? null, source: "person" }); reload(); }
  };
  return (
    <div className="card">
      <header><h2>Routine costs by year (£)</h2><div className="row tight"><button className="btn sm" onClick={fill}>Copy year 1 to all years</button><button className="btn sm primary" onClick={save}>Save routine costs</button></div></header>
      <p className="small muted" style={{ marginBottom: 8 }}>Taken off each year's budget before schemes are funded (SAVI 'Routine' sheet).</p>
      <div className="tablewrap tall">
        <table><thead><tr><th className="r">Year</th>{ROUTINE.map((k) => <th key={k} className="r">{ROUTINE_LABEL[k]}</th>)}<th className="r">Total</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.year}><td className="r">{r.year}</td>
              {ROUTINE.map((k) => <td key={k} className="r"><input type="number" min={0} value={r[k] ?? ""} onChange={(e) => set(i, k, e.target.value === "" ? null : Number(e.target.value))} style={{ width: 110 }} aria-label={`${ROUTINE_LABEL[k]} year ${r.year}`} /></td>)}
              <td className="r">{gbp(ROUTINE.reduce((a, k) => a + (Number(r[k]) || 0), 0))}</td></tr>))}</tbody></table>
      </div>
    </div>
  );
}

function SettingsTab({ L, tables, reload }: { L: any; tables: any; reload: () => void }) {
  const { run, setSt, toast, st } = useApp();
  const [org, setOrg] = useState(tables.settings?.organisation ?? "");
  const [auth, setAuth] = useState(tables.settings?.authority_type ?? "Local Authority");
  const [w, setW] = useState<Row[]>(L.priority_factor_weights.map((r: Row) => ({ ...r })));
  const save = async () => {
    const r: any = await run("Saving settings and re-running", () => call("saveInventorySettings", { organisation: org, authority_type: auth, priority_factor_weights: w }));
    if (r) { setSt(r.state); toast("Settings saved."); await record({ action: "Inventory settings changed", target: "Settings", detail: `${org} · ${auth} · weights ${w.map((x) => x.weight).join("/")}`, run_before: null, run_after: r.state.run?.run_id ?? null, source: "person" }); reload(); }
  };
  return (
    <div className="grid g2">
      <div className="card">
        <header><h2>Organisation</h2></header>
        <div className="stack">
          <label className="field"><span>Organisation</span><input type="text" value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Organisation" /></label>
          <label className="field"><span>Authority type (sets the asset value factors)</span><select value={auth} onChange={(e) => setAuth(e.target.value)} aria-label="Authority type">{L.authority_types.map((a: string) => <option key={a}>{a}</option>)}</select></label>
          <p className="tiny muted">Budgets, strategy and plan length are set on the Long-term plan and 5-year programme pages.</p>
        </div>
      </div>
      <div className="card">
        <header><h2>Priority factor weights</h2><span className="muted small">SAVI Structures!Q3:V3 and Elements!G3:L3</span></header>
        <p className="small muted" style={{ marginBottom: 8 }}>Each structure's or element's priority factor is multiplied by its weight and added to the priority score. The blank SAVI workbook uses 1 for all; the Hertfordshire sample uses 100 for structure heritage.</p>
        <div className="tablewrap"><table><thead><tr><th>Level</th><th>Factor</th><th className="r">Weight</th></tr></thead>
          <tbody>{w.map((r, i) => <tr key={i}><td>{r.level}</td><td>{PF_LABEL[r.column] ?? r.column}</td><td className="r"><input type="number" min={0} step="any" value={r.weight} onChange={(e) => setW(w.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))} style={{ width: 90 }} aria-label={`Weight ${r.level} ${PF_LABEL[r.column] ?? r.column}`} /></td></tr>)}</tbody></table></div>
      </div>
      <div><button className="btn primary" onClick={save}>Save settings</button></div>
    </div>
  );
}

function ExportTab({ tables }: { tables: any }) {
  const { caps, toast } = useApp();
  const files: [string, Row[]][] = [["structures.csv", tables.structures], ["elements.csv", tables.elements], ["planned.csv", tables.planned], ["routine.csv", tables.routine]];
  return (
    <div className="card">
      <header><h2>Export the inventory</h2></header>
      <p className="small" style={{ marginBottom: 10 }}>Save your entries as the four CSV files this page reads back in (Inventory &amp; condition → Choose files). Edits otherwise last only for this browser session.</p>
      <div className="row tight">{files.map(([f, rows]) => <button key={f} className="btn" onClick={async () => { const e = await saveFile(caps, f, toCsv(rows)); if (e) toast(e); }}>{f} ({n0(rows.length)})</button>)}</div>
    </div>
  );
}

export function DataEntry() {
  const { st, run, setSt, toast } = useApp();
  const L = useLookups();
  const [tables, setTables] = useState<any>(null);
  const [tab, setTab] = useState("structures");
  const [confirmBlank, setConfirmBlank] = useState(false);
  const [name, setName] = useState("New inventory");
  const reload = () => call("inventoryTables").then(setTables);
  useEffect(() => { reload(); }, [st.inventory?.hash]);
  if (!L || !tables) return <div className="empty"><span className="spin" /></div>;
  const ecs = Object.fromEntries((st.meta.condition_codes as string[]).map((c, i) => [c, st.meta.condition_ecs[i]]));
  const v = st.validation;
  return (
    <div className="stack lg">
      <div className="hero-strip">
        <span className={`badge ${v?.valid ? "ok" : "bad"}`}>{v?.valid ? "Valid - plans up to date" : `${v?.errors} blocking problem${v?.errors === 1 ? "" : "s"}`}</span>
        <span className="small">Editing <b>{st.inventory?.name}</b>: {n0(tables.structures.length)} structures, {n0(tables.elements.length)} elements.{v?.valid ? " Every save re-runs the valuation and both plans." : " Plans run again once every structure has valid elements."}</span>
        <span style={{ marginLeft: "auto" }} className="row tight">
          {confirmBlank ? (
            <form className="row tight" onSubmit={async (e) => { e.preventDefault(); const r: any = await run("Starting a blank inventory", () => call("newBlank", name)); if (r) { setSt(r); setConfirmBlank(false); toast("Blank inventory started. Add your first structure."); await record({ action: "Blank inventory started", target: name, detail: "replaces the loaded inventory for this session", run_before: null, run_after: null, source: "person" }); } }}>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Inventory name" style={{ width: 170 }} />
              <button className="btn bad" type="submit">Replace current data</button><button className="btn ghost" type="button" onClick={() => setConfirmBlank(false)}>Cancel</button>
            </form>
          ) : <button className="btn" onClick={() => setConfirmBlank(true)}>Start a blank inventory</button>}
        </span>
      </div>
      <div className="tabs" role="tablist">
        {[["structures", "Structures & elements"], ["planned", `Planned works (${tables.planned.length})`], ["routine", "Routine costs"], ["settings", "Settings & weights"], ["export", "Export"]].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "structures" ? <StructuresTab L={{ ...L, condition_ecs: ecs }} tables={tables} reload={reload} /> : tab === "planned" ? <PlannedTab tables={tables} reload={reload} /> :
        tab === "routine" ? <RoutineTab tables={tables} reload={reload} /> : tab === "settings" ? <SettingsTab L={L} tables={tables} reload={reload} /> : <ExportTab tables={tables} />}
    </div>
  );
}
