// Asset management planning: the 5-year programme and the long-term plan.
// A line-by-line port of dst_engine/planning.py (SAVI v1.10 Y5 and Yn sheets, SAMPT Part A 2.4).
// Verified against SAVI's own results in web/test/engine.test.ts.
import { Row, key, num, xlRound, xlCmp, xlRoundDown1, vbaRndDraws, mulberry32, percentile } from "./core";
import { RuleSet } from "./rules";
import { AVF_GROUPS, Inventory, TM_CODES, TM_CODE_ARR, computeSizing, elementStatic, exposures, ElementStatic } from "./valuation";

export const STRATEGIES: Record<string, string> = {
  "early intervention (condition 2c-3c)": "trigger_early",
  "mid intervention (condition 4b)": "trigger_mid",
  "late intervention (condition 5b)": "trigger_late",
  "user defined (default, condition 4b)": "trigger_user",
};
export const STRATEGY_NAMES = ["Early Intervention (condition 2C-3C)", "Mid Intervention (condition 4B)",
  "Late Intervention (condition 5B)", "User Defined (default, condition 4B)"];
const IMPORTANCE_POS: Record<string, number> = { Low: 1, Medium: 2, High: 3, "Very High": 4 };
const ECF_BASE: Record<string, number> = { "Very High": 0, High: 0.3, Medium: 0.6, Low: 1.2 };
const NT = TM_CODES.length;

export interface PlanSettings {
  years: number;
  budgetBands: [number, number, number][];
  fiveYearAnnualBudget: number;
  strategy: string;
  extraVhHEcs5: boolean; extraMlEcs5: boolean; extraVhHEcs4: boolean; extraMlEcs4: boolean;
  carryForward: boolean;
  random: "savi" | "midpoint" | number;
  fiveYearBudgetFactor: number;
  longTermMinBudgetFactor: number;
  replaceMultiplier: number | null;
  deteriorationFactor: number;
}

export function settingsFromInventory(inv: Inventory, over: Partial<PlanSettings> = {}): PlanSettings {
  const s = inv.settings || {};
  const bands: [number, number, number][] = [];
  for (const row of s.budget_long_term || []) {
    const v = (row as any[]).filter((x) => x !== null && x !== undefined && x !== "");
    if (v.length >= 3) bands.push([Math.trunc(+v[0]), Math.trunc(+v[1]), +v[2]]);
  }
  return {
    years: s.years_long_term ? Math.trunc(+s.years_long_term) : 30,
    budgetBands: bands.length ? bands : [[1, 30, 3e6]],
    fiveYearAnnualBudget: s.budget_5yr_annual ? +s.budget_5yr_annual : 3e6,
    strategy: s.intervention_strategy || "Mid Intervention (condition 4B)",
    extraVhHEcs5: true, extraMlEcs5: false, extraVhHEcs4: true, extraMlEcs4: false,
    carryForward: true, random: "savi", fiveYearBudgetFactor: 1.2, longTermMinBudgetFactor: 6,
    replaceMultiplier: null, deteriorationFactor: 1, ...over,
  };
}

export function budgetFor(s: PlanSettings, year: number): number {
  for (const [a, b, v] of s.budgetBands) if (a <= year && year <= b) return v !== 0 ? v : 1e-10;
  return 1e-10;
}

export interface State { pos: Int32Array; ecs: Float64Array; precise: Float64Array }
export interface YearOverrides { reject?: number[]; force?: number[] }
type PlannedLookup = (seq: number) => [number, number] | undefined;

export interface PassResult {
  J: string[]; K: Float64Array; M: Int32Array; N: Int32Array; Q: Float64Array; O: Float64Array; P: Float64Array;
  F: Float64Array; U: Float64Array; W: Float64Array; AB: Float64Array; AE: Uint8Array; DN: Int32Array; DV: Float64Array;
  DW: Float64Array; DX: Float64Array; workbank: Float64Array; CF: Float64Array; DC: Float64Array; DD: Float64Array;
  action: Int32Array; DF: Float64Array; DG: Int32Array; DH: Float64Array; rank: Int32Array; cum: Float64Array;
  fP: Float64Array; fO: Float64Array; fD: Float64Array; planned: Uint8Array; budgetAvailable: number; considerLimit: number;
}

export interface WorkItem {
  year: number; element_index: number; element_seq: number; structure_index: number; structure_id: string;
  element_type: string; material: string; status: string; action: string; condition_before: string;
  ecs_before: number; ecs_after: number; priority: number; structure_rank: number; cost: number; works_cost: number;
  exposure: string;
}

export interface Evaluation { eci: Float64Array; sciAv: Float64Array; sciCrit: Float64Array; sgr: Float64Array; delay: Float64Array; atRisk: Float64Array }

export class PlanningModel {
  rs: RuleSet; inv: Inventory; settings: PlanSettings;
  ns: number; ne: number; st: ElementStatic; pos: Int32Array; valid: Uint8Array;
  ttfFactor: Float64Array;
  // structures
  networkPriority!: Float64Array; structurePf!: Float64Array; grc!: Float64Array; avfType!: string[];
  keyDim!: Float64Array; keyDimAvf!: Float64Array; nGroup!: Float64Array; lengthGroup!: Float64Array;
  delayRate!: Float64Array; code4!: Float64Array; code5!: Float64Array; delayDays = new Map<string, number>();
  delayMult = 1; replaceMult = 1.5;
  // elements
  seq!: Int32Array; impPos!: Int32Array; ecfBase!: Float64Array; life!: string[]; strategyCol!: string[];
  ruleLookup: Record<string, Map<string, number>> = {}; ruleAction!: Int32Array; ruleActionName!: string[];
  ruleAfterEcs!: Float64Array; actType!: string[]; actFixed!: Float64Array; actConst!: Float64Array;
  actVar!: Float64Array[]; actRate!: Float64Array; tmCodeRate!: Float64Array; elementPf!: Float64Array;
  codes!: string[]; ecsList!: number[]; teod!: number[]; ext!: number[][];
  startPos!: Int32Array; startEcs!: Float64Array; detRows = new Map<string, { frac: number[]; mttf: number }>();
  planned = new Map<string, [number, number]>(); routine = new Map<number, number>();

