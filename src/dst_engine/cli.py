"""Command line: validate an inventory and run the WGA valuation.

    python -m dst_engine validate  <inputs dir | SAVI .xlsm>
    python -m dst_engine valuation <inputs dir | SAVI .xlsm> [--out results/] [--ruleset path]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .inventory import Inventory
from .ruleset import DEFAULT_RULESET, RuleSet
from .run import run_valuation
from .validation import validate_inventory


def _money(v: float) -> str:
    return f"£{v:,.0f}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="dst_engine", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["validate", "valuation"])
    ap.add_argument("inputs", help="directory of input tables, or a SAVI v1.10 workbook")
    ap.add_argument("--ruleset", default=str(DEFAULT_RULESET))
    ap.add_argument("--out", default=None, help="directory for results (valuation) or the issue list (validate)")
    a = ap.parse_args(argv)

    rs = RuleSet.load(a.ruleset)
    inv = Inventory.load(a.inputs)
    report = validate_inventory(inv.structures, inv.elements, rs)
    s = report.summary()
    print(f"Validation: {'VALID' if s['valid'] else 'INVALID'} - {s['errors']} errors, {s['warnings']} warnings")
    for rule, n in sorted(s["by_rule"].items()):
        print(f"  {rule:40} {n}")
    out = Path(a.out) if a.out else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
        report.to_frame().to_csv(out / "validation_issues.csv", index=False)

    if a.command == "validate":
        return 0 if s["valid"] else 1
    if not s["valid"]:
        print("Valuation not run: fix the blocking errors first (SAMPT Part B 5.4).", file=sys.stderr)
        return 1

    t0 = time.perf_counter()
    run = run_valuation(inv, rs)
    dt = time.perf_counter() - t0
    v = run.summary["valuation"]
    c = run.summary["condition_y0"]["ssci_table"]["Stock"]
    print(f"\nValuation ({v['price_year']} prices, rule set {rs.name}) in {dt:.2f}s")
    print(f"  Structures {run.summary['n_structures']:,.0f} ({run.summary['n_structure_records']} records), "
          f"elements {run.summary['n_elements']:,}")
    print(f"  Gross replacement cost      {_money(v['grc'])}")
    print(f"  Depreciated replacement cost {_money(v['drc'])} ({v['drc_pct_of_grc']:.1%} of GRC)")
    print(f"  Accumulated depreciation    {_money(v['accumulated_depreciation'])}")
    print(f"  Annual depreciation         {_money(v['annual_depreciation'])}")
    print(f"  Stock condition: SSCIav {c['ssci_av']:.2f}, SSCIcrit {c['ssci_crit']:.2f}, SSS {c['sss']:.3f}")
    if out:
        (out / "summary.json").write_text(run.to_json())
        run.structures.to_csv(out / "structures.csv", index=False)
        run.elements.to_csv(out / "elements.csv", index=False)
        print(f"\nResults written to {out}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
