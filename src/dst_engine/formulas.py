"""SAMPT Part A equations as small pure functions.

These are the published building blocks (works cost, scheme add-ons, traffic management,
apportionment, penalties, depreciation, ECS averaging). The QA unit tests check each one
against the worked examples in Part A and the April 2015 Technical Note; the planning
modules (5-year and long-term) will be built from them.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

# ---- Part A Table 4: extent of each severity for a primary condition --------------------
EXTENT_OF_SEVERITY = {
    "1A": (0.0, 0.0, 0.0, 0.0), "2B": (0.025, 0, 0, 0), "2C": (0.075, 0, 0, 0), "2D": (0.125, 0, 0, 0),
    "2E": (0.15, 0, 0, 0), "3B": (0.125, 0.025, 0, 0), "3C": (0.125, 0.075, 0, 0),
    "3D": (0.10, 0.125, 0, 0), "3E": (0.10, 0.15, 0, 0), "4B": (0.10, 0.125, 0.025, 0),
    "4C": (0.10, 0.125, 0.075, 0), "4D": (0.10, 0.125, 0.125, 0), "4E": (0.10, 0.125, 0.15, 0),
    "5B": (0.10, 0.125, 0.125, 0.025), "5C": (0.10, 0.125, 0.125, 0.075),
    "5D": (0.125, 0.125, 0.125, 0.20), "5E": (0, 0, 0.20, 0.50),
}


def total_extent_of_defects(condition: str) -> float:
    """TEoD (Part A Table 4)."""
    return float(sum(EXTENT_OF_SEVERITY[condition.upper()]))


# ---- Works cost (Part A eq. 1-3) ---------------------------------------------------------
def works_cost_fixed(fixed_rate: float) -> float:
    return fixed_rate


def works_cost_constant(size: float, unit_rate: float) -> float:
    return size * unit_rate


def works_cost_variable(size: float, rates_s2_s5: tuple[float, float, float, float], condition: str) -> float:
    ext = EXTENT_OF_SEVERITY[condition.upper()]
    return size * sum(r * e for r, e in zip(rates_s2_s5, ext))


# ---- Works duration and traffic management (eq. 5, 6, 10; Example 5) ---------------------
def works_duration(size: float, work_rate: float, cost_type: str, condition: str | None = None) -> float:
    """WD = SF / WDR (fixed/constant) or SF x TEoD / WDR (variable)."""
    if cost_type.lower() == "variable":
        return size * total_extent_of_defects(condition or "1A") / work_rate
    return size / work_rate


def combine_tm_durations(durations_by_arrangement: dict[str, list[float]],
                         onerousness: list[str]) -> dict[str, float]:
    """Combine traffic-management arrangements (Part A 2.11.6, Example 5).

    Step 1: each arrangement lasts as long as its longest job (eq. 10).
    Step 2: less onerous arrangements only cover time not already under a more onerous one.
    `onerousness` lists arrangements from most to least onerous.
    """
    tmd = {a: max(d) for a, d in durations_by_arrangement.items() if d}
    final, covered = {}, 0.0
    for a in onerousness:
        if a in tmd:
            final[a] = max(tmd[a] - covered, 0.0)
            covered += final[a]
    return final


# ---- Scheme cost (eq. 4, 7-9) --------------------------------------------------------------
@dataclass
class SchemeCost:
    wc: float
    tmc: float
    pc: float
    oc: float
    dc: float

    @property
    def total(self) -> float:
        return self.wc + self.tmc + self.pc + self.oc + self.dc


def scheme_cost(wc: float, tmc: float, fP: float, fO: float, fD: float) -> SchemeCost:
    pc, oc = fP * wc, fO * wc
    dc = fD * (wc + tmc + pc + oc)
    return SchemeCost(wc, tmc, pc, oc, dc)


def apportion_tm(tmc_arrangement: float, wd_element: float, wd_all_on_arrangement: list[float]) -> float:
    """TMC_element = TMC x WD_element / SWD (eq. 16-17)."""
    return tmc_arrangement * wd_element / sum(wd_all_on_arrangement)


def element_scheme_cost(wc: float, tmc: float, fP: float, fO: float, fD: float) -> SchemeCost:
    """Scheme cost apportioned to one element (eq. 18-21)."""
    return scheme_cost(wc, tmc, fP, fO, fD)


# ---- Penalties (Part A 2.11.10, Part C Table C.10.A) --------------------------------------
def restriction_days(length_m: float, worst_very_high_ecs: float) -> int:
    if worst_very_high_ecs >= 5.0:
        return 30
    if worst_very_high_ecs >= 4.0:
        return 5 if length_m <= 10 else (10 if length_m <= 20 else 15)
    return 0


def traffic_delay_cost(length_m: float, worst_very_high_ecs: float, daily_rate: float) -> float:
    return restriction_days(length_m, worst_very_high_ecs) * daily_rate


# ---- Depreciation (Part A section 4) -----------------------------------------------------------
def annual_depreciation(cost_of_next_intervention: float, years_between_interventions: float) -> float:
    """Eq. 13."""
    return cost_of_next_intervention / years_between_interventions


def accumulated_depreciation(cost: float, years_consumed: float, cycle_years: float) -> float:
    """Cost x share of the intervention cycle already used (Examples 8, 9, 12)."""
    return cost * years_consumed / cycle_years


def structure_drc(grc: float, accumulated: list[float], terc: float | None = None) -> float:
    """Eq. 14, or eq. 15 (TERC-normalised) when accumulated depreciation exceeds GRC."""
    acc = sum(accumulated)
    if terc and acc > grc:
        return grc - acc * grc / terc
    return grc - acc


# ---- Element condition score from sub-elements (Technical Note Apr 2015, eq. A-C) ----------
_EXTENT_VALUE = {"A": 0.0, "B": 0.0, "C": 0.1, "D": 0.3, "E": 0.7}
_EXTENT_STEPS = [("B", 0.0), ("C", 0.1), ("D", 0.3), ("E", 0.7)]


def average_ecs(sub_elements: list[tuple[float, str]]) -> str:
    """Combine sub-element (dimension, condition) pairs into one element condition code.

    Worst severity wins; extent = weighted extent of the worst-severity sub-elements over
    all sub-element weights, rounded *up* to the next extent rating.
    """
    if not sub_elements:
        raise ValueError("no sub-elements")
    max_dim = max(d for d, _ in sub_elements)
    weights = [(d / max_dim, c.upper()) for d, c in sub_elements]
    worst = max(int(c[0]) for _, c in weights)
    if worst == 1:
        return "1A"
    num = sum(w * _EXTENT_VALUE[c[1]] for w, c in weights if int(c[0]) == worst)
    extent = num / sum(w for w, _ in weights)
    for letter, value in _EXTENT_STEPS:
        if extent <= value + 1e-12:
            return f"{worst}{letter}"
    return f"{worst}E"


def sci_from_mean_eci(mean_eci: float) -> float:
    """Structure condition index from an (EIF-weighted) mean ECI."""
    return min(115 - 2 * mean_eci * (mean_eci + 6.5), 100.0)


def is_close_money(a: float, b: float, pounds: float = 1.0) -> bool:
    return math.isclose(a, b, abs_tol=pounds)
