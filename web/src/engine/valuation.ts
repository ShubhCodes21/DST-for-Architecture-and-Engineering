// Year-0 engine: GRC, condition indices and the WGA valuation (port of grc.py, condition.py,
// valuation.py, run.py). Results are checked against SAVI's own figures in web/test.
import { Row, key, num } from "./core";
import { RuleSet } from "./rules";

export interface Inventory {
  name: string;
  structures: Row[];
  elements: Row[];
  planned: Row[];
  routine: Row[];
  settings: Record<string, any>;
}

export const AVF_GROUPS: [string, string][] = [
  ["AVF_Bridge", "Bridges"], ["AVF_RetainingWall", "Retaining Walls"], ["AVF_SmallCulvert", "Culverts"],
  ["AVF_SignGantry", "Sign/Signal Gantries"], ["AVF_HighMast", "High Mast Lighting"],
  ["AVF_Tunnel", "Tunnels and Vehicular Underpasses"], ["AVF_Other", "Other"],
];
const USER_ADJ = ["adj_heritage", "adj_conservation_area", "adj_environmentally_sensitive", "adj_river_coastal_wall",
  "adj_substandard", "adj_spare_1", "adj_spare_2", "adj_spare_3", "adj_spare_4", "adj_spare_5", "adj_spare_6"];
const TUNNELS = new Set(["tunnel (bored)", "tunnel (cut and cover)"]);
const RAILWAYS = new Set(["railway: freight", "railway: inter-city line", "railway: suburban, tram, underground"]);
const TENANTED = new Set(["business and community premises", "residential premises"]);
export const TM_CODES = ["RouteContraflow", "RouteShuttle Working / Lane Closure", "RouteHardshoulder Closure",
  "RouteAndObstacleRetaining Wall TM", "ObstacleContraflow", "ObstacleShuttle Working / Lane Closure",
  "ObstacleHardshoulder Closure", "ObstacleWaterway Possession", "ObstacleRailway Possession"];
export const TM_CODE_ARR: Record<string, string> = {
  routecontraflow: "Contraflow", "routeshuttle working / lane closure": "Shuttle Working / Lane Closure",
  "routehardshoulder closure": "Hardshoulder Closure", "routeandobstacleretaining wall tm": "Retaining Wall TM",
  obstaclecontraflow: "Contraflow", "obstacleshuttle working / lane closure": "Shuttle Working / Lane Closure",
  "obstaclehardshoulder closure": "Hardshoulder Closure", "obstaclewaterway possession": "Waterway Possession",
  "obstaclerailway possession": "Railway Possession",
};
const SHORT_TYPE: Record<string, string> = {
  "structural earthworks - reinforced/strengthened soil/fill structure (height > 3m)": "Structural Earthworks (height > 3m)",
  "structural earthworks - reinforced/strengthened soil/fill structure (height ≤ 3m)": "Structural Earthworks (height ≤ 3m)",
};

export interface Sizing {
  known: boolean; keyDim: number; grcRate: number; basicGrc: number; uplift: number; grc: number;
  avfType: string; avf: number; keyDimAvf: number; stf: number; tmRequired: number; flags: Record<string, number>;
}

/** Structure positions for elements: first match on structure id (case-insensitive), -1 if none. */
export function structurePositions(structures: Row[], elements: Row[]): Int32Array {
  const first = new Map<string, number>();
  structures.forEach((s, i) => { const k = key(s.structure_id); if (!first.has(k)) first.set(k, i); });
  const pos = new Int32Array(elements.length);
  elements.forEach((e, i) => (pos[i] = first.get(key(e.structure_id)) ?? -1));
  return pos;
}

