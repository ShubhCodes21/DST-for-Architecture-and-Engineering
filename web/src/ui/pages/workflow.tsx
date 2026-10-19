import React, { useEffect, useRef, useState } from "react";
import { useApp, Cond, Delta } from "../app";
import { call } from "../api";
import { briefing, Grounding } from "../ai";
import { record } from "../audit";
import { gbp, n1, n2, n0 } from "../format";

let pendingStructure: string | null = null;
export const setWorkflowStructure = (s: string) => { pendingStructure = s; };

type Status = "idle" | "run" | "done" | "err" | "skipped";
interface Step { key: string; title: string; module: string; status: Status; result?: any; error?: string; ms?: number }
const STEPS: Omit<Step, "status">[] = [
  { key: "record", title: "Record the inspection", module: "Inventory & condition" },
  { key: "evaluate", title: "Recalculate condition and risk", module: "Asset evaluation" },
  { key: "programme", title: "Re-prioritise and revise the 5-year programme", module: "Planning engine · 5-year programme" },
  { key: "longterm", title: "Update the long-term forecast", module: "Long-term plan" },
  { key: "note", title: "Prepare the decision note", module: "AI (Claude) · grounded on steps 1–4" },
  { key: "decide", title: "Decide", module: "You · control layer" },
];
const fresh = (): Step[] => STEPS.map((s) => ({ ...s, status: "idle" }));

