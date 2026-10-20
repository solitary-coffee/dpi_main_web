#!/usr/bin/env python3
"""Prepare reviewed runtime sources offline. Does not deploy or enable modes.

Usage: python3 scripts/prepare-mode-runtime.py ROLE INPUT OUTPUT
Refuse unexpected source layouts rather than silently leaving an egress unguarded.
Keep INPUT private; only this integration recipe belongs in the public repository.
"""
import argparse
import ast
from pathlib import Path

MARKER = '# DPI_MODE_HOOKS_V1'
ROLES = ('home_sender', 'home_fallback', 'home_health', 'eew_receiver',
         'eew_ingest', 'weather_sender', 'ingress', 'worker', 'heartbeat')


def prepare(role, source):
    if MARKER in source:
        raise ValueError('Already patched: use the original snapshot for reproducible preparation')

    def replace(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise ValueError(f'{role}: expected exactly one integration point: {old[:90]!r}')
        source = source.replace(old, new, 1)

    if role in {'home_sender', 'home_fallback', 'weather_sender'}:
        name = '_post_both_regions' if role == 'home_sender' else '_post_fallback_message'
        tree = ast.parse(source)
        func = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
        lines = source.splitlines(keepends=True)
        lines.insert(func.body[0].lineno - 1, '    mode_hooks.prepare_source(message)\n')
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
        replace('        wait_until = received_at + wait',
                '        if mode_hooks.enabled():\n'
                '            mode_hooks.wait_source(received_at, lambda: {"delivery": "standby" if wait else "immediate", "waitSeconds": int(wait)})\n'
                '            wait = 0\n'
                '        wait_until = received_at + wait')
        replace('        token = self.guard.claim(key, telegram_type, info)',
                '        mode_hooks.check_source(received_at)\n'
                '        token = self.guard.claim(key, telegram_type, info)')
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
    elif role == 'heartbeat':
        anchor = 'def _response(status: int, body: dict) -> dict:\n'
        replace(anchor, anchor +
                '    if mode_hooks.enabled() and 200 <= status < 300 and body.get("ok"):\n'
                '        record = _ddb.get_item(Key={"pk": "ADMIN#SYSTEM_MODE"}, ConsistentRead=True).get("Item", {})\n'
                '        fields = ("mode", "revision", "node_overrides", "discard_before_epoch")\n'
                '        body["operating_mode"] = json.loads(json.dumps({k: record[k] for k in fields if k in record}, default=int))\n')
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
    compile(output, f'<prepared-{role}>', 'exec')
    return output


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
