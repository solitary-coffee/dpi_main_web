#!/usr/bin/env python3
"""Prepare or install runtime hooks in a checkout/unpacked Lambda ZIP.

Defaults to a read-only plan. --apply preserves originals, writes all modules,
then atomically enables the config LAST. It never starts/stops any process and
never sends a notification. Restart senders after installation.
"""
import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import time
import uuid

HERE = Path(__file__).resolve().parent
MODULES = HERE.parent / 'aws/channel-directory-api'
spec = importlib.util.spec_from_file_location('prepare_mode_runtime', HERE / 'prepare-mode-runtime.py')
prepare_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_module)

COMMON = ('operating_modes.py', 'delivery_gate.py', 'mode_hooks.py', 'mode_transition.py', 'mode_observation.py', 'mode_lambda_entry.py')
LAYOUTS = {
    'home': {'dpi_aws_sender_core.py': 'home_sender', 'wss_hais_new_aws.py': 'home_fallback', 'dpi_home_health_agent.py': 'home_health'},
    'eew': {'backup_receiver.py': 'eew_receiver', 'dpi_backup/ingest.py': 'eew_ingest'},
    'weather': {'dpi_aws_sender_core.py': 'home_sender', 'wss_hais_new_aws.py': 'weather_sender'},
    'worker': {'lambda_function.py': 'worker'},
    'ingress': {'control/lambda_function.py': 'ingress'},
    'candidate': {'candidate/lambda_function.py': 'candidate'},
    'heartbeat': {'home_heartbeat.py': 'heartbeat'},
    'monitor': {'auto_failover_monitor.py': 'monitor'},
}
DIRECT_FILES = ('wss_disc_senyo_zisin.py', 'wss_hais_disc_osirase.py',
                'wss_hais_disc_test_all.py', 'wss_hais_disc_tunami.py', 'wss_hais_keiho.py', 'hinans.py')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def prepare_bundle(root, kind, node, region, authority, table, allow_upgrade=False):
    targets = dict(LAYOUTS[kind])
    mandatory = set(targets.values())
    if kind in {'home', 'weather'}:
        for name in DIRECT_FILES:
            if (root / name).is_file():
                targets[name] = 'direct_discord'
        if (root / 'wss_hais_aws_osaka.py').is_file():
            targets['wss_hais_aws_osaka.py'] = 'legacy_sender'
        if (root / 'dpi_training_delivery.py').is_file():
            targets['dpi_training_delivery.py'] = 'training'
    if kind == 'eew' and (root / 'dpi_training_delivery.py').is_file():
        targets['dpi_training_delivery.py'] = 'training'
    if kind == 'eew' and (root / 'dpi_backup/training.py').is_file():
        targets['dpi_backup/training.py'] = 'training'
    installation = str(uuid.uuid4())
    files, members, optional = {}, {}, {}
    for relative, role in targets.items():
        path = root / relative
        source = path.read_text(encoding='utf-8')
        if prepare_module.MARKER in source:
            if not allow_upgrade:
                raise ValueError('Already patched: restore the original snapshot or use the verified AWS upgrade workflow')
            output = prepare_module.upgrade_v1(role, source).encode()
        else:
            output = prepare_module.prepare(role, source).encode()
        files[relative] = output
        tree = ast.parse(output.decode())
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and ast.unparse(n.func) == 'mode_hooks.register']
        member = ast.literal_eval(calls[-1].args[0])
        (members if role in mandatory else optional)[member] = sha(output)
    for name in COMMON:
        files[name] = (MODULES / name).read_bytes()
    manifest = {'installation_id': installation, 'created_at': int(time.time()), 'node': node,
                'members': members, 'optional_members': optional,
                'files': {name: sha(data) for name, data in files.items()}}
    runtime_root = Path('/var/task') if kind in {'worker', 'ingress', 'candidate', 'heartbeat', 'monitor'} else root
    state = runtime_root / '.dpi-mode'
    config = {'DPI_MODE_ENABLED': '1', 'DPI_MODE_NODE': node,
              'DPI_MODE_REGION': region, 'DPI_MODE_AUTHORITY_REGION': authority,
              'DPI_MODE_STATE_TABLE': table, 'DPI_MODE_ROOT': str(runtime_root),
              'DPI_MODE_FILE': str(state / 'policy.json'),
              'DPI_MODE_MANIFEST': str(state / 'manifest.json'),
              'DPI_MODE_ACK_DIRECTORY': str(state / 'acks')}
    return files, manifest, config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=LAYOUTS)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--node', required=True, choices=('home', 'tokyo-eew', 'tokyo-weather', 'osaka-eew', 'osaka-weather', 'aws-tokyo', 'aws-osaka'))
    parser.add_argument('--region', required=True, choices=('ap-northeast-1', 'ap-northeast-3'))
    parser.add_argument('--authority-region', default='ap-northeast-1')
    parser.add_argument('--table', default='DPI-BackupFleetState-v51')
    parser.add_argument('--upgrade-v2', action='store_true', help='upgrade an existing verified V1 hook installation')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    files, manifest, config = prepare_bundle(root, args.kind, args.node, args.region,
                                             args.authority_region, args.table,
                                             allow_upgrade=args.upgrade_v2)
    print(json.dumps({'node': args.node, 'kind': args.kind, 'files': sorted(files),
                      'apply': args.apply, 'restart_required': True}, ensure_ascii=False, indent=2))
    if not args.apply:
        return
    backup = root / '.dpi-mode' / 'backups' / manifest['installation_id']
    backup.mkdir(parents=True)
    original_paths = [*files, '.dpi-mode/manifest.json', 'mode_runtime_config.json']
    existed = {}
    for relative in original_paths:
        original = root / relative
        existed[relative] = original.exists()
        if original.exists():
            saved = backup / relative
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, saved)
    (backup / 'rollback.json').write_text(json.dumps(existed), encoding='utf-8')
    try:
        for relative, data in files.items():
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + '.mode-new')
            temporary.write_bytes(data)
            temporary.replace(target)
        (root / '.dpi-mode/manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        target = root / 'mode_runtime_config.json'
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps(config), encoding='utf-8')
        temporary.replace(target)
    except Exception:
        for relative, was_present in existed.items():
            target = root / relative
            if was_present:
                shutil.copy2(backup / relative, target)
            elif target.exists():
                target.unlink()
        raise
    print('Installed. Original files and rollback manifest:', backup)
    print('Restart the affected processes; capability and application remain unconfirmed until ACKs arrive.')


if __name__ == '__main__':
    main()
