// Service-level tests: the flows the UI and the AI tools call (QA family 2/3 for the MVP).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { EngineService } from "../src/engine/service";

const J = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const svc = new EngineService(J("data/ruleset.json"), J("data/sample.json"), { lamp: J("test/fixtures/lamp_results.json"), summary: J("test/fixtures/summary.json") });

test("load sample -> valid, baseline run with stable run id", async () => {
  const s: any = await svc.loadSample();
  assert.equal(s.validation.valid, true);
  assert.equal(s.inventory.structures, 652);
  assert.match(s.run.run_id, /^R001-/);
  const again: any = await svc.loadSample();
  assert.equal(again.run.input_hash, s.run.input_hash, "same inputs give the same input hash");
});

test("in-browser verification against SAVI passes", async () => {
  const v = await svc.verify();
  assert.equal(v.lamp_mismatches, 0);
  assert.ok(v.lamp_cells > 1700);
  assert.ok(v.passed);
});

test("structures query, detail and priority explanation agree", async () => {
  const q = svc.structures({ only: "programme", sort: "rank" });
  assert.ok(q.total > 0);
  const top = q.rows[0];
  assert.equal(top.structure_id, "ST423");
  const d = svc.structure("st423");
  assert.equal(d.structure_id, "ST423");
  assert.ok(d.elements.length > 0);
  const x = svc.explainPriority("ST423");
  assert.equal(Math.round(x.structure_priority * 100) / 100, 10025.35);
  assert.equal(x.budget.funded, true);
  assert.throws(() => svc.structure("ST99999"), /not in the inventory/);
});

test("defer a funded scheme frees budget for the next structures and is reversible", async () => {
  const before = (svc.state() as any).five_year.projects.map((p: any) => p.structure_id);
  const r: any = await svc.decide({ structure_id: "ST423", status: "deferred", note: "Test", at: "now" });
  assert.ok(!r.state.five_year.projects.some((p: any) => p.structure_id === "ST423"));
  assert.ok(r.left.includes("ST423"));
  assert.ok(r.entered.length > 0);
  const c: any = await svc.decide({ structure_id: "ST423", status: "clear" });
  assert.deepEqual(c.state.five_year.projects.map((p: any) => p.structure_id), before);
});

test("W1 new inspection: record -> evaluate -> programme -> long term -> commit", async () => {
  // a structure outside the programme, worsen its most important elements to 5B
  const out = svc.structures({ sort: "sci_av", limit: 1000 }).rows.find((r: any) => !r.in_programme && r.sci_av > 85)!;
  const d = svc.structure(out.structure_id);
  const vh = d.elements.filter((e: any) => e.importance === "Very High" || e.importance === "High").slice(0, 3);
  const ch = Object.fromEntries(vh.map((e: any) => [e.element_seq, "5B"]));
  const rec = svc.w1Record(out.structure_id, ch);
  assert.ok(rec.worsened > 0);
  const ev = svc.w1Evaluate(rec.draft_id);
  assert.ok(ev.sci_av.after < ev.sci_av.before);
  const pg = svc.w1Programme(rec.draft_id);
  assert.ok(pg.structure.priority.after > pg.structure.priority.before);
  const lt = svc.w1LongTerm(rec.draft_id);
  assert.ok(lt.totals.expenditure.after > 0);
  const runsBefore = svc.runs.length;
  const c = await svc.w1Commit(rec.draft_id, "tester");
  assert.equal(svc.runs.length, runsBefore + 1);
  assert.equal(svc.inspections.length, 1);
  const d2 = svc.structure(out.structure_id);
  assert.equal(d2.elements.find((e: any) => e.element_seq === vh[0].element_seq)!.condition, "5B");
  assert.throws(() => svc.w1Evaluate(rec.draft_id), /not found/);
  assert.throws(() => svc.w1Record(out.structure_id, { [vh[0].element_seq]: "9Z" }), /not a condition code/);
});

test("scenario does not change the committed run", async () => {
  const run = svc.current.run_id;
  const s = await svc.scenario({ budgetBands: [[1, 30, 8_000_000]] }, "More money");
  assert.equal(svc.current.run_id, run);
  assert.ok(s.totals.expenditure > s.base_totals.expenditure);
  assert.ok(s.totals.workbank_end < s.base_totals.workbank_end);
});

test("setSettings re-runs and registers a new run", async () => {
  const n = svc.runs.length;
  const st: any = await svc.setSettings({ strategy: "Early Intervention (condition 2C-3C)" }, "Early strategy");
  assert.equal(svc.runs.length, n + 1);
  assert.equal(st.settings.strategy, "Early Intervention (condition 2C-3C)");
});

