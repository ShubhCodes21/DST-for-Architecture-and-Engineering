// Input data validation (QA family 1) - port of dst_engine/validation.py.
// Blocking errors mirror SAVI v1.10's CHECK columns; warnings flag data SAVI tolerates.
import { Row, key, num } from "./core";
import { RuleSet } from "./rules";

export interface Issue { table: string; row: number; record_id: string; field: string; rule: string; message: string; severity: "error" | "warning" }
export interface ValidationReport { issues: Issue[]; errors: number; warnings: number; valid: boolean; byRule: Record<string, number> }

const lower = (xs: string[]) => new Set(xs.map((x) => key(x)));
const NO_LENGTH = lower(["Cantilever Road Sign", "High Mast Lighting"]);
const NO_WIDTH = new Set([...NO_LENGTH, ...lower(["Retaining Wall (height > 3m)", "Retaining Wall (height ≤ 3m)"])]);
const EARTHWORKS = lower(["Structural Earthworks - Reinforced/Strengthened Soil/Fill Structure (height > 3m)",
  "Structural Earthworks - Reinforced/Strengthened Soil/Fill Structure (height ≤ 3m)"]);
const GANTRIES = lower(["Sign/Signal Gantry (cantilever)", "Sign/Signal Gantry (spanning)"]);
const NO_HEADROOM = new Set([...NO_LENGTH, ...EARTHWORKS]);
const NO_SPANS = new Set([...NO_WIDTH, ...GANTRIES, ...EARTHWORKS]);
const NO_OBSTACLE = new Set([...NO_LENGTH, ...GANTRIES]);
const NO_SPRAY = lower(["Chamber/Cellar/Vault"]);
const ADJ = ["adj_heritage", "adj_conservation_area", "adj_environmentally_sensitive", "adj_river_coastal_wall",
  "adj_substandard", "adj_spare_1", "adj_spare_2", "adj_spare_3", "adj_spare_4", "adj_spare_5", "adj_spare_6"];
export const REQUIRED_STRUCTURE_COLUMNS = ["structure_id", "structure_type", "number_in_group", "location", "traffic"];
export const REQUIRED_ELEMENT_COLUMNS = ["structure_id", "condition_code", "element_type", "material"];

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (typeof v === "number" && Number.isNaN(v));
const isFlag = (v: unknown) => { const n = num(v); return n === 0 || n === 1; };

