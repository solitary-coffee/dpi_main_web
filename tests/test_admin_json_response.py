import json
from decimal import Decimal
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "aws/channel-directory-api"))

from json_support import json_default


class AdminJsonResponseTests(unittest.TestCase):
    def test_nested_dynamodb_decimals_are_json_serializable(self):
        payload = {
            "revision": Decimal("7"),
            "waitSeconds": Decimal("2.5"),
            "nodes": [{"count": Decimal("3")}],
        }

        encoded = json.dumps(payload, default=json_default)

        self.assertEqual(
            json.loads(encoded),
            {"revision": 7, "waitSeconds": 2.5, "nodes": [{"count": 3}]},
        )

    def test_unknown_types_still_raise(self):
        with self.assertRaises(TypeError):
            json.dumps({"value": object()}, default=json_default)


if __name__ == "__main__":
    unittest.main()
