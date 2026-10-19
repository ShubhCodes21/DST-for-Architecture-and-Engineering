// The engine service: the single source of every number the UI or the AI assistant shows.
// Runs inside a Web Worker; every method returns plain JSON. Deterministic: same inputs -> same run id.
import { Row, key, num, sha256Hex, toRows, Table } from "./core";
import { RuleSet, RuleSetJson } from "./rules";
import { Inventory, runValuation, ValuationResult, AVF_GROUPS } from "./valuation";
import { PlanningModel, PlanSettings, settingsFromInventory, LongTermResult, FiveYearResult, LAMP_COLUMNS, STRATEGY_NAMES, YearOverrides, budgetFor } from "./planning";
import { validateInventory, ValidationReport } from "./validation";
import { readWorkbookFile, readCsv, STRUCTURE_COLUMNS, ELEMENT_COLUMNS } from "./io";
const STRUCT_NUMERIC = ["structure_seq", "number_in_group", "length_m", "width_m", "headroom_m", "spans", "route_salted", "obstacle_salted", "pf_heritage", "pf_2", "pf_3", "pf_4", "pf_5", "pf_6", "adj_heritage", "adj_conservation_area", "adj_environmentally_sensitive", "adj_river_coastal_wall", "adj_substandard", "adj_spare_1", "adj_spare_2", "adj_spare_3", "adj_spare_4", "adj_spare_5", "adj_spare_6"];
const ELEMENT_NUMERIC = ["element_seq", "pf_heritage", "pf_2", "pf_3", "pf_4", "pf_5", "pf_6"];

export const ENGINE_VERSION = "1.0.0-mvp";
const GROUP_LABEL = Object.fromEntries(AVF_GROUPS);

export interface RunRecord {
  run_id: string; label: string; created: string; input_hash: string; duration_ms: number; settings: PlanSettings;
  decisions: number; inspections: number; totals: Record<string, number>; five_year: Record<string, number>;
}
export interface Decision { structure_id: string; status: "approved" | "rejected" | "deferred"; note: string; at: string; by?: string }
interface Draft { id: string; structure_id: string; changes: Record<number, string>; created: string; steps: Record<string, any> }

type Emit = (event: string, data: any) => void;

export class EngineService {
  rs: RuleSet;
  sampleJson: any;
  fixtures: { lamp: Table; summary: any };
  inv!: Inventory;
  source = "";
  invHash = "";
  validation!: ValidationReport;
  valuation!: ValuationResult;
  settings!: PlanSettings;
  decisions = new Map<string, Decision>();
  inspections: { structure_id: string; changes: Record<number, string>; at: string; draft: string }[] = [];
  /** Approved inspection codes keyed by element_seq, so adding or deleting records never misaligns them. */
  condBySeq: Record<string, string> = {};
  get committedConditions(): Record<number, string> {
    const out: Record<number, string> = {};
    if (!this.inv || !Object.keys(this.condBySeq).length) return out;
    this.inv.elements.forEach((e, i) => { const c = this.condBySeq[String(e.element_seq)]; if (c) out[i] = c; });
    return out;
  }
  model!: PlanningModel;
  lt!: LongTermResult;
  fy!: FiveYearResult;
  current!: RunRecord;
  runs: RunRecord[] = [];
  drafts = new Map<string, Draft>();
  verification: any = null;
  sidIndex = new Map<string, number>();
  emit: Emit = () => {};

  constructor(ruleset: RuleSetJson, sample: any, fixtures: { lamp: Table; summary: any }) {
    this.rs = new RuleSet(ruleset);
    this.sampleJson = sample;
    this.fixtures = fixtures;
  }

  // ------------------------------------------------------------------ loading
  meta() {
    return {
      engine_version: ENGINE_VERSION, ruleset: this.rs.name, price_year: this.rs.priceYear, ruleset_sha256: this.rs.sourceSha,
      strategies: STRATEGY_NAMES, condition_codes: this.rs.condition.map((r) => r.code),
      condition_ecs: this.rs.ecsList, discount_rate: this.rs.t.discount_rates[0]?.rate ?? 0.035,
    };
  }

  async loadSample() {
    const s = this.sampleJson;
    return this.load({ name: s.name, structures: toRows(s.structures), elements: toRows(s.elements), planned: toRows(s.planned), routine: toRows(s.routine), settings: s.settings }, "sample");
  }

  async importFile(buf: ArrayBuffer, name: string) {
    const got = readWorkbookFile(buf, name) as Inventory;
    if (!got.structures?.length || !got.elements?.length) throw new Error("No Structures and Elements tables were found in this file. Use a SAVI v1.10 workbook, or a workbook with sheets named 'structures' and 'elements'.");
    return this.load({ name, structures: got.structures, elements: got.elements, planned: got.planned ?? [], routine: got.routine ?? [], settings: { ...this.sampleJson.settings, ...(got.settings ?? {}) } }, "upload");
  }

  async importCsvs(files: { name: string; text: string }[]) {
    const inv: any = { name: files.map((f) => f.name).join(" + "), structures: [], elements: [], planned: [], routine: [], settings: { ...this.sampleJson.settings } };
    for (const f of files) {
      const { kind, rows } = readCsv(f.text);
      if (kind === "unknown") throw new Error(`${f.name}: could not tell which table this is (expected columns such as structure_type, condition_code, year_of_work or routine_maintenance).`);
      inv[kind] = rows;
    }
    if (!inv.structures.length || !inv.elements.length) throw new Error("Both a structures CSV and an elements CSV are needed.");
    return this.load(inv, "upload");
  }

