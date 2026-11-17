"""Snapshot timestamps: a future generatedAt must never be accepted (it would block later updates)."""
import unittest

from test_aws_supporter_snapshot_v4 import NOW, repo_validator, snapshot


class SnapshotTimeBounds(unittest.TestCase):
    def setUp(self):
        self.validate = repo_validator()

    def test_future_generated_at_rejected(self):
        value = snapshot(1, {"type": "earthquake"})
        value["generatedAt"] = NOW + 3600
        with self.assertRaises(ValueError):
            self.validate(value, now=NOW)

    def test_small_clock_skew_and_normal_values_accepted(self):
        value = snapshot(1, {"type": "earthquake"})
        value["generatedAt"] = NOW + 120
        self.assertEqual(self.validate(value, now=NOW)["generatedAt"], NOW + 120)

    def test_generated_after_expiry_rejected(self):
        value = snapshot(1, {"type": "earthquake"})
        value["generatedAt"], value["expiresAt"] = NOW + 200, NOW + 100
        with self.assertRaises(ValueError):
            self.validate(value, now=NOW)


if __name__ == "__main__":
    unittest.main()
