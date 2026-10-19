"""QA family 2a - unit tests against SAMPT's published worked examples.

Oracle 1 in the QA framework. Where a published figure is internally inconsistent the
test asserts the recomputed value and records the published one (see ERRATA).
"""
from __future__ import annotations

import pytest

from dst_engine import formulas as f

# Part A v2.01 errata found while building these oracles (logged in the decision log).
ERRATA = {
    "A-Ex6-waterway-TM": "Doc £20,923 uses 68.6 h rounded; exact 24/0.35 h gives £20,914.",
    "A-Ex6-scheme-sum": "Doc's sum lists a stray £9,354 term; its total £123,713 omits it (exact £123,712).",
    "A-Ex9-accumulated": "Doc £12,355 uses annual £1,765 rounded; exact £12,353.",
    "A-Ex13-TM-apportion": "Doc £13,712 / £4,330 do not follow eq. 17; exact £13,737 / £4,305.",
}


# ---- Part A Example 6: scheme cost for a 2-span bridge ------------------------------------
def test_ex6_bearing_replacement_constant_cost():
    size = 8 * (2 + 1) * 1                      # width x (spans + 1) x number
    assert size == 24
    assert f.works_cost_constant(size, 1037) == 24_888


def test_ex6_expansion_joint_replacement():
    assert f.works_cost_constant(24, 763) == 18_312


def test_ex6_abutment_concrete_repair_variable_cost_at_3c():
    size = 4.7 * 8 * 1 * 2                      # headroom x width x number x 2
    assert size == pytest.approx(75.2)
    wc = f.works_cost_variable(size, (346, 1383, 2075, 2685), "3C")
    assert round(wc) == 11_053


def test_ex6_lane_closure_tm():
    wd = f.works_duration(24, 1.0, "Constant")
    assert wd == 24 and wd * 259 == 6_216


def test_ex6_waterway_possession_tm_combines_to_longest_job():
    bearings = f.works_duration(24, 0.35, "Constant")          # 68.57 h
    abutments = f.works_duration(75.2, 0.7, "Variable", "3C")  # 21.49 h
    assert round(bearings, 1) == 68.6 and round(abutments, 1) == 21.5
    combined = f.combine_tm_durations({"Waterway Possession": [bearings, abutments]}, ["Waterway Possession"])
    assert combined["Waterway Possession"] == pytest.approx(bearings)
    assert round(combined["Waterway Possession"] * 305) == 20_914      # erratum: doc 20,923
    assert round(68.6 * 305) == 20_923                                 # the doc's rounded-hours figure


def test_ex6_total_scheme_cost():
    sc = f.scheme_cost(wc=54_253, tmc=27_139, fP=0.2, fO=0.2, fD=0.2)
    assert round(sc.pc) == 10_851 and round(sc.oc) == 10_851
    assert round(sc.dc) == 20_619
    assert round(sc.total) == 123_712                                  # erratum: doc 123,713


# ---- Part A Example 5: combining traffic-management arrangements --------------------------
def test_ex5_tm_combination():
    final = f.combine_tm_durations(
        {"Contraflow": [5, 15], "Lane Closure": [8, 24], "Hardshoulder Closure": [10, 30]},
        ["Contraflow", "Lane Closure", "Hardshoulder Closure"])
    assert final == {"Contraflow": 15, "Lane Closure": 9, "Hardshoulder Closure": 6}


# ---- Part A Example 7: penalty ----------------------------------------------------------------
def test_ex7_traffic_delay_penalty():
    assert f.restriction_days(15, 4.3) == 10
    assert f.traffic_delay_cost(15, 4.3, 996) == 9_960


@pytest.mark.parametrize("length,ecs,days", [(10, 4.0, 5), (10.1, 4.5, 10), (20, 4.9, 10),
                                             (20.1, 4.0, 15), (5, 5.0, 30), (500, 5.0, 30), (50, 3.9, 0)])
def test_traffic_restriction_days_table_c10a(length, ecs, days):
    assert f.restriction_days(length, ecs) == days


# ---- Part A Examples 8, 9, 12: depreciation ---------------------------------------------------
def test_ex8_accumulated_depreciation_from_condition():
    assert round(f.accumulated_depreciation(50_000, 70, 120)) == 29_167


def test_ex9_annual_and_accumulated_depreciation():
    annual = f.annual_depreciation(30_000, 17)
    assert round(annual) == 1_765
    assert round(annual * 7) == 12_353                                 # erratum: doc 12,355


def test_ex12_structure_drc_year0_and_year17():
    assert f.structure_drc(1_000_000, [26_069, 20_414, 61_816, 31_337, 0]) == 860_364
    acc17 = [63_000,
             f.accumulated_depreciation(37_000, 17 - 13, 26 - 13),
             f.accumulated_depreciation(81_000, 17 - 9, 30 - 9),
             f.accumulated_depreciation(35_000, 17 - 9, 47 - 9),
             f.accumulated_depreciation(5_000, 17 - 13, 26 - 13)]
    assert [round(a) for a in acc17] == [63_000, 11_385, 30_857, 7_368, 1_538]
    assert round(f.structure_drc(1_000_000, acc17)) == 885_851        # doc 885,852 (rounded terms)


def test_drc_normalised_by_terc_when_depreciation_exceeds_grc():
    assert f.structure_drc(100, [80, 60], terc=200) == pytest.approx(30)   # eq. 15
    assert f.structure_drc(100, [30, 20], terc=200) == pytest.approx(50)   # eq. 14


# ---- Part A Example 13: apportioning scheme add-ons to elements -------------------------------
def test_ex13_element_apportionment():
    wd_b, wd_a = 24 / 0.35, 75.2 * 0.2 / 0.7
    tmc_b = f.apportion_tm(18_042, wd_b, [wd_b, wd_a])
    tmc_a = f.apportion_tm(18_042, wd_a, [wd_b, wd_a])
    assert round(tmc_b) == 13_738 and round(tmc_a) == 4_304            # erratum: doc 13,712 / 4,330
    assert tmc_b + tmc_a == pytest.approx(18_042)
    joints = f.element_scheme_cost(15_792, 5_352, 0.2, 0.2, 0.2)
    assert round(joints.dc) == 5_492
    assert joints.total == pytest.approx(32_952, abs=1)                # doc rounds each term


# ---- Technical Note (Apr 2015): averaging sub-element conditions -----------------------------
def test_technical_note_example1_ecs_average():
    assert f.average_ecs([(5, "2B"), (5, "3D")]) == "3D"


def test_technical_note_example2_ecs_average():
    assert f.average_ecs([(5, "4E"), (20, "2B"), (5, "4C")]) == "4D"


def test_ecs_average_all_good_is_1a():
    assert f.average_ecs([(3, "1A"), (4, "1A")]) == "1A"


# ---- Condition index formula -----------------------------------------------------------------
@pytest.mark.parametrize("eci,sci", [(1.0, 100.0), (2.0, 81.0), (3.3, 50.32), (5.0, 0.0)])
def test_sci_formula(eci, sci):
    assert f.sci_from_mean_eci(eci) == pytest.approx(sci)
