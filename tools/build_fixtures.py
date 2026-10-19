"""Build the versioned rule set and the golden dataset from a SAVI v1.10 workbook.

Usage:
    python tools/build_fixtures.py <savi-with-sample-data.xlsm>

Writes:
    rulesets/savi-1.10/<table>.parquet + manifest.json
    golden/hertfordshire-sample/inputs/*.parquet, settings.json
    golden/hertfordshire-sample/expected/{summary.json, structures.parquet, elements.parquet}
    golden/hertfordshire-sample/manifest.json  (sha256 of every file + source workbook)

Run once per SAVI release. The outputs are committed; CI verifies their hashes.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dst_engine.io.savi_workbook import SaviWorkbook, read_inventory, read_ruleset  # noqa: E402

RULESET_DIR = ROOT / "rulesets" / "savi-1.10"
GOLDEN_DIR = ROOT / "golden" / "hertfordshire-sample"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_parquet(df: pd.DataFrame, path: Path) -> None:
    """Parquet needs one type per column: stringify mixed object columns."""
    df = df.copy()
    for c in df.columns:
        if df[c].dtype == object:
            kinds = {type(v) for v in df[c].dropna()}
            if len(kinds) > 1 or (kinds and not kinds <= {str}):
                df[c] = df[c].map(lambda v: None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v))
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)


def frame(wb: SaviWorkbook, sheet: str, rng: str, cols: dict[str, str], nrows: int) -> pd.DataFrame:
    """Read selected columns (letter -> name) for the first `nrows` data rows from row 5."""
    from openpyxl.utils import column_index_from_string as ci, get_column_letter
    last = max(ci(k) for k in cols)
    rows = wb.grid(sheet, f"A5:{get_column_letter(last)}{4 + nrows}")
    return pd.DataFrame({name: [r[ci(letter) - 1] for r in rows] for letter, name in cols.items()})


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main(src: str) -> None:
    src = Path(src)
    wb = SaviWorkbook.open(src)

    # ---------------- rule set ----------------
    tables = read_ruleset(wb)
    files = {}
    for name, df in tables.items():
        p = RULESET_DIR / f"{name}.parquet"
        write_parquet(df, p)
        files[p.name] = sha256(p)
    manifest = {
        "ruleset": "savi-1.10",
        "description": "SAMPT Part C defaults as packaged in SAVI v1.10 (UKRLG UK Bridges Board), "
                       "indexed to 2025/26 (ROCOS).",
        "price_year": "2025/26",
        "source_workbook": src.name,
        "source_sha256": sha256(src),
        "files": files,
    }
    (RULESET_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))

    # ---------------- inventory ----------------
    inv = read_inventory(wb)
    gfiles = {}
    for name in ("structures", "elements", "planned", "routine"):
        p = GOLDEN_DIR / "inputs" / f"{name}.parquet"
        write_parquet(getattr(inv, name), p)
        gfiles[f"inputs/{p.name}"] = sha256(p)
    (GOLDEN_DIR / "inputs").mkdir(parents=True, exist_ok=True)
    sp = GOLDEN_DIR / "inputs" / "settings.json"
    sp.write_text(json.dumps(inv.settings, indent=2, default=str))
    gfiles["inputs/settings.json"] = sha256(sp)

    ns, ne = len(inv.structures), len(inv.elements)

    # ---------------- expected: per structure ----------------
    st = pd.concat([
        frame(wb, "Structures", "", {"B": "structure_id", "AH": "adj_tunnel_over_400m", "AI": "adj_rural",
                                    "AJ": "adj_route_unclassified", "AK": "adj_obstacle_footway",
                                    "AL": "adj_obstacle_watercourse_non_nav", "AM": "adj_obstacle_land_disused",
                                    "AN": "adj_obstacle_railway", "AO": "adj_obstacle_tenanted_business",
                                    "AQ": "size_number", "AR": "size_length", "AS": "size_width",
                                    "AT": "size_headroom", "AU": "key_dimension", "AV": "basic_grc",
                                    "AW": "grc_uplift", "AX": "grc", "AY": "network_priority",
                                    "AZ": "structure_priority_factor", "BA": "avf_type", "BB": "avf",
                                    "BC": "key_dimension_x_avf", "BD": "n_elements", "BU": "check_total"}, ns),
        frame(wb, "Y0", "", {"P": "vh_h_ecs_band", "U": "traffic_delay_days", "X": "daily_delay_rate",
                             "Y": "traffic_delay_cost", "Z": "structures_with_traffic_delay",
                             "AD": "max_eci_very_high", "AE": "sci_av", "AF": "sci_crit",
                             "AK": "state_of_good_repair"}, ns),
        frame(wb, "Value", "", {"AP": "exp_location", "AQ": "exp_route_salted", "AR": "exp_traffic",
                                "AS": "exp_watercourse", "AT": "exp_obstacle_salted",
                                "AZ": "terc", "BB": "grc_to_terc_factor", "BM": "annual_depreciation",
                                "BN": "accumulated_depreciation", "BO": "drc"}, ns),
    ], axis=1)
    write_parquet(st, GOLDEN_DIR / "expected" / "structures.parquet")

    # ---------------- expected: per element ----------------
    el = pd.concat([
        frame(wb, "Elements", "", {"A": "element_seq", "B": "structure_id", "C": "element_type",
                                   "Y": "element_size", "AB": "tm_location", "AC": "tm_arrangement_id",
                                   "AL": "check_inventory", "AN": "check_condition"}, ne),
        frame(wb, "Y0", "", {"C": "ecs", "G": "importance", "H": "eif", "I": "ecf", "J": "eci"}, ne),
        frame(wb, "Value", "", {"F": "exposure_id", "G": "exposure", "H": "time_to_failure",
                                "I": "equivalent_age_frac", "K": "rule_row", "L": "condition_after",
                                "M": "repair_age_frac", "O": "works_cost_id", "P": "cost_type",
                                "Q": "works_quantity", "R": "works_cost", "S": "tm_code", "T": "tm_cost",
                                "U": "fP", "V": "fO", "W": "fD", "X": "factor_2b",
                                "Y": "element_replacement_cost", "BE": "terc_factor", "BF": "factored_cost",
                                "BG": "annual_depreciation", "BH": "accumulated_depreciation"}, ne),
    ], axis=1)
    write_parquet(el, GOLDEN_DIR / "expected" / "elements.parquet")

    # ---------------- expected: stock summary ----------------
    c = wb.cell
    summary = {
        "source": "SAVI v1.10 'with sample data and analysis' - Value Dashboard, Y0 and LAMP/SAMP sheets",
        "n_structure_records": ns,
        "n_structures": num(c("Value Dashboard", "G11")),
        "n_elements": num(c("Value Dashboard", "G12")),
        "valuation": {
            "grc": num(c("Value Dashboard", "K7")),
            "drc": num(c("Value Dashboard", "K11")),
            "annual_depreciation": num(c("Value Dashboard", "P10")),
            "accumulated_depreciation": num(c("Valuation Certificate", "W21")),
            "price_year": c("Value Dashboard", "P6"),
            "by_avf_group": {
                str(r[9]): {"structures": num(r[1]), "grc": num(r[2]), "drc": num(r[3]),
                            "depreciation": num(r[4])}
                for r in wb.grid("Value Dashboard", "L21:U27")
            },
            "by_structure_type": {
                str(r[0]): {"structures": num(r[1]), "grc": num(r[2]), "drc": num(r[3])}
                for r in wb.grid("Value Dashboard", "L34:O54") if r[0] and r[0] != "Total"
            },
        },
        "condition_y0": {
            "ssci_av": {str(r[0]): num(r[1]) for r in wb.grid("Y0", "AP6:AQ12") if r[0]},
            "ssci_crit": {str(r[0]): num(r[1]) for r in wb.grid("Y0", "AP13:AQ19") if r[0]},
            "ssci_table": {str(r[0]): {"ssci_av": num(r[1]), "ssci_crit": num(r[2]), "sss": num(r[3])}
                           for r in wb.grid("Value Dashboard", "G48:J55")},
            "bands": {str(r[0]).strip(): num(r[1]) for r in wb.grid("Value Dashboard", "I21:J25")},
            "structures_at_risk": num(c("Y0", "AQ38")),
            "traffic_delay_cost": sum(num(r[0]) or 0 for r in wb.grid("Y0", f"Y5:Y{4 + ns}")),
        },
        "short_term_plan": {
            "budget": num(c("SAMP Dashboard", "K8")),
            "expenditure": num(c("SAMP Dashboard", "K9")),
            "ssci_av_y5": num(c("SAMP Dashboard", "R9")),
            "ssci_crit_y5": num(c("SAMP Dashboard", "R10")),
            "sss_y5": num(c("SAMP Dashboard", "R11")),
        },
        "long_term_plan": {
            "years": num(c("LAMP Dashboard", "H10")),
            "total_budget": num(c("LAMP Dashboard", "AQ6")),
            "expenditure": num(c("LAMP Dashboard", "AQ7")),
            "discounted_expenditure": num(c("LAMP Dashboard", "BK7")),
            "workbank_end": num(c("LAMP Dashboard", "AQ12")),
        },
    }
    p = GOLDEN_DIR / "expected" / "summary.json"
    p.write_text(json.dumps(summary, indent=2))
    for name in ("structures.parquet", "elements.parquet", "summary.json"):
        gfiles[f"expected/{name}"] = sha256(GOLDEN_DIR / "expected" / name)

    (GOLDEN_DIR / "manifest.json").write_text(json.dumps({
        "dataset": "hertfordshire-sample",
        "description": "Hertfordshire CC sample stock shipped with SAVI v1.10, with SAVI's own calculated results.",
        "ruleset": "savi-1.10",
        "source_workbook": src.name,
        "source_sha256": sha256(src),
        "files": gfiles,
    }, indent=2))
    print(f"rule set: {len(tables)} tables -> {RULESET_DIR}")
    print(f"golden: {ns} structure records, {ne} elements -> {GOLDEN_DIR}")
    print(json.dumps(summary["valuation"]["grc"]), json.dumps(summary["valuation"]["drc"]))


if __name__ == "__main__":
    main(sys.argv[1])
