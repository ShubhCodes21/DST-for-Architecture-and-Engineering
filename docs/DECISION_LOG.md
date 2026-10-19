# Decision log

Every place where our engine, SAVI v1.10 and the SAMPT documents could disagree is recorded here.
Default policy (decided 16 Oct 2026): **SAVI-compatible behaviour**, with SAMPT behaviour available as a switch later.

## D-001 · Text matching is case-insensitive
Excel's MATCH, SUMIF, COUNTIF and `=` ignore case, so SAVI accepts `Local Road - A Class` for the canonical
`Local Road - A class`. The engine does the same (`ruleset.key()`), and validation raises warning `W01_case_variant`
(1,009 in the Hertfordshire sample) so data owners can clean their data.

## D-002 · Valuation is SAVI's closed-form year-0 method
SAVI does not simulate 30 years to value the stock. Per element it takes the cost of the intervention triggered at
failure (5B) and multiplies by the share of life consumed at today's condition (the material's "Average" profile).
It then scales element costs to GRC (TERC normalisation) and sums. This is SAMPT Part A §4 under the Technical Note's
WGA settings. The engine reproduces it exactly: £377,929,803.68 GRC and £257,364,205.75 DRC for the sample.

## D-003 · Year-0 "at risk" flag is deterministic
SAVI computes a randomised start ECS between a code's ECS and the next code's. Draws are in [0, 1), so the
randomised value can never cross 4.0 or 5.0. The engine therefore uses the ECS directly, with identical results
(134 structures at risk).

## D-004 · Traffic delay cost is indexed twice (SAVI behaviour kept)
`Y0!Y = daily rate (already indexed) × days × Ref10!D25 (maintenance index again)`. The engine keeps this for parity
(`traffic_delay_extra_multiplier` in the rule set). **Open:** confirm with UKRLG whether this is intended.

## D-005 · TEoD for 1A is 0.001, not 0
SAVI's Ref00 sets total extent of defects at 1A to 0.001 (Part A Table 4: 0%), presumably to avoid division by zero.
Kept. Asserted by `test_teod_differs_from_part_a_only_at_1a`.

## D-006 · Excel `MAX(range, range)` is a scalar
For retaining-wall traffic management SAVI takes `MAX(route flags, obstacle flags)`, which returns one number over
both ranges, not an element-wise maximum. Replicated.

## D-007 · Errors become zero, as in SAVI
Where SAVI wraps a calculation in `IFERROR(…, 0)` (unresolved exposure, unknown traffic-management code, zero work
rate), the element's replacement cost is 0. The engine counts these in `diagnostics.elements_with_valuation_error`
(0 in the sample). **MVP:** surface them as validation warnings, not silent zeros.

## D-008 · Blank element importance
Ref14 has no importance for `Br35 Approach Rails` and `Br36 Signs` (EIF 0, so excluded from condition indices).
Excel shows the blank as 0; the engine leaves it empty. No numeric effect.

## Errata in SAMPT Part A v2.01 worked examples
Unit tests assert the recomputed value and record the published one.

| Example | Published | Recomputed | Cause |
| --- | --- | --- | --- |
| Ex 6, waterway possession TM | £20,923 | £20,914 | duration rounded to 68.6 h |
| Ex 6, total scheme cost | £123,713 | £123,712 | stray £9,354 term in the printed sum; rounding |
| Ex 9, accumulated depreciation | £12,355 | £12,353 | annual figure rounded to £1,765 |
| Ex 12, DRC year 17 | £885,852 | £885,851 | rounded terms |
| Ex 13, TM apportioned to bearings / abutments | £13,712 / £4,330 | £13,738 / £4,304 | figures do not follow eq. 17 |
| Ex 13, maintenance cost for joints | £32,952 | £32,953 | rounded terms |

## Planning (MVP)

