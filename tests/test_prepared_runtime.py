"""Optional integration tests against privately downloaded, prepared sources.

DPI_PREPARED_RUNTIME_DIR=/path/to/prepared python3 -m unittest discover ...
The production source files themselves must never be committed to this repo.
"""
import ast
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'aws/channel-directory-api'))
import mode_hooks
from delivery_gate import DeliveryGate, DeliveryBlocked

ROOT = os.environ.get('DPI_PREPARED_RUNTIME_DIR')


def extracted(role, name):
    tree = ast.parse((Path(ROOT) / f'{role}.py').read_text())
    matches = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name]
    if len(matches) != 1:
        raise ValueError(f'Expected one {role}.{name}, found {len(matches)}')
    tree.body = matches
    return compile(tree, role, 'exec')


@unittest.skipUnless(ROOT, 'Set DPI_PREPARED_RUNTIME_DIR to test private prepared runtime snapshots')
class PreparedRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'DPI_MODE_ENABLED': '1', 'DPI_MODE_NODE': 'aws-tokyo'})
        self.env.start()
        self.record = {'mode': 'emergency_stop', 'revision': 10}
        self.previous_gate = mode_hooks._gate
        mode_hooks._gate = DeliveryGate(lambda: self.record)

    def tearDown(self):
        mode_hooks._gate = self.previous_gate
        self.env.stop()

    def test_actual_worker_never_calls_http_during_stop(self):
        ns = {'mode_hooks': mode_hooks, '_normalize_webhook_url': lambda u: u,
              '_url_hash': lambda u: 'hash', '_auth_cache_get': lambda _: None}
        exec(extracted('worker', '_send_one'), ns)
        session = Mock()
        success, error = ns['_send_one'](session, 'https://example.invalid', {}, {'admitted_at': time.time()})
        self.assertFalse(success)
        self.assertEqual(error['error_kind'], 'emergency_stop')
        session.post.assert_not_called()

    def test_actual_home_http_checks_before_every_attempt(self):
        os.environ['DPI_MODE_NODE'] = 'home'
        session = Mock()
        ns = {'mode_hooks': mode_hooks, 'Callable': __import__('typing').Callable,
              'requests': Mock(), 'Any': __import__('typing').Any, 'time': time,
              '_endpoint_region': lambda _: 'tokyo', 'TOTAL_ATTEMPTS': 2,
              '_now_epoch_ms': lambda: 1000, 'REQUEST_TIMEOUT': (1, 2)}
        ns['requests'].exceptions.RequestException = ConnectionError
        exec(extracted('home_sender', '_post_endpoint'), ns)
        with self.assertRaises(DeliveryBlocked):
            ns['_post_endpoint']('https://example.invalid', b'{}', {}, lambda: (session, True))
        session.post.assert_not_called()

    def test_actual_eew_receiver_stops_before_claim(self):
        os.environ['DPI_MODE_NODE'] = 'tokyo-eew'
        ns = {'mode_hooks': mode_hooks, 'time': time, 'LOG': Mock(),
              'delivery_wait': lambda *a, **k: (3, 'NORMAL'), '_active_eew_id': lambda *a: (None, False)}
        exec(extracted('eew_receiver', '_process'), ns)
        receiver = Mock()
        receiver.settings.region = 'ap-northeast-1'
        with self.assertRaises(DeliveryBlocked):
            ns['_process'](receiver, {}, time.time(), 'eew', 'VXSE43', {}, 'key', 'public', None, None)
        receiver.guard.claim.assert_not_called()
        receiver.ingest.post.assert_not_called()

    def test_actual_ingress_rejects_before_source_guard(self):
        guard = Mock()
        ns = {'mode_hooks': mode_hooks, '_response': lambda status, body: (status, body),
              '_final_backup_event_key': guard}
        exec(extracted('ingress', '_ingest'), ns)
        status, body = ns['_ingest']({'data': 'eew', 'url': [], 'times': time.time()})
        self.assertEqual(status, 409)
        self.assertFalse(body['accepted'])
        guard.assert_not_called()

    def test_actual_eew_http_stops_before_network(self):
        os.environ['DPI_MODE_NODE'] = 'tokyo-eew'
        ns = {'mode_hooks': mode_hooks, 'hmac': hmac, 'hashlib': hashlib,
              'time': time, 'requests': Mock(), 'Any': __import__('typing').Any,
              'Optional': __import__('typing').Optional}
        ns['requests'].RequestException = ConnectionError
        exec(extracted('eew_ingest', '_post_one'), ns)
        sender = Mock()
        sender.attempts = 3
        sender.secret = b'test-only-secret'
        sender.sessions = {'https://example.invalid': Mock()}
        with self.assertRaises(DeliveryBlocked):
            ns['_post_one'](sender, 'https://example.invalid', b'{}')
        sender.sessions['https://example.invalid'].post.assert_not_called()


if __name__ == '__main__':
    unittest.main()
