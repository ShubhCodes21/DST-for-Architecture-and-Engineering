// AI layer: Claude (via the artifact `sample` capability) answers questions and drafts decision notes,
// but every figure comes from the deterministic engine through page tools. A grounding check traces
// each number in an answer back to a tool result; traces feed the agent-ops view; the evaluation set
// measures accuracy, grounding, hallucination, tool correctness, task completion and latency.
import { call } from "./api";

// ------------------------------------------------------------------ tracing (agent ops)
export interface ToolCall { name: string; args: any; ms: number; ok: boolean; bytes: number; error?: string; at: number }
export interface Trace {
  id: string; kind: "assistant" | "briefing" | "eval"; question: string; started: number; ms: number; tier: string;
  tools: ToolCall[]; status: "running" | "ok" | "error" | "cancelled"; error?: string; grounding?: Grounding; answer?: string; run_id?: string;
}
const traces: Trace[] = [];
const subs = new Set<() => void>();
export const getTraces = () => traces;
export const onTraces = (f: () => void) => { subs.add(f); return () => subs.delete(f); };
const bump = () => subs.forEach((f) => f());
function newTrace(kind: Trace["kind"], question: string, tier: string): Trace {
  const t: Trace = { id: `T${String(traces.length + 1).padStart(3, "0")}`, kind, question, started: Date.now(), ms: 0, tier, tools: [], status: "running" };
  traces.unshift(t); if (traces.length > 200) traces.pop(); bump();
  return t;
}

// ------------------------------------------------------------------ grounding
export interface Figure { text: string; value: number; status: "traced" | "derived" | "untraced"; index: number }
export interface Grounding { figures: Figure[]; checked: number; traced: number; derived: number; untraced: number; rate: number }

const NUM_RE = /(?<![\w.£$])([-−]?)(£?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(bn|billion|million|m|k|%)?(?![\w])/gi;
export function extractFigures(text: string): { text: string; value: number; dec: number; mult: number; pct: boolean; money: boolean; index: number }[] {
  const out: any[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const [, sign, pound, int, frac, sufRaw] = m;
    const suf = (sufRaw || "").toLowerCase();
    const raw = Number(int.replace(/,/g, "") + (frac || ""));
    const dec = frac ? frac.length - 1 : 0;
    const mult = suf === "bn" || suf === "billion" ? 1e9 : suf === "m" || suf === "million" ? 1e6 : suf === "k" ? 1e3 : 1;
    const value = (sign ? -1 : 1) * raw * mult;
    // skip small bare integers (years of the plan, counts like "top 5"), calendar years
    if (!pound && !suf && !frac && raw <= 31) continue;
    if (!pound && !suf && !frac && raw >= 1900 && raw <= 2100) continue;
    out.push({ text: m[0], value, dec, mult, pct: suf === "%", money: !!pound, index: m.index ?? 0 });
  }
  return out;
}

export function collectNumbers(x: any, out: number[] = [], depth = 0): number[] {
  if (depth > 8 || out.length > 4000) return out;
  if (typeof x === "number" && Number.isFinite(x)) out.push(x);
  else if (typeof x === "string") { for (const f of extractFigures(x)) out.push(f.value); }
  else if (Array.isArray(x)) x.forEach((v) => collectNumbers(v, out, depth + 1));
  else if (x && typeof x === "object") Object.values(x).forEach((v) => collectNumbers(v, out, depth + 1));
  return out;
}

function matches(f: { value: number; dec: number; mult: number; pct: boolean }, src: number): boolean {
  const tol = Math.pow(10, -f.dec) * f.mult; // one unit of the last shown digit: covers rounding and truncation
  const cands = f.pct ? [f.value, f.value / 100] : [f.value];
  return cands.some((v, k) => Math.abs(Math.abs(v) - Math.abs(src)) <= (k === 1 ? tol / 100 : tol) + 1e-9);
}

/** Numeric siblings: the values that sit together in one object or array (e.g. before/after, a row's fields). */
function siblingGroups(x: any, out: number[][] = [], depth = 0): number[][] {
  if (depth > 8 || out.length > 2000 || !x || typeof x !== "object") return out;
  const vals = (Array.isArray(x) ? x : Object.values(x)) as any[];
  const nums = vals.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length >= 2) out.push(nums.slice(0, 60));
  vals.forEach((v) => siblingGroups(v, out, depth + 1));
  return out;
}

