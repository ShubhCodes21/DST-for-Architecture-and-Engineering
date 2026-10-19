"""QA family 3 - UI flow tests (Playwright) for the MVP page web/dist/preview.html.

F1 load + in-browser SAVI verification   F2 programme decision (control layer + audit)
F3 new-inspection workflow (W1)          F4 long-term scenario and apply
F5 upload with validation errors         F6 phone width, no sideways scroll
F7 dark theme                            F8 assistant with a mocked Claude: tools + grounding
F9 workflow note written by (mocked) Claude, approve
Run: pytest tests/ui  (needs `npm run build` in web/ first)
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

pytestmark = pytest.mark.ui
PAGE = Path(__file__).resolve().parents[2] / "web" / "dist" / "preview.html"

MOCK_CLAUDE = r"""
window.__calls = [];
const sample = async (input, opts = {}) => {
  window.__calls.push({ input, tools: (opts.tools || []).map(t => t.name) });
  let figure = "";
  if (opts.tools) {
    const t = opts.tools.find(x => x.name === "get_portfolio_summary");
    const r = await t.execute({}, { signal: new AbortController().signal });
    figure = "£" + (r.valuation_wga.gross_replacement_cost / 1e6).toFixed(1) + "m";
  }
  const text = "The gross replacement cost is " + figure + " (run). An invented figure: £12.3m.";
  opts.onText && opts.onText({ text, delta: text });
  return { text, truncated: false };
};
sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 20 } });
sample.json = async (prompt) => {
  const ev = JSON.parse(prompt.slice(prompt.indexOf("Evidence:") + 9));
  return { headline: "Condition falls; review the scheme", summary: "SCIav " + ev.evaluation.sci_av.after + ".",
           impacts: ["SCIav after " + ev.evaluation.sci_av.after], risks: [], recommendation: "approve", confidence: "high", confidence_reason: "Engine evidence." };
};
window.claude = { use: async (n) => (n === "sample" ? sample : null) };
"""


@pytest.fixture(scope="module")
def browser():
    if not PAGE.exists():
        pytest.skip("web/dist/preview.html not built")
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def open_page(browser, width=1360, scheme="light", mock=False, tab="overview") -> Page:
    ctx = browser.new_context(viewport={"width": width, "height": 900}, color_scheme=scheme)
    if mock:
        ctx.add_init_script(MOCK_CLAUDE)
    pg = ctx.new_page()
    pg.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg._errors = errors  # type: ignore[attr-defined]
    pg.goto(PAGE.as_uri() + "#" + tab)
    expect(pg.get_by_role("button", name=re.compile("Matches SAVI v1.10"))).to_be_visible(timeout=60_000)
    return pg


def nav(pg: Page, name: str):
    pg.get_by_role("navigation").get_by_role("button", name=name).click()


def run_id(pg: Page) -> str:
    return pg.locator(".top .chip").inner_text()


def test_f1_load_verify_and_kpis(browser):
    pg = open_page(browser)
    expect(pg.get_by_text("1,783 of 1,783")).to_be_visible()
    expect(pg.locator(".kpi").filter(has_text="Gross replacement cost")).to_contain_text("£377.9m")
    expect(pg.locator(".kpi").filter(has_text="Depreciated replacement cost")).to_contain_text("£257.4m")
    nav(pg, "Evaluation & trust")
    expect(pg.get_by_text("All checks pass")).to_be_visible()
    expect(pg.locator("td", has_text="£103,390,688.73")).to_have_count(2)
    assert not pg._errors


def test_f2_programme_defer_moves_budget_and_is_audited(browser):
    pg = open_page(browser, tab="programme")
    before = run_id(pg)
    expect(pg.locator("tbody tr").first).to_contain_text("ST423")
    pg.get_by_role("button", name="Defer").click()
    pg.get_by_label("Reason").fill("Coordinate with drainage works in 2031")
    pg.get_by_role("button", name="Confirm defer").click()
    expect(pg.locator(".toast")).to_contain_text("ST423: deferred")
    assert run_id(pg) != before
    expect(pg.locator(".tablewrap tbody tr").first).not_to_contain_text("ST423")
    nav(pg, "Audit & agent ops")
    expect(pg.locator("tbody tr").first).to_contain_text("Programme item deferred")
    expect(pg.locator("tbody tr").first).to_contain_text("Coordinate with drainage")
    nav(pg, "5-year programme")
    pg.get_by_role("button", name="ST423").click()
    pg.get_by_role("button", name="Undo").click()
    expect(pg.locator(".tablewrap tbody tr").first).to_contain_text("ST423")
    assert not pg._errors


def test_f3_inspection_workflow_without_ai(browser):
    pg = open_page(browser, tab="workflow")
    pg.get_by_label("Structure").fill("ST1515")
    sel = pg.locator("select[aria-label^='New condition']").first
    expect(sel).to_be_visible()
    sel.select_option("5B")
    before = run_id(pg)
    pg.get_by_role("button", name="Run assessment").click()
    expect(pg.get_by_text("Rule-based (AI off)")).to_be_visible(timeout=60_000)
    expect(pg.locator(".step.done")).to_have_count(5)
    pg.get_by_role("button", name="Approve and update the plan").click()
    expect(pg.locator(".toast")).to_contain_text("Approved")
    assert run_id(pg) != before
    nav(pg, "Audit & agent ops")
    expect(pg.locator("tbody tr").first).to_contain_text("Inspection approved")
    assert not pg._errors


def test_f3b_workflow_cancel_and_reject_need_reason(browser):
    pg = open_page(browser, tab="workflow")
    pg.get_by_label("Structure").fill("ST423")
    pg.locator("select[aria-label^='New condition']").first.select_option("1A")
    pg.get_by_role("button", name="Run assessment").click()
    expect(pg.get_by_role("button", name="Reject")).to_be_visible(timeout=60_000)
    before = run_id(pg)
    pg.get_by_role("button", name="Reject").click()
    expect(pg.locator(".toast")).to_contain_text("Give a reason")
    pg.get_by_label("Decision note").fill("Inspection photos do not support 1A")
    pg.get_by_role("button", name="Reject").click()
    expect(pg.locator(".toast")).to_contain_text("plan is unchanged")
    assert run_id(pg) == before


def test_f4_long_term_scenario_then_apply(browser):
    pg = open_page(browser, tab="longterm")
    budget = pg.get_by_label("Annual budget").nth(2)
    budget.fill("8000000")
    before = run_id(pg)
    pg.get_by_role("button", name="Compare as scenario").click()
    expect(pg.get_by_text(re.compile(r"Scenarios vs run"))).to_be_visible(timeout=60_000)
    assert run_id(pg) == before, "a scenario must not change the committed run"
    pg.get_by_role("button", name="Apply to plan").click()
    expect(pg.locator(".toast")).to_contain_text("re-run")
    assert run_id(pg) != before
    nav(pg, "Audit & agent ops")
    expect(pg.locator("tbody tr").first).to_contain_text("Plan settings changed")


def test_f5_upload_with_validation_errors_blocks_runs(browser, tmp_path):
    s = tmp_path / "structures.csv"
    e = tmp_path / "elements.csv"
    s.write_text("structure_id,structure_type,number_in_group,length_m,width_m,headroom_m,spans,location,route_supported,route_salted,traffic,obstacle_crossed,obstacle_salted\n"
                 "X1,Bridge:  Vehicular (single span),1,12,8,5,1,Urban,Local Road - A class,1,High,Watercourse - navigable,0\n"
                 "X2,Spaceport,1,12,8,5,1,Moon,Local Road - A class,1,High,Watercourse - navigable,0\n")
    e.write_text("element_seq,structure_id,element_type,material,condition_code,spray_proximity\n"
                 "1,X1,Br01.  Primary Deck Element,Insitu Reinforced Concrete,2B,Not within 3 metres' proximity to spray zone / Not applicable\n"
                 "2,X1,Br01.  Primary Deck Element,Insitu Reinforced Concrete,9Z,Not within 3 metres' proximity to spray zone / Not applicable\n")
    pg = open_page(browser, tab="inventory")
    pg.locator("input[type=file]").set_input_files([str(s), str(e)])
    expect(pg.locator(".badge.bad", has_text=re.compile(r"\d+ blocking errors"))).to_be_visible(timeout=30_000)
    for rule in ("S01_structure_type", "S07_location", "E05_condition", "S12_no_elements"):
        expect(pg.locator("td.mono", has_text=rule).first).to_be_visible()
    nav(pg, "Overview")
    expect(pg.get_by_text("No plan yet")).to_be_visible()
    nav(pg, "Inventory & condition")
    pg.get_by_role("button", name="Reload Hertfordshire sample").click()
    expect(pg.get_by_text("Valid - runs allowed")).to_be_visible(timeout=30_000)


@pytest.mark.parametrize("tab", ["overview", "programme", "longterm", "inventory", "valuation", "assistant", "workflow", "governance", "evaluation"])
def test_f6_phone_width_no_sideways_scroll(browser, tab):
    pg = open_page(browser, width=390, tab=tab)
    pg.wait_for_timeout(300)
    sw, cw = pg.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
    assert sw <= cw + 1, f"{tab}: page scrolls sideways ({sw} > {cw})"
    assert not pg._errors


def test_f7_dark_theme_uses_tokens(browser):
    pg = open_page(browser, scheme="dark")
    bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
    assert bg == "rgb(17, 22, 28)", bg


def test_f8_assistant_tools_and_grounding_with_mocked_claude(browser):
    pg = open_page(browser, mock=True, tab="assistant")
    expect(pg.locator(".top .badge", has_text="AI ready")).to_be_visible(timeout=15_000)
    pg.get_by_label("Question").fill("What is the GRC?")
    pg.get_by_role("button", name="Ask", exact=True).click()
    msg = pg.locator(".msg.ai").last
    expect(msg).to_contain_text("£377.9m")
    expect(msg.locator("mark.traced", has_text="£377.9m")).to_be_visible()
    expect(msg.locator("mark.untraced", has_text="£12.3m")).to_be_visible()
    expect(msg.get_by_text("1 of 2 figures untraced")).to_be_visible()
    expect(msg.get_by_text(re.compile("get_portfolio_summary"))).to_be_visible()
    calls = pg.evaluate("window.__calls")
    assert "prepare_inspection_review" in calls[0]["tools"] and "run_scenario" in calls[0]["tools"]
    nav(pg, "Audit & agent ops")
    pg.get_by_role("tab", name="Agent traces").click()
    expect(pg.locator("tbody tr").first).to_contain_text("get_portfolio_summary")
    nav(pg, "Evaluation & trust")
    pg.get_by_role("tab", name="AI evaluation").click()
    expect(pg.locator("tbody tr")).to_have_count(26, timeout=20_000)


def test_f9_workflow_note_from_claude_then_approve(browser):
    pg = open_page(browser, mock=True, tab="workflow")
    expect(pg.locator(".top .badge", has_text="AI ready")).to_be_visible(timeout=15_000)
    pg.get_by_label("Structure").fill("ST936")
    pg.locator("select[aria-label^='New condition']").first.select_option("5E")
    pg.get_by_role("button", name="Run assessment").click()
    expect(pg.get_by_text("Written by Claude")).to_be_visible(timeout=60_000)
    expect(pg.get_by_text("Recommends: approve")).to_be_visible()
    expect(pg.locator(".step .badge.ok", has_text="figures traced")).to_be_visible()
    pg.get_by_role("button", name="Approve and update the plan").click()
    expect(pg.locator(".toast")).to_contain_text("Approved")


def _add_structure(pg: Page, sid: str):
    pg.get_by_role("button", name="Add structure").click()
    pg.get_by_label("Structure id").fill(sid)
    pg.get_by_label("Name").fill("Test bridge")
    pg.get_by_label("Structure type").select_option("Bridge:  Vehicular (single span)")
    pg.get_by_label("Length (m)").fill("14")
    pg.get_by_label("Average width (m)").fill("9")
    pg.get_by_label("Headroom / height (m)").fill("5.1")
    pg.get_by_label("Number of spans").fill("1")
    pg.get_by_label("Location").select_option("Urban")
    pg.get_by_label("Route supported").select_option("Local Road - A class")
    pg.get_by_label("Traffic").select_option("High")
    pg.get_by_label("Obstacle crossed").select_option("Watercourse - navigable")
    expect(pg.get_by_text("Passes the input checks")).to_be_visible(timeout=10_000)
    pg.get_by_role("button", name="Add structure", exact=True).last.click()
    expect(pg.locator(".toast")).to_contain_text(f"{sid} saved")


def _add_element(pg: Page, etype_prefix: str, code: str):
    pg.get_by_role("button", name="Add element").click()
    sel = pg.get_by_label("Element type")
    value = sel.locator("option", has_text=etype_prefix).first.get_attribute("value")
    sel.select_option(value)
    pg.get_by_label("Material").select_option("Insitu Reinforced Concrete")
    pg.get_by_label("Condition", exact=True).select_option(code)
    pg.get_by_label("Spray proximity").select_option(index=2)
    pg.get_by_role("button", name="Add element", exact=True).last.click()
    expect(pg.locator("form.card.tint")).to_have_count(0, timeout=20_000)    # the editor closes once saved


def test_f10_data_entry_checks_fields_then_adds_a_structure_to_the_sample(browser):
    pg = open_page(browser, tab="dataentry")
    before = run_id(pg)
    pg.get_by_role("button", name="Add structure").click()
    pg.get_by_label("Structure type").select_option("Bridge:  Vehicular (single span)")
    expect(pg.get_by_text("Length must be greater than 0 for this structure type")).to_be_visible(timeout=10_000)
    expect(pg.get_by_role("button", name="Add structure", exact=True).last).to_be_disabled()
    pg.get_by_role("button", name="Cancel").click()
    _add_structure(pg, "ST9001")
    expect(pg.get_by_text("1 blocking problem")).to_be_visible()          # a structure needs elements (S12)
    _add_element(pg, "Br01", "4C")
    expect(pg.get_by_text("Valid - plans up to date")).to_be_visible()
    assert run_id(pg) != before
    expect(pg.locator(".top .muted")).to_contain_text("653 structure records")
    pg.get_by_role("button", name="See its valuation and plan").click()
    expect(pg.get_by_role("dialog")).to_contain_text("ST9001")
    pg.get_by_role("button", name="Close").click()
    nav(pg, "Audit & agent ops")
    expect(pg.locator("tbody")).to_contain_text("Element added")
    assert not pg._errors


def test_f11_blank_inventory_like_the_empty_savi_workbook(browser):
    pg = open_page(browser, tab="dataentry")
    pg.get_by_role("button", name="Start a blank inventory").click()
    pg.get_by_role("button", name="Replace current data").click()
    expect(pg.get_by_text("0 structures, 0 elements")).to_be_visible(timeout=15_000)
    nav(pg, "Overview")
    expect(pg.get_by_text("No plan yet")).to_be_visible()
    nav(pg, "Data entry")
    _add_structure(pg, "ST1")
    _add_element(pg, "Br01", "3C")
    _add_element(pg, "Br09", "2B")
    expect(pg.get_by_text("Valid - plans up to date")).to_be_visible()
    pg.get_by_role("tab", name="Routine costs").click()
    pg.get_by_label("Routine maintenance year 1", exact=True).fill("5000")
    pg.get_by_role("button", name="Copy year 1 to all years").click()
    pg.get_by_role("button", name="Save routine costs").click()
    expect(pg.locator(".toast")).to_contain_text("Routine costs saved")
    nav(pg, "Valuation (WGA)")
    expect(pg.locator(".kpi").filter(has_text="Gross replacement cost")).to_contain_text("£")
    nav(pg, "Overview")
    expect(pg.locator(".kpi").filter(has_text="Average condition")).to_be_visible()
    assert not pg._errors


def test_f12_case_variant_records_edit_cleanly(browser):
    """ST1515 is typed 'Tunnel (Bored)' in the sample; SAVI's list says 'Tunnel (bored)'. Edits must still work."""
    pg = open_page(browser, tab="dataentry")
    pg.get_by_label("Search structures to edit").fill("ST1515")
    pg.locator("td", has_text="ST1515").first.click()
    expect(pg.get_by_label("Structure type")).to_have_value("Tunnel (bored)")
    expect(pg.get_by_text(re.compile(r"\b\d+ types allowed"))).not_to_contain_text(" 0 types")
    pg.get_by_role("button", name="Edit").first.click()
    expect(pg.get_by_label("Element type")).not_to_have_value("")
    pg.get_by_label("Condition", exact=True).select_option("3C")
    pg.get_by_role("button", name="Save element").click()
    expect(pg.locator("form.card.tint")).to_have_count(0, timeout=20_000)
    expect(pg.get_by_text("Valid - plans up to date")).to_be_visible()
    assert not pg._errors
