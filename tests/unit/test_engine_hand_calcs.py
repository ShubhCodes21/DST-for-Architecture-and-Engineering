"""QA family 2a - engine results for single structures, checked by hand from the rule tables."""
from __future__ import annotations

import pytest

from dst_engine import run_valuation

from ..conftest import subset_inventory


@pytest.fixture(scope="module")
def st01(golden_inventory, rs):
    """ST01: rural single-cell culvert, 1.22 m x 3.09 m, unclassified road over a non-navigable stream."""
    return run_valuation(subset_inventory(golden_inventory, ["ST01"]), rs)


def test_st01_grc_by_hand(st01, rs):
    rate = rs.structure_types.loc["culvert (single cell)", "grc_unit_rate"]
    assert rate == pytest.approx(4539 * 1.6137015535914818)            # 2010/11 base x 2025/26 index
    uplift = 0.7 * 0.8 * 0.9                                             # rural x unclassified x watercourse
    s = st01.structures.iloc[0]
    assert s["key_dimension"] == pytest.approx(1.22 * 3.09)
    assert s["grc_uplift"] == pytest.approx(uplift)
    assert s["grc"] == pytest.approx(1.22 * 3.09 * rate * uplift)
    assert s["grc"] == pytest.approx(13_916.57, abs=0.01)


def test_heritage_uplift_st08(golden_inventory, rs):
    """ST08 is a listed rural bridge: heritage 2.0 x rural 0.7 x watercourse 0.9 = 1.26."""
    run = run_valuation(subset_inventory(golden_inventory, ["ST08"]), rs)
    assert run.structures.iloc[0]["grc_uplift"] == pytest.approx(1.26)


def test_st01_condition_indices_by_hand(st01):
    el = st01.elements
    deck = el[el["element_type"].str.startswith("Br01")].iloc[0]
    assert deck["condition_code"] == "3D" and deck["ecs"] == pytest.approx(3.3)
    assert deck["importance"] == "Very High" and deck["eci"] == pytest.approx(3.3)
    s = st01.structures.iloc[0]
    assert s["max_eci_very_high"] == pytest.approx(3.3)
    assert s["sci_crit"] == pytest.approx(115 - 2 * 3.3 * (3.3 + 6.5))   # 50.32
    m = (el["eci"] * el["eif"]).sum() / el["eif"].sum()
    assert s["sci_av"] == pytest.approx(min(115 - 2 * m * (m + 6.5), 100))


def test_element_condition_factor_by_importance(rs):
    import pandas as pd

    from dst_engine.condition import element_condition
    e = pd.DataFrame({"element_type": ["Br01.  Primary Deck Element", "Br13.  Bearings",
                                       "Br23.  Handrail/Parapets/Safety Fences", "Br33.  Embankments"],
                      "condition_code": ["3C", "3C", "3C", "3C"]})
    c = element_condition(e, rs).set_index(e["element_type"])
    imp = c["importance"].to_dict()
    for name, row in c.iterrows():
        k = {"Very High": 0.0, "High": 0.3, "Medium": 0.6, "Low": 1.2}[imp[name]]
        assert row["ecf"] == pytest.approx(k - (3.1 - 1) * k / 4)
        assert row["eci"] == pytest.approx(max(3.1 - row["ecf"], 1.0))


def test_st01_deck_replacement_cost_by_hand(st01, rs):
    """Deck: brickwork, severe exposure; failure (5B) triggers concrete-type repair to 2B."""
    d = st01.elements[st01.elements["element_type"].str.startswith("Br01")].iloc[0]
    assert d["exposure"] == "Severe" and d["condition_after"] == "2B"
    act = rs["maintenance_actions"].iloc[int(d["works_cost_id"]) - 1]
    assert act["cost_type"] == "Variable"
    c5b = rs.condition.loc["5b"]
    rate = sum(act[f"var_rate_s{k}"] * c5b[f"ext_s{k}"] for k in range(2, 6))
    works = d["element_size"] * rate
    assert d["works_cost"] == pytest.approx(works)
    fP, fO, fD = 0.2, 0.2, 0.4                                            # small job bands
    assert (d["fP"], d["fO"], d["fD"]) == (fP, fO, fD)
    assert d["element_replacement_cost"] == pytest.approx(
        d["factor_2b"] * works * (1 + fP + fO + fD + fP * fD + fO * fD))


def test_st01_drc_is_grc_less_accumulated_depreciation(st01):
    s, el = st01.structures.iloc[0], st01.elements
    f = min(1.0, s["grc"] / el["element_replacement_cost"].sum())
    assert s["grc_to_terc_factor"] == pytest.approx(f)
    acc = (el["equivalent_age_frac"] * el["element_replacement_cost"] * f).sum()
    assert s["accumulated_depreciation"] == pytest.approx(acc)
    assert s["drc"] == pytest.approx(s["grc"] - acc)


def test_excluded_elements_carry_no_value(golden_run, rs):
    excluded = rs["element_types"].loc[rs["element_types"]["excluded_from_valuation"], "element_type"]
    el = golden_run.elements[golden_run.elements["element_type"].isin(excluded)]
    assert len(el) > 0
    assert (el["element_replacement_cost"] == 0).all() and (el["accumulated_depreciation"] == 0).all()


def test_traffic_delay_for_structure_at_risk(golden_run, rs):
    s = golden_run.structures
    risk = s[s["traffic_delay_cost"] > 0].iloc[0]
    rate = rs.traffic.loc[risk["traffic"].casefold(), "daily_delay_rate"]
    assert risk["traffic_delay_cost"] == pytest.approx(
        rate * risk["traffic_delay_days"] * rs.constants["traffic_delay_extra_multiplier"])


# ---- boundary tests added after mutation testing (two mutants survived on the sample data) --------
@pytest.mark.parametrize("length,uplifted", [(400.0, False), (400.01, True), (150.0, False)])
def test_tunnel_over_400m_boundary(golden_inventory, rs, length, uplifted):
    """Part C Table C.12.B: the 1.25 uplift applies to tunnels strictly longer than 400 m."""
    import pandas as pd

    from dst_engine.grc import compute_grc
    s = golden_inventory.structures[golden_inventory.structures["structure_type"].str.casefold()
                                    == "tunnel (bored)"].copy()
    s["length_m"] = length
    g = compute_grc(s.reset_index(drop=True), rs, "Local Authority").iloc[0]
    assert g["adj_tunnel_over_400m"] == int(uplifted)
    base = g["grc_uplift"] / (1.25 if uplifted else 1.0)
    assert g["grc"] == pytest.approx(g["basic_grc"] * base * (1.25 if uplifted else 1.0))
    assert isinstance(s, pd.DataFrame)


def test_each_user_adjustment_factor_applied_once(golden_inventory, rs):
    """Setting one user flag multiplies GRC by exactly that factor (Part C Table C.12.B)."""
    from dst_engine.grc import USER_ADJUSTMENT_COLUMNS, compute_grc
    s = golden_inventory.structures.iloc[[1]].reset_index(drop=True).copy()
    for c in USER_ADJUSTMENT_COLUMNS:
        s[c] = 0
    base = compute_grc(s, rs, "Local Authority").iloc[0]["grc"]
    for c in USER_ADJUSTMENT_COLUMNS:
        t = s.copy()
        t[c] = 1
        got = compute_grc(t, rs, "Local Authority").iloc[0]["grc"]
        assert got == pytest.approx(base * rs.adjustment_factors[c]), c