function BA({ rows }: { rows: [string, any, any, ((v: any) => string)?, boolean?][] }) {
  return (
    <div className="ba">
      <span className="h" /><span className="h">Before</span><span className="h">After</span><span className="h">Change</span>
      {rows.map(([label, b, a, f, goodUp]) => (
        <React.Fragment key={label}>
          <span>{label}</span><span className="num">{f ? f(b) : String(b ?? "–")}</span><span className="num"><b>{f ? f(a) : String(a ?? "–")}</b></span>
          {typeof a === "number" && typeof b === "number" ? <Delta before={b} after={a} fmt={f ?? n1} goodUp={goodUp ?? true} /> : <span className="muted small">{String(b) === String(a) ? "no change" : "changed"}</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

function deterministicNote(ev: any) {
  const e = ev.evaluation, p = ev.programme.structure, l = ev.long_term.totals;
  const enters = !p.funded.before && p.funded.after, leaves = p.funded.before && !p.funded.after;
  return {
    headline: `${ev.structure_id}: SCIav ${n1(e.sci_av.before)} → ${n1(e.sci_av.after)}${enters ? `, enters programme in year ${p.year.after}` : leaves ? ", leaves programme" : ""}`,
    summary: `The new inspection changes ${ev.record.changes.length} element condition(s). ${p.funded.after ? `The structure is funded in year ${p.year.after} (${p.action.after}, ${gbp(p.cost.after)}).` : "The structure is not funded within the 5-year budget."} ${ev.programme.displaced.length ? `${ev.programme.displaced.length} other scheme(s) drop out of the programme.` : "No other scheme drops out."}`,
    impacts: [
      `SCIcrit ${n1(e.sci_crit.before)} → ${n1(e.sci_crit.after)}`,
      `Priority ${n2(p.priority.before)} → ${n2(p.priority.after)} (rank ${p.rank.before ?? "–"} → ${p.rank.after ?? "–"})`,
      `30-year workbank ${gbp(l.workbank_end.before)} → ${gbp(l.workbank_end.after)}`,
    ],
    risks: e.traffic_risk.after && !e.traffic_risk.before ? ["The structure now carries a traffic-restriction risk."] : [],
    recommendation: "approve with review", confidence: "medium", confidence_reason: "Rule-based summary; AI note unavailable in this view.",
  };
}

export function Workflow() {
  const { st, caps, me, setSt, toast, review, setReview, openStructure } = useApp();
  const [sid, setSid] = useState<string>(pendingStructure ?? "");
  const [detail, setDetail] = useState<any>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<Step[]>(fresh());
  const [draft, setDraft] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [reason, setReason] = useState("");
  const [tier, setTier] = useState<"quick" | "default">("default");
  const cancelled = useRef(false), ctl = useRef<AbortController | null>(null), evidence = useRef<any>({});
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => { pendingStructure = null; call("structures", { sort: "structure_id", limit: 2000 }).then((r: any) => setIds(r.rows.map((x: any) => x.structure_id))).catch(() => {}); }, []);
  useEffect(() => { if (!sid) { setDetail(null); return; } call("structure", sid).then(setDetail).catch(() => setDetail(null)); }, [sid, st.run?.run_id]);
  // a review the assistant prepared: steps 1-4 already ran in the engine
  useEffect(() => {
    if (!review) return;
    setSid(review.record.structure_id); setDraft(review.draft_id);
    evidence.current = { structure_id: review.record.structure_id, record: review.record, evaluation: review.evaluation, programme: review.programme, long_term: review.long_term };
    setEdits(Object.fromEntries(review.record.changes.map((c: any) => [String(c.element_seq), c.after])));
    setSteps(fresh().map((s) => ["record", "evaluate", "programme", "longterm"].includes(s.key) ? { ...s, status: "done", result: evidence.current[s.key === "longterm" ? "long_term" : s.key === "evaluate" ? "evaluation" : s.key] } : s));
    setReview(null);
  }, [review]);

  const set = (k: string, patch: Partial<Step>) => setSteps((ss) => ss.map((s) => (s.key === k ? { ...s, ...patch } : s)));
  const runFrom = async (from: string) => {
    cancelled.current = false; setRunning(true);
    let d = draft;
    const order = ["record", "evaluate", "programme", "longterm", "note"];
    try {
      for (const k of order.slice(order.indexOf(from))) {
        if (cancelled.current) break;
        set(k, { status: "run", error: undefined });
        const t0 = performance.now();
        try {
          let r: any;
          if (k === "record") {
            if (d) await call("w1Discard", d).catch(() => {});
            r = await call("w1Record", sid, edits); d = r.draft_id; setDraft(d); evidence.current = { structure_id: r.structure_id, record: r };
          } else if (k === "evaluate") { r = await call("w1Evaluate", d); evidence.current.evaluation = r; }
          else if (k === "programme") { r = await call("w1Programme", d); evidence.current.programme = r; }
          else if (k === "longterm") { r = await call("w1LongTerm", d); evidence.current.long_term = r; }
          else if (k === "note") {
            if (caps.sample) { ctl.current = new AbortController(); r = await briefing(caps.sample, evidence.current, tier, ctl.current.signal); r = { ...r, ai: true }; }
            else r = { note: deterministicNote(evidence.current), ai: false };
          }
          set(k, { status: "done", result: r, ms: performance.now() - t0 });
        } catch (e: any) {
          if (k === "note" && e?.code && e.code !== "cancelled") { set(k, { status: "done", result: { note: deterministicNote(evidence.current), ai: false, fallback: e.code }, ms: performance.now() - t0 }); continue; }
          set(k, { status: e?.code === "cancelled" ? "idle" : "err", error: e?.code === "cancelled" ? undefined : String(e?.message ?? e?.code ?? e) });
          break;
        }
      }
    } finally { setRunning(false); }
  };
  const cancel = () => { cancelled.current = true; ctl.current?.abort(); toast("Workflow cancelled; nothing was changed."); };
  const reset = async () => { if (draft) await call("w1Discard", draft).catch(() => {}); setDraft(null); setSteps(fresh()); setReason(""); };
  const approve = async () => {
    const before = st.run.run_id;
    const r: any = await call("w1Commit", draft, me.name || undefined).catch((e) => { toast(String(e.message ?? e)); return null; });
    if (!r) return;
    setSt(r.state); set("decide", { status: "done", result: { decision: "approved", run: r.run.run_id } });
    const ch = evidence.current.record.changes.map((c: any) => `${c.element_type} ${c.before}→${c.after}`).join("; ");
    const note = steps.find((s) => s.key === "note")?.result?.note;
    await record({ action: "Inspection approved", target: evidence.current.structure_id, detail: `${ch}${reason ? ` · Note: ${reason}` : ""}${note ? ` · AI recommendation: ${note.recommendation}` : ""}`, run_before: before, run_after: r.run.run_id, source: review ? "assistant-prepared" : "person" });
    toast(`Approved. New run ${r.run.run_id}; the plan now uses the new inspection.`);
    setDraft(null);
  };
  const reject = async () => {
    if (!reason.trim()) { toast("Give a reason for rejecting - it goes in the audit log."); return; }
    await call("w1Discard", draft).catch(() => {});
    set("decide", { status: "done", result: { decision: "rejected" } });
    await record({ action: "Inspection rejected", target: evidence.current.structure_id, detail: reason, run_before: st.run.run_id, run_after: st.run.run_id, source: "person" });
    toast("Rejected. The plan is unchanged."); setDraft(null);
  };

  const ready = steps.find((s) => s.key === "note")?.status === "done" && steps.find((s) => s.key === "decide")?.status !== "done";
  const decided = steps.find((s) => s.key === "decide")?.status === "done";
  const editable = !running && !draft;
  return (
    <div className="grid g-main">
      <div className="stack lg">
        <div className="card">
          <header><h2>New inspection</h2><span className="muted small">The engine does every calculation; you approve the outcome.</span></header>
          <div className="stack">
            <label className="field"><span>Structure</span>
              <input type="text" list="sids" value={sid} disabled={!editable} onChange={(e) => { setSid(e.target.value.trim().toUpperCase()); setEdits({}); }} placeholder="e.g. ST423" style={{ maxWidth: 220 }} />
              <datalist id="sids">{ids.slice(0, 2000).map((x) => <option key={x} value={x} />)}</datalist>
            </label>
            {detail && (
              <>
                <p className="small"><b>{detail.name}</b> · {detail.structure_type} · SCIav {n1(detail.sci_av)} · {detail.in_programme ? `in programme year ${detail.programme_year}` : "not in the 5-year programme"} <button className="btn sm ghost" onClick={() => openStructure(detail.structure_id)}>Record</button></p>
                <div className="tablewrap" style={{ maxHeight: 340, overflowY: "auto" }}>
                  <table><thead><tr><th>Element</th><th>Importance</th><th>Current</th><th>New inspection</th></tr></thead>
                    <tbody>{detail.elements.map((e: any) => (
                      <tr key={e.index} className={edits[String(e.element_seq)] ? "sel" : ""}>
                        <td>{e.element_type}<div className="tiny muted">{e.material}</div></td><td>{e.importance}</td><td><Cond code={e.condition} ecs={e.ecs} /></td>
                        <td><select disabled={!editable} value={edits[String(e.element_seq)] ?? ""} onChange={(ev) => setEdits((x) => { const y = { ...x }; if (ev.target.value) y[String(e.element_seq)] = ev.target.value; else delete y[String(e.element_seq)]; return y; })} aria-label={`New condition for ${e.element_type}`}>
                          <option value="">unchanged</option>{detail.condition_codes.map((c: string) => <option key={c} value={c}>{c}</option>)}</select></td>
                      </tr>))}</tbody></table>
                </div>
              </>
            )}
            {sid && !detail && <p className="small muted">No structure {sid} in the inventory.</p>}
            {!sid && <p className="small muted">Pick a structure, then set the condition codes the new inspection found. Try <button className="btn sm ghost mono" onClick={() => setSid("ST1515")}>ST1515</button> (outside the programme) with its primary deck at 5B.</p>}
            <div className="row tight">
              <button className="btn primary" disabled={!detail || !Object.keys(edits).length || running || !!draft} onClick={() => { setSteps(fresh()); runFrom("record"); }}>Run assessment</button>
              {draft && !running && steps.find((s) => s.key === "note")?.status === "idle" && <button className="btn primary" onClick={() => runFrom("note")}>Continue to decision note</button>}
              {running && <button className="btn" onClick={cancel}>Cancel</button>}
              {(draft || decided) && !running && <button className="btn" onClick={reset}>{decided ? "Start another" : "Edit / start over"}</button>}
              {caps.sample && <label className="row tight small muted">Note by <select value={tier} onChange={(e) => setTier(e.target.value as any)} disabled={running}><option value="default">Claude (balanced)</option><option value="quick">Claude (fast)</option></select></label>}
              <span className="tiny muted">{Object.keys(edits).length} element(s) changed</span>
            </div>
          </div>
        </div>
      </div>
      <div className="card">
        <header><h2>Workflow</h2>{draft && <span className="chip">Draft {draft}</span>}</header>
        <div className="steps">
          {steps.map((s, i) => (
            <div key={s.key} className={`step ${s.status}`}>
              <div className="rail"><b>{s.status === "done" ? "✓" : s.status === "err" ? "!" : s.status === "run" ? <span className="spin" /> : i + 1}</b>{i < steps.length - 1 && <i />}</div>
              <div className="body stack" style={{ gap: 6 }}>
                <div className="row spread"><div><h3>{s.title}</h3><span className="tiny muted">{s.module}{s.ms ? ` · ${(s.ms / 1000).toFixed(1)} s` : ""}</span></div>
                  {s.status === "err" && <button className="btn sm" onClick={() => runFrom(s.key)}>Retry</button>}</div>
                {s.error && <div className="note bad small">{s.error}</div>}
                <StepResult step={s} />
                {s.key === "decide" && ready && draft && (
                  <div className="stack">
                    <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Note or reason (required to reject)" aria-label="Decision note" />
                    <div className="row tight">
                      <button className="btn ok" onClick={approve}>Approve and update the plan</button>
                      <button className="btn" onClick={reset}>Edit inspection</button>
                      <button className="btn bad" onClick={reject}>Reject</button>
                    </div>
                    <p className="tiny muted">Approving writes the new condition codes into this session's inventory, re-runs valuation and both plans under a new run id, and logs who approved what.</p>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GroundBadge({ g }: { g?: Grounding }) {
  if (!g) return null;
  return <span className={`badge ${g.untraced ? "bad" : "ok"}`} title={g.figures.filter((f) => f.status === "untraced").map((f) => f.text).join(", ")}>{g.untraced ? `${g.untraced} untraced figure${g.untraced > 1 ? "s" : ""}` : `${g.traced + g.derived}/${g.checked} figures traced`}</span>;
}

function StepResult({ step }: { step: Step }) {
  const r = step.result;
  if (!r || step.status !== "done") return null;
  if (step.key === "record") return (
    <div className="tablewrap"><table><thead><tr><th>Element</th><th>Before</th><th>After</th></tr></thead>
      <tbody>{r.changes.map((c: any) => <tr key={c.element_seq}><td>{c.element_type}</td><td><Cond code={c.before} ecs={c.ecs_before} /></td><td><Cond code={c.after} ecs={c.ecs_after} /></td></tr>)}</tbody></table></div>
  );
  if (step.key === "evaluate") return <BA rows={[["SCIav", r.sci_av.before, r.sci_av.after, n1], ["SCIcrit", r.sci_crit.before, r.sci_crit.after, n1], ["Band", r.band.before, r.band.after], ["Good repair", r.good_repair.before ? "yes" : "no", r.good_repair.after ? "yes" : "no"], ["Traffic risk", r.traffic_risk.before ? "yes" : "no", r.traffic_risk.after ? "yes" : "no"]]} />;
  if (step.key === "programme") {
    const s = r.structure;
    return (
      <div className="stack" style={{ gap: 8 }}>
        <BA rows={[["Priority", s.priority.before, s.priority.after, n2], ["Rank", s.rank.before ?? "–", s.rank.after ?? "–"], ["Funded", s.funded.before ? `yes, yr ${s.year.before}` : "no", s.funded.after ? `yes, yr ${s.year.after}` : "no"], ["Action", s.action.before ?? "–", s.action.after ?? "–"], ["Cost", s.cost.before, s.cost.after, (v: number) => gbp(v), false], ["5-yr SSCIav", r.ssci_av_y5.before, r.ssci_av_y5.after, n1]]} />
        {(r.entered.length > 0 || r.displaced.length > 0) && <p className="small">{r.entered.length ? <>Enters: {r.entered.map((x: any) => <span key={x.structure_id} className="chip" style={{ marginRight: 4 }}>{x.structure_id} yr {x.year}</span>)} </> : null}{r.displaced.length ? <>Drops out: {r.displaced.map((x: any) => <span key={x.structure_id} className="chip" style={{ marginRight: 4 }}>{x.structure_id}</span>)}</> : null}</p>}
        {r.moved.length > 0 && <p className="tiny muted">{r.moved.length} other scheme(s) change year.</p>}
      </div>
    );
  }
  if (step.key === "longterm") { const t = r.totals; return <BA rows={[["Spend over plan", t.expenditure.before, t.expenditure.after, (v: number) => gbp(v), false], ["Workbank at end", t.workbank_end.before, t.workbank_end.after, (v: number) => gbp(v), false], ["SSCIav at end", t.ssci_av_end.before, t.ssci_av_end.after, n1], ["Works years", r.works_years.before.join(", ") || "none", r.works_years.after.join(", ") || "none"]]} />; }
  if (step.key === "note") {
    const n = r.note;
    return (
      <div className="card flat" style={{ padding: 12 }}>
        <div className="row tight" style={{ marginBottom: 6 }}>
          <span className={`badge ${r.ai ? "ai" : ""}`}>{r.ai ? "Written by Claude" : r.fallback ? `Rule-based (AI ${r.fallback})` : "Rule-based (AI off)"}</span>
          <span className={`badge ${n.recommendation === "approve" ? "ok" : n.recommendation?.startsWith("challenge") ? "bad" : "warn"}`}>Recommends: {n.recommendation}</span>
          <span className="badge">Confidence {n.confidence}</span>
          <GroundBadge g={r.grounding} />
        </div>
        <h3>{n.headline}</h3>
        <p className="small" style={{ marginTop: 4 }}>{n.summary}</p>
        {n.impacts?.length > 0 && <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{n.impacts.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>}
        {n.risks?.length > 0 && <p className="small" style={{ marginTop: 6 }}><b>Risks:</b> {n.risks.join(" ")}</p>}
        {n.confidence_reason && <p className="tiny muted" style={{ marginTop: 6 }}>{n.confidence_reason}</p>}
      </div>
    );
  }
  if (step.key === "decide") return <span className={`badge ${r.decision === "approved" ? "ok" : "bad"}`}>{r.decision}{r.run ? ` · run ${r.run}` : ""}</span>;
  return null;
}
