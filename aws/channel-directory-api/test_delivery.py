"""Validation and payload builders for administrator delivery tests.

This module has no AWS clients and never performs network I/O.  The caller must
resolve destinations from the dedicated ``配信テスト`` delivery slot.
"""
import json
import re
import time


TEST_SLOT = "配信テスト"
TEST_RUN_TTL_SECONDS = 7 * 24 * 60 * 60
MAX_TEST_FUNCTIONS = 120
ROUTES = ("fast", "sqs", "regional-backup", "cross-region-backup")
SOURCES = ("admin", "home", "tokyo-eew", "tokyo-weather", "osaka-eew", "osaka-weather")
REGIONS = ("ap-northeast-1", "ap-northeast-3")
DELIVERY_FUNCTION = re.compile(
    r"^(?:dpi-delivery-(?:primary|backup)-(?:TOKYO|OSAKA)|"
    r"new_(?:EEW|EEW_SIND|ZISIN|TUNAMI|KEIHO|TOKYO_SUB|kisyo|kisyo2|KAZAN|OSAKA_SUB)_\d+)$"
)

ROUTE_LABELS = {
    "fast": "高速系統",
    "sqs": "SQS系統",
    "regional-backup": "リージョン内バックアップ",
    "cross-region-backup": "相互バックアップ",
}
SOURCE_LABELS = {
    "admin": "管理サイト",
    "home": "自宅サーバー",
    "tokyo-eew": "東京EC2（EEW・地震・津波）",
    "tokyo-weather": "東京EC2（気象・火山）",
    "osaka-eew": "大阪EC2（EEW・地震・津波）",
    "osaka-weather": "大阪EC2（気象・火山）",
}


def _strings(value, allowed, field, limit, allow_empty=False):
    if not isinstance(value, list) or (not value and not allow_empty) or len(value) > limit:
        raise ValueError(f"{field}を1つ以上選択してください。")
    result = []
    for item in value:
        text = str(item or "").strip()
        if text not in allowed:
            raise ValueError(f"{field}に未対応の項目が含まれています。")
        if text not in result:
            result.append(text)
    return result


def discover_functions(region_rows):
    """Return the allow-listed worker Lambda inventory from ListFunctions rows."""
    result = []
    for region, rows in region_rows.items():
        if region not in REGIONS:
            continue
        for row in rows or []:
            name = str(row.get("FunctionName") or "")
            if DELIVERY_FUNCTION.fullmatch(name):
                result.append({"region": region, "name": name, "group": function_group(name)})
    return sorted(result, key=lambda item: (item["region"], item["group"], item["name"]))


def function_group(name):
    if name.startswith("dpi-delivery-primary-"):
        return "primary"
    if name.startswith("dpi-delivery-backup-"):
        return "backup"
    if name.startswith("new_EEW"):
        return "eew"
    if name.startswith("new_ZISIN"):
        return "earthquake"
    if name.startswith("new_TUNAMI"):
        return "tsunami"
    if name.startswith("new_KEIHO"):
        return "eew-warning"
    if name.startswith("new_kisyo"):
        return "weather"
    if name.startswith("new_KAZAN"):
        return "volcano"
    return "sub"


def validate_request(body, available_functions):
    available = {(item["region"], item["name"]) for item in available_functions}
    sources = _strings(body.get("sources"), set(SOURCES), "試験開始元", len(SOURCES))
    routes = _strings(body.get("routes"), set(ROUTES), "試験配信系統", len(ROUTES), allow_empty=True)
    raw_functions = body.get("functions") or []
    if not isinstance(raw_functions, list) or len(raw_functions) > MAX_TEST_FUNCTIONS:
        raise ValueError("試験対象Lambdaを確認してください。")
    functions = []
    for item in raw_functions:
        if not isinstance(item, dict):
            raise ValueError("試験対象Lambdaを確認してください。")
        pair = (str(item.get("region") or ""), str(item.get("name") or ""))
        if pair not in available:
            raise ValueError("試験対象外のLambdaが含まれています。")
        if pair not in functions:
            functions.append(pair)
    if not functions and not routes:
        raise ValueError("Lambdaまたは配信系統を1つ以上選択してください。")
    title = str(body.get("title") or "DPI-Bot 配信系統試験").strip()[:100]
    note = str(body.get("note") or "").strip()[:500]
    return {"sources": sources, "routes": routes, "functions": functions,
            "title": title or "DPI-Bot 配信系統試験", "note": note}


