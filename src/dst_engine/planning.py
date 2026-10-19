"""Asset management planning: the 5-year programme and the long-term plan.

A vectorised re-implementation of SAVI v1.10's ``Y5`` and ``Yn`` sheets (SAMPT Part A
section 2.4 process logic). One planning *year* is:

1. Exposure     from the structure and the state of its influencing elements (Part C s.2)
2. Needs        the intervention rule triggered by each element's condition, under its
                strategy (Part C 6a); planned works pre-empt condition-triggered ones
3. Cost         works cost + traffic management + add-ons per element (Part A eq. 1-9)
4. Priority     PR = f1.ECI + network score + extra priority (Part A eq. 11, SAVI extras)
5. Consider     elements in priority order while cumulative cost <= budget factor x budget
6. Schemes      per structure: works + combined TM + add-ons; replace instead of repair
                when 1.5 x GRC is cheaper; fund structures in priority order while the
                cumulative scheme cost fits the budget
7. Maintain / deteriorate   treated elements reset; others follow the material curve
8. Evaluate     condition indices, at-risk structures, traffic delay, spend, shortfall

Every rule comes from the versioned rule set; behaviours that differ from the SAMPT
documents are SAVI's and are recorded in docs/DECISION_LOG.md (D-009 onwards).
"""
from __future__ import annotations

import math
import struct
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .condition import AVF_GROUPS
from .grc import compute_grc
from .inventory import Inventory
from .ruleset import RuleSet, key
from .run import attach_structure_positions
from .valuation import _TM_CODE_KEYS, exposure_parameters

STRATEGIES = {
    "early intervention (condition 2c-3c)": "trigger_early",
    "mid intervention (condition 4b)": "trigger_mid",
    "late intervention (condition 5b)": "trigger_late",
    "user defined (default, condition 4b)": "trigger_user",
}
TM_CODES = ["RouteContraflow", "RouteShuttle Working / Lane Closure", "RouteHardshoulder Closure",
            "RouteAndObstacleRetaining Wall TM", "ObstacleContraflow", "ObstacleShuttle Working / Lane Closure",
            "ObstacleHardshoulder Closure", "ObstacleWaterway Possession", "ObstacleRailway Possession"]
WORK_COLUMNS = ["year", "element_index", "element_seq", "structure_index", "structure_id", "element_type",
                "material", "status", "action", "condition_before", "ecs_before", "ecs_after", "priority",
                "structure_rank", "cost", "works_cost", "exposure"]
_IMPORTANCE_POS = {"Low": 1, "Medium": 2, "High": 3, "Very High": 4}
_ECF_BASE = {"Very High": 0.0, "High": 0.3, "Medium": 0.6, "Low": 1.2}


# ------------------------------------------------------------------ Excel helpers
def xl_round(x, digits: int = 0):
    """Excel ROUND: half away from zero."""
    f = 10.0 ** digits
    x = np.asarray(x, dtype=float)
    # Excel works to 15 significant digits, so 8.825 (stored as 8.82499999...) rounds up.
    return np.sign(x) * np.floor(np.round(np.abs(x) * f, 6) + 0.5) / f


