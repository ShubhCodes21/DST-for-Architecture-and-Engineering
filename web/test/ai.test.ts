// The grounding check is the trust layer for every AI answer: test it like engine code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groundText, extractFigures, summariseEval } from "../src/ui/ai";

const src = { grc: 377929803.682419, drc: 257364205.748757, ssci_av: 86.4207798720426, schemes: 41, spend: 14233985.32, sss: 0.964834 };

test("figures in prose are parsed with units", () => {
  const f = extractFigures("GRC is £377.9m, DRC £257,364,206 and SSCI 86.4; 96.5% in good repair; ST423 in year 1; 5B; 2026; £1.2bn; 41 schemes");
  const vals = f.map((x) => x.text.trim());
  assert.deepEqual(vals, ["£377.9m", "£257,364,206", "86.4", "96.5%", "£1.2bn", "41"]);
});

test("traced, derived and untraced figures", () => {
  const g = groundText("The GRC is £377.9m and DRC £257.4m (68.1% of GRC). SSCIav is 86.4. Spend £14.2m. Invented £12.3m.", [src]);
  const by = Object.fromEntries(g.figures.map((x) => [x.text.trim(), x.status]));
  assert.equal(by["£377.9m"], "traced");
  assert.equal(by["£257.4m"], "traced");
  assert.equal(by["86.4"], "traced");
  assert.equal(by["£14.2m"], "traced");
  assert.equal(by["£12.3m"], "untraced");
  assert.equal(by["68.1%"], "derived"); // DRC as a share of GRC: a ratio of two source figures
});

test("percentages match fractions; rounding tolerance is one shown digit", () => {
  const g = groundText("96.5% are in a state of good repair; 96% overall; 97.5% is wrong", [src]);
  const st = g.figures.map((x) => x.status);
  assert.deepEqual(st.slice(0, 2), ["traced", "traced"]);
  assert.equal(st[2], "untraced");
});

test("difference between two source figures counts as derived", () => {
  const g = groundText("DRC is £120.6m below GRC", [src]);
  assert.equal(g.figures[0].status, "derived");
});

test("eval summary metrics", () => {
  const r = (id: string, cat: string, passed: boolean, hall: boolean, ms: number) => ({ id, category: cat, question: "", passed, accurate: passed, toolsOk: true, grounded: !hall, hallucinated: hall, ms, answer: "", toolNames: [], grounding: { figures: [], checked: 2, traced: hall ? 1 : 2, derived: 0, untraced: hall ? 1 : 0, rate: 1 } });
  const s = summariseEval([r("A", "accuracy", true, false, 1000), r("B", "task", false, true, 3000), r("C", "task", true, false, 2000)] as any);
  assert.equal(s.cases, 3); assert.equal(s.passed, 2);
  assert.ok(Math.abs(s.hallucination_rate - 1 / 3) < 1e-9);
  assert.equal(s.task_completion, 0.5);
  assert.equal(s.latency_p50_ms, 2000);
  assert.ok(Math.abs(s.grounding - 5 / 6) < 1e-9);
});

test("an invented figure is not excused as a combination of unrelated numbers", async () => {
  const { portfolioLike } = { portfolioLike: { a: { grc: 228767056.84, drc: 151457269.09 }, b: { grc: 13046812.3, drc: 9000000 }, c: [1, 2, 3, 41, 192, 258, 108000, 640000, 18014.68] } };
  const g = groundText("An invented figure: £12.3m. DRC/GRC for group a is 66.2%.", [portfolioLike]);
  assert.equal(g.figures[0].status, "untraced");
  assert.equal(g.figures[1].status, "derived");
});

test("totals of a table column are derived; arbitrary sums across tables are not", () => {
  const src = { projects: [{ id: "A", cost: 74404.82 }, { id: "B", cost: 295758.6 }, { id: "C", cost: 15630.1 }, { id: "D", cost: 405991.9 }, { id: "E", cost: 86137.2 }], other: { x: 123456 } };
  const g = groundText("Together the five cost about £0.88m; the first three £385,794. A made-up £1.9m.", [src]);
  assert.deepEqual(g.figures.map((f) => f.status), ["derived", "derived", "untraced"]);
});