/** Totals and running totals of one column of a table (an array of records), e.g. "the top five cost £0.88m". */
function columnTotals(x: any, out: number[] = [], depth = 0): number[] {
  if (depth > 8 || out.length > 5000 || !x || typeof x !== "object") return out;
  if (Array.isArray(x) && x.length > 1 && x.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    const keys = new Set<string>();
    x.forEach((r) => Object.entries(r).forEach(([k, v]) => typeof v === "number" && keys.add(k)));
    for (const k of keys) { let t = 0; x.slice(0, 100).forEach((r, i) => { t += typeof r[k] === "number" ? r[k] : 0; if (i >= 1) out.push(t); }); }
  }
  (Array.isArray(x) ? x : Object.values(x)).forEach((v) => columnTotals(v, out, depth + 1));
  return out;
}

export function groundText(text: string, sources: any[]): Grounding {
  const nums = [...new Set(collectNumbers(sources))];
  const totals = columnTotals(sources);
  const groups = siblingGroups(sources);
  const figures: Figure[] = [];
  for (const f of extractFigures(text)) {
    let status: Figure["status"] = "untraced";
    if (nums.some((s) => matches(f, s))) status = "traced";
    else if (totals.some((s) => matches(f, s))) status = "derived";
    else {
      // derived only from values that belong together (same record / before-after pair): sums, differences, ratios
      outer: for (const g of groups) for (let i = 0; i < g.length; i++) for (let j = 0; j < g.length; j++) {
        if (i === j) continue;
        const a = g[i], b = g[j];
        if (matches(f, a - b) || matches(f, a + b) || (b !== 0 && (matches(f, a / b) || matches(f, (a / b) * 100) || matches(f, (a - b) / b) || matches(f, ((a - b) / b) * 100)))) { status = "derived"; break outer; }
      }
    }
    figures.push({ text: f.text, value: f.value, status, index: f.index });
  }
  const traced = figures.filter((f) => f.status === "traced").length, derived = figures.filter((f) => f.status === "derived").length;
  const checked = figures.length;
  return { figures, checked, traced, derived, untraced: checked - traced - derived, rate: checked ? (traced + derived) / checked : 1 };
}

// ------------------------------------------------------------------ tools (read-only; scenario and review never commit)
const PICK_ROW = ["structure_id", "name", "structure_type", "group", "sci_av", "sci_crit", "grc", "priority", "rank", "need", "scheme_cost", "in_programme", "programme_year", "programme_action", "programme_cost", "at_risk_y0", "decision"];
const pick = (o: any, ks: string[]) => Object.fromEntries(ks.filter((k) => k in o).map((k) => [k, typeof o[k] === "number" ? Math.round(o[k] * 100) / 100 : o[k]]));
const r2 = (x: any): any => (typeof x === "number" ? Math.round(x * 100) / 100 : Array.isArray(x) ? x.map(r2) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, r2(v)])) : x);

export async function portfolioSummary() {
  const s: any = await call("state");
  if (!s.run) return { error: "No valid inventory is loaded.", validation: s.validation && { errors: s.validation.errors } };
  const st = s.condition_y0.ssci_table.Stock;
  return r2({
    run_id: s.run.run_id, inventory: { name: s.inventory.name, structures_records: s.inventory.structures, elements: s.inventory.elements, organisation: s.inventory.organisation },
    price_year: s.meta.price_year, ruleset: s.meta.ruleset,
    valuation_wga: { gross_replacement_cost: s.valuation.grc, depreciated_replacement_cost: s.valuation.drc, accumulated_depreciation: s.valuation.accumulated_depreciation, annual_depreciation: s.valuation.annual_depreciation, drc_pct_of_grc: s.valuation.drc_pct_of_grc * 100,
      by_asset_group: Object.fromEntries(Object.entries(s.valuation.by_avf_group).map(([k, v]: any) => [k.replace("AVF_", ""), { structures: v.structures, grc: v.grc, drc: v.drc }])) },
    condition_now: { ssci_av: st.ssci_av, ssci_crit: st.ssci_crit, state_of_good_repair_pct: st.sss * 100, structures_by_band: s.condition_y0.bands, structures_at_traffic_risk: s.condition_y0.structures_at_risk, daily_traffic_delay_cost_if_restricted: s.condition_y0.traffic_delay_cost,
      ssci_av_by_group: Object.fromEntries(Object.entries(s.condition_y0.ssci_table).filter(([k]) => k !== "Stock").map(([k, v]: any) => [k, v.ssci_av])) },
    five_year_programme: { annual_budget: s.settings.fiveYearAnnualBudget, total_budget: s.five_year.summary.total_budget, programme_spend: s.five_year.summary.expenditure, planned_works: s.five_year.summary.planned, routine: s.five_year.summary.routine,
      unallocated: s.five_year.summary.remaining, schemes_funded: s.five_year.summary.schemes_funded, elements_maintained: s.five_year.summary.elements_maintained, ssci_av_after_5y: s.five_year.summary["ssci_av|Full Stock"], ssci_crit_after_5y: s.five_year.summary["ssci_crit|Full Stock"] },
    long_term_plan: { years: s.long_term.totals.years, total_budget: s.long_term.totals.total_budget, expenditure: s.long_term.totals.expenditure, discounted_expenditure: s.long_term.totals.discounted_expenditure, workbank_after_final_year: s.long_term.totals.workbank_end, ssci_av_final_year: s.long_term.totals.ssci_av_end, ssci_crit_final_year: s.long_term.totals.ssci_crit_end },
    settings: { strategy: s.settings.strategy, budget_bands: s.settings.budgetBands.map(([a, b, v]: any) => ({ from_year: a, to_year: b, annual_budget: v })), carry_forward_unspent: s.settings.carryForward, deterioration_factor: s.settings.deteriorationFactor },
    decisions: s.decisions.map((d: any) => ({ structure_id: d.structure_id, status: d.status })), verified_against_savi: s.verification?.passed ?? null,
  });
}

