import copy
import os
import pathlib
import sys
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "aws/channel-directory-api"))

import mode_hooks
from delivery_gate import DeliveryBlocked, DeliveryGate
from operating_modes import NODES, PROTOCOL_VERSION, RUNTIME_COMPONENTS, build_plan, build_route_plan, notification_policy, runtime_readiness
from test_delivery import TEST_SLOT, build_message, candidate_event, discover_functions, validate_request, worker_event


class MaintenanceModeTests(unittest.TestCase):
    def setUp(self):
        self.plan = build_plan("emergency")
        self.routes = {
            "fast": {"enabled": True, "priority": 1},
            "sqs": {"enabled": False, "priority": 2},
            "regional-backup": {"enabled": True, "priority": 3},
            "cross-region-backup": {"enabled": True, "priority": 4},
        }
        self.record = {"mode": "maintenance", "revision": 8,
                       "node_overrides": self.plan, "route_overrides": self.routes}

    def test_maintenance_requires_every_source_and_unique_enabled_priorities(self):
        self.assertEqual(set(build_plan("maintenance", self.plan)), set(NODES))
        self.assertFalse(build_route_plan("maintenance", self.routes)["sqs"]["enabled"])
        invalid = copy.deepcopy(self.routes)
        invalid["regional-backup"]["priority"] = 1
        with self.assertRaises(ValueError):
            build_route_plan("maintenance", invalid)
        for value in self.routes.values():
            value["enabled"] = False
        with self.assertRaises(ValueError):
            build_route_plan("maintenance", self.routes)

    def test_route_gate_stops_disabled_route_and_orders_enabled_routes(self):
        gate = DeliveryGate(lambda: self.record)
        self.assertEqual(gate.route("fast")["waitSeconds"], 0)
        self.assertEqual(gate.route("regional-backup")["waitSeconds"], 3)
        with self.assertRaises(DeliveryBlocked) as error:
            gate.route("sqs")
        self.assertEqual(error.exception.reason, "maintenance_route_stopped")

    def test_maintenance_notification_policy_keeps_critical_and_tests(self):
        gate = DeliveryGate(lambda: self.record)
        self.assertFalse(gate.notification_allowed("operational"))
        self.assertTrue(gate.notification_allowed("critical"))
        self.assertTrue(gate.notification_allowed("test"))
        self.assertTrue(notification_policy("normal")["suppressNonEssential"] is False)

    def test_v2_readiness_does_not_claim_v1_can_apply_maintenance(self):
        records = {node: {"observed_at": 100, "protocol_version": 1, "verified": True,
                          "capability_verified": True, "installation_id": "v1", "coverage_digest": "hash"}
                   for node in RUNTIME_COMPONENTS}
        self.assertTrue(runtime_readiness(records, 100)["ready"])
        self.assertFalse(runtime_readiness(records, 100, PROTOCOL_VERSION)["ready"])

    def test_candidate_route_classification(self):
        previous = mode_hooks._gate
        try:
            mode_hooks._gate = None
            with patch.dict(os.environ, {"DPI_MODE_REGION": "ap-northeast-1"}, clear=False):
                self.assertEqual(mode_hooks.candidate_route({"_ha": {
                    "accepted_region": "ap-northeast-1", "primary_region": "ap-northeast-1"}}), "sqs")
                self.assertEqual(mode_hooks.candidate_route({"_ha": {
                    "accepted_region": "ap-northeast-1", "primary_region": "ap-northeast-3"}}), "regional-backup")
                self.assertEqual(mode_hooks.candidate_route({"_ha": {
                    "accepted_region": "ap-northeast-3", "primary_region": "ap-northeast-3"}}), "cross-region-backup")
        finally:
            mode_hooks._gate = previous


class TestDeliveryPayloadTests(unittest.TestCase):
    def setUp(self):
        self.inventory = discover_functions({
            "ap-northeast-1": [{"FunctionName": "new_EEW_1"}, {"FunctionName": "unrelated"}],
            "ap-northeast-3": [{"FunctionName": "new_kisyo_1"}],
        })

    def test_test_slot_and_lambda_allowlist_are_fail_closed(self):
        self.assertEqual(TEST_SLOT, "配信テスト")
        request = validate_request({"sources": ["admin"], "routes": ["fast"],
                                    "functions": [self.inventory[0]], "title": "test"}, self.inventory)
        self.assertEqual(request["routes"], ["fast"])
        with self.assertRaises(ValueError):
            validate_request({"sources": ["admin"], "routes": ["fast"],
                              "functions": [{"region": "ap-northeast-1", "name": "unrelated"}]}, self.inventory)

    def test_embed_identifies_origin_route_and_disables_mentions(self):
        message = build_message("run", title="delivery test", source="home", route="sqs", requested_by="admin")
        self.assertEqual(message["allowed_mentions"], {"parse": []})
        values = [field["value"] for field in message["embeds"][0]["fields"]]
        self.assertIn("自宅サーバー", values)
        self.assertIn("SQS系統", values)
        self.assertIn("配信テスト", message["embeds"][0]["footer"]["text"])

    def test_worker_and_candidate_payloads_keep_test_metadata(self):
        worker = worker_event("run", region="ap-northeast-1", function_name="new_EEW_1",
                              source="admin", url="https://example.invalid", title="test", note="", requested_by="admin")
        candidate = candidate_event("run", target_region="ap-northeast-3", primary_region="ap-northeast-1",
                                    accepted_region="ap-northeast-1", source="home", route="cross-region-backup",
                                    urls=["https://example.invalid"], title="test", note="", requested_by="admin")
        self.assertEqual(worker["_dpi_test"]["slot"], TEST_SLOT)
        self.assertEqual(candidate["_dpi_test"]["route"], "cross-region-backup")


if __name__ == "__main__":
    unittest.main()