  constructor(inv: Inventory, rs: RuleSet, settings?: PlanSettings) {
    this.rs = rs; this.inv = inv;
    this.settings = settings ?? settingsFromInventory(inv);
    this.ns = inv.structures.length; this.ne = inv.elements.length;
    const authority = inv.settings?.authority_type || "Local Authority";
    const sizing = inv.structures.map((s) => computeSizing(s, rs, authority));
    this.st = elementStatic(inv.structures, inv.elements, sizing, rs);
    this.pos = this.st.pos;
    this.valid = Uint8Array.from(this.pos, (p) => (p >= 0 ? 1 : 0));
    this.ttfFactor = new Float64Array(this.ne).fill(1);
    this.structureStatic(sizing);
    this.elementStaticPlan();
    this.plannedAndRoutine();
  }

  private structureStatic(sizing: ReturnType<typeof computeSizing>[]) {
    const rs = this.rs, S = this.inv.structures, ns = this.ns, w = rs.weights;
    this.networkPriority = new Float64Array(ns); this.structurePf = new Float64Array(ns);
    this.grc = new Float64Array(ns); this.keyDim = new Float64Array(ns); this.keyDimAvf = new Float64Array(ns);
    this.nGroup = new Float64Array(ns); this.lengthGroup = new Float64Array(ns); this.delayRate = new Float64Array(ns);
    this.code4 = new Float64Array(ns); this.code5 = new Float64Array(ns); this.avfType = [];
    const pfw: Row[] = this.inv.settings?.priority_factor_weights ?? rs.t.priority_factor_weights;
    const spf = pfw.filter((r) => r.level === "structure");
    const codes = new Map(rs.t.traffic_restriction_codes.map((r) => [r.avf_type, r]));
    S.forEach((s, p) => {
      const rf = num(rs.routes.get(key(s.route_supported))?.rf), tf = num(rs.traffic.get(key(s.traffic))?.tf);
      const obs = num(rs.obstacles.get(key(s.obstacle_crossed))?.obsf), stf = num(rs.structureTypes.get(key(s.structure_type))?.stf);
      this.networkPriority[p] = w.f2 * (rf + tf + obs) + w.f3 * stf;
      let az = 0;
      for (const r of spf) az += num(r.weight) * num(s[r.column]);
      this.structurePf[p] = az;
      this.grc[p] = sizing[p].grc; this.avfType.push(sizing[p].avfType);
      this.keyDim[p] = sizing[p].keyDim; this.keyDimAvf[p] = sizing[p].keyDimAvf;
      this.nGroup[p] = num(s.number_in_group);
      const L = num(s.length_m);
      this.lengthGroup[p] = L <= 10 ? 0 : L <= 20 ? 10.0001 : 20.0001;
      this.delayRate[p] = num(rs.traffic.get(key(s.traffic))?.daily_delay_rate);
      const c = codes.get(sizing[p].avfType);
      this.code4[p] = num(c?.code_ecs4); this.code5[p] = num(c?.code_ecs5);
    });
    for (const r of rs.t.traffic_delay_days) this.delayDays.set(`${Math.round(r.length_over_m * 1e4) / 1e4}|${Math.trunc(r.restriction_code)}`, num(r.days));
    this.delayMult = rs.constants.traffic_delay_extra_multiplier ?? 1;
    this.replaceMult = this.settings.replaceMultiplier || rs.constants.replace_vs_repair_grc_multiplier;
  }

  private elementStaticPlan() {
    const rs = this.rs, E = this.inv.elements, ne = this.ne;
    this.seq = Int32Array.from(E, (e) => (Number.isFinite(+e.element_seq) && e.element_seq !== null ? Math.trunc(+e.element_seq) : -1));
    this.impPos = Int32Array.from(this.st.importance, (i) => IMPORTANCE_POS[i] ?? 0);
    this.ecfBase = Float64Array.from(this.st.importance, (i) => ECF_BASE[i] ?? 0);
    this.life = this.st.etypeKey.map((k) => rs.elementTypes.get(k)?.life ?? "");
    for (const r of rs.t.deterioration) {
      const k = key(r.material) + "|" + key(r.exposure);
      if (!this.detRows.has(k)) this.detRows.set(k, { frac: Object.keys(r).filter((c) => c.startsWith("frac_")).map((c) => num(r[c])), mttf: num(r.mttf) });
    }
    this.codes = rs.condition.map((r) => r.code);
    this.ecsList = rs.ecsList;
    this.teod = rs.condition.map((r) => num(r.teod));
    this.ext = rs.condition.map((r) => [num(r.ext_s2), num(r.ext_s3), num(r.ext_s4), num(r.ext_s5)]);
    const rules = rs.t.intervention_rules;
    const def = STRATEGIES[key(this.settings.strategy)] ?? "trigger_mid";
    this.strategyCol = E.map((e) => (typeof e.intervention_threshold === "string" && e.intervention_threshold
      ? STRATEGIES[key(e.intervention_threshold)] ?? def : def));
    for (const col of Object.values(STRATEGIES)) {
      const d = new Map<string, number>();
      rules.forEach((r, i) => { const k = key(r[col]) + "|" + key(r.material) + "|" + key(r.exposure); if (!d.has(k)) d.set(k, i + 1); });
      this.ruleLookup[col] = d;
    }
    const acts = rs.t.maintenance_actions;
    const actId = new Map<string, number>();
    acts.forEach((a, i) => { if (!actId.has(key(a.action))) actId.set(key(a.action), i + 1); });
    this.ruleAction = Int32Array.from(rules, (r) => actId.get(key(r.action)) ?? -10);
    this.ruleActionName = rules.map((r) => r.action);
    this.ruleAfterEcs = Float64Array.from(rules, (r) => { const p = rs.conditionPos.get(key(r.condition_after)); return p === undefined ? NaN : this.ecsList[p]; });
    this.actType = acts.map((a) => a.cost_type);
    this.actFixed = Float64Array.from(acts, (a) => num(a.fixed_rate));
    this.actConst = Float64Array.from(acts, (a) => num(a.constant_rate));
    this.actVar = acts.map((a) => Float64Array.from([num(a.var_rate_s2), num(a.var_rate_s3), num(a.var_rate_s4), num(a.var_rate_s5)]));
    this.actRate = Float64Array.from(acts, (a) => num(a.work_rate));
    const tmRate = new Map(rs.t.tm_arrangements.map((r) => [r.arrangement, num(r.rate_per_hour)]));
    this.tmCodeRate = Float64Array.from(TM_CODES, (c) => tmRate.get(TM_CODE_ARR[key(c)]) ?? 0);
    const epf = (this.inv.settings?.priority_factor_weights ?? rs.t.priority_factor_weights).filter((r: Row) => r.level === "element");
    this.elementPf = new Float64Array(ne);
    E.forEach((e, i) => {
      let ad = 0;
      for (const r of epf) ad += num(r.weight) * num(e[r.column]);
      this.elementPf[i] = ad + (this.pos[i] >= 0 ? this.structurePf[this.pos[i]] : 0);
    });
    this.startPos = Int32Array.from(E, (e) => rs.conditionPos.get(key(e.condition_code)) ?? -1);
    this.startEcs = Float64Array.from(this.startPos, (p) => (p >= 0 ? this.ecsList[p] : 0));
  }

