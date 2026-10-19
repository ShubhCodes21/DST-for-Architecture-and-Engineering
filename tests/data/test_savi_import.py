"""QA family 1c - the SAVI workbook importer (slow: reads the original .xlsm files).

Set SAVI_SAMPLE and SAVI_BLANK to the two SAVI v1.10 workbooks to run these:
    SAVI_SAMPLE=... SAVI_BLANK=... pytest -m slow
"""
from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
import pytest

from dst_engine import Inventory
from dst_engine.io.savi_workbook import SaviWorkbook, read_ruleset

pytestmark = pytest.mark.slow
SAMPLE = os.environ.get("SAVI_SAMPLE")
BLANK = os.environ.get("SAVI_BLANK")


@pytest.mark.skipif(not SAMPLE, reason="SAVI_SAMPLE not set")
def test_importing_the_workbook_reproduces_the_golden_inputs(golden_inventory):
    inv = Inventory.load(Path(SAMPLE))
    for name in ("structures", "elements"):
        a, b = getattr(inv, name), getattr(golden_inventory, name)
        assert a.shape == b.shape, name
        pd.testing.assert_frame_equal(a.astype(str).reset_index(drop=True), b.astype(str).reset_index(drop=True),
                                      check_dtype=False)


@pytest.mark.skipif(not (SAMPLE and BLANK), reason="SAVI_SAMPLE / SAVI_BLANK not set")
def test_blank_and_sample_workbooks_carry_identical_rules():
    """The rule set must not depend on the data in the workbook it was read from."""
    a = read_ruleset(SaviWorkbook.open(SAMPLE))
    b = read_ruleset(SaviWorkbook.open(BLANK))
    differing = []
    for name in a:
        if name in {"adjustment_factors", "priority_factor_weights"}:
            continue  # held on the data sheets; compared below on values only
        try:
            pd.testing.assert_frame_equal(a[name].astype(str), b[name].astype(str))
        except AssertionError:
            differing.append(name)
    assert not differing, differing
    assert list(a["adjustment_factors"]["factor"]) == list(b["adjustment_factors"]["factor"])


@pytest.mark.skipif(not BLANK, reason="SAVI_BLANK not set")
def test_blank_workbook_imports_as_empty_inventory():
    inv = Inventory.load(Path(BLANK))
    assert len(inv.structures) == 0 and len(inv.elements) == 0
