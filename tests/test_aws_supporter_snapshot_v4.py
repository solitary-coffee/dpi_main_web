"""Offline validation of the AWS schema-v4 (paid image rules) Lambda validator and ZIP patch.

Run: python -m unittest tests/test_aws_supporter_snapshot_v4.py
"""
import ast
import io
from pathlib import Path
import sys
import time
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "aws" / "channel-directory-api"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy_schema_v3
import deploy_schema_v4
from test_aws_supporter_snapshot_v3 import SOURCE as V1_SOURCE


def repo_validator():
    """Load only the validator and its helpers from the repository Lambda (no boto3)."""
    tree = ast.parse((ROOT / "aws/channel-directory-api/lambda_function.py").read_text(encoding="utf-8"))
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef)
             and n.name in ("_clean", "_integer", "_validate_supporter_snapshot")]
    namespace = {"time": time}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<lambda-validator>", "exec"), namespace)
    return namespace["_validate_supporter_snapshot"]


NOW = 1_800_000_000


def snapshot(version, *rules):
    return {"schemaVersion": version, "version": "supporter-1", "generatedAt": NOW - 5,
            "expiresAt": NOW + 3600, "routing": {}, "rules": [
                {"id": f"rule-{index}", "guildId": "111111111111111111",
                 "channelIds": ["222222222222222222"], **rule} for index, rule in enumerate(rules)]}


EARTHQUAKE = {"type": "earthquake", "region": "all"}
RADAR = {"type": "hires-radar", "region": "kanto-koshin", "tier": "pro", "linearRainband": True,
         "radarCondition": "rainfall-threshold", "rainfallThresholdMmPerHour": 30, "deliveryIntervalHours": 1}
TSUNAMI = {"type": "tsunami-map", "region": "all", "tier": "plus", "includeTables": True, "enlargedArea": False}
WEATHER = {"type": "weather-map", "region": "kanto-koshin", "tier": "custom", "products": ["VPWW55"],
           "minSeverity": "warning", "prefecture": "13", "municipalities": ["1310100"], "municipalityDetail": True}
QUAKE_MAP = {"type": "earthquake-map", "region": "all", "tier": "pro", "products": ["VXSE51", "VXSE53"],
             "minIntensity": "5-", "regionMinIntensity": {"kanto-koshin": "3"}, "centerMunicipality": "1310100"}


class RepositoryLambdaV4Tests(unittest.TestCase):
    def setUp(self):
        self.validate = repo_validator()

    def test_v1_to_v3_still_accepted(self):
        for version in (1, 2, 3):
            self.assertEqual(self.validate(snapshot(version, EARTHQUAKE), NOW)["schemaVersion"], version)
        with self.assertRaises(ValueError):
            self.validate(snapshot(5, EARTHQUAKE), NOW)

    def test_v4_accepts_three_image_types_and_keeps_fields(self):
        result = self.validate(snapshot(4, RADAR, TSUNAMI, WEATHER, EARTHQUAKE), NOW)
        self.assertEqual(result["schemaVersion"], 4)
        self.assertEqual([rule["type"] for rule in result["rules"]],
                         ["hires-radar", "tsunami-map", "weather-map", "earthquake"])
        self.assertEqual(result["rules"][0]["rainfallThresholdMmPerHour"], 30)
        self.assertEqual(result["rules"][2]["municipalities"], ["1310100"])
        self.assertEqual(result["rules"][1]["tier"], "plus")

    def test_image_rules_require_v4_tier_and_region(self):
        bad = [snapshot(3, TSUNAMI), snapshot(4, {**TSUNAMI, "tier": "supporter"}),
               snapshot(4, {**TSUNAMI, "tier": None}), snapshot(4, {**RADAR, "region": "kanto"}),
               snapshot(4, {**WEATHER, "type": "weather-image"})]
        for value in bad:
            with self.assertRaises(ValueError):
                self.validate(value, NOW)


    def test_v4_accepts_eew_map_and_warning_table(self):
        features = ["eewMap"]
        basic = {"type": "eew-map", "region": "all", "tier": "supporter", "regions": [], "features": features}
        regional = {"type": "eew-map", "region": "all", "tier": "plus", "regions": ["tohoku", "kanto-koshin"]}
        table = {"type": "warning-table", "region": "all", "tier": "pro", "tables": ["national", "timeseries"],
                 "regions": ["kinki"], "deliverOn": "changed", "showAllAreas": True}
        result = self.validate(snapshot(4, basic, regional, table, EARTHQUAKE), NOW)
        self.assertEqual([rule["type"] for rule in result["rules"]], ["eew-map", "eew-map", "warning-table", "earthquake"])
        self.assertEqual(result["rules"][0]["features"], features)
        self.assertEqual(result["rules"][1]["regions"], ["tohoku", "kanto-koshin"])
        self.assertEqual(result["rules"][2]["tables"], ["national", "timeseries"])
        # "supporter" (Basic) is accepted for eew-map only.
        for bad in (snapshot(4, {**table, "tier": "supporter"}), snapshot(4, {**basic, "tier": ""}),
                    snapshot(3, basic), snapshot(4, {**TSUNAMI, "tier": "supporter"})):
            with self.assertRaises(ValueError):
                self.validate(bad, NOW)

    def test_v4_accepts_earthquake_map_and_keeps_fields(self):
        plus = {"type": "earthquake-map", "region": "all", "tier": "plus", "products": ["VXSE52"]}
        result = self.validate(snapshot(4, QUAKE_MAP, plus, EARTHQUAKE), NOW)
        self.assertEqual([rule["type"] for rule in result["rules"]], ["earthquake-map", "earthquake-map", "earthquake"])
        self.assertEqual(result["rules"][0]["regionMinIntensity"], {"kanto-koshin": "3"})
        self.assertEqual(result["rules"][0]["centerMunicipality"], "1310100")
        self.assertEqual(result["rules"][1]["products"], ["VXSE52"])
        for bad in (snapshot(3, QUAKE_MAP), snapshot(4, {**QUAKE_MAP, "tier": "supporter"}),
                    snapshot(4, {**QUAKE_MAP, "region": "kanto"})):
            with self.assertRaises(ValueError):
                self.validate(bad, NOW)