export function computeSizing(s: Row, rs: RuleSet, authority: string): Sizing {
  const row = rs.structureTypes.get(key(s.structure_type));
  const known = !!row;
  const dims = [num(row?.grc_f_number) * num(s.number_in_group), num(row?.grc_f_length) * num(s.length_m),
    num(row?.grc_f_width) * num(s.width_m), num(row?.grc_f_headroom) * num(s.headroom_m)];
  const keyDim = dims.reduce((p, d) => p * (d === 0 ? 1 : d), 1);
  const grcRate = row ? num(row.grc_unit_rate) : NaN;
  const t = key(s.structure_type), loc = key(s.location), route = key(s.route_supported), obs = key(s.obstacle_crossed);
  const flags: Record<string, number> = {};
  for (const c of USER_ADJ) flags[c] = num(s[c]);
  flags.adj_tunnel_over_400m = TUNNELS.has(t) && num(s.length_m) > 400 ? 1 : 0;
  flags.adj_rural = loc === "rural" ? 1 : 0;
  flags.adj_route_unclassified = route === "local road - unclassified" ? 1 : 0;
  flags.adj_obstacle_footway = obs === "footway/cycleway" ? 1 : 0;
  flags.adj_obstacle_watercourse_non_nav = obs === "watercourse - non-navigable" ? 1 : 0;
  flags.adj_obstacle_land_disused = obs === "land/disused" ? 1 : 0;
  flags.adj_obstacle_railway = RAILWAYS.has(obs) ? 1 : 0;
  flags.adj_obstacle_tenanted_business = TENANTED.has(obs) ? 1 : 0;
  let uplift = 1;
  for (const [c, f] of Object.entries(flags)) uplift *= f === 0 ? 1 : f * rs.adjustment[c];
  const avfType = row?.avf_type ?? "";
  const avfRow = rs.avf.get(avfType);
  const avf = avfRow ? num(avfRow[authority] ?? avfRow["Local Authority"]) : 0;
  return { known, keyDim, grcRate, basicGrc: grcRate * keyDim, uplift, grc: grcRate * keyDim * uplift, avfType,
    avf, keyDimAvf: keyDim * avf, stf: num(row?.stf), tmRequired: num(row?.tm_required), flags };
}

export function elementSize(e: Row, s: Row | undefined, rs: RuleSet): number {
  const r = rs.elementTypes.get(key(e.element_type));
  const d = (c: string) => (s ? num(s[c]) : 0);
  const fSpans = num(r?.f_spans);
  const factors = [num(r?.size_multiplier), num(r?.f_number) * d("number_in_group"), num(r?.f_length) * d("length_m"),
    num(r?.f_width) * d("width_m"), num(r?.f_headroom) * d("headroom_m"), fSpans,
    fSpans === 1 ? d("spans") + num(r?.spans_offset) : 0];
  return factors.reduce((p, f) => p * (f === 0 ? 1 : f), 1);
}

/** Static per-structure exposure parameters (location, salted route, traffic, watercourse, salted obstacle). */
export function structureExposureParams(s: Row, rs: RuleSet): number[] {
  const obs = key(s.obstacle_crossed);
  return [num(rs.locations.get(key(s.location))?.exposure_factor), num(s.route_salted),
    num(rs.traffic.get(key(s.traffic))?.exposure_factor),
    obs === "watercourse - navigable" || obs === "watercourse - non-navigable" ? 1 : 0, num(s.obstacle_salted)];
}

export interface ElementStatic {
  pos: Int32Array; size: Float64Array; etypeKey: string[]; matKey: string[]; importance: string[]; eif: Float64Array;
  expStatic: Float64Array; expFlags: Float64Array[]; influenceIdx: Int32Array; tmCodeIdx: Int32Array;
}

