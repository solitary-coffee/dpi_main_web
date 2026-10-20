#!/usr/bin/env python3
"""CloudShell rollout: prepare a reviewable plan, then apply that exact plan.

python3 scripts/deploy-mode-aws.py --directory /tmp/dpi-mode-rollout
python3 scripts/deploy-mode-aws.py --directory /tmp/dpi-mode-rollout --apply

Requires boto3 (present in CloudShell). Never changes layers, sends a bulletin,
switches system mode, starts EC2, or publishes deployment proof before probes.
"""
import argparse
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import time
import urllib.request
import uuid
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('runtime_install', HERE / 'install-mode-runtime.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
REGIONS = ('ap-northeast-1', 'ap-northeast-3')
WORKER = re.compile(r'^(?:new_(?:EEW|EEW_SIND|ZISIN|TUNAMI|KEIHO|TOKYO_SUB|kisyo|kisyo2|KAZAN|OSAKA_SUB)_\d+|dpi-delivery-(?:primary|backup)-(?:TOKYO|OSAKA))$')
COUNTS = {'ap-northeast-1': {'new_EEW': 16, 'new_EEW_SIND': 10, 'new_ZISIN': 16, 'new_TUNAMI': 10, 'new_KEIHO': 10, 'new_TOKYO_SUB': 10},
          'ap-northeast-3': {'new_kisyo': 10, 'new_kisyo2': 10, 'new_KAZAN': 10, 'new_OSAKA_SUB': 10}}
PROBE_MODULE = {'worker': 'lambda_function', 'ingress': 'control.lambda_function',
                'heartbeat': 'home_heartbeat', 'monitor': 'auto_failover_monitor'}


def code_hash(data):
    return base64.b64encode(hashlib.sha256(data).digest()).decode()


def kind_for(name):
    if WORKER.fullmatch(name): return 'worker'
    if name in {'dpi-ha-control-TOKYO', 'dpi-ha-control-OSAKA'}: return 'ingress'
    if name == 'dpi-backup-home-heartbeat': return 'heartbeat'
    if name == 'dpi-backup-auto-failover-monitor': return 'monitor'
    return None


def unpack(data, directory):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for item in archive.infolist():
            path = PurePosixPath(item.filename)
            if path.is_absolute() or '..' in path.parts or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Unsafe archive member')
            archive.extract(item, directory)


def pack(directory):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts:
                archive.write(path, path.relative_to(directory).as_posix())
    return buffer.getvalue()


def prepare(session, directory, account, table):
    if (directory / 'plan.json').exists():
        raise ValueError('Plan already exists. Apply it or use another directory; originals are never overwritten.')
    directory.mkdir(parents=True, exist_ok=True)
    plan = {'account': account, 'table': table, 'authority_region': REGIONS[0],
            'installation_id': str(uuid.uuid4()), 'created_at': int(time.time()), 'functions': []}
    downloaded = {}
    for region in REGIONS:
        client = session.client('lambda', region_name=region)
        functions = [f for page in client.get_paginator('list_functions').paginate() for f in page['Functions']]
        names = {f['FunctionName'] for f in functions}
        required = {f'{prefix}_{i}' for prefix, count in COUNTS[region].items() for i in range(1, count + 1)}
        required |= {'dpi-ha-control-' + ('TOKYO' if region == REGIONS[0] else 'OSAKA'), 'dpi-backup-home-heartbeat', 'dpi-backup-auto-failover-monitor'}
        if required - names:
            raise ValueError(f'{region}: required functions missing: {sorted(required - names)}')
        for fn in functions:
            kind = kind_for(fn['FunctionName'])
            if not kind: continue
            name = fn['FunctionName']
            response = client.get_function(FunctionName=name)
            config = response['Configuration']
            if config['Handler'] == 'mode_lambda_entry.handler':
                raise ValueError(f'{name}: already installed. Resume its existing rollout plan instead.')
            old_sha = config['CodeSha256']
            if old_sha not in downloaded:
                with urllib.request.urlopen(response['Code']['Location'], timeout=60) as stream:
                    downloaded[old_sha] = stream.read()
            original = downloaded[old_sha]
            if code_hash(original) != old_sha: raise ValueError('Downloaded code hash mismatch')
            work = directory / region / name
            work.mkdir(parents=True)
            (work / 'original.zip').write_bytes(original)
            source = work / 'source'
            unpack(original, source)
            node = 'aws-tokyo' if region == REGIONS[0] else 'aws-osaka'
            files, manifest, settings = installer.prepare_bundle(source, kind, node, region, REGIONS[0], table)
            manifest['installation_id'] = plan['installation_id']
            settings.update(DPI_MODE_ORIGINAL_HANDLER=config['Handler'], DPI_MODE_PROBE_MODULE=PROBE_MODULE[kind])
            for relative, data in files.items(): (source / relative).write_bytes(data)
            (source / '.dpi-mode').mkdir(exist_ok=True)
            (source / '.dpi-mode/manifest.json').write_text(json.dumps(manifest))
            (source / 'mode_runtime_config.json').write_text(json.dumps(settings))
            candidate = pack(source)
            if len(candidate) > 50 * 1024 * 1024: raise ValueError('Deployment ZIP exceeds direct upload limit')
            (work / 'prepared.zip').write_bytes(candidate)
            plan['functions'].append({'region': region, 'name': name, 'kind': kind,
                                      'original_handler': config['Handler'], 'role': config['Role'].split('/')[-1],
                                      'old_sha': old_sha, 'new_sha': code_hash(candidate), 'members': manifest['members']})
            shutil.rmtree(source)
    (directory / 'plan.json').write_text(json.dumps(plan, indent=2))
    print(f"Prepared {len(plan['functions'])} functions. No AWS writes. Plan: {directory / 'plan.json'}")


def apply(session, directory, account):
    plan = json.loads((directory / 'plan.json').read_text())
    if plan['account'] != account: raise ValueError('Plan/account mismatch')
    # Validate all source revisions before the first mutation. Partial previous
    # application of this exact plan is resumable; unrelated changes are refused.
    for fn in plan['functions']:
        client = session.client('lambda', region_name=fn['region'])
        current = client.get_function_configuration(FunctionName=fn['name'])
        if current['CodeSha256'] not in {fn['old_sha'], fn['new_sha']}:
            raise ValueError(f"{fn['name']}: changed since preparation")
        if current['Handler'] not in {fn['original_handler'], 'mode_lambda_entry.handler'} or current['Role'].split('/')[-1] != fn['role']:
            raise ValueError(f"{fn['name']}: handler/role changed since preparation")
        for filename, expected in [('original.zip', fn['old_sha']), ('prepared.zip', fn['new_sha'])]:
            if code_hash((directory / fn['region'] / fn['name'] / filename).read_bytes()) != expected:
                raise ValueError('Local artifact hash mismatch')
    state = session.resource('dynamodb', region_name=plan['authority_region']).Table(plan['table'])
    state.update_item(Key={'pk': 'ADMIN#SYSTEM_MODE'},
                      UpdateExpression='SET #mode=if_not_exists(#mode,:auto), revision=if_not_exists(revision,:zero)',
                      ExpressionAttributeNames={'#mode': 'mode'}, ExpressionAttributeValues={':auto': 'automatic', ':zero': 0})
    roles = {}
    for fn in plan['functions']:
        actions = roles.setdefault(fn['role'], {'dynamodb:GetItem'})
        if fn['kind'] == 'monitor': actions.add('dynamodb:UpdateItem')
        if fn['kind'] == 'heartbeat': actions.add('dynamodb:PutItem')
    iam = session.client('iam')
    for role, actions in roles.items():
        iam.put_role_policy(RoleName=role, PolicyName='DpiOperatingModeRuntimeV1', PolicyDocument=json.dumps({
            'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Action': sorted(actions),
            'Resource': [f"arn:aws:dynamodb:{region}:{account}:table/{plan['table']}" for region in REGIONS]}]}))
    for fn in plan['functions']:
        client = session.client('lambda', region_name=fn['region'])
        deploy_function(client, directory, fn)
        print('Verified without sending:', fn['region'], fn['name'])
    for region in REGIONS:
        functions = {fn['name']: fn['new_sha'] for fn in plan['functions'] if fn['region'] == region}
        node = 'aws-tokyo' if region == REGIONS[0] else 'aws-osaka'
        state.put_item(Item={'pk': f'MODE_RUNTIME#{node}', 'protocol_version': 1,
                            'installation_id': plan['installation_id'], 'installed_at': plan['created_at'],
                            'coverage_digest': hashlib.sha256(json.dumps(functions, sort_keys=True).encode()).hexdigest(),
                            'capability_verified': True, 'verified': False, 'functions': functions,
                            'observed_at': 0, 'applied_revision': -1})
    print('AWS capability verified. No mode switch, bulletin, or EC2 operation was performed.')


