"""The command line validates first and refuses to value invalid data (SAMPT Part B 5.4)."""
from __future__ import annotations

import json
import shutil

import pandas as pd

from dst_engine.cli import main

from ..conftest import GOLDEN


def test_validate_golden_exit_code(capsys):
    assert main(["validate", str(GOLDEN / "inputs")]) == 0
    assert "VALID" in capsys.readouterr().out


def test_valuation_writes_results(tmp_path, capsys):
    assert main(["valuation", str(GOLDEN / "inputs"), "--out", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "£377,929,804" in out and "£257,364,206" in out
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["lineage"]["ruleset"] == "savi-1.10"
    assert (tmp_path / "structures.csv").exists() and (tmp_path / "elements.csv").exists()
    assert (tmp_path / "validation_issues.csv").exists()


def test_invalid_data_is_not_valued(tmp_path, capsys):
    inputs = tmp_path / "inputs"
    shutil.copytree(GOLDEN / "inputs", inputs)
    s = pd.read_parquet(inputs / "structures.parquet")
    s.loc[0, "traffic"] = "Gridlock"
    s.to_parquet(inputs / "structures.parquet", index=False)
    assert main(["valuation", str(inputs), "--out", str(tmp_path / "out")]) == 1
    captured = capsys.readouterr()
    assert "INVALID" in captured.out and "not run" in captured.err
    assert not (tmp_path / "out" / "summary.json").exists()