  private plannedAndRoutine() {
    for (const r of this.inv.planned || []) {
      const p = this.rs.conditionPos.get(key(r.condition_after));
      const ecs = p === undefined ? 0 : this.ecsList[p];
      const k = `${Math.trunc(+r.element_seq)}|${Math.trunc(+r.year_of_work)}`;
      const [c, e0] = this.planned.get(k) ?? [0, 0];
      this.planned.set(k, [c + num(r.total_cost), e0 + ecs]);
    }
    for (const r of this.inv.routine || []) {
      let t = 0;
      for (const [c, v] of Object.entries(r)) if (c !== "year") t += num(v);
      this.routine.set(Math.trunc(+r.year), (this.routine.get(Math.trunc(+r.year)) ?? 0) + t);
    }
  }

  plannedCost(pred: (y: number) => boolean): number {
    let t = 0;
    for (const [k, [c]] of this.planned) if (pred(+k.split("|")[1])) t += c;
    return t;
  }

  addon(kind: string, x: number): number { return this.rs.addon(kind, x); }

  startDraws(): Float64Array {
    const r = this.settings.random;
    if (r === "savi") return vbaRndDraws(this.ne);
    if (r === "midpoint") return new Float64Array(this.ne).fill(0.5);
    const g = mulberry32(r as number);
    return Float64Array.from({ length: this.ne }, () => g());
  }

  initialState(draws?: Float64Array): State {
    const d = draws ?? this.startDraws();
    const e = this.ecsList;
    const precise = new Float64Array(this.ne);
    for (let i = 0; i < this.ne; i++) {
      const p = this.startPos[i];
      const nxt = p < 0 ? 0 : p === 16 ? e[16] : e[Math.min(p + 1, 16)];
      precise[i] = this.startEcs[i] + d[i] * (nxt - this.startEcs[i]);
    }
    return { pos: this.startPos.slice(), ecs: this.startEcs.slice(), precise };
  }

  applyCondition(state: State, changes: Record<number, string>): State {
    const s: State = { pos: state.pos.slice(), ecs: state.ecs.slice(), precise: state.precise.slice() };
    for (const [i, code] of Object.entries(changes)) {
      const p = this.rs.conditionPos.get(key(code));
      if (p === undefined) throw new Error(`Unknown condition code ${code}`);
      const e = this.ecsList, nxt = p === 16 ? e[16] : e[p + 1];
      s.pos[+i] = p; s.ecs[+i] = e[p]; s.precise[+i] = e[p] + 0.5 * (nxt - e[p]);
    }
    return s;
  }

  private det(i: number, expKey: string) { return this.detRows.get(this.st.matKey[i] + "|" + expKey); }

