// QA family 2 for the browser engine: the TypeScript port must reproduce SAVI v1.10's own results
// (the same golden data the Python engine is tested against). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { RuleSet } from "../src/engine/rules";
import { toRows } from "../src/engine/core";
import { runValuation } from "../src/engine/valuation";
import { PlanningModel, LAMP_COLUMNS } from "../src/engine/planning";

const J = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const rs = new RuleSet(J("data/ruleset.json"));
const s = J("data/sample.json");
const inv = { name: s.name, structures: toRows(s.structures), elements: toRows(s.elements), planned: toRows(s.planned), routine: toRows(s.routine), settings: s.settings };
const summary = J("test/fixtures/summary.json");
const close = (a: any, b: any, rtol = 1e-9) => {
  const x = Number.isFinite(+a) && a !== null ? +a : 0, y = Number.isFinite(+b) && b !== null ? +b : 0;
  return Math.abs(x - y) <= rtol * Math.max(1, Math.abs(y));
};
const val = runValuation(inv, rs);
const model = new PlanningModel(inv, rs);
const t0 = performance.now();
const lt = model.runLongTerm();
const fy = model.runFiveYear();
const runtime = performance.now() - t0;

test("WGA valuation certificate matches SAVI", () => {
  const v = summary.valuation;
  for (const k of ["grc", "drc", "annual_depreciation", "accumulated_depreciation"]) assert.ok(close(val.summary.valuation[k], v[k]), k);
  assert.equal(val.summary.n_structures, 700);
  assert.equal(val.summary.n_elements, 8692);
});

test("structure valuation and condition columns match SAVI", () => {
  const st = toRows(J("test/fixtures/structures.json"));
  for (const c of ["grc", "sci_av", "sci_crit", "terc", "annual_depreciation", "accumulated_depreciation", "drc", "traffic_delay_cost"]) {
    const bad = st.filter((x, i) => !close(val.structures[i][c], x[c], 1e-6));
    assert.equal(bad.length, 0, c);
  }
});

test("element valuation columns match SAVI", () => {
  const el = toRows(J("test/fixtures/elements.json"));
  for (const c of ["ecs", "eci", "rule_row", "works_cost", "tm_cost", "element_replacement_cost"]) {
    const bad = el.filter((x, i) => !close(val.elements[i][c], x[c], 1e-6));
    assert.equal(bad.length, 0, c);
  }
});

test("LAMP Results: every column, every year", () => {
  const lamp = toRows(J("test/fixtures/lamp_results.json"));
  const failures: string[] = [];
  for (const [col, name] of Object.entries(LAMP_COLUMNS)) {
    const rows = col.length === 1 && col <= "Q" ? [...Array(30)].map((_, i) => i + 1) : [...Array(31)].map((_, i) => i);
    for (const y of rows) {
      let exp = lamp[y][col];
      if ("RSTUVWX".includes(col) && col.length === 1 && (exp === null || exp === "") && lamp[y].A > 0) exp = 0;
      if (!close(lt.table[y][name], exp)) failures.push(`${col} y${y}: ${lt.table[y][name]} vs ${exp}`);
    }
  }
  assert.deepEqual(failures.slice(0, 5), []);
});

test("ECS profile: every element, every year", () => {
  const prof = J("test/fixtures/ecs_profile.json");
  let bad = 0;
  for (let y = 0; y < 31; y++) for (let i = 0; i < prof.rows.length; i++) {
    const e = prof.rows[i][y];
    if (Math.abs(lt.ecsProfile[y][i] - (e ?? 0)) > 1e-12) bad++;
  }
  assert.equal(bad, 0);
});

test("long-term totals and end workbank", () => {
  const t = lt.totals(), e = summary.long_term_plan;
  assert.equal(t.total_budget, e.total_budget);
  for (const k of ["expenditure", "discounted_expenditure", "workbank_end"]) assert.ok(close((t as any)[k], e[k]), k);
  assert.equal(Math.round(t.workbank_end * 100) / 100, 103390688.73);
});

test("5-year programme: element decisions and end condition", () => {
  const y5 = toRows(J("test/fixtures/y5.json"));
  const pairs: [keyof typeof fy.detail, string][] = [["M", "M"], ["Q", "Q"], ["AB", "AB"], ["AE", "AE"], ["DN", "DP"], ["DV", "DX"], ["DW", "DY"]];
  for (const [ours, col] of pairs) {
    const arr = fy.detail[ours] as any;
    const bad = y5.filter((x, i) => !close(arr[i], x[col]));
    assert.equal(bad.length, 0, `${String(ours)}/${col}`);
  }
  assert.equal(y5.filter((x, i) => !close(fy.preciseEcs[i], x.ED)).length, 0, "ED");
  assert.equal(y5.filter((x, i) => !close(fy.reportedEcs[i], x.EE)).length, 0, "EE");
});