/** Element arrays shared by valuation and planning. */
export function elementStatic(structures: Row[], elements: Row[], sizing: Sizing[], rs: RuleSet): ElementStatic {
  const pos = structurePositions(structures, elements);
  const ne = elements.length;
  const w = rs.t.exposure_weights.map((r) => num(r.weight));
  const influencing = rs.t.exposure_weights.slice(1, 15).map((r) => key(r.parameter));
  const sp = structures.map((s) => structureExposureParams(s, rs));
  const tm = [...rs.t.tm_arrangements].sort((a, b) => a.arrangement_id - b.arrangement_id);
  const tmCols = tm.map((r) => r.column), tmIds = tm.map((r) => num(r.arrangement_id)), tmNames = tm.map((r) => r.arrangement);
  const tmCodeKeys = TM_CODES.map((c) => key(c));
  const out: ElementStatic = {
    pos, size: new Float64Array(ne), etypeKey: [], matKey: [], importance: [], eif: new Float64Array(ne),
    expStatic: new Float64Array(ne), expFlags: [], influenceIdx: new Int32Array(ne), tmCodeIdx: new Int32Array(ne),
  };
  for (let i = 0; i < ne; i++) {
    const e = elements[i], p = pos[i], s = p >= 0 ? structures[p] : undefined;
    const ek = key(e.element_type), mk = key(e.material);
    const et = rs.elementTypes.get(ek);
    out.etypeKey.push(ek); out.matKey.push(mk);
    out.importance.push(et?.importance ?? "");
    out.eif[i] = num(et?.eif);
    out.size[i] = elementSize(e, s, rs);
    const flags = Array.from({ length: 21 }, (_, k) => num(et?.[`exp_flag_${String(k + 1).padStart(2, "0")}`]));
    out.expFlags.push(Float64Array.from(flags));
    out.influenceIdx[i] = influencing.indexOf(ek);
    if (et && p >= 0 && mk) {
      let code = num(et.exposure_scenario_id) * w[0];
      for (let j = 0; j < 5; j++) code += w[15 + j] * flags[14 + j] * sp[p][j];
      code += w[20] * flags[19] * num(rs.spray.get(key(e.spray_proximity))?.exposure_factor);
      code += w[21] * flags[20] * num(rs.materials.get(mk)?.protected_by_finishes);
      out.expStatic[i] = code;
    } else out.expStatic[i] = NaN;
    // traffic management code (static)
    out.tmCodeIdx[i] = -1;
    if (s && et && sizing[p].tmRequired === 1 && et.tm_location) {
      const loc: string = et.tm_location;
      const r = rs.routes.get(key(s.route_supported)), o = rs.obstacles.get(key(s.obstacle_crossed));
      let sfl: number[] | number | null = null;
      if (loc === "RouteAndObstacle" && r && o) sfl = Math.max(...tmCols.map((c) => num(r[c])), ...tmCols.map((c) => num(o[c])));
      else if (loc === "Route" && r) sfl = tmCols.map((c) => num(r[c]));
      else if (loc === "Obstacle" && o) sfl = tmCols.map((c) => num(o[c]));
      if (sfl !== null) {
        let arr = 0;
        tmCols.forEach((c, k) => (arr += tmIds[k] * (Array.isArray(sfl) ? sfl[k] : (sfl as number)) * num(et[c])));
        if (arr > 0) {
          let idx = -1;
          tmIds.forEach((v, k) => { if (v <= arr) idx = k; });
          const ci = tmCodeKeys.indexOf(key(loc + tmNames[idx]));
          out.tmCodeIdx[i] = ci;
        }
      } else out.tmCodeIdx[i] = -2; // unresolved (an error in SAVI)
    }
  }
  return out;
}

/** Exposure name per element given the current reported ECS (influencing elements count as failed at >= 4). */
export function exposures(st: ElementStatic, nStructures: number, reported: ArrayLike<number>, rs: RuleSet): string[] {
  const ne = st.pos.length;
  const counts = Array.from({ length: nStructures }, () => new Float64Array(14));
  for (let i = 0; i < ne; i++) {
    const j = st.influenceIdx[i], p = st.pos[i];
    if (j >= 0 && p >= 0) counts[p][j] += reported[i] < 4 ? 2 : 1;
  }
  const w = rs.t.exposure_weights.map((r) => num(r.weight));
  const out: string[] = new Array(ne);
  for (let i = 0; i < ne; i++) {
    if (!Number.isFinite(st.expStatic[i])) { out[i] = ""; continue; }
    let code = st.expStatic[i];
    const c = counts[st.pos[i]], f = st.expFlags[i];
    for (let j = 0; j < 14; j++) code += w[1 + j] * f[j] * c[j];
    out[i] = rs.exposureRules.get(Math.round(code)) ?? "";
  }
  return out;
}

export interface ValuationResult {
  structures: Row[];
  elements: Row[];
  summary: Record<string, any>;
  sizing: Sizing[];
}

