// The versioned rule set (SAMPT Part C / SAVI Ref tables) with case-insensitive lookups.
import { Row, Table, key, num, toRows } from "./core";

export interface RuleSetJson {
  name: string;
  price_year: string;
  source_sha256: string;
  tables: Record<string, Table>;
  exposure_rules: Record<string, string>;
}

export class RuleSet {
  name: string;
  priceYear: string;
  sourceSha: string;
  t: Record<string, Row[]> = {};
  exposureRules: Map<number, string>;
  constants: Record<string, number> = {};
  weights: Record<string, number> = {};
  condition: Row[];
  conditionPos = new Map<string, number>();
  ecsList: number[];
  elementTypes = new Map<string, Row>();
  structureTypes = new Map<string, Row>();
  materials = new Map<string, Row>();
  routes = new Map<string, Row>();
  obstacles = new Map<string, Row>();
  traffic = new Map<string, Row>();
  locations = new Map<string, Row>();
  spray = new Map<string, Row>();
  deterioration = new Map<string, Row>();
  avf: Map<string, Row>;
  adjustment: Record<string, number> = {};
  allowedElements = new Set<string>();
  allowedMaterials = new Set<string>();
  bands: Record<string, { thr: number[]; fac: number[] }> = {};

  constructor(j: RuleSetJson) {
    this.name = j.name;
    this.priceYear = j.price_year;
    this.sourceSha = j.source_sha256;
    for (const [k, v] of Object.entries(j.tables)) this.t[k] = toRows(v);
    this.exposureRules = new Map(Object.entries(j.exposure_rules).map(([k, v]) => [Number(k), v ?? ""]));
    for (const r of this.t.constants) this.constants[r.name] = num(r.value);
    for (const r of this.t.priority_weights) this.weights[r.name] = num(r.value);
    this.condition = this.t.condition_codes;
    this.condition.forEach((r, i) => this.conditionPos.set(key(r.code), i));
    this.ecsList = this.condition.map((r) => num(r.ecs));
    const idx = (rows: Row[], col: string, m: Map<string, Row>) => rows.forEach((r) => m.set(key(r[col]), r));
    idx(this.t.element_types, "element_type", this.elementTypes);
    idx(this.t.structure_types, "structure_type", this.structureTypes);
    idx(this.t.materials, "material", this.materials);
    idx(this.t.routes, "route", this.routes);
    idx(this.t.obstacles, "obstacle", this.obstacles);
    idx(this.t.traffic, "traffic", this.traffic);
    idx(this.t.locations, "location", this.locations);
    idx(this.t.spray_proximity, "spray_proximity", this.spray);
    for (const r of this.t.deterioration) {
      const k = key(r.material) + "|" + key(r.exposure);
      if (!this.deterioration.has(k)) this.deterioration.set(k, r);
    }
    this.avf = new Map(this.t.avf_factors.map((r) => [r.avf_type, r]));
    for (const r of this.t.adjustment_factors) this.adjustment[r.column] = num(r.factor);
    for (const r of this.t.structure_elements) this.allowedElements.add(key(r.structure_type) + "|" + key(r.element_type));
    for (const r of this.t.element_materials) this.allowedMaterials.add(key(r.element_type) + "|" + key(r.material));
    for (const kind of ["fP", "fO", "fD"]) {
      const rows = this.t.addon_bands.filter((r) => r.kind === kind).sort((a, b) => a.threshold - b.threshold);
      this.bands[kind] = { thr: rows.map((r) => num(r.threshold)), fac: rows.map((r) => num(r.factor)) };
    }
  }

  /** Excel LOOKUP on ascending add-on thresholds. */
  addon(kind: string, amount: number): number {
    const b = this.bands[kind];
    let i = -1;
    for (let k = 0; k < b.thr.length; k++) if (b.thr[k] <= amount) i = k;
    return i >= 0 ? b.fac[i] : NaN;
  }
}
