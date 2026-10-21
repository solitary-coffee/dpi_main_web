"""No network calls or real notifications: exercise mode changes during sends."""
import copy
import ast
from decimal import Decimal
import pathlib
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'aws/channel-directory-api'))
from delivery_gate import DeliveryGate, DeliveryBlocked, validate_record
from operating_modes import PROTOCOL_VERSION, build_plan, build_route_plan, notification_policy, runtime_readiness
from mode_transition import reserve, finish


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.on_sleep = lambda: None

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        self.on_sleep()


class GateTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.record = {'mode': 'normal', 'revision': 1}
        self.loader = Mock(side_effect=lambda: copy.deepcopy(self.record))
        self.gate = DeliveryGate(self.loader, refresh_seconds=1, max_age_seconds=2,
                                 clock=self.clock, epoch=self.clock, sleep=self.clock.sleep)

    def check(self, node='home', admitted_at=1000, **kwargs):
        return self.gate.check(node, admitted_at=admitted_at, **kwargs)

    def test_all_sources_and_regional_egress_stop(self):
        self.record.update(mode='emergency_stop', revision=2, discard_before_epoch=1000)
        for node in (*build_plan('normal'), 'aws-tokyo', 'aws-osaka'):
            with self.subTest(node=node), self.assertRaises(DeliveryBlocked) as error:
                self.check(node)
            self.assertEqual(error.exception.reason, 'emergency_stop')

    def test_stop_during_wait_never_reaches_claim_or_send(self):
        self.clock.on_sleep = lambda: self.record.update(mode='emergency_stop', revision=2)
        claim, send = Mock(), Mock()
        with self.assertRaises(DeliveryBlocked):
            self.gate.wait('tokyo-eew', admitted_at=1000)
            claim()
            send()
        claim.assert_not_called()
        send.assert_not_called()

    def test_emergency_shortens_existing_wait(self):
        self.clock.on_sleep = lambda: self.record.update(mode='emergency', revision=2)
        decision = self.gate.wait('tokyo-eew', admitted_at=1000)
        self.assertEqual(decision.wait_seconds, 0)
        self.assertLess(self.clock.now - 1000, 1.2)

    def test_stop_checked_between_retry_attempts(self):
        send = Mock()
        self.check('aws-tokyo')
        send()
        self.record.update(mode='emergency_stop', revision=2)
        self.clock.now += 1
        with self.assertRaises(DeliveryBlocked):
            self.check('aws-tokyo')
            send()
        self.assertEqual(send.call_count, 1)

    def test_resume_rejects_old_unstamped_and_future_messages(self):
        self.record.update(mode='automatic', revision=3, discard_before_epoch=1000)
        self.clock.now = 1010
        for admission in [None, 999, 1000, float('nan'), float('inf'), True, 1016]:
            with self.subTest(admission=admission), self.assertRaises(DeliveryBlocked):
                self.check('aws-osaka', admitted_at=admission)
        self.assertEqual(self.check('aws-osaka', admitted_at=1001).revision, 3)

    def test_reader_outage_bounded_and_restart_fails_closed(self):
        self.check()
        self.loader.side_effect = OSError('unavailable')
        self.clock.now += 1
        self.check()
        self.clock.now += 1
        with self.assertRaises(DeliveryBlocked) as error:
            self.check()
        self.assertTrue(error.exception.retryable)
        fresh = DeliveryGate(self.loader)
        with self.assertRaises(DeliveryBlocked):
            fresh.check('home', admitted_at=1000)

    def test_stale_replica_and_conflicting_revision_do_not_clear_stop(self):
        self.record.update(mode='emergency_stop', revision=5)
        with self.assertRaises(DeliveryBlocked): self.check()
        for revision in [4, 5]:
            self.record.update(mode='emergency', revision=revision)
            self.clock.now += 1
            with self.assertRaises(DeliveryBlocked): self.check()

    def test_remote_reads_shared_across_webhooks(self):
        for _ in range(1000): self.check('aws-tokyo')
        self.assertEqual(self.loader.call_count, 1)

    def test_manual_home_delay_and_ec2_stop_without_double_wait(self):
        plan = build_plan('emergency')
        plan['home'] = {'delivery': 'standby', 'waitSeconds': Decimal(3)}
        plan['tokyo-weather'] = {'delivery': 'stopped', 'waitSeconds': Decimal(0)}
        self.record.update(mode='manual', revision=2, node_overrides=plan)
        self.gate.wait('home', admitted_at=1000)
        self.assertAlmostEqual(self.clock.now, 1003)
        self.assertEqual(self.check('aws-tokyo').wait_seconds, 0)
        with self.assertRaises(DeliveryBlocked): self.check('tokyo-weather')

    def test_automatic_uses_original_policy_and_ack_is_not_deployment_proof(self):
        self.record.update(mode='automatic', revision=2)
        policy = lambda: {'delivery': 'standby', 'waitSeconds': 3}
        self.assertEqual(self.check('tokyo-eew', automatic_policy=policy).wait_seconds, 3)
        ack = self.gate.acknowledgement('tokyo-eew', automatic_policy=policy)
        self.assertFalse(ack['verified'])
        self.assertTrue(ack['gate_loaded'])


