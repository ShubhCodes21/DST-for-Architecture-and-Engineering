"""WGA valuation: element replacement cost, depreciation and DRC (SAVI 'Value' sheet).

This is SAVI v1.10's closed-form year-0 implementation of SAMPT Part A section 4,
run under the Technical Note settings (default tables, mean deterioration, the
intervention triggered at failure, no planned works). Per element:

    exposure            from the exposure-rule encoding (Part C section 2)
    time to failure     H = mean time to failure for material & exposure (Part C 3/4a)
    equivalent age      I = fraction of life consumed at the current condition ("Average" profile)
    intervention        the rule triggered at 5B for material & exposure (Part C 6a)
    replacement cost    Y = 2B factor x (works x (1+fP+fO+fD+fP.fD+fO.fD) + TM x (1+fD))

Per structure the element costs are scaled to GRC (TERC normalisation, Part A eq. 15):

    f = min(1, GRC / TERC),  annual depreciation = sum(Y / H x f),
    accumulated depreciation = sum(I x Y x f),  DRC = GRC - accumulated depreciation
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .ruleset import RuleSet, key

TM_CODE_TO_ARRANGEMENT = {
    "RouteContraflow": "Contraflow",
    "RouteShuttle Working / Lane Closure": "Shuttle Working / Lane Closure",
    "RouteHardshoulder Closure": "Hardshoulder Closure",
    "RouteAndObstacleRetaining Wall TM": "Retaining Wall TM",
    "ObstacleContraflow": "Contraflow",
    "ObstacleShuttle Working / Lane Closure": "Shuttle Working / Lane Closure",
    "ObstacleHardshoulder Closure": "Hardshoulder Closure",
    "ObstacleWaterway Possession": "Waterway Possession",
    "ObstacleRailway Possession": "Railway Possession",
}
_TM_CODE_KEYS = {key(k): v for k, v in TM_CODE_TO_ARRANGEMENT.items()}
_WATERCOURSES = {key("Watercourse - navigable"), key("Watercourse - non-navigable")}


def _num(v) -> float:
    try:
        f = float(v)
        return 0.0 if math.isnan(f) else f
    except (TypeError, ValueError):
        return 0.0


def element_size(elements: pd.DataFrame, structures: pd.DataFrame, rs: RuleSet) -> np.ndarray:
    """Element size from the structure's dimensions (Part C section 8; SAVI Elements!R:Y)."""
    et = rs.element_types
    row = et.reindex(elements["element_type"].map(key))
    pos = elements["structure_pos"].to_numpy()
    valid = pos >= 0
    take = np.where(valid, pos, 0)

    def dim(col):
        v = pd.to_numeric(structures[col], errors="coerce").fillna(0.0).to_numpy()[take]
        return np.where(valid, v, 0.0)

    factors = [
        row["size_multiplier"].fillna(0).to_numpy(),
        row["f_number"].fillna(0).to_numpy() * dim("number_in_group"),
        row["f_length"].fillna(0).to_numpy() * dim("length_m"),
        row["f_width"].fillna(0).to_numpy() * dim("width_m"),
        row["f_headroom"].fillna(0).to_numpy() * dim("headroom_m"),
        row["f_spans"].fillna(0).to_numpy(),
        np.where(row["f_spans"].fillna(0).to_numpy() == 1, dim("spans") + row["spans_offset"].fillna(0).to_numpy(), 0.0),
    ]
    size = np.ones(len(elements))
    for f in factors:
        size *= np.where(f == 0, 1.0, f)          # SAVI: IF(x=0, 1, x)
    return size


def exposure_parameters(structures: pd.DataFrame, elements: pd.DataFrame, ecs: np.ndarray,
                        rs: RuleSet) -> np.ndarray:
    """The 19 structure-level exposure parameters (SAVI Value!AB:AT), one row per structure."""
    w = rs["exposure_weights"]
    influencing = [w.loc[i, "parameter"] for i in range(1, 15)]      # 14 influencing element types
    n = len(structures)
    params = np.zeros((n, 19))
    ekey = elements["element_type"].map(key).to_numpy()
    pos = elements["structure_pos"].to_numpy()
    for j, name in enumerate(influencing):
        hit = (ekey == key(name)) & (pos >= 0)
        # count present + count present in condition better than 4 -> 0 absent, 1 failed, 2 working
        params[:, j] = (np.bincount(pos[hit], minlength=n) +
                        np.bincount(pos[hit & (ecs < 4)], minlength=n))[:n]
    params[:, 14] = structures["location"].map(key).map(rs.locations["exposure_factor"]).astype(float).fillna(0)
    params[:, 15] = pd.to_numeric(structures["route_salted"], errors="coerce").fillna(0)
    params[:, 16] = structures["traffic"].map(key).map(rs.traffic["exposure_factor"]).astype(float).fillna(0)
    params[:, 17] = structures["obstacle_crossed"].map(key).isin(_WATERCOURSES).astype(int)
    params[:, 18] = pd.to_numeric(structures["obstacle_salted"], errors="coerce").fillna(0)
    return params


