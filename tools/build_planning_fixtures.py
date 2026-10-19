"""Snapshot SAVI v1.10's calculated planning sheets into the golden dataset.

Usage:
    python tools/build_planning_fixtures.py <savi-with-sample-data.xlsm>

Writes golden/hertfordshire-sample/expected/planning/<sheet>.parquet with SAVI's own
column letters as column names (A, B, ..., GH), rows from the first data row, so a test
can name the exact SAVI cell it checks. Also records the random draws (Ref99).
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import openpyxl
import pandas as pd
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "golden" / "hertfordshire-sample" / "expected" / "planning"

# sheet -> (first data row, last column letter, rows source: "elements" | "structures" | int)
SHEETS = {
    "Y0": (5, "AM", "elements"),
    "Y5": (5, "GM", "elements"),
    "Yn": (5, "FY", "elements"),
    "ECS Profile": (5, "DV", "elements"),
    "LAMP Results": (5, "BH", 31),
    "Ref99": (5, "A", "elements"),
}


def to_parquet_safe(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    for c in df.columns:
        kinds = {type(v) for v in df[c].dropna()}
        if kinds and not kinds <= {int, float, bool}:
            df[c] = df[c].map(lambda v: None if v is None else str(v))
        else:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def main(src: str) -> None:
    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    n_el = sum(1 for r in wb["Elements"].iter_rows(min_row=5, min_col=2, max_col=2, values_only=True)
               if r[0] not in (None, ""))
    OUT.mkdir(parents=True, exist_ok=True)
    files = {}
    for sheet, (r0, last, rows) in SHEETS.items():
        n = n_el if rows == "elements" else rows
        ncol = openpyxl.utils.column_index_from_string(last)
        data = list(wb[sheet].iter_rows(min_row=r0, max_row=r0 + n - 1, max_col=ncol, values_only=True))
        df = pd.DataFrame(data, columns=[get_column_letter(i + 1) for i in range(ncol)])
        df = to_parquet_safe(df.dropna(axis=1, how="all"))
        name = sheet.replace(" ", "_").lower()
        p = OUT / f"{name}.parquet"
        df.to_parquet(p, index=False)
        files[p.name] = hashlib.sha256(p.read_bytes()).hexdigest()
        print(f"{sheet:14} {df.shape}")
    (OUT / "manifest.json").write_text(json.dumps({
        "source_workbook": Path(src).name,
        "source_sha256": hashlib.sha256(Path(src).read_bytes()).hexdigest(),
        "note": "Columns are SAVI column letters; row i is SAVI row (first data row + i).",
        "files": files}, indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