export function validateInventory(structures: Row[], elements: Row[], rs: RuleSet): ValidationReport {
  const issues: Issue[] = [];
  const add = (table: string, row: number, id: unknown, field: string, rule: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ table, row, record_id: id === null || id === undefined ? "" : String(id), field, rule, message, severity });
  const sCols = new Set(structures.length ? Object.keys(structures[0]) : []);
  const eCols = new Set(elements.length ? Object.keys(elements[0]) : []);
  for (const c of REQUIRED_STRUCTURE_COLUMNS) if (structures.length && !sCols.has(c)) add("structures", -1, "", c, "X00_column_missing", `Column '${c}' is missing`);
  for (const c of REQUIRED_ELEMENT_COLUMNS) if (elements.length && !eCols.has(c)) add("elements", -1, "", c, "X00_column_missing", `Column '${c}' is missing`);
  if (!structures.length) add("structures", -1, "", "", "X03_empty", "No structures were found");
  if (!elements.length) add("elements", -1, "", "", "X03_empty", "No elements were found");

  const types = lower(rs.t.structure_types.map((r) => r.structure_type));
  const locs = lower(rs.t.locations.map((r) => r.location));
  const traffic = lower(rs.t.traffic.map((r) => r.traffic));
  const routes = lower(rs.t.routes.map((r) => r.route));
  const obstacles = lower(rs.t.obstacles.map((r) => r.obstacle));
  const sidCount = new Map<string, number>();
  for (const s of structures) sidCount.set(key(s.structure_id), (sidCount.get(key(s.structure_id)) ?? 0) + 1);

  structures.forEach((s, i) => {
    const id = s.structure_id, t = key(s.structure_type);
    const err = (f: string, r: string, m: string) => add("structures", i, id, f, r, m);
    if (blank(id)) err("structure_id", "S00_id_present", "Structure identifier is required");
    else if ((sidCount.get(key(id)) ?? 0) > 1) err("structure_id", "X01_unique", `Structure identifier '${id}' is used more than once`);
    if (!blank(s.structure_type) && !types.has(t)) err("structure_type", "S01_structure_type", "Structure type is not one of the SAMPT/SAVI types");
    if (blank(s.structure_type)) err("structure_type", "S01_structure_type", "Structure type is not one of the SAMPT/SAVI types");
    if (!(num(s.number_in_group) >= 1)) err("number_in_group", "S02_number_in_group", "Number of structures in the group must be at least 1");
    if (!NO_LENGTH.has(t) && !(num(s.length_m) > 0)) err("length_m", "S03_length", "Length must be greater than 0 for this structure type");
    if (!NO_WIDTH.has(t) && !(num(s.width_m) > 0)) err("width_m", "S04_width", "Average width must be greater than 0 for this structure type");
    if (!NO_HEADROOM.has(t) && !(num(s.headroom_m) > 0)) err("headroom_m", "S05_headroom", "Headroom/height must be greater than 0 for this structure type");
    if (!NO_SPANS.has(t) && !(num(s.spans) > 0)) err("spans", "S06_spans", "Number of spans must be greater than 0 for this structure type");
    if (!locs.has(key(s.location))) err("location", "S07_location", "Location must be Urban, Rural or Marine/Estuarial");
    if (!isFlag(s.route_salted) || !routes.has(key(s.route_supported))) err("route_supported", "S08_route", "Route supported must be a listed route type and 'salted' must be 0 or 1");
    if (!isFlag(s.obstacle_salted) || !(NO_OBSTACLE.has(t) || obstacles.has(key(s.obstacle_crossed)))) err("obstacle_crossed", "S09_obstacle", "Obstacle crossed must be a listed obstacle and 'salted' must be 0 or 1");
    if (!traffic.has(key(s.traffic))) err("traffic", "S10_traffic", "Traffic must be High, Moderate or Low");
    if (!ADJ.every((c) => blank(s[c]) || isFlag(s[c]))) err("adj_*", "S11_adjustment_flags", "GRC adjustment flags must be 0, 1 or blank");
  });

  const stype = new Map(structures.map((s) => [key(s.structure_id), key(s.structure_type)]));
  const codes = lower(rs.t.condition_codes.map((r) => r.code));
  const spray = lower(rs.t.spray_proximity.map((r) => r.spray_proximity));
  elements.forEach((e, i) => {
    const id = e.element_seq, sk = key(e.structure_id);
    const err = (f: string, r: string, m: string) => add("elements", i, id, f, r, m);
    const known = (sidCount.get(sk) ?? 0) === 1;
    if (!known) err("structure_id", "E01_structure_known", "The structure or group of structures is not recognised");
    const t = stype.get(sk), ek = key(e.element_type);
    if (known && t !== undefined && ek && !rs.allowedElements.has(`${t}|${ek}`)) err("element_type", "E02_element_allowed", "The element is not recognised for this structure type");
    const mk = key(e.material);
    if (!mk || !rs.allowedMaterials.has(`${ek}|${mk}`)) err("material", "E03_material_allowed", "The component/material type is missing or not allowed for this element");
    if (!(NO_SPRAY.has(t ?? "") || blank(e.element_type) || spray.has(key(e.spray_proximity)))) err("spray_proximity", "E04_spray_proximity", "Proximity to traffic spray zone is not recognised");
    if (!codes.has(key(e.condition_code))) err("condition_code", "E05_condition", "Condition must be a severity/extent code such as 1A, 2B ... 5E");
  });

  // warnings (non-blocking)
  const canon: [string, string, string[]][] = [
    ["structures", "structure_type", rs.t.structure_types.map((r) => r.structure_type)],
    ["structures", "route_supported", rs.t.routes.map((r) => r.route)],
    ["structures", "obstacle_crossed", rs.t.obstacles.map((r) => r.obstacle)],
    ["structures", "location", rs.t.locations.map((r) => r.location)],
    ["structures", "traffic", rs.t.traffic.map((r) => r.traffic)],
    ["elements", "element_type", rs.t.element_types.map((r) => r.element_type)],
    ["elements", "material", rs.t.materials.map((r) => r.material)],
  ];
  for (const [tn, col, values] of canon) {
    const rows = tn === "structures" ? structures : elements, idc = tn === "structures" ? "structure_id" : "element_seq";
    const exact = new Set(values), byKey = new Map(values.map((v) => [key(v), v]));
    rows.forEach((r, i) => {
      const v = r[col];
      if (typeof v === "string" && !exact.has(v) && byKey.has(key(v)))
        add(tn, i, r[idc], col, "W01_case_variant", `'${v}' matches '${byKey.get(key(v))}' only when case is ignored`, "warning");
    });
  }
  elements.forEach((e, i) => {
    if (typeof e.material === "string" && e.material.toLowerCase().startsWith("other/unknown"))
      add("elements", i, e.element_seq, "material", "W02_unknown_material", "Generic deterioration profile used (material unknown)", "warning");
  });
  structures.forEach((s, i) => {
    for (const c of ["width_m", "headroom_m", "spans"]) if (s[c] === null || s[c] === undefined || (typeof s[c] === "number" && Number.isNaN(s[c])))
      add("structures", i, s.structure_id, c, "W03_blank_dimension", `${c} is blank (not required for this structure type)`, "warning");
  });
  const withEl = new Set(elements.map((e) => key(e.structure_id)));
  structures.forEach((s, i) => { if (!withEl.has(key(s.structure_id))) add("structures", i, s.structure_id, "", "S12_no_elements", "Structure has no elements"); });

  const byRule: Record<string, number> = {};
  for (const x of issues) byRule[`${x.severity}:${x.rule}`] = (byRule[`${x.severity}:${x.rule}`] ?? 0) + 1;
  const errors = issues.filter((x) => x.severity === "error").length;
  return { issues, errors, warnings: issues.length - errors, valid: errors === 0, byRule };
}