def xl_cmp(x):
    """Value as Excel sees it in a comparison: rounded to 15 significant digits."""
    x = np.asarray(x, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        mag = np.where(x == 0, 0, np.floor(np.log10(np.abs(np.where(x == 0, 1, x)))))
    scale = 10.0 ** (14 - mag)
    return np.where(np.isfinite(x), np.round(x * scale) / scale, x)


def xl_rounddown1(x):
    """Excel ROUNDDOWN(x, 1) for x >= 0, tolerant of binary representation (2.3 -> 2.3)."""
    return np.floor(np.round(np.asarray(x, dtype=float) * 10.0, 9)) / 10.0


def vba_rnd_draws(n: int) -> np.ndarray:
    """The n numbers SAVI writes to Ref99: VBA ``Rnd(-10)`` then ``Randomize 0`` then ``Rnd()``.

    Emulates VBA's 24-bit linear congruential generator exactly, so the engine reproduces
    SAVI's randomised start conditions for any inventory (decision D-010).
    """
    b = struct.unpack("<I", struct.pack("<f", -10.0))[0]
    seed = ((b & 0xFFFFFF) + (b >> 24)) & 0xFFFFFF
    seed = (seed * 0x43FD43FD + 0xC39EC3) & 0xFFFFFF
    h = struct.unpack("<Q", struct.pack("<d", 0.0))[0] >> 32
    h = ((h & 0xFFFF) ^ (h >> 16)) << 8
    seed = (seed & 0xFF0000FF) | (h & 0x00FFFF00)
    out = np.empty(n)
    for i in range(n):
        seed = (seed * 0x43FD43FD + 0xC39EC3) & 0xFFFFFF
        out[i] = seed / 16777216.0
    return out


# ------------------------------------------------------------------ settings
@dataclass
class PlanSettings:
    """Analysis parameters (SAMPT Part B Function 4)."""
    years: int = 30
    budget_bands: list[tuple[int, int, float]] = field(default_factory=lambda: [(1, 30, 3_000_000.0)])
    five_year_annual_budget: float = 3_000_000.0
    strategy: str = "Mid Intervention (condition 4B)"   # default where an element has none
    extra_priority_vh_h_ecs5: bool = True
    extra_priority_ml_ecs5: bool = False
    extra_priority_vh_h_ecs4: bool = True
    extra_priority_ml_ecs4: bool = False
    carry_forward_budget: bool = True                   # SAVI (D-011); SAMPT user guide: False
    random: str | int = "savi"                          # "savi" | "midpoint" | int seed
    five_year_budget_factor: float = 1.2
    long_term_min_budget_factor: float = 6.0
    replace_multiplier: float | None = None             # default from rule set (1.5)
    deterioration_factor: float = 1.0                   # < 1 = faster deterioration

    @classmethod
    def from_inventory(cls, inv: Inventory, **overrides) -> "PlanSettings":
        s = inv.settings or {}
        bands = []
        for row in s.get("budget_long_term") or []:
            vals = [v for v in row if v is not None]
            if len(vals) >= 3:
                bands.append((int(vals[0]), int(vals[1]), float(vals[2])))
        kw = {}
        if bands:
            kw["budget_bands"] = bands
        if s.get("years_long_term"):
            kw["years"] = int(s["years_long_term"])
        if s.get("budget_5yr_annual"):
            kw["five_year_annual_budget"] = float(s["budget_5yr_annual"])
        if s.get("intervention_strategy"):
            kw["strategy"] = s["intervention_strategy"]
        kw.update(overrides)
        return cls(**kw)

    def budget(self, year: int) -> float:
        """Ref98!O: user budget for a year (1e-10 when no band covers it)."""
        for a, b, v in self.budget_bands:
            if a <= year <= b:
                return v if v != 0 else 1e-10
        return 1e-10


# ------------------------------------------------------------------ the model
class PlanningModel:
    """Static arrays for one inventory + rule set; ``run_long_term`` / ``run_five_year`` reuse them."""

    def __init__(self, inv: Inventory, rs: RuleSet, settings: PlanSettings | None = None):
        self.rs, self.inv = rs, inv
        self.settings = settings or PlanSettings.from_inventory(inv)
        st = inv.structures.reset_index(drop=True)
        el = attach_structure_positions(st, inv.elements.reset_index(drop=True))
        self.structures, self.elements = st, el
        self.ns, self.ne = len(st), len(el)
        self.pos = el["structure_pos"].to_numpy()
        self.ttf_factor = np.ones(len(el))           # per-element time-to-failure multiplier (uncertainty)
        self.valid = self.pos >= 0
        self.posz = np.where(self.valid, self.pos, 0)
        self._structure_static()
        self._element_static()
        self._planned_and_routine()

    # ---------------------------------------------------------- structures
    def _structure_static(self):
        rs, st = self.rs, self.structures
        sizing = compute_grc(st, rs, self.inv.authority_type)
        self.sizing = sizing
        w = rs.priority_weights
        rf = st["route_supported"].map(key).map(rs.routes["rf"]).astype(float).fillna(0)
        tf = st["traffic"].map(key).map(rs.traffic["tf"]).astype(float).fillna(0)
        obs = st["obstacle_crossed"].map(key).map(rs.obstacles["obsf"]).astype(float).fillna(0)
        stf = st["structure_type"].map(key).map(rs.structure_types["stf"]).astype(float).fillna(0)
        self.network_priority = (w["f2"] * (rf + tf + obs) + w["f3"] * stf).to_numpy()  # Structures!AY
        pfw = rs["priority_factor_weights"]
        spf = pfw[pfw["level"] == "structure"]
        az = np.zeros(self.ns)
        for c, wt in zip(spf["column"], spf["weight"]):
            az += wt * pd.to_numeric(st.get(c, 0), errors="coerce").fillna(0).to_numpy()
        self.structure_pf = az                                                           # Structures!AZ
        self.grc = sizing["grc"].to_numpy()
        self.avf_type = sizing["avf_type"].to_numpy()
        self.key_dim = sizing["key_dimension"].to_numpy()
        self.key_dim_avf = sizing["key_dimension_x_avf"].to_numpy()
        self.n_group = pd.to_numeric(st["number_in_group"], errors="coerce").fillna(0).to_numpy()
        length = pd.to_numeric(st["length_m"], errors="coerce").fillna(0).to_numpy()
        self.length_group = np.where(length <= 10, 0.0, np.where(length <= 20, 10.0001, 20.0001))
        self.delay_rate = st["traffic"].map(key).map(rs.traffic["daily_delay_rate"]).astype(float).fillna(0).to_numpy()
        codes = rs["traffic_restriction_codes"].set_index("avf_type")
        self.code4 = pd.Series(self.avf_type).map(codes["code_ecs4"]).fillna(0).astype(int).to_numpy()
        self.code5 = pd.Series(self.avf_type).map(codes["code_ecs5"]).fillna(0).astype(int).to_numpy()
        self.delay_days = {(round(r.length_over_m, 4), int(r.restriction_code)): r.days
                           for r in rs["traffic_delay_days"].itertuples()}
        self.delay_mult = rs.constants.get("traffic_delay_extra_multiplier", 1.0)
        self.replace_mult = (self.settings.replace_multiplier
                             or rs.constants["replace_vs_repair_grc_multiplier"])

    # ---------------------------------------------------------- elements
    def _element_static(self):
        rs, el, st = self.rs, self.elements, self.structures
        et = rs.element_types
        ek = el["element_type"].map(key)
        self.etype_key = ek.to_numpy()
        self.mat_key = el["material"].map(key).fillna("").to_numpy()
        self.importance = ek.map(et["importance"]).fillna("").to_numpy()
        self.eif = ek.map(et["eif"]).astype(float).fillna(0).to_numpy()
        self.imp_pos = np.array([_IMPORTANCE_POS.get(i, 0) for i in self.importance])
        self.ecf_base = np.array([_ECF_BASE.get(i, 0.0) for i in self.importance])
        self.life = ek.map(et["life"]).fillna("").to_numpy()
        self.seq = pd.to_numeric(el["element_seq"], errors="coerce").fillna(-1).astype(int).to_numpy()

        from .valuation import element_size
        self.size = element_size(el, st, rs)

        # exposure encoding: static part + per-element flags for the 14 influencing elements
        w = rs["exposure_weights"]["weight"].to_numpy(dtype=np.int64)
        flag_cols = [f"exp_flag_{k:02d}" for k in range(1, 22)]
        flags = et.reindex(ek)[flag_cols].fillna(0).to_numpy(dtype=float)
        scen = ek.map(et["exposure_scenario_id"]).astype(float).fillna(0).to_numpy()
        spray = el["spray_proximity"].map(key).map(rs.spray["exposure_factor"]).astype(float).fillna(0).to_numpy()
        prot = pd.Series(self.mat_key).map(rs.materials["protected_by_finishes"]).astype(float).fillna(0).to_numpy()
        self.has_exposure = self.valid & ek.isin(et.index).to_numpy() & (self.mat_key != "")
        self.exp_flags = flags
        self.exp_weights = w
        self.exp_static = scen * w[0] + w[20] * flags[:, 19] * spray + w[21] * flags[:, 20] * prot
        # structure-level params 14..18 (location, salted route, traffic, watercourse, salted obstacle)
        zeros = np.zeros(self.ne)
        p0 = exposure_parameters(st, el, zeros, rs)          # counts with all ECS 0 -> "present" x2
        self.exp_struct_params = p0[:, 14:]
        self.exp_static += np.einsum("ij,ij->i", (w[15:20] * flags[:, 14:19]), self.exp_struct_params[self.posz])
        self.exp_static = np.where(self.has_exposure, self.exp_static, np.nan)
        influencing = [key(n) for n in rs["exposure_weights"]["parameter"].iloc[1:15]]
        self.influence_idx = np.array([influencing.index(k) if k in influencing else -1 for k in self.etype_key])
        self.exposure_rules = rs.exposure_rules

        # deterioration curves (material|exposure -> fractions of life at each of 17 codes, mttf)
        det = rs.deterioration
        frac_cols = [c for c in det.columns if c.startswith("frac_")]
        self.det_index = {k: i for i, k in enumerate(det.index) if k not in {}}
        self.det_frac = det[frac_cols].to_numpy(dtype=float)
        self.det_mttf = pd.to_numeric(det["mttf"], errors="coerce").fillna(0).to_numpy()
        # SUMIF semantics: duplicate keys would add; the rule set has unique keys (integrity test)

        # condition codes
        cond = rs["condition_codes"]
        self.codes = list(cond["code"])
        self.code_pos = {key(c): i for i, c in enumerate(self.codes)}
        self.ecs_list = cond["ecs"].to_numpy(dtype=float)
        self.teod = cond["teod"].to_numpy(dtype=float)
        self.ext = cond[["ext_s2", "ext_s3", "ext_s4", "ext_s5"]].to_numpy(dtype=float)

        # strategies and intervention rules
        rules = rs["intervention_rules"]
        strat_default = STRATEGIES.get(key(self.settings.strategy), "trigger_mid")
        per_el = el.get("intervention_threshold", pd.Series([None] * self.ne))
        self.strategy_col = np.array([STRATEGIES.get(key(s), strat_default) if isinstance(s, str) and s
                                      else strat_default for s in per_el])
        self.rule_lookup: dict[str, dict[str, int]] = {}
        for col in STRATEGIES.values():
            d = {}
            for i, k in enumerate(rules[col].map(key) + "|" + rules["material"].map(key) + "|" + rules["exposure"].map(key), 1):
                d.setdefault(k, i)
            self.rule_lookup[col] = d
        acts = rs["maintenance_actions"]
        act_id = {k: i for i, k in enumerate(acts["action"].map(key), 1)}
        self.rule_action = np.array([act_id.get(key(a), -10) for a in rules["action"]])
        self.rule_action_name = list(rules["action"])
        self.rule_after_ecs = np.array([self.ecs_list[self.code_pos[key(c)]] if key(c) in self.code_pos else np.nan
                                        for c in rules["condition_after"]])
        self.act_type = list(acts["cost_type"])
        self.act_fixed = pd.to_numeric(acts["fixed_rate"], errors="coerce").fillna(0).to_numpy()
        self.act_const = pd.to_numeric(acts["constant_rate"], errors="coerce").fillna(0).to_numpy()
        self.act_var = acts[["var_rate_s2", "var_rate_s3", "var_rate_s4", "var_rate_s5"]].apply(
            pd.to_numeric, errors="coerce").fillna(0).to_numpy()
        self.act_rate = pd.to_numeric(acts["work_rate"], errors="coerce").fillna(0).to_numpy()

        # traffic management code per element (static: depends on structure and element type)
        tm = rs["tm_arrangements"].sort_values("arrangement_id")
        tm_cols, tm_ids, tm_names = list(tm["column"]), tm["arrangement_id"].to_numpy(dtype=float), list(tm["arrangement"])
        tm_rate = dict(zip(tm["arrangement"], tm["rate_per_hour"].astype(float)))
        req = self.sizing["tm_required"].to_numpy()
        routes = {k: r[tm_cols].to_numpy(dtype=float) for k, r in rs.routes.iterrows()}
        obstacles = {k: r[tm_cols].to_numpy(dtype=float) for k, r in rs.obstacles.iterrows()}
        s_route = st["route_supported"].map(key).to_numpy()
        s_obs = st["obstacle_crossed"].map(key).to_numpy()
        tm_code_idx = np.full(self.ne, -1)
        for i in range(self.ne):
            p = self.pos[i]
            if p < 0 or req[p] != 1 or self.etype_key[i] not in et.index:
                continue
            row = et.loc[self.etype_key[i]]
            loc = row["tm_location"] or ""
            if not loc:
                continue
            r_fl, o_fl = routes.get(s_route[p]), obstacles.get(s_obs[p])
            if loc == "RouteAndObstacle" and r_fl is not None and o_fl is not None:
                sfl = max(r_fl.max(), o_fl.max())
            elif loc == "Route" and r_fl is not None:
                sfl = r_fl
            elif loc == "Obstacle" and o_fl is not None:
                sfl = o_fl
            else:
                continue
            arr = float(np.dot(tm_ids * sfl, row[tm_cols].to_numpy(dtype=float)))
            if arr > 0:
                code = loc + tm_names[int(np.searchsorted(tm_ids, arr, side="right")) - 1]
                if key(code) in {key(c) for c in TM_CODES}:
                    tm_code_idx[i] = [key(c) for c in TM_CODES].index(key(code))
        self.tm_code_idx = tm_code_idx
        self.tm_code_rate = np.array([tm_rate[_TM_CODE_KEYS[key(c)]] for c in TM_CODES])

        # element priority factors (Elements!AD = element pf + structure pf)
        pfw = rs["priority_factor_weights"]
        epf = pfw[pfw["level"] == "element"]
        ad = np.zeros(self.ne)
        for c, wt in zip(epf["column"], epf["weight"]):
            ad += wt * pd.to_numeric(el.get(c, 0), errors="coerce").fillna(0).to_numpy()
        self.element_pf = ad + np.where(self.valid, self.structure_pf[self.posz], 0.0)

        # add-on bands
        b = rs["addon_bands"]
        self.bands = {k: (g.sort_values("threshold")["threshold"].to_numpy(dtype=float),
                          g.sort_values("threshold")["factor"].to_numpy(dtype=float)) for k, g in b.groupby("kind")}

        # starting condition (Y0!B:F)
        ccode = el["condition_code"].map(key)
        self.start_pos = ccode.map(self.code_pos).fillna(-1).astype(int).to_numpy()
        self.start_ecs = np.where(self.start_pos >= 0, self.ecs_list[np.maximum(self.start_pos, 0)], 0.0)

    def _planned_and_routine(self):
        p = self.inv.planned
        self.planned = {}
        if p is not None and len(p):
            for r in p.itertuples(index=False):
                c = key(r.condition_after)
                ecs = self.ecs_list[self.code_pos[c]] if c in self.code_pos else 0.0
                k = (int(r.element_seq), int(r.year_of_work))
                cost, e0 = self.planned.get(k, (0.0, 0.0))
                self.planned[k] = (cost + float(r.total_cost or 0), e0 + ecs)        # SUMIF semantics
        self.routine = {}
        rt = self.inv.routine
        if rt is not None and len(rt):
            num = rt.drop(columns=["year"]).apply(pd.to_numeric, errors="coerce").fillna(0)
            self.routine = dict(zip(pd.to_numeric(rt["year"]).astype(int), num.sum(axis=1)))

    # ---------------------------------------------------------- helpers
    def addon(self, kind: str, amount: np.ndarray) -> np.ndarray:
        thr, fac = self.bands[kind]
        i = np.searchsorted(thr, amount, side="right") - 1
        return np.where(i >= 0, fac[np.maximum(i, 0)], np.nan)

    def start_draws(self) -> np.ndarray:
        r = self.settings.random
        if r == "savi":
            return vba_rnd_draws(self.ne)
        if r == "midpoint":
            return np.full(self.ne, 0.5)
        return np.random.default_rng(int(r)).random(self.ne)

    def initial_state(self, draws: np.ndarray | None = None) -> dict:
        """Y0!B:F - code, reported ECS and a randomised precise ECS inside the code's band."""
        d = self.start_draws() if draws is None else draws
        pos = self.start_pos
        nxt = np.where(pos == 16, self.ecs_list[16], self.ecs_list[np.minimum(np.maximum(pos, 0) + 1, 16)])
        nxt = np.where(pos >= 0, nxt, 0.0)
        precise = self.start_ecs + d * (nxt - self.start_ecs)
        return {"pos": pos.copy(), "ecs": self.start_ecs.copy(), "precise": precise}

    def exposure(self, reported_ecs: np.ndarray) -> np.ndarray:
        """Exposure ID -> exposure name per element, given current reported ECS of influencing elements."""
        counts = np.zeros((self.ns, 14))
        inf = (self.influence_idx >= 0) & self.valid
        for j in range(14):
            hit = inf & (self.influence_idx == j)
            counts[:, j] = (np.bincount(self.pos[hit], minlength=self.ns)
                            + np.bincount(self.pos[hit & (reported_ecs < 4)], minlength=self.ns))[: self.ns]
        w = self.exp_weights
        dyn = np.einsum("ij,ij->i", w[1:15] * self.exp_flags[:, :14], counts[self.posz])
        code = np.rint(self.exp_static + dyn)
        names = np.full(self.ne, "", dtype=object)
        ok = ~np.isnan(code)
        names[ok] = [self.exposure_rules.get(int(c), "") for c in code[ok]]
        return names

    # ---------------------------------------------------------- one planning pass
    def _pass(self, state: dict, year: int | str, budget_available: float, consider_limit: float,
              planned_lookup, overrides: dict | None = None) -> dict:
        """Steps 1-6 for one year (Yn) or for the 5-year pot (Y5). Returns element/structure arrays."""
        ne, ns = self.ne, self.ns
        pos_c, C, D = state["pos"], state["ecs"], state["precise"]
        J = self.exposure(C)
        keyJ = np.array([key(j) for j in J], dtype=object)
        det_k = np.array([self.det_index.get(f"{m}|{e}", -1) for m, e in zip(self.mat_key, keyJ)])
        mttf = np.where(det_k >= 0, self.det_mttf[np.maximum(det_k, 0)], 0.0)
        K = xl_round(mttf * self.settings.deterioration_factor * self.ttf_factor, 0)

        # ---- needs: planned work pre-empts; else rule triggered by current code
        planned_now = np.array([planned_lookup(int(s)) is not None for s in self.seq])
        code_key = np.array([key(self.codes[p]) if p >= 0 else "" for p in pos_c], dtype=object)
        M = np.full(ne, -10)
        for i in range(ne):
            if planned_now[i]:
                continue
            M[i] = self.rule_lookup[self.strategy_col[i]].get(f"{code_key[i]}|{self.mat_key[i]}|{keyJ[i]}", -10)
        if overrides:
            for i in overrides.get("reject", ()):
                M[i] = -10
        N = np.where(M > 0, self.rule_action[np.maximum(M - 1, 0)], -10)

        # ---- priority (O, P, Q)
        ecf = np.where(self.ecf_base > 0, self.ecf_base - (D - 1) * self.ecf_base / 4, 0.0)
        F = np.where((D == 0) | (self.eif == 0), 0.0, np.maximum(D - ecf, 1.0))
        O = np.where(N == -10, 0.0, xl_round(self.rs.priority_weights["f1"] * F
                                             + np.where(self.valid, self.network_priority[self.posz], 0.0), 2))
        hi = self.imp_pos > 2
        lo = self.imp_pos < 3
        s = self.settings
        bonus5 = ((hi & s.extra_priority_vh_h_ecs5) | (lo & s.extra_priority_ml_ecs5))
        bonus4 = ((hi & s.extra_priority_vh_h_ecs4) | (lo & s.extra_priority_ml_ecs4))
        P = 5000.0 * (C >= 5) * bonus5 + 400.0 * ((C >= 4) & (C < 5)) * bonus4 + self.element_pf
        P = np.where(keyJ == "protected", 0.0, P)
        Q = O + P

        # ---- cost (R..AB)
        act = np.maximum(N - 1, 0)
        ctype = np.array([self.act_type[a] if n > 0 else "" for a, n in zip(act, N)], dtype=object)
        spos = np.where(pos_c >= 0, pos_c, 1)
        teod = self.teod[spos]
        T = np.where(ctype == "Fixed", 1.0, self.size * np.where(ctype == "Constant", 1.0,
                                                                 np.where(ctype == "Variable", teod, 0.0)))
        var_rate = np.einsum("ij,ij->i", self.act_var[act], self.ext[spos]) / teod
        U = np.select([ctype == "Fixed", ctype == "Constant", ctype == "Variable"],
                      [self.act_fixed[act], self.act_const[act], var_rate], 0.0) * np.where(ctype == "Fixed", 1.0, 1.0)
        U = np.where(ctype == "Fixed", self.act_fixed[act], U * T)
        U = np.where(N > 0, U, 0.0)
        has_tm = (N > 0) & (self.tm_code_idx >= 0)
        rate = self.act_rate[act]
        with np.errstate(divide="ignore", invalid="ignore"):
            W = np.where(has_tm, T / rate, 0.0)
        X = np.where(has_tm, W * self.tm_code_rate[np.maximum(self.tm_code_idx, 0)], 0.0)
        fP, fO = self.addon("fP", U), self.addon("fO", U)
        fD = self.addon("fD", U * (1 + fP + fO) + X)
        AB = xl_round(U * (1 + fP + fO + fD + fP * fD + fO * fD) + X * (1 + fD), 2)
        AB = np.where(N > 0, AB, 0.0)

        # ---- consider for scheme (AC..AE): eligible elements in priority order
        elig = N != -10
        order = np.lexsort((np.arange(ne), -Q))
        order = order[elig[order]]
        cum = np.cumsum(AB[order])
        AD = np.zeros(ne)
        AD[order] = cum
        AE = elig & (AD <= consider_limit)
        if overrides:
            for i in overrides.get("force", ()):
                AE[i] = N[i] > 0
        AF = Q * AE

        # ---- structure schemes
        tm_dur_all = self._tm_durations(W, np.ones(ne, bool))
        tm_dur_des = self._tm_durations(W, AE)
        BL = self._sum_by_structure(U)
        workbank = self._scheme_cost(BL, tm_dur_all)
        CL = self._sum_by_structure(U * AE)
        CM, CO = self.addon("fP", CL), self.addon("fO", CL)
        CZ = (tm_dur_des * self.tm_code_rate).sum(axis=1)
        DA = self.addon("fD", CL * (1 + CM + CO) + CZ)
        DC = CL + CM * CL + CO * CL + CZ + DA * (CL + CM * CL + CO * CL + CZ)
        CF = xl_round(self._sum_by_structure(AF), 2)
        DD = self.grc * self.replace_mult
        action = np.where(DC == 0, 0, np.where(DD < DC, 2, 1))           # 0 none, 1 maintain, 2 replace
        DF = np.where(action == 2, DD, np.where(action == 1, DC, 0.0))
        s_order = np.lexsort((np.arange(ns), -CF))
        s_order = s_order[CF[s_order] > 0]
        cum_s = np.cumsum(DF[s_order])
        DG = np.zeros(ns, dtype=int)
        funded = (budget_available - cum_s) >= 0
        DG[s_order[funded]] = action[s_order[funded]]
        DH = np.where(DG > 0, DF, 0.0)
        rank = np.zeros(ns, dtype=int)
        rank[s_order] = np.arange(1, len(s_order) + 1)
        cum_all = np.zeros(ns)
        cum_all[s_order] = cum_s

        # ---- element status and costs (DN..DY)
        dgs = np.where(self.valid, DG[self.posz], 0)
        DN = np.where(planned_now, 3, np.where(dgs == 2, 2, np.where(~self.valid, 0,
                                                                     np.where(~AE, 0, np.where(dgs == 1, 1, 0)))))
        DN = np.where(planned_now, 3, np.where(self.valid & (dgs == 2), 2, DN))
        maint = DN == 1
        pP = np.where(self.valid, CM[self.posz], 0.0)
        pO = np.where(self.valid, CO[self.posz], 0.0)
        pD = np.where(self.valid, DA[self.posz], 0.0)
        sumW = self._sum_w_by_code(W)
        with np.errstate(divide="ignore", invalid="ignore"):
            cidx = np.maximum(self.tm_code_idx, 0)
            DS = np.where(W == 0, 0.0, W / sumW[self.posz, cidx] * tm_dur_des[self.posz, cidx] * self.tm_code_rate[cidx])
        DS = np.where(maint, np.nan_to_num(DS), 0.0)
        DV = np.where(maint, U + U * pP + U * pO + DS + pD * (U + DS + U * pP + U * pO), 0.0)
        sumU = self._sum_by_structure(U)
        with np.errstate(divide="ignore", invalid="ignore"):
            DW = np.where(DN == 2, U / sumU[self.posz] * DH[self.posz], 0.0)
        DW = np.nan_to_num(DW)
        DX = np.array([planned_lookup(int(s))[0] if d == 3 else 0.0 for s, d in zip(self.seq, DN)])
        return dict(J=J, K=K, M=M, N=N, Q=Q, U=U, W=W, AB=AB, AE=AE, DN=DN, DV=DV, DW=DW, DX=DX,
                    workbank_by_structure=workbank, CF=CF, DC=DC, DD=DD, action=action, DF=DF, DG=DG, DH=DH,
                    rank=rank, cum=cum_all, fP=CM, fO=CO, fD=DA, tm=tm_dur_des, planned_now=planned_now)

    def _sum_by_structure(self, v: np.ndarray) -> np.ndarray:
        return np.bincount(self.pos[self.valid], weights=v[self.valid], minlength=self.ns)[: self.ns]

    def _sum_w_by_code(self, W: np.ndarray) -> np.ndarray:
        out = np.zeros((self.ns, len(TM_CODES)))
        m = self.valid & (self.tm_code_idx >= 0)
        np.add.at(out, (self.pos[m], self.tm_code_idx[m]), W[m])
        return out

    def _tm_durations(self, W: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """Combined TM durations per structure (SAVI Yn!BQ:BY / CQ:CY; Part A 2.11.6)."""
        mx = np.zeros((self.ns, len(TM_CODES)))
        m = self.valid & (self.tm_code_idx >= 0) & mask
        np.maximum.at(mx, (self.pos[m], self.tm_code_idx[m]), W[m])
        RC, RS, RH, RW, OC, OS, OH, OW, OR_ = mx.T
        d = np.zeros_like(mx)
        d[:, 0] = RC
        d[:, 1] = np.maximum(RS - d[:, 0], 0)
        d[:, 2] = np.maximum(RH - d[:, 0] - d[:, 1], 0)
        d[:, 3] = np.maximum(RW - d[:, 2], 0)                 # SAVI subtracts only the hardshoulder term
        d[:, 4] = np.maximum(OC, 0)
        d[:, 5] = np.maximum(OS - d[:, 4], 0)
        d[:, 6] = np.maximum(OH - d[:, 5] - d[:, 4], 0)
        d[:, 7] = np.maximum(OW, 0)
        d[:, 8] = np.maximum(OR_, 0)
        return d

    def _scheme_cost(self, works: np.ndarray, tm_dur: np.ndarray) -> np.ndarray:
        fP, fO = self.addon("fP", works), self.addon("fO", works)
        tmc = (tm_dur * self.tm_code_rate).sum(axis=1)
        base = works + fP * works + fO * works + tmc
        fD = self.addon("fD", base)
        return np.where(works > 0, base + fD * base, base + fD * base)

    # ---------------------------------------------------------- condition at end of period
    def _deteriorate(self, state: dict, K: np.ndarray, keyJ: np.ndarray) -> np.ndarray:
        """Yn!DZ:EF - one year of deterioration along the material curve (no maintenance)."""
        pos_c, C, D = state["pos"], state["ecs"], state["precise"]
        S = np.where(pos_c >= 0, pos_c, 1)                       # 0-based position of current code
        is5e = S == 16
        det_k = np.array([self.det_index.get(f"{m}|{e}", -1) for m, e in zip(self.mat_key, keyJ)])
        frac = np.where(det_k[:, None] >= 0, self.det_frac[np.maximum(det_k, 0)], np.nan)
        ecs = self.ecs_list
        nxt = np.where(S + 1 <= 16, ecs[np.minimum(S + 1, 16)], np.nan)
        nxt2 = np.where(S + 2 <= 16, ecs[np.minimum(S + 2, 16)], np.nan)
        fa = np.take_along_axis(frac, np.minimum(S, 16)[:, None], 1)[:, 0]
        fb = np.where(S + 1 <= 16, np.take_along_axis(frac, np.minimum(S + 1, 16)[:, None], 1)[:, 0], np.nan)
        fc = np.where(S + 2 <= 16, np.take_along_axis(frac, np.minimum(S + 2, 16)[:, None], 1)[:, 0], np.nan)
        DZ = np.where(is5e, 0.0, nxt - D)
        with np.errstate(divide="ignore", invalid="ignore"):
            ED = (nxt - C) / (fb - fa) / K
            EE = (nxt2 - nxt) / (fc - fb) / K
            ratio = DZ / ED
            a = D + ED
            b = D + ED * ratio + EE * (1 - ratio)
            ef = np.where(ratio >= 1, a, b)
        ok = np.isfinite(ratio) & np.where(ratio >= 1, np.isfinite(a), np.isfinite(b)) & ~is5e
        return np.where(ok, np.minimum(ef, 5.0), np.minimum(D, 5.0))

    def _snap(self, eg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Yn!EH:EI - reported ECS and code position from a precise ECS."""
        e = self.ecs_list
        rep = np.where((eg > 5) & (eg <= e[14]), e[14],
                       np.where((eg > e[14]) & (eg <= e[15]), e[15],
                                np.where(eg > e[15], e[16], np.nan)))
        snap = np.searchsorted(e, xl_rounddown1(eg), side="right") - 1
        rep = np.where(np.isnan(rep), np.where(snap >= 0, e[np.maximum(snap, 0)], 0.0), rep)
        pos = np.searchsorted(e, rep, side="left")
        pos = np.where((pos < 17) & (e[np.minimum(pos, 16)] == rep), pos, -1)
        return rep, pos

    # ---------------------------------------------------------- evaluation
    def evaluate(self, reported: np.ndarray, precise: np.ndarray) -> dict:
        """End-of-period condition metrics (Yn!EK:FP and the FY results block)."""
        ecf = np.where(self.ecf_base > 0, self.ecf_base - (reported - 1) * self.ecf_base / 4, 0.0)
        eci = np.where((self.eif == 0), 0.0, np.maximum(reported - ecf, 1.0))
        v = self.valid
        sum_eif = self._sum_by_structure(self.eif)
        sum_ex = self._sum_by_structure(eci * self.eif)
        with np.errstate(divide="ignore", invalid="ignore"):
            m = np.where(sum_eif == 0, 0.0, sum_ex / np.where(sum_eif == 0, 1, sum_eif))
        sci_av = np.where(sum_eif == 0, 0.0, np.minimum(115 - 2 * m * (m + 6.5), 100.0))
        max_vh = np.zeros(self.ns)
        vh = v & (self.eif == 2)
        np.maximum.at(max_vh, self.pos[vh], eci[vh])
        sci_crit = np.clip(115 - 2 * max_vh * (max_vh + 6.5), 0.0, 100.0)
        c = self.rs.constants
        sgr = (sci_av > c["sgr_sci_av_threshold"]) & (sci_crit > c["sgr_sci_crit_threshold"])
        # at-risk: precise ECS of very-high/high elements
        ep = np.where(np.isin(self.eif, [2.0, 1.5]), precise, 0.0)
        max_ep = np.zeros(self.ns)
        np.maximum.at(max_ep, self.pos[v], ep[v])
        cmp = xl_cmp(max_ep)                       # Excel compares at 15 significant digits
        band = np.where(cmp >= 5, 5, np.where(cmp >= 4, 4, 0))
        code = np.where(band == 4, self.code4, np.where(band == 5, self.code5, 0))
        days = np.array([self.delay_days.get((round(lg, 4), int(cd)), 0.0) if b else 0.0
                         for lg, cd, b in zip(self.length_group, code, band)])
        delay = np.where(band > 0, self.delay_rate * days * self.delay_mult, 0.0)
        at_risk = np.where(delay > 0, self.n_group, 0.0)
        return {"eci": eci, "sci_av": sci_av, "sci_crit": sci_crit, "sgr": sgr.astype(int),
                "delay_cost": delay, "at_risk": at_risk}

    def stock_metrics(self, ev: dict) -> dict:
        """The LAMP Results condition columns (R..BH) from an evaluation."""
        out = {}
        groups = list(AVF_GROUPS.items())
        kd, kda = self.key_dim, self.key_dim_avf

        def ratio(n, d):
            return float(n / d) if d else 0.0

        for metric, val in (("ssci_av", ev["sci_av"]), ("ssci_crit", ev["sci_crit"])):
            for t, label in groups:
                if t == "AVF_Other":
                    continue
                m = self.avf_type == t
                out[f"{metric}|{label}"] = ratio((val * kd)[m].sum(), kd[m].sum())
            out[f"{metric}|Full Stock"] = ratio((val * kda).sum(), kda.sum())
        bands = [("Very good", 90), ("Good", 80), ("Fair", 65), ("Poor", 40), ("Very poor", -np.inf)]
        taken = np.zeros(self.ns, bool)
        for name, lo in bands:
            hit = (ev["sci_av"] >= lo) & ~taken
            out[f"band|{name}"] = float(self.n_group[hit].sum())
            taken |= hit
        for t, label in groups:
            if t == "AVF_Other":
                continue
            m = self.avf_type == t
            out[f"sss|{label}"] = ratio((ev["sgr"] * kd)[m].sum(), kd[m].sum())
        out["sss|Full Stock"] = ratio((ev["sgr"] * kda).sum(), kda.sum())
        for t, label in groups:
            if t == "AVF_Other":
                continue
            out[f"at_risk|{label}"] = float(ev["at_risk"][self.avf_type == t].sum())
        out["at_risk|Stock"] = float(ev["at_risk"].sum())
        for lg, name in ((0.0, "0-10m"), (10.0001, "10-20m"), (20.0001, "20m+")):
            out[f"at_risk_len|{name}"] = float(ev["at_risk"][np.isclose(self.length_group, lg)].sum())
        for t, label in groups:
            if t == "AVF_Other":
                continue
            out[f"delay|{label}"] = float(ev["delay_cost"][self.avf_type == t].sum())
        out["delay|Stock"] = float(ev["delay_cost"].sum())
        out["_sci_av"] = ev["sci_av"]
        return out

    # ---------------------------------------------------------- long-term plan
    def run_long_term(self, draws: np.ndarray | None = None, overrides: dict | None = None,
                      condition_overrides: dict | None = None) -> "LongTermResult":
        """SAVI run_LAMPlan_NCycle: year 1..N then the workbank year N+1.

        overrides: {year: {"reject": [element index, ...], "force": [...]}}
        condition_overrides: {element index: condition code} applied at year 0 (e.g. a new inspection).
        """
        s = self.settings
        state = self.initial_state(draws)
        if condition_overrides:
            state = self._apply_condition(state, condition_overrides)
        disc_rates = self.rs["discount_rates"]

        def rate_for(y):
            for r in disc_rates.itertuples():
                if r.from_year <= y <= r.to_year:
                    return r.rate
            return 0.0

        rows, profile, works, carry, factor = [], [state["ecs"].copy()], [], 0.0, 1.0
        y0 = self.stock_metrics(self.evaluate(state["ecs"], state["precise"]))
        for k in list(y0):                      # SAVI's year-0 per-group risk cells read a blank header (D-013)
            if k.startswith(("at_risk|", "delay|")) and not k.endswith("|Stock"):
                y0[k] = 0.0
        for year in range(1, s.years + 2):
            last = year == s.years + 1
            user_budget = s.budget(year) if not last else 1e-10
            if last:
                carry = 1e9                                           # Ref98!O132 (workbank year)
            budget = user_budget + carry
            planned_cost = sum(c for (e, y), (c, _) in self.planned.items() if y == year) if not last else \
                sum(c for (e, y), (c, _) in self.planned.items() if y == year)
            routine = float(self.routine.get(year, 0.0))
            bf = max(budget / user_budget + 0.5, s.long_term_min_budget_factor)
            avail = budget - (planned_cost + routine)
            r = self._pass(state, year, avail, bf * avail, lambda seq, y=year: self.planned.get((seq, y)),
                           (overrides or {}).get(year))
            workbank = float(r["workbank_by_structure"].sum())
            if last:
                rows.append({"year": year, "workbank": workbank})
                break
            expenditure = float(r["DH"].sum())
            if year > 1:
                factor = factor / (1 + rate_for(year))
            # end-of-year condition
            keyJ = np.array([key(j) for j in r["J"]], dtype=object)
            ef = self._deteriorate(state, r["K"], keyJ)
            DN = r["DN"]
            after = np.where(r["M"] > 0, self.rule_after_ecs[np.maximum(r["M"] - 1, 0)], np.nan)
            plan_ecs = np.array([self.planned.get((int(sq), year), (0, 0))[1] for sq in self.seq])
            eg = np.where(state["precise"] == 0, 0.0,
                          np.where(DN == 3, plan_ecs, np.where(DN == 2, 1.0, np.where(DN == 1, after, ef))))
            rep, pos = self._snap(eg)
            ev = self.evaluate(rep, eg)
            stock = self.stock_metrics(ev)
            finite = self.life == "Finite"
            indef = self.life == "Indefinite"
            DY = r["DV"] + r["DW"] + r["DX"]
            row = {"year": year, "years": s.years, "start_budget": user_budget, "budget": budget,
                   "budget_factor": bf, "workbank": workbank, "expenditure": expenditure,
                   "discounted_expenditure": expenditure * factor, "planned": planned_cost,
                   "routine": routine, "carry_in": carry,
                   "remaining": budget - (expenditure + planned_cost + routine),
                   "ct_finite": float((r["DV"] + r["DW"])[finite].sum()),
                   "planned_finite": float(DY[finite].sum() - (r["DV"] + r["DW"])[finite].sum()),
                   "ct_indefinite": float((r["DV"] + r["DW"])[indef].sum()),
                   "planned_indefinite": float(DY[indef].sum() - (r["DV"] + r["DW"])[indef].sum()),
                   "condition_triggered": expenditure}
            row.update({k: v for k, v in stock.items() if not k.startswith("_")})
            rows.append(row)
            works.extend(self._work_items(year, r, state, eg))
            profile.append(rep.copy())
            carry = row["remaining"] if s.carry_forward_budget else 0.0
            state = {"pos": pos, "ecs": rep, "precise": eg}
        table = pd.DataFrame(rows[:-1])
        y0_row = {"year": 0}
        y0_row.update({k: v for k, v in y0.items() if not k.startswith("_")})
        return LongTermResult(self, pd.concat([pd.DataFrame([y0_row]), table], ignore_index=True),
                              rows[-1]["workbank"], np.vstack(profile).T, pd.DataFrame(works, columns=WORK_COLUMNS))

    def _apply_condition(self, state: dict, changes: dict) -> dict:
        st = {k: v.copy() for k, v in state.items()}
        for i, code in changes.items():
            p = self.code_pos[key(code)]
            st["pos"][i] = p
            st["ecs"][i] = self.ecs_list[p]
            nxt = self.ecs_list[16] if p == 16 else self.ecs_list[p + 1]
            st["precise"][i] = self.ecs_list[p] + 0.5 * (nxt - self.ecs_list[p])
        return st

    def _work_items(self, year, r, state, eg) -> list[dict]:
        out = []
        idx = np.where(r["DN"] > 0)[0]
        for i in idx:
            p = self.pos[i]
            dn = r["DN"][i]
            out.append({
                "year": year, "element_index": int(i), "element_seq": int(self.seq[i]),
                "structure_index": int(p), "structure_id": self.structures["structure_id"].iloc[p],
                "element_type": self.elements["element_type"].iloc[i],
                "material": self.elements["material"].iloc[i],
                "status": {1: "Maintain", 2: "Replace structure", 3: "Planned"}[int(dn)],
                "action": (self.rule_action_name[r["M"][i] - 1] if dn == 1 and r["M"][i] > 0
                           else "Structure replaced" if dn == 2 else "Planned work"),
                "condition_before": self.codes[state["pos"][i]] if state["pos"][i] >= 0 else "",
                "ecs_before": float(state["ecs"][i]), "ecs_after": float(eg[i]),
                "priority": float(r["Q"][i]), "structure_rank": int(r["rank"][p]),
                "cost": float(r["DV"][i] + r["DW"][i] + r["DX"][i]),
                "works_cost": float(r["U"][i]), "exposure": r["J"][i],
            })
        return out

    # ---------------------------------------------------------- uncertainty (forecasting tier 2)
    def run_uncertainty(self, runs: int = 20, seed: int = 0, spread: float = 0.2,
                        metrics: tuple[str, ...] = ("ssci_av|Full Stock", "ssci_crit|Full Stock", "expenditure",
                                                    "workbank", "at_risk|Stock")) -> dict:
        """Monte Carlo over SAMPT's uncertainty (Part A 2.13.7): time to failure uniform +/-20 %
        per element and a random start position inside each condition band. Planning only:
        never used for the WGA valuation. Returns P10/P50/P90 per metric per year."""
        rng = np.random.default_rng(seed)
        saved = self.ttf_factor
        series = {m: [] for m in metrics}
        try:
            for _ in range(runs):
                self.ttf_factor = rng.uniform(1 - spread, 1 + spread, self.ne)
                res = self.run_long_term(draws=rng.random(self.ne))
                for m in metrics:
                    series[m].append(res.table[m].to_numpy(dtype=float))
        finally:
            self.ttf_factor = saved
        years = list(range(len(series[metrics[0]][0])))
        out = {"runs": runs, "seed": seed, "spread": spread, "years": years}
        for m, vals in series.items():
            a = np.vstack(vals)
            out[m] = {q: np.nanpercentile(a, p, axis=0).tolist() for q, p in (("p10", 10), ("p50", 50), ("p90", 90))}
        return out

    # ---------------------------------------------------------- 5-year programme
    def run_five_year(self, draws: np.ndarray | None = None, overrides: dict | None = None,
                      condition_overrides: dict | None = None) -> "FiveYearResult":
        """SAVI Y5: one prioritisation against the 5-year budget pot, schemes scheduled into years."""
        s = self.settings
        state = self.initial_state(draws)
        if condition_overrides:
            state = self._apply_condition(state, condition_overrides)
        total = s.five_year_annual_budget * 5
        planned5 = {}
        for (e, y), v in self.planned.items():
            if y <= 5:
                c, ecs = planned5.get(e, (0.0, 0.0))
                planned5[e] = (c + v[0], v[1])
        planned_cost = sum(c for (e, y), (c, _) in self.planned.items() if y <= 5)
        routine = float(sum(self.routine.get(y, 0.0) for y in range(1, 6)))
        avail = total - (planned_cost + routine)
        r = self._pass(state, "y5", avail, s.five_year_budget_factor * avail,
                       lambda seq: planned5.get(seq), overrides)
        # scheduling (Y5!DK): cumulative scheme cost against fifths of the total budget
        cum = r["cum"]
        sched = np.where(cum <= total / 5, 1, np.where(cum <= 2 * total / 5, 2, np.where(
            cum <= 3 * total / 5, 3, np.where(cum <= 4 * total / 5, 4, np.where(cum <= total, 5, 6)))))
        sched = np.where(r["rank"] > 0, sched, 0)
        # condition after 5 years (Y5!EB:EE)
        pos_c, C, D = state["pos"], state["ecs"], state["precise"]
        keyJ = np.array([key(j) for j in r["J"]], dtype=object)
        det_k = np.array([self.det_index.get(f"{m}|{e}", -1) for m, e in zip(self.mat_key, keyJ)])
        S = np.where(pos_c >= 0, pos_c, 1)
        frac = np.where(det_k[:, None] >= 0, self.det_frac[np.maximum(det_k, 0)], np.nan)
        fa = np.take_along_axis(frac, np.minimum(S, 16)[:, None], 1)[:, 0]
        fb = np.where(S + 1 <= 16, np.take_along_axis(frac, np.minimum(S + 1, 16)[:, None], 1)[:, 0], np.nan)
        nxt = np.where(S + 1 <= 16, self.ecs_list[np.minimum(S + 1, 16)], np.nan)
        with np.errstate(divide="ignore", invalid="ignore"):
            EB = 5 * (nxt - C) / ((fb - fa) * r["K"])
        EB = np.where(np.isfinite(EB), EB, 0.0)
        EC = D + EB
        after = np.where(r["M"] > 0, self.rule_after_ecs[np.maximum(r["M"] - 1, 0)], np.nan)
        DN = r["DN"]
        # planned works do not reset condition in SAVI's Y5 (its lookup references a deleted range; D-012)
        ED = np.where(D == 0, 0.0, np.where(DN == 2, 1.0, np.where(DN == 1, after, EC)))
        rep, pos = self._snap(ED)
        ev = self.evaluate(rep, ED)
        stock = self.stock_metrics(ev)
        finite, indef = self.life == "Finite", self.life == "Indefinite"
        expenditure = float(r["DV"].sum() + r["DW"].sum())
        summary = {"annual_budget": s.five_year_annual_budget, "total_budget": total,
                   "budget_factor": s.five_year_budget_factor, "expenditure": expenditure,
                   "planned": planned_cost, "routine": routine,
                   "remaining": total - (expenditure + planned_cost + routine),
                   "ct_finite": float((r["DV"] + r["DW"])[finite].sum()),
                   "ct_indefinite": float((r["DV"] + r["DW"])[indef].sum()),
                   "schemes_funded": int((r["DG"] > 0).sum()),
                   "elements_maintained": int((DN == 1).sum())}
        summary.update({k: v for k, v in stock.items() if not k.startswith("_")})
        items = self._work_items(0, r, state, ED)
        for it in items:
            it["year"] = int(sched[it["structure_index"]])
        return FiveYearResult(self, summary, r, sched, pd.DataFrame(items, columns=WORK_COLUMNS), rep, ED, ev)


# ------------------------------------------------------------------ results
@dataclass
class LongTermResult:
    model: PlanningModel
    table: pd.DataFrame            # year 0..N, one row per year (LAMP Results)
    workbank_end: float            # cost of all outstanding needs after year N
    ecs_profile: np.ndarray        # elements x (N+1) reported ECS
    works: pd.DataFrame            # forward work plan: one row per element treated per year

    def totals(self) -> dict:
        t = self.table[self.table["year"] > 0]
        return {"years": int(t["year"].max()), "total_budget": float(t["start_budget"].sum()),
                "expenditure": float(t["expenditure"].sum()),
                "discounted_expenditure": float(t["discounted_expenditure"].sum()),
                "planned": float(t["planned"].sum()), "routine": float(t["routine"].sum()),
                "workbank_end": self.workbank_end,
                "ssci_av_end": float(t["ssci_av|Full Stock"].iloc[-1]),
                "ssci_crit_end": float(t["ssci_crit|Full Stock"].iloc[-1])}


@dataclass
class FiveYearResult:
    model: PlanningModel
    summary: dict
    detail: dict
    schedule: np.ndarray           # planned year (1..5, 6 = beyond) per structure
    works: pd.DataFrame
    reported_ecs: np.ndarray
    precise_ecs: np.ndarray
    evaluation: dict

    def projects(self) -> pd.DataFrame:
        """SAVI Project List: funded structures in priority order with their year and cost."""
        m = self.model
        d = self.detail
        idx = np.where(d["DG"] > 0)[0]
        df = pd.DataFrame({
            "rank": d["rank"][idx], "year": self.schedule[idx],
            "structure_id": m.structures["structure_id"].iloc[idx].values,
            "structure_name": m.structures["name"].iloc[idx].values,
            "structure_type": m.structures["structure_type"].iloc[idx].values,
            "priority_score": d["CF"][idx],
            "action": np.where(d["DG"][idx] == 2, "Replace", "Maintain"),
            "cost": d["DH"][idx]})
        return df.sort_values("rank").reset_index(drop=True)


# SAVI 'LAMP Results' column letter -> LongTermResult.table column
LAMP_COLUMNS = {
    "C": "start_budget", "D": "budget", "E": "budget_factor", "F": "workbank", "G": "expenditure",
    "H": "discounted_expenditure", "I": "planned", "J": "routine", "K": "carry_in", "L": "remaining",
    "M": "ct_finite", "N": "planned_finite", "O": "ct_indefinite", "P": "planned_indefinite",
    "Q": "condition_triggered",
    "R": "ssci_av|Bridges", "S": "ssci_av|Retaining Walls", "T": "ssci_av|Culverts",
    "U": "ssci_av|Sign/Signal Gantries", "V": "ssci_av|High Mast Lighting",
    "W": "ssci_av|Tunnels and Vehicular Underpasses", "X": "ssci_av|Full Stock",
    "Y": "ssci_crit|Bridges", "Z": "ssci_crit|Retaining Walls", "AA": "ssci_crit|Culverts",
    "AB": "ssci_crit|Sign/Signal Gantries", "AC": "ssci_crit|High Mast Lighting",
    "AD": "ssci_crit|Tunnels and Vehicular Underpasses", "AE": "ssci_crit|Full Stock",
    "AF": "band|Very good", "AG": "band|Good", "AH": "band|Fair", "AI": "band|Poor", "AJ": "band|Very poor",
    "AK": "sss|Bridges", "AL": "sss|Retaining Walls", "AM": "sss|Culverts", "AN": "sss|Sign/Signal Gantries",
    "AO": "sss|High Mast Lighting", "AP": "sss|Tunnels and Vehicular Underpasses", "AQ": "sss|Full Stock",
    "AR": "at_risk|Bridges", "AS": "at_risk|Retaining Walls", "AT": "at_risk|Culverts",
    "AU": "at_risk|Sign/Signal Gantries", "AV": "at_risk|High Mast Lighting",
    "AW": "at_risk|Tunnels and Vehicular Underpasses", "AX": "at_risk|Stock",
    "AY": "at_risk_len|0-10m", "AZ": "at_risk_len|10-20m", "BA": "at_risk_len|20m+",
    "BB": "delay|Bridges", "BC": "delay|Retaining Walls", "BD": "delay|Culverts",
    "BE": "delay|Sign/Signal Gantries", "BF": "delay|High Mast Lighting",
    "BG": "delay|Tunnels and Vehicular Underpasses", "BH": "delay|Stock",
}
