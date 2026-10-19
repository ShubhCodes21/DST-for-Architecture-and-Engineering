"""Shared fixtures: the versioned rule set, the golden inventory and SAVI's expected results."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from dst_engine import Inventory, RuleSet, run_valuation

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "golden" / "hertfordshire-sample"
RULESET = ROOT / "rulesets" / "savi-1.10"


@pytest.fixture(scope="session")
def rs() -> RuleSet:
    return RuleSet.load(RULESET)


@pytest.fixture(scope="session")
def golden_inventory() -> Inventory:
    return Inventory.load(GOLDEN / "inputs")


@pytest.fixture(scope="session")
def golden_run(golden_inventory, rs):
    return run_valuation(golden_inventory, rs)


@pytest.fixture(scope="session")
def expected_summary() -> dict:
    return json.loads((GOLDEN / "expected" / "summary.json").read_text())


@pytest.fixture(scope="session")
def expected_structures() -> pd.DataFrame:
    return pd.read_parquet(GOLDEN / "expected" / "structures.parquet")


@pytest.fixture(scope="session")
def expected_elements() -> pd.DataFrame:
    return pd.read_parquet(GOLDEN / "expected" / "elements.parquet")


@pytest.fixture(scope="session")
def tolerances() -> dict:
    return json.loads((ROOT / "tests" / "regression" / "tolerances.json").read_text())


def subset_inventory(inv: Inventory, structure_ids) -> Inventory:
    """A smaller inventory holding only the given structures and their elements."""
    ids = set(structure_ids)
    s = inv.structures[inv.structures["structure_id"].isin(ids)].reset_index(drop=True)
    e = inv.elements[inv.elements["structure_id"].isin(ids)].reset_index(drop=True)
    return Inventory(s, e, settings=dict(inv.settings))
