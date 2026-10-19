"""Export the rule set, the sample inventory and the regression fixtures for the browser engine.

Usage:  python tools/export_web_data.py
Writes  web/data/ruleset.json, web/data/sample.json and web/test/fixtures/*.json

The TypeScript engine (web/src/engine) reads exactly these files; its tests compare its output
with SAVI's own results (the same golden data the Python engine is tested against).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dst_engine import Inventory, RuleSet  # noqa: E402

WEB = ROOT / "web"
GOLD = ROOT / "golden" / "hertfordshire-sample"


def clean(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        if math.isnan(f):
            return None
        if math.isinf(f):
            return 1e308 if f > 0 else -1e308
        return f
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


def records(df: pd.DataFrame) -> dict:
    """Column-oriented table: {columns: [...], rows: [[...], ...]} (compact)."""
    return {"columns": list(df.columns),
            "rows": [[clean(v) for v in row] for row in df.itertuples(index=False, name=None)]}


def main():
    rs = RuleSet.load()
    out = {"name": rs.name, "price_year": rs.manifest.get("price_year"),
           "source_sha256": rs.manifest.get("source_sha256"), "tables": {}}
    for name, df in rs.tables.items():
        if name in ("exposure_rules", "maintenance_actions_base"):
            continue
        out["tables"][name] = records(df)
    er = rs["exposure_rules"]
    out["exposure_rules"] = {str(int(k)): v for k, v in zip(er["exposure_id"], er["exposure"])}
    (WEB / "data").mkdir(parents=True, exist_ok=True)
    (WEB / "data" / "ruleset.json").write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))

    inv = Inventory.load(GOLD / "inputs")
    sample = {"name": "Hertfordshire sample (SAVI v1.10)",
              "structures": records(inv.structures), "elements": records(inv.elements),
              "planned": records(inv.planned), "routine": records(inv.routine), "settings": inv.settings}
    (WEB / "data" / "sample.json").write_text(json.dumps(sample, separators=(",", ":"), default=str))

    # regression fixtures (SAVI's own results)
    fx = WEB / "test" / "fixtures"
    fx.mkdir(parents=True, exist_ok=True)
    summary = json.loads((GOLD / "expected" / "summary.json").read_text())
    (fx / "summary.json").write_text(json.dumps(summary))
    st = pd.read_parquet(GOLD / "expected" / "structures.parquet")
    el = pd.read_parquet(GOLD / "expected" / "elements.parquet")
    (fx / "structures.json").write_text(json.dumps(records(st[["structure_id", "grc", "sci_av", "sci_crit", "terc",
                                                               "annual_depreciation", "accumulated_depreciation",
                                                               "drc", "traffic_delay_cost"]])))
    (fx / "elements.json").write_text(json.dumps(records(el[["element_seq", "ecs", "eci", "exposure_id",
                                                             "rule_row", "works_cost", "tm_cost",
                                                             "element_replacement_cost"]])))
    P = GOLD / "expected" / "planning"
    lamp = pd.read_parquet(P / "lamp_results.parquet")
    (fx / "lamp_results.json").write_text(json.dumps(records(lamp)))
    prof = pd.read_parquet(P / "ecs_profile.parquet")
    keep = [c for c in prof.columns if c not in ("A", "B", "C", "D", "E")]
    (fx / "ecs_profile.json").write_text(json.dumps({"columns": keep,
                                                     "rows": prof[keep].round(15).values.tolist()}))
    y5 = pd.read_parquet(P / "y5.parquet")
    (fx / "y5.json").write_text(json.dumps(records(y5[["M", "Q", "AB", "AE", "DP", "DX", "DY", "ED", "EE"]])))
    for p in sorted((WEB / "data").glob("*.json")) + sorted(fx.glob("*.json")):
        print(f"{p.relative_to(ROOT)}  {p.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