  /** Steps 1-6 for one year (Yn) or the 5-year pot (Y5). */
  pass(state: State, budgetAvailable: number, considerLimit: number, lookup: PlannedLookup, ov?: YearOverrides): PassResult {
    const ne = this.ne, ns = this.ns, rs = this.rs, s = this.settings, pos = this.pos, st = this.st;
    const { pos: posC, ecs: C, precise: D } = state;
    const J = exposures(st, ns, C, rs);
    const K = new Float64Array(ne), M = new Int32Array(ne), N = new Int32Array(ne);
    const F = new Float64Array(ne), O = new Float64Array(ne), P = new Float64Array(ne), Q = new Float64Array(ne);
    const U = new Float64Array(ne), W = new Float64Array(ne), AB = new Float64Array(ne), planned = new Uint8Array(ne);
    const T = new Float64Array(ne);
    const reject = new Set(ov?.reject ?? []);
    const f1 = rs.weights.f1;
    for (let i = 0; i < ne; i++) {
      const jk = key(J[i]);
      const d = this.det(i, jk);
      K[i] = xlRound((d ? d.mttf : 0) * s.deteriorationFactor * this.ttfFactor[i], 0);
      planned[i] = lookup(this.seq[i]) !== undefined ? 1 : 0;
      M[i] = -10;
      if (!planned[i]) {
        const ck = posC[i] >= 0 ? key(this.codes[posC[i]]) : "";
        M[i] = this.ruleLookup[this.strategyCol[i]].get(`${ck}|${st.matKey[i]}|${jk}`) ?? -10;
      }
      if (reject.has(i)) M[i] = -10;
      N[i] = M[i] > 0 ? this.ruleAction[M[i] - 1] : -10;
      // priority
      const eb = this.ecfBase[i];
      const ecf = eb > 0 ? eb - (D[i] - 1) * eb / 4 : 0;
      F[i] = D[i] === 0 || st.eif[i] === 0 ? 0 : Math.max(D[i] - ecf, 1);
      O[i] = N[i] === -10 ? 0 : xlRound(f1 * F[i] + (pos[i] >= 0 ? this.networkPriority[pos[i]] : 0), 2);
      const hi = this.impPos[i] > 2, lo = this.impPos[i] < 3;
      const b5 = (hi && s.extraVhHEcs5) || (lo && s.extraMlEcs5), b4 = (hi && s.extraVhHEcs4) || (lo && s.extraMlEcs4);
      P[i] = jk === "protected" ? 0 : (C[i] >= 5 && b5 ? 5000 : 0) + (C[i] >= 4 && C[i] < 5 && b4 ? 400 : 0) + this.elementPf[i];
      Q[i] = O[i] + P[i];
      // cost
      const a = Math.max(N[i] - 1, 0);
      const ct = N[i] > 0 ? this.actType[a] : "";
      const sp = posC[i] >= 0 ? posC[i] : 1;
      const teod = this.teod[sp];
      T[i] = ct === "Fixed" ? 1 : st.size[i] * (ct === "Constant" ? 1 : ct === "Variable" ? teod : 0);
      let u = 0;
      if (N[i] > 0) {
        if (ct === "Fixed") u = this.actFixed[a];
        else if (ct === "Constant") u = this.actConst[a] * T[i];
        else if (ct === "Variable") { const v = this.actVar[a], x = this.ext[sp]; u = (v[0] * x[0] + v[1] * x[1] + v[2] * x[2] + v[3] * x[3]) / teod * T[i]; }
      }
      U[i] = u;
      const hasTm = N[i] > 0 && st.tmCodeIdx[i] >= 0;
      W[i] = hasTm ? T[i] / this.actRate[a] : 0;
      const X = hasTm ? W[i] * this.tmCodeRate[st.tmCodeIdx[i]] : 0;
      if (N[i] > 0) {
        const fP = this.addon("fP", u), fO = this.addon("fO", u), fD = this.addon("fD", u * (1 + fP + fO) + X);
        AB[i] = xlRound(u * (1 + fP + fO + fD + fP * fD + fO * fD) + X * (1 + fD), 2);
      }
    }
    // consider for scheme: eligible elements in priority order
    const order: number[] = [];
    for (let i = 0; i < ne; i++) if (N[i] !== -10) order.push(i);
    order.sort((a, b) => Q[b] - Q[a] || a - b);
    const AE = new Uint8Array(ne);
    let cum = 0;
    for (const i of order) { cum += AB[i]; AE[i] = cum <= considerLimit ? 1 : 0; }
    for (const i of ov?.force ?? []) AE[i] = N[i] > 0 ? 1 : 0;
    // structure schemes
    const tmAll = this.tmDurations(W, null), tmDes = this.tmDurations(W, AE);
    const BL = new Float64Array(ns), CL = new Float64Array(ns), AFs = new Float64Array(ns);
    for (let i = 0; i < ne; i++) {
      const p = pos[i];
      if (p < 0) continue;
      BL[p] += U[i]; CL[p] += U[i] * AE[i]; AFs[p] += Q[i] * AE[i];
    }
    const workbank = new Float64Array(ns), CM = new Float64Array(ns), CO = new Float64Array(ns), DA = new Float64Array(ns);
    const DC = new Float64Array(ns), CF = new Float64Array(ns), DD = new Float64Array(ns), action = new Int32Array(ns), DF = new Float64Array(ns);
    for (let p = 0; p < ns; p++) {
      workbank[p] = this.schemeCost(BL[p], tmAll, p);
      CM[p] = this.addon("fP", CL[p]); CO[p] = this.addon("fO", CL[p]);
      let CZ = 0;
      for (let c = 0; c < NT; c++) CZ += tmDes[p * NT + c] * this.tmCodeRate[c];
      DA[p] = this.addon("fD", CL[p] * (1 + CM[p] + CO[p]) + CZ);
      const L = CL[p];
      DC[p] = L + CM[p] * L + CO[p] * L + CZ + DA[p] * (L + CM[p] * L + CO[p] * L + CZ);
      CF[p] = xlRound(AFs[p], 2);
      DD[p] = this.grc[p] * this.replaceMult;
      action[p] = DC[p] === 0 ? 0 : DD[p] < DC[p] ? 2 : 1;
      DF[p] = action[p] === 2 ? DD[p] : action[p] === 1 ? DC[p] : 0;
    }
    const sOrder: number[] = [];
    for (let p = 0; p < ns; p++) if (CF[p] > 0) sOrder.push(p);
    sOrder.sort((a, b) => CF[b] - CF[a] || a - b);
    const DG = new Int32Array(ns), DH = new Float64Array(ns), rank = new Int32Array(ns), cumAll = new Float64Array(ns);
    let cs = 0;
    sOrder.forEach((p, k) => {
      cs += DF[p];
      cumAll[p] = cs; rank[p] = k + 1;
      if (budgetAvailable - cs >= 0) DG[p] = action[p];
      DH[p] = DG[p] > 0 ? DF[p] : 0;
    });
    // element status and costs
    const DN = new Int32Array(ne), DV = new Float64Array(ne), DW = new Float64Array(ne), DX = new Float64Array(ne);
    const sumW = new Float64Array(ns * NT);
    for (let i = 0; i < ne; i++) if (pos[i] >= 0 && st.tmCodeIdx[i] >= 0) sumW[pos[i] * NT + st.tmCodeIdx[i]] += W[i];
    for (let i = 0; i < ne; i++) {
      const p = pos[i], valid = p >= 0, dgs = valid ? DG[p] : 0;
      DN[i] = planned[i] ? 3 : valid && dgs === 2 ? 2 : !valid || !AE[i] ? 0 : dgs === 1 ? 1 : 0;
      if (DN[i] === 1) {
        const pP = CM[p], pO = CO[p], pD = DA[p], u = U[i];
        let DS = 0;
        if (W[i] !== 0) {
          const ci = Math.max(st.tmCodeIdx[i], 0);
          DS = W[i] / sumW[p * NT + ci] * tmDes[p * NT + ci] * this.tmCodeRate[ci];
          if (!Number.isFinite(DS)) DS = Number.isNaN(DS) ? 0 : DS > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
        }
        DV[i] = u + u * pP + u * pO + DS + pD * (u + DS + u * pP + u * pO);
      }
      if (DN[i] === 2) { const v = U[i] / BL[p] * DH[p]; DW[i] = Number.isFinite(v) ? v : 0; }
      if (DN[i] === 3) DX[i] = lookup(this.seq[i])![0];
    }
    return { J, K, M, N, Q, O, P, F, U, W, AB, AE, DN, DV, DW, DX, workbank, CF, DC, DD, action, DF, DG, DH, rank,
      cum: cumAll, fP: CM, fO: CO, fD: DA, planned, budgetAvailable, considerLimit };
  }

