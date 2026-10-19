"""QA family 1b - input data accuracy (Pandera schemas mirroring SAVI's CHECK columns)."""
from __future__ import annotations

import pandas as pd
import pytest

from dst_engine.validation import validate_inventory


def _rules(report, severity="error"):
    return {i.rule for i in report.issues if i.severity == severity}


def test_golden_inventory_is_valid(golden_inventory, rs):
    """SAVI marks every one of the 652 + 8,692 rows 'Valid'; so must we."""
    rep = validate_inventory(golden_inventory.structures, golden_inventory.elements, rs)
    assert rep.is_valid, rep.to_frame().query("severity == 'error'").head(20)


def test_validation_agrees_with_savi_check_columns(golden_inventory, rs, expected_structures, expected_elements):
    assert set(expected_structures["check_total"]) == {"Valid"}
    assert set(expected_elements["check_inventory"]) == {"Valid"}
    assert set(expected_elements["check_condition"]) == {"Valid"}


STRUCTURE_FAULTS = [
    ("structure_type", "Bridge: Flying", "S01_structure_type"),
    ("number_in_group", 0, "S02_number_in_group"),
    ("length_m", 0, "S03_length"),
    ("width_m", None, "S04_width"),
    ("headroom_m", -1, "S05_headroom"),
    ("spans", 0, "S06_spans"),
    ("location", "Lunar", "S07_location"),
    ("route_supported", "Canal towpath", "S08_route"),
    ("route_salted", 2, "S08_route"),
    ("obstacle_crossed", "Lava", "S09_obstacle"),
    ("traffic", "Gridlock", "S10_traffic"),
    ("adj_heritage", 3, "S11_adjustment_flags"),
]


@pytest.mark.parametrize("column,value,rule", STRUCTURE_FAULTS)
def test_each_structure_rule_fires(golden_inventory, rs, column, value, rule):
    s = golden_inventory.structures.copy()
    s[column] = s[column].astype(object)
    s.loc[1, column] = value                      # ST02, a single-span vehicular bridge
    rep = validate_inventory(s, golden_inventory.elements, rs)
    hits = [i for i in rep.errors if i.rule == rule]
    assert hits and hits[0].record_id == "ST02", rep.summary()


ELEMENT_FAULTS = [
    ("structure_id", "NOPE", "E01_structure_known"),
    ("element_type", "Rw02.  Primary Element", "E02_element_allowed"),
    ("material", "Cheese", "E03_material_allowed"),
    ("material", None, "E03_material_allowed"),
    ("spray_proximity", "Sometimes", "E04_spray_proximity"),
    ("condition_code", "6F", "E05_condition"),
]


@pytest.mark.parametrize("column,value,rule", ELEMENT_FAULTS)
def test_each_element_rule_fires(golden_inventory, rs, column, value, rule):
    e = golden_inventory.elements.copy()
    e[column] = e[column].astype(object)
    e.loc[0, column] = value
    rep = validate_inventory(golden_inventory.structures, e, rs)
    assert rule in _rules(rep), rep.summary()


def test_duplicate_structure_id_is_an_error_and_orphans_its_elements(golden_inventory, rs):
    s = golden_inventory.structures.copy()
    s.loc[3, "structure_id"] = s.loc[4, "structure_id"]
    rep = validate_inventory(s, golden_inventory.elements, rs)
    assert "X01_unique" in _rules(rep)
    assert "E01_structure_known" in _rules(rep)     # SAVI's COUNTIF(...)=1 test fails for duplicates


def test_structure_without_elements_is_an_error(golden_inventory, rs):
    e = golden_inventory.elements[golden_inventory.elements["structure_id"] != "ST02"]
    rep = validate_inventory(golden_inventory.structures, e, rs)
    assert "S12_no_elements" in _rules(rep)


def test_case_variants_are_accepted_but_warned(golden_inventory, rs):
    """Excel lookups ignore case, so SAVI accepts 'Local Road - A Class'; we accept and warn."""
    rep = validate_inventory(golden_inventory.structures, golden_inventory.elements, rs)
    w = [i for i in rep.warnings if i.rule == "W01_case_variant"]
    assert any("Local Road - A Class" in i.message for i in w)
    assert rep.is_valid


def test_exempt_structure_types_skip_dimension_checks(golden_inventory, rs):
    """High mast lighting needs no length, width, headroom or spans (SAVI Structures!BK:BN)."""
    s = golden_inventory.structures.copy()
    hm = s.index[s["structure_type"] == "High Mast Lighting"][0]
    for c in ("length_m", "width_m", "headroom_m", "spans"):
        s.loc[hm, c] = None
    rep = validate_inventory(s, golden_inventory.elements, rs)
    assert not [i for i in rep.errors if i.row == hm]


def test_missing_required_column_is_reported(golden_inventory, rs):
    s = golden_inventory.structures.drop(columns=["traffic"])
    rep = validate_inventory(s, golden_inventory.elements, rs)
    assert not rep.is_valid


def test_report_is_tabular(golden_inventory, rs):
    rep = validate_inventory(golden_inventory.structures, golden_inventory.elements, rs)
    df = rep.to_frame()
    assert list(df.columns) == ["table", "row", "record_id", "field", "rule", "message", "severity"]
    assert isinstance(df, pd.DataFrame)
