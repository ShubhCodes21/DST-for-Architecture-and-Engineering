"""Input data validation (QA family 1).

Blocking errors mirror SAVI v1.10's CHECK columns (Structures!BH:BU, Elements!AG:AN),
so a file SAVI calls "Valid" is valid here too. They are expressed as Pandera schemas
built from the rule set, so allowed values always come from the versioned tables.

Non-blocking warnings report data quality issues that SAVI tolerates (e.g. inconsistent
capitalisation, which Excel's case-insensitive lookups hide).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import pandas as pd
import pandera.pandas as pa

from .ruleset import RuleSet, key

# Structure types exempt from individual dimension checks (SAVI Structures!BK:BQ).
_NO_LENGTH = {"Cantilever Road Sign", "High Mast Lighting"}
_NO_WIDTH = _NO_LENGTH | {"Retaining Wall (height > 3m)", "Retaining Wall (height ≤ 3m)"}
_EARTHWORKS = {"Structural Earthworks - Reinforced/Strengthened Soil/Fill Structure (height > 3m)",
               "Structural Earthworks - Reinforced/Strengthened Soil/Fill Structure (height ≤ 3m)"}
_GANTRIES = {"Sign/Signal Gantry (cantilever)", "Sign/Signal Gantry (spanning)"}
_NO_HEADROOM = _NO_LENGTH | _EARTHWORKS
_NO_SPANS = _NO_WIDTH | _GANTRIES | _EARTHWORKS
_NO_OBSTACLE = _NO_LENGTH | _GANTRIES
_NO_SPRAY = {"Chamber/Cellar/Vault"}
_RULE_FIELDS = {"S03_length": "length_m", "S04_width": "width_m", "S05_headroom": "headroom_m",
                "S06_spans": "spans", "S08_route": "route_supported", "S09_obstacle": "obstacle_crossed",
                "S11_adjustment_flags": "adj_*", "E02_element_allowed": "element_type",
                "E03_material_allowed": "material", "E04_spray_proximity": "spray_proximity"}
_ADJ_FLAGS = ["adj_heritage", "adj_conservation_area", "adj_environmentally_sensitive", "adj_river_coastal_wall",
              "adj_substandard", "adj_spare_1", "adj_spare_2", "adj_spare_3", "adj_spare_4", "adj_spare_5",
              "adj_spare_6"]


@dataclass
class Issue:
    table: str
    row: int                 # 0-based row position in the uploaded table
    record_id: str
    field: str
    rule: str
    message: str
    severity: str            # "error" blocks a run; "warning" does not

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class ValidationReport:
    issues: list[Issue]

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "warning"]

    @property
    def is_valid(self) -> bool:
        return not self.errors

    def to_frame(self) -> pd.DataFrame:
        cols = ["table", "row", "record_id", "field", "rule", "message", "severity"]
        return pd.DataFrame([i.as_dict() for i in self.issues], columns=cols)

    def summary(self) -> dict:
        df = self.to_frame()
        by_rule = df.groupby(["severity", "rule"]).size().to_dict() if len(df) else {}
        return {"valid": self.is_valid, "errors": len(self.errors), "warnings": len(self.warnings),
                "by_rule": {f"{s}:{r}": int(n) for (s, r), n in by_rule.items()}}


# ---------------------------------------------------------------------------------------
def _isin_ci(allowed) -> callable:
    allowed = {key(a) for a in allowed}
    return lambda s: s.map(key).isin(allowed)


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce").fillna(0.0)


def _col(d: pd.DataFrame, c: str) -> pd.Series:
    """A column, or an all-blank one if it is missing (the missing column is reported separately)."""
    return d[c] if c in d.columns else pd.Series([None] * len(d), index=d.index, dtype=object)


def _type_in(df: pd.DataFrame, names: set[str]) -> pd.Series:
    return df["structure_type"].map(key).isin({key(n) for n in names})


def structure_schema(rs: RuleSet) -> pa.DataFrameSchema:
    """Pandera schema for the Structures table (SAVI Structures!BH:BT)."""
    def present(s):
        return s.notna() & (s.astype(str).str.strip() != "")

    return pa.DataFrameSchema(
        columns={
            "structure_id": pa.Column(nullable=False, unique=True, checks=[
                pa.Check(present, element_wise=False, name="S00_id_present",
                         error="Structure identifier is required")]),
            "structure_type": pa.Column(nullable=True, checks=[
                pa.Check(_isin_ci(rs["structure_types"]["structure_type"]), name="S01_structure_type",
                         error="Structure type is not one of the SAMPT/SAVI types")]),
            "number_in_group": pa.Column(nullable=True, checks=[
                pa.Check(lambda s: _num(s) >= 1, name="S02_number_in_group",
                         error="Number of structures in the group must be at least 1")]),
            "location": pa.Column(nullable=True, checks=[
                pa.Check(_isin_ci(rs["locations"]["location"]), name="S07_location",
                         error="Location must be Urban, Rural or Marine/Estuarial")]),
            "traffic": pa.Column(nullable=True, checks=[
                pa.Check(_isin_ci(rs["traffic"]["traffic"]), name="S10_traffic",
                         error="Traffic must be High, Moderate or Low")]),
        },
        checks=[
            pa.Check(lambda d: _type_in(d, _NO_LENGTH) | (_num(_col(d, "length_m")) > 0), name="S03_length",
                     error="Length must be greater than 0 for this structure type"),
            pa.Check(lambda d: _type_in(d, _NO_WIDTH) | (_num(_col(d, "width_m")) > 0), name="S04_width",
                     error="Average width must be greater than 0 for this structure type"),
            pa.Check(lambda d: _type_in(d, _NO_HEADROOM) | (_num(_col(d, "headroom_m")) > 0), name="S05_headroom",
                     error="Headroom/height must be greater than 0 for this structure type"),
            pa.Check(lambda d: _type_in(d, _NO_SPANS) | (_num(_col(d, "spans")) > 0), name="S06_spans",
                     error="Number of spans must be greater than 0 for this structure type"),
            pa.Check(lambda d: _num(_col(d, "route_salted")).isin([0, 1]) &
                     _isin_ci(rs["routes"]["route"])(_col(d, "route_supported")), name="S08_route",
                     error="Route supported must be a listed route type and 'salted' must be 0 or 1"),
            pa.Check(lambda d: _num(_col(d, "obstacle_salted")).isin([0, 1]) &
                     (_type_in(d, _NO_OBSTACLE) | _isin_ci(rs["obstacles"]["obstacle"])(_col(d, "obstacle_crossed"))),
                     name="S09_obstacle",
                     error="Obstacle crossed must be a listed obstacle and 'salted' must be 0 or 1"),
            pa.Check(lambda d: d.reindex(columns=_ADJ_FLAGS).apply(
                lambda s: s.isna() | _num(s).isin([0, 1])).all(axis=1), name="S11_adjustment_flags",
                error="GRC adjustment flags must be 0, 1 or blank"),
        ],
        strict=False,
    )


def element_schema(rs: RuleSet, structures: pd.DataFrame) -> pa.DataFrameSchema:
    """Pandera schema for the Elements table (SAVI Elements!AG:AN), with cross-table checks."""
    sid_counts = structures["structure_id"].map(key).value_counts()
    stype = dict(zip(structures["structure_id"].map(key), structures["structure_type"].map(key)))
    allowed_el, allowed_mat = rs.allowed_elements, rs.allowed_materials

    def known_structure(s):
        return s.map(key).map(sid_counts).fillna(0).eq(1)

    def element_allowed(d):
        pairs = zip(d["structure_id"].map(key).map(stype), d["element_type"].map(key))
        ok = [(t, e) in allowed_el if t is not None and e else True for t, e in pairs]
        return pd.Series(ok, index=d.index) | ~known_structure(d["structure_id"])

    def material_allowed(d):
        pairs = zip(d["element_type"].map(key), d["material"].map(key))
        return pd.Series([bool(m) and (e, m) in allowed_mat for e, m in pairs], index=d.index)

    def spray_ok(d):
        exempt = d["structure_id"].map(key).map(stype).isin({key(t) for t in _NO_SPRAY})
        return exempt | d["element_type"].isna() | _isin_ci(rs["spray_proximity"]["spray_proximity"])(
            d["spray_proximity"])

    return pa.DataFrameSchema(
        columns={
            "structure_id": pa.Column(nullable=True, checks=[
                pa.Check(known_structure, name="E01_structure_known",
                         error="The structure or group of structures is not recognised")]),
            "condition_code": pa.Column(nullable=True, checks=[
                pa.Check(_isin_ci(rs["condition_codes"]["code"]), name="E05_condition",
                         error="Condition must be a severity/extent code such as 1A, 2B ... 5E")]),
        },
        checks=[
            pa.Check(element_allowed, name="E02_element_allowed",
                     error="The element is not recognised for this structure type"),
            pa.Check(material_allowed, name="E03_material_allowed",
                     error="The component/material type is missing or not allowed for this element"),
            pa.Check(spray_ok, name="E04_spray_proximity",
                     error="Proximity to traffic spray zone is not recognised"),
        ],
        strict=False,
    )


def _issues_from(err: pa.errors.SchemaErrors, table: str, df: pd.DataFrame, id_col: str) -> list[Issue]:
    out = []
    fc = err.failure_cases
    for r in fc.itertuples(index=False):
        idx = r.index
        if idx is None or (isinstance(idx, float) and pd.isna(idx)):
            # A schema-level problem (e.g. a missing column) with no row attached.
            out.append(Issue(table, -1, "", str(r.column or ""), str(r.check), str(r.failure_case), "error"))
            continue
        check = str(r.check)
        rule, message = check, check
        for schema_check in _all_checks(err):
            if check in (schema_check.name, schema_check.error):
                rule, message = schema_check.name, schema_check.error or check
        field = str(r.column) if r.schema_context == "Column" else _RULE_FIELDS.get(rule, "")
        if check in ("column_in_dataframe", "field_uniqueness") or check.startswith("not_nullable"):
            rule = {"field_uniqueness": "X01_unique", "column_in_dataframe": "X00_column_missing"}.get(
                check, "X02_not_null")
            message = f"{check}: {r.failure_case}"
        pos = df.index.get_loc(idx) if idx in df.index else -1
        rid = str(df.iloc[pos][id_col]) if pos >= 0 and id_col in df.columns else ""
        out.append(Issue(table, int(pos), rid, field, rule, message, "error"))
    return out


def _all_checks(err) -> list:
    schema = err.schema
    checks = list(schema.checks)
    for c in schema.columns.values():
        checks += list(c.checks)
    return checks


def _validate(schema: pa.DataFrameSchema, df: pd.DataFrame, table: str, id_col: str) -> list[Issue]:
    try:
        schema.validate(df, lazy=True)
        return []
    except pa.errors.SchemaErrors as e:
        issues = _issues_from(e, table, df, id_col)
        # De-duplicate (pandera may report one failure per column for wide checks).
        seen, uniq = set(), []
        for i in issues:
            k = (i.table, i.row, i.rule)
            if k not in seen:
                seen.add(k)
                uniq.append(i)
        return uniq


def quality_warnings(structures: pd.DataFrame, elements: pd.DataFrame, rs: RuleSet) -> list[Issue]:
    """Non-blocking checks: things SAVI accepts but a data owner should fix."""
    out: list[Issue] = []
    canon = {
        ("structures", "structure_type"): rs["structure_types"]["structure_type"],
        ("structures", "route_supported"): rs["routes"]["route"],
        ("structures", "obstacle_crossed"): rs["obstacles"]["obstacle"],
        ("structures", "location"): rs["locations"]["location"],
        ("structures", "traffic"): rs["traffic"]["traffic"],
        ("elements", "element_type"): rs["element_types"]["element_type"],
        ("elements", "material"): rs["materials"]["material"],
    }
    tables = {"structures": (structures, "structure_id"), "elements": (elements, "element_seq")}
    for (tname, col), values in canon.items():
        df, idc = tables[tname]
        if col not in df.columns or idc not in df.columns:
            continue
        exact = set(values)
        by_key = {key(v): v for v in values}
        for pos, v in enumerate(df[col]):
            if isinstance(v, str) and v not in exact and key(v) in by_key:
                out.append(Issue(tname, pos, str(df.iloc[pos][idc]), col, "W01_case_variant",
                                 f"'{v}' matches '{by_key[key(v)]}' only when case is ignored", "warning"))
    for pos, v in enumerate(elements.get("material", pd.Series(dtype=object))):
        if isinstance(v, str) and v.lower().startswith("other/unknown"):
            out.append(Issue("elements", pos, str(elements.iloc[pos]["element_seq"]), "material",
                             "W02_unknown_material", "Generic deterioration profile used (material unknown)",
                             "warning"))
    for pos, r in enumerate(structures.itertuples(index=False)):
        for col in ("width_m", "headroom_m", "spans"):
            v = getattr(r, col, 0)
            if v is None or (isinstance(v, float) and pd.isna(v)):
                out.append(Issue("structures", pos, str(r.structure_id), col, "W03_blank_dimension",
                                 f"{col} is blank (not required for this structure type)", "warning"))
    no_el = set(structures["structure_id"].map(key)) - set(elements["structure_id"].map(key))
    for pos, sid in enumerate(structures["structure_id"]):
        if key(sid) in no_el:
            out.append(Issue("structures", pos, str(sid), "", "S12_no_elements",
                             "Structure has no elements", "error"))
    return out


def validate_inventory(structures: pd.DataFrame, elements: pd.DataFrame, rs: RuleSet) -> ValidationReport:
    issues = _validate(structure_schema(rs), structures, "structures", "structure_id")
    issues += _validate(element_schema(rs, structures), elements, "elements", "element_seq")
    issues += quality_warnings(structures, elements, rs)
    return ValidationReport(issues)
