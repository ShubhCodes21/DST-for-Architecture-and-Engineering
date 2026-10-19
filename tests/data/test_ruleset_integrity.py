"""QA family 1a - the rule set and golden fixtures are exactly what we think they are.

Also cross-checks SAVI's tables against the published SAMPT documents, so any place
where the tool and the method disagree is caught and logged rather than inherited silently.
"""
from __future__ import annotations

import hashlib
import json

import pytest

from dst_engine.formulas import EXTENT_OF_SEVERITY
from dst_engine.ruleset import RuleSet, RuleSetIntegrityError, key

from ..conftest import GOLDEN, RULESET


def test_golden_fixture_hashes_match_manifest():
    manifest = json.loads((GOLDEN / "manifest.json").read_text())
    for rel, digest in manifest["files"].items():
        assert hashlib.sha256((GOLDEN / rel).read_bytes()).hexdigest() == digest, rel


def test_ruleset_load_detects_tampering(tmp_path):
    import shutil
    copy = tmp_path / "rs"
    shutil.copytree(RULESET, copy)
    p = copy / "constants.parquet"
    p.write_bytes(p.read_bytes() + b"x")
    with pytest.raises(RuleSetIntegrityError):
        RuleSet.load(copy)


def test_ruleset_has_all_tables(rs):
    expected = {"condition_codes", "element_types", "structure_types", "deterioration", "intervention_rules",
                "maintenance_actions", "exposure_rules", "exposure_weights", "adjustment_factors",
                "traffic", "routes", "obstacles", "avf_factors", "indexation", "addon_bands"}
    assert expected <= set(rs.tables)
    for name in expected:
        assert len(rs[name]) > 0, name


def test_grc_unit_rates_are_base_rates_times_index(rs):
    """Ref12: 2025/26 rate = 2010/11 base rate x GRC multiplier (1.6137)."""
    st = rs["structure_types"]
    m = rs.constants["grc_multiplier"]
    assert m == pytest.approx(1.6137015535914818)
    for r in st.itertuples():
        assert r.grc_unit_rate == pytest.approx(r.grc_unit_rate_base * m, rel=1e-12), r.structure_type


def test_maintenance_rates_are_base_rates_times_index(rs):
    real = lambda d: d[~d["action"].astype(str).str.startswith("[")].reset_index(drop=True)  # noqa: E731
    a, b = real(rs["maintenance_actions"]), real(rs["maintenance_actions_base"])
    m = rs.constants["maintenance_multiplier"]
    assert list(a["action"]) == list(b["action"])
    for c in ["fixed_rate", "constant_rate", "var_rate_s2", "var_rate_s3", "var_rate_s4", "var_rate_s5"]:
        assert (a[c].astype(float) - b[c].astype(float) * m).abs().max() < 1e-6, c


def test_indexation_row_for_price_year(rs):
    idx = rs["indexation"].set_index("price_year")
    assert idx.loc["2025/26", "grc_multiplier"] == pytest.approx(rs.constants["grc_multiplier"])
    assert idx.loc["2025/26", "maintenance_multiplier"] == pytest.approx(rs.constants["maintenance_multiplier"])


def test_condition_scores_match_part_c_table_c11f(rs):
    expected = {"1A": 1, "2B": 2, "2C": 2.1, "2D": 2.3, "2E": 2.7, "3B": 3, "3C": 3.1, "3D": 3.3, "3E": 3.7,
                "4B": 4, "4C": 4.1, "4D": 4.3, "4E": 4.7, "5B": 5, "5C": 5, "5D": 5, "5E": 5}
    c = rs["condition_codes"].set_index("code")["ecs"]
    for code, ecs in expected.items():
        assert c[code] == pytest.approx(ecs, abs=1e-11), code


def test_extent_of_severity_matches_part_a_table_4(rs):
    c = rs["condition_codes"].set_index("code")
    for code, ext in EXTENT_OF_SEVERITY.items():
        got = tuple(c.loc[code, ["ext_s2", "ext_s3", "ext_s4", "ext_s5"]].astype(float))
        assert got == pytest.approx(ext), code


def test_teod_differs_from_part_a_only_at_1a(rs):
    """Logged divergence: SAVI sets TEoD(1A) = 0.001 (Part A: 0) to avoid division by zero."""
    c = rs["condition_codes"].set_index("code")
    for code, ext in EXTENT_OF_SEVERITY.items():
        if code == "1A":
            assert c.loc[code, "teod"] == pytest.approx(0.001)
        else:
            assert c.loc[code, "teod"] == pytest.approx(sum(ext)), code


def test_adjustment_factors_match_part_c_table_c12b(rs):
    expected = {"adj_heritage": 2.0, "adj_conservation_area": 1.25, "adj_environmentally_sensitive": 1.4,
                "adj_river_coastal_wall": 1.6, "adj_substandard": 0.85, "adj_tunnel_over_400m": 1.25,
                "adj_rural": 0.7, "adj_route_unclassified": 0.8, "adj_obstacle_footway": 0.75,
                "adj_obstacle_watercourse_non_nav": 0.9, "adj_obstacle_land_disused": 0.9,
                "adj_obstacle_railway": 2.0, "adj_obstacle_tenanted_business": 1.1}
    for col, f in expected.items():
        assert rs.adjustment_factors[col] == pytest.approx(f), col


def test_priority_weights_match_part_c_table_c11a(rs):
    assert rs.priority_weights == {"f1": 1.0, "f2": 0.25, "f3": 0.5}


def test_addon_bands_match_part_c_section_9(rs):
    assert rs.addon_factor("fP", 0) == 0.2 and rs.addon_factor("fP", 60_000) == 0.15
    assert rs.addon_factor("fO", 2_000_000) == 0.1
    assert rs.addon_factor("fD", 10) == 0.4 and rs.addon_factor("fD", 300_000) == 0.15


def test_ref03_element_columns_follow_ref14_order(rs):
    """SAVI indexes Ref14 importance by the material-matrix column (Elements!AA), not by Ref14 row.
    The engine looks up by element name; this proves the two orders agree, so results are identical."""
    et = rs["element_types"]["element_type"].map(key).tolist()
    em = rs["element_materials"]["element_type"].map(key)
    assert list(dict.fromkeys(em)) == [e for e in et if e in set(em)]


def test_every_intervention_rule_action_is_costed(rs):
    actions = set(rs["maintenance_actions"]["action"].map(key))
    used = rs["intervention_rules"]["action"].dropna().map(key)
    missing = set(used[used != ""]) - actions
    assert not missing


def test_every_deterioration_material_has_an_average_profile(rs):
    det = rs["deterioration"]
    det = det[~det["material"].astype(str).str.startswith("[")]           # spare placeholder rows
    mats = set(det["material"].map(key))
    avg = set(det.loc[det["exposure"].map(key) == "average", "material"].map(key))
    assert mats - avg <= {key("Foundation Material")}
