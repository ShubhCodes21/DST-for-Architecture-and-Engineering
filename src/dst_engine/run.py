"""Run the year-0 engine: GRC, condition indices and the WGA valuation (GRC, DRC, depreciation)."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import __version__
from .condition import AVF_GROUPS, element_condition, stock_condition, structure_condition
from .grc import compute_grc
from .inventory import Inventory
from .ruleset import RuleSet, key
from .valuation import element_valuation, structure_valuation

# SAVI shortens two structure-type names in its valuation tables (Value!BX).
_TYPE_LABELS = {
    key("Structural Earthworks - Reinforced/Strengthened Soil/Fill Structure (height > 3m)"):
        "Structural Earthworks (height > 3m)",
    key("Structural Earthworks - Reinforced/Strengthened Soil/Fill Structure (height ≤ 3m)"):
        "Structural Earthworks (height ≤ 3m)",
}


@dataclass
class ValuationRun:
    structures: pd.DataFrame
    elements: pd.DataFrame
    summary: dict
    lineage: dict = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps({"lineage": self.lineage, "summary": self.summary}, indent=2, default=float)


def inventory_fingerprint(inv: Inventory) -> str:
    h = hashlib.sha256()
    for df in (inv.structures, inv.elements):
        h.update(pd.util.hash_pandas_object(df.astype(str), index=False).values.tobytes())
    h.update(json.dumps(inv.settings, sort_keys=True, default=str).encode())
    return h.hexdigest()


def attach_structure_positions(structures: pd.DataFrame, elements: pd.DataFrame) -> pd.DataFrame:
    """Position of each element's structure (first match, case-insensitive, as Excel MATCH); -1 if none."""
    first: dict[str, int] = {}
    for i, sid in enumerate(structures["structure_id"].map(key)):
        first.setdefault(sid, i)
    out = elements.copy()
    out["structure_pos"] = out["structure_id"].map(key).map(first).fillna(-1).astype(int)
    return out


def run_valuation(inv: Inventory, rs: RuleSet) -> ValuationRun:
    structures = inv.structures.reset_index(drop=True)
    elements = attach_structure_positions(structures, inv.elements.reset_index(drop=True))

    sizing = compute_grc(structures, rs, inv.authority_type)
    econd = element_condition(elements, rs)
    scond = structure_condition(structures, elements, econd, sizing, rs)
    evalu = element_valuation(elements, structures, sizing, econd["ecs"].to_numpy(), rs)
    sval, eval2 = structure_valuation(elements, evalu, sizing, len(structures))

    st = pd.concat([structures, sizing, scond, sval], axis=1)
    el = pd.concat([elements, econd, evalu, eval2], axis=1)
    summary = summarise(st, el, rs)
    lineage = {
        "engine_version": __version__,
        "ruleset": rs.name,
        "ruleset_source_sha256": rs.manifest.get("source_sha256"),
        "price_year": rs.manifest.get("price_year"),
        "authority_type": inv.authority_type,
        "inventory_sha256": inventory_fingerprint(inv),
        "settings": {"strategy": "WGA valuation (Technical Note: default tables, mean deterioration, "
                                 "unconstrained budget, intervention at failure, no planned works)"},
    }
    return ValuationRun(st, el, summary, lineage)


def summarise(st: pd.DataFrame, el: pd.DataFrame, rs: RuleSet) -> dict:
    n = pd.to_numeric(st["number_in_group"], errors="coerce").fillna(0.0)
    grc, drc = st["grc"].fillna(0.0), st["drc"].fillna(0.0)
    by_group = {}
    for avf_type in AVF_GROUPS:
        m = st["avf_type"] == avf_type
        by_group[avf_type] = {"structures": float(n[m].sum()), "grc": float(grc[m].sum()),
                              "drc": float(drc[m].sum()), "depreciation": float((grc - drc)[m].sum())}
    by_type = {}
    tkey = st["structure_type"].map(key)
    for t in rs["structure_types"]["structure_type"]:
        m = tkey == key(t)
        label = _TYPE_LABELS.get(key(t), t)
        by_type[label] = {"structures": float(n[m].sum()), "grc": float(grc[m].sum()), "drc": float(drc[m].sum())}

    stock = stock_condition(st, st, st, rs)
    total_grc = float(grc.sum())
    total_drc = float(drc.sum())
    return {
        "n_structure_records": int(len(st)),
        "n_structures": float(n.sum()),
        "n_elements": int(len(el)),
        "valuation": {
            "grc": total_grc,
            "drc": total_drc,
            "accumulated_depreciation": total_grc - total_drc,
            "annual_depreciation": float(st["annual_depreciation"].sum()),
            "drc_pct_of_grc": total_drc / total_grc if total_grc else 0.0,
            "price_year": rs.manifest.get("price_year"),
            "by_avf_group": by_group,
            "by_structure_type": by_type,
        },
        "condition_y0": stock,
        "diagnostics": {
            "elements_with_valuation_error": int(el["valuation_error"].sum()),
            "elements_excluded_from_valuation": int((el["rule_row"] < 0).sum()),
            "structures_unknown_type": int((~st["structure_type_known"]).sum()),
            "elements_without_structure": int((el["structure_pos"] < 0).sum()),
        },
    }
