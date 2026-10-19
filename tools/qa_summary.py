"""Collect the QA framework results (pytest JUnit XML, node TAP, coverage) into web/build/qa-summary.json,
which the page shows under Evaluation & trust > Verification.   Usage: python tools/qa_summary.py"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

B = Path(__file__).resolve().parents[1] / "web" / "build"
FAMILIES = {
    "tests/data": ("1 Input data", "pandera schemas, rule-set integrity, validation rules"),
    "tests/unit": ("2 Model output", "hand calculations of every SAMPT equation"),
    "tests/property": ("2 Model output", "invariants: budget never exceeded, monotonicity, determinism"),
    "tests/regression": ("2 Model output", "every SAVI v1.10 figure: valuation, 5-year programme, 30-year plan, ECS profile"),
    "tests/ui": ("3 UI flows", "Playwright: load, decisions, inspection workflow, scenarios, upload errors, phone width, AI with mocked Claude"),
}


def main():
    suites: dict[str, dict] = {}
    root = ET.parse(B / "pytest.xml").getroot()
    for tc in root.iter("testcase"):
        cls = tc.get("classname", "")
        path = "/".join(cls.split(".")[:2])
        if tc.find("skipped") is not None:
            continue
        s = suites.setdefault(path, {"tests": 0, "passed": 0})
        s["tests"] += 1
        if tc.find("failure") is None and tc.find("error") is None:
            s["passed"] += 1
    out = []
    for path, (fam, covers) in FAMILIES.items():
        if path in suites:
            out.append({"family": fam, "name": f"pytest {path}", "covers": covers, **suites[path]})
    tap = (B / "node-tests.tap").read_text()
    ok = len(re.findall(r"^ok \d+", tap, re.M))
    bad = len(re.findall(r"^not ok \d+", tap, re.M))
    out.append({"family": "2 Model output", "name": "node web/test (browser engine)", "tests": ok + bad, "passed": ok,
                "covers": "TypeScript engine = SAVI figures; engine service flows; grounding check"})
    cov = json.loads((B / "coverage.json").read_text())["totals"]["percent_covered"]
    data = {"built": datetime.now(timezone.utc).isoformat(), "suites": out, "coverage": f"{cov:.0f}%"}
    (B / "qa-summary.json").write_text(json.dumps(data))
    print(json.dumps(data, indent=1))


if __name__ == "__main__":
    main()