test("5-year summary and project list", () => {
  const e = summary.short_term_plan, s5 = fy.summary;
  assert.equal(s5.total_budget, 15_000_000);
  assert.equal(Math.round(s5.expenditure * 100) / 100, 14233985.32);
  assert.equal(Math.round(s5.remaining * 100) / 100, 18014.68);
  for (const [k, ek] of [["ssci_av|Full Stock", "ssci_av_y5"], ["ssci_crit|Full Stock", "ssci_crit_y5"], ["sss|Full Stock", "sss_y5"]]) assert.ok(close(s5[k], e[ek]), k);
  const first = fy.projects()[0];
  assert.equal(first.structure_id, "ST423"); assert.equal(first.year, 1); assert.equal(first.action, "Replace");
  assert.equal(Math.round(first.priority_score * 100) / 100, 10025.35);
});

test("planning invariants: spend within budget, determinism, reject override", () => {
  for (const r of lt.table.slice(1)) assert.ok(r.expenditure + r.planned + r.routine <= r.budget + 1e-6);
  const again = model.runLongTerm();
  assert.equal(again.totals().expenditure, lt.totals().expenditure);
  const p = fy.projects()[0];
  const els = fy.works.filter((w) => w.structure_index === p.structure_index).map((w) => w.element_index);
  const rej = model.runFiveYear({ overrides: { reject: els } });
  assert.ok(!rej.projects().some((x) => x.structure_id === p.structure_id));
});

test("uncertainty bands are ordered", () => {
  const u = model.runUncertainty({ runs: 4, seed: 1 });
  const m = u["ssci_av|Full Stock"];
  for (let y = 1; y < m.p10.length; y++) assert.ok(m.p10[y] <= m.p50[y] + 1e-9 && m.p50[y] <= m.p90[y] + 1e-9);
});

test("runtime under 10 s for both plans", () => assert.ok(runtime < 10_000, `${runtime} ms`));

import { validateInventory } from "../src/engine/validation";
test("validation matches the Python/Pandera rules on clean and corrupted data", () => {
  const ok = validateInventory(inv.structures, inv.elements, rs);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.byRule, { "warning:W01_case_variant": 1009, "warning:W02_unknown_material": 4687, "warning:W03_blank_dimension": 48 });
  const s = inv.structures.map((r) => ({ ...r })), e = inv.elements.map((r) => ({ ...r }));
  s[0].structure_type = "Bogus"; s[1].location = "Moon"; s[2].number_in_group = 0; s[3].adj_heritage = 2;
  e[0].condition_code = "9Z"; e[1].material = "Cheese"; e[2].structure_id = "NOPE";
  const bad = validateInventory(s, e, rs);
  assert.equal(bad.valid, false);
  assert.deepEqual(Object.fromEntries(Object.entries(bad.byRule).filter(([k]) => k.startsWith("error"))), {
    "error:E01_structure_known": 1, "error:E02_element_allowed": 11, "error:E03_material_allowed": 1, "error:E05_condition": 1,
    "error:S01_structure_type": 1, "error:S02_number_in_group": 1, "error:S07_location": 1, "error:S11_adjustment_flags": 1 });
});

import { readWorkbookFile } from "../src/engine/io";
import { existsSync } from "fs";
test("SAVI .xlsm import in the browser reads the same inventory and values", { skip: !existsSync("test/fixtures/savi-sample.xlsm") }, () => {
  const buf = readFileSync("test/fixtures/savi-sample.xlsm");
  const t = performance.now();
  const got = readWorkbookFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "sample.xlsm") as any;
  assert.equal(got.structures.length, inv.structures.length);
  assert.equal(got.elements.length, inv.elements.length);
  assert.equal(got.planned.length, inv.planned.length);
  assert.equal(got.settings.intervention_strategy, inv.settings.intervention_strategy);
  const v = runValuation(got, rs);
  assert.ok(close(v.summary.valuation.grc, summary.valuation.grc));
  assert.ok(close(v.summary.valuation.drc, summary.valuation.drc));
  const m = new PlanningModel(got, rs);
  assert.ok(close(m.runLongTerm().totals().workbank_end, summary.long_term_plan.workbank_end));
  console.log(`# xlsm import + runs: ${Math.round(performance.now() - t)} ms`);
});
