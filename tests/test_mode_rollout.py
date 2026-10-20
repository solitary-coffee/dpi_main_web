"""No AWS calls: failure/resume paths for the production update helper."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rollout', ROOT / 'scripts/deploy-mode-aws.py')
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


class RolloutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.fn = dict(region='ap-northeast-1', name='monitor', kind='monitor', old_sha='old',
                       new_sha='new', original_handler='old.handler', members={'monitor': 'sha'})
        folder = self.directory / self.fn['region'] / 'monitor'
        folder.mkdir(parents=True)
        (folder / 'original.zip').write_bytes(b'old')
        (folder / 'prepared.zip').write_bytes(b'new')
        self.state = {'CodeSha256': 'old', 'Handler': 'old.handler', 'RevisionId': 'revision'}
        self.client = Mock()
        self.client.get_function_configuration.side_effect = lambda **kw: dict(self.state)
        self.client.update_function_code.side_effect = lambda **kw: self.state.update(CodeSha256=kw['ZipFile'].decode())
        self.client.update_function_configuration.side_effect = lambda **kw: self.state.update(Handler=kw['Handler'])
        self.client.get_function_concurrency.return_value = {'ReservedConcurrentExecutions': 0}
        self.client.invoke.return_value = {'Payload': io.BytesIO(json.dumps({
            'mode_probe': True, 'enabled': True, 'node': 'aws-tokyo', 'members': self.fn['members'],
            'acknowledgement': {'gate_loaded': True}}).encode())}

    def test_disabled_monitor_probe_restores_concurrency(self):
        rollout.deploy_function(self.client, self.directory, self.fn)
        self.assertEqual(self.state['Handler'], 'mode_lambda_entry.handler')
        self.assertEqual([c.kwargs['ReservedConcurrentExecutions'] for c in self.client.put_function_concurrency.call_args_list], [1, 0])
        self.assertEqual(json.loads(self.client.invoke.call_args.kwargs['Payload']), {'_dpi_mode_probe': True})

    def test_invoke_exception_rolls_back_code_and_handler(self):
        self.client.invoke.side_effect = RuntimeError('invoke failed')
        with self.assertRaises(RuntimeError): rollout.deploy_function(self.client, self.directory, self.fn)
        self.assertEqual(self.state['CodeSha256'], 'old')
        self.assertEqual(self.state['Handler'], 'old.handler')
        self.assertEqual(self.client.put_function_concurrency.call_args.kwargs['ReservedConcurrentExecutions'], 0)

    def test_partial_code_update_resumes_without_reupload(self):
        self.state['CodeSha256'] = 'new'
        rollout.deploy_function(self.client, self.directory, self.fn)
        self.client.update_function_code.assert_not_called()
        self.assertEqual(self.state['Handler'], 'mode_lambda_entry.handler')

    def test_disabled_delivery_worker_never_enabled(self):
        self.fn['kind'] = 'worker'
        with self.assertRaisesRegex(ValueError, 'intentionally disabled'):
            rollout.deploy_function(self.client, self.directory, self.fn)
        self.client.put_function_concurrency.assert_not_called()
        self.client.invoke.assert_not_called()
        self.assertEqual(self.state['CodeSha256'], 'old')

    def test_external_code_change_is_not_overwritten(self):
        self.state['CodeSha256'] = 'other'
        with self.assertRaises(ValueError): rollout.deploy_function(self.client, self.directory, self.fn)
        self.client.update_function_code.assert_not_called()