class TransitionTests(unittest.TestCase):
    def reserve(self, table, current, mode='normal', revision=0, now=1000):
        return reserve(table, current, mode=mode, plan=build_plan(mode), overrides=None,
                       actor='test', reason='test change', request_id='request',
                       expected_revision=revision, now=now, previous_concurrency={})

    def test_automatic_preserves_revision_and_resume_cutoff(self):
        table = Mock()
        stopped = self.reserve(table, {}, 'emergency_stop')
        stopped['transition_status'] = 'awaiting_ack'
        resumed = self.reserve(table, stopped, 'automatic', 1, 1010)
        self.assertEqual(resumed['revision'], 2)
        self.assertEqual(resumed['discard_before_epoch'], 1010)
        table.delete_item.assert_not_called()
        self.assertIn('revision = :revision', table.put_item.call_args.kwargs['ConditionExpression'])

    def test_pending_operation_and_stale_revision_have_no_writes(self):
        table = Mock()
        for current, expected in [({'revision': 2}, 1), ({'revision': 1}, True),
                                  ({'revision': 1, 'transition_status': 'applying', 'lease_until': 1100}, 1)]:
            with self.assertRaises(ValueError): self.reserve(table, current, revision=expected)
        table.put_item.assert_not_called()

    def test_expired_operation_can_recover_and_finish_is_owner_conditional(self):
        table = Mock()
        current = {'revision': 1, 'transition_status': 'applying', 'lease_until': 999}
        operation = self.reserve(table, current, revision=1)
        finish(table, operation, status='failed', error='read failed')
        values = table.update_item.call_args.kwargs['ExpressionAttributeValues']
        self.assertEqual(values[':revision'], 2)
        self.assertEqual(values[':operation'], 'request')
        self.assertEqual(values[':status'], 'failed')

    def test_api_reserves_before_side_effects_and_records_partial_failure(self):
        path = pathlib.Path(__file__).resolve().parents[1] / 'aws/channel-directory-api/lambda_function.py'
        tree = ast.parse(path.read_text())
        tree.body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_control_system_mode']
        table = Mock()
        table.get_item.return_value = {'Item': {'revision': 0, 'previous_concurrency': {'region': 1}}}
        db = Mock()
        db.Table.return_value = table
        operation = {'revision': 1}
        reservation = Mock(return_value=operation)
        apply = Mock(side_effect=OSError('regional API unavailable'))
        finished = Mock()
        ns = {'_clean': lambda v, n: str(v or '')[:n], 'build_plan': build_plan,
              'build_route_plan': build_route_plan, 'notification_policy': notification_policy,
              'PROTOCOL_VERSION': PROTOCOL_VERSION,
              'os': __import__('os'), 'MODE_AUTHORITY_REGION': 'ap-northeast-1',
              'hmac': __import__('hmac'), 'time': __import__('time'),
              'ALLOWED_SYSTEM_MODES': {'automatic', 'normal'}, 'STATE_TABLE_NAME': 'state',
              '_dynamodb': db, 'MANUAL_MODE_KEY': 'ADMIN#SYSTEM_MODE',
              'RUNTIME_INTEGRATION_COMPLETE': False, 'ClientError': type('ClientError', (Exception,), {}),
              'runtime_readiness': runtime_readiness, '_mode_runtime_records': lambda: {},
              'reserve_mode_transition': reservation, 'finish_mode_transition': finished,
              '_apply_reserved_system_mode': apply, '_system_cache': {'expires_at': 99},
              '_flow_system_cache': {'expires_at': 99}}
        exec(compile(tree, 'mode-api-extracted', 'exec'), ns)
        body = {'mode': 'normal', 'confirmation': 'MODE:NORMAL', 'reason': 'test reason', 'expectedRevision': 0}
        reservation.side_effect = ValueError('conflicting operation')
        with self.assertRaises(ValueError): ns['_control_system_mode'](body, 'actor', 'request')
        apply.assert_not_called()
        reservation.side_effect = None
        with self.assertRaises(OSError): ns['_control_system_mode'](body, 'actor', 'request')
        finished.assert_called_once_with(table, operation, status='failed', error='OSError')
        self.assertEqual(ns['_system_cache']['expires_at'], 0)


if __name__ == '__main__':
    unittest.main()