class _Tables:
    """Plain-Python views of the rule tables used in the per-element loop (fast lookups)."""

    def __init__(self, rs: RuleSet):
        et = rs.element_types
        flag_cols = [f"exp_flag_{k:02d}" for k in range(1, 22)]
        self.tm = rs["tm_arrangements"].sort_values("arrangement_id")
        self.tm_cols = list(self.tm["column"])
        self.tm_ids = self.tm["arrangement_id"].to_numpy(dtype=float)
        self.tm_names = list(self.tm["arrangement"])
        self.tm_rates = dict(zip(self.tm["arrangement"], self.tm["rate_per_hour"].astype(float)))
        self.elements = {
            k: {"scenario": float(r["exposure_scenario_id"]),
                "flags": r[flag_cols].to_numpy(dtype=float),
                "excluded": bool(r["excluded_from_valuation"]),
                "tm_location": r["tm_location"] or "",
                "tm_flags": r[self.tm_cols].to_numpy(dtype=float)}
            for k, r in et.iterrows()}
        self.weights = rs["exposure_weights"]["weight"].to_numpy(dtype=np.int64)
        self.spray = {k: _num(v) for k, v in rs.spray["exposure_factor"].items()}
        self.mat_protected = {k: _num(v) for k, v in rs.materials["protected_by_finishes"].items()}
        self.exposure_rules = rs.exposure_rules
        det = rs.deterioration
        frac_cols = [c for c in det.columns if c.startswith("frac_")]
        self.mttf = {}
        for k, v in det["mttf"].items():
            self.mttf.setdefault(k, _num(v))                     # SUMIF on a unique code
        self.average = {k: det.loc[k, frac_cols].to_numpy(dtype=float)
                        for k in det.index if k.endswith("|average")}
        cond = rs.condition
        self.cond_order = {k: int(v) for k, v in cond["order"].items()}
        self.teod_5b = float(cond.loc[key("5B"), "teod"])
        self.ext_5b = cond.loc[key("5B"), ["ext_s2", "ext_s3", "ext_s4", "ext_s5"]].to_numpy(dtype=float)
        rules = rs["intervention_rules"]
        self.rule_5b = rs.intervention_user_5b
        self.rule_after = list(rules["condition_after"])
        self.rule_action = [key(a) for a in rules["action"]]
        acts = rs.maintenance_actions
        self.action_id = {k: i for i, k in enumerate(acts.index, start=1)}
        self.actions = [
            {"cost_type": a["cost_type"], "fixed": _num(a["fixed_rate"]), "constant": _num(a["constant_rate"]),
             "variable": np.array([_num(a[f"var_rate_s{k}"]) for k in range(2, 6)]),
             "work_rate": _num(a["work_rate"])}
            for _, a in acts.iterrows()]
        self.routes = {k: r[self.tm_cols].to_numpy(dtype=float) for k, r in rs.routes.iterrows()}
        self.obstacles = {k: r[self.tm_cols].to_numpy(dtype=float) for k, r in rs.obstacles.iterrows()}
        self.bands = {}
        b = rs["addon_bands"]
        for kind in ("fP", "fO", "fD"):
            bb = b[b["kind"] == kind].sort_values("threshold")
            self.bands[kind] = (bb["threshold"].to_numpy(dtype=float), bb["factor"].to_numpy(dtype=float))

    def addon(self, kind: str, amount: float) -> float:
        thr, fac = self.bands[kind]
        i = int(np.searchsorted(thr, amount, side="right")) - 1     # Excel LOOKUP
        return float(fac[i]) if i >= 0 else float("nan")


