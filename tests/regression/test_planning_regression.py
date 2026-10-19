"""QA family 2d - planning regression against SAVI v1.10's calculated 5-year and 30-year runs.

Every number SAVI reports (58 LAMP Results columns x 31 years), every element's condition in
every year (ECS Profile, 8,692 x 31), and every element/structure decision in the 5-year
programme (Y5 sheet) is compared.
"""
from __future__ import annotations

import time

import numpy as np
import pandas as pd
import pytest
from openpyxl.utils import get_column_letter

from dst_engine.planning import LAMP_COLUMNS, PlanningModel, vba_rnd_draws

from ..conftest import GOLDEN

pytestmark = pytest.mark.regression
P = GOLDEN / "expected" / "planning"


@pytest.fixture(scope="module")
def model(golden_inventory, rs):
    return PlanningModel(golden_inventory, rs)


@pytest.fixture(scope="module")
def long_term(model):
    return model.run_long_term()


@pytest.fixture(scope="module")
def five_year(model):
    return model.run_five_year()


@pytest.fixture(scope="module")
def savi_lamp():
    return pd.read_parquet(P / "lamp_results.parquet")


@pytest.fixture(scope="module")
def savi_y5():
    return pd.read_parquet(P / "y5.parquet")


def close(a, b, rtol=1e-9):
    a, b = np.nan_to_num(np.asarray(a, float)), np.nan_to_num(np.asarray(b, float))
    return np.abs(a - b) <= rtol * np.maximum(1.0, np.abs(b))


# ---------------------------------------------------------------- random start conditions
def test_vba_rnd_emulation_reproduces_ref99():
    savi = pd.to_numeric(pd.read_parquet(P / "ref99.parquet")["A"]).to_numpy()
    assert np.array_equal(vba_rnd_draws(len(savi)), savi)


def test_start_precise_ecs_matches_y0(model):
    y0 = pd.read_parquet(P / "y0.parquet")
    st = model.initial_state()
    assert close(st["precise"], pd.to_numeric(y0["F"])).all()


# ---------------------------------------------------------------- long-term plan
@pytest.mark.parametrize("col", list(LAMP_COLUMNS))
def test_lamp_results_column_all_years(long_term, savi_lamp, col):
    name = LAMP_COLUMNS[col]
    got = long_term.table.set_index("year")[name].reindex(range(31))
    exp = pd.to_numeric(savi_lamp[col], errors="coerce")
    if col in "RSTUVWX":                    # SAVI writes "" for a zero group SSCI
        exp = exp.where(~(exp.isna() & (savi_lamp["A"] > 0)), 0.0)
    rows = range(1, 31) if col <= "Q" and len(col) == 1 else range(31)
    bad = [y for y in rows if not close(got[y], exp[y])]
    assert not bad, [(y, got[y], exp[y]) for y in bad[:5]]


def test_ecs_profile_every_element_every_year(long_term):
    prof = pd.read_parquet(P / "ecs_profile.parquet")
    for y in range(31):
        exp = pd.to_numeric(prof[get_column_letter(6 + y)], errors="coerce").to_numpy()
        bad = np.where(np.abs(long_term.ecs_profile[:, y] - exp) > 1e-12)[0]
        assert len(bad) == 0, (y, bad[:5])


def test_long_term_dashboard_totals(long_term, expected_summary):
    exp = expected_summary["long_term_plan"]
    t = long_term.totals()
    assert t["years"] == exp["years"] == 30
    assert t["total_budget"] == exp["total_budget"]
    for k in ("expenditure", "discounted_expenditure", "workbank_end"):
        assert close(t[k], exp[k]), (k, t[k], exp[k])
    assert round(t["workbank_end"], 2) == 103_390_688.73


def test_final_workbank_pass_element_columns(model, long_term):
    """SAVI's Yn sheet holds the workbank year (31): our state after year 30 must reproduce it."""
    yn = pd.read_parquet(P / "yn.parquet")
    assert close(long_term.ecs_profile[:, 30], pd.to_numeric(yn["C"])).all()


# ---------------------------------------------------------------- 5-year programme
@pytest.mark.parametrize("ours,col", [("M", "M"), ("N", "N"), ("Q", "Q"), ("U", "U"), ("W", "W"), ("AB", "AB"),
                                      ("AE", "AE"), ("DN", "DP"), ("DV", "DX"), ("DW", "DY")])
def test_five_year_element_columns(five_year, savi_y5, ours, col):
    got = np.asarray(five_year.detail[ours], float)
    exp = pd.to_numeric(savi_y5[col], errors="coerce").to_numpy()
    bad = np.where(~close(got, exp))[0]
    assert len(bad) == 0, [(i, got[i], exp[i]) for i in bad[:5]]


def test_five_year_end_condition(five_year, savi_y5):
    assert close(five_year.precise_ecs, pd.to_numeric(savi_y5["ED"])).all()
    assert close(five_year.reported_ecs, pd.to_numeric(savi_y5["EE"])).all()


def test_five_year_summary(five_year, expected_summary):
    exp = expected_summary["short_term_plan"]
    s = five_year.summary
    assert s["total_budget"] == exp["budget"] == 15_000_000
    assert close(s["expenditure"], exp["expenditure"])
    assert round(s["expenditure"], 2) == 14_233_985.32
    assert close(s["ssci_av|Full Stock"], exp["ssci_av_y5"])
    assert close(s["ssci_crit|Full Stock"], exp["ssci_crit_y5"])
    assert close(s["sss|Full Stock"], exp["sss_y5"])
    assert round(s["remaining"], 2) == 18_014.68


def test_five_year_project_list_matches_savi(five_year):
    """SAVI's Project List starts with CULVERT 423, replaced in year 1 (priority 10,025.35)."""
    pl = five_year.projects()
    first = pl.iloc[0]
    assert first["structure_id"] == "ST423" and first["year"] == 1
    assert first["action"] == "Replace" and round(first["priority_score"], 2) == 10_025.35
    assert pl["cost"].sum() <= 15_000_000 - 108_000 - 640_000


# ---------------------------------------------------------------- performance (QA 2e)
def test_planning_runtime(golden_inventory, rs):
    t = time.perf_counter()
    m = PlanningModel(golden_inventory, rs)
    m.run_long_term()
    m.run_five_year()
    assert time.perf_counter() - t < 20.0
