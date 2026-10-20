import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'aws/channel-directory-api'))
import mode_hooks
import mode_lambda_entry
from mode_observation import aggregate, publish
from mode_transition import reserve, acquire_monitor, release_monitor
from operating_modes import build_plan, application_status, stored_plan
from delivery_gate import DeliveryGate, DeliveryBlocked


class EvidenceTests(unittest.TestCase):
    class AwsError(RuntimeError):
        def __init__(self, code):
            super().__init__(code)
            self.response = {'Error': {'Code': code, 'Message': code}}

    def setUp(self):
        self.manifest = {'installation_id': 'new', 'created_at': 50,
                         'members': {'home_sender': 'a', 'home_fallback': 'b'},
                         'optional_members': {'training': 'c'}}
        self.rows = [{'member': m, 'code_sha': sha, 'installation_id': 'new', 'pid': i,
                      'observed_at': 95, 'verified': True, 'applied_revision': 5,
                      'delivery': 'stopped', 'wait_seconds': 0}
                     for i, (m, sha) in enumerate(self.manifest['members'].items(), 1)]

    def test_old_process_cannot_claim_new_revision_applied(self):
        row = {**self.rows[1], 'pid': 3, 'applied_revision': 4, 'observed_at': 94}
        proof = aggregate(self.manifest, self.rows + [row], 100, [1, 2, 3])
        self.assertFalse(proof['verified'])
        self.assertEqual(proof['missing_pids'], [3])

    def test_missing_process_and_code_hash_never_verified(self):
        self.assertFalse(aggregate(self.manifest, self.rows, 100, [999])['verified'])
        self.rows[0]['code_sha'] = 'old'
        self.assertFalse(aggregate(self.manifest, self.rows, 100)['capability_verified'])

    def test_installation_does_not_prove_live_stop(self):
        evidence = aggregate(self.manifest, self.rows, 200)
        self.assertTrue(evidence['capability_verified'])
        self.assertFalse(evidence['verified'])
        self.assertEqual(application_status(evidence, 5, 200), 'unconfirmed')

    def test_all_processes_same_revision_is_applied(self):
        evidence = aggregate(self.manifest, self.rows, 100, [1, 2])
        self.assertEqual(application_status(evidence, 5, 100, {'delivery': 'stopped'}), 'applied')
        self.assertEqual(application_status(evidence, 6, 100), 'pending')
        self.assertEqual(application_status(evidence, 5, 100, {'delivery': 'immediate'}), 'pending')

    def test_optional_direct_sender_is_checked_by_pid(self):
        row = {**self.rows[0], 'member': 'training', 'code_sha': 'c', 'pid': 3}
        self.assertTrue(aggregate(self.manifest, self.rows + [row], 100, [1, 2, 3])['verified'])

    def test_older_installation_does_not_replace_evidence(self):
        table = Mock()
        table.get_item.return_value = {'Item': {'installation_id': 'new', 'installed_at': 200}}
        self.assertFalse(publish(table, 'home', {'installation_id': 'old', 'installed_at': 100}))
        table.put_item.assert_not_called()

    def test_stale_evidence_condition_is_a_benign_noop(self):
        table = Mock()
        table.get_item.return_value = {'Item': {
            'installation_id': 'same', 'installed_at': 100, 'observed_at': 200,
        }}
        table.put_item.side_effect = self.AwsError('ConditionalCheckFailedException')

        accepted = publish(table, 'home', {
            'installation_id': 'same', 'installed_at': 100, 'observed_at': 0,
        })

        self.assertFalse(accepted)

    def test_publish_still_raises_unexpected_aws_errors(self):
        table = Mock()
        table.get_item.return_value = {'Item': {}}
        table.put_item.side_effect = self.AwsError('AccessDeniedException')

        with self.assertRaises(self.AwsError):
            publish(table, 'home', {
                'installation_id': 'same', 'installed_at': 100, 'observed_at': 200,
            })

    def test_dynamodb_decimal_wait_can_be_displayed(self):
        from decimal import Decimal
        plan = build_plan('emergency')
        plan['home'] = {'delivery': 'standby', 'waitSeconds': Decimal(7)}
        self.assertEqual(stored_plan('manual', plan)['home']['waitSeconds'], 7)