/** WGA valuation + year-0 condition (SAVI Value and Y0 sheets). */
export function runValuation(inv: Inventory, rs: RuleSet): ValuationResult {
  const S = inv.structures, E = inv.elements;
  const authority = inv.settings?.authority_type || "Local Authority";
  const sizing = S.map((s) => computeSizing(s, rs, authority));
  const st = elementStatic(S, E, sizing, rs);
  const ne = E.length, ns = S.length;
  const ecs = new Float64Array(ne), eci = new Float64Array(ne);
  E.forEach((e, i) => {
    const p = rs.conditionPos.get(key(e.condition_code));
    ecs[i] = p === undefined ? 0 : rs.ecsList[p];
    const imp = st.importance[i];
    const base = imp === "High" ? 0.3 : imp === "Medium" ? 0.6 : imp === "Low" ? 1.2 : 0;
    const ecf = base ? base - (ecs[i] - 1) * base / 4 : 0;
    eci[i] = ecs[i] === 0 || st.eif[i] === 0 ? 0 : Math.max(ecs[i] - ecf, 1);
  });
  // exposure at year 0 (Value sheet blanks excluded elements)
  const expo = exposures(st, ns, ecs, rs);
  const condOrder = (c: unknown) => rs.conditionPos.get(key(c));
  const c5b = rs.condition[rs.conditionPos.get("5b")!];
  const teod5b = num(c5b.teod), ext5b = [num(c5b.ext_s2), num(c5b.ext_s3), num(c5b.ext_s4), num(c5b.ext_s5)];
  const actions = rs.t.maintenance_actions;
  const actionId = new Map(actions.map((a, i) => [key(a.action), i + 1]));
  const rules = rs.t.intervention_rules;
  const rule5b = new Map<string, number>();
  rules.forEach((r, i) => { const k = key(r.trigger_user) + "|" + key(r.material) + "|" + key(r.exposure); if (!rule5b.has(k)) rule5b.set(k, i + 1); });
  const tmRates = new Map(rs.t.tm_arrangements.map((r) => [r.arrangement, num(r.rate_per_hour)]));
  const fracCols = rs.t.deterioration.length ? Object.keys(rs.t.deterioration[0]).filter((c) => c.startsWith("frac_")) : [];
  const elOut: Row[] = [];
  for (let i = 0; i < ne; i++) {
    const e = E[i], p = st.pos[i], et = rs.elementTypes.get(st.etypeKey[i]), mk = st.matKey[i];
    const excluded = !et || !!et.excluded_from_valuation;
    let error = false;
    const exposure = excluded ? null : (Number.isFinite(st.expStatic[i]) ? expo[i] : null);
    const expKey = exposure === null ? "" : key(exposure);
    if (!excluded && exposure === null && Number.isFinite(st.expStatic[i]) === false && et && p >= 0 && mk) error = true;
    const det = rs.deterioration.get(mk + "|" + expKey);
    const ttf = excluded || exposure !== null ? num(det?.mttf) : 0;
    const avg = rs.deterioration.get(mk + "|average");
    const o = condOrder(e.condition_code);
    const age = avg && o !== undefined ? Math.min(1, num(avg[fracCols[o]])) : 0;
    let ruleRow = -10;
    if (!excluded && exposure !== null) ruleRow = rule5b.get("5b|" + mk + "|" + (expKey === "protected" ? "moderate" : expKey)) ?? -10;
    const after = ruleRow > 0 ? rules[ruleRow - 1].condition_after : null;
    const repairAge = after === "2B" ? (avg ? 2 * num(avg[fracCols[0]]) : NaN) : 0;
    const worksId = ruleRow > 0 ? actionId.get(key(rules[ruleRow - 1].action)) ?? -10 : -10;
    let qty = 0, works = 0, costType: string | null = null;
    if (worksId > 0) {
      const a = actions[worksId - 1];
      costType = a.cost_type;
      if (costType === "Fixed") { qty = 1; works = num(a.fixed_rate); }
      else if (costType === "Constant") { qty = st.size[i]; works = num(a.constant_rate) * qty; }
      else if (costType === "Variable") {
        qty = st.size[i] * teod5b;
        const rates = [num(a.var_rate_s2), num(a.var_rate_s3), num(a.var_rate_s4), num(a.var_rate_s5)];
        works = (rates[0] * ext5b[0] + rates[1] * ext5b[1] + rates[2] * ext5b[2] + rates[3] * ext5b[3]) / teod5b * qty;
      }
    }
    let tmCost = 0;
    if (st.tmCodeIdx[i] === -2) error = true;
    if (st.tmCodeIdx[i] >= 0 && worksId > 0) {
      const arr = TM_CODE_ARR[key(TM_CODES[st.tmCodeIdx[i]])];
      const wr = num(actions[worksId - 1].work_rate);
      if (!arr || wr === 0) error = true; else tmCost = qty / wr * (tmRates.get(arr) ?? 0);
    }
    const fP = rs.addon("fP", works), fO = rs.addon("fO", works), fD = rs.addon("fD", works * (1 + fP + fO) + tmCost);
    const f2b = repairAge !== 1 ? 1 / (1 - repairAge) : NaN;
    let y = 0;
    if (!(ecs[i] === 0 || worksId < 0 || error)) {
      y = f2b * (works * (1 + fP + fO + fD + fP * fD + fO * fD) + tmCost * (1 + fD));
      if (!Number.isFinite(y)) y = 0;
    }
    elOut.push({ element_seq: e.element_seq, structure_id: e.structure_id, element_type: e.element_type, material: e.material,
      condition_code: e.condition_code, ecs: ecs[i], eci: eci[i], eif: st.eif[i], importance: st.importance[i], exposure,
      time_to_failure: ttf, equivalent_age_frac: age, rule_row: ruleRow, condition_after: after, works_cost: works,
      tm_cost: tmCost, element_replacement_cost: y, valuation_error: error, pos: p });
  }
  // structure level
  const terc = new Float64Array(ns), sumEif = new Float64Array(ns), sumEx = new Float64Array(ns), maxVh = new Float64Array(ns), maxEcs = new Float64Array(ns);
  for (let i = 0; i < ne; i++) {
    const p = st.pos[i];
    if (p < 0) continue;
    terc[p] += elOut[i].element_replacement_cost;
    sumEif[p] += st.eif[i];
    sumEx[p] += eci[i] * st.eif[i];
    if (st.eif[i] === 2) maxVh[p] = Math.max(maxVh[p], eci[i]);
    if (st.eif[i] === 2 || st.eif[i] === 1.5) maxEcs[p] = Math.max(maxEcs[p], ecs[i]);
  }
  const factor = Array.from(terc, (t, p) => (t > 0 ? Math.min(1, sizing[p].grc / t) : NaN));
  const annual = new Float64Array(ns), acc = new Float64Array(ns);
  for (let i = 0; i < ne; i++) {
    const el = elOut[i], p = st.pos[i];
    const f = p >= 0 ? factor[p] : NaN;
    el.terc_factor = f;
    el.annual_depreciation = !Number.isFinite(f) || el.element_replacement_cost === 0 ? 0 : el.element_replacement_cost / el.time_to_failure * f;
    el.accumulated_depreciation = !Number.isFinite(f) ? 0 : el.equivalent_age_frac * el.element_replacement_cost * f;
    if (!Number.isFinite(el.annual_depreciation)) el.annual_depreciation = 0;
    if (p >= 0) { annual[p] += el.annual_depreciation; acc[p] += el.accumulated_depreciation; }
  }
  const sgrAv = rs.constants.sgr_sci_av_threshold, sgrCrit = rs.constants.sgr_sci_crit_threshold;
  const delayDays = new Map(rs.t.traffic_delay_days.map((r) => [`${Math.round(r.length_over_m * 1e4) / 1e4}|${r.restriction_code}`, num(r.days)]));
  const codes = new Map(rs.t.traffic_restriction_codes.map((r) => [r.avf_type, r]));
  const stOut: Row[] = S.map((s, p) => {
    const m = sumEif[p] === 0 ? 0 : sumEx[p] / sumEif[p];
    const sciAv = sumEif[p] === 0 ? 0 : Math.min(115 - 2 * m * (m + 6.5), 100);
    const sciCrit = Math.min(Math.max(115 - 2 * maxVh[p] * (maxVh[p] + 6.5), 0), 100);
    const band = maxEcs[p] >= 5 ? 5 : maxEcs[p] >= 4 ? 4 : 0;
    const cr = codes.get(sizing[p].avfType);
    const code = band === 4 ? num(cr?.code_ecs4) : band === 5 ? num(cr?.code_ecs5) : 0;
    const L = num(s.length_m);
    const lg = L <= 10 ? 0 : L <= 20 ? 10.0001 : 20.0001;
    const days = band ? delayDays.get(`${lg}|${code}`) ?? 0 : 0;
    const rate = num(rs.traffic.get(key(s.traffic))?.daily_delay_rate);
    const delay = band ? rate * days * (rs.constants.traffic_delay_extra_multiplier ?? 1) : 0;
    const grc = sizing[p].grc;
    return { structure_id: s.structure_id, name: s.name, structure_type: s.structure_type, number_in_group: num(s.number_in_group),
      length_m: L, location: s.location, route_supported: s.route_supported, obstacle_crossed: s.obstacle_crossed, traffic: s.traffic,
      grc, key_dimension: sizing[p].keyDim, grc_uplift: sizing[p].uplift, avf_type: sizing[p].avfType,
      key_dimension_x_avf: sizing[p].keyDimAvf, sci_av: sciAv, sci_crit: sciCrit, max_eci_very_high: maxVh[p],
      state_of_good_repair: sciAv > sgrAv && sciCrit > sgrCrit ? 1 : 0, traffic_delay_days: days, traffic_delay_cost: delay,
      structures_with_traffic_delay: delay > 0 ? num(s.number_in_group) : 0, terc: terc[p], grc_to_terc_factor: factor[p],
      annual_depreciation: annual[p], accumulated_depreciation: acc[p], drc: grc - acc[p], vh_h_ecs_band: band };
  });
  return { structures: stOut, elements: elOut, sizing, summary: summarise(stOut, elOut, rs) };
}

