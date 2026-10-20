import ast
import hashlib
import hmac
import json
import pathlib
import sys
import time
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import Mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "aws/channel-directory-api"))
from xml_delivery import render_xml
from operating_modes import build_plan, runtime_readiness, RUNTIME_COMPONENTS

XML = '<Report><Control><Title>地震情報</Title><Status>通常</Status></Control><Head><Title>震源・震度情報</Title></Head><Body><Text>地震情報の本文</Text></Body></Report>'
SUMMARY = {"headline": "震源・震度情報", "status": "通常", "controlTitle": "地震情報"}


class XmlTests(unittest.TestCase):
    def test_deterministic_preview(self):
        a = render_xml(XML, SUMMARY, "zisin", "地震情報")
        self.assertEqual(a, render_xml(XML, SUMMARY, "zisin", "地震情報"))
        self.assertEqual(a["messages"][0]["allowed_mentions"], {"parse": []})
        for route, slot in [("eew", "地震情報"), ("zisin", "別の枠")]:
            self.assertNotEqual(a["previewDigest"], render_xml(XML, SUMMARY, route, slot)["previewDigest"])
        self.assertEqual(a["rendererVersion"], "xml-production-embed-v2")
        self.assertIn("同じ種別別Embed形式", a["formatNote"])
        self.assertEqual(a["messages"][0]["username"], "防災情報提供BOT")
        self.assertEqual(a["messages"][0]["embeds"][0]["color"], 15258703)
        self.assertNotIn("Body /", a["messages"][0]["embeds"][0]["description"])

    def test_earthquake_uses_production_summary_layout(self):
        xml = '''<Report><Control><Title>地震情報</Title><Status>通常</Status></Control><Head>
        <Title>震源・震度情報</Title><InfoType>発表</InfoType><Serial>2</Serial><Headline><Text>各地の震度情報</Text></Headline></Head><Body>
        <Earthquake><OriginTime>2026-10-20T10:00:00+09:00</OriginTime><Hypocenter><Area><Name>東京湾</Name>
        <Coordinate description="北緯35度 東経140度"/></Area></Hypocenter><Magnitude description="マグニチュード4.2"/></Earthquake>
        <Intensity><Observation><MaxInt>4</MaxInt></Observation></Intensity><Comments><ForecastComment><Text>津波の心配はありません。</Text></ForecastComment></Comments>
        </Body></Report>'''
        embed = render_xml(xml, SUMMARY, "zisin", "地震情報")["messages"][0]["embeds"][0]
        self.assertEqual(embed["title"], "震源・震度情報[第2報](発表|通常)")
        for expected in ("各地の震度情報", "最大震度:4", "震源:東京湾 マグニチュード4.2", "北緯35度 東経140度", "発生時間:20日10時0分", "津波の心配はありません。"):
            self.assertIn(expected, embed["description"])

    def test_warning_uses_area_and_kind_layout(self):
        xml = '''<Report><Control><Title>気象警報</Title><Status>通常</Status></Control><Head><Title>気象警報・注意報</Title><InfoType>発表</InfoType>
        <Headline><Text>東京都に警報を発表しました。</Text></Headline></Head><Body><Warning><Item><Kind><Name>大雨警報</Name><Status>発表</Status></Kind>
        <Area><Name>東京地方</Name></Area></Item></Warning></Body></Report>'''
        embed = render_xml(xml, SUMMARY, "keiho", "気象警報")["messages"][0]["embeds"][0]
        self.assertIn("東京地方: 【!】大雨警報（発表）", embed["description"])
        self.assertIn("【!】", embed["footer"]["text"])

    def test_namespace_unicode_split_without_loss(self):
        text = "長い本文" * 2000
        result = render_xml(f'<Report xmlns="urn:jma"><Body><Text>{text}</Text></Body></Report>', SUMMARY, "zisin", "地震")
        descriptions = [m["embeds"][0]["description"] for m in result["messages"]]
        self.assertIn(text, "".join(descriptions))
        self.assertTrue(all(len(s.encode("utf-16-le")) // 2 <= 3500 for s in descriptions))

    def test_wrong_shape_and_large_message_set_rejected(self):
        for xml in ['<Other/>', '<Report/>', '<Report><Body><Text>' + 'x' * 150000 + '</Text></Body></Report>']:
            with self.assertRaises(ValueError):
                render_xml(xml, SUMMARY, "zisin", "地震")

    def dispatch_namespace(self):
        tree = ast.parse((ROOT / "aws/channel-directory-api/lambda_function.py").read_text())
        tree.body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_xml_dispatch"]
        ns = {"hashlib": hashlib, "hmac": hmac, "json": json, "time": time, "uuid": uuid,
              "datetime": datetime, "timezone": timezone, "render_xml": render_xml,
              "_xml_text": lambda b: b["xml"], "_parse_xml_summary": lambda _: SUMMARY,
              "_dmdata_source_from_body": lambda _: None, "_clean": lambda v, n: str(v or "")[:n],
              "_normalize_delivery_name": lambda v: v, "ALLOWED_SEND_DATA": {"zisin"},
              "INGEST_ENDPOINTS": ["https://example.invalid/tokyo", "https://example.invalid/osaka"],
              "INGEST_HMAC_PARAMETER": "configured", "_load_dispatch_targets": lambda _: ["test-target"],
              "_record_delivery_metadata": Mock(), "_get_ingest_secret": lambda: "not-a-real-secret",
              "_admin_delivery_check": Mock(),
              "_post_signed_ingest": Mock(return_value={"accepted": True}), "_audit_operation": Mock()}
        exec(compile(tree, "dispatch-extracted", "exec"), ns)
        return ns

    def test_sent_payload_matches_preview_and_route(self):
        preview = render_xml(XML, SUMMARY, "zisin", "地震")
        ns = self.dispatch_namespace()
        ns["_xml_dispatch"]({"xml": XML, "sendData": "zisin", "deliverySlot": "地震",
                             "confirmation": "XML配信:地震", "previewDigest": preview["previewDigest"]}, "test", "request")
        calls = ns["_post_signed_ingest"].call_args_list
        self.assertEqual(len(calls), 2)
        for call in calls:
            payload = json.loads(call.args[1])
            self.assertEqual(payload["title"], preview["messages"][0])
            self.assertEqual(payload["data"], "zisin")
        self.assertEqual(json.loads(calls[0].args[1])["delivery_id"], json.loads(calls[1].args[1])["delivery_id"])

    def test_changed_preview_blocks_all_side_effects(self):
        ns = self.dispatch_namespace()
        with self.assertRaises(ValueError):
            ns["_xml_dispatch"]({"xml": XML, "sendData": "zisin", "deliverySlot": "地震",
                                 "confirmation": "XML配信:地震", "previewDigest": "stale"}, "test", "request")
        ns["_post_signed_ingest"].assert_not_called()
        ns["_record_delivery_metadata"].assert_not_called()


class ModeTests(unittest.TestCase):
    def test_modes_follow_existing_wait_policy(self):
        normal = build_plan("normal")
        self.assertEqual(normal["home"]["delivery"], "immediate")
        self.assertEqual(normal["tokyo-eew"]["waitSeconds"], 3)
        self.assertEqual(normal["tokyo-weather"]["delivery"], "stopped")
        self.assertEqual(build_plan("standby")["osaka-eew"]["waitSeconds"], 3)
        for p in build_plan("emergency").values():
            self.assertEqual(p, {"delivery": "immediate", "waitSeconds": 0})
        self.assertTrue(all(p["delivery"] == "stopped" for p in build_plan("emergency_stop").values()))

    def test_manual_requires_all_nodes_and_bounded_wait(self):
        with self.assertRaises(ValueError): build_plan("manual", {})
        p = build_plan("emergency")
        p["home"] = {"delivery": "standby", "waitSeconds": 3}
        self.assertEqual(build_plan("manual", p)["home"]["waitSeconds"], 3)
        for value in [True, -1, 301, 1.5, "3"]:
            p["home"]["waitSeconds"] = value
            with self.assertRaises(ValueError): build_plan("manual", p)

    def test_installation_and_live_application_are_distinct(self):
        self.assertFalse(runtime_readiness({}, 100)["ready"])
        records = {node: {"observed_at": 95, "protocol_version": 1, "verified": True,
                          "capability_verified": True, "installation_id": "install", "coverage_digest": "hash"} for node in RUNTIME_COMPONENTS}
        self.assertTrue(runtime_readiness(records, 100)["ready"])
        self.assertTrue(runtime_readiness(records, 200)["ready"])
        self.assertEqual(set(runtime_readiness(records, 200)["stale"]), set(RUNTIME_COMPONENTS))
        records["home"]["capability_verified"] = False
        self.assertFalse(runtime_readiness(records, 100)["ready"])


if __name__ == "__main__":
    unittest.main()