  /** Combined TM durations per structure (Part A 2.11.6); flat ns x 9. */
  private tmDurations(W: Float64Array, mask: Uint8Array | null): Float64Array {
    const ns = this.ns, mx = new Float64Array(ns * NT);
    for (let i = 0; i < this.ne; i++) {
      const p = this.pos[i], c = this.st.tmCodeIdx[i];
      if (p < 0 || c < 0 || (mask && !mask[i])) continue;
      const k = p * NT + c;
      mx[k] = Number.isNaN(W[i]) || Number.isNaN(mx[k]) ? NaN : Math.max(mx[k], W[i]);
    }
    const d = new Float64Array(ns * NT);
    for (let p = 0; p < ns; p++) {
      const o = p * NT, m = (k: number) => mx[o + k];
      d[o] = m(0);
      d[o + 1] = Math.max(m(1) - d[o], 0);
      d[o + 2] = Math.max(m(2) - d[o] - d[o + 1], 0);
      d[o + 3] = Math.max(m(3) - d[o + 2], 0); // SAVI subtracts only the hardshoulder term
      d[o + 4] = Math.max(m(4), 0);
      d[o + 5] = Math.max(m(5) - d[o + 4], 0);
      d[o + 6] = Math.max(m(6) - d[o + 5] - d[o + 4], 0);
      d[o + 7] = Math.max(m(7), 0);
      d[o + 8] = Math.max(m(8), 0);
    }
    return d;
  }

  private schemeCost(works: number, tm: Float64Array, p: number): number {
    const fP = this.addon("fP", works), fO = this.addon("fO", works);
    let tmc = 0;
    for (let c = 0; c < NT; c++) tmc += tm[p * NT + c] * this.tmCodeRate[c];
    const base = works + fP * works + fO * works + tmc;
    return base + this.addon("fD", base) * base;
  }

  /** One year of deterioration along the material curve (Yn!DZ:EF). */
  deteriorate(state: State, K: Float64Array, J: string[]): Float64Array {
    const e = this.ecsList, out = new Float64Array(this.ne);
    for (let i = 0; i < this.ne; i++) {
      const S = state.pos[i] >= 0 ? state.pos[i] : 1, C = state.ecs[i], D = state.precise[i];
      const is5e = S === 16;
      const d = this.det(i, key(J[i]));
      const fr = (k: number) => (d && k <= 16 ? d.frac[k] : NaN);
      const nxt = S + 1 <= 16 ? e[S + 1] : NaN, nxt2 = S + 2 <= 16 ? e[S + 2] : NaN;
      const fa = fr(Math.min(S, 16)), fb = fr(S + 1), fc = fr(S + 2);
      const DZ = is5e ? 0 : nxt - D;
      const ED = (nxt - C) / (fb - fa) / K[i], EE = (nxt2 - nxt) / (fc - fb) / K[i];
      const ratio = DZ / ED;
      const ef = ratio >= 1 ? D + ED : D + ED * ratio + EE * (1 - ratio);
      out[i] = Number.isFinite(ratio) && Number.isFinite(ef) && !is5e ? Math.min(ef, 5) : Math.min(D, 5);
    }
    return out;
  }