def rollback_function(client, directory, fn):
    current = client.get_function_configuration(FunctionName=fn['name'])
    if current['CodeSha256'] != fn['new_sha']:
        raise ValueError('Rollback refused: function changed outside this plan')
    client.update_function_code(FunctionName=fn['name'], RevisionId=current['RevisionId'],
                                ZipFile=(directory / fn['region'] / fn['name'] / 'original.zip').read_bytes())
    client.get_waiter('function_updated_v2').wait(FunctionName=fn['name'])
    current = client.get_function_configuration(FunctionName=fn['name'])
    client.update_function_configuration(FunctionName=fn['name'], RevisionId=current['RevisionId'], Handler=fn['original_handler'])
    client.get_waiter('function_updated_v2').wait(FunctionName=fn['name'])


def deploy_function(client, directory, fn):
    restored_concurrency = False
    try:
        current = client.get_function_configuration(FunctionName=fn['name'])
        if current['CodeSha256'] == fn['old_sha']:
            client.update_function_code(FunctionName=fn['name'], RevisionId=current['RevisionId'],
                                        ZipFile=(directory / fn['region'] / fn['name'] / 'prepared.zip').read_bytes())
            client.get_waiter('function_updated_v2').wait(FunctionName=fn['name'])
            current = client.get_function_configuration(FunctionName=fn['name'])
        if current['CodeSha256'] != fn['new_sha']:
            raise ValueError('Function changed outside this plan')
        if current['Handler'] == fn['original_handler']:
            client.update_function_configuration(FunctionName=fn['name'], RevisionId=current['RevisionId'], Handler='mode_lambda_entry.handler')
            client.get_waiter('function_updated_v2').wait(FunctionName=fn['name'])
        elif current['Handler'] != 'mode_lambda_entry.handler':
            raise ValueError('Handler changed outside this plan')
        # Old manual control disabled monitors with concurrency=0. A private
        # probe needs one slot; restore the previous value even on exceptions.
        concurrency = client.get_function_concurrency(FunctionName=fn['name']).get('ReservedConcurrentExecutions')
        if concurrency == 0:
            if fn['kind'] != 'monitor':
                raise ValueError('Delivery function is intentionally disabled; refusing to enable it')
            client.put_function_concurrency(FunctionName=fn['name'], ReservedConcurrentExecutions=1)
            restored_concurrency = True
        response = client.invoke(FunctionName=fn['name'], Payload=b'{"_dpi_mode_probe":true}')
        proof = json.loads(response['Payload'].read())
        expected_node = 'aws-tokyo' if fn['region'] == REGIONS[0] else 'aws-osaka'
        if (response.get('FunctionError') or not proof.get('mode_probe') or not proof.get('enabled')
                or proof.get('node') != expected_node or proof.get('members') != fn['members']
                or not proof.get('acknowledgement', {}).get('gate_loaded')):
            raise ValueError(f"{fn['name']}: no-send runtime probe failed")
    except Exception:
        if restored_concurrency:
            client.put_function_concurrency(FunctionName=fn['name'], ReservedConcurrentExecutions=0)
            restored_concurrency = False
        current = client.get_function_configuration(FunctionName=fn['name'])
        if current['CodeSha256'] == fn['new_sha']:
            rollback_function(client, directory, fn)
        raise
    finally:
        if restored_concurrency:
            client.put_function_concurrency(FunctionName=fn['name'], ReservedConcurrentExecutions=0)


def main():
    import boto3
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--account', default='458768390689')
    parser.add_argument('--table', default='DPI-BackupFleetState-v51')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    session = boto3.Session()
    if session.client('sts').get_caller_identity()['Account'] != args.account:
        raise ValueError('Wrong AWS account')
    if args.apply: apply(session, args.directory.resolve(), args.account)
    else: prepare(session, args.directory.resolve(), args.account, args.table)


if __name__ == '__main__':
    main()