def build_message(run_id, *, title, source, route=None, function_name=None,
                  requested_by="", note="", status="実行中"):
    fields = [
        {"name": "試験実行ID", "value": f"`{run_id}`", "inline": False},
        {"name": "試験開始元", "value": SOURCE_LABELS.get(source, source), "inline": True},
        {"name": "配信系統", "value": ROUTE_LABELS.get(route, route) if route else "Lambda個別試験", "inline": True},
        {"name": "実行Lambda", "value": function_name or "系統側で自動選択", "inline": False},
        {"name": "開始時状態", "value": status, "inline": True},
    ]
    if note:
        fields.append({"name": "管理者メモ", "value": note, "inline": False})
    return {
        "username": "DPI-Bot 配信試験",
        "allowed_mentions": {"parse": []},
        "embeds": [{
            "title": title,
            "description": "管理者が開始した試験配信です。実災害の情報ではありません。",
            "color": 3447003,
            "fields": fields,
            "footer": {"text": f"配信枠: {TEST_SLOT} / 実行者: {requested_by or '管理者'}"},
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }],
    }


def worker_event(run_id, *, region, function_name, source, url, title, note, requested_by):
    message = build_message(run_id, title=title, source=source,
                            function_name=function_name, requested_by=requested_by, note=note)
    now_ms = time.time_ns() // 1_000_000
    return {
        "id": run_id,
        "delivery_id": f"test-{run_id}-{function_name}"[:120],
        "source_uuid": run_id,
        "data": "test",
        "type": "test",
        "title": message,
        "url": [url],
        "expected_workers": 1,
        "_dpi_test": {"run_id": run_id, "slot": TEST_SLOT, "source": source,
                      "route": "lambda-direct", "target_function": function_name},
        "_dpi_mode": {"admitted_at": now_ms / 1000},
        "_ha": {"generation": 1, "owner_region": region, "accepted_region": region,
                "primary_region": region, "is_backup": "delivery-backup" in function_name},
        "_trace": {"test_started_at_ms": now_ms, "delivery_origin": "admin-test"},
    }


def candidate_event(run_id, *, target_region, primary_region, accepted_region,
                    source, route, urls, title, note, requested_by):
    now_ms = time.time_ns() // 1_000_000
    message = build_message(run_id, title=title, source=source, route=route,
                            requested_by=requested_by, note=note)
    return {
        "id": run_id,
        "delivery_id": f"test-{run_id}-{source}-{route}-{target_region}"[:120],
        "source_uuid": run_id,
        "data": "test",
        "type": "test",
        "title": message,
        "url": list(urls),
        "expected_workers": 1,
        "times": now_ms / 1000,
        "_dpi_test": {"run_id": run_id, "slot": TEST_SLOT, "source": source, "route": route},
        "_dpi_mode": {"admitted_at": now_ms / 1000},
        "_ha": {"primary_region": primary_region, "accepted_region": accepted_region,
                "final_backup": route in {"regional-backup", "cross-region-backup"},
                "delivery_origin": f"admin-test:{route}"},
        "_trace": {"test_started_at_ms": now_ms, "candidate_region": target_region,
                   "candidate_delay_seconds": 0, "delivery_origin": f"admin-test:{route}"},
    }


def decode_invoke_payload(raw):
    if not raw:
        return {}
    if hasattr(raw, "read"):
        raw = raw.read()
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {"value": value}
    except (TypeError, ValueError):
        return {"body": str(raw)[:500]}