def element_valuation(elements: pd.DataFrame, structures: pd.DataFrame, sizing: pd.DataFrame,
                      ecs: np.ndarray, rs: RuleSet) -> pd.DataFrame:
    """Per-element exposure, life, intervention cost and replacement cost."""
    T = rs.cache.get("valuation_tables")
    if T is None:
        T = rs.cache["valuation_tables"] = _Tables(rs)
    params = exposure_parameters(structures, elements, ecs, rs)
    sizes = element_size(elements, structures, rs)
    w = T.weights
    s_route = structures["route_supported"].map(key).tolist()
    s_obstacle = structures["obstacle_crossed"].map(key).tolist()
    s_tm_required = sizing["tm_required"].to_numpy()
    moderate, protected, average_2b = key("Moderate"), key("Protected"), "2B"
    key_5b = key("5B")

    cols = {c: [] for c in ["element_size", "exposure_id", "exposure", "time_to_failure", "equivalent_age_frac",
                            "rule_row", "condition_after", "repair_age_frac", "works_cost_id", "cost_type",
                            "works_quantity", "works_cost", "tm_code", "tm_cost", "fP", "fO", "fD",
                            "factor_2b", "element_replacement_cost", "valuation_error"]}
    etypes = elements["element_type"].map(key).tolist()
    mats = elements["material"].map(key).tolist()
    conds = elements["condition_code"].map(key).tolist()
    sprays = elements["spray_proximity"].map(key).tolist()
    positions = elements["structure_pos"].to_numpy()

    for i in range(len(elements)):
        p, ek, mk = int(positions[i]), etypes[i], mats[i]
        erow = T.elements.get(ek)
        excluded = erow is None or erow["excluded"]
        error = False

        # ---- exposure (SAVI Value!F:G) ------------------------------------------------
        exposure_id, exposure = None, None
        if erow is not None and p >= 0 and mk:
            f = erow["flags"]
            code = (erow["scenario"] * w[0] + float(np.dot(w[1:20] * f[:19], params[p]))
                    + w[20] * f[19] * T.spray.get(sprays[i], 0.0)
                    + w[21] * f[20] * T.mat_protected.get(mk, 0.0))
            exposure_id = int(round(code))
            if not excluded:
                exposure = T.exposure_rules.get(exposure_id)
        # SAVI blanks the exposure of excluded elements; an unresolved ID is #N/A.
        exp_key = "" if excluded or exposure is None else key(exposure)
        if not excluded and exposure is None:
            error = True

        # ---- life (H, I) ---------------------------------------------------------------
        ttf = T.mttf.get(f"{mk}|{exp_key}", 0.0) if (excluded or exposure is not None) else 0.0
        avg = T.average.get(f"{mk}|average")
        order = T.cond_order.get(conds[i])
        age = min(1.0, float(avg[order])) if (avg is not None and order is not None) else 0.0

        # ---- intervention triggered at failure (K, L, M) -------------------------------
        rule_row = -10
        if not excluded and exposure is not None:
            ek2 = moderate if exp_key == protected else exp_key
            rule_row = T.rule_5b.get(f"{key_5b}|{mk}|{ek2}", -10)
        cond_after = T.rule_after[rule_row - 1] if rule_row > 0 else None
        if cond_after == average_2b:
            repair_age = 2.0 * float(avg[0]) if avg is not None else float("nan")
        else:
            repair_age = 0.0

        # ---- works cost (O, P, Q, R) ---------------------------------------------------
        works_id = T.action_id.get(T.rule_action[rule_row - 1], -10) if rule_row > 0 else -10
        cost_type, qty, works = None, 0.0, 0.0
        if works_id > 0:
            a = T.actions[works_id - 1]
            cost_type = a["cost_type"]
            if cost_type == "Fixed":
                qty, works = 1.0, a["fixed"]
            elif cost_type == "Constant":
                qty = sizes[i]
                works = a["constant"] * qty
            elif cost_type == "Variable":
                qty = sizes[i] * T.teod_5b
                works = float(np.dot(a["variable"], T.ext_5b)) / T.teod_5b * qty

        # ---- traffic management (S, T) ---------------------------------------------------
        tm_code, tm_cost = "", 0.0
        if erow is not None and p >= 0 and s_tm_required[p] == 1 and erow["tm_location"]:
            loc = erow["tm_location"]
            r_fl, o_fl = T.routes.get(s_route[p]), T.obstacles.get(s_obstacle[p])
            sflags = None
            if loc == "RouteAndObstacle" and r_fl is not None and o_fl is not None:
                sflags = max(r_fl.max(), o_fl.max())        # Excel MAX(range, range) is a scalar
            elif loc == "Route" and r_fl is not None:
                sflags = r_fl
            elif loc == "Obstacle" and o_fl is not None:
                sflags = o_fl
            if sflags is None:
                error = True
            else:
                arr_id = float(np.dot(T.tm_ids * sflags, erow["tm_flags"]))
                if arr_id > 0:
                    idx = int(np.searchsorted(T.tm_ids, arr_id, side="right")) - 1
                    tm_code = loc + T.tm_names[idx]
        if tm_code and works_id > 0:
            arrangement = _TM_CODE_KEYS.get(key(tm_code))
            work_rate = T.actions[works_id - 1]["work_rate"]
            if arrangement is None or work_rate == 0:
                error = True
            else:
                tm_cost = qty / work_rate * T.tm_rates[arrangement]

        # ---- add-ons and element replacement cost (U..Y) ----------------------------------
        fP, fO = T.addon("fP", works), T.addon("fO", works)
        fD = T.addon("fD", works * (1 + fP + fO) + tm_cost)
        f2b = 1.0 / (1.0 - repair_age) if repair_age != 1 else float("nan")
        y = 0.0
        if not (ecs[i] == 0 or works_id < 0 or error):
            y = f2b * (works * (1 + fP + fO + fD + fP * fD + fO * fD) + tm_cost * (1 + fD))
            if not math.isfinite(y):
                y = 0.0                                     # SAVI: IFERROR(..., 0)

        for c, v in (("element_size", sizes[i]), ("exposure_id", exposure_id), ("exposure", exposure),
                     ("time_to_failure", ttf), ("equivalent_age_frac", age), ("rule_row", rule_row),
                     ("condition_after", cond_after), ("repair_age_frac", repair_age),
                     ("works_cost_id", works_id), ("cost_type", cost_type), ("works_quantity", qty),
                     ("works_cost", works), ("tm_code", tm_code), ("tm_cost", tm_cost), ("fP", fP),
                     ("fO", fO), ("fD", fD), ("factor_2b", f2b), ("element_replacement_cost", y),
                     ("valuation_error", error)):
            cols[c].append(v)
    return pd.DataFrame(cols, index=elements.index)