class CoordinationTests(unittest.TestCase):
    def reserve(self, table, current, mode):
        return reserve(table, current, mode=mode, plan=build_plan(mode), overrides=None,
                       actor='test', reason='test', request_id='request', expected_revision=1,
                       now=100, previous_concurrency={})

    def test_active_monitor_blocks_fixed_change_but_never_blocks_stop(self):
        table = Mock()
        current = {'revision': 1, 'monitor_lease_until': 150, 'monitor_owner': 'monitor'}
        with self.assertRaises(ValueError): self.reserve(table, current, 'normal')
        table.put_item.assert_not_called()
        result = self.reserve(table, current, 'emergency_stop')
        self.assertEqual(result['mode'], 'emergency_stop')

    def test_monitor_lock_is_conditional_and_owner_scoped(self):
        table = Mock()
        acquire_monitor(table, owner='first', now=100, duration=130)
        values = table.update_item.call_args.kwargs['ExpressionAttributeValues']
        self.assertEqual(values[':until'], 230)
        self.assertEqual(values[':auto'], 'automatic')
        release_monitor(table, 'first')
        self.assertEqual(table.update_item.call_args.kwargs['ConditionExpression'], 'monitor_owner=:owner')

    def test_monitor_coordination_outage_does_not_run_ec2_actions(self):
        table, action = Mock(), Mock()
        table.update_item.side_effect = OSError('coordination unavailable')
        context = Mock(aws_request_id='request')
        context.get_remaining_time_in_millis.return_value = 120000
        with patch.object(mode_hooks, 'enabled', return_value=True), patch.object(mode_hooks, '_state_table', return_value=table):
            with self.assertRaises(OSError): mode_hooks.coordinate_monitor(action, context)
        action.assert_not_called()


class HookTests(unittest.TestCase):
    def setUp(self):
        self.record = {'mode': 'emergency_stop', 'revision': 5}
        self.gate = DeliveryGate(lambda: self.record)

    def test_direct_discord_transport_is_not_called_on_stop(self):
        post = Mock()
        with patch.dict(os.environ, {'DPI_MODE_ENABLED': '1', 'DPI_MODE_NODE': 'home'}), patch.object(mode_hooks, '_gate', self.gate):
            with self.assertRaises(DeliveryBlocked):
                mode_hooks.direct_discord_post(post, 'https://example.invalid', json={}, mode_admitted_at=100)
        post.assert_not_called()

    def test_disabled_adapter_preserves_original_transport(self):
        post = Mock(return_value='original')
        with patch.object(mode_hooks, 'enabled', return_value=False):
            self.assertEqual(mode_hooks.direct_discord_post(post, 'url', json={'embeds': []}), 'original')
        post.assert_called_once_with('url', json={'embeds': []})

    def test_normal_fast_eew_does_not_override_manual_wait(self):
        self.record.update(mode='normal')
        now = [100.0]
        gate = DeliveryGate(lambda: self.record, clock=lambda: now[0], epoch=lambda: now[0], sleep=lambda n: now.__setitem__(0, now[0] + n))
        decision = gate.wait('tokyo-eew', admitted_at=100, legacy_fast=True)
        self.assertEqual(decision.wait_seconds, 0)
        self.assertEqual(now[0], 100)
        self.record.update(mode='manual', revision=6, node_overrides=build_plan('normal'))
        now[0] = 106
        gate.wait('tokyo-eew', admitted_at=106, legacy_fast=True)
        self.assertAlmostEqual(now[0], 109)

    def test_waited_eew_does_not_wait_twice_or_change_identity(self):
        self.record.update(mode='normal')
        payload = {'id': 'stable-id', 'data': 'eew', 'title': {'embeds': []}, 'times': 100,
                   '_dpi_mode': {'admitted_at': 100, 'waited_revision': 5}}
        with patch.dict(os.environ, {'DPI_MODE_ENABLED': '1', 'DPI_MODE_NODE': 'tokyo-eew'}), patch.object(mode_hooks, '_gate', self.gate), patch.object(mode_hooks, 'wait_source') as wait:
            mode_hooks.prepare_source(payload)
        wait.assert_not_called()
        self.assertEqual(payload['id'], 'stable-id')

    def test_http_event_cannot_trigger_private_probe(self):
        original = Mock(return_value='original')
        with patch.object(mode_lambda_entry, 'original', return_value=original), patch.object(mode_hooks, 'probe') as probe:
            event = {'requestContext': {'http': {'method': 'POST'}}, '_dpi_mode_probe': True}
            self.assertEqual(mode_lambda_entry.handler(event, None), 'original')
        probe.assert_not_called()
        original.assert_called_once_with(event, None)

    def test_old_heartbeat_does_not_renew_policy_freshness(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'policy.json'
            saved = {'record': {'mode': 'emergency_stop', 'revision': 5}, 'received_at': 50}
            path.write_text(json.dumps(saved))
            with patch.dict(os.environ, {'DPI_MODE_ENABLED': '1', 'DPI_MODE_FILE': str(path)}):
                mode_hooks.save_heartbeat_policy({'operating_mode': {'mode': 'normal', 'revision': 4}})
            self.assertEqual(json.loads(path.read_text()), saved)


if __name__ == '__main__':
    unittest.main()
