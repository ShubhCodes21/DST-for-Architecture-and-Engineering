# Structures DST · MVP

A decision support tool for UK highway structures that follows the SAMPT method and is compatible with **SAVI v1.10**
(UKRLG UK Bridges Board). It contains:

* **dst-engine** (Python): the reference engine. It does validation, the WGA valuation, the 5-year programme and
  the long-term plan, and it reproduces SAVI's own results for the Hertfordshire sample cell by cell.
* **web/**: the MVP page, published as one private claude.ai artifact. The engine is ported to TypeScript and runs in
  the browser. The AI layer (Claude, through the artifact runtime) answers questions and drafts decision notes
  from the engine's numbers only.

## MVP exit gate: passed

| Gate | Result |
| --- | --- |
| Browser engine reproduces SAVI v1.10 | 1,783 / 1,783 LAMP cells, 8,692 × 31 ECS profile, Y5 decisions, valuation per element |
| Input data accuracy (QA 1) | 41 pytest + validation parity test (TS = Pandera rules) |
| Model output (QA 2) | 194 pytest (unit, property, regression) + 27 node tests |
| UI flows (QA 3) | 18 Playwright tests: load, decisions, inspection workflow, scenarios, upload errors, phone width, dark theme, AI with mocked Claude |
| Coverage | 91 % (gate 85 %) |
| Page size / plan run time | 3.5 MB · about 0.5 s per long-term plus 5-year run |

## What the page does

| Module | Page | AI role | Control |
| --- | --- | --- | --- |
| Inventory & condition | Upload a SAVI .xlsm or CSVs, validation report, structure explorer | none | runs blocked on errors |
| Asset evaluation | Valuation (WGA): GRC, DRC, depreciation by group and type | none | deterministic only |
| Planning engine / 5-year programme | Ranked schemes with a "why this priority" breakdown | explains, via tools | approve / defer / reject, with a reason, re-plan, audit |
| Long-term plan | 30-year LAMP results, budget bands, strategy, scenarios, P10–P90 | runs what-if scenarios | apply only on confirm |
| W1 new-inspection workflow | record → evaluate → re-prioritise → 5-yr → long-term → note → decide | writes a grounded decision note | approve / edit / reject |
| Governance | audit log, agent traces, run registry, evaluation set (25 cases), responsible-AI checklist | measured | |

## Deploy

See **DEPLOY.md**: Vercel, Docker/Node or static hosting. The AI features use `deploy/api/claude.js` with your Anthropic key.

## Build and test the page

```bash
python tools/export_web_data.py          # rule set, sample and SAVI fixtures -> web/data, web/test/fixtures
cd web && npm ci && npm run typecheck && npm test && node build.mjs     # -> dist/index.html
cd .. && pytest -m ui                    # Playwright flows against web/dist/preview.html
python tools/qa_summary.py && (cd web && node build.mjs)   # embeds the QA results shown on the page
```

---

# dst-engine · proof of concept (Python reference engine)

A Python engine that implements the SAMPT method as packaged in **SAVI v1.10** (UKRLG UK Bridges Board).
This proof of concept covers the year-0 engine: input validation, Gross Replacement Cost, condition indices and the
**WGA valuation** (DRC, accumulated and annual depreciation). It reproduces SAVI's own calculated results for the
Hertfordshire sample stock, element by element.

## POC exit gate: passed

| Measure | SAVI v1.10 | dst-engine | Difference |
| --- | --- | --- | --- |
| Gross replacement cost | £377,929,803.68 | £377,929,803.68 | < £0.000001 |
| Depreciated replacement cost | £257,364,205.75 | £257,364,205.75 | < £0.000001 |
| Annual depreciation | £5,632,473.58 | £5,632,473.58 | < £0.000001 |
| Stock SSCI average / critical | 86.4208 / 78.1415 | 86.4208 / 78.1415 | < 1e-9 |
| Condition bands (VG/G/F/P/VP) | 273 / 283 / 89 / 55 / 0 | 273 / 283 / 89 / 55 / 0 | exact |
| Structures at risk (year 0) | 134 | 134 | exact |
| Per structure (652 records × 15 fields) | Value, Y0 sheets | — | 0 mismatches |
| Per element (8,692 × 22 fields) | Value, Y0 sheets | — | 0 mismatches |
| Run time | minutes (SAVI); 20 min–7 h (SAMPT Excel) | **0.8 s** | |

Not in the POC: the 5-year and long-term plans (MVP), and any UI.

## Quick start

```bash
pip install -e ".[test]"
python -m dst_engine validate  golden/hertfordshire-sample/inputs
python -m dst_engine valuation golden/hertfordshire-sample/inputs --out results/
# or straight from a SAVI workbook:
python -m dst_engine valuation "SAVI v1.10 with sample data.xlsm" --out results/
pytest                      # 147 tests, about 45 s
```

`valuation` validates first and refuses to run if there are blocking errors (SAMPT Part B 5.4).

## Layout

```
src/dst_engine/
  ruleset.py      versioned rule set (Part C / SAVI Ref tables), SHA-256 verified on load
  inventory.py    structures, elements, programmes, settings
  validation.py   Pandera schemas mirroring SAVI's CHECK columns + quality warnings
  grc.py          GRC: key dimension × unit rate × adjustment factors
  condition.py    ECS, ECF, ECI, SCIav/SCIcrit, SSCI, SSS, condition bands, year-0 traffic delay
  valuation.py    exposure, life consumed, failure intervention cost, TERC, depreciation, DRC
  formulas.py     SAMPT Part A equations (works cost, add-ons, TM, penalties, depreciation, ECS averaging)
  run.py          run_valuation() -> results + summary + lineage
  io/savi_workbook.py   reads any SAVI v1.10 workbook (rules and inventory)
rulesets/savi-1.10/     30 rule tables (Parquet) + manifest
golden/hertfordshire-sample/  inputs + SAVI's expected results (stock, structure, element) + manifest
tools/build_fixtures.py rebuilds both from a SAVI workbook
tests/                  QA framework, by family (below)
docs/DECISION_LOG.md    every divergence between SAMPT, SAVI and this engine
```

## QA framework mapping

| QA family | Folder | What it proves |
| --- | --- | --- |
| 1 Input data accuracy | `tests/data` | Fixture hashes; rule tables vs SAMPT Part C; indexation; every SAVI CHECK rule fires on a bad value; golden data valid; importer round-trips the workbook |
| 2a Unit (oracle 1) | `tests/unit` | SAMPT Part A Examples 5–9, 12, 13 and the Technical Note, with errata recorded; hand calculations for single structures |
| 2b/2c Property and metamorphic | `tests/property` | Bounds, independence, order invariance, determinism, condition monotonicity, GRC scaling, stock duplication |
| 2d Regression (oracle 2) | `tests/regression` | Stock, every structure and every element vs SAVI's calculated run; tolerances in `tolerances.json` |
| 2e Performance | `tests/regression` | Golden valuation under 10 s |
| 3 UI flows | — | MVP (Playwright) |

The importer tests read the original workbooks: `SAVI_SAMPLE=… SAVI_BLANK=… pytest -m slow`.

## Rule set and lineage

Every run records the engine version, rule-set name and source hash, price year, authority type and a SHA-256
of the inventory, so the same inputs reproduce the same figures. The rule set is data: changing a unit rate or a
deterioration curve is a reviewed change to `rulesets/`, never to code.
