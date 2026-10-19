"""Condition indices (CSS/HA Condition Performance Indicator, as implemented in SAVI's Y0 sheet).

Element level
    ECS  element condition score, from the severity/extent code (Part C Table C.11.F)
    ECF  element condition factor, by element importance (Part C Table C.11.G)
    ECI  element condition index = max(ECS - ECF, 1)
Structure level
    SCIav   = min(115 - 2 m (m + 6.5), 100),  m = sum(ECI x EIF) / sum(EIF)
    SCIcrit = clamp(115 - 2 M (M + 6.5), 0, 100), M = max ECI of very-high-importance elements
Stock level
    SSCI = key-dimension (x AVF for the whole stock) weighted average of SCI
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .ruleset import RuleSet, key

AVF_GROUPS = {
    "AVF_Bridge": "Bridges",
    "AVF_RetainingWall": "Retaining Walls",
    "AVF_SmallCulvert": "Culverts",
    "AVF_SignGantry": "Sign/Signal Gantries",
    "AVF_HighMast": "High Mast Lighting",
    "AVF_Tunnel": "Tunnels and Vehicular Underpasses",
    "AVF_Other": "Other",
}


def sci_formula(x: np.ndarray | float) -> np.ndarray:
    return 115.0 - 2.0 * np.asarray(x) * (np.asarray(x) + 6.5)


def element_condition(elements: pd.DataFrame, rs: RuleSet) -> pd.DataFrame:
    """ECS, importance, EIF, ECF, ECI per element."""
    cond = rs.condition
    ckey = elements["condition_code"].map(key)
    ecs = ckey.map(cond["ecs"]).astype(float).fillna(0.0)          # SUMIF -> 0 when unknown

    et = rs.element_types
    ekey = elements["element_type"].map(key)
    importance = ekey.map(et["importance"])
    eif = ekey.map(et["eif"]).astype(float).fillna(0.0)

    ecs_v = ecs.to_numpy()
    imp = importance.fillna("").to_numpy()
    ecf = np.select(
        [imp == "Very High", imp == "High", imp == "Medium", imp == "Low"],
        [0.0, 0.3 - (ecs_v - 1) * 0.3 / 4, 0.6 - (ecs_v - 1) * 0.6 / 4, 1.2 - (ecs_v - 1) * 1.2 / 4],
        default=0.0)
    eci = np.where((ecs_v == 0) | (eif.to_numpy() == 0), 0.0, np.maximum(ecs_v - ecf, 1.0))
    return pd.DataFrame({"ecs": ecs_v, "importance": importance.values, "eif": eif.values,
                         "ecf": ecf, "eci": eci}, index=elements.index)


def structure_condition(structures: pd.DataFrame, elements: pd.DataFrame, econd: pd.DataFrame,
                        sizing: pd.DataFrame, rs: RuleSet) -> pd.DataFrame:
    """SCIav, SCIcrit, state of good repair and year-0 traffic delay per structure."""
    df = pd.DataFrame({
        "pos": elements["structure_pos"].values,
        "eif": econd["eif"].values,
        "eci_x_eif": (econd["eci"] * econd["eif"]).values,
        "eci_vh": np.where(econd["eif"] == 2, econd["eci"], 0.0),
        "ecs_vh_h": np.where(econd["eif"].isin([2.0, 1.5]), econd["ecs"], 0.0),
    })
    g = df.groupby("pos")
    sum_eif = g["eif"].sum().reindex(range(len(structures)), fill_value=0.0).to_numpy()
    sum_ex = g["eci_x_eif"].sum().reindex(range(len(structures)), fill_value=0.0).to_numpy()
    max_vh = g["eci_vh"].max().reindex(range(len(structures)), fill_value=0.0).to_numpy()
    max_ecs = g["ecs_vh_h"].max().reindex(range(len(structures)), fill_value=0.0).to_numpy()

    with np.errstate(divide="ignore", invalid="ignore"):
        m = np.where(sum_eif == 0, 0.0, sum_ex / np.where(sum_eif == 0, 1, sum_eif))
    sci_av = np.where(sum_eif == 0, 0.0, np.minimum(sci_formula(m), 100.0))
    sci_crit = np.clip(sci_formula(max_vh), 0.0, 100.0)

    c = rs.constants
    out = pd.DataFrame(index=structures.index)
    out["max_eci_very_high"] = max_vh
    out["sci_av"] = sci_av
    out["sci_crit"] = sci_crit
    out["state_of_good_repair"] = ((sci_av > c["sgr_sci_av_threshold"]) &
                                   (sci_crit > c["sgr_sci_crit_threshold"])).astype(int)

    # --- safety or performance at risk, and traffic delay (Part A 2.11.10; SAVI Y0!P:Z) -----
    # SAVI uses a randomised "start ECS" between this code's ECS and the next one; it can never
    # cross the 4.0 / 5.0 thresholds (draws are in [0, 1)), so the band is set by the ECS itself.
    band = np.where(max_ecs >= 5, 5, np.where(max_ecs >= 4, 4, 0))
    out["vh_h_ecs_band"] = band
    codes = rs["traffic_restriction_codes"].set_index("avf_type")
    code = np.where(band == 4, sizing["avf_type"].map(codes["code_ecs4"]),
                    np.where(band == 5, sizing["avf_type"].map(codes["code_ecs5"]), 0))
    code = pd.to_numeric(pd.Series(code, index=structures.index), errors="coerce").fillna(0).astype(int)
    length = pd.to_numeric(structures["length_m"], errors="coerce").fillna(0.0)
    length_group = np.where(length <= 10, 0.0, np.where(length <= 20, 10.0001, 20.0001))
    days_tbl = rs["traffic_delay_days"]
    lookup = {(round(r.length_over_m, 4), int(r.restriction_code)): r.days for r in days_tbl.itertuples()}
    days = np.array([lookup.get((round(lg, 4), cd), 0.0) if b else 0.0
                     for lg, cd, b in zip(length_group, code, band)])
    rate = structures["traffic"].map(key).map(rs.traffic["daily_delay_rate"]).astype(float).fillna(0.0)
    # SAVI multiplies the (already indexed) daily rate by the maintenance index again (Ref10!D25).
    extra = c.get("traffic_delay_extra_multiplier", 1.0)
    cost = np.where(band > 0, rate.to_numpy() * days * extra, 0.0)
    out["traffic_delay_days"] = days
    out["traffic_delay_cost"] = cost
    number = pd.to_numeric(structures["number_in_group"], errors="coerce").fillna(0.0)
    out["structures_with_traffic_delay"] = np.where(cost > 0, number, 0.0)
    return out


def stock_condition(structures: pd.DataFrame, sizing: pd.DataFrame, scond: pd.DataFrame,
                    rs: RuleSet) -> dict:
    """Stock condition indices by AVF group and for the whole stock, plus condition bands."""
    d = pd.DataFrame({
        "group": sizing["avf_type"].values,
        "kd": sizing["key_dimension"].values,
        "kd_avf": sizing["key_dimension_x_avf"].values,
        "sci_av": scond["sci_av"].values,
        "sci_crit": scond["sci_crit"].values,
        "sgr": scond["state_of_good_repair"].values,
        "n": pd.to_numeric(structures["number_in_group"], errors="coerce").fillna(0.0).values,
    })

    def ratio(num, den):
        return float(num / den) if den else 0.0

    table = {}
    for avf_type, label in AVF_GROUPS.items():
        s = d[d["group"] == avf_type]
        table[label] = {
            "ssci_av": ratio((s.sci_av * s.kd).sum(), s.kd.sum()),
            "ssci_crit": ratio((s.sci_crit * s.kd).sum(), s.kd.sum()),
            "sss": ratio((s.sgr * s.kd).sum(), s.kd.sum()),
        }
    table["Stock"] = {
        "ssci_av": ratio((d.sci_av * d.kd_avf).sum(), d.kd_avf.sum()),
        "ssci_crit": ratio((d.sci_crit * d.kd_avf).sum(), d.kd_avf.sum()),
        "sss": ratio((d.sgr * d.kd_avf).sum(), d.kd_avf.sum()),
    }

    bands = rs["condition_bands"].sort_values("sci_min", ascending=False)
    counts = {}
    remaining = d.copy()
    for b in bands.itertuples():
        hit = remaining["sci_av"] >= b.sci_min
        counts[b.band] = float(remaining.loc[hit, "n"].sum())
        remaining = remaining[~hit]
    return {"ssci_table": table, "bands": counts,
            "structures_at_risk": float(scond["structures_with_traffic_delay"].sum()),
            "traffic_delay_cost": float(scond["traffic_delay_cost"].sum())}