test("invalid inventory blocks runs with a clear message", async () => {
  const s = J("data/sample.json");
  const t = svc as any;
  const bad = await t.load({ name: "bad", structures: [{ structure_id: "X1", structure_type: "Bogus", number_in_group: 1 }], elements: [], planned: [], routine: [], settings: s.settings }, "upload");
  assert.equal(bad.validation.valid, false);
  assert.throws(() => svc.structures({}), /blocking validation errors/);
});

test("data entry: add a structure and elements by hand, plans re-run, edits and deletes are clean", async () => {
  await svc.loadSample();
  const L = svc.lookups();
  const stype = "Bridge:  Vehicular (single span)";
  const els = L.elements_for[stype];
  assert.ok(els.length > 5 && L.materials_for[els[0]].length > 0);
  const bad = await svc.saveStructure({ structure_id: "NEW1", structure_type: stype, number_in_group: 1, length_m: 0, location: "Moon" });
  assert.equal(bad.saved, false);
  assert.ok(bad.issues.some((i: any) => i.rule === "S07_location") && bad.issues.some((i: any) => i.rule === "S03_length"));
  const ok = await svc.saveStructure({ structure_id: "NEW1", name: "New bridge", structure_type: stype, number_in_group: 1, length_m: 14, width_m: 9, headroom_m: 5.1, spans: 1,
    location: "Urban", route_supported: "Local Road - A class", route_salted: 1, traffic: "High", obstacle_crossed: "Watercourse - navigable", obstacle_salted: 0 });
  assert.equal(ok.saved, true);
  assert.equal((ok.state as any).validation.valid, false, "a structure without elements blocks runs (S12)");
  const deck = els.find((e: string) => e.startsWith("Br01"))!;
  const e1 = await svc.saveElement({ structure_id: "NEW1", element_type: deck, material: "Insitu Reinforced Concrete", condition_code: "4C", spray_proximity: L.spray[1] });
  assert.equal(e1.saved, true);
  const st: any = e1.state;
  assert.equal(st.validation.valid, true);
  assert.equal(st.inventory.structures, 653);
  const rec = svc.structure("NEW1");
  assert.equal(rec.elements.length, 1);
  assert.ok(rec.grc > 0 && rec.sci_av < 100);
  const badEl = await svc.saveElement({ structure_id: "NEW1", element_type: deck, material: "Cheese", condition_code: "4C", spray_proximity: L.spray[1] });
  assert.equal(badEl.saved, false);
  // edit the element's condition: the plan changes; delete removes the structure cleanly
  const e2 = await svc.saveElement({ ...svc.inventoryTables().elements.find((e: any) => e.structure_id === "NEW1"), condition_code: "1A" }, e1.element_seq);
  assert.equal(e2.saved, true);
  assert.equal(svc.structure("NEW1").elements[0].condition, "1A");
  await svc.deleteStructure("NEW1");
  assert.equal(svc.inventoryTables().structures.length, 652);
  assert.ok(!svc.inventoryTables().elements.some((e: any) => e.structure_id === "NEW1"));
});

test("data entry: approved inspections stay attached to their element after other records are deleted", async () => {
  await svc.loadSample();
  const target = svc.inventoryTables().elements[100];
  const r = svc.w1Record(target.structure_id, { [target.element_seq]: "5B" });
  await svc.w1Commit(r.draft_id);
  await svc.deleteElement(svc.inventoryTables().elements[0].element_seq);
  const d = svc.structure(target.structure_id);
  assert.equal(d.elements.find((e: any) => e.element_seq === target.element_seq)!.condition, "5B");
});

test("data entry: blank inventory starts empty and blocked, priority weights are editable", async () => {
  const s: any = await svc.newBlank("Test council");
  assert.equal(s.inventory.structures, 0);
  assert.equal(s.validation.valid, false);
  await svc.loadSample();
  const base = svc.fy.projects().length;
  const w = svc.lookups().priority_factor_weights.map((r: any) => ({ ...r, weight: r.column === "pf_heritage" && r.level === "structure" ? 1 : r.weight }));
  const st: any = (await svc.saveInventorySettings({ priority_factor_weights: w })).state;
  assert.ok(st.run);
  assert.equal(svc.lookups().priority_factor_weights.find((r: any) => r.column === "pf_heritage" && r.level === "structure").weight, 1);
  assert.ok(Number.isFinite(base));
  const p: any = (await svc.savePlanned([{ element_seq: svc.inventoryTables().elements[5].element_seq, year_of_work: 2, total_cost: 50000, condition_after: "1a" }])).state;
  assert.equal(p.inventory.planned, 1);
  await assert.rejects(svc.savePlanned([{ element_seq: 99999999, year_of_work: 2, total_cost: 1, condition_after: "1A" }]), /not in the inventory/);
});