  /** Reported ECS and code position from a precise ECS (Yn!EH:EI). */
  snap(eg: Float64Array): { rep: Float64Array; pos: Int32Array } {
    const e = this.ecsList, n = eg.length, rep = new Float64Array(n), pos = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const g = eg[i];
      let r: number;
      if (g > 5 && g <= e[14]) r = e[14];
      else if (g > e[14] && g <= e[15]) r = e[15];
      else if (g > e[15]) r = e[16];
      else if (Number.isNaN(g)) r = e[16]; // numpy sorts NaN last
      else {
        const rd = xlRoundDown1(g);
        let k = -1;
        for (let j = 0; j < e.length; j++) if (e[j] <= rd) k = j;
        r = k >= 0 ? e[k] : 0;
      }
      rep[i] = r;
      let k = e.findIndex((x) => x >= r);
      pos[i] = k >= 0 && e[k] === r ? k : -1;
    }
    return { rep, pos };
  }

  evaluate(reported: Float64Array, precise: Float64Array): Evaluation {
    const ns = this.ns, ne = this.ne, st = this.st, c = this.rs.constants;
    const eci = new Float64Array(ne), sumEif = new Float64Array(ns), sumEx = new Float64Array(ns);
    const maxVh = new Float64Array(ns), maxEp = new Float64Array(ns);
    for (let i = 0; i < ne; i++) {
      const eb = this.ecfBase[i], ecf = eb > 0 ? eb - (reported[i] - 1) * eb / 4 : 0;
      eci[i] = st.eif[i] === 0 ? 0 : Math.max(reported[i] - ecf, 1);
      const p = this.pos[i];
      if (p < 0) continue;
      sumEif[p] += st.eif[i]; sumEx[p] += eci[i] * st.eif[i];
      if (st.eif[i] === 2) maxVh[p] = Math.max(maxVh[p], eci[i]);
      const ep = st.eif[i] === 2 || st.eif[i] === 1.5 ? precise[i] : 0;
      maxEp[p] = Math.max(maxEp[p], ep);
    }
    const sciAv = new Float64Array(ns), sciCrit = new Float64Array(ns), sgr = new Float64Array(ns), delay = new Float64Array(ns), atRisk = new Float64Array(ns);
    for (let p = 0; p < ns; p++) {
      const m = sumEif[p] === 0 ? 0 : sumEx[p] / sumEif[p];
      sciAv[p] = sumEif[p] === 0 ? 0 : Math.min(115 - 2 * m * (m + 6.5), 100);
      sciCrit[p] = Math.min(Math.max(115 - 2 * maxVh[p] * (maxVh[p] + 6.5), 0), 100);
      sgr[p] = sciAv[p] > c.sgr_sci_av_threshold && sciCrit[p] > c.sgr_sci_crit_threshold ? 1 : 0;
      const cm = xlCmp(maxEp[p]);
      const band = cm >= 5 ? 5 : cm >= 4 ? 4 : 0;
      const code = band === 4 ? this.code4[p] : band === 5 ? this.code5[p] : 0;
      const days = band ? this.delayDays.get(`${this.lengthGroup[p]}|${Math.trunc(code)}`) ?? 0 : 0;
      delay[p] = band ? this.delayRate[p] * days * this.delayMult : 0;
      atRisk[p] = delay[p] > 0 ? this.nGroup[p] : 0;
    }
    return { eci, sciAv, sciCrit, sgr, delay, atRisk };
  }

  stockMetrics(ev: Evaluation): Record<string, number> {
    const out: Record<string, number> = {}, kd = this.keyDim, kda = this.keyDimAvf, ns = this.ns;
    const ratio = (n: number, d: number) => (d ? n / d : 0);
    const groups = AVF_GROUPS.filter(([t]) => t !== "AVF_Other");
    const agg = (val: Float64Array, w: Float64Array, t?: string) => {
      let n = 0, d = 0;
      for (let p = 0; p < ns; p++) if (!t || this.avfType[p] === t) { n += val[p] * w[p]; d += w[p]; }
      return ratio(n, d);
    };
    const total = (val: Float64Array, f: (p: number) => boolean) => { let s = 0; for (let p = 0; p < ns; p++) if (f(p)) s += val[p]; return s; };
    for (const [metric, val] of [["ssci_av", ev.sciAv], ["ssci_crit", ev.sciCrit]] as const) {
      for (const [t, label] of groups) out[`${metric}|${label}`] = agg(val, kd, t);
      out[`${metric}|Full Stock`] = agg(val, kda);
    }
    const bands: [string, number][] = [["Very good", 90], ["Good", 80], ["Fair", 65], ["Poor", 40], ["Very poor", -Infinity]];
    const taken = new Uint8Array(ns);
    for (const [name, lo] of bands) {
      let s = 0;
      for (let p = 0; p < ns; p++) if (!taken[p] && ev.sciAv[p] >= lo) { s += this.nGroup[p]; taken[p] = 1; }
      out[`band|${name}`] = s;
    }
    for (const [t, label] of groups) out[`sss|${label}`] = agg(ev.sgr, kd, t);
    out["sss|Full Stock"] = agg(ev.sgr, kda);
    for (const [t, label] of groups) out[`at_risk|${label}`] = total(ev.atRisk, (p) => this.avfType[p] === t);
    out["at_risk|Stock"] = total(ev.atRisk, () => true);
    for (const [lg, name] of [[0, "0-10m"], [10.0001, "10-20m"], [20.0001, "20m+"]] as const)
      out[`at_risk_len|${name}`] = total(ev.atRisk, (p) => Math.abs(this.lengthGroup[p] - lg) < 1e-8);
    for (const [t, label] of groups) out[`delay|${label}`] = total(ev.delay, (p) => this.avfType[p] === t);
    out["delay|Stock"] = total(ev.delay, () => true);
    return out;
  }

  private rateFor(y: number): number {
    for (const r of this.rs.t.discount_rates) if (r.from_year <= y && y <= r.to_year) return num(r.rate);
    return 0;
  }

  /** SAVI run_LAMPlan_NCycle: years 1..N, then the workbank year N+1. */
  runLongTerm(opts: { draws?: Float64Array; overrides?: Record<number, YearOverrides>; conditionOverrides?: Record<number, string> } = {}): LongTermResult {
    const s = this.settings;
    let state = this.initialState(opts.draws);
    if (opts.conditionOverrides && Object.keys(opts.conditionOverrides).length) state = this.applyCondition(state, opts.conditionOverrides);
    const rows: Row[] = [], profile: Float64Array[] = [state.ecs.slice()], works: WorkItem[] = [];
    let carry = 0, factor = 1, workbankEnd = 0;
    const y0 = this.stockMetrics(this.evaluate(state.ecs, state.precise));
    for (const k of Object.keys(y0)) if ((k.startsWith("at_risk|") || k.startsWith("delay|")) && !k.endsWith("|Stock")) y0[k] = 0; // D-013
    const finite = this.life.map((l) => l === "Finite"), indef = this.life.map((l) => l === "Indefinite");
    for (let year = 1; year <= s.years + 1; year++) {
      const last = year === s.years + 1;
      const userBudget = last ? 1e-10 : budgetFor(s, year);
      if (last) carry = 1e9;
      const budget = userBudget + carry;
      const plannedCost = this.plannedCost((y) => y === year);
      const routine = this.routine.get(year) ?? 0;
      const bf = Math.max(budget / userBudget + 0.5, s.longTermMinBudgetFactor);
      const avail = budget - (plannedCost + routine);
      const r = this.pass(state, avail, bf * avail, (seq) => this.planned.get(`${seq}|${year}`), opts.overrides?.[year]);
      let workbank = 0;
      for (const v of r.workbank) workbank += v;
      if (last) { workbankEnd = workbank; break; }
      let expenditure = 0;
      for (const v of r.DH) expenditure += v;
      if (year > 1) factor = factor / (1 + this.rateFor(year));
      const ef = this.deteriorate(state, r.K, r.J);
      const eg = new Float64Array(this.ne);
      for (let i = 0; i < this.ne; i++) {
        const dn = r.DN[i];
        eg[i] = state.precise[i] === 0 ? 0 : dn === 3 ? (this.planned.get(`${this.seq[i]}|${year}`)?.[1] ?? 0)
          : dn === 2 ? 1 : dn === 1 ? (r.M[i] > 0 ? this.ruleAfterEcs[r.M[i] - 1] : NaN) : ef[i];
      }
      const { rep, pos } = this.snap(eg);
      const stock = this.stockMetrics(this.evaluate(rep, eg));
      let ctF = 0, dyF = 0, ctI = 0, dyI = 0;
      for (let i = 0; i < this.ne; i++) {
        const ct = r.DV[i] + r.DW[i], dy = ct + r.DX[i];
        if (finite[i]) { ctF += ct; dyF += dy; }
        if (indef[i]) { ctI += ct; dyI += dy; }
      }
      const row: Row = { year, years: s.years, start_budget: userBudget, budget, budget_factor: bf, workbank, expenditure,
        discounted_expenditure: expenditure * factor, planned: plannedCost, routine, carry_in: carry,
        remaining: budget - (expenditure + plannedCost + routine), ct_finite: ctF, planned_finite: dyF - ctF,
        ct_indefinite: ctI, planned_indefinite: dyI - ctI, condition_triggered: expenditure, ...stock };
      rows.push(row);
      works.push(...this.workItems(year, r, state, eg));
      profile.push(rep.slice());
      carry = s.carryForward ? row.remaining : 0;
      state = { pos, ecs: rep, precise: eg };
    }
    return new LongTermResult(this, [{ year: 0, ...y0 }, ...rows], workbankEnd, profile, works, state);
  }

  workItems(year: number, r: PassResult, state: State, eg: Float64Array): WorkItem[] {
    const out: WorkItem[] = [], S = this.inv.structures, E = this.inv.elements;
    for (let i = 0; i < this.ne; i++) {
      const dn = r.DN[i];
      if (dn <= 0) continue;
      const p = this.pos[i];
      out.push({ year, element_index: i, element_seq: this.seq[i], structure_index: p, structure_id: S[p]?.structure_id,
        element_type: E[i].element_type, material: E[i].material,
        status: dn === 1 ? "Maintain" : dn === 2 ? "Replace structure" : "Planned",
        action: dn === 1 && r.M[i] > 0 ? this.ruleActionName[r.M[i] - 1] : dn === 2 ? "Structure replaced" : "Planned work",
        condition_before: state.pos[i] >= 0 ? this.codes[state.pos[i]] : "", ecs_before: state.ecs[i], ecs_after: eg[i],
        priority: r.Q[i], structure_rank: r.rank[p], cost: r.DV[i] + r.DW[i] + r.DX[i], works_cost: r.U[i], exposure: r.J[i] });
    }
    return out;
  }

  /** Forecasting tier 2: Monte Carlo over time to failure (+/- spread) and start position in band. Planning only. */
  runUncertainty(opts: { runs?: number; seed?: number; spread?: number; metrics?: string[]; onProgress?: (k: number) => void } = {}) {
    const runs = opts.runs ?? 20, seed = opts.seed ?? 0, spread = opts.spread ?? 0.2;
    const metrics = opts.metrics ?? ["ssci_av|Full Stock", "ssci_crit|Full Stock", "expenditure", "workbank", "at_risk|Stock"];
    const g = mulberry32(seed + 1);
    const saved = this.ttfFactor;
    const series: Record<string, number[][]> = Object.fromEntries(metrics.map((m) => [m, []]));
    try {
      for (let k = 0; k < runs; k++) {
        this.ttfFactor = Float64Array.from({ length: this.ne }, () => 1 - spread + 2 * spread * g());
        const res = this.runLongTerm({ draws: Float64Array.from({ length: this.ne }, () => g()) });
        for (const m of metrics) series[m].push(res.table.map((r) => (r[m] === undefined ? NaN : r[m])));
        opts.onProgress?.(k + 1);
      }
    } finally { this.ttfFactor = saved; }
    const years = series[metrics[0]][0].map((_, y) => y);
    const out: Record<string, any> = { runs, seed, spread, years };
    for (const m of metrics) {
      const q = (p: number) => years.map((y) => percentile(series[m].map((r) => r[y]), p));
      out[m] = { p10: q(10), p50: q(50), p90: q(90) };
    }
    return out;
  }

  /** SAVI Y5: one prioritisation against the 5-year pot; schemes scheduled into years. */
  runFiveYear(opts: { draws?: Float64Array; overrides?: YearOverrides; conditionOverrides?: Record<number, string> } = {}): FiveYearResult {
    const s = this.settings, ne = this.ne;
    let state = this.initialState(opts.draws);
    if (opts.conditionOverrides && Object.keys(opts.conditionOverrides).length) state = this.applyCondition(state, opts.conditionOverrides);
    const total = s.fiveYearAnnualBudget * 5;
    const planned5 = new Map<number, [number, number]>();
    for (const [k, v] of this.planned) {
      const [e, y] = k.split("|").map(Number);
      if (y <= 5) { const c = planned5.get(e) ?? [0, 0]; planned5.set(e, [c[0] + v[0], v[1]]); }
    }
    const plannedCost = this.plannedCost((y) => y <= 5);
    let routine = 0;
    for (let y = 1; y <= 5; y++) routine += this.routine.get(y) ?? 0;
    const avail = total - (plannedCost + routine);
    const r = this.pass(state, avail, s.fiveYearBudgetFactor * avail, (seq) => planned5.get(seq), opts.overrides);
    const schedule = Int32Array.from(r.cum, (c, p) => (r.rank[p] > 0 ? (c <= total / 5 ? 1 : c <= 2 * total / 5 ? 2 : c <= 3 * total / 5 ? 3 : c <= 4 * total / 5 ? 4 : c <= total ? 5 : 6) : 0));
    const e = this.ecsList, ED = new Float64Array(ne);
    for (let i = 0; i < ne; i++) {
      const S = state.pos[i] >= 0 ? state.pos[i] : 1, C = state.ecs[i], D = state.precise[i];
      const d = this.det(i, key(r.J[i]));
      const fa = d ? d.frac[Math.min(S, 16)] : NaN, fb = d && S + 1 <= 16 ? d.frac[S + 1] : NaN;
      const nxt = S + 1 <= 16 ? e[S + 1] : NaN;
      let EB = 5 * (nxt - C) / ((fb - fa) * r.K[i]);
      if (!Number.isFinite(EB)) EB = 0;
      const dn = r.DN[i];
      // planned works do not reset condition in SAVI's Y5 (D-012)
      ED[i] = D === 0 ? 0 : dn === 2 ? 1 : dn === 1 ? (r.M[i] > 0 ? this.ruleAfterEcs[r.M[i] - 1] : NaN) : D + EB;
    }
    const { rep } = this.snap(ED);
    const ev = this.evaluate(rep, ED);
    const stock = this.stockMetrics(ev);
    let exp = 0, ctF = 0, ctI = 0, maint = 0, funded = 0;
    for (let i = 0; i < ne; i++) {
      const ct = r.DV[i] + r.DW[i];
      exp += ct;
      if (this.life[i] === "Finite") ctF += ct;
      if (this.life[i] === "Indefinite") ctI += ct;
      if (r.DN[i] === 1) maint++;
    }
    for (const g of r.DG) if (g > 0) funded++;
    const summary: Record<string, number> = { annual_budget: s.fiveYearAnnualBudget, total_budget: total, budget_factor: s.fiveYearBudgetFactor,
      expenditure: exp, planned: plannedCost, routine, remaining: total - (exp + plannedCost + routine), ct_finite: ctF,
      ct_indefinite: ctI, schemes_funded: funded, elements_maintained: maint, ...stock };
    const works = this.workItems(0, r, state, ED);
    for (const w of works) w.year = schedule[w.structure_index];
    return new FiveYearResult(this, summary, r, schedule, works, rep, ED, ev, state);
  }
}