### D-009 · The planning engine reproduces SAVI's Y5 and Yn sheets exactly
`planning.py` is a vectorised port of SAVI's yearly formulas (Yn) and the one-shot 5-year sheet (Y5).
On the Hertfordshire sample it matches all 58 LAMP Results columns for years 0–30, all 269,452
element-year condition scores, the £103,390,688.73 end workbank and every element and structure decision in
the 5-year programme (£14,233,985.32 expenditure). Tests: `tests/regression/test_planning_regression.py`.

### D-010 · Random start condition: VBA `Rnd` emulated
SAVI places each element at a random point inside its condition band (`Y0!F = ECS + r × (next ECS − ECS)`),
with `r` from VBA `Rnd(-10)` + `Randomize 0`. The engine emulates VBA's 24-bit generator exactly (all 8,692 draws
identical), so any council's data reproduces SAVI. Options: `random="midpoint"` or an integer seed.

### D-011 · Unspent budget carries forward (SAVI); SAMPT says it does not
SAMPT User Guide 2.7.13: "not carried forward". SAVI: `FT15 = previous FT16`. Default SAVI; `carry_forward_budget=False`
gives SAMPT behaviour.

### D-012 · 5-year plan: planned works do not reset condition (SAVI behaviour kept)
`Y5!ED` looks planned works up in `Planned!#REF!`; the error falls through to the deterioration branch, so
elements with planned works deteriorate as if untreated. Kept for parity. **Open:** report to UKRLG.

### D-013 · Year 0: per-type at-risk counts and delay costs are blank in SAVI
`Y0!AQ32:AQ37` read a blank header cell, so only the stock total (134) is populated. Reproduced in the year-0 row.

### D-014 · Elements entering at 5C–5E settle at 5B
Deterioration is capped at 5.0 (`MIN(…, 5)`), so an untreated 5C/5D/5E element reports 5B (5.0) after year 1,
a 3×10⁻¹² "improvement". Kept; invariant tests use a 1×10⁻⁹ tolerance.

### D-015 · SAVI's greedy allocation is not monotone once every need is funded
While the budget binds, more budget always gives better condition (full stock, 10 years: SSCIav 73.1 at £0,
77.1 at £1m, 81.8 at £3m, 84.8 at £5m). Beyond full funding, timing of replacements shifts SSCIav by about ±0.01.
This is the method, not a defect of the port; the optimiser mode (production) addresses it.

### D-016 · Excel numerics are emulated
ROUND uses Excel's 15-significant-digit behaviour (8.825 → 8.83) and the at-risk thresholds compare at 15
significant digits (3.9999999999999996 counts as 4). Without these, 82 priority scores and 4 at-risk counts differed.

### D-017 · "Protected" exposure
Valuation maps Protected to Moderate when choosing the failure intervention (Value!K). Planning does not: Ref06
has no Protected rules, so protected elements receive no condition-triggered work. Both SAVI behaviours kept.

### D-018 · Uncertainty bands are planning-only
`run_uncertainty()` draws time to failure uniformly ±20 % per element (Part A 2.13.7) and a random start inside each
band, and reports P10/P50/P90. Never used for the WGA valuation (Part A note to 2.13.7).

---

## MVP (browser deployment)

### D-019 · The browser engine is a TypeScript port, not Pyodide
The demo must run as one private claude.ai page. Pyodide could not be fetched or tested from the build
environment, and would add about 30 MB. The engine was ported line by line to TypeScript (`web/src/engine`) and
is held to the same golden data: valuation per structure and element, all 58 LAMP Results columns × 31 years,
the ECS profile of all 8,692 elements in every year, and the Y5 element decisions (`web/test/engine.test.ts`).
The page also re-runs this comparison live on load ("Matches SAVI v1.10"). Python remains the reference engine.

### D-020 · The engine runs in a Web Worker
Plans take about 0.5 s, and a 20-run Monte Carlo takes about 10 s. The worker keeps the page responsive and reports
progress. If a worker cannot start, the same code runs on the page (`api.ts` fallback).