export function stockCondition(st: Row[]): Record<string, any> {
  const ratio = (n: number, d: number) => (d ? n / d : 0);
  const table: Record<string, any> = {};
  for (const [t, label] of AVF_GROUPS) {
    const g = st.filter((s) => s.avf_type === t);
    const kd = g.reduce((a, s) => a + s.key_dimension, 0);
    table[label] = { ssci_av: ratio(g.reduce((a, s) => a + s.sci_av * s.key_dimension, 0), kd),
      ssci_crit: ratio(g.reduce((a, s) => a + s.sci_crit * s.key_dimension, 0), kd),
      sss: ratio(g.reduce((a, s) => a + s.state_of_good_repair * s.key_dimension, 0), kd) };
  }
  const kda = st.reduce((a, s) => a + s.key_dimension_x_avf, 0);
  table.Stock = { ssci_av: ratio(st.reduce((a, s) => a + s.sci_av * s.key_dimension_x_avf, 0), kda),
    ssci_crit: ratio(st.reduce((a, s) => a + s.sci_crit * s.key_dimension_x_avf, 0), kda),
    sss: ratio(st.reduce((a, s) => a + s.state_of_good_repair * s.key_dimension_x_avf, 0), kda) };
  const bands: Record<string, number> = { "Very Good": 0, Good: 0, Fair: 0, Poor: 0, "Very Poor": 0 };
  for (const s of st) {
    const v = s.sci_av;
    const b = v >= 90 ? "Very Good" : v >= 80 ? "Good" : v >= 65 ? "Fair" : v >= 40 ? "Poor" : "Very Poor";
    bands[b] += s.number_in_group;
  }
  return { ssci_table: table, bands, structures_at_risk: st.reduce((a, s) => a + s.structures_with_traffic_delay, 0),
    traffic_delay_cost: st.reduce((a, s) => a + s.traffic_delay_cost, 0) };
}