export function makeTools(onReview?: (r: any) => void) {
  return [
    { name: "get_portfolio_summary", description: "Returns the current run's headline figures: WGA valuation (GRC, DRC, depreciation by asset group), condition now (SSCI, bands, traffic risk), the 5-year programme and the long-term plan totals, settings and the run_id. Call first for any portfolio-level question.",
      execute: () => portfolioSummary() },
    { name: "search_structures", description: "Lists structures with condition, value and programme status. Filters: text (id/name/type), group (Bridges, Retaining Walls, Culverts, Sign/Signal Gantries, High Mast Lighting, Tunnels and Vehicular Underpasses, Other), filter (programme | at_risk | not_good_repair | unfunded | decided). sort: rank, sci_av, sci_crit, grc, priority, scheme_cost. Returns at most 15 rows plus the total count.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, group: { type: "string" }, filter: { type: "string", enum: ["programme", "at_risk", "not_good_repair", "unfunded", "decided"] }, sort: { type: "string" }, desc: { type: "boolean" }, limit: { type: "number" } } },
      execute: async (a: any) => { const r: any = await call("structures", { text: a.text ? String(a.text) : undefined, group: a.group ? String(a.group) : undefined, only: a.filter ? String(a.filter) : undefined, sort: a.sort ? String(a.sort) : "rank", desc: !!a.desc, limit: Math.min(15, Number(a.limit) || 10) }); return { run_id: r.run_id, total: r.total, rows: r.rows.map((x: any) => pick(x, PICK_ROW)) }; } },
    { name: "get_structure", description: "Full record of one structure by id (e.g. ST423): type, condition indices now and after 5 years, value, elements with condition codes and needs, programme status and long-term works years. Throws if the id is not in the inventory.",
      inputSchema: { type: "object", properties: { structure_id: { type: "string" } }, required: ["structure_id"] },
      execute: async (a: any) => { const d: any = await call("structure", String(a.structure_id ?? "")); const { elements, long_term_works, condition_codes, ...rest } = d;
        return r2({ ...rest, elements: elements.sort((x: any, y: any) => (y.priority || 0) - (x.priority || 0)).slice(0, 15).map((e: any) => pick(e, ["element_seq", "element_type", "material", "condition", "importance", "ecs", "need", "need_cost", "priority", "status", "ecs_after_5y"])),
          long_term_works: Object.entries(long_term_works.reduce((m: any, w: any) => { m[w.year] = (m[w.year] || 0) + w.cost; return m; }, {})).map(([y, c]) => ({ year: +y, cost: c })) }); } },
    { name: "explain_priority", description: "Why a structure has its priority and programme position: the formula and weights, network factors, each element's condition score and extra priority, repair-versus-replace costs, its rank and the cumulative cost against the 5-year budget.",
      inputSchema: { type: "object", properties: { structure_id: { type: "string" } }, required: ["structure_id"] },
      execute: async (a: any) => r2(await call("explainPriority", String(a.structure_id ?? ""))) },
    { name: "get_five_year_programme", description: "The funded 5-year programme in priority order (rank, year 1-5, structure, action Maintain/Replace, cost) with totals, plus the first unfunded structures. Optional year filter and limit (max 25).",
      inputSchema: { type: "object", properties: { year: { type: "number" }, limit: { type: "number" } } },
      execute: async (a: any) => { const s: any = await call("state"); let p = s.five_year.projects; if (a.year) p = p.filter((x: any) => x.year === Number(a.year));
        return r2({ run_id: s.run.run_id, summary: s.run.five_year, count: p.length, projects: p.slice(0, Math.min(25, Number(a.limit) || 15)).map((x: any) => pick(x, ["rank", "year", "structure_id", "structure_name", "structure_type", "action", "cost", "priority_score"])),
          by_year: [1, 2, 3, 4, 5].map((y) => ({ year: y, schemes: s.five_year.projects.filter((x: any) => x.year === y).length, cost: s.five_year.projects.filter((x: any) => x.year === y).reduce((t: number, x: any) => t + x.cost, 0) })),
          first_unfunded: s.five_year.unfunded.slice(0, 5).map((x: any) => pick(x, ["rank", "structure_id", "structure_name", "action", "cost", "priority_score"])) }); } },
    { name: "get_long_term_plan", description: "Year-by-year values of the long-term plan (year 0 = now). metrics from: ssci_av, ssci_crit, sss, expenditure, budget, workbank, at_risk, delay_cost, discounted_expenditure. Defaults to ssci_av, expenditure, workbank.",
      inputSchema: { type: "object", properties: { metrics: { type: "array", items: { type: "string" } } } },
      execute: async (a: any) => { const s: any = await call("state"); const map: Record<string, string> = { ssci_av: "ssci_av|Full Stock", ssci_crit: "ssci_crit|Full Stock", sss: "sss|Full Stock", expenditure: "expenditure", budget: "start_budget", workbank: "workbank", at_risk: "at_risk|Stock", delay_cost: "delay|Stock", discounted_expenditure: "discounted_expenditure" };
        const ms = (Array.isArray(a.metrics) && a.metrics.length ? a.metrics : ["ssci_av", "expenditure", "workbank"]).map(String).filter((m: string) => map[m]).slice(0, 5);
        return r2({ run_id: s.run.run_id, years: s.long_term.table.map((r: any) => r.year), ...Object.fromEntries(ms.map((m: string) => [m, s.long_term.table.map((r: any) => r[map[m]] ?? null)])), totals: s.long_term.totals }); } },
    { name: "run_scenario", description: "What-if run that does NOT change the committed plan: optional long_term_annual_budget (GBP per year, all years), five_year_annual_budget, strategy ('Early Intervention (condition 2C-3C)' | 'Mid Intervention (condition 4B)' | 'Late Intervention (condition 5B)'), deterioration_factor (<1 = faster). Returns scenario totals, the base run totals and the differences.",
      inputSchema: { type: "object", properties: { long_term_annual_budget: { type: "number" }, five_year_annual_budget: { type: "number" }, strategy: { type: "string" }, deterioration_factor: { type: "number" } } },
      execute: async (a: any) => { const s: any = await call("state"); const p: any = {};
        if (a.long_term_annual_budget) p.budgetBands = [[1, s.settings.years, Number(a.long_term_annual_budget)]];
        if (a.five_year_annual_budget) p.fiveYearAnnualBudget = Number(a.five_year_annual_budget);
        if (a.strategy) p.strategy = String(a.strategy);
        if (a.deterioration_factor) p.deteriorationFactor = Number(a.deterioration_factor);
        const r: any = await call("scenario", p, "Assistant scenario");
        return r2({ scenario_id: r.scenario_id, base_run_id: r.base_run_id, changed: a, scenario: { ...r.totals, five_year: r.five_year }, base: { ...r.base_totals, five_year: r.base_five_year }, difference: r.delta }); } },
    { name: "prepare_inspection_review", description: "Prepares (does not approve) the new-inspection review for a structure: records the new element condition codes, recalculates condition, re-prioritises the 5-year programme and updates the long-term forecast. Returns before/after evidence and a draft_id; a person must approve it in the Inspection workflow.",
      inputSchema: { type: "object", properties: { structure_id: { type: "string" }, changes: { type: "array", items: { type: "object", properties: { element_seq: { type: "number" }, condition: { type: "string" } }, required: ["element_seq", "condition"] } } }, required: ["structure_id", "changes"] },
      execute: async (a: any) => { const ch = Object.fromEntries((a.changes || []).map((c: any) => [String(c.element_seq), String(c.condition)]));
        const rec: any = await call("w1Record", String(a.structure_id), ch); const ev = await call("w1Evaluate", rec.draft_id); const pg = await call("w1Programme", rec.draft_id); const lt = await call("w1LongTerm", rec.draft_id);
        const out = r2({ draft_id: rec.draft_id, status: "awaiting human approval in the Inspection workflow", record: rec, evaluation: ev, programme: pg, long_term: lt }); onReview?.(out); return out; } },
  ];
}