export class LongTermResult {
  constructor(public model: PlanningModel, public table: Row[], public workbankEnd: number,
    public ecsProfile: Float64Array[], public works: WorkItem[], public endState: State) {}
  totals() {
    const t = this.table.filter((r) => r.year > 0), sumOf = (c: string) => t.reduce((a, r) => a + r[c], 0), last = t[t.length - 1];
    return { years: last.year, total_budget: sumOf("start_budget"), expenditure: sumOf("expenditure"),
      discounted_expenditure: sumOf("discounted_expenditure"), planned: sumOf("planned"), routine: sumOf("routine"),
      workbank_end: this.workbankEnd, ssci_av_end: last["ssci_av|Full Stock"], ssci_crit_end: last["ssci_crit|Full Stock"] };
  }
}

export interface Project { rank: number; year: number; structure_index: number; structure_id: string; structure_name: string;
  structure_type: string; priority_score: number; action: "Replace" | "Maintain"; cost: number; elements: number }

export class FiveYearResult {
  constructor(public model: PlanningModel, public summary: Record<string, number>, public detail: PassResult,
    public schedule: Int32Array, public works: WorkItem[], public reportedEcs: Float64Array, public preciseEcs: Float64Array,
    public evaluation: Evaluation, public startState: State) {}
  /** SAVI Project List: funded structures in priority order. */
  projects(): Project[] {
    const m = this.model, d = this.detail, S = m.inv.structures, out: Project[] = [];
    const count = new Map<number, number>();
    for (const w of this.works) count.set(w.structure_index, (count.get(w.structure_index) ?? 0) + 1);
    for (let p = 0; p < m.ns; p++) if (d.DG[p] > 0)
      out.push({ rank: d.rank[p], year: this.schedule[p], structure_index: p, structure_id: S[p].structure_id, structure_name: S[p].name,
        structure_type: S[p].structure_type, priority_score: d.CF[p], action: d.DG[p] === 2 ? "Replace" : "Maintain", cost: d.DH[p],
        elements: count.get(p) ?? 0 });
    return out.sort((a, b) => a.rank - b.rank);
  }
  /** Structures that needed a scheme but were not funded (the backlog the budget cannot reach). */
  unfunded(): Project[] {
    const m = this.model, d = this.detail, S = m.inv.structures, out: Project[] = [];
    for (let p = 0; p < m.ns; p++) if (d.rank[p] > 0 && d.DG[p] === 0)
      out.push({ rank: d.rank[p], year: this.schedule[p], structure_index: p, structure_id: S[p].structure_id, structure_name: S[p].name,
        structure_type: S[p].structure_type, priority_score: d.CF[p], action: d.action[p] === 2 ? "Replace" : "Maintain", cost: d.DF[p], elements: 0 });
    return out.sort((a, b) => a.rank - b.rank);
  }
}