def first_v4_source():
    """The repository Lambda as first deployed for v4 (before earthquake-map was allowed)."""
    old = earthquake_map_v4_source()
    old = old.replace(',\n                     "earthquake-map"}', '}').replace(', "earthquake-map"}', '}')
    assert '"earthquake-map"' not in deploy_schema_v4.function_source(old, "_validate_supporter_snapshot")
    return old


def earthquake_map_v4_source():
    """The repository Lambda as deployed on 2026-11-18 (earthquake-map, no eew-map / warning-table)."""
    source = (ROOT / "aws/channel-directory-api/lambda_function.py").read_text(encoding="utf-8")
    old = source.replace(', "eew-map", "warning-table"}', '}').replace(
        '    basic_image_types = {"eew-map"}\n', '').replace(
        '''not in (
                image_tiers | ({"supporter"} if _clean(rule.get("type"), 30) in basic_image_types else set()))''',
        'not in image_tiers')
    validator = deploy_schema_v4.function_source(old, "_validate_supporter_snapshot")
    assert '"eew-map"' not in validator and '"warning-table"' not in validator and '"earthquake-map"' in validator
    return old


class LambdaSnapshotV4PatchTests(unittest.TestCase):
    def test_first_v4_validator_is_upgraded_for_earthquake_map(self):
        live = first_v4_source()
        updated, changed = deploy_schema_v4.patch(live)
        self.assertTrue(changed)
        self.assertIn('"earthquake-map"', deploy_schema_v4.function_source(updated, "_validate_supporter_snapshot"))
        self.assertEqual(deploy_schema_v4.verify(updated),
                         {1: "accepted", 2: "accepted", 3: "accepted", 4: "accepted", 5: "rejected"})
        self.assertFalse(deploy_schema_v4.patch(updated)[1])
        # Everything outside the validator is untouched.
        self.assertEqual(updated.replace(deploy_schema_v4.function_source(updated, "_validate_supporter_snapshot"), ""),
                         live.replace(deploy_schema_v4.function_source(live, "_validate_supporter_snapshot"), ""))


    def test_earthquake_map_validator_is_upgraded_for_eew_map_and_warning_table(self):
        live = earthquake_map_v4_source()
        updated, changed = deploy_schema_v4.patch(live)
        self.assertTrue(changed)
        validator = deploy_schema_v4.function_source(updated, "_validate_supporter_snapshot")
        self.assertIn('"eew-map"', validator)
        self.assertIn('"warning-table"', validator)
        self.assertEqual(deploy_schema_v4.verify(updated),
                         {1: "accepted", 2: "accepted", 3: "accepted", 4: "accepted", 5: "rejected"})
        self.assertFalse(deploy_schema_v4.patch(updated)[1])

    def test_v1_and_v3_live_validators_are_upgraded(self):
        v3, _ = deploy_schema_v3.patch(V1_SOURCE)
        for live in (V1_SOURCE, v3):
            updated, changed = deploy_schema_v4.patch(live)
            self.assertTrue(changed)
            self.assertIn("unrelated", updated)
            found = deploy_schema_v4.verify(updated)
            self.assertEqual(found, {1: "accepted", 2: "accepted", 3: "accepted", 4: "accepted", 5: "rejected"})
            same, again = deploy_schema_v4.patch(updated)
            self.assertFalse(again)
            self.assertEqual(same, updated)

    def test_repository_lambda_is_already_v4(self):
        source = (ROOT / "aws/channel-directory-api/lambda_function.py").read_text(encoding="utf-8")
        self.assertFalse(deploy_schema_v4.patch(source)[1])

    def test_unknown_live_validator_refused(self):
        with self.assertRaisesRegex(RuntimeError, "Unrecognized deployed validator"):
            deploy_schema_v4.patch(V1_SOURCE.replace(" != 1", " < 4"))

    def test_preserves_unrelated_zip_content(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("lambda_function.py", V1_SOURCE)
            archive.writestr("local_delivery_gate.py", b"original code must not change")
        result, changed = deploy_schema_v4.repack(data.getvalue())
        self.assertTrue(changed)
        with zipfile.ZipFile(io.BytesIO(result)) as archive:
            self.assertEqual(archive.read("local_delivery_gate.py"), b"original code must not change")
            self.assertIn(b"not in (1, 2, 3, 4)", archive.read("lambda_function.py"))
            self.assertIn(b'"tsunami-map"', archive.read("lambda_function.py"))


if __name__ == "__main__":
    unittest.main()
