#!/usr/bin/env python3
"""Prepare reviewed runtime sources offline. Does not deploy or enable modes.

Usage: python3 scripts/prepare-mode-runtime.py ROLE INPUT OUTPUT
Refuse unexpected source layouts rather than silently leaving an egress unguarded.
Keep INPUT private; only this integration recipe belongs in the public repository.
"""
import argparse
import ast
import hashlib
from pathlib import Path

MARKER = '# DPI_MODE_HOOKS_V1'
ROLES = ('home_sender', 'home_fallback', 'home_health', 'eew_receiver',
         'eew_ingest', 'weather_sender', 'ingress', 'candidate', 'worker', 'heartbeat', 'monitor', 'direct_discord', 'training', 'legacy_sender')


def prepare(role, source):
    if MARKER in source:
        raise ValueError('Already patched: use the original snapshot for reproducible preparation')

    def replace(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise ValueError(f'{role}: expected exactly one integration point: {old[:90]!r}')
        source = source.replace(old, new, 1)

    member = role
    if role == 'direct_discord':
        member = 'direct:' + hashlib.sha256(source.encode()).hexdigest()[:12]
        class DirectGuard(ast.NodeTransformer):
            count = 0
            depth = 0
            def visit_FunctionDef(self, node):
                before = self.count
                self.depth += 1
                self.generic_visit(node)
                self.depth -= 1
                if self.count > before:
                    offset = int(isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant) and isinstance(node.body[0].value.value, str))
                    node.body.insert(offset, ast.parse('_dpi_mode_admitted_at = mode_hooks.timestamp()').body[0])
                return node
            def visit_Call(self, node):
                self.generic_visit(node)
                if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'requests' and node.func.attr == 'post':
                    if not self.depth:
                        raise ValueError("Top-level Discord send requires explicit timestamp integration")
                    self.count += 1
                    return ast.Call(func=ast.parse('mode_hooks.direct_discord_post', mode='eval').body,
                                    args=[node.func, *node.args], keywords=[*node.keywords, ast.keyword(arg='mode_admitted_at', value=ast.Name(id='_dpi_mode_admitted_at', ctx=ast.Load()))])
                return node
        transformer = DirectGuard()
        tree = transformer.visit(ast.parse(source))
        if not transformer.count:
            raise ValueError('No direct requests.post integration point')
        source = ast.unparse(ast.fix_missing_locations(tree)) + '\n'
    elif role == 'training':
        replace('    def _post(self, url: str, payload: dict) -> None:\n',
                '    def _post(self, url: str, payload: dict) -> None:\n'
                '        _dpi_mode_admitted_at = mode_hooks.timestamp()\n'
                '        mode_hooks.wait_source(_dpi_mode_admitted_at)\n')
        replace('                if self._session is not None:',
                '                mode_hooks.check_source(_dpi_mode_admitted_at)\n'
                '                if self._session is not None:')
    elif role == 'legacy_sender':
        replace('def _post_aws(msg):\n', 'def _post_aws(msg):\n    mode_hooks.prepare_source(msg)\n')
        replace('            response = _SESSION.post(',
                '            mode_hooks.check_source(mode_hooks.admitted_at(msg))\n'
                '            response = _SESSION.post(')
    elif role in {'home_sender', 'home_fallback', 'weather_sender'}:
        name = '_post_both_regions' if role == 'home_sender' else '_post_fallback_message'
        tree = ast.parse(source)
        func = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
        lines = source.splitlines(keepends=True)
        lines.insert(func.body[0].lineno - 1, '    mode_hooks.prepare_source(message)\n')
        source = ''.join(lines)
        if role in {'home_fallback', 'weather_sender'}:
            tree = ast.parse(source)
            entries = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'aws_send']
            lines = source.splitlines(keepends=True)
            for entry in sorted(entries, key=lambda n: n.lineno, reverse=True):
                offset = int(isinstance(entry.body[0], ast.Expr) and isinstance(entry.body[0].value, ast.Constant) and isinstance(entry.body[0].value.value, str))
                lines.insert(entry.body[offset].lineno - 1, '    if mode_hooks.enabled():\n        received_at = time.time() if received_at is None else received_at\n        mode_hooks.wait_source(_source_epoch_ms(received_at) / 1000)\n')
            source = ''.join(lines)
        indent = '            ' if role == 'home_sender' else '                '
        replace(indent + 'response = session.post(', indent + 'mode_hooks.before_source_http(raw_body)\n' + indent + 'response = session.post(')
        if role == 'weather_sender':
            replace('    remaining=received_seconds+wait_seconds-time.time()',
                    '    if mode_hooks.enabled():\n'
                    '        mode_hooks.wait_source(received_seconds, lambda: {"delivery": "standby" if wait_seconds else "immediate", "waitSeconds": int(wait_seconds)})\n'
                    '        wait_seconds = 0\n'
                    '        mode_hooks.check_source(received_seconds)\n'
                    '    remaining=received_seconds+wait_seconds-time.time()')
    elif role == 'eew_receiver':
        replace('        if eew_id and self.guard.eew_fast(eew_id):',
                '        fast_eew = bool(eew_id and self.guard.eew_fast(eew_id))\n        if fast_eew:')
        replace('        wait_until = received_at + wait',
                '        _dpi_mode_waited_revision = None\n'
                '        if mode_hooks.enabled():\n'
                '            decision = mode_hooks.wait_source(received_at, lambda: {"delivery": "standby" if wait else "immediate", "waitSeconds": int(wait)}, legacy_fast=fast_eew)\n'
                '            _dpi_mode_waited_revision = decision.revision\n'
                '            wait = 0\n'
                '        wait_until = received_at + wait')
        replace('        token = self.guard.claim(key, telegram_type, info)',
                '        mode_hooks.check_source(received_at)\n'
                '        token = self.guard.claim(key, telegram_type, info)')
        replace('                    "_backup_event_key": key,',
                '                    "_backup_event_key": key,\n'
                '                    **({"_dpi_mode": {"admitted_at": received_at, "waited_revision": _dpi_mode_waited_revision}} if mode_hooks.enabled() else {}),')
    elif role == 'eew_ingest':
        replace('        # Both regions receive the identical signed body and delivery_id.',
                '        mode_hooks.prepare_source(payload)\n'
                '        # Both regions receive the identical signed body and delivery_id.')
        replace('                response = self.sessions[endpoint].post(',
                '                mode_hooks.before_source_http(raw)\n'
                '                response = self.sessions[endpoint].post(')
    elif role == 'ingress':
        replace('    final_backup_event_key = _final_backup_event_key(payload)',
                '    mode_error = mode_hooks.ingress_check(payload)\n'
                '    if mode_error:\n'
                '        return _response(503 if mode_error["retryable"] else 409, {"accepted": False, **mode_error})\n'
                '    final_backup_event_key = _final_backup_event_key(payload)')
        replace('    """Acquire MRSC while SQS is being written, then dispatch after durability."""',
                '    """Acquire MRSC while SQS is being written, then dispatch after durability."""\n'
                '    if not mode_hooks.route_allowed("fast"):\n'
                '        return {"attempted": False, "mode": "control-inline", "result": "suppressed-by-maintenance"}\n'
                '    mode_hooks.wait_route("fast")')
    elif role == 'candidate':
        replace('            _process(payload, context)',
                '            _dpi_route = mode_hooks.candidate_route(payload)\n'
                '            if not mode_hooks.route_allowed(_dpi_route):\n'
                '                print(json.dumps({"route": _dpi_route, "result": "suppressed-by-maintenance"}))\n'
                '                continue\n'
                '            mode_hooks.wait_route(_dpi_route)\n'
                '            _process(payload, context)')
    elif role == 'worker':
        for old, new in (
            ('def _send_one(session, url, message):', 'def _send_one(session, url, message, mode_context=None):'),
            ('def _timed_send_one(url, message):', 'def _timed_send_one(url, message, mode_context=None):'),
            ('def _queued_send_one(url, message, queued_ns):', 'def _queued_send_one(url, message, queued_ns, mode_context=None):'),
            ('_send_one(session, url, message)', '_send_one(session, url, message, mode_context)'),
            ('_timed_send_one(url, message)', '_timed_send_one(url, message, mode_context)'),
            ('_queued_send_one, url, message, time.monotonic_ns()', '_queued_send_one, url, message, time.monotonic_ns(), event.get("_dpi_mode")'),
        ):
            replace(old, new)
        replace('        response = session.post(',
                '        mode_error = mode_hooks.worker_check(mode_context)\n'
                '        if mode_error:\n'
                '            return False, mode_error\n'
                '        response = session.post(')
    elif role == 'home_health':
        replace('\n\ndef post_all(', '\n    mode_hooks.save_heartbeat_policy(response.json())\n\n\ndef post_all(')
        replace('        "schema_version": 2,', '        "mode_runtime": mode_hooks.home_evidence(manager_payload, {name for spec in GROUPS.values() for name in spec["processes"]} | {"訓練報専用受信", "避難情報配信"}),\n        "schema_version": 2,')
        replace('        "interval_seconds": interval,', '        "interval_seconds": min(interval, 30) if mode_hooks.enabled() else interval,')
    elif role == 'heartbeat':
        anchor = 'def _response(status: int, body: dict) -> dict:\n'
        replace(anchor, anchor +
                '    if mode_hooks.enabled() and 200 <= status < 300 and body.get("ok"):\n'
                '        record = _ddb.get_item(Key={"pk": "ADMIN#SYSTEM_MODE"}, ConsistentRead=True).get("Item", {})\n'
                '        fields = ("mode", "revision", "node_overrides", "route_overrides", "notification_policy", "discard_before_epoch")\n'
                '        body["operating_mode"] = json.loads(json.dumps({k: record[k] for k in fields if k in record}, default=int))\n')
        replace('    # Also prove this regional control plane is receiving home traffic.',
                '    mode_hooks.accept_home_evidence(_ddb, payload)\n\n'
                '    # Also prove this regional control plane is receiving home traffic.')
    elif role == 'monitor':
        replace('def _notify(text: str) -> None:',
                'def _notify(text: str, kind: str = "operational") -> None:\n'
                '    if not mode_hooks.notification_allowed(kind):\n'
                '        print("Slack notification suppressed by maintenance mode")\n'
                '        return')
        replace('            _notify(f"【DPI-Bot 自動監視エラー】\\nController: {REGION_ROLE}\\n対象: {key}\\n{type(exc).__name__}: {str(exc)[:500]}")',
                '            _notify(f"【DPI-Bot 自動監視エラー】\\nController: {REGION_ROLE}\\n対象: {key}\\n{type(exc).__name__}: {str(exc)[:500]}", "critical")')
        replace('def lambda_handler(event, context):', 'def _mode_legacy_handler(event, context):')
        replace('            _reconcile(key, home, now, decision)',
                '            if not mode_hooks.monitor_allows_actions():\n'
                '                break\n'
                '            _reconcile(key, home, now, decision)')
        source += ('\n\ndef lambda_handler(event, context):\n'
                   '    _ddb.update_item(Key={"pk": CONTROLLER_PK}, UpdateExpression="SET monitor_seen_at=:t", ExpressionAttributeValues={":t": int(time.time())})\n'
                   '    return mode_hooks.coordinate_monitor(lambda: _mode_legacy_handler(event, context), context)\n')
    else:
        raise ValueError('Unknown runtime role')

    tree = ast.parse(source)
    position = 0
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == '__future__':
            position = node.end_lineno
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            position = max(position, node.end_lineno)
        else:
            break
    lines = source.splitlines(keepends=True)
    lines.insert(position, f'\n{MARKER}\nimport mode_hooks\n')
    output = ''.join(lines)
    tree = ast.parse(output)
    guards = [n for n in tree.body if isinstance(n, ast.If) and '__name__' in ast.unparse(n.test)]
    lines = output.splitlines(keepends=True)
    position = guards[0].lineno - 1 if guards else len(lines)
    lines.insert(position, f'\nmode_hooks.register({member!r}, __file__)\n\n')
    output = ''.join(lines)
    if role in {'worker', 'monitor', 'ingress', 'candidate', 'heartbeat'}:
        anchor = 'def lambda_handler(event, context):\n'
        output = output.replace(anchor, anchor + '    if event.get("_dpi_mode_probe") is True and mode_hooks.enabled():\n        return mode_hooks.probe()\n', 1)
    compile(output, f'<prepared-{role}>', 'exec')
    return output


