"""Offline validation of the safe AWS schema-v3 Lambda ZIP patch.

Run: python3 -m unittest tests/test_aws_supporter_snapshot_v3.py
"""
import io
import sys
from pathlib import Path
import unittest
import zipfile
from contextlib import redirect_stdout

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "aws" / "channel-directory-api"))
from deploy_schema_v3 import patch, repack, verify

SOURCE = '''
import time
def _clean(value, limit):
    return str(value).strip()[:limit] if value is not None else ""
def _integer(value, default):
    try: return int(value)
    except (ValueError, TypeError): return default
def _validate_supporter_snapshot(value, now=None):
    if not isinstance(value, dict) or int(value.get("schemaVersion", 0)) != 1:
        raise ValueError("schema")
    version = _clean(value.get("version"), 128)
    generated_at = _integer(value.get("generatedAt"), 0)
    expires_at = _integer(value.get("expiresAt"), 0)
    current = int(time.time() if now is None else now)
    if not version or generated_at <= 0 or expires_at <= current + 60 or expires_at > current + 172800:
        raise ValueError("time")
    rules = value.get("rules")
    if not isinstance(rules, list) or len(rules) > 10000: raise ValueError("rules")
    normalized_rules = []
    for raw in rules:
        if not isinstance(raw, dict): raise ValueError("rule")
        rule = dict(raw)
        rule_id = _clean(rule.get("id"), 80)
        guild_id = _clean(rule.get("guildId"), 25)
        channels = rule.get("channelIds")
        if not rule_id or _clean(rule.get("type"), 30) not in {"earthquake", "eew", "weather", "rain-radar"} or not guild_id.isdigit() or not 15 <= len(guild_id) <= 25 or not isinstance(channels, list) or not channels or len(channels) > 20:
            raise ValueError("rule")
        normalized_channels = []
        for channel in channels:
            channel_id = _clean(channel, 25)
            if not channel_id.isdigit() or not 15 <= len(channel_id) <= 25: raise ValueError("channel")
            if channel_id not in normalized_channels: normalized_channels.append(channel_id)
        rule["id"] = rule_id
        rule["guildId"] = guild_id
        rule["channelId"] = normalized_channels[0]
        rule["channelIds"] = normalized_channels
        normalized_rules.append(rule)
    routing = value.get("routing") if isinstance(value.get("routing"), dict) else {}
    dedicated_min = _integer(routing.get("dedicatedMinDestinations"), 100)
    urls_per_worker = _integer(routing.get("urlsPerWorker"), 25)
    max_workers = _integer(routing.get("maxDedicatedWorkers"), 10)
    if dedicated_min < 1 or urls_per_worker < 1 or not 1 <= max_workers <= 10: raise ValueError("routing")
    return {
        "schemaVersion": 1,
        "version": version,
        "generatedAt": generated_at,
        "expiresAt": expires_at,
        "routing": {"dedicatedMinDestinations": dedicated_min, "urlsPerWorker": urls_per_worker, "maxDedicatedWorkers": max_workers},
        "rules": normalized_rules,
    }
def unrelated(): return "safe"
'''


class LambdaSnapshotV3Tests(unittest.TestCase):
    def test_old_v1_only_is_upgraded(self):
        changed, yes = patch(SOURCE)
        self.assertTrue(yes)
        self.assertEqual(verify(changed), {1:"accepted", 2:"accepted", 3:"accepted", 4:"rejected"})
        same, no = patch(changed)
        self.assertFalse(no)
        self.assertEqual(same, changed)

    def test_preserves_unrelated_zip_content(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("lambda_function.py", SOURCE)
            z.writestr("local_delivery_gate.py", b"original code must not change")
        result, changed = repack(data.getvalue())
        self.assertTrue(changed)
        with zipfile.ZipFile(io.BytesIO(result)) as z:
            self.assertEqual(z.read("local_delivery_gate.py"), b"original code must not change")
            self.assertIn(b"not in (1, 2, 3)", z.read("lambda_function.py"))

    def test_unexpected_live_function_refused(self):
        with self.assertRaisesRegex(RuntimeError, "Unrecognized deployed validator"):
            patch(SOURCE.replace(' != 1', ' < 4'))

    def test_missing_lambda_entrypoint_refused(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as z: z.writestr("another.py", "print(1)")
        with self.assertRaisesRegex(RuntimeError, "Missing/duplicate"):
            repack(data.getvalue())


if __name__ == "__main__":
    unittest.main()