function summarise(st: Row[], el: Row[], rs: RuleSet): Record<string, any> {
  const byGroup: Record<string, any> = {};
  for (const [t] of AVF_GROUPS) {
    const g = st.filter((s) => s.avf_type === t);
    const grc = g.reduce((a, s) => a + s.grc, 0), drc = g.reduce((a, s) => a + s.drc, 0);
    byGroup[t] = { structures: g.reduce((a, s) => a + s.number_in_group, 0), grc, drc, depreciation: grc - drc };
  }
  const byType: Record<string, any> = {};
  for (const r of rs.t.structure_types) {
    const g = st.filter((s) => key(s.structure_type) === key(r.structure_type));
    byType[SHORT_TYPE[key(r.structure_type)] ?? r.structure_type] = {
      structures: g.reduce((a, s) => a + s.number_in_group, 0), grc: g.reduce((a, s) => a + s.grc, 0), drc: g.reduce((a, s) => a + s.drc, 0) };
  }
  const grc = st.reduce((a, s) => a + s.grc, 0), drc = st.reduce((a, s) => a + s.drc, 0);
  return {
    n_structure_records: st.length, n_structures: st.reduce((a, s) => a + s.number_in_group, 0), n_elements: el.length,
    valuation: { grc, drc, accumulated_depreciation: grc - drc, annual_depreciation: st.reduce((a, s) => a + s.annual_depreciation, 0),
      drc_pct_of_grc: grc ? drc / grc : 0, price_year: rs.priceYear, by_avf_group: byGroup, by_structure_type: byType },
    condition_y0: stockCondition(st),
    diagnostics: { elements_with_valuation_error: el.filter((e) => e.valuation_error).length },
  };
}