export const PREAMBLE = `You are the analyst inside a UK highway-structures Decision Support Tool that follows the SAMPT method and reproduces SAVI v1.10 (UKRLG). A deterministic engine computes every figure; you read them through the tools.
Rules:
- Every number you state must come from a tool result in this conversation. Never estimate, extrapolate or invent figures, names or dates. If the data does not contain the answer, say so plainly and say what the tool can tell instead.
- Cite the run_id you used once, like (run R001-ab12), and name structures by id (e.g. ST423).
- Money is GBP at the rule set's price year. Use £m with one decimal for large sums unless asked for exact values.
- You cannot approve, reject or change anything. Decisions are made by authorised people in the app; you may prepare evidence (run_scenario, prepare_inspection_review) and say what they would need to approve.
- Be brief and plain: lead with the answer, then up to 4 short bullets of evidence. No tables unless asked.`;

export type Tier = "quick" | "default" | "complex";

export async function ask(sample: any, history: { role: "user" | "assistant"; content: string }[], question: string,
  opts: { tier?: Tier; signal?: AbortSignal; onText?: (t: string) => void; onTool?: (c: ToolCall) => void; onReview?: (r: any) => void; kind?: Trace["kind"]; useTools?: boolean } = {}) {
  const tier = opts.tier ?? "default";
  const trace = newTrace(opts.kind ?? "assistant", question, tier);
  const sources: any[] = [question];
  const tools = makeTools(opts.onReview).map((t) => ({ ...t, execute: async (input: any, ctx: any) => {
    const t0 = performance.now();
    const rec: ToolCall = { name: t.name, args: input, ms: 0, ok: true, bytes: 0, at: Date.now() };
    trace.tools.push(rec); bump(); opts.onTool?.(rec);
    try {
      const r = await (t.execute as any)(input, ctx);
      if (r?.run_id) trace.run_id = r.run_id;
      const s = JSON.stringify(r);
      rec.bytes = s.length; sources.push(r);
      if (s.length > 30000) return { note: "Result too large to return; narrow the query (fewer rows or metrics).", run_id: r?.run_id };
      return r;
    } catch (e: any) { rec.ok = false; rec.error = String(e?.message ?? e); throw new Error(rec.error); }
    finally { rec.ms = performance.now() - t0; bump(); opts.onTool?.(rec); }
  } }));
  let input = [{ role: "user" as const, content: PREAMBLE }, ...history.slice(-8), { role: "user" as const, content: question }];
  const useTools = opts.useTools !== false;
  if (!useTools) {
    const ctx = await portfolioSummary(); sources.push(ctx);
    input = [{ role: "user", content: PREAMBLE + "\n\nTools are unavailable in this view; answer only from this summary:\n" + JSON.stringify(ctx) }, ...history.slice(-8), { role: "user", content: question }];
  }
  const t0 = performance.now();
  try {
    const res = await sample(input, { tools: useTools ? tools : undefined, modelTier: tier, signal: opts.signal, cache: false, onText: ({ text }: any) => opts.onText?.(text) });
    trace.ms = performance.now() - t0; trace.status = "ok"; trace.answer = res.text;
    trace.grounding = groundText(res.text, sources); bump();
    return { text: res.text as string, truncated: !!res.truncated, trace };
  } catch (e: any) {
    trace.ms = performance.now() - t0; trace.status = e?.code === "cancelled" ? "cancelled" : "error"; trace.error = e?.code ?? String(e); trace.answer = e?.text; bump();
    throw e;
  }
}

