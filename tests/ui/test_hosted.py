"""QA family 3 - the hosted deployment (deploy/): real Node server + page, Claude API replaced by a local stand-in.

H1 engine verified and plans work without any AI configuration
H2 AI blocked until the access code is entered; then a tool-using answer comes back grounded
H3 CSV export becomes an ordinary browser download
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import expect, sync_playwright  # noqa: E402

pytestmark = pytest.mark.ui
DEPLOY = Path(__file__).resolve().parents[2] / "deploy"


def free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class FakeClaude(BaseHTTPRequestHandler):
    """Speaks the Messages API: first asks for a tool, then answers from the tool result."""
    calls: list = []

    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeClaude.calls.append({"key": self.headers.get("x-api-key"), "model": body["model"], "tools": [t["name"] for t in body.get("tools", [])]})
        last = body["messages"][-1]["content"]
        if isinstance(last, list) and last and last[0].get("type") == "tool_result":
            data = json.loads(last[0]["content"])
            grc = data["valuation_wga"]["gross_replacement_cost"]
            out = {"content": [{"type": "text", "text": f"The gross replacement cost is £{grc / 1e6:.1f}m (run {data['run_id']})."}], "stop_reason": "end_turn"}
        else:
            out = {"content": [{"type": "text", "text": "Checking the engine."}, {"type": "tool_use", "id": "tu_1", "name": "get_portfolio_summary", "input": {}}], "stop_reason": "tool_use"}
        raw = json.dumps({**out, "model": body["model"], "usage": {}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)


@pytest.fixture(scope="module")
def site():
    if not (DEPLOY / "public" / "index.html").exists():
        pytest.skip("deploy/public/index.html not built")
    up_port, port = free_port(), free_port()
    up = HTTPServer(("127.0.0.1", up_port), FakeClaude)
    threading.Thread(target=up.serve_forever, daemon=True).start()
    env = {**os.environ, "PORT": str(port), "ANTHROPIC_API_KEY": "sk-test-key", "DST_ACCESS_CODE": "demo-123",
           "DST_ANTHROPIC_URL": f"http://127.0.0.1:{up_port}/v1/messages"}
    proc = subprocess.Popen(["node", "server.mjs"], cwd=DEPLOY, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close(); break
        except OSError:
            time.sleep(0.1)
    yield f"http://127.0.0.1:{port}"
    proc.terminate(); up.shutdown()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(); yield b; b.close()


def open_page(browser, url, tab="overview"):
    ctx = browser.new_context(viewport={"width": 1360, "height": 900}, accept_downloads=True)
    pg = ctx.new_page()
    pg.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg._errors = errors  # type: ignore[attr-defined]
    pg.goto(f"{url}/#{tab}")
    expect(pg.get_by_role("button", name=re.compile("Matches SAVI v1.10"))).to_be_visible(timeout=60_000)
    return pg


def test_h1_hosted_page_engine_works(browser, site):
    pg = open_page(browser, site)
    expect(pg.locator(".kpi").filter(has_text="Gross replacement cost")).to_contain_text("£377.9m")
    expect(pg.locator(".top .badge", has_text="AI ready")).to_be_visible(timeout=15_000)
    assert not pg._errors


def test_h2_ai_needs_access_code_then_answers_grounded(browser, site):
    FakeClaude.calls.clear()
    pg = open_page(browser, site, tab="assistant")
    pg.get_by_label("Question").fill("What is the GRC?")
    pg.get_by_role("button", name="Ask", exact=True).click()
    expect(pg.locator(".msg.ai").last).to_contain_text("needs an access code", timeout=15_000)
    assert FakeClaude.calls == [], "no upstream call without the access code"
    pg.get_by_label("AI access code").fill("demo-123")
    pg.get_by_role("button", name="Save").click()
    pg.get_by_label("Question").fill("What is the GRC?")
    pg.get_by_role("button", name="Ask", exact=True).click()
    msg = pg.locator(".msg.ai").last
    expect(msg).to_contain_text("£377.9m", timeout=20_000)
    expect(msg.locator("mark.traced", has_text="£377.9m")).to_be_visible()
    expect(msg.get_by_text(re.compile(r"\d+/\d+ figures traced"))).to_be_visible()
    assert FakeClaude.calls[0]["key"] == "sk-test-key"
    assert FakeClaude.calls[0]["model"] == "claude-sonnet-5-5"
    assert "get_portfolio_summary" in FakeClaude.calls[0]["tools"]
    assert len(FakeClaude.calls) == 2, "tool round then answer"
    assert not pg._errors


def test_h3_csv_export_downloads(browser, site):
    pg = open_page(browser, site, tab="programme")
    with pg.expect_download() as d:
        pg.get_by_role("button", name="Export CSV").click()
    assert d.value.suggested_filename.startswith("programme-") and d.value.suggested_filename.endswith(".csv")
    content = Path(d.value.path()).read_text()
    assert content.splitlines()[0].startswith("rank,") and "ST423" in content


def test_h4_verify_script_against_running_site(site):
    """deploy/verify.mjs is what Claude Code runs after deploying: page served, no key leaked, AI locked."""
    r = subprocess.run(["node", "verify.mjs", site], cwd=DEPLOY, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "AI refused without an access code" in r.stdout
    r2 = subprocess.run(["node", "verify.mjs", site, "demo-123"], cwd=DEPLOY, capture_output=True, text=True, timeout=60)
    assert r2.returncode == 0 and "AI answers with the right access code" in r2.stdout, r2.stdout


def test_h5_server_without_access_code_keeps_ai_off(browser):
    """Key set but no access code: the server refuses every AI request and says why."""
    port = free_port()
    env = {**os.environ, "PORT": str(port), "ANTHROPIC_API_KEY": "sk-test-key", "DST_ANTHROPIC_URL": "http://127.0.0.1:9/never"}
    env.pop("DST_ACCESS_CODE", None)
    proc = subprocess.Popen(["node", "server.mjs"], cwd=DEPLOY, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close(); break
            except OSError:
                time.sleep(0.1)
        r = subprocess.run(["node", "verify.mjs", f"http://127.0.0.1:{port}"], cwd=DEPLOY, capture_output=True, text=True, timeout=60)
        assert r.returncode == 1 and "FAIL  AI endpoint is configured" in r.stdout
        pg = open_page(browser, f"http://127.0.0.1:{port}", tab="assistant")
        pg.get_by_label("Question").fill("What is the GRC?")
        pg.get_by_role("button", name="Ask", exact=True).click()
        expect(pg.locator(".msg.ai").last).to_contain_text("AI is switched off on this server", timeout=15_000)
    finally:
        proc.terminate()
        out = proc.communicate(timeout=5)[0]
    assert "AI: OFF - DST_ACCESS_CODE missing" in out
