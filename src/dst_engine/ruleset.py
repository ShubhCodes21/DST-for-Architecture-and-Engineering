"""Versioned rule sets: the SAMPT Part C / SAVI reference tables as data.

A rule set is a directory of Parquet tables plus a ``manifest.json`` that records
the SHA-256 of every table. Loading verifies the hashes, so a run can always state
exactly which rules produced it.

Lookups follow Excel semantics because SAVI is the regression reference:
text matching is case-insensitive (Excel's MATCH/SUMIF/COUNTIF ignore case).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

import pandas as pd

DEFAULT_RULESET = Path(__file__).resolve().parents[2] / "rulesets" / "savi-1.10"


def key(v) -> str:
    """Normalise a text key the way Excel compares text: case-insensitively."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    return str(v).casefold()


class RuleSetIntegrityError(RuntimeError):
    pass


@dataclass
class RuleSet:
    name: str
    tables: dict[str, pd.DataFrame]
    manifest: dict = field(default_factory=dict)
    cache: dict = field(default_factory=dict, repr=False)   # derived lookup structures

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, path: str | Path = DEFAULT_RULESET, verify: bool = True) -> "RuleSet":
        path = Path(path)
        manifest = json.loads((path / "manifest.json").read_text())
        tables = {}
        for fname, digest in manifest["files"].items():
            fpath = path / fname
            if verify:
                actual = hashlib.sha256(fpath.read_bytes()).hexdigest()
                if actual != digest:
                    raise RuleSetIntegrityError(f"{fname}: hash {actual[:12]} != manifest {digest[:12]}")
            tables[fpath.stem] = pd.read_parquet(fpath)
        return cls(manifest.get("ruleset", path.name), tables, manifest)

    def __getitem__(self, name: str) -> pd.DataFrame:
        return self.tables[name]

    # ------------------------------------------------------------- constants
    @cached_property
    def constants(self) -> dict[str, float]:
        c = self["constants"]
        return dict(zip(c["name"], c["value"].astype(float)))

    @cached_property
    def priority_weights(self) -> dict[str, float]:
        p = self["priority_weights"]
        return dict(zip(p["name"], p["value"].astype(float)))

    # ------------------------------------------------------------- lookups
    @cached_property
    def condition(self) -> pd.DataFrame:
        """Condition codes indexed by normalised code, in severity order."""
        df = self["condition_codes"].copy()
        df["order"] = range(len(df))
        df.index = df["code"].map(key)
        return df

    @cached_property
    def element_types(self) -> pd.DataFrame:
        df = self["element_types"].copy()
        df.index = df["element_type"].map(key)
        return df

    @cached_property
    def structure_types(self) -> pd.DataFrame:
        df = self["structure_types"].copy()
        df.index = df["structure_type"].map(key)
        return df

    @cached_property
    def materials(self) -> pd.DataFrame:
        df = self["materials"].copy()
        df.index = df["material"].map(key)
        return df

    @cached_property
    def routes(self) -> pd.DataFrame:
        df = self["routes"].copy()
        df.index = df["route"].map(key)
        return df

    @cached_property
    def obstacles(self) -> pd.DataFrame:
        df = self["obstacles"].copy()
        df.index = df["obstacle"].map(key)
        return df

    @cached_property
    def traffic(self) -> pd.DataFrame:
        df = self["traffic"].copy()
        df.index = df["traffic"].map(key)
        return df

    @cached_property
    def locations(self) -> pd.DataFrame:
        df = self["locations"].copy()
        df.index = df["location"].map(key)
        return df

    @cached_property
    def spray(self) -> pd.DataFrame:
        df = self["spray_proximity"].copy()
        df.index = df["spray_proximity"].map(key)
        return df

    @cached_property
    def deterioration(self) -> pd.DataFrame:
        df = self["deterioration"].copy()
        df.index = (df["material"].map(key) + "|" + df["exposure"].map(key))
        return df

    @cached_property
    def intervention_user_5b(self) -> dict[str, int]:
        """Key '5B|material|exposure' (user-defined strategy column) -> 1-based rule row.

        SAVI's valuation looks for the intervention triggered at failure (5B) in the
        user-defined strategy column (Ref06 col P key = trigger_user & material & exposure).
        First match wins, as with Excel MATCH.
        """
        r = self["intervention_rules"]
        out: dict[str, int] = {}
        keys = r["trigger_user"].map(key) + "|" + r["material"].map(key) + "|" + r["exposure"].map(key)
        for i, k in enumerate(keys, start=1):
            out.setdefault(k, i)
        return out

    @cached_property
    def maintenance_actions(self) -> pd.DataFrame:
        df = self["maintenance_actions"].copy()
        df.index = df["action"].map(key)
        return df

    @cached_property
    def avf(self) -> pd.DataFrame:
        return self["avf_factors"].set_index("avf_type")

    @cached_property
    def adjustment_factors(self) -> dict[str, float]:
        a = self["adjustment_factors"]
        return dict(zip(a["column"], a["factor"].astype(float)))

    @cached_property
    def allowed_elements(self) -> set[tuple[str, str]]:
        s = self["structure_elements"]
        return set(zip(s["structure_type"].map(key), s["element_type"].map(key)))

    @cached_property
    def allowed_materials(self) -> set[tuple[str, str]]:
        s = self["element_materials"]
        return set(zip(s["element_type"].map(key), s["material"].map(key)))

    @cached_property
    def exposure_rules(self) -> dict[int, str]:
        r = self["exposure_rules"]
        return dict(zip(r["exposure_id"].astype("int64"), r["exposure"]))

    def addon_factor(self, kind: str, amount: float) -> float:
        """Excel LOOKUP on ascending thresholds: factor of the largest threshold <= amount."""
        b = self["addon_bands"]
        b = b[b["kind"] == kind].sort_values("threshold")
        ok = b[b["threshold"] <= amount]
        if ok.empty:
            return float("nan")
        return float(ok["factor"].iloc[-1])
