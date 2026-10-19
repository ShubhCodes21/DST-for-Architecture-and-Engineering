"""Gross Replacement Cost (SAMPT Part A eq. 12; SAVI Structures!AH:BC).

    GRC = key dimension x unit rate x product of applicable adjustment factors
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .ruleset import RuleSet, key

_TUNNELS = {key("Tunnel (bored)"), key("Tunnel (cut and cover)")}
_RAILWAYS = {key("Railway: Freight"), key("Railway: Inter-City Line"),
             key("Railway: Suburban, Tram, Underground")}
_TENANTED = {key("Business and Community Premises"), key("Residential Premises")}

USER_ADJUSTMENT_COLUMNS = [
    "adj_heritage", "adj_conservation_area", "adj_environmentally_sensitive", "adj_river_coastal_wall",
    "adj_substandard", "adj_spare_1", "adj_spare_2", "adj_spare_3", "adj_spare_4", "adj_spare_5", "adj_spare_6",
]


def _num(s: pd.Series) -> pd.Series:
    """Excel arithmetic on a blank cell treats it as 0."""
    return pd.to_numeric(s, errors="coerce").fillna(0.0)


def derived_adjustment_flags(structures: pd.DataFrame) -> pd.DataFrame:
    """The eight adjustment flags SAVI derives from inventory fields (Structures!AH:AO)."""
    t = structures["structure_type"].map(key)
    loc = structures["location"].map(key)
    route = structures["route_supported"].map(key)
    obs = structures["obstacle_crossed"].map(key)
    length = _num(structures["length_m"])
    return pd.DataFrame({
        "adj_tunnel_over_400m": (t.isin(_TUNNELS) & (length > 400)).astype(int),
        "adj_rural": (loc == key("Rural")).astype(int),
        "adj_route_unclassified": (route == key("Local Road - unclassified")).astype(int),
        "adj_obstacle_footway": (obs == key("Footway/cycleway")).astype(int),
        "adj_obstacle_watercourse_non_nav": (obs == key("Watercourse - non-navigable")).astype(int),
        "adj_obstacle_land_disused": (obs == key("Land/Disused")).astype(int),
        "adj_obstacle_railway": obs.isin(_RAILWAYS).astype(int),
        "adj_obstacle_tenanted_business": obs.isin(_TENANTED).astype(int),
    }, index=structures.index)


def compute_grc(structures: pd.DataFrame, rs: RuleSet, authority_type: str) -> pd.DataFrame:
    """Per-structure sizing, GRC and asset-value-factor (AVF) fields."""
    st = rs.structure_types
    tkey = structures["structure_type"].map(key)
    known = tkey.isin(st.index)
    row = st.reindex(tkey.where(known))
    row.index = structures.index

    number = _num(structures["number_in_group"])
    length = _num(structures["length_m"])
    width = _num(structures["width_m"])
    headroom = _num(structures["headroom_m"])

    out = pd.DataFrame(index=structures.index)
    out["structure_type_known"] = known
    out["size_number"] = row["grc_f_number"].fillna(0).values * number
    out["size_length"] = row["grc_f_length"].fillna(0).values * length
    out["size_width"] = row["grc_f_width"].fillna(0).values * width
    out["size_headroom"] = row["grc_f_headroom"].fillna(0).values * headroom
    dims = out[["size_number", "size_length", "size_width", "size_headroom"]].to_numpy()
    # SAVI: IF(x=0,1,x) for each dimension, multiplied together.
    out["key_dimension"] = np.where(dims == 0, 1.0, dims).prod(axis=1)
    out["grc_unit_rate"] = row["grc_unit_rate"].astype(float).values
    out["basic_grc"] = out["grc_unit_rate"] * out["key_dimension"]

    flags = pd.concat([structures.reindex(columns=USER_ADJUSTMENT_COLUMNS).apply(_num),
                       derived_adjustment_flags(structures)], axis=1)
    factors = rs.adjustment_factors
    uplift = np.ones(len(structures))
    for c in flags.columns:
        f = flags[c].to_numpy(dtype=float)
        # SAVI: IF(flag=0, 1, flag * factor)
        uplift *= np.where(f == 0, 1.0, f * factors[c])
    for c in flags.columns:
        out[c] = flags[c].values
    out["grc_uplift"] = uplift
    out["grc"] = out["basic_grc"] * out["grc_uplift"]

    out["avf_type"] = row["avf_type"].values
    avf_col = authority_type if authority_type in rs.avf.columns else "Local Authority"
    out["avf"] = out["avf_type"].map(rs.avf[avf_col]).astype(float).fillna(0.0)
    out["key_dimension_x_avf"] = out["key_dimension"] * out["avf"]
    out["stf"] = row["stf"].astype(float).values
    out["tm_required"] = row["tm_required"].fillna(0).astype(float).values
    return out