def structure_valuation(elements: pd.DataFrame, evalu: pd.DataFrame, sizing: pd.DataFrame,
                        n_structures: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """TERC normalisation, depreciation and DRC (SAVI Value!AV:BO)."""
    pos = elements["structure_pos"].to_numpy()
    y = evalu["element_replacement_cost"].to_numpy()
    valid = pos >= 0
    terc = np.bincount(pos[valid], weights=y[valid], minlength=n_structures)[:n_structures]
    grc = sizing["grc"].to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        factor = np.where(terc > 0, np.minimum(1.0, grc / np.where(terc > 0, terc, 1)), np.nan)

    f_el = np.where(valid, factor[np.where(valid, pos, 0)], np.nan)
    f_el = np.where(np.isfinite(f_el), f_el, np.nan)
    ttf = evalu["time_to_failure"].to_numpy()
    age = evalu["equivalent_age_frac"].to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        factored = np.where(np.isnan(f_el), 0.0, y * f_el)
        annual = np.where((y == 0) | np.isnan(f_el), 0.0, y / ttf * f_el)
        accumulated = np.where(np.isnan(f_el), 0.0, age * y * f_el)
    el_out = pd.DataFrame({"terc_factor": f_el, "factored_cost": factored,
                           "annual_depreciation": annual, "accumulated_depreciation": accumulated},
                          index=elements.index)

    def per_structure(v):
        return np.bincount(pos[valid], weights=v[valid], minlength=n_structures)[:n_structures]

    st_out = pd.DataFrame({
        "terc": terc,
        "grc_to_terc_factor": factor,
        "annual_depreciation": per_structure(annual),
        "accumulated_depreciation": per_structure(accumulated),
    }, index=sizing.index)
    st_out["drc"] = grc - st_out["accumulated_depreciation"].to_numpy()
    return st_out, el_out