  private async load(inv: Inventory, source: string) {
    const t = performance.now();
    this.inv = inv;
    this.source = source;
    this.validation = validateInventory(inv.structures, inv.elements, this.rs);
    this.invHash = (await sha256Hex(JSON.stringify([inv.structures, inv.elements, inv.planned, inv.routine]))).slice(0, 12);
    this.decisions.clear(); this.inspections = []; this.condBySeq = {}; this.drafts.clear(); this.runs = [];
    this.sidIndex = new Map(inv.structures.map((s, i) => [key(s.structure_id), i]));
    this.settings = settingsFromInventory(inv);
    if (this.validation.valid) {
      this.valuation = runValuation(inv, this.rs);
      await this.rerun("Baseline (inventory loaded)");
    }
    return { ...this.state(), load_ms: Math.round(performance.now() - t) };
  }

  // ------------------------------------------------------------------ runs
  private overrides5(): YearOverrides {
    const reject: number[] = [];
    for (const d of this.decisions.values()) if (d.status === "rejected" || d.status === "deferred") reject.push(...this.elementsOf(d.structure_id));
    return { reject };
  }
  private overridesLT(): Record<number, YearOverrides> {
    const reject: number[] = [];
    for (const d of this.decisions.values()) if (d.status === "deferred") reject.push(...this.elementsOf(d.structure_id));
    const out: Record<number, YearOverrides> = {};
    if (reject.length) for (let y = 1; y <= 5; y++) out[y] = { reject };
    return out;
  }
  elementsOf(sid: string): number[] {
    const p = this.sidIndex.get(key(sid));
    if (p === undefined || !this.model) return [];
    const out: number[] = [];
    this.model.pos.forEach((q, i) => { if (q === p) out.push(i); });
    return out;
  }

  private async hashFor(settings: PlanSettings, extra: any = null) {
    return (await sha256Hex(JSON.stringify([this.invHash, settings, [...this.decisions.values()].map((d) => [d.structure_id, d.status]), this.committedConditions, extra]))).slice(0, 10);
  }

  async rerun(label: string) {
    this.requireValid();
    const t = performance.now();
    this.model = new PlanningModel(this.inv, this.rs, this.settings);
    const cond = this.committedConditions;
    this.lt = this.model.runLongTerm({ overrides: this.overridesLT(), conditionOverrides: cond });
    this.fy = this.model.runFiveYear({ overrides: this.overrides5(), conditionOverrides: cond });
    const hash = await this.hashFor(this.settings);
    const prev = this.runs.find((r) => r.input_hash === hash);
    this.current = {
      run_id: prev?.run_id ?? `R${String(this.runs.length + 1).padStart(3, "0")}-${hash.slice(0, 4)}`, label, created: new Date().toISOString(), input_hash: hash,
      duration_ms: Math.round(performance.now() - t), settings: { ...this.settings }, decisions: this.decisions.size,
      inspections: this.inspections.length, totals: this.lt.totals(), five_year: this.fiveYearKey(this.fy),
    };
    if (!prev) this.runs.push(this.current);
    return this.current;
  }

  private fiveYearKey(fy: FiveYearResult) {
    const s = fy.summary;
    return { total_budget: s.total_budget, expenditure: s.expenditure, remaining: s.remaining, planned: s.planned, routine: s.routine,
      schemes_funded: s.schemes_funded, elements_maintained: s.elements_maintained, ssci_av_y5: s["ssci_av|Full Stock"],
      ssci_crit_y5: s["ssci_crit|Full Stock"], sss_y5: s["sss|Full Stock"], at_risk_y5: s["at_risk|Stock"] };
  }

  private requireValid() {
    if (!this.inv) throw new Error("No inventory is loaded.");
    if (!this.validation.valid) throw new Error(`The inventory has ${this.validation.errors} blocking validation errors; fix them before running plans.`);
  }

  // ------------------------------------------------------------------ state for the UI
  state() {
    const v = this.validation;
    const base: any = {
      meta: this.meta(), source: this.source, inventory: this.inv ? { name: this.inv.name, structures: this.inv.structures.length,
        elements: this.inv.elements.length, planned: this.inv.planned.length, routine_years: this.inv.routine.length, hash: this.invHash,
        organisation: this.inv.settings?.organisation ?? "", authority_type: this.inv.settings?.authority_type ?? "Local Authority" } : null,
      validation: v ? { valid: v.valid, errors: v.errors, warnings: v.warnings, byRule: v.byRule, issues: v.issues.filter((i) => i.severity === "error").slice(0, 300).concat(v.issues.filter((i) => i.severity === "warning").slice(0, 200)) } : null,
    };
    if (!v?.valid || !this.lt) return base;
    return {
      ...base,
      valuation: this.valuation.summary.valuation, condition_y0: this.valuation.summary.condition_y0,
      settings: this.settings, run: this.current, runs: this.runs.slice(-30),
      long_term: { table: this.lt.table, totals: this.lt.totals(), works_count: this.lt.works.length },
      five_year: { summary: this.fy.summary, projects: this.fy.projects(), unfunded: this.fy.unfunded().slice(0, 60) },
      decisions: [...this.decisions.values()], inspections: this.inspections, verification: this.verification,
      budget_by_year: [...Array(this.settings.years)].map((_, i) => budgetFor(this.settings, i + 1)),
    };
  }