export const LAMP_COLUMNS: Record<string, string> = {
  C: "start_budget", D: "budget", E: "budget_factor", F: "workbank", G: "expenditure", H: "discounted_expenditure",
  I: "planned", J: "routine", K: "carry_in", L: "remaining", M: "ct_finite", N: "planned_finite", O: "ct_indefinite",
  P: "planned_indefinite", Q: "condition_triggered",
  R: "ssci_av|Bridges", S: "ssci_av|Retaining Walls", T: "ssci_av|Culverts", U: "ssci_av|Sign/Signal Gantries",
  V: "ssci_av|High Mast Lighting", W: "ssci_av|Tunnels and Vehicular Underpasses", X: "ssci_av|Full Stock",
  Y: "ssci_crit|Bridges", Z: "ssci_crit|Retaining Walls", AA: "ssci_crit|Culverts", AB: "ssci_crit|Sign/Signal Gantries",
  AC: "ssci_crit|High Mast Lighting", AD: "ssci_crit|Tunnels and Vehicular Underpasses", AE: "ssci_crit|Full Stock",
  AF: "band|Very good", AG: "band|Good", AH: "band|Fair", AI: "band|Poor", AJ: "band|Very poor",
  AK: "sss|Bridges", AL: "sss|Retaining Walls", AM: "sss|Culverts", AN: "sss|Sign/Signal Gantries",
  AO: "sss|High Mast Lighting", AP: "sss|Tunnels and Vehicular Underpasses", AQ: "sss|Full Stock",
  AR: "at_risk|Bridges", AS: "at_risk|Retaining Walls", AT: "at_risk|Culverts", AU: "at_risk|Sign/Signal Gantries",
  AV: "at_risk|High Mast Lighting", AW: "at_risk|Tunnels and Vehicular Underpasses", AX: "at_risk|Stock",
  AY: "at_risk_len|0-10m", AZ: "at_risk_len|10-20m", BA: "at_risk_len|20m+",
  BB: "delay|Bridges", BC: "delay|Retaining Walls", BD: "delay|Culverts", BE: "delay|Sign/Signal Gantries",
  BF: "delay|High Mast Lighting", BG: "delay|Tunnels and Vehicular Underpasses", BH: "delay|Stock",
};
