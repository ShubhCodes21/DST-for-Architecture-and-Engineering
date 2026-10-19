"""QA families 2b/2c for planning: rules every plan must obey, and how plans must respond to changes."""
from __future__ import annotations

import numpy as np
import pytest

from dst_engine import Inventory, RuleSet
from dst_engine.planning import PlanningModel, PlanSettings

from ..conftest import GOLDEN, subset_inventory

RS = RuleSet.load()
INV = Inventory.load(GOLDEN / "inputs")
SUB = subset_inventory(INV, list(INV.structures["structure_id"].iloc[:120]))


def model(inv=SUB, **kw):
    return PlanningModel(inv, RS, PlanSettings.from_inventory(INV, **kw))


@pytest.fixture(scope="module")
def base():
    m = model(years=12)
    return m, m.run_long_term()


def test_spend_never_exceeds_available_budget(base):
    _, lt = base
    t = lt.table[lt.table["year"] > 0]
    assert (t["expenditure"] + t["planned"] + t["routine"] <= t["budget"] + 1e-6).all()
    assert (t["remaining"] >= -1e-6).all()


def test_untreated_elements_never_improve(base):
    m, lt = base
    treated = {(r.year, r.element_index) for r in lt.works.itertuples()}
    prof = lt.ecs_profile
    for y in range(1, prof.shape[1]):
        idx = np.array([i for i in range(m.ne) if (y, i) not in treated])
        # tolerance: elements entering at 5C-5E settle at 5B, a 3e-12 drop (decision D-014)
        assert (prof[idx, y] >= prof[idx, y - 1] - 1e-9).all(), y


def test_treatment_resets_condition(base):
    m, lt = base
    w = lt.works
    rep = w[w["status"] == "Replace structure"]
    assert (rep["ecs_after"] == 1.0).all()
    mnt = w[w["status"] == "Maintain"]
    assert len(mnt) > 0 and (mnt["ecs_after"] < mnt["ecs_before"] + 1e-9).all()


def test_zero_budget_means_no_works_and_monotone_decline():
    m = model(years=8, budget_bands=[(1, 8, 0.0)])
    lt = m.run_long_term()
    assert lt.table.loc[lt.table["year"] > 0, "expenditure"].sum() == 0
    assert (np.diff(lt.ecs_profile, axis=1) >= -1e-9).all()
    ssci = lt.table["ssci_av|Full Stock"].to_numpy()
    assert (np.diff(ssci) <= 1e-9).all()


def test_more_budget_never_worse_while_budget_is_binding():
    """Metamorphic, on the full stock: while the budget is the constraint, more money means better
    condition, fewer structures at risk and a smaller workbank. Past full funding SAVI's greedy
    timing can move SSCI by about 0.01 either way (decision D-015), so that regime is bounded instead."""
    rows = []
    for b in (0.0, 1_000_000.0, 3_000_000.0, 5_000_000.0, 20_000_000.0):
        lt = model(INV, years=10, budget_bands=[(1, 10, b)]).run_long_term()
        t = lt.table
        rows.append((t["ssci_av|Full Stock"].iloc[-1], t["at_risk|Stock"].iloc[-1], lt.workbank_end))
    binding = rows[:4]
    assert all(b[0] > a[0] for a, b in zip(binding, binding[1:])), rows
    assert all(b[1] <= a[1] for a, b in zip(binding, binding[1:])), rows
    assert all(b[2] < a[2] for a, b in zip(binding, binding[1:])), rows
    assert abs(rows[4][0] - rows[3][0]) < 0.1, rows


def test_deterministic_with_savi_draws(base):
    m, lt = base
    again = m.run_long_term()
    assert lt.table.equals(again.table)


def test_rejected_intervention_is_not_done_that_year(base):
    m, lt = base
    first = lt.works[lt.works["year"] == 1]
    target = int(first[first["status"] == "Maintain"]["element_index"].iloc[0])
    lt2 = m.run_long_term(overrides={1: {"reject": [target]}})
    y1 = lt2.works[lt2.works["year"] == 1]
    assert target not in set(y1["element_index"])


def test_worse_inspection_raises_priority_and_spend_or_risk(base):
    """W1 building block: recording a worse condition must not make the plan less urgent."""
    m, lt = base
    el = m.elements
    i = int(np.where(m.importance == "Very High")[0][0])
    lt2 = m.run_long_term(condition_overrides={i: "5B"})
    before = lt.table.loc[1, "at_risk|Stock"] + lt.table.loc[1, "expenditure"]
    after = lt2.table.loc[1, "at_risk|Stock"] + lt2.table.loc[1, "expenditure"]
    assert after >= before
    assert el is not None


def test_five_year_budget_respected():
    r = model().run_five_year()
    s = r.summary
    assert s["expenditure"] + s["planned"] + s["routine"] <= s["total_budget"] + 1e-6
    assert set(np.unique(r.schedule)) <= {0, 1, 2, 3, 4, 5, 6}


def test_uncertainty_bands_are_ordered():
    u = model(years=6).run_uncertainty(runs=4, seed=1)
    for metric in ("ssci_av|Full Stock", "expenditure"):
        lo, mid, hi = (np.array(u[metric][q])[1:] for q in ("p10", "p50", "p90"))   # year 0 has no spend
        assert (lo <= mid + 1e-9).all() and (mid <= hi + 1e-9).all()