  async setSettings(patch: Partial<PlanSettings>, label = "Settings changed") {
    this.settings = { ...this.settings, ...patch };
    await this.rerun(label);
    return this.state();
  }

  async decide(d: Decision | { structure_id: string; status: "clear" }) {
    const p = this.sidIndex.get(key(d.structure_id));
    if (p === undefined) throw new Error(`Structure ${d.structure_id} not found`);
    const sid = this.inv.structures[p].structure_id;
    if (d.status === "clear") this.decisions.delete(sid);
    else this.decisions.set(sid, { ...(d as Decision), structure_id: sid });
    const before = this.fy.projects().map((x) => x.structure_id);
    await this.rerun(d.status === "clear" ? `Decision cleared: ${sid}` : `${d.status[0].toUpperCase() + d.status.slice(1)}: ${sid}`);
    const after = this.fy.projects().map((x) => x.structure_id);
    return { state: this.state(), entered: after.filter((x) => !before.includes(x)), left: before.filter((x) => !after.includes(x)) };
  }

  // ------------------------------------------------------------------ verification against SAVI
  /** Re-runs the bundled SAVI sample with default settings and compares with SAVI's own LAMP results. */
  async verify() {
    const t = performance.now();
    const s = this.sampleJson;
    const inv: Inventory = { name: s.name, structures: toRows(s.structures), elements: toRows(s.elements), planned: toRows(s.planned), routine: toRows(s.routine), settings: s.settings };
    const val = runValuation(inv, this.rs);
    const m = new PlanningModel(inv, this.rs);
    const lt = m.runLongTerm(), fy = m.runFiveYear();
    const lamp = toRows(this.fixtures.lamp), sm = this.fixtures.summary;
    const close = (a: any, b: any) => { const x = Number.isFinite(+a) && a !== null ? +a : 0, y = Number.isFinite(+b) && b !== null ? +b : 0; return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y)); };
    let cells = 0, bad = 0;
    for (const [col, name] of Object.entries(LAMP_COLUMNS)) {
      const ys = col.length === 1 && col <= "Q" ? [...Array(30)].map((_, i) => i + 1) : [...Array(31)].map((_, i) => i);
      for (const y of ys) {
        let e = lamp[y][col];
        if ("RSTUVWX".includes(col) && (e === null || e === "") && lamp[y].A > 0) e = 0;
        cells++; if (!close(lt.table[y][name], e)) bad++;
      }
    }
    const checks = [
      { name: "WGA gross replacement cost", ours: val.summary.valuation.grc, savi: sm.valuation.grc },
      { name: "WGA depreciated replacement cost", ours: val.summary.valuation.drc, savi: sm.valuation.drc },
      { name: "Annual depreciation", ours: val.summary.valuation.annual_depreciation, savi: sm.valuation.annual_depreciation },
      { name: "5-year programme spend", ours: fy.summary.expenditure, savi: sm.short_term_plan.expenditure },
      { name: "SSCIav after 5 years", ours: fy.summary["ssci_av|Full Stock"], savi: sm.short_term_plan.ssci_av_y5 },
      { name: "30-year expenditure", ours: lt.totals().expenditure, savi: sm.long_term_plan.expenditure },
      { name: "Workbank after 30 years", ours: lt.workbankEnd, savi: sm.long_term_plan.workbank_end },
    ].map((c) => ({ ...c, match: close(c.ours, c.savi) }));
    this.verification = { lamp_cells: cells, lamp_mismatches: bad, checks, passed: bad === 0 && checks.every((c) => c.match),
      ms: Math.round(performance.now() - t), at: new Date().toISOString(), reference: "SAVI v1.10 'with sample data and analysis' (UKRLG)" };
    return this.verification;
  }

  // ------------------------------------------------------------------ queries
  private structureRow(p: number) {
    const s = this.inv.structures[p], vs = this.valuation.structures[p], d = this.fy.detail;
    const funded = d.DG[p] > 0, sid = s.structure_id;
    const ltWorks = this.lt.works.filter((w) => w.structure_index === p);
    const firstYear = ltWorks.length ? Math.min(...ltWorks.map((w) => w.year)) : null;
    return {
      structure_id: sid, name: s.name, structure_type: s.structure_type, group: GROUP_LABEL[vs.avf_type] ?? vs.avf_type,
      number_in_group: num(s.number_in_group), length_m: num(s.length_m), route: s.route_supported, obstacle: s.obstacle_crossed, traffic: s.traffic,
      grc: vs.grc, drc: vs.drc, sci_av: vs.sci_av, sci_crit: vs.sci_crit, good_repair: vs.state_of_good_repair === 1,
      at_risk_y0: vs.traffic_delay_cost > 0, delay_cost_y0: vs.traffic_delay_cost,
      priority: d.CF[p], rank: d.rank[p] || null, need: d.action[p] === 2 ? "Replace" : d.action[p] === 1 ? "Maintain" : "None",
      scheme_cost: d.DF[p], in_programme: funded, programme_year: funded ? this.fy.schedule[p] : null,
      programme_action: funded ? (d.DG[p] === 2 ? "Replace" : "Maintain") : null, programme_cost: funded ? d.DH[p] : 0,
      decision: this.decisions.get(sid)?.status ?? null, first_long_term_works_year: firstYear,
    };
  }

  structures(q: { text?: string; group?: string; sort?: string; desc?: boolean; only?: string; limit?: number; offset?: number } = {}) {
    this.requireValid();
    let rows = this.inv.structures.map((_, p) => this.structureRow(p));
    const t = (q.text ?? "").trim().toLowerCase();
    if (t) rows = rows.filter((r) => `${r.structure_id} ${r.name} ${r.structure_type}`.toLowerCase().includes(t));
    if (q.group) rows = rows.filter((r) => r.group === q.group);
    if (q.only === "programme") rows = rows.filter((r) => r.in_programme);
    if (q.only === "at_risk") rows = rows.filter((r) => r.at_risk_y0);
    if (q.only === "not_good_repair") rows = rows.filter((r) => !r.good_repair);
    if (q.only === "unfunded") rows = rows.filter((r) => r.rank && !r.in_programme);
    if (q.only === "decided") rows = rows.filter((r) => r.decision);
    const sk = q.sort ?? "rank";
    rows.sort((a: any, b: any) => {
      const x = a[sk], y = b[sk];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const c = typeof x === "string" ? x.localeCompare(y) : x - y;
      return q.desc ? -c : c;
    });
    const off = q.offset ?? 0, lim = q.limit ?? 100;
    return { total: rows.length, rows: rows.slice(off, off + lim), run_id: this.current.run_id };
  }

  structure(id: string) {
    this.requireValid();
    const p = this.sidIndex.get(key(id));
    if (p === undefined) throw new Error(`Structure '${id}' is not in the inventory.`);
    const d = this.fy.detail, m = this.model, codes = m.codes;
    const elements = this.model.pos.reduce<number[]>((a, q, i) => (q === p ? (a.push(i), a) : a), []).map((i) => {
      const e = this.inv.elements[i], ve = this.valuation.elements[i];
      return {
        index: i, element_seq: e.element_seq, element_type: e.element_type, material: e.material,
        condition: this.committedConditions[i] ?? e.condition_code, importance: ve.importance, ecs: ve.ecs, eci: ve.eci,
        exposure: d.J[i] || null, time_to_failure: ve.time_to_failure, replacement_cost: ve.element_replacement_cost,
        need: d.M[i] > 0 ? m.ruleActionName[d.M[i] - 1] : null, need_cost: d.AB[i], priority: d.Q[i], considered: d.AE[i] === 1,
        status: ["-", "Maintain", "Replace structure", "Planned"][d.DN[i]] ?? "-", programme_cost: d.DV[i] + d.DW[i] + d.DX[i],
        ecs_after_5y: this.fy.reportedEcs[i],
        profile: this.lt.ecsProfile.map((row) => row[i]),
      };
    });
    const works = this.lt.works.filter((w) => w.structure_index === p).map((w) => ({ year: w.year, element_seq: w.element_seq, element_type: w.element_type, action: w.action, status: w.status, cost: w.cost, condition_before: w.condition_before }));
    const ev = this.fy.evaluation;
    return { ...this.structureRow(p), run_id: this.current.run_id, sci_av_y5: ev.sciAv[p], sci_crit_y5: ev.sciCrit[p],
      reference: this.inv.structures[p].reference, location: this.inv.structures[p].location, width_m: num(this.inv.structures[p].width_m),
      spans: num(this.inv.structures[p].spans), elements, long_term_works: works, condition_codes: codes };
  }

  explainPriority(id: string) {
    this.requireValid();
    const p = this.sidIndex.get(key(id));
    if (p === undefined) throw new Error(`Structure '${id}' is not in the inventory.`);
    const d = this.fy.detail, m = this.model, s = this.inv.structures[p], rs = this.rs, w = rs.weights;
    const rf = num(rs.routes.get(key(s.route_supported))?.rf), tf = num(rs.traffic.get(key(s.traffic))?.tf);
    const obs = num(rs.obstacles.get(key(s.obstacle_crossed))?.obsf), stf = num(rs.structureTypes.get(key(s.structure_type))?.stf);
    const els = this.elementsOf(s.structure_id).filter((i) => d.N[i] !== -10).map((i) => ({
      element_seq: this.inv.elements[i].element_seq, element_type: this.inv.elements[i].element_type,
      condition: m.codes[this.fy.startState.pos[i]] ?? "", precise_ecs: d.F[i] ? this.fy.startState.precise[i] : 0, eci: d.F[i],
      condition_score: w.f1 * d.F[i], network_score: m.networkPriority[p], extra: d.P[i], priority: d.Q[i],
      action: d.M[i] > 0 ? m.ruleActionName[d.M[i] - 1] : null, cost: d.AB[i], considered: d.AE[i] === 1,
    })).sort((a, b) => b.priority - a.priority);
    const order = [...Array(m.ns).keys()].filter((q) => d.rank[q] > 0).sort((a, b) => d.rank[a] - d.rank[b]);
    const pos = order.indexOf(p);
    return {
      structure_id: s.structure_id, run_id: this.current.run_id,
      formula: "Element priority = f1 x ECI + f2 x (route + traffic + obstacle factors) + f3 x structure-type factor + extra priority (+5000 if a very-high/high importance element is at ECS 5, +400 at ECS 4) + user priority factors. Structure priority = sum over the elements considered for its scheme.",
      weights: { f1: w.f1, f2: w.f2, f3: w.f3 }, factors: { route: rf, traffic: tf, obstacle: obs, structure_type: stf },
      network_score: m.networkPriority[p], structure_priority: d.CF[p], rank: d.rank[p] || null, of_ranked: order.length,
      scheme: { repair_cost: d.DC[p], replace_cost: d.DD[p], replace_rule: `Replace when ${m.replaceMult} x GRC < repair scheme cost`, action: d.action[p] === 2 ? "Replace" : d.action[p] === 1 ? "Maintain" : "None", cost: d.DF[p] },
      budget: { available_5yr: d.budgetAvailable, cumulative_cost_at_rank: d.cum[p], funded: d.DG[p] > 0, programme_year: d.DG[p] > 0 ? this.fy.schedule[p] : null,
        structure_before: pos > 0 ? this.inv.structures[order[pos - 1]].structure_id : null },
      decision: this.decisions.get(s.structure_id) ?? null, elements: els.slice(0, 25),
    };
  }

  /** What-if run, not committed. */
  async scenario(patch: Partial<PlanSettings>, label = "Scenario") {
    this.requireValid();
    const t = performance.now();
    const settings = { ...this.settings, ...patch };
    const m = new PlanningModel(this.inv, this.rs, settings);
    const lt = m.runLongTerm({ overrides: this.overridesLT(), conditionOverrides: this.committedConditions });
    const fy = m.runFiveYear({ overrides: this.overrides5(), conditionOverrides: this.committedConditions });
    const pick = (r: LongTermResult) => ({ ssci_av: r.table.map((x) => x["ssci_av|Full Stock"]), ssci_crit: r.table.map((x) => x["ssci_crit|Full Stock"]),
      expenditure: r.table.map((x) => x.expenditure ?? 0), workbank: r.table.map((x) => x.workbank ?? 0), at_risk: r.table.map((x) => x["at_risk|Stock"]), budget: r.table.map((x) => x.start_budget ?? 0) });
    const hash = await this.hashFor(settings, "scenario");
    const tot = lt.totals(), base = this.lt.totals();
    return { scenario_id: `S-${hash.slice(0, 6)}`, label, base_run_id: this.current.run_id, settings, duration_ms: Math.round(performance.now() - t),
      totals: tot, five_year: this.fiveYearKey(fy), series: pick(lt), base_series: pick(this.lt), base_totals: base, base_five_year: this.current.five_year,
      delta: Object.fromEntries(Object.keys(tot).filter((k) => typeof (tot as any)[k] === "number").map((k) => [k, (tot as any)[k] - (base as any)[k]])) };
  }

  async uncertainty(runs = 20, seed = 0) {
    this.requireValid();
    const t = performance.now();
    const m = new PlanningModel(this.inv, this.rs, this.settings);
    const res = m.runUncertainty({ runs, seed, onProgress: (k) => this.emit("progress", { task: "uncertainty", done: k, of: runs }) });
    return { ...res, run_id: this.current.run_id, ms: Math.round(performance.now() - t) };
  }

  // ------------------------------------------------------------------ W1: a new inspection, agentic but deterministic
  w1Record(structureId: string, changes: Record<string, string>) {
    this.requireValid();
    const p = this.sidIndex.get(key(structureId));
    if (p === undefined) throw new Error(`Structure '${structureId}' is not in the inventory.`);
    const els = new Set(this.elementsOf(structureId));
    const bySeq = new Map(this.inv.elements.map((e, i) => [String(e.element_seq), i]));
    const out: Record<number, string> = {}, rows: any[] = [];
    for (const [seq, code] of Object.entries(changes)) {
      const i = bySeq.get(String(seq));
      if (i === undefined || !els.has(i)) throw new Error(`Element ${seq} does not belong to ${structureId}.`);
      const c = String(code).toUpperCase().trim();
      if (!this.rs.conditionPos.has(c.toLowerCase())) throw new Error(`'${code}' is not a condition code (1A, 2B ... 5E).`);
      const before = this.committedConditions[i] ?? this.inv.elements[i].condition_code;
      if (key(before) === key(c)) continue;
      out[i] = c;
      rows.push({ element_seq: this.inv.elements[i].element_seq, element_type: this.inv.elements[i].element_type, before, after: c,
        ecs_before: this.rs.ecsList[this.rs.conditionPos.get(key(before))!], ecs_after: this.rs.ecsList[this.rs.conditionPos.get(c.toLowerCase())!] });
    }
    if (!rows.length) throw new Error("No element condition changed - nothing to assess.");
    const id = `D-${Date.now().toString(36)}`;
    this.drafts.set(id, { id, structure_id: this.inv.structures[p].structure_id, changes: out, created: new Date().toISOString(), steps: {} });
    return { draft_id: id, structure_id: this.inv.structures[p].structure_id, changes: rows, worsened: rows.filter((r) => r.ecs_after > r.ecs_before).length };
  }

  private draft(id: string) { const d = this.drafts.get(id); if (!d) throw new Error(`Draft ${id} not found (it may have been committed or discarded).`); return d; }

  /** Step 2: condition indices for the structure, before vs after (evaluation module). */
  w1Evaluate(id: string) {
    const d = this.draft(id), p = this.sidIndex.get(key(d.structure_id))!;
    const m = this.model;
    const b0 = m.applyCondition(m.initialState(), this.committedConditions), a0 = m.applyCondition(b0, d.changes);
    const eb = m.evaluate(b0.ecs, b0.precise), ea = m.evaluate(a0.ecs, a0.precise);
    const band = (v: number) => (v >= 90 ? "Very good" : v >= 80 ? "Good" : v >= 65 ? "Fair" : v >= 40 ? "Poor" : "Very poor");
    const r = { structure_id: d.structure_id, sci_av: { before: eb.sciAv[p], after: ea.sciAv[p] }, sci_crit: { before: eb.sciCrit[p], after: ea.sciCrit[p] },
      band: { before: band(eb.sciAv[p]), after: band(ea.sciAv[p]) }, good_repair: { before: eb.sgr[p] === 1, after: ea.sgr[p] === 1 },
      traffic_risk: { before: eb.delay[p] > 0, after: ea.delay[p] > 0, delay_cost_after: ea.delay[p] } };
    d.steps.evaluate = r;
    return r;
  }

  /** Steps 3-4: re-prioritise and revise the 5-year programme. */
  w1Programme(id: string) {
    const d = this.draft(id), p = this.sidIndex.get(key(d.structure_id))!;
    const cond = { ...this.committedConditions, ...d.changes };
    const fy = this.model.runFiveYear({ overrides: this.overrides5(), conditionOverrides: cond });
    const b = this.fy, before = b.projects(), after = fy.projects();
    const bi = new Map(before.map((x) => [x.structure_id, x])), ai = new Map(after.map((x) => [x.structure_id, x]));
    const sid = d.structure_id;
    const r = {
      structure_id: sid,
      structure: { priority: { before: b.detail.CF[p], after: fy.detail.CF[p] }, rank: { before: b.detail.rank[p] || null, after: fy.detail.rank[p] || null },
        funded: { before: bi.has(sid), after: ai.has(sid) }, year: { before: bi.get(sid)?.year ?? null, after: ai.get(sid)?.year ?? null },
        action: { before: bi.get(sid)?.action ?? null, after: ai.get(sid)?.action ?? null }, cost: { before: bi.get(sid)?.cost ?? 0, after: ai.get(sid)?.cost ?? 0 } },
      entered: after.filter((x) => !bi.has(x.structure_id)).map((x) => ({ structure_id: x.structure_id, year: x.year, cost: x.cost })),
      displaced: before.filter((x) => !ai.has(x.structure_id)).map((x) => ({ structure_id: x.structure_id, year: x.year, cost: x.cost })),
      moved: after.filter((x) => bi.has(x.structure_id) && bi.get(x.structure_id)!.year !== x.year && x.structure_id !== sid).map((x) => ({ structure_id: x.structure_id, from: bi.get(x.structure_id)!.year, to: x.year })).slice(0, 20),
      spend: { before: b.summary.expenditure, after: fy.summary.expenditure }, ssci_av_y5: { before: b.summary["ssci_av|Full Stock"], after: fy.summary["ssci_av|Full Stock"] },
    };
    d.steps.programme = r;
    return r;
  }

  /** Step 5: update the long-term lifecycle forecast. */
  w1LongTerm(id: string) {
    const d = this.draft(id), p = this.sidIndex.get(key(d.structure_id))!;
    const lt = this.model.runLongTerm({ overrides: this.overridesLT(), conditionOverrides: { ...this.committedConditions, ...d.changes } });
    const a = lt.totals(), b = this.lt.totals();
    const yrs = (r: LongTermResult) => r.works.filter((w) => w.structure_index === p).map((w) => w.year);
    const r = { structure_id: d.structure_id,
      totals: Object.fromEntries(["expenditure", "discounted_expenditure", "workbank_end", "ssci_av_end", "ssci_crit_end"].map((k) => [k, { before: (b as any)[k], after: (a as any)[k] }])),
      works_years: { before: [...new Set(yrs(this.lt))], after: [...new Set(yrs(lt))] } };
    d.steps.long_term = r;
    return r;
  }

  async w1Commit(id: string, by?: string) {
    const d = this.draft(id);
    for (const [i, c] of Object.entries(d.changes)) this.condBySeq[String(this.inv.elements[+i].element_seq)] = c;
    this.revalue();
    this.inspections.push({ structure_id: d.structure_id, changes: d.changes, at: new Date().toISOString(), draft: id });
    this.drafts.delete(id);
    const run = await this.rerun(`Inspection approved: ${d.structure_id}${by ? " by " + by : ""}`);
    return { run, state: this.state() };
  }

  w1Discard(id: string) { this.drafts.delete(id); return { discarded: id }; }

  /** Valuation with approved inspection codes applied (WGA depreciation uses the reported code). */
  private revalue() {
    const cc = this.committedConditions;
    const inv2 = { ...this.inv, elements: this.inv.elements.map((e, i) => (cc[i] ? { ...e, condition_code: cc[i] } : e)) };
    this.valuation = runValuation(inv2, this.rs);
  }

  // ------------------------------------------------------------------ data entry (record by record, like typing into SAVI's input sheets)
  lookups() {
    const t = this.rs.t;
    const elementsFor: Record<string, string[]> = {}, materialsFor: Record<string, string[]> = {};
    for (const r of t.structure_elements) (elementsFor[r.structure_type] ??= []).push(r.element_type);
    for (const r of t.element_materials) (materialsFor[r.element_type] ??= []).push(r.material);
    const imp = new Map(t.element_types.map((r) => [r.element_type, r.importance]));
    return {
      structure_types: t.structure_types.map((r) => r.structure_type), locations: t.locations.map((r) => r.location),
      routes: t.routes.map((r) => r.route), obstacles: t.obstacles.map((r) => r.obstacle), traffic: t.traffic.map((r) => r.traffic),
      spray: t.spray_proximity.map((r) => r.spray_proximity), condition_codes: this.rs.condition.map((r) => r.code),
      strategies: STRATEGY_NAMES, elements_for: elementsFor, materials_for: materialsFor, importance: Object.fromEntries(imp),
      authority_types: ["Local Authority", "Overseeing (Trunk Road) Authority", "Transport for London"],
      adjustment_flags: t.adjustment_factors.slice(0, 11).map((r) => ({ column: r.column, label: r.label, factor: r.factor })),
      priority_factor_weights: this.inv?.settings?.priority_factor_weights ?? t.priority_factor_weights,
    };
  }

  /** Start from an empty inventory - the blank SAVI workbook. */
  async newBlank(name = "New inventory") {
    return this.load({ name, structures: [], elements: [], planned: [], routine: [], settings: { authority_type: "Local Authority", price_year: this.rs.priceYear, intervention_strategy: "Mid Intervention (condition 4B)", years_long_term: 30, budget_5yr_annual: 0, budget_long_term: [] } }, "manual");
  }

  inventoryTables() {
    if (!this.inv) throw new Error("No inventory is loaded.");
    return { structures: this.inv.structures, elements: this.inv.elements, planned: this.inv.planned, routine: this.inv.routine, settings: this.inv.settings };
  }

  private recordIssues(table: "structures" | "elements", id: string, inv: Inventory) {
    const rep = validateInventory(inv.structures, inv.elements, this.rs);
    const seen = new Set<string>();
    return rep.issues
      .filter((x) => x.table === table && key(x.record_id) === key(id) && x.rule !== "S12_no_elements")
      .filter((x) => { const k = x.rule + "|" + x.field; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((x) => ({ field: x.field, rule: x.rule, message: x.message, severity: x.severity }));
  }

  private cleanRow(row: Row, cols: string[], numeric: string[]) {
    const out: Row = {};
    for (const c of cols) {
      let v = row[c];
      if (typeof v === "string") v = v.trim();
      if (v === "" || v === undefined) v = null;
      if (v !== null && numeric.includes(c)) { const n = Number(v); v = Number.isFinite(n) ? n : v; }
      out[c] = v;
    }
    return out;
  }

  /** Check a structure or element without saving it. */
  checkRecord(table: "structures" | "elements", row: Row, original?: string | number | null) {
    const inv = this.withRecord(table, row, original);
    return this.recordIssues(table, String(table === "structures" ? row.structure_id : row.element_seq), inv);
  }

  private withRecord(table: "structures" | "elements", row: Row, original?: string | number | null): Inventory {
    const inv = { ...this.inv, structures: [...this.inv.structures], elements: [...this.inv.elements] };
    if (table === "structures") {
      const r = this.cleanRow(row, STRUCTURE_COLUMNS, STRUCT_NUMERIC);
      const at = original != null ? inv.structures.findIndex((s) => key(s.structure_id) === key(original)) : -1;
      if (at >= 0) inv.structures[at] = { ...inv.structures[at], ...r }; else inv.structures.push(r);
      if (at >= 0 && key(original) !== key(r.structure_id)) inv.elements = inv.elements.map((e) => (key(e.structure_id) === key(original) ? { ...e, structure_id: r.structure_id } : e));
    } else {
      const r = this.cleanRow(row, ELEMENT_COLUMNS, ELEMENT_NUMERIC);
      const at = original != null ? inv.elements.findIndex((e) => String(e.element_seq) === String(original)) : -1;
      if (at >= 0) inv.elements[at] = { ...inv.elements[at], ...r }; else inv.elements.push(r);
    }
    return inv;
  }

  private async afterEdit(label: string) {
    this.validation = validateInventory(this.inv.structures, this.inv.elements, this.rs);
    this.sidIndex = new Map(this.inv.structures.map((s, i) => [key(s.structure_id), i]));
    this.invHash = (await sha256Hex(JSON.stringify([this.inv.structures, this.inv.elements, this.inv.planned, this.inv.routine, this.inv.settings?.priority_factor_weights ?? null]))).slice(0, 12);
    const seqs = new Set(this.inv.elements.map((e) => String(e.element_seq)));
    for (const k of Object.keys(this.condBySeq)) if (!seqs.has(k)) delete this.condBySeq[k];
    for (const k of [...this.decisions.keys()]) if (!this.sidIndex.has(key(k))) this.decisions.delete(k);
    this.drafts.clear();
    if (this.validation.valid) { this.revalue(); await this.rerun(label); }
    if (this.source === "sample") this.source = "edited";
    return this.state();
  }

  async saveStructure(row: Row, original?: string | null) {
    if (!this.inv) throw new Error("No inventory is loaded.");
    const id = String(row.structure_id ?? "").trim();
    if (!id) throw new Error("A structure needs an identifier.");
    if (this.inv.structures.some((s) => key(s.structure_id) === key(id) && key(s.structure_id) !== key(original ?? null))) throw new Error(`Structure ${id} already exists.`);
    if (original == null && row.structure_seq == null) row = { ...row, structure_seq: Math.max(0, ...this.inv.structures.map((s) => num(s.structure_seq))) + 1 };
    const issues = this.checkRecord("structures", row, original).filter((x) => x.severity === "error");
    if (issues.length) return { saved: false, issues };
    this.inv = this.withRecord("structures", row, original);
    if (original && key(original) !== key(id)) { const d = this.decisions.get(original); if (d) { this.decisions.delete(original); this.decisions.set(id, { ...d, structure_id: id }); } }
    return { saved: true, issues: [], state: await this.afterEdit(original ? `Structure edited: ${id}` : `Structure added: ${id}`) };
  }

  async deleteStructure(id: string) {
    const n0 = this.inv.structures.length;
    this.inv = { ...this.inv, structures: this.inv.structures.filter((s) => key(s.structure_id) !== key(id)), elements: this.inv.elements.filter((e) => key(e.structure_id) !== key(id)),
      planned: this.inv.planned.filter((p) => key(p.structure_id) !== key(id)) };
    if (this.inv.structures.length === n0) throw new Error(`Structure ${id} not found.`);
    return { state: await this.afterEdit(`Structure deleted: ${id}`) };
  }

  async saveElement(row: Row, original?: number | string | null) {
    if (!this.inv) throw new Error("No inventory is loaded.");
    if (row.element_seq == null || row.element_seq === "") row = { ...row, element_seq: Math.max(0, ...this.inv.elements.map((e) => num(e.element_seq))) + 1 };
    const seq = String(row.element_seq);
    if (this.inv.elements.some((e) => String(e.element_seq) === seq && seq !== String(original ?? ""))) throw new Error(`Element number ${seq} already exists.`);
    const issues = this.checkRecord("elements", row, original).filter((x) => x.severity === "error");
    if (issues.length) return { saved: false, issues };
    this.inv = this.withRecord("elements", row, original);
    if (original != null && String(original) !== seq && this.condBySeq[String(original)]) { this.condBySeq[seq] = this.condBySeq[String(original)]; delete this.condBySeq[String(original)]; }
    // a new condition typed here is the new reported code: it replaces any earlier approved inspection
    if (original != null) delete this.condBySeq[seq];
    return { saved: true, issues: [], element_seq: row.element_seq, state: await this.afterEdit(original != null ? `Element ${seq} edited (${row.structure_id})` : `Element ${seq} added to ${row.structure_id}`) };
  }

  async deleteElement(seq: number | string) {
    const n0 = this.inv.elements.length;
    this.inv = { ...this.inv, elements: this.inv.elements.filter((e) => String(e.element_seq) !== String(seq)), planned: this.inv.planned.filter((p) => String(p.element_seq) !== String(seq)) };
    if (this.inv.elements.length === n0) throw new Error(`Element ${seq} not found.`);
    return { state: await this.afterEdit(`Element ${seq} deleted`) };
  }

  /** Planned works, routine costs, organisation settings and priority-factor weights. */
  async savePlanned(rows: Row[]) {
    const seqs = new Map(this.inv.elements.map((e) => [String(e.element_seq), e]));
    const codes = new Set(this.rs.condition.map((r) => key(r.code)));
    const out: Row[] = [];
    rows.forEach((r, k) => {
      const e = seqs.get(String(r.element_seq));
      if (!e) throw new Error(`Planned work ${k + 1}: element ${r.element_seq} is not in the inventory.`);
      const y = Number(r.year_of_work), c = Number(r.total_cost);
      if (!(Number.isInteger(y) && y >= 1)) throw new Error(`Planned work ${k + 1}: year must be a whole number from 1.`);
      if (!(c >= 0)) throw new Error(`Planned work ${k + 1}: cost must be a positive amount.`);
      if (!codes.has(key(r.condition_after))) throw new Error(`Planned work ${k + 1}: condition after works must be a code such as 1A.`);
      const st = this.inv.structures[this.sidIndex.get(key(e.structure_id)) ?? -1];
      out.push({ element_seq: num(e.element_seq), structure_id: e.structure_id, structure_name: st?.name ?? null, element_type: e.element_type, material: e.material,
        year_of_work: y, maintenance_action: r.maintenance_action || null, total_cost: c, condition_after: String(r.condition_after).toUpperCase() });
    });
    this.inv = { ...this.inv, planned: out };
    return { state: await this.afterEdit(`Planned works updated (${out.length})`) };
  }

  async saveRoutine(rows: Row[]) {
    const out = rows.filter((r) => Number(r.year) >= 1).map((r) => ({ year: Math.trunc(Number(r.year)), routine_maintenance: num(r.routine_maintenance) || null, general_inspections: num(r.general_inspections) || null,
      principal_inspections: num(r.principal_inspections) || null, structural_assessments: num(r.structural_assessments) || null, other_regular_maintenance: num(r.other_regular_maintenance) || null }));
    this.inv = { ...this.inv, routine: out };
    return { state: await this.afterEdit("Routine costs updated") };
  }

  async saveInventorySettings(patch: Record<string, any>) {
    const allowed = ["organisation", "authority_type", "priority_factor_weights", "name"];
    const s = { ...this.inv.settings };
    for (const k of allowed) if (k in patch && k !== "name") s[k] = patch[k];
    if (patch.priority_factor_weights) {
      const w = patch.priority_factor_weights as Row[];
      if (!Array.isArray(w) || w.some((r) => !(Number(r.weight) >= 0))) throw new Error("Priority factor weights must be numbers of 0 or more.");
      s.priority_factor_weights = w.map((r) => ({ level: r.level, column: r.column, weight: Number(r.weight) }));
    }
    this.inv = { ...this.inv, settings: s, name: patch.name ? String(patch.name) : this.inv.name };
    return { state: await this.afterEdit("Inventory settings changed") };
  }

  workPlanCsvRows() {
    return this.lt.works.map((w) => ({ year: w.year, structure_id: w.structure_id, element_seq: w.element_seq, element_type: w.element_type, material: w.material,
      status: w.status, action: w.action, condition_before: w.condition_before, cost: Math.round(w.cost * 100) / 100, priority: w.priority }));
  }
  programmeCsvRows() {
    return this.fy.projects().map((p) => ({ ...p, decision: this.decisions.get(p.structure_id)?.status ?? "" }));
  }
}