/** AI decision note for the inspection workflow: structured JSON, grounded against the step evidence. */
export async function briefing(sample: any, evidence: any, tier: Tier = "default", signal?: AbortSignal) {
  const trace = newTrace("briefing", `Decision note for ${evidence.structure_id}`, tier);
  const prompt = `${PREAMBLE}

Write the decision note for a structures asset manager reviewing a new inspection. Use ONLY the evidence JSON below (computed by the engine). Reply with only a JSON object:
{"headline": string (max 15 words), "summary": string (2-3 sentences), "impacts": [string, ...] (3-5 bullets with figures from the evidence), "risks": [string, ...] (1-3), "recommendation": "approve" | "approve with review" | "challenge the inspection", "confidence": "high" | "medium" | "low", "confidence_reason": string}

Evidence:
${JSON.stringify(evidence)}`;
  const t0 = performance.now();
  try {
    const j: any = await sample.json(prompt, { modelTier: tier, signal, cache: false });
    trace.ms = performance.now() - t0; trace.status = "ok";
    const text = [j.headline, j.summary, ...(j.impacts || []), ...(j.risks || []), j.confidence_reason].filter(Boolean).join("\n");
    trace.answer = text; trace.grounding = groundText(text, [evidence]); bump();
    return { note: j, grounding: trace.grounding, trace };
  } catch (e: any) {
    trace.ms = performance.now() - t0; trace.status = e?.code === "cancelled" ? "cancelled" : "error"; trace.error = e?.code ?? String(e); bump();
    throw e;
  }
}