def upgrade_v1(role, source):
    """Upgrade an already verified V1 runtime source without stacking V1 hooks."""
    if MARKER not in source:
        raise ValueError(f'{role}: V1 runtime marker missing')

    def replace(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise ValueError(f'{role}: expected exactly one V1 upgrade point: {old[:90]!r}')
        source = source.replace(old, new, 1)

    if role == 'ingress' and 'suppressed-by-maintenance' not in source:
        replace('    """Acquire MRSC while SQS is being written, then dispatch after durability."""',
                '    """Acquire MRSC while SQS is being written, then dispatch after durability."""\n'
                '    if not mode_hooks.route_allowed("fast"):\n'
                '        return {"attempted": False, "mode": "control-inline", "result": "suppressed-by-maintenance"}\n'
                '    mode_hooks.wait_route("fast")')
    elif role == 'heartbeat' and '"route_overrides"' not in source:
        replace('fields = ("mode", "revision", "node_overrides", "discard_before_epoch")',
                'fields = ("mode", "revision", "node_overrides", "route_overrides", "notification_policy", "discard_before_epoch")')
    elif role == 'monitor' and 'notification_allowed(kind)' not in source:
        replace('def _notify(text: str) -> None:',
                'def _notify(text: str, kind: str = "operational") -> None:\n'
                '    if not mode_hooks.notification_allowed(kind):\n'
                '        print("Slack notification suppressed by maintenance mode")\n'
                '        return')
        replace('            _notify(f"【DPI-Bot 自動監視エラー】\\nController: {REGION_ROLE}\\n対象: {key}\\n{type(exc).__name__}: {str(exc)[:500]}")',
                '            _notify(f"【DPI-Bot 自動監視エラー】\\nController: {REGION_ROLE}\\n対象: {key}\\n{type(exc).__name__}: {str(exc)[:500]}", "critical")')
    elif role == 'candidate' and 'candidate_route(payload)' not in source:
        replace('            _process(payload, context)',
                '            _dpi_route = mode_hooks.candidate_route(payload)\n'
                '            if not mode_hooks.route_allowed(_dpi_route):\n'
                '                print(json.dumps({"route": _dpi_route, "result": "suppressed-by-maintenance"}))\n'
                '                continue\n'
                '            mode_hooks.wait_route(_dpi_route)\n'
                '            _process(payload, context)')
    compile(source, f'<upgraded-{role}>', 'exec')
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('role', choices=ROLES)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error('Input and output must differ; preserve the original snapshot')
    result = prepare(args.role, args.input.read_text(encoding='utf-8'))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(result, encoding='utf-8')


if __name__ == '__main__':
    main()
