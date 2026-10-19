"""QA families 2b/2c - property and metamorphic tests (Hypothesis).

Inputs are drawn from the golden stock (random subsets, random condition changes, random
re-orderings), so every generated case is realistic and valid.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from dst_engine import Inventory, run_valuation
from dst_engine.ruleset import key

from ..conftest import GOLDEN, subset_inventory
from dst_engine import RuleSet

RS = RuleSet.load()
INV = Inventory.load(GOLDEN / "inputs")
FULL = run_valuation(INV, RS)
IDS = list(INV.structures["structure_id"])
CODES = list(RS["condition_codes"]["code"])
INFLUENCING = {key(n) for n in RS["exposure_weights"]["parameter"].iloc[1:15]}
SETTINGS = settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.too_slow])

subsets = st.lists(st.sampled_from(IDS), min_size=1, max_size=6, unique=True)
STRUCTURE_COLS = ["grc", "terc", "annual_depreciation", "accumulated_depreciation", "drc", "sci_av", "sci_crit",
                  "traffic_delay_cost"]


def by_id(run) -> pd.DataFrame:
    return run.structures.set_index("structure_id")[STRUCTURE_COLS]


@SETTINGS
@given(subsets)
def test_value_and_condition_bounds(ids):
    s = run_valuation(subset_inventory(INV, ids), RS).structures
    assert (s["drc"] <= s["grc"] + 1e-6).all() and (s["drc"] >= -1e-6).all()
    assert (s["accumulated_depreciation"] >= 0).all() and (s["annual_depreciation"] >= 0).all()
    assert (s["sci_av"] <= 100).all()
    assert s["sci_crit"].between(0, 100).all()


@SETTINGS
@given(subsets)
def test_structures_are_valued_independently(ids):
    """A structure's results do not depend on which other structures are in the run."""
    sub = by_id(run_valuation(subset_inventory(INV, ids), RS))
    full = by_id(FULL).loc[sub.index]
    pd.testing.assert_frame_equal(sub, full, rtol=1e-12, atol=1e-9)


@SETTINGS
@given(subsets, st.randoms(use_true_random=False))
def test_row_order_does_not_matter(ids, rnd):
    inv = subset_inventory(INV, ids)
    s = inv.structures.sample(frac=1, random_state=rnd.randint(0, 10**6)).reset_index(drop=True)
    e = inv.elements.sample(frac=1, random_state=rnd.randint(0, 10**6)).reset_index(drop=True)
    a = by_id(run_valuation(inv, RS))
    b = by_id(run_valuation(Inventory(s, e, settings=inv.settings), RS)).loc[a.index]
    pd.testing.assert_frame_equal(a, b, rtol=1e-12, atol=1e-9)


@SETTINGS
@given(subsets)
def test_deterministic(ids):
    inv = subset_inventory(INV, ids)
    a, b = run_valuation(inv, RS), run_valuation(inv, RS)
    assert a.summary == b.summary
    assert a.lineage["inventory_sha256"] == b.lineage["inventory_sha256"]


@st.composite
def worsening(draw):
    """A non-influencing element and a worse condition code for it."""
    e = INV.elements
    cand = e.index[~e["element_type"].map(key).isin(INFLUENCING)]
    i = draw(st.sampled_from(list(cand)))
    cur = CODES.index(e.loc[i, "condition_code"].upper())
    assume_worse = draw(st.integers(min_value=cur, max_value=len(CODES) - 1))
    return i, CODES[assume_worse]


@SETTINGS
@given(worsening())
def test_worse_condition_never_improves_sci_or_value(case):
    """Metamorphic: worsening an element's condition cannot raise SCIav or lower depreciation."""
    i, code = case
    sid = INV.elements.loc[i, "structure_id"]
    base = subset_inventory(INV, [sid])
    worse_el = INV.elements.copy()
    worse_el.loc[i, "condition_code"] = code
    worse = subset_inventory(Inventory(INV.structures, worse_el, settings=INV.settings), [sid])
    a = run_valuation(base, RS).structures.iloc[0]
    b = run_valuation(worse, RS).structures.iloc[0]
    assert b["sci_av"] <= a["sci_av"] + 1e-9
    assert b["sci_crit"] <= a["sci_crit"] + 1e-9
    assert b["accumulated_depreciation"] >= a["accumulated_depreciation"] - 1e-6


@SETTINGS
@given(st.sampled_from([i for i, t in zip(IDS, INV.structures["structure_type"])
                        if RS.structure_types.loc[key(t), "grc_f_length"] == 1]),
       st.floats(min_value=0.1, max_value=10, allow_nan=False))
def test_grc_scales_with_length(sid, k):
    inv = subset_inventory(INV, [sid])
    s2 = inv.structures.copy()
    s2["length_m"] = pd.to_numeric(s2["length_m"]) * k
    a = run_valuation(inv, RS).structures.iloc[0]["grc"]
    b = run_valuation(Inventory(s2, inv.elements, settings=inv.settings), RS).structures.iloc[0]["grc"]
    assert b == pytest.approx(a * k, rel=1e-12)


def test_duplicating_the_stock_doubles_value_and_keeps_condition():
    s2 = INV.structures.copy()
    s2["structure_id"] = s2["structure_id"] + "_copy"
    e2 = INV.elements.copy()
    e2["structure_id"] = e2["structure_id"] + "_copy"
    double = Inventory(pd.concat([INV.structures, s2], ignore_index=True),
                       pd.concat([INV.elements, e2], ignore_index=True), settings=INV.settings)
    d = run_valuation(double, RS).summary
    one = FULL.summary
    for f in ("grc", "drc", "annual_depreciation"):
        assert d["valuation"][f] == pytest.approx(2 * one["valuation"][f], rel=1e-12)
    for g, v in one["condition_y0"]["ssci_table"].items():
        assert d["condition_y0"]["ssci_table"][g]["ssci_av"] == pytest.approx(v["ssci_av"], abs=1e-9)
    assert d["condition_y0"]["bands"] == {k: 2 * v for k, v in one["condition_y0"]["bands"].items()}


def test_stock_ssci_lies_within_structure_range():
    s = FULL.structures
    stock = FULL.summary["condition_y0"]["ssci_table"]["Stock"]["ssci_av"]
    w = s["key_dimension_x_avf"] > 0
    assert s.loc[w, "sci_av"].min() <= stock <= s.loc[w, "sci_av"].max()


def test_all_elements_in_perfect_condition_means_no_depreciation_beyond_1a_age():
    e = INV.elements.copy()
    e["condition_code"] = "1A"
    run = run_valuation(Inventory(INV.structures, e, settings=INV.settings), RS)
    assert np.allclose(run.structures["sci_av"], 100) or (run.structures["sci_av"] >= 99.999).all()
    assert run.summary["valuation"]["drc"] > FULL.summary["valuation"]["drc"]