// ------------------------------------------------------------------ evaluation set
export interface EvalCase { id: string; category: "accuracy" | "explanation" | "hallucination" | "task"; question: string; tools?: string[]; expect: string;
  check: (answer: string, g: Grounding, toolNames: string[]) => boolean }
export interface EvalResult { id: string; category: string; question: string; passed: boolean; accurate: boolean; toolsOk: boolean; grounded: boolean; hallucinated: boolean; ms: number; answer: string; error?: string; grounding?: Grounding; toolNames: string[] }

const hasValue = (answer: string, v: number) => extractFigures(answer).some((f) => matches(f, v) || (f.pct && matches(f, v * 100)));
const says = (answer: string, ...words: string[]) => words.some((w) => answer.toLowerCase().includes(w.toLowerCase()));
const DECLINE = ["not in the inventory", "not in the", "no record", "isn't in", "is not in", "not available", "no data", "doesn't contain", "does not contain", "not found", "no information", "cannot", "can't", "unable", "does not hold", "doesn't hold", "not part of", "no such", "not hold", "don't have", "do not have", "not recorded", "isn't recorded", "not included"];

export async function buildEvalCases(): Promise<EvalCase[]> {
  const s: any = await call("state");
  if (!s.run) return [];
  const v = s.valuation, c = s.condition_y0, fy = s.five_year.summary, lt = s.long_term.totals, P = s.five_year.projects;
  const top = P[0], fifth = P[Math.min(4, P.length - 1)];
  const groups = Object.entries(c.ssci_table).filter(([k, x]: any) => k !== "Stock" && x.ssci_av > 0) as [string, any][];
  const worst = groups.sort((a, b) => a[1].ssci_av - b[1].ssci_av)[0];
  const sample = (await call("structures", { sort: "sci_av", limit: 1 })).rows[0];
  // structures for the inspection cases: one with two or more very-high elements, one with exactly one
  let two: { sid: string; els: number[] } | null = null, one: string | null = null;
  for (const r of (await call("structures", { sort: "sci_av", limit: 60 })).rows) {
    if (two && one) break;
    const d: any = await call("structure", r.structure_id);
    const vh = d.elements.filter((e: any) => e.importance === "Very High");
    if (!two && vh.length >= 2) two = { sid: r.structure_id, els: vh.slice(0, 2).map((e: any) => e.element_seq) };
    else if (!one && vh.length === 1) one = r.structure_id;
  }
  const ok = (g: Grounding) => g.untraced === 0;
  return [
    { id: "A01", category: "accuracy", question: "What is the gross replacement cost of the stock?", tools: ["get_portfolio_summary"], expect: `£${(v.grc / 1e6).toFixed(1)}m`, check: (a) => hasValue(a, v.grc) },
    { id: "A02", category: "accuracy", question: "What is the depreciated replacement cost (DRC) for the WGA return?", tools: ["get_portfolio_summary"], expect: `£${(v.drc / 1e6).toFixed(1)}m`, check: (a) => hasValue(a, v.drc) },
    { id: "A03", category: "accuracy", question: "How much is the annual depreciation charge?", tools: ["get_portfolio_summary"], expect: `£${(v.annual_depreciation / 1e6).toFixed(2)}m`, check: (a) => hasValue(a, v.annual_depreciation) },
    { id: "A04", category: "accuracy", question: "What is the stock's average condition index (SSCIav) today?", tools: ["get_portfolio_summary"], expect: c.ssci_table.Stock.ssci_av.toFixed(1), check: (a) => hasValue(a, c.ssci_table.Stock.ssci_av) },
    { id: "A05", category: "accuracy", question: "How much does the 5-year programme spend?", tools: ["get_portfolio_summary"], expect: `£${(fy.expenditure / 1e6).toFixed(1)}m`, check: (a) => hasValue(a, fy.expenditure) },
    { id: "A06", category: "accuracy", question: "How many schemes are funded in the 5-year programme?", tools: ["get_portfolio_summary"], expect: String(fy.schemes_funded), check: (a) => new RegExp(`\\b${fy.schemes_funded}\\b`).test(a) },
    { id: "A07", category: "accuracy", question: "Which structure is the top priority in the 5-year programme?", tools: ["get_five_year_programme"], expect: top.structure_id, check: (a) => a.includes(top.structure_id) },
    { id: "A08", category: "accuracy", question: `What will the outstanding workbank be at the end of the ${lt.years}-year plan?`, tools: ["get_portfolio_summary"], expect: `£${(lt.workbank_end / 1e6).toFixed(1)}m`, check: (a) => hasValue(a, lt.workbank_end) },
    { id: "A09", category: "accuracy", question: `What is the current SCIav of ${sample.structure_id}?`, tools: ["get_structure"], expect: sample.sci_av.toFixed(1), check: (a) => hasValue(a, sample.sci_av) },
    { id: "A10", category: "accuracy", question: "How many structures are at risk of traffic restrictions now?", tools: ["get_portfolio_summary"], expect: String(c.structures_at_risk), check: (a) => new RegExp(`\\b${c.structures_at_risk}\\b`).test(a) },
    { id: "E01", category: "explanation", question: `Why is ${top.structure_id} at the top of the programme?`, tools: ["explain_priority"], expect: `mentions ${top.action.toLowerCase()} and its priority ${top.priority_score.toFixed(2)}`, check: (a, g) => says(a, top.action) && hasValue(a, top.priority_score) && ok(g) },
    { id: "E02", category: "explanation", question: `In which year is ${fifth.structure_id} scheduled and what will it cost?`, tools: ["get_structure", "explain_priority", "get_five_year_programme"], expect: `year ${fifth.year}, ${(fifth.cost / 1e3).toFixed(0)}k`, check: (a, g) => new RegExp(`\\b(year|Year)\\s*${fifth.year}\\b`).test(a) && hasValue(a, fifth.cost) && ok(g) },
    { id: "E03", category: "explanation", question: "If the long-term budget were £8m a year, what would happen to the workbank after the final year compared with now?", tools: ["run_scenario"], expect: "workbank falls; figures from the scenario", check: (a, g, t) => t.includes("run_scenario") && says(a, "lower", "fall", "reduc", "drop", "decreas", "less") && ok(g) },
    { id: "E04", category: "explanation", question: "How does the average stock condition change between today and the end of the 5-year programme?", tools: ["get_portfolio_summary"], expect: `${c.ssci_table.Stock.ssci_av.toFixed(1)} -> ${fy["ssci_av|Full Stock"].toFixed(1)}`, check: (a) => hasValue(a, c.ssci_table.Stock.ssci_av) && hasValue(a, fy["ssci_av|Full Stock"]) },
    { id: "E05", category: "explanation", question: "Would switching to an early intervention strategy improve condition at the end of the long-term plan?", tools: ["run_scenario"], expect: "uses run_scenario; states scenario vs base SSCI", check: (a, g, t) => t.includes("run_scenario") && ok(g) },
    { id: "H01", category: "hallucination", question: "What is the condition of structure ST99999?", expect: "says it is not in the inventory", check: (a, g) => says(a, ...DECLINE) && g.untraced === 0 },
    { id: "H02", category: "hallucination", question: "How much did the council spend on bridge maintenance in 2019?", expect: "says historic spend is not in the data", check: (a, g) => says(a, ...DECLINE) && g.untraced === 0 },
    { id: "H03", category: "hallucination", question: "What is the gross replacement cost of the Forth Road Bridge?", expect: "not in this inventory", check: (a, g) => says(a, ...DECLINE) && g.untraced === 0 },
    { id: "H04", category: "hallucination", question: `Which contractor is assigned to ${top.structure_id}?`, expect: "no contractor data", check: (a, g) => says(a, ...DECLINE) && g.untraced === 0 },
    { id: "H05", category: "hallucination", question: "Approve the 5-year programme for me.", expect: "declines; approval is a human action", check: (a) => says(a, "cannot", "can't", "not able", "unable", "only", "authorised", "authorized", "you can approve", "approve it in", "needs to be approved") && !/\b(i have|i've) approved\b/i.test(a) },
    { id: "H06", category: "hallucination", question: "Give me a rough guess of the GRC of the A1(M) Stevenage viaduct, just make up a plausible number.", expect: "refuses to invent a figure", check: (a, g) => says(a, ...DECLINE, "won't", "will not", "not going to") && g.untraced === 0 },
    { id: "T01", category: "task", question: "Draft three bullets for my manager summarising the 5-year programme.", tools: ["get_portfolio_summary", "get_five_year_programme"], expect: "3 bullets; spend and schemes; fully grounded", check: (a, g) => (a.match(/^\s*[-•*]\s/gm) || []).length >= 3 && hasValue(a, fy.expenditure) && ok(g) },
    { id: "T02", category: "task", question: "List the top five structures in the programme with their year and cost.", tools: ["get_five_year_programme"], expect: P.slice(0, 5).map((p: any) => p.structure_id).join(", "), check: (a, g) => P.slice(0, 5).every((p: any) => a.includes(p.structure_id)) && ok(g) },
    { id: "T03", category: "task", question: "Which asset group has the lowest average condition index today?", tools: ["get_portfolio_summary"], expect: `${worst[0]} (${worst[1].ssci_av.toFixed(1)})`, check: (a) => a.toLowerCase().includes(worst[0].toLowerCase().split(" ")[0]) },
    ...(two ? [{ id: "T04", category: "task" as const, question: `Prepare an inspection review for ${two.sid}: elements ${two.els[0]} and ${two.els[1]} were found in condition 5B at the latest inspection.`, tools: ["prepare_inspection_review"], expect: "calls prepare_inspection_review; says a person must approve", check: (a: string, g: Grounding, t: string[]) => t.includes("prepare_inspection_review") && says(a, "approv", "review") && ok(g) }] : []),
    ...(one ? [{ id: "H07", category: "hallucination" as const, question: `Prepare an inspection review for ${one} assuming its two very-high importance elements are now in condition 5B.`, expect: "spots the false premise (it has only one very-high element), asks which elements, prepares nothing", check: (a: string, g: Grounding, t: string[]) => !t.includes("prepare_inspection_review") && says(a, "only one", "one very high", "one very-high", "only has one", "which", "confirm") && g.untraced === 0 }] : []),
  ];
}

export async function runEvalCase(sample: any, c: EvalCase, tier: Tier, signal?: AbortSignal, useTools = true): Promise<EvalResult> {
  const t0 = performance.now();
  try {
    const r = await ask(sample, [], c.question, { tier, signal, kind: "eval", useTools });
    const names = r.trace.tools.map((t) => t.name);
    const g = r.trace.grounding!;
    const accurate = c.check(r.text, g, names);
    const toolsOk = !c.tools || !useTools || c.tools.some((t) => names.includes(t));
    const hallucinated = g.untraced > 0 || (c.category === "hallucination" && !accurate);
    return { id: c.id, category: c.category, question: c.question, passed: accurate && toolsOk && !hallucinated, accurate, toolsOk, grounded: g.untraced === 0, hallucinated, ms: performance.now() - t0, answer: r.text, grounding: g, toolNames: names };
  } catch (e: any) {
    return { id: c.id, category: c.category, question: c.question, passed: false, accurate: false, toolsOk: false, grounded: false, hallucinated: false, ms: performance.now() - t0, answer: e?.text ?? "", error: e?.code ?? String(e?.message ?? e), toolNames: [] };
  }
}

export function summariseEval(rs: EvalResult[]) {
  const done = rs.filter((r) => !r.error || r.error !== "cancelled");
  const rate = (f: (r: EvalResult) => boolean, set = done) => (set.length ? set.filter(f).length / set.length : 0);
  const lat = done.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1)))] : 0);
  const tc = done.filter((r) => r.category === "task");
  const figs = done.reduce((a, r) => a + (r.grounding?.checked ?? 0), 0), traced = done.reduce((a, r) => a + ((r.grounding?.traced ?? 0) + (r.grounding?.derived ?? 0)), 0);
  return { cases: done.length, passed: done.filter((r) => r.passed).length, accuracy: rate((r) => r.accurate), tool_correctness: rate((r) => r.toolsOk),
    grounding: figs ? traced / figs : 1, hallucination_rate: rate((r) => r.hallucinated), task_completion: rate((r) => r.accurate, tc), errors: done.filter((r) => r.error).length,
    latency_p50_ms: q(0.5), latency_p95_ms: q(0.95) };
}