### D-021 · Programme decisions: approve, defer, reject
Approve records agreement and changes no numbers. Defer removes the structure's elements from the 5-year pass and from
long-term years 1–5, so the need returns from year 6. Reject removes it from the 5-year programme only, with a
mandatory reason, and leaves the long-term need in place. Every decision re-runs the plan, so the budget it freed
funds the next-ranked schemes. The audit log records both run ids.

### D-022 · New-inspection overrides start at the band midpoint
An approved inspection sets the element's code, and its precise ECS is set to the midpoint of the band (`_apply_condition`).
SAVI's random draw is not used for it, so the preview and the committed run are identical. Valuation uses the new code.

### D-023 · The AI is read-only and must ground every figure
Claude (artifact `sample` capability, on the viewer's account) reaches the plan only through eight page tools. Six
are read-only. Two compute without committing: `run_scenario`, and `prepare_inspection_review`, which creates a draft
for a person to approve. Every number in an answer is checked against the tool results and reported as traced,
derived or untraced. Untraced numbers are highlighted.

### D-024 · "Derived" figures only combine values from the same record
The first grounding rule accepted any sum, difference or ratio of any two numbers in the tool results. The F8 UI test
showed that this excused an invented £12.3m, because about 600 numbers give about 360,000 combinations. Derivation is now
limited to values in the same object or array, such as a before/after pair or one row's fields. A regression test
covers this (`web/test/ai.test.ts`).

### D-025 · Audit log and evaluation history live in the artifact database when available
They are shared, so a reviewer sees the same log. If the store is missing or the viewer cannot write to it, entries are
kept for the session and the page says so. Inputs are never stored server-side, because the inventory stays in the browser.

### D-026 · Data entry record by record (the blank-workbook analogy)
The Data entry page adds, edits and deletes structures, elements, planned works and routine costs one record at a time,
as a user types into SAVI's blank workbook. Before a save, each record is checked against the same validation rules.
Every save re-runs the valuation and both plans. "Start a blank inventory" begins empty, the way the blank workbook does.
Approved inspection codes are now keyed by element number rather than row position, so deleting records cannot misalign them.
Priority-factor weights are an inventory setting (default: the rule set), closing gap 2 of the workbook analysis.
Pickers ignore letter case, as SAVI does, and save the official spelling. The sample's "Tunnel (Bored)" exposed this.

### D-027 · AI evaluation baseline for the MVP (Balanced model, run R001-9a7f)
First live run (25 cases): 23/25 passed. Both failures were harness defects, not AI errors.
T02 summed five table rows (£0.88m), which the pairwise grounding rule could not trace. T04 rested on a false premise,
and Claude correctly declined and asked which elements were meant. Fixes: column totals and running totals now count as
derived (with a unit test that an invented figure stays untraced). T04 now names its elements. The false-premise
wording became trap case H07. Second run (26 cases): 26/26. Accuracy, grounding, tool correctness and task completion
are all 100%, hallucination rate 0%, latency p50 3.9 s and p95 5.9 s. This is the baseline the production AI layer must meet.

### D-028 · Hosted deployment outside claude.ai
`web/src/ui/hosted.ts` installs a runtime with the same `use("sample")` contract when the page is not inside
claude.ai and declares `<meta name="dst-ai-endpoint">`. The page's AI code is therefore unchanged. Tools still run in the
browser, and the grounding check is unchanged. `deploy/lib/claude-proxy.js` is the only server code. It holds the API key,
enforces an optional access code (constant-time compare), caps tokens and request size, rate-limits per IP, and maps
upstream errors without echoing secrets. Downloads fall back to ordinary browser downloads. Tested end to end with the
real server and a stand-in Claude API (`tests/ui/test_hosted.py`).

### D-029 · The hosted AI fails closed
With an API key but no access code (or one shorter than 6 characters), the proxy refuses every AI request (HTTP 503),
the page says AI is switched off, and the server logs why at start-up. `deploy/verify.mjs` checks a live deployment
without any secrets: the page is served, no key is in it, and AI requests without or with a wrong code are refused.
