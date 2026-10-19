"""QA family 2d - regression against SAVI v1.10's own calculated run of the Hertfordshire sample.

Oracle 2 in the QA framework. Stock totals, every structure and every element are compared.
Tolerances live in tolerances.json; loosening one needs a decision-log entry.
"""
from __future__ import annotations

import time

import numpy as np
import pandas as pd
import pytest

from dst_engine import run_valuation

pytestmark = pytest.mark.regression


def rel(a, b):
    return abs(a - b) / max(abs(b), 1.0)


# ---------------------------------------------------------------- stock level
@pytest.mark.parametrize("field", ["grc", "drc", "annual_depreciation", "accumulated_depreciation"])
def test_stock_valuation(golden_run, expected_summary, tolerances, field):
    got, exp = golden_run.summary["valuation"][field], expected_summary["valuation"][field]
    assert rel(got, exp) <= tolerances["relative"][f"valuation.{field}"], (got, exp)


def test_headline_values_in_pounds(golden_run):
    v = golden_run.summary["valuation"]
    assert round(v["grc"], 2) == 377_929_803.68
    assert round(v["drc"], 2) == 257_364_205.75
    assert round(v["annual_depreciation"], 2) == 5_632_473.58


def test_valuation_by_avf_group(golden_run, expected_summary, tolerances):
    tol = tolerances["relative"]["valuation.by_avf_group"]
    for group, exp in expected_summary["valuation"]["by_avf_group"].items():
        got = golden_run.summary["valuation"]["by_avf_group"][group]
        assert got["structures"] == exp["structures"], group
        for f in ("grc", "drc", "depreciation"):
            assert rel(got[f], exp[f]) <= tol, (group, f, got[f], exp[f])


def test_valuation_by_structure_type(golden_run, expected_summary, tolerances):
    tol = tolerances["relative"]["valuation.by_structure_type"]
    got_all = {k.casefold(): v for k, v in golden_run.summary["valuation"]["by_structure_type"].items()}
    for t, exp in expected_summary["valuation"]["by_structure_type"].items():
        got = got_all[t.casefold()]
        assert got["structures"] == exp["structures"], t
        assert rel(got["grc"], exp["grc"]) <= tol and rel(got["drc"], exp["drc"]) <= tol, t


def test_stock_condition_indices(golden_run, expected_summary, tolerances):
    tol = tolerances["absolute"]["condition.ssci"]
    for group, exp in expected_summary["condition_y0"]["ssci_table"].items():
        got = golden_run.summary["condition_y0"]["ssci_table"][group]
        for f in ("ssci_av", "ssci_crit", "sss"):
            assert abs(got[f] - exp[f]) <= tol, (group, f, got[f], exp[f])


def test_condition_bands_exact(golden_run, expected_summary):
    assert golden_run.summary["condition_y0"]["bands"] == expected_summary["condition_y0"]["bands"]


def test_structures_at_risk_and_delay_cost(golden_run, expected_summary):
    got, exp = golden_run.summary["condition_y0"], expected_summary["condition_y0"]
    assert got["structures_at_risk"] == exp["structures_at_risk"] == 134
    assert rel(got["traffic_delay_cost"], exp["traffic_delay_cost"]) < 1e-9


def test_counts(golden_run, expected_summary):
    assert golden_run.summary["n_structure_records"] == 652
    assert golden_run.summary["n_structures"] == expected_summary["n_structures"] == 700
    assert golden_run.summary["n_elements"] == expected_summary["n_elements"] == 8692


# ---------------------------------------------------------------- structure level
STRUCTURE_MONEY = ["basic_grc", "grc", "terc", "annual_depreciation", "accumulated_depreciation", "drc",
                   "traffic_delay_cost"]
STRUCTURE_OTHER = ["key_dimension", "grc_uplift", "key_dimension_x_avf", "sci_av", "sci_crit",
                   "max_eci_very_high", "traffic_delay_days", "structures_with_traffic_delay"]


def _compare(got: pd.Series, exp: pd.Series, rtol: float, atol: float) -> np.ndarray:
    g = pd.to_numeric(got, errors="coerce").fillna(0).to_numpy(float)
    e = pd.to_numeric(exp, errors="coerce").fillna(0).to_numpy(float)
    return np.where(np.abs(g - e) > atol + rtol * np.abs(e))[0]


@pytest.mark.parametrize("col", STRUCTURE_MONEY + STRUCTURE_OTHER)
def test_every_structure(golden_run, expected_structures, tolerances, col):
    rtol = tolerances["relative"]["structures.money"]
    bad = _compare(golden_run.structures[col], expected_structures[col], rtol, 1e-9)
    assert len(bad) == 0, golden_run.structures.iloc[bad[:5]][["structure_id", col]]


@pytest.mark.parametrize("col", ["state_of_good_repair", "avf_type", "adj_rural", "adj_route_unclassified",
                                 "adj_obstacle_watercourse_non_nav", "adj_tunnel_over_400m"])
def test_every_structure_exact(golden_run, expected_structures, col):
    got = golden_run.structures[col].astype(str).str.replace(r"\.0$", "", regex=True)
    exp = expected_structures[col].astype(str).str.replace(r"\.0$", "", regex=True)
    assert (got.values == exp.values).all()


# ---------------------------------------------------------------- element level
ELEMENT_MONEY = ["works_cost", "tm_cost", "element_replacement_cost", "factored_cost",
                 "annual_depreciation", "accumulated_depreciation"]
ELEMENT_OTHER = ["ecs", "eif", "ecf", "eci", "element_size", "time_to_failure", "equivalent_age_frac",
                 "repair_age_frac", "works_quantity", "fP", "fO", "fD", "factor_2b"]


@pytest.mark.parametrize("col", ELEMENT_MONEY + ELEMENT_OTHER)
def test_every_element(golden_run, expected_elements, tolerances, col):
    rtol = tolerances["relative"]["elements.money"]
    bad = _compare(golden_run.elements[col], expected_elements[col], rtol, tolerances["absolute"]["elements.ratio"])
    assert len(bad) == 0, golden_run.elements.iloc[bad[:5]][["element_seq", col]]


@pytest.mark.parametrize("col", ["exposure_id", "rule_row", "works_cost_id"])
def test_every_element_exact_ids(golden_run, expected_elements, col):
    bad = _compare(golden_run.elements[col], expected_elements[col], 0, 0)
    assert len(bad) == 0


def test_every_element_exposure_and_repair_condition(golden_run, expected_elements):
    for col in ("exposure", "condition_after", "cost_type", "importance"):
        got = golden_run.elements[col].fillna("").astype(str).values
        exp = expected_elements[col].fillna("").astype(str).values
        if col == "importance":                  # Excel shows a blank Ref14 cell as 0 (EIF 0 either way)
            exp = pd.Series(exp).replace("0", "").values
        assert (got == exp).all(), col


# ---------------------------------------------------------------- performance (QA 2e)
def test_valuation_runtime_budget(golden_inventory, rs):
    t = time.perf_counter()
    run_valuation(golden_inventory, rs)
    assert time.perf_counter() - t < 10.0          # POC gate: < 60 s for the golden set
