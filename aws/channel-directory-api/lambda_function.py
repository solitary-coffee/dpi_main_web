import hmac
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from base64 import b64decode, b64encode
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config
from botocore.exceptions import ClientError


TABLE_NAME = os.environ.get("TABLE_NAME", "EarthquakeData").strip()
API_TOKEN = os.environ.get("DIRECTORY_API_TOKEN", "").strip()
HOME_SERVER_TABLE_NAME = os.environ.get("HOME_SERVER_TABLE_NAME", "").strip()
MONITORED_TABLE_NAMES = [name.strip() for name in os.environ.get("MONITORED_TABLE_NAMES", TABLE_NAME).split(",") if name.strip()]
STATE_TABLE_NAME = os.environ.get("STATE_TABLE_NAME", HOME_SERVER_TABLE_NAME or "DPI-BackupFleetState-v51").strip()
DELIVERY_MONITOR_TABLE_NAME = os.environ.get("DELIVERY_MONITOR_TABLE_NAME", "DPI-DeliveryMonitor-v1").strip()
OPERATING_REGIONS = [name.strip() for name in os.environ.get("OPERATING_REGIONS", "ap-northeast-1,ap-northeast-3").split(",") if name.strip()]
AUTO_MONITOR_FUNCTION = os.environ.get("AUTO_MONITOR_FUNCTION", "dpi-backup-auto-failover-monitor").strip()
INGEST_ENDPOINTS = [url.strip() for url in os.environ.get("INGEST_ENDPOINTS", "").split(",") if url.strip()]
INGEST_HMAC_PARAMETER = os.environ.get("INGEST_HMAC_PARAMETER", "").strip()
DMDATA_API_KEY_PARAMETER = os.environ.get("DMDATA_API_KEY_PARAMETER", "/dpi-bot/dmdata/api-key").strip()
MAX_LIMITED_RESULTS = 1000
MAX_XML_BYTES = 1_500_000
MAX_DMDATA_RESPONSE_BYTES = 4_000_000
MAX_ADMIN_BODY_BYTES = 2_200_000
MAX_DISCORD_IMAGE_BYTES = 1_250_000
MAX_DISCORD_WORKERS = 25
DISCORD_REQUEST_INTERVAL_SECONDS = 0.02
SNOWFLAKE_LENGTHS = {17, 18, 19, 20}
RESERVED_FIELDS = {"id", "Ch_Name", "app", "time", "URL", "url"}
MANAGED_INSTANCE_TAG = "dpi:backup-managed"
MANUAL_MODE_KEY = "ADMIN#SYSTEM_MODE"
ALLOWED_SYSTEM_MODES = {"automatic", "normal", "failover"}
ALLOWED_EC2_ACTIONS = {"start", "stop", "reboot"}
ALLOWED_SEND_DATA = {"eew", "zisin", "tunami", "keiho", "sub", "eew_sind", "kisyo", "kisyo2", "kazan"}
DELIVERY_PREFIX_RE = re.compile(r"^(?:\[[^\]]+\])+", re.UNICODE)

_dynamodb = boto3.resource(
    "dynamodb",
    config=Config(
        connect_timeout=2,
        read_timeout=8,
        retries={"total_max_attempts": 2, "mode": "standard"},
    ),
)
_table = _dynamodb.Table(TABLE_NAME)
_cache = {"expires_at": 0.0, "items": []}
_system_cache = {"expires_at": 0.0, "value": None}
_flow_system_cache = {"expires_at": 0.0, "value": None}
_delivery_flow_cache = {"expires_at": 0.0, "value": None}
_delivery_statistics_cache = {}
_secret_cache = {"expires_at": 0.0, "value": None}
_dmdata_key_cache = {"expires_at": 0.0, "value": None}
_dmdata_history_cache = {}
_dmdata_xml_cache = {}
_discord_rate_lock = threading.Lock()
_discord_next_request_at = 0.0


def lambda_handler(event, context):
    if not _authorized(event):
        return _response(401, {"success": False, "message": "認証に失敗しました。"})
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET").upper()

    if method == "POST":
        try:
            return _handle_action(_json_body(event))
        except ValueError as error:
            return _response(400, {"success": False, "message": str(error)})
        except Exception as error:
            print(json.dumps({"event": "admin_action_failed", "error": type(error).__name__}, ensure_ascii=False))
            return _response(500, {"success": False, "message": "管理操作を実行できませんでした。"})
    if method != "GET":
        return _response(405, {"success": False, "message": "許可されていない操作です。"}, {"Allow": "GET, POST"})

    params = event.get("queryStringParameters") or {}
    view = _clean(params.get("view"), 30).casefold()
    if view == "system":
        return _response(200, {
            "success": True,
            "system": _load_system_summary(),
            "observedAt": datetime.now(tz=timezone.utc).isoformat(),
        })
    if view == "delivery-stats":
        period = _clean(params.get("period"), 10).casefold() or "24h"
        if period not in {"24h", "7d", "all"}:
            return _response(400, {"success": False, "message": "集計期間を確認してください。"})
        return _response(200, {
            "success": True,
            "statistics": _load_delivery_statistics(period),
            "observedAt": datetime.now(tz=timezone.utc).isoformat(),
        })
    if view == "dmdata-history":
        try:
            return _response(200, {
                "success": True,
                **_load_dmdata_history(params),
                "observedAt": datetime.now(tz=timezone.utc).isoformat(),
            })
        except ValueError as error:
            return _response(400, {"success": False, "message": str(error)})
        except Exception as error:
            error_code = error.response.get("Error", {}).get("Code", "") if isinstance(error, ClientError) else ""
            print(json.dumps({
                "event": "dmdata_history_failed",
                "error": type(error).__name__,
                "error_code": error_code,
            }, ensure_ascii=False))
            return _response(502, {"success": False, "message": "DMDATAの過去電文を取得できませんでした。"})
    if view == "delivery-flow":
        return _response(200, {
            "success": True,
            "flow": _load_delivery_flow(),
            "observedAt": datetime.now(tz=timezone.utc).isoformat(),
        })
    query = _clean(params.get("q"), 120).casefold()
    delivery = _clean(params.get("delivery"), 100).casefold()
    limit = _parse_limit(params.get("limit"))

    entries = _load_directory()
    matched = []
    for entry in entries:
        if delivery and not any(delivery in value.casefold() for value in entry["deliveryTypes"]):
            continue
        if query:
            values = [
                entry["serverId"],
                entry["serverName"],
                entry["channelId"],
                entry["channelName"],
                *entry["deliveryTypes"],
            ]
            if not any(query in value.casefold() for value in values if value):
                continue
        matched.append(entry)
        if limit is not None and len(matched) >= limit:
            break

    webhook_channels = {
        entry["channelId"] for entry in matched
        if entry.get("channelId") and entry.get("hasWebhook")
    }
    return _response(200, {
        "success": True,
        "items": matched,
        "count": len(matched),
        "webhookCount": len(webhook_channels),
        "source": {"region": os.environ.get("AWS_REGION", ""), "table": TABLE_NAME},
    })


def _json_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = b64decode(raw).decode("utf-8")
    if len(raw.encode("utf-8")) > MAX_ADMIN_BODY_BYTES:
        raise ValueError("送信データが大きすぎます。")
    try:
        body = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError("JSON形式を確認してください。") from None
    if not isinstance(body, dict):
        raise ValueError("JSONオブジェクトを送信してください。")
    return body


def _handle_action(body):
    action = _clean(body.get("action"), 50).casefold()
    actor = _clean(body.get("actor"), 254).casefold()
    request_id = _clean(body.get("requestId"), 80) or str(uuid.uuid4())
    if not actor:
        raise ValueError("操作ユーザーを確認できません。")

    if action == "ec2":
        result = _control_ec2(body, actor, request_id)
    elif action == "system-mode":
        result = _control_system_mode(body, actor, request_id)
    elif action == "xml-preview":
        result = _xml_preview(body)
    elif action == "xml-dispatch":
        result = _xml_dispatch(body, actor, request_id)
    elif action == "dmdata-load-xml":
        result = _dmdata_load_xml(body)
    elif action == "discord-announcement-preview":
        result = _discord_announcement_preview(body)
    elif action == "discord-announcement":
        result = _discord_announcement(body, actor, request_id)
    else:
        raise ValueError("指定された管理操作はありません。")

    _system_cache["expires_at"] = 0.0
    _flow_system_cache["expires_at"] = 0.0
    _delivery_flow_cache["expires_at"] = 0.0
    return _response(200, {"success": True, "requestId": request_id, **result})


def _authorized(event):
    if not API_TOKEN:
        return False
    headers = {str(key).lower(): str(value) for key, value in (event.get("headers") or {}).items()}
    supplied = headers.get("authorization", "")
    expected = f"Bearer {API_TOKEN}"
    return hmac.compare_digest(supplied, expected)


def _load_directory():
    now = datetime.now(tz=timezone.utc).timestamp()
    if _cache["expires_at"] > now:
        return _cache["items"]

    items = []
    paginator = _table.meta.client.get_paginator("scan")
    for page in paginator.paginate(TableName=TABLE_NAME):
        for record in page.get("Items", []):
            items.extend(_directory_entries(record))

    items.sort(key=lambda item: (
        item["serverName"].casefold(),
        item["channelName"].casefold(),
        item["channelId"],
    ))
    _cache["items"] = items
    _cache["expires_at"] = now + 60
    return items


def _load_system_summary():
    now = datetime.now(tz=timezone.utc).timestamp()
    if _system_cache["expires_at"] > now and _system_cache["value"] is not None:
        return _system_cache["value"]

    loaders = {
        "lambda": _lambda_summary,
        "apiGateway": _api_gateway_summary,
        "sqs": _sqs_summary,
        "dynamoDb": _dynamodb_summary,
        "alarms": _alarm_summary,
        "logGroups": _log_summary,
        "backupInstances": _ec2_summary,
        "stacks": _stack_summary,
        "homeServers": _home_server_summary,
        "systemMode": _system_mode_summary,
        "deliveryDirectory": _delivery_directory_summary,
    }
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {name: executor.submit(_safe_section, loader) for name, loader in loaders.items()}
        summary = {"region": os.environ.get("AWS_REGION", "")}
        summary.update({name: future.result() for name, future in futures.items()})
    _system_cache["value"] = summary
    _system_cache["expires_at"] = now + 20
    return summary


def _load_delivery_statistics(period):
    now = int(datetime.now(tz=timezone.utc).timestamp())
    cached = _delivery_statistics_cache.get(period)
    if cached and cached["expires_at"] > now:
        return cached["value"]

    cutoff = {"24h": now - 86400, "7d": now - 7 * 86400, "all": 0}[period]
    table = _dynamodb.Table(DELIVERY_MONITOR_TABLE_NAME)
    scan_args = {
        "ProjectionExpression": (
            "#kind, deliveryId, generation, eventType, updatedEpoch, targetCount, normalCount, "
            "errorCount, excludedErrorCount, seriousErrorCount, ownerRegion, workerMaxSeconds, "
            "latencyMaxMs, logsCollected, #title, subject, eventTitle, reportTitle, headline, "
            "deliverySlot, deliverySlots, deliveryType, #app, sendData, send_data, pipeline, #route"
        ),
        "ExpressionAttributeNames": {
            "#kind": "kind",
            "#title": "title",
            "#app": "app",
            "#route": "route",
        },
    }
    latest_by_delivery = {}
    while True:
        page = table.scan(**scan_args)
        for item in page.get("Items", []):
            if item.get("kind") != "delivery":
                continue
            updated = _integer(item.get("updatedEpoch"), 0)
            if updated < cutoff:
                continue
            delivery_id = _clean(item.get("deliveryId"), 200)
            if not delivery_id:
                continue
            current = latest_by_delivery.get(delivery_id)
            generation = _integer(item.get("generation"), 0)
            if current is None or (generation, updated) > (
                _integer(current.get("generation"), 0),
                _integer(current.get("updatedEpoch"), 0),
            ):
                latest_by_delivery[delivery_id] = item
        last_key = page.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_args["ExclusiveStartKey"] = last_key

    rows = sorted(latest_by_delivery.values(), key=lambda item: _integer(item.get("updatedEpoch"), 0), reverse=True)
    totals = _empty_delivery_totals()
    by_type = {}
    by_title = {}
    regions = {}
    for item in rows:
        event_type = _clean(item.get("eventType"), 40).casefold() or "unknown"
        bucket = by_type.setdefault(event_type, _empty_delivery_totals())
        _add_delivery_totals(totals, item)
        _add_delivery_totals(bucket, item)
        title = _delivery_title(item)
        delivery_slot = _delivery_slot(item)
        title_key = (title, event_type, delivery_slot)
        title_bucket = by_title.setdefault(title_key, {
            **_empty_delivery_totals(),
            "title": title,
            "eventType": event_type,
            "deliverySlot": delivery_slot,
            "latestEpoch": 0,
        })
        _add_delivery_totals(title_bucket, item)
        title_bucket["latestEpoch"] = max(title_bucket["latestEpoch"], _integer(item.get("updatedEpoch"), 0))
        region = _clean(item.get("ownerRegion"), 40) or "unknown"
        regions[region] = regions.get(region, 0) + 1

    timestamps = [_integer(item.get("updatedEpoch"), 0) for item in rows if _integer(item.get("updatedEpoch"), 0) > 0]
    value = {
        "period": period,
        "retentionNote": "監視テーブルの保持期間内（現在は約7日）のデータを集計します。",
        "source": {"region": os.environ.get("AWS_REGION", ""), "table": DELIVERY_MONITOR_TABLE_NAME},
        "coverage": {
            "oldestEpoch": min(timestamps) if timestamps else None,
            "latestEpoch": max(timestamps) if timestamps else None,
        },
        "totals": totals,
        "byEventType": [{"eventType": key, **counts} for key, counts in sorted(by_type.items())],
        "byTitle": sorted(by_title.values(), key=lambda item: item["latestEpoch"], reverse=True)[:100],
        "byRegion": regions,
        "recent": [_delivery_stat_row(item) for item in rows[:50]],
    }
    _delivery_statistics_cache[period] = {"expires_at": now + 45, "value": value}
    return value


def _empty_delivery_totals():
    return {"events": 0, "targets": 0, "normal": 0, "errors": 0, "excludedErrors": 0, "seriousErrors": 0, "maxWorkerSeconds": 0, "maxLatencyMs": 0}


def _add_delivery_totals(totals, item):
    totals["events"] += 1
    totals["targets"] += _integer(item.get("targetCount"), 0)
    totals["normal"] += _integer(item.get("normalCount"), 0)
    totals["errors"] += _integer(item.get("errorCount"), 0)
    totals["excludedErrors"] += _integer(item.get("excludedErrorCount"), 0)
    totals["seriousErrors"] += _integer(item.get("seriousErrorCount"), 0)
    totals["maxWorkerSeconds"] = max(totals["maxWorkerSeconds"], _integer(item.get("workerMaxSeconds"), 0))
    latency_values = [_integer(value, 0) for value in (item.get("latencyMaxMs") or {}).values()]
    totals["maxLatencyMs"] = max(totals["maxLatencyMs"], max(latency_values, default=0))


def _delivery_stat_row(item):
    return {
        "title": _delivery_title(item),
        "eventType": _clean(item.get("eventType"), 40).casefold() or "unknown",
        "deliverySlot": _delivery_slot(item),
        "route": _delivery_route(item),
        "updatedEpoch": _integer(item.get("updatedEpoch"), 0),
        "generation": _integer(item.get("generation"), 0),
        "targets": _integer(item.get("targetCount"), 0),
        "normal": _integer(item.get("normalCount"), 0),
        "errors": _integer(item.get("errorCount"), 0),
        "seriousErrors": _integer(item.get("seriousErrorCount"), 0),
        "ownerRegion": _clean(item.get("ownerRegion"), 40),
        "logsCollected": bool(item.get("logsCollected")),
        "maxLatencyMs": max((_integer(value, 0) for value in (item.get("latencyMaxMs") or {}).values()), default=0),
    }


def _delivery_title(item):
    for key in ("title", "subject", "eventTitle", "reportTitle", "headline"):
        value = _clean(item.get(key), 300)
        if value:
            return value
    return _clean(item.get("eventType"), 80) or "タイトル未記録"


def _delivery_slot(item):
    for key in ("deliverySlot", "deliverySlots", "deliveryType", "app"):
        values = _string_list(item.get(key), 20, item_length=120)
        if values:
            return "、".join(values)
    return "未記録"


def _delivery_route(item):
    for key in ("sendData", "send_data", "pipeline", "route"):
        value = _clean(item.get(key), 120)
        if value:
            return value
    return "未記録"


DMDATA_CATEGORIES = {
    "earthquake": "telegram.earthquake",
    "weather": "telegram.weather,telegram.forecast,telegram.scheduled",
    "volcano": "telegram.volcano",
}


def _load_dmdata_history(params):
    category = _clean(params.get("category"), 30).casefold() or "earthquake"
    if category not in {*DMDATA_CATEGORIES, "eew"}:
        raise ValueError("DMDATAの情報分類を確認してください。")
    limit = min(max(_integer(params.get("limit"), 20), 1), 100)
    cursor = _clean(params.get("cursorToken"), 2000)
    event_id = _clean(params.get("eventId"), 40)
    if cursor and not re.fullmatch(r"[A-Za-z0-9._~+/=-]+", cursor):
        raise ValueError("DMDATAの続き位置が不正です。")
    if event_id and not re.fullmatch(r"[0-9]{10,20}", event_id):
        raise ValueError("緊急地震速報のイベントIDが不正です。")

    cache_key = json.dumps([category, limit, cursor, event_id], separators=(",", ":"))
    now = time.time()
    cached = _dmdata_history_cache.get(cache_key)
    if cached and cached["expires_at"] > now:
        return cached["value"]

    if category == "eew":
        value = _load_dmdata_eew(event_id, limit, cursor)
    else:
        query = {
            "classification": DMDATA_CATEGORIES[category],
            "xmlReport": "true",
            "test": "including",
            "formatMode": "raw",
            "limit": str(limit),
        }
        if cursor:
            query["cursorToken"] = cursor
        response = _dmdata_json(f"https://api.dmdata.jp/v2/telegram?{urllib.parse.urlencode(query)}")
        raw_items = response.get("items") if isinstance(response.get("items"), list) else []
        items = [_normalize_dmdata_telegram(item, category) for item in raw_items if isinstance(item, dict)]
        _attach_dmdata_delivery_states(items)
        value = {
            "category": category,
            "items": items,
            "nextToken": _clean(response.get("nextToken"), 2000) or None,
            "count": len(items),
            "source": "telegram.list",
            "cacheSeconds": 60,
        }

    _dmdata_history_cache[cache_key] = {"expires_at": now + 60, "value": value}
    _trim_ttl_cache(_dmdata_history_cache, 24)
    return value


def _load_dmdata_eew(event_id, limit, cursor=""):
    if not event_id:
        query = {"limit": str(limit)}
        if cursor:
            query["cursorToken"] = cursor
        response = _dmdata_json(f"https://api.dmdata.jp/v2/gd/eew?{urllib.parse.urlencode(query)}")
        items = []
        for raw in response.get("items") or []:
            if not isinstance(raw, dict):
                continue
            event = _clean(raw.get("eventId"), 40)
            earthquake = raw.get("earthquake") if isinstance(raw.get("earthquake"), dict) else {}
            hypocenter = earthquake.get("hypocenter") if isinstance(earthquake.get("hypocenter"), dict) else {}
            title = "緊急地震速報"
            if hypocenter.get("name"):
                title = f"緊急地震速報（{_clean(hypocenter.get('name'), 120)}）"
            items.append({
                "sourceId": "",
                "eventId": event,
                "serial": _integer(raw.get("serial"), 0),
                "title": title,
                "controlTitle": "緊急地震速報",
                "headline": _clean(raw.get("text"), 500),
                "classification": "eew.forecast",
                "category": "eew",
                "typeCode": "VXSE",
                "receivedTime": _clean(raw.get("dateTime"), 60),
                "format": "event",
                "test": False,
                "deliveryState": "details_required",
                "deliveryStateLabel": "報の取得が必要",
                "selectable": False,
                "needsReports": True,
                "isWarning": bool(raw.get("isWarning")),
                "isCanceled": bool(raw.get("isCanceled")),
            })
        return {
            "category": "eew",
            "items": items,
            "nextToken": _clean(response.get("nextToken"), 2000) or None,
            "count": len(items),
            "source": "gd.eew.list",
            "cacheSeconds": 60,
        }

    response = _dmdata_json(f"https://api.dmdata.jp/v2/gd/eew/{urllib.parse.quote(event_id, safe='')}")
    items = []
    for report in response.get("items") or []:
        if not isinstance(report, dict):
            continue
        for telegram in report.get("telegrams") or []:
            if not isinstance(telegram, dict):
                continue
            item = _normalize_dmdata_telegram(telegram, "eew", raw_source_id=telegram.get("originalId"))
            item.update({
                "eventId": _clean(report.get("eventId"), 40) or event_id,
                "serial": _integer(report.get("serial"), _integer(telegram.get("serial"), 0)),
                "isWarning": bool(report.get("isWarning")),
                "isCanceled": bool(report.get("isCanceled")),
                "needsReports": False,
            })
            if not item["headline"]:
                item["headline"] = _clean(report.get("text"), 500)
            items.append(item)
    _attach_dmdata_delivery_states(items)
    return {
        "category": "eew",
        "eventId": event_id,
        "items": items,
        "nextToken": None,
        "count": len(items),
        "source": "gd.eew.event",
        "cacheSeconds": 60,
    }


def _normalize_dmdata_telegram(raw, category, raw_source_id=None):
    xml_report = raw.get("xmlReport") if isinstance(raw.get("xmlReport"), dict) else {}
    control = xml_report.get("control") if isinstance(xml_report.get("control"), dict) else {}
    head_report = xml_report.get("head") if isinstance(xml_report.get("head"), dict) else {}
    head = raw.get("head") if isinstance(raw.get("head"), dict) else {}
    source_id = _clean(raw_source_id if raw_source_id is not None else raw.get("id"), 160)
    data_format = _clean(raw.get("format"), 20).casefold()
    if category == "eew" and source_id:
        data_format = "xml"
    title = _clean(head_report.get("title"), 300) or _clean(control.get("title"), 300) or _clean(head.get("type"), 40) or "名称未取得"
    return {
        "sourceId": source_id,
        "eventId": _clean(head_report.get("eventId"), 80),
        "serial": _integer(raw.get("serial"), 0),
        "title": title,
        "controlTitle": _clean(control.get("title"), 300),
        "headline": _clean(head_report.get("headline"), 500),
        "classification": _clean(raw.get("classification"), 80),
        "category": category,
        "typeCode": _clean(head.get("type"), 40),
        "receivedTime": _clean(raw.get("receivedTime"), 60) or _clean(head.get("time"), 60),
        "reportTime": _clean(head_report.get("reportDateTime"), 60),
        "format": data_format or "unknown",
        "test": bool(head.get("test")),
        "deliveryState": "unsupported" if data_format != "xml" else "undelivered",
        "deliveryStateLabel": "未対応形式" if data_format != "xml" else "未配信",
        "selectable": data_format == "xml" and bool(source_id),
        "needsReports": False,
    }


def _attach_dmdata_delivery_states(items):
    states = {}
    lookup_failed = False
    if STATE_TABLE_NAME:
        keys = [{"pk": f"DMDATA#SOURCE#{item['sourceId']}"} for item in items if item.get("sourceId")]
        for offset in range(0, len(keys), 100):
            request_items = {STATE_TABLE_NAME: {"Keys": keys[offset:offset + 100]}}
            try:
                response = _dynamodb.batch_get_item(RequestItems=request_items)
            except ClientError as error:
                lookup_failed = True
                print(json.dumps({
                    "event": "dmdata_delivery_state_lookup_failed",
                    "error_code": error.response.get("Error", {}).get("Code", "ClientError"),
                    "table": STATE_TABLE_NAME,
                }, ensure_ascii=False))
                break
            for record in response.get("Responses", {}).get(STATE_TABLE_NAME, []):
                states[_clean(record.get("source_id"), 160)] = record
    for item in items:
        state = states.get(item.get("sourceId"))
        if item.get("deliveryState") == "unsupported":
            continue
        if lookup_failed:
            item["deliveryState"] = "unknown"
            item["deliveryStateLabel"] = "状態取得失敗"
            continue
        if not state:
            continue
        status = _clean(state.get("status"), 30).casefold()
        item["lastDeliveryAt"] = _epoch_iso(_integer(state.get("updated_at"), 0))
        item["lastDeliverySlot"] = _clean(state.get("delivery_slot"), 120)
        item["lastSendData"] = _clean(state.get("send_data"), 40)
        if status == "delivered":
            item["deliveryState"] = "delivered"
            item["deliveryStateLabel"] = "配信済み"
        elif status == "dispatching":
            item["deliveryState"] = "dispatching"
            item["deliveryStateLabel"] = "配信処理中"
        elif status == "failed":
            item["deliveryState"] = "undelivered"
            item["deliveryStateLabel"] = "未配信（前回失敗）"


def _dmdata_load_xml(body):
    source_id = _valid_dmdata_source_id(body.get("sourceId"))
    xml_text = _dmdata_download_xml(source_id)
    preview = _parse_xml_summary(xml_text)
    return {
        "message": "DMDATAからXMLを読み込みました。内容を確認してから配信してください。",
        "sourceId": source_id,
        "xml": xml_text,
        "xmlSha256": hashlib.sha256(xml_text.encode("utf-8")).hexdigest(),
        "bytes": len(xml_text.encode("utf-8")),
        "preview": preview,
    }


def _valid_dmdata_source_id(value):
    source_id = _clean(value, 160)
    if not re.fullmatch(r"[A-Fa-f0-9]{64,128}", source_id):
        raise ValueError("DMDATAの電文IDが不正です。")
    return source_id


def _dmdata_download_xml(source_id):
    now = time.time()
    cached = _dmdata_xml_cache.get(source_id)
    if cached and cached["expires_at"] > now:
        return cached["value"]
    raw = _dmdata_request(f"https://data.api.dmdata.jp/v1/{source_id}", "application/xml,text/xml")
    if len(raw) > MAX_XML_BYTES:
        raise ValueError("DMDATAのXMLが1.5MBを超えています。")
    try:
        xml_text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("DMDATAの電文をUTF-8 XMLとして読み込めませんでした。") from None
    _parse_xml_summary(xml_text)
    _dmdata_xml_cache[source_id] = {"expires_at": now + 900, "value": xml_text}
    _trim_ttl_cache(_dmdata_xml_cache, 12)
    return xml_text


def _dmdata_json(url):
    raw = _dmdata_request(url, "application/json")
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ValueError("DMDATAの応答形式を確認できませんでした。") from None
    if not isinstance(body, dict) or body.get("status") != "ok":
        error = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
        raise ValueError(_clean(error.get("message"), 300) or "DMDATA APIがエラーを返しました。")
    return body


def _dmdata_request(url, accept):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in {"api.dmdata.jp", "data.api.dmdata.jp"}:
        raise ValueError("DMDATAの接続先が不正です。")
    api_key = _get_dmdata_api_key()
    authorization = b64encode(f"{api_key}:".encode("utf-8")).decode("ascii")
    request = urllib.request.Request(url, headers={
        "Accept": accept,
        "Authorization": f"Basic {authorization}",
        "User-Agent": "dpi-admin-center/1.0",
    })
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                raw = response.read(MAX_DMDATA_RESPONSE_BYTES + 1)
            if len(raw) > MAX_DMDATA_RESPONSE_BYTES:
                raise ValueError("DMDATAの応答が大きすぎます。検索件数を減らしてください。")
            _record_dmdata_health(True)
            return raw
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt == 0:
                retry_after = error.headers.get("Retry-After", "1") if error.headers else "1"
                try:
                    delay = min(2.0, max(0.5, float(retry_after)))
                except (TypeError, ValueError):
                    delay = 1.0
                time.sleep(delay)
                continue
            _record_dmdata_health(False, f"HTTP_{error.code}")
            if error.code in {401, 403}:
                raise ValueError("DMDATA APIキーまたは権限を確認してください。") from None
            if error.code == 429:
                raise ValueError("DMDATAのレート制限に達しました。時間を置いて更新してください。") from None
            raise ValueError(f"DMDATA APIがHTTP {error.code}を返しました。") from None
        except urllib.error.URLError:
            _record_dmdata_health(False, "CONNECTION_ERROR")
            raise ValueError("DMDATA APIに接続できませんでした。") from None
    raise ValueError("DMDATA APIに接続できませんでした。")


def _get_dmdata_api_key():
    if not DMDATA_API_KEY_PARAMETER:
        raise ValueError("DMDATA APIキーの保存先が設定されていません。")
    now = time.time()
    if _dmdata_key_cache["expires_at"] > now and _dmdata_key_cache["value"]:
        return _dmdata_key_cache["value"]
    response = _client("ssm").get_parameter(Name=DMDATA_API_KEY_PARAMETER, WithDecryption=True)
    value = str((response.get("Parameter") or {}).get("Value") or "")
    if not value:
        raise ValueError("DMDATA APIキーを取得できません。")
    _dmdata_key_cache.update({"expires_at": now + 300, "value": value})
    return value


def _record_dmdata_health(success, error=""):
    if not STATE_TABLE_NAME:
        return
    now = int(time.time())
    try:
        table = _dynamodb.Table(STATE_TABLE_NAME)
        if success:
            table.update_item(
                Key={"pk": "DMDATA#HEALTH"},
                UpdateExpression=(
                    "SET #status = :status, last_success_at = :now, last_error_at = :zero, "
                    "last_error = :empty, updated_at = :now, expires_at = :expires"
                ),
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":status": "normal", ":now": now, ":zero": 0, ":empty": "",
                    ":expires": now + 31_536_000,
                },
            )
        else:
            table.update_item(
                Key={"pk": "DMDATA#HEALTH"},
                UpdateExpression=(
                    "SET #status = :status, last_error_at = :now, last_error = :error, "
                    "updated_at = :now, expires_at = :expires"
                ),
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":status": "abnormal", ":now": now, ":error": _clean(error, 100),
                    ":expires": now + 31_536_000,
                },
            )
        _delivery_flow_cache["expires_at"] = 0.0
    except Exception as record_error:
        print(json.dumps({"event": "dmdata_health_record_failed", "error": type(record_error).__name__}, ensure_ascii=False))


def _trim_ttl_cache(cache, maximum):
    if len(cache) <= maximum:
        return
    oldest = sorted(cache.items(), key=lambda item: item[1].get("expires_at", 0))
    for key, _ in oldest[:len(cache) - maximum]:
        cache.pop(key, None)


def _client(service, region=None):
    return boto3.client(service, config=Config(
        region_name=region,
        connect_timeout=2,
        read_timeout=6,
        retries={"total_max_attempts": 2, "mode": "standard"},
    ))


def _safe_section(loader):
    try:
        return loader()
    except Exception as error:  # AWS側の一部障害でダッシュボード全体を落とさない
        return {"available": False, "error": type(error).__name__}


def _lambda_summary():
    with ThreadPoolExecutor(max_workers=max(1, len(OPERATING_REGIONS))) as executor:
        regional = list(executor.map(_lambda_region_summary, OPERATING_REGIONS))
    functions = [item for section in regional for item in section["functions"]]
    return {
        "available": True,
        "count": len(functions),
        "regions": [
            {
                "region": section["region"],
                "count": len(section["functions"]),
                "names": sorted(
                    _clean(item.get("FunctionName"), 100)
                    for item in section["functions"]
                    if item.get("FunctionName")
                )[:500],
            }
            for section in regional
        ],
        "names": sorted(_clean(item.get("FunctionName"), 100) for item in functions if item.get("FunctionName"))[:200],
    }


def _lambda_region_summary(region):
    functions = []
    paginator = _client("lambda", region).get_paginator("list_functions")
    for page in paginator.paginate(PaginationConfig={"MaxItems": 500}):
        functions.extend(page.get("Functions", []))
    return {"region": region, "functions": functions}


def _api_gateway_summary():
    apis = []
    paginator = _client("apigatewayv2").get_paginator("get_apis")
    for page in paginator.paginate(PaginationConfig={"MaxItems": 500}):
        apis.extend(page.get("Items", []))
    return {
        "available": True,
        "count": len(apis),
        "names": sorted(_clean(item.get("Name"), 100) for item in apis if item.get("Name"))[:100],
    }


def _sqs_summary():
    with ThreadPoolExecutor(max_workers=max(1, len(OPERATING_REGIONS))) as executor:
        regional = list(executor.map(_sqs_region_summary, OPERATING_REGIONS))
    queues = [queue for section in regional for queue in section["queues"]]
    return {
        "available": True,
        "count": sum(section["count"] for section in regional),
        "visibleMessages": sum(section["visibleMessages"] for section in regional),
        "deadLetterMessages": sum(section["deadLetterMessages"] for section in regional),
        "regions": regional,
        "queues": queues,
    }


def _sqs_region_summary(region):
    client = _client("sqs", region)
    urls = []
    paginator = client.get_paginator("list_queues")
    for page in paginator.paginate(PaginationConfig={"MaxItems": 1000, "PageSize": 1000}):
        urls.extend(page.get("QueueUrls", []))
    queues = []
    visible = 0
    dead_letter = 0
    for url in urls[:50]:
        attributes = client.get_queue_attributes(
            QueueUrl=url,
            AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        ).get("Attributes", {})
        count = _integer(attributes.get("ApproximateNumberOfMessages"), 0)
        name = url.rsplit("/", 1)[-1]
        visible += count
        if "dlq" in name.casefold() or "dead" in name.casefold():
            dead_letter += count
        queues.append({
            "name": name[:100],
            "region": region,
            "visible": count,
            "inFlight": _integer(attributes.get("ApproximateNumberOfMessagesNotVisible"), 0),
            "deadLetter": "dlq" in name.casefold() or "dead" in name.casefold(),
        })
    return {
        "region": region,
        "count": len(urls),
        "visibleMessages": visible,
        "deadLetterMessages": dead_letter,
        "queues": queues,
    }


def _dynamodb_summary():
    client = _client("dynamodb")
    names = []
    paginator = client.get_paginator("list_tables")
    for page in paginator.paginate(PaginationConfig={"MaxItems": 500}):
        names.extend(page.get("TableNames", []))
    selected = []
    requested = set(MONITORED_TABLE_NAMES)
    if HOME_SERVER_TABLE_NAME:
        requested.add(HOME_SERVER_TABLE_NAME)
    if STATE_TABLE_NAME:
        requested.add(STATE_TABLE_NAME)
    for name in sorted(requested):
        if name not in names:
            selected.append({"name": name[:100], "status": "NOT_FOUND", "itemCount": 0})
            continue
        table = client.describe_table(TableName=name).get("Table", {})
        selected.append({"name": name[:100], "status": table.get("TableStatus"), "itemCount": _integer(table.get("ItemCount"), 0)})
    return {"available": True, "count": len(names), "tables": selected}


def _alarm_summary():
    alarms = []
    paginator = _client("cloudwatch").get_paginator("describe_alarms")
    for page in paginator.paginate(StateValue="ALARM", PaginationConfig={"MaxItems": 200}):
        alarms.extend(page.get("MetricAlarms", []))
        alarms.extend(page.get("CompositeAlarms", []))
    return {"available": True, "active": len(alarms), "names": sorted(_clean(item.get("AlarmName"), 120) for item in alarms if item.get("AlarmName"))[:100]}


def _log_summary():
    groups = []
    paginator = _client("logs").get_paginator("describe_log_groups")
    for page in paginator.paginate(PaginationConfig={"MaxItems": 200}):
        groups.extend(page.get("logGroups", []))
    groups.sort(key=lambda item: _integer(item.get("storedBytes"), 0), reverse=True)
    return {
        "available": True,
        "count": len(groups),
        "storedBytes": sum(_integer(item.get("storedBytes"), 0) for item in groups),
        "groups": [{"name": _clean(item.get("logGroupName"), 200), "storedBytes": _integer(item.get("storedBytes"), 0)} for item in groups[:30]],
    }


def _ec2_summary():
    instances = []
    with ThreadPoolExecutor(max_workers=max(1, len(OPERATING_REGIONS))) as executor:
        regional = list(executor.map(_managed_instances_for_region, OPERATING_REGIONS))
    for region_items in regional:
        instances.extend(region_items)
    states = {}
    for instance in instances:
        state = instance["state"]
        states[state] = states.get(state, 0) + 1
    instances.sort(key=lambda item: (item["region"], item["name"], item["instanceId"]))
    return {"available": True, "count": len(instances), "states": states, "instances": instances}


def _managed_instances_for_region(region):
    client = _client("ec2", region)
    raw_instances = []
    paginator = client.get_paginator("describe_instances")
    for page in paginator.paginate(
        Filters=[{"Name": f"tag:{MANAGED_INSTANCE_TAG}", "Values": ["true"]}],
        PaginationConfig={"MaxItems": 100},
    ):
        for reservation in page.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                raw_instances.append(instance)

    status_by_id = {}
    instance_ids = [_clean(instance.get("InstanceId"), 30) for instance in raw_instances if instance.get("InstanceId")]
    if instance_ids:
        response = client.describe_instance_status(InstanceIds=instance_ids, IncludeAllInstances=True)
        status_by_id = {item.get("InstanceId"): item for item in response.get("InstanceStatuses", [])}

    instances = []
    for instance in raw_instances:
        instance_id = _clean(instance.get("InstanceId"), 30)
        tags = {str(tag.get("Key", "")): str(tag.get("Value", "")) for tag in instance.get("Tags", [])}
        health = status_by_id.get(instance_id, {})
        security_groups = [
            {"id": _clean(group.get("GroupId"), 40), "name": _clean(group.get("GroupName"), 120)}
            for group in instance.get("SecurityGroups", [])
        ]
        volumes = [
            _clean((mapping.get("Ebs") or {}).get("VolumeId"), 40)
            for mapping in instance.get("BlockDeviceMappings", [])
            if (mapping.get("Ebs") or {}).get("VolumeId")
        ]
        instances.append({
            "instanceId": instance_id,
            "name": _clean(tags.get("Name"), 120) or instance_id,
            "region": region,
            "state": _clean((instance.get("State") or {}).get("Name"), 30) or "unknown",
            "normalState": _clean(tags.get("dpi:normal-state"), 30) or "unknown",
            "backupRole": _clean(tags.get("dpi:backup-role"), 80) or "unknown",
            "availabilityZone": _clean((instance.get("Placement") or {}).get("AvailabilityZone"), 40),
            "launchTime": _normalize_time(instance.get("LaunchTime")),
            "instanceType": _clean(instance.get("InstanceType"), 40),
            "architecture": _clean(instance.get("Architecture"), 40),
            "imageId": _clean(instance.get("ImageId"), 40),
            "platformDetails": _clean(instance.get("PlatformDetails"), 80),
            "privateIpAddress": _clean(instance.get("PrivateIpAddress"), 80),
            "publicIpAddress": _clean(instance.get("PublicIpAddress"), 80),
            "vpcId": _clean(instance.get("VpcId"), 40),
            "subnetId": _clean(instance.get("SubnetId"), 40),
            "monitoringState": _clean((instance.get("Monitoring") or {}).get("State"), 30),
            "rootDeviceType": _clean(instance.get("RootDeviceType"), 30),
            "virtualizationType": _clean(instance.get("VirtualizationType"), 30),
            "ebsOptimized": bool(instance.get("EbsOptimized")),
            "instanceStatus": _clean((health.get("InstanceStatus") or {}).get("Status"), 30) or "unknown",
            "systemStatus": _clean((health.get("SystemStatus") or {}).get("Status"), 30) or "unknown",
            "securityGroups": security_groups,
            "volumeIds": volumes,
            "controllable": True,
        })
    return instances


def _stack_summary():
    stacks = []
    paginator = _client("cloudformation").get_paginator("list_stacks")
    for page in paginator.paginate(PaginationConfig={"MaxItems": 200}):
        stacks.extend(page.get("StackSummaries", []))
    return {
        "available": True,
        "count": len(stacks),
        "failed": sum(1 for stack in stacks if any(word in _clean(stack.get("StackStatus"), 80) for word in ("FAILED", "ROLLBACK"))),
        "items": [{"name": _clean(stack.get("StackName"), 120), "status": _clean(stack.get("StackStatus"), 80)} for stack in stacks[:100]],
    }


def _home_server_summary():
    table_name = HOME_SERVER_TABLE_NAME or STATE_TABLE_NAME
    if not table_name:
        return {"available": False, "configured": False, "healthy": 0, "unhealthy": 0, "lastHeartbeat": None, "nodes": []}
    table = _dynamodb.Table(table_name)
    now = datetime.now(tz=timezone.utc).timestamp()
    nodes = []
    for region_role in ("TOKYO", "OSAKA"):
        record = table.get_item(
            Key={"pk": f"HOME#{region_role}"},
            ProjectionExpression="#pk, updated_at",
            ExpressionAttributeNames={"#pk": "pk"},
        ).get("Item", {})
        updated_at = _integer(record.get("updated_at"), 0)
        age = max(0, int(now - updated_at)) if updated_at else None
        healthy = age is not None and age <= 300
        nodes.append({
            "id": region_role.casefold(),
            "name": f"自宅サーバー（{region_role.title()}系統）",
            "status": "online" if healthy else "offline",
            "healthy": healthy,
            "lastHeartbeat": _epoch_iso(updated_at),
            "ageSeconds": age,
        })
    healthy_count = sum(1 for node in nodes if node["healthy"])
    last_heartbeat = max((node["lastHeartbeat"] for node in nodes if node["lastHeartbeat"]), default=None)
    return {
        "available": True,
        "configured": True,
        "count": len(nodes),
        "healthy": healthy_count,
        "unhealthy": len(nodes) - healthy_count,
        "lastHeartbeat": last_heartbeat,
        "nodes": nodes,
    }


def _system_mode_summary():
    if not STATE_TABLE_NAME:
        return {"available": False, "configured": False, "controlMode": "unknown", "regions": []}
    table = _dynamodb.Table(STATE_TABLE_NAME)
    manual = table.get_item(
        Key={"pk": MANUAL_MODE_KEY},
        ProjectionExpression="#pk, #mode, requested_at, requested_by, reason",
        ExpressionAttributeNames={"#pk": "pk", "#mode": "mode"},
    ).get("Item", {})
    control_mode = _clean(manual.get("mode"), 40).casefold() or "automatic"
    regions = []
    for region_role in ("TOKYO", "OSAKA"):
        record = table.get_item(
            Key={"pk": f"MODE#{region_role}"},
            ProjectionExpression="#pk, #mode, updated_at, reason",
            ExpressionAttributeNames={"#pk": "pk", "#mode": "mode"},
        ).get("Item", {})
        regions.append({
            "regionRole": region_role.casefold(),
            "mode": _clean(record.get("mode"), 40) or "UNKNOWN",
            "reason": _clean(record.get("reason"), 300),
            "updatedAt": _epoch_iso(_integer(record.get("updated_at"), 0)),
        })
    return {
        "available": True,
        "configured": True,
        "controlMode": control_mode,
        "requestedAt": _epoch_iso(_integer(manual.get("requested_at"), 0)),
        "requestedBy": _clean(manual.get("requested_by"), 254),
        "reason": _clean(manual.get("reason"), 300),
        "regions": regions,
    }


def _delivery_directory_summary():
    entries = _load_directory()
    by_type = {}
    servers = set()
    channels = set()
    for entry in entries:
        if entry.get("serverId"):
            servers.add(entry["serverId"])
        if entry.get("channelId"):
            channels.add(entry["channelId"])
        for delivery_type in entry.get("deliveryTypes", []):
            normalized = _normalize_delivery_name(delivery_type)
            if normalized:
                by_type[normalized] = by_type.get(normalized, 0) + 1
    return {
        "available": True,
        "entries": len(entries),
        "servers": len(servers),
        "channels": len(channels),
        "byType": dict(sorted(by_type.items(), key=lambda item: (-item[1], item[0]))[:100]),
    }


def _load_delivery_flow():
    now = time.time()
    if _delivery_flow_cache["expires_at"] > now and _delivery_flow_cache["value"] is not None:
        return _delivery_flow_cache["value"]

    system = _load_flow_system_summary()
    statistics = _load_delivery_statistics("24h")
    observed_at = datetime.now(tz=timezone.utc).isoformat()
    components = []

    dmdata_health = _dmdata_health()
    components.append({
        "id": "dmdata-history-api",
        "layer": "upstream",
        "name": "DMDATA上流API",
        "status": dmdata_health["status"],
        "expectedStopped": dmdata_health["expectedStopped"],
        "detail": dmdata_health["detail"],
        "lastConnectivityAt": dmdata_health["lastConnectivityAt"],
        "lastPassedAt": dmdata_health["lastConnectivityAt"],
        "passageMs": None,
    })

    home = system.get("homeServers") or {}
    for node in home.get("nodes") or []:
        components.append({
            "id": f"home-{_clean(node.get('id'), 30)}",
            "layer": "home",
            "name": _clean(node.get("name"), 160) or "自宅サーバー",
            "status": "normal" if node.get("healthy") else "abnormal",
            "expectedStopped": False,
            "detail": "ハートビート正常" if node.get("healthy") else "ハートビートが5分以上更新されていません",
            "lastConnectivityAt": node.get("lastHeartbeat"),
            "lastPassedAt": node.get("lastHeartbeat"),
            "passageMs": None,
        })

    lambda_summary = system.get("lambda") or {}
    alarm_names = (system.get("alarms") or {}).get("names") or []
    for region in OPERATING_REGIONS:
        recent = _flow_recent_for_region(statistics.get("recent") or [], region)
        region_role = _region_role(region)
        lambda_region = next((item for item in lambda_summary.get("regions") or [] if item.get("region") == region), {})
        lambda_count = _integer(lambda_region.get("count"), 0)
        function_names = set(lambda_region.get("names") or [])
        required_functions = {
            f"dpi-delivery-primary-{region_role.upper()}",
            f"dpi-distributor-{region_role.upper()}",
            f"dpi-ha-control-{region_role.upper()}",
        }
        missing_functions = sorted(required_functions - function_names)
        relevant_alarms = [name for name in alarm_names if region.casefold() in name.casefold() or region_role in name.casefold()]
        status = "abnormal" if relevant_alarms or not lambda_summary.get("available") or missing_functions else "normal"
        components.append({
            "id": f"aws-fast-{region}",
            "layer": "aws-fast",
            "name": f"AWS高速系統（{region_role.upper()}）",
            "region": region,
            "status": status,
            "expectedStopped": False,
            "detail": (
                f"Lambda {lambda_count}件 / 必須3機能確認済み"
                if not missing_functions
                else f"Lambda {lambda_count}件 / 不足: {', '.join(missing_functions)}"
            ) + (f" / 警報 {len(relevant_alarms)}件" if relevant_alarms else " / 有効な警報なし"),
            "lastConnectivityAt": observed_at if lambda_summary.get("available") else None,
            "lastPassedAt": _epoch_iso(recent.get("updatedEpoch")) if recent else None,
            "passageMs": recent.get("maxLatencyMs") if recent else None,
            "lastTitle": recent.get("title") if recent else None,
        })

    sqs = system.get("sqs") or {}
    for region in OPERATING_REGIONS:
        section = next((item for item in sqs.get("regions") or [] if item.get("region") == region), None)
        recent = _flow_recent_for_region(statistics.get("recent") or [], region)
        queue_count = _integer((section or {}).get("count"), 0)
        dlq = _integer((section or {}).get("deadLetterMessages"), 0)
        status = "abnormal" if not sqs.get("available") or dlq > 0 or queue_count == 0 else "normal"
        components.append({
            "id": f"sqs-{region}",
            "layer": "sqs",
            "name": f"SQS系統（{_region_role(region).upper()}）",
            "region": region,
            "status": status,
            "expectedStopped": False,
            "detail": f"キュー {queue_count}件 / 待機 {_integer((section or {}).get('visibleMessages'), 0)}件 / DLQ {dlq}件",
            "lastConnectivityAt": observed_at if sqs.get("available") else None,
            "lastPassedAt": _epoch_iso(recent.get("updatedEpoch")) if recent else None,
            "passageMs": recent.get("maxLatencyMs") if recent else None,
            "queues": (section or {}).get("queues") or [],
        })

    backup = system.get("backupInstances") or {}
    instances = backup.get("instances") or []
    if not instances:
        components.append({
            "id": "backup-unconfigured",
            "layer": "backup",
            "name": "バックアップ配信系統",
            "status": "stopped",
            "expectedStopped": True,
            "detail": "管理対象EC2は停止または未登録です",
            "lastConnectivityAt": observed_at if backup.get("available") else None,
            "lastPassedAt": None,
            "passageMs": None,
        })
    for instance in instances:
        state = _clean(instance.get("state"), 30).casefold()
        healthy = instance.get("instanceStatus") in {"ok", "unknown", "not_applicable"} and instance.get("systemStatus") in {"ok", "unknown", "not_applicable"}
        if state == "stopped":
            status = "stopped"
        elif state == "running" and healthy:
            status = "normal"
        else:
            status = "abnormal"
        recent = _flow_recent_for_region(statistics.get("recent") or [], _clean(instance.get("region"), 40))
        components.append({
            "id": f"backup-{_clean(instance.get('instanceId'), 40)}",
            "layer": "backup",
            "name": _clean(instance.get("name"), 160) or _clean(instance.get("instanceId"), 40),
            "region": _clean(instance.get("region"), 40),
            "status": status,
            "expectedStopped": state == "stopped",
            "detail": f"EC2 {state or 'unknown'} / 役割 {_clean(instance.get('backupRole'), 80) or '未設定'}",
            "lastConnectivityAt": observed_at if backup.get("available") else None,
            "lastPassedAt": _epoch_iso(recent.get("updatedEpoch")) if recent else None,
            "passageMs": recent.get("maxLatencyMs") if recent else None,
        })

    counts = {"normal": 0, "stopped": 0, "abnormal": 0, "unknown": 0}
    for component in components:
        key = component.get("status") if component.get("status") in counts else "unknown"
        counts[key] += 1
    value = {
        "summary": counts,
        "components": components,
        "layers": [
            {"id": "upstream", "label": "上流API"},
            {"id": "home", "label": "自宅サーバー"},
            {"id": "aws-fast", "label": "AWS高速系統"},
            {"id": "sqs", "label": "SQS系統"},
            {"id": "backup", "label": "バックアップ配信"},
        ],
        "costPolicy": "自動ポーリングは行わず、画面更新時に既存のハートビート・監視記録・AWS属性を再利用します。",
        "observedAt": observed_at,
    }
    _delivery_flow_cache.update({"expires_at": now + 45, "value": value})
    return value


def _load_flow_system_summary():
    now = time.time()
    if _system_cache["expires_at"] > now and _system_cache["value"] is not None:
        return _system_cache["value"]
    if _flow_system_cache["expires_at"] > now and _flow_system_cache["value"] is not None:
        return _flow_system_cache["value"]
    loaders = {
        "lambda": _lambda_summary,
        "sqs": _sqs_summary,
        "alarms": _alarm_summary,
        "backupInstances": _ec2_summary,
        "homeServers": _home_server_summary,
    }
    with ThreadPoolExecutor(max_workers=len(loaders)) as executor:
        futures = {name: executor.submit(_safe_section, loader) for name, loader in loaders.items()}
        value = {name: future.result() for name, future in futures.items()}
    _flow_system_cache.update({"expires_at": now + 45, "value": value})
    return value


def _dmdata_health():
    if not DMDATA_API_KEY_PARAMETER:
        return {"status": "abnormal", "expectedStopped": False, "detail": "APIキー保存先が未設定です", "lastConnectivityAt": None}
    if not STATE_TABLE_NAME:
        return {"status": "stopped", "expectedStopped": True, "detail": "履歴APIはオンデマンド参照待機中です", "lastConnectivityAt": None}
    try:
        record = _dynamodb.Table(STATE_TABLE_NAME).get_item(Key={"pk": "DMDATA#HEALTH"}).get("Item", {})
    except Exception:
        return {"status": "stopped", "expectedStopped": True, "detail": "履歴APIはオンデマンド参照待機中です", "lastConnectivityAt": None}
    if not record:
        return {"status": "stopped", "expectedStopped": True, "detail": "履歴APIはオンデマンド参照待機中です", "lastConnectivityAt": None}
    success_at = _integer(record.get("last_success_at"), 0)
    status = "normal" if _clean(record.get("status"), 30) == "normal" else "abnormal"
    return {
        "status": status,
        "expectedStopped": False,
        "detail": "最終API呼び出し成功" if status == "normal" else f"最終エラー: {_clean(record.get('last_error'), 100) or '不明'}",
        "lastConnectivityAt": _epoch_iso(success_at or _integer(record.get("last_error_at"), 0)),
    }


def _flow_recent_for_region(rows, region):
    region_text = _clean(region, 40).casefold()
    role = _region_role(region_text)
    for item in rows:
        owner = _clean(item.get("ownerRegion"), 80).casefold()
        if (region_text and region_text in owner) or (role and role in owner):
            return item
    return None


def _region_role(region):
    return {"ap-northeast-1": "tokyo", "ap-northeast-3": "osaka"}.get(_clean(region, 40).casefold(), _clean(region, 40).casefold() or "unknown")


def _timestamp(value):
    text = _clean(value, 60)
    if not text:
        return None
    try:
        if text.isdigit():
            number = int(text)
            return number / 1000 if number > 10_000_000_000 else float(number)
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


def _directory_entries(record):
    channel_id = _clean(record.get("id"), 30)
    channel_name = _clean(record.get("Ch_Name"), 100)
    deliveries = _string_list(record.get("app"), 100, item_length=120)
    updated_at = _normalize_time(record.get("time"))
    has_webhook = any(
        _valid_discord_webhook_url(candidate)
        for candidate in [*_string_list(record.get("URL"), 100), *_string_list(record.get("url"), 100)]
    )

    servers = []
    for key, value in record.items():
        key_text = _clean(key, 30)
        if key in RESERVED_FIELDS or not key_text.isdigit() or len(key_text) not in SNOWFLAKE_LENGTHS:
            continue
        server_name = _clean(value, 100)
        if server_name:
            servers.append((key_text, server_name))
    if not servers:
        servers.append(("", ""))

    return [{
        "serverId": server_id,
        "serverName": server_name,
        "channelId": channel_id,
        "channelName": channel_name,
        "channelType": None,
        "announcement": None,
        "deliveryTypes": deliveries,
        "permissions": None,
        "permissionSummary": None,
        "visibility": None,
        "memberCount": None,
        "updatedAt": updated_at,
        "hasWebhook": has_webhook,
    } for server_id, server_name in servers if channel_id or channel_name]


def _normalize_time(value):
    text = _clean(value, 40)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.isoformat()
    except ValueError:
        return text


def _string_list(value, limit, item_length=2048):
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
            value = parsed if isinstance(parsed, list) else re.split(r"[,、\n]+", text)
        except ValueError:
            value = re.split(r"[,、\n]+", text)
    if not isinstance(value, (list, tuple, set)):
        value = [value]
    result = []
    for item in value:
        text = _clean(item, item_length)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _normalize_delivery_name(value):
    text = _clean(value, 120)
    while DELIVERY_PREFIX_RE.match(text):
        text = DELIVERY_PREFIX_RE.sub("", text, count=1).strip()
    return text


def _control_ec2(body, actor, request_id):
    region = _clean(body.get("region"), 40)
    instance_id = _clean(body.get("instanceId"), 40)
    operation = _clean(body.get("operation"), 20).casefold()
    expected_confirmation = f"{operation}:{instance_id}"
    if region not in OPERATING_REGIONS:
        raise ValueError("操作対象リージョンが許可されていません。")
    if operation not in ALLOWED_EC2_ACTIONS:
        raise ValueError("EC2操作は起動・停止・再起動から選択してください。")
    if not re.fullmatch(r"i-[0-9a-f]{8,32}", instance_id):
        raise ValueError("EC2インスタンスIDが不正です。")
    if not hmac.compare_digest(_clean(body.get("confirmation"), 100), expected_confirmation):
        raise ValueError(f"確認欄に {expected_confirmation} と入力してください。")

    client = _client("ec2", region)
    response = client.describe_instances(
        InstanceIds=[instance_id],
        Filters=[{"Name": f"tag:{MANAGED_INSTANCE_TAG}", "Values": ["true"]}],
    )
    instances = [
        instance
        for reservation in response.get("Reservations", [])
        for instance in reservation.get("Instances", [])
    ]
    if len(instances) != 1:
        raise ValueError("このEC2はDPI-Botの管理対象として登録されていません。")
    before = _clean((instances[0].get("State") or {}).get("Name"), 30)
    if operation == "start":
        client.start_instances(InstanceIds=[instance_id])
    elif operation == "stop":
        client.stop_instances(InstanceIds=[instance_id])
    else:
        if before != "running":
            raise ValueError("再起動は実行中のEC2だけで行えます。")
        client.reboot_instances(InstanceIds=[instance_id])
    _audit_operation(actor, f"ec2.{operation}", request_id, {
        "region": region,
        "instance_id": instance_id,
        "state_before": before,
    })
    return {
        "message": f"EC2の{_ec2_operation_label(operation)}を受け付けました。",
        "operation": operation,
        "region": region,
        "instanceId": instance_id,
        "stateBefore": before,
    }


def _control_system_mode(body, actor, request_id):
    mode = _clean(body.get("mode"), 30).casefold()
    expected_confirmation = f"MODE:{mode.upper()}"
    reason = _clean(body.get("reason"), 300)
    if mode not in ALLOWED_SYSTEM_MODES:
        raise ValueError("システムモードを自動・通常固定・フェイルオーバー固定から選択してください。")
    if not hmac.compare_digest(_clean(body.get("confirmation"), 100), expected_confirmation):
        raise ValueError(f"確認欄に {expected_confirmation} と入力してください。")
    if mode != "automatic" and len(reason) < 4:
        raise ValueError("手動モードに変更する理由を4文字以上で入力してください。")
    if not STATE_TABLE_NAME:
        raise ValueError("システムモード用テーブルが設定されていません。")

    table = _dynamodb.Table(STATE_TABLE_NAME)
    current = table.get_item(Key={"pk": MANUAL_MODE_KEY}).get("Item", {})
    previous = current.get("previous_concurrency") if isinstance(current.get("previous_concurrency"), dict) else {}
    changed_instances = []
    now = int(time.time())

    if mode == "automatic":
        if current:
            for region in OPERATING_REGIONS:
                lambda_client = _client("lambda", region)
                saved = previous.get(region)
                if saved is None or int(saved) < 0:
                    try:
                        lambda_client.delete_function_concurrency(FunctionName=AUTO_MONITOR_FUNCTION)
                    except lambda_client.exceptions.ResourceNotFoundException:
                        pass
                else:
                    lambda_client.put_function_concurrency(
                        FunctionName=AUTO_MONITOR_FUNCTION,
                        ReservedConcurrentExecutions=int(saved),
                    )
        table.delete_item(Key={"pk": MANUAL_MODE_KEY})
        for region in OPERATING_REGIONS:
            _client("lambda", region).invoke(FunctionName=AUTO_MONITOR_FUNCTION, InvocationType="Event", Payload=b"{}")
    else:
        if not current:
            for region in OPERATING_REGIONS:
                concurrency = _client("lambda", region).get_function_concurrency(FunctionName=AUTO_MONITOR_FUNCTION)
                previous[region] = concurrency.get("ReservedConcurrentExecutions", -1)
        for region in OPERATING_REGIONS:
            _client("lambda", region).put_function_concurrency(
                FunctionName=AUTO_MONITOR_FUNCTION,
                ReservedConcurrentExecutions=0,
            )
        changed_instances = _reconcile_instances_for_mode(mode)
        table.put_item(Item={
            "pk": MANUAL_MODE_KEY,
            "mode": mode,
            "reason": reason,
            "requested_at": now,
            "requested_by": actor,
            "previous_concurrency": previous,
        })
        regional_mode = "NORMAL" if mode == "normal" else "FAILOVER"
        for region_role in ("TOKYO", "OSAKA"):
            table.update_item(
                Key={"pk": f"MODE#{region_role}"},
                UpdateExpression="SET #mode = :mode, updated_at = :updated, reason = :reason",
                ExpressionAttributeNames={"#mode": "mode"},
                ExpressionAttributeValues={
                    ":mode": regional_mode,
                    ":updated": now,
                    ":reason": f"manual by {actor}: {reason}",
                },
            )
    _audit_operation(actor, "system_mode.change", request_id, {
        "mode": mode,
        "reason": reason,
        "changed_instances": changed_instances,
    })
    return {
        "message": f"システムモードを「{_mode_label(mode)}」に変更しました。",
        "mode": mode,
        "changedInstances": changed_instances,
    }


def _reconcile_instances_for_mode(mode):
    changed = []
    for region in OPERATING_REGIONS:
        instances = _managed_instances_for_region(region)
        client = _client("ec2", region)
        start_ids = []
        stop_ids = []
        for instance in instances:
            desired = "running" if mode == "failover" else instance.get("normalState")
            current = instance.get("state")
            if desired == "running" and current == "stopped":
                start_ids.append(instance["instanceId"])
            elif desired == "stopped" and current == "running":
                stop_ids.append(instance["instanceId"])
        if start_ids:
            client.start_instances(InstanceIds=start_ids)
            changed.extend({"region": region, "instanceId": value, "operation": "start"} for value in start_ids)
        if stop_ids:
            client.stop_instances(InstanceIds=stop_ids)
            changed.extend({"region": region, "instanceId": value, "operation": "stop"} for value in stop_ids)
    return changed


def _xml_preview(body):
    xml_text = _xml_text(body)
    return {"preview": _parse_xml_summary(xml_text), "bytes": len(xml_text.encode("utf-8"))}


def _discord_announcement_preview(body):
    target_mode, delivery_slots, server_ids, deduplicate_channels = _announcement_targeting(body)
    targets, by_delivery = _load_announcement_targets(
        delivery_slots,
        server_ids,
        target_mode,
        deduplicate_channels,
    )
    return {
        "targetCount": len(targets),
        "byDelivery": by_delivery,
        "targetMode": target_mode,
        "deduplicateChannels": deduplicate_channels,
        "serverFilterApplied": bool(server_ids),
    }


def _discord_announcement(body, actor, request_id):
    if not hmac.compare_digest(_clean(body.get("confirmation"), 100), request_id):
        raise ValueError("配信確認が一致しません。")
    target_mode, delivery_slots, server_ids, deduplicate_channels = _announcement_targeting(body)
    subject = _clean(body.get("subject"), 121)
    message = str(body.get("body") or "").strip()
    delivery_format = _clean(body.get("deliveryFormat"), 20).casefold() or "message"
    embed_color = _integer(body.get("embedColor"), 0x5865F2)
    image_url = _clean(body.get("imageUrl"), 2048)
    image_alt = _clean(body.get("imageAlt"), 1024)
    image_name = _safe_image_name(body.get("imageName"), body.get("imageType"))
    image_type = _clean(body.get("imageType"), 50).casefold()
    image_bytes = _decode_announcement_image(body.get("imageBase64"), image_type)
    if not subject or len(subject) > 120 or re.search(r"[\r\n\x00-\x1f\x7f]", subject):
        raise ValueError("件名は改行なしの120文字以内で入力してください。")
    if delivery_format not in {"message", "embed"}:
        raise ValueError("Discordの送信形式を確認してください。")
    if not message or len(message) > 4096:
        raise ValueError("本文は4,096文字以内で入力してください。")
    if not 0 <= embed_color <= 0xFFFFFF:
        raise ValueError("Embed色を確認してください。")
    if image_url and (not _valid_https_url(image_url) or image_bytes):
        raise ValueError("画像URLと画像ファイルはどちらか一方だけ指定してください。")
    if delivery_format == "message" and len(f"**{subject}**\n\n{message}" + (f"\n\n{image_url}" if image_url else "")) > 2000:
        raise ValueError("通常メッセージは2,000文字以内にしてください。")

    targets, by_delivery = _load_announcement_targets(
        delivery_slots,
        server_ids,
        target_mode,
        deduplicate_channels,
    )
    if not targets:
        raise ValueError("選択条件に一致する有効なDiscord Webhookがありません。")
    state_table = _dynamodb.Table(STATE_TABLE_NAME) if STATE_TABLE_NAME else None
    operation_key = f"ADMIN#DISCORD_ANNOUNCEMENT#{request_id}"
    if state_table:
        existing = state_table.get_item(Key={"pk": operation_key}).get("Item", {})
        if existing.get("status") == "completed":
            return _announcement_result(existing, by_delivery, reused=True)
        if existing.get("status") == "failed":
            state_table.delete_item(Key={"pk": operation_key})
        try:
            state_table.put_item(
                Item={"pk": operation_key, "status": "sending", "actor": actor, "created_at": int(time.time()), "expires_at": int(time.time()) + 604800},
                ConditionExpression=Attr("pk").not_exists(),
            )
        except state_table.meta.client.exceptions.ConditionalCheckFailedException:
            raise ValueError("この配信は現在処理中です。完了後に更新してください。") from None

    payload = _discord_webhook_payload(subject, message, delivery_format, embed_color, image_url, image_name if image_bytes else "", image_alt)
    delivery_deadline = time.monotonic() + 105
    target_groups = {}
    for target in targets:
        target_groups.setdefault(target["url"], []).append(target)

    def deliver_group(group):
        group_results = []
        for index, target in enumerate(group):
            if time.monotonic() >= delivery_deadline:
                result = {"ok": False, "reason": "DELIVERY_DEADLINE", "status": 0}
            else:
                result = _post_discord_webhook(target["url"], payload, image_bytes, image_name, image_type)
            result["slot"] = target.get("slot") or ""
            group_results.append(result)
            if index + 1 < len(group):
                time.sleep(0.45)
        return group_results
    try:
        groups = list(target_groups.values())
        with ThreadPoolExecutor(max_workers=min(MAX_DISCORD_WORKERS, len(groups))) as executor:
            grouped_results = list(executor.map(deliver_group, groups))
        results = [result for group in grouped_results for result in group]
        sent_count = sum(1 for result in results if result.get("ok"))
        failed_count = len(results) - sent_count
        failure_summary = {}
        for result in results:
            if result.get("ok"):
                continue
            reason = _clean(result.get("reason"), 80) or "UNKNOWN"
            failure_summary[reason] = failure_summary.get(reason, 0) + 1
        completed = int(time.time())
        operation_status = "failed" if failed_count and sent_count == 0 else "completed"
        if state_table:
            state_table.update_item(
                Key={"pk": operation_key},
                UpdateExpression="SET #status = :status, target_count = :targets, sent_count = :sent, failed_count = :failed, failure_summary = :summary, completed_at = :completed",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":status": operation_status,
                    ":targets": len(targets),
                    ":sent": sent_count,
                    ":failed": failed_count,
                    ":summary": failure_summary,
                    ":completed": completed,
                },
            )
        _audit_operation(actor, "discord.announcement", request_id, {
            "target_mode": target_mode,
            "deduplicate_channels": deduplicate_channels,
            "delivery_slots": delivery_slots,
            "server_filter_count": len(server_ids),
            "target_count": len(targets),
            "sent_count": sent_count,
            "failed_count": failed_count,
            "failure_summary": failure_summary,
        })
        if failure_summary:
            print(json.dumps({
                "event": "discord_announcement_delivery_failures",
                "request_id": request_id,
                "target_count": len(targets),
                "sent_count": sent_count,
                "failure_summary": failure_summary,
            }, ensure_ascii=False))
        return {
            "message": "Discordお知らせの配信処理が完了しました。",
            "targetCount": len(targets),
            "sentCount": sent_count,
            "failedCount": failed_count,
            "failureSummary": failure_summary,
            "allFailed": bool(failed_count and sent_count == 0),
            "byDelivery": by_delivery,
        }
    except Exception:
        if state_table:
            state_table.update_item(
                Key={"pk": operation_key},
                UpdateExpression="SET #status = :status, failed_at = :failed",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": "failed", ":failed": int(time.time())},
            )
        raise


def _announcement_result(item, by_delivery, reused=False):
    return {
        "message": "Discordお知らせはすでに配信済みです。" if reused else "Discordお知らせの配信処理が完了しました。",
        "targetCount": _integer(item.get("target_count"), 0),
        "sentCount": _integer(item.get("sent_count"), 0),
        "failedCount": _integer(item.get("failed_count"), 0),
        "failureSummary": item.get("failure_summary") if isinstance(item.get("failure_summary"), dict) else {},
        "byDelivery": by_delivery,
        "reused": reused,
    }


def _announcement_targeting(body):
    delivery_slots = _announcement_delivery_slots(body)
    server_ids = _announcement_server_ids(body)
    target_mode = _clean(body.get("targetMode"), 30).casefold()
    if not target_mode:
        target_mode = "intersection" if server_ids else "delivery_slots"
    if target_mode not in {"delivery_slots", "servers", "intersection"}:
        raise ValueError("Discordの送信先指定方法を確認してください。")
    if target_mode == "delivery_slots" and not delivery_slots:
        raise ValueError("配信枠を1つ以上選択してください。")
    if target_mode == "servers" and not server_ids:
        raise ValueError("配信先サーバーを1つ以上選択してください。")
    if target_mode == "intersection" and (not delivery_slots or not server_ids):
        raise ValueError("配信枠と配信先サーバーをそれぞれ1つ以上選択してください。")
    if target_mode == "delivery_slots":
        server_ids = []
    elif target_mode == "servers":
        delivery_slots = []
    deduplicate_value = body.get("deduplicateChannels", True)
    if not isinstance(deduplicate_value, bool):
        raise ValueError("同一チャンネルへの送信方法を確認してください。")
    return target_mode, delivery_slots, server_ids, deduplicate_value


def _announcement_delivery_slots(body):
    slots = []
    values = body.get("deliverySlots") or []
    if not isinstance(values, list):
        raise ValueError("配信枠を確認してください。")
    for value in values:
        normalized = _normalize_delivery_name(value)
        if normalized and normalized not in slots:
            slots.append(normalized)
    if len(slots) > 100:
        raise ValueError("配信枠を確認してください。")
    return slots


def _announcement_server_ids(body):
    values = body.get("targetServerIds") or []
    if not isinstance(values, list) or len(values) > 500:
        raise ValueError("配信先サーバーを確認してください。")
    result = []
    for value in values:
        server_id = _clean(value, 30)
        if not re.fullmatch(r"\d{17,20}", server_id):
            raise ValueError("配信先サーバーを確認してください。")
        if server_id not in result:
            result.append(server_id)
    return result


def _load_announcement_targets(delivery_slots, server_ids, target_mode="delivery_slots", deduplicate_channels=True):
    selected_slots = set(delivery_slots)
    selected_servers = set(server_ids)
    targets = []
    seen = set()
    by_delivery_urls = {slot: set() for slot in delivery_slots}
    by_delivery_tasks = {slot: 0 for slot in delivery_slots}
    paginator = _table.meta.client.get_paginator("scan")
    for page in paginator.paginate(TableName=TABLE_NAME):
        for record in page.get("Items", []):
            record_servers = {
                _clean(key, 30) for key in record
                if _clean(key, 30).isdigit() and len(_clean(key, 30)) in SNOWFLAKE_LENGTHS
            }
            server_matches = bool(selected_servers.intersection(record_servers))
            if target_mode in {"servers", "intersection"} and not server_matches:
                continue
            record_slots = {
                _normalize_delivery_name(value)
                for value in _string_list(record.get("app"), 100, item_length=120)
            }
            record_slots.discard("")
            matched_slots = selected_slots.intersection(record_slots)
            if target_mode in {"delivery_slots", "intersection"} and not matched_slots:
                continue
            applicable_slots = matched_slots if target_mode in {"delivery_slots", "intersection"} else record_slots
            task_slots = sorted(applicable_slots) or [""]
            for candidate in [*_string_list(record.get("URL"), 100), *_string_list(record.get("url"), 100)]:
                if not _valid_discord_webhook_url(candidate):
                    continue
                for slot in applicable_slots:
                    by_delivery_urls.setdefault(slot, set())
                    by_delivery_urls[slot].add(candidate)
                for slot in task_slots:
                    target_key = candidate if deduplicate_channels else (candidate, slot)
                    if target_key in seen:
                        continue
                    seen.add(target_key)
                    targets.append({"url": candidate, "slot": slot})
                    if slot:
                        by_delivery_tasks[slot] = by_delivery_tasks.get(slot, 0) + 1
                    if deduplicate_channels:
                        break
    by_delivery = {
        slot: len(urls) if deduplicate_channels else by_delivery_tasks.get(slot, 0)
        for slot, urls in by_delivery_urls.items()
    }
    return targets, by_delivery


def _discord_webhook_payload(subject, message, delivery_format, color, image_url, image_name, image_alt):
    payload = {"allowed_mentions": {"parse": []}}
    attachment_url = f"attachment://{image_name}" if image_name else ""
    if delivery_format == "embed":
        embed = {"title": subject, "description": message, "color": color, "footer": {"text": "DPI-Bot 運営"}}
        if attachment_url or image_url:
            embed["image"] = {"url": attachment_url or image_url}
        payload["embeds"] = [embed]
    else:
        payload["content"] = f"**{subject}**\n\n{message}" + (f"\n\n{image_url}" if image_url else "")
    if image_name:
        attachment = {"id": 0, "filename": image_name}
        if image_alt:
            attachment["description"] = image_alt
        payload["attachments"] = [attachment]
    return payload


def _post_discord_webhook(url, payload, image_bytes, image_name, image_type):
    endpoint = f"{url}{'&' if '?' in url else '?'}wait=true"
    headers = {"User-Agent": "DPI-Bot-Admin-Announcement/2.0"}
    if image_bytes:
        boundary = f"dpi-{uuid.uuid4().hex}"
        body = _multipart_discord_body(boundary, payload, image_bytes, image_name, image_type)
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    else:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    for attempt in range(2):
        _wait_for_discord_rate_slot()
        request = urllib.request.Request(endpoint, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=6) as response:
                if 200 <= response.status < 300:
                    return {"ok": True, "reason": "OK", "status": response.status}
                return {"ok": False, "reason": f"HTTP_{response.status}", "status": response.status}
        except urllib.error.HTTPError as error:
            reason = _discord_http_error_reason(error)
            if attempt == 0 and (error.code == 429 or error.code >= 500):
                time.sleep(_discord_retry_delay(error))
                continue
            return {"ok": False, "reason": reason, "status": error.code}
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == 0:
                continue
            reason = "NETWORK_TIMEOUT" if isinstance(error, TimeoutError) or isinstance(getattr(error, "reason", None), TimeoutError) else "NETWORK_ERROR"
            return {"ok": False, "reason": reason, "status": 0}
        except ValueError:
            return {"ok": False, "reason": "INVALID_WEBHOOK_URL", "status": 0}
    return {"ok": False, "reason": "UNKNOWN", "status": 0}


def _wait_for_discord_rate_slot():
    global _discord_next_request_at
    with _discord_rate_lock:
        now = time.monotonic()
        scheduled = max(now, _discord_next_request_at)
        _discord_next_request_at = scheduled + DISCORD_REQUEST_INTERVAL_SECONDS
    delay = scheduled - time.monotonic()
    if delay > 0:
        time.sleep(delay)


def _discord_http_error_reason(error):
    discord_code = ""
    try:
        raw = error.read(2048)
        parsed = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
        if isinstance(parsed, dict) and isinstance(parsed.get("code"), int):
            discord_code = f"_DISCORD_{parsed['code']}"
    except (OSError, TypeError, ValueError):
        pass
    return f"HTTP_{error.code}{discord_code}"[:80]


def _discord_retry_delay(error):
    retry_after = error.headers.get("Retry-After", "") if error.headers else ""
    try:
        return min(10.0, max(0.25, float(retry_after)))
    except (TypeError, ValueError):
        return 1.0


def _multipart_discord_body(boundary, payload, image_bytes, image_name, image_type):
    prefix = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n"
        f"Content-Type: application/json\r\n\r\n{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"{image_name}\"\r\n"
        f"Content-Type: {image_type}\r\n\r\n"
    ).encode("utf-8")
    return prefix + image_bytes + f"\r\n--{boundary}--\r\n".encode("ascii")


def _decode_announcement_image(value, image_type):
    if not value:
        return b""
    if image_type not in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
        raise ValueError("画像形式を確認してください。")
    try:
        data = b64decode(str(value), validate=True)
    except (ValueError, TypeError):
        raise ValueError("画像データを確認してください。") from None
    if not data or len(data) > MAX_DISCORD_IMAGE_BYTES or not _valid_image_signature(data, image_type):
        raise ValueError("画像はPNG・JPEG・GIF・WebPのいずれかで、1.25MB以内にしてください。")
    return data


def _valid_image_signature(data, image_type):
    return {
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/gif": data.startswith((b"GIF87a", b"GIF89a")),
        "image/webp": len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP",
    }.get(image_type, False)


def _safe_image_name(value, image_type):
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", _clean(value, 100))
    extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}.get(_clean(image_type, 50).casefold(), ".bin")
    return name if "." in name else f"announcement{extension}"


def _valid_https_url(value):
    try:
        parsed = urllib.parse.urlparse(value)
        return parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password
    except (TypeError, ValueError):
        return False


def _valid_discord_webhook_url(value):
    try:
        parsed = urllib.parse.urlparse(value)
        if parsed.scheme != "https" or parsed.hostname not in {"discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"}:
            return False
        return bool(re.fullmatch(r"/api(?:/v\d+)?/webhooks/\d{17,20}/[A-Za-z0-9._-]+/?", parsed.path)) and not parsed.username and not parsed.password
    except (TypeError, ValueError):
        return False


def _xml_dispatch(body, actor, request_id):
    xml_text = _xml_text(body)
    preview = _parse_xml_summary(xml_text)
    dmdata_source = _dmdata_source_from_body(body.get("dmdataSource"))
    xml_digest = hashlib.sha256(xml_text.encode("utf-8")).hexdigest()
    if dmdata_source and not hmac.compare_digest(dmdata_source["xmlSha256"], xml_digest):
        raise ValueError("選択したDMDATA電文とXML本文が一致しません。電文を読み込み直してください。")
    send_data = _clean(body.get("sendData"), 30).casefold()
    delivery_slot = _normalize_delivery_name(body.get("deliverySlot"))
    expected_confirmation = f"XML配信:{delivery_slot}"
    if send_data not in ALLOWED_SEND_DATA:
        raise ValueError("XMLの配信経路を選択してください。")
    if not delivery_slot:
        raise ValueError("配信枠を選択してください。")
    if not hmac.compare_digest(_clean(body.get("confirmation"), 180), expected_confirmation):
        raise ValueError(f"確認欄に {expected_confirmation} と入力してください。")
    if not INGEST_ENDPOINTS or not INGEST_HMAC_PARAMETER:
        raise ValueError("XML配信先が設定されていません。")
    targets = _load_dispatch_targets(delivery_slot)
    if not targets:
        raise ValueError("選択した配信枠に有効な配信先URLがありません。")

    now = datetime.now(tz=timezone.utc).isoformat()
    delivery_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"dpi-admin:{xml_digest}:{delivery_slot}:{send_data}"))
    _record_delivery_metadata(
        delivery_id,
        preview.get("headline") or preview.get("controlTitle") or "気象庁XML",
        delivery_slot,
        send_data,
        dmdata_source,
    )
    payload = {
        "title": preview.get("headline") or preview.get("controlTitle") or "気象庁XML",
        "url": targets,
        "data": xml_text,
        "id": delivery_id,
        "delivery_id": delivery_id,
        "source_uuid": delivery_id,
        "times": now,
        "type": preview.get("controlTitle") or "XML",
        "send_data": send_data,
        "delivery_slot": delivery_slot,
        **({"dmdata_id": dmdata_source["sourceId"]} if dmdata_source else {}),
        "_home_trace": {
            "source": "dmdata-history" if dmdata_source else "admin-center",
            "actor": actor,
            "requested_at": now,
            **({"dmdata_id": dmdata_source["sourceId"]} if dmdata_source else {}),
        },
    }
    raw_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    secret = _get_ingest_secret()
    timestamp = str(int(time.time()))
    signature = hmac.new(secret.encode("utf-8"), timestamp.encode("ascii") + b"." + raw_body, hashlib.sha256).hexdigest()
    if dmdata_source:
        _record_dmdata_dispatch(dmdata_source, "dispatching", delivery_slot, send_data, delivery_id, preview)
    try:
        results = [_post_signed_ingest(endpoint, raw_body, timestamp, signature) for endpoint in INGEST_ENDPOINTS]
    except Exception:
        if dmdata_source:
            _record_dmdata_dispatch(dmdata_source, "failed", delivery_slot, send_data, delivery_id, preview)
        raise
    if dmdata_source:
        _record_dmdata_dispatch(dmdata_source, "delivered", delivery_slot, send_data, delivery_id, preview)
    _audit_operation(actor, "xml.dispatch", request_id, {
        "delivery_slot": delivery_slot,
        "send_data": send_data,
        "target_count": len(targets),
        "endpoint_count": len(results),
        "xml_sha256": xml_digest,
        "delivery_id": delivery_id,
        "dmdata_source_id": dmdata_source["sourceId"] if dmdata_source else None,
    })
    return {
        "message": "XML配信を受け付けました。二重送信は既存の配信IDで抑止されます。",
        "deliverySlot": delivery_slot,
        "sendData": send_data,
        "targetCount": len(targets),
        "deliveryId": delivery_id,
        "endpoints": results,
        "preview": preview,
        "dmdataSource": dmdata_source,
    }


def _dmdata_source_from_body(value):
    if value in (None, ""):
        return None
    if not isinstance(value, dict):
        raise ValueError("DMDATAの電文情報が不正です。")
    return {
        "sourceId": _valid_dmdata_source_id(value.get("sourceId")),
        "classification": _clean(value.get("classification"), 80),
        "typeCode": _clean(value.get("typeCode"), 40),
        "receivedTime": _clean(value.get("receivedTime"), 60),
        "eventId": _clean(value.get("eventId"), 80),
        "title": _clean(value.get("title"), 300),
        "xmlSha256": _valid_sha256(value.get("xmlSha256")),
    }


def _valid_sha256(value):
    digest = _clean(value, 64).casefold()
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("DMDATA電文の整合性情報が不正です。電文を読み込み直してください。")
    return digest


def _record_delivery_metadata(delivery_id, title, delivery_slot, send_data, dmdata_source):
    now = int(time.time())
    values = {
        ":metadata_kind": "delivery-metadata",
        ":delivery_id": delivery_id,
        ":generation": 1,
        ":title": _clean(title, 300) or "気象庁XML",
        ":delivery_slot": delivery_slot,
        ":send_data": send_data,
        ":now": now,
        ":expires": now + 604_800,
    }
    update = (
        "SET #kind = if_not_exists(#kind, :metadata_kind), "
        "deliveryId = if_not_exists(deliveryId, :delivery_id), "
        "generation = if_not_exists(generation, :generation), #title = :title, "
        "deliverySlot = :delivery_slot, sendData = :send_data, "
        "metadataUpdatedEpoch = :now, expiresAt = if_not_exists(expiresAt, :expires)"
    )
    if dmdata_source:
        update += ", dmdataId = :dmdata_id, source_uuid = :dmdata_id"
        values[":dmdata_id"] = dmdata_source["sourceId"]
    _dynamodb.Table(DELIVERY_MONITOR_TABLE_NAME).update_item(
        Key={"pk": f"delivery#{delivery_id}#g1"},
        UpdateExpression=update,
        ExpressionAttributeNames={"#kind": "kind", "#title": "title"},
        ExpressionAttributeValues=values,
    )


def _record_dmdata_dispatch(source, status, delivery_slot, send_data, delivery_id, preview):
    if not STATE_TABLE_NAME:
        return
    now = int(time.time())
    _dynamodb.Table(STATE_TABLE_NAME).put_item(Item={
        "pk": f"DMDATA#SOURCE#{source['sourceId']}",
        "source_id": source["sourceId"],
        "classification": source.get("classification") or "",
        "type_code": source.get("typeCode") or "",
        "event_id": source.get("eventId") or "",
        "received_time": source.get("receivedTime") or "",
        "title": preview.get("headline") or preview.get("controlTitle") or source.get("title") or "",
        "status": status,
        "delivery_slot": delivery_slot,
        "send_data": send_data,
        "delivery_id": delivery_id,
        "updated_at": now,
        "expires_at": now + 31_536_000,
    })
    for cached in _dmdata_history_cache.values():
        for item in cached.get("value", {}).get("items", []):
            if item.get("sourceId") != source["sourceId"]:
                continue
            item["deliveryState"] = "delivered" if status == "delivered" else ("dispatching" if status == "dispatching" else "undelivered")
            item["deliveryStateLabel"] = {"delivered": "配信済み", "dispatching": "配信処理中", "failed": "未配信（前回失敗）"}.get(status, "未配信")
            item["lastDeliveryAt"] = _epoch_iso(now)
            item["lastDeliverySlot"] = delivery_slot
            item["lastSendData"] = send_data


def _xml_text(body):
    value = body.get("xml")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("XMLファイルまたはXML本文を入力してください。")
    encoded = value.encode("utf-8")
    if len(encoded) > MAX_XML_BYTES:
        raise ValueError("XMLは1.5MB以下にしてください。")
    lowered = value.casefold()
    if "<!doctype" in lowered or "<!entity" in lowered:
        raise ValueError("DOCTYPEまたはENTITYを含むXMLは配信できません。")
    return value.strip()


def _parse_xml_summary(xml_text):
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as error:
        raise ValueError(f"XMLを解析できません: {error}") from None
    values = {}
    wanted = {"Title", "DateTime", "Status", "EditorialOffice", "PublishingOffice", "EventID", "ReportDateTime", "TargetDateTime"}
    for element in root.iter():
        name = element.tag.rsplit("}", 1)[-1]
        text = (element.text or "").strip()
        if name in wanted and text and name not in values:
            values[name] = text[:500]
    control = next((element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "Control"), None)
    head = next((element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "Head"), None)
    return {
        "root": root.tag.rsplit("}", 1)[-1][:100],
        "controlTitle": _child_text(control, "Title"),
        "headline": _child_text(head, "Title") or values.get("Title", ""),
        "eventId": values.get("EventID", ""),
        "reportDateTime": values.get("ReportDateTime", "") or values.get("DateTime", ""),
        "targetDateTime": values.get("TargetDateTime", ""),
        "status": values.get("Status", ""),
        "publishingOffice": values.get("PublishingOffice", "") or values.get("EditorialOffice", ""),
    }


def _child_text(parent, local_name):
    if parent is None:
        return ""
    for child in parent.iter():
        if child.tag.rsplit("}", 1)[-1] == local_name and (child.text or "").strip():
            return (child.text or "").strip()[:500]
    return ""


def _load_dispatch_targets(delivery_slot):
    targets = []
    paginator = _table.meta.client.get_paginator("scan")
    for page in paginator.paginate(
        TableName=TABLE_NAME,
        ProjectionExpression="#app, #upper_url, #lower_url",
        ExpressionAttributeNames={"#app": "app", "#upper_url": "URL", "#lower_url": "url"},
    ):
        for record in page.get("Items", []):
            slots = {
                _normalize_delivery_name(value)
                for value in _string_list(record.get("app"), 100, item_length=120)
            }
            if delivery_slot not in slots:
                continue
            for candidate in [*_string_list(record.get("URL"), 100), *_string_list(record.get("url"), 100)]:
                if _valid_target_url(candidate) and candidate not in targets:
                    targets.append(candidate)
    return targets


def _valid_target_url(value):
    try:
        parsed = urllib.parse.urlparse(value)
        return parsed.scheme == "https" and bool(parsed.netloc) and not parsed.username and not parsed.password
    except (TypeError, ValueError):
        return False


def _get_ingest_secret():
    now = time.time()
    if _secret_cache["expires_at"] > now and _secret_cache["value"]:
        return _secret_cache["value"]
    response = _client("ssm").get_parameter(Name=INGEST_HMAC_PARAMETER, WithDecryption=True)
    value = str((response.get("Parameter") or {}).get("Value") or "")
    if not value:
        raise ValueError("XML配信用署名キーを取得できません。")
    _secret_cache.update({"expires_at": now + 300, "value": value})
    return value


def _post_signed_ingest(endpoint, raw_body, timestamp, signature):
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".amazonaws.com"):
        raise ValueError("XML配信エンドポイントが不正です。")
    request = urllib.request.Request(endpoint, data=raw_body, method="POST", headers={
        "Content-Type": "application/json",
        "X-DPI-Timestamp": timestamp,
        "X-DPI-Signature": signature,
        "User-Agent": "dpi-admin-center/1.0",
    })
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            return {"region": _endpoint_region(parsed.hostname), "status": response.status, "accepted": 200 <= response.status < 300}
    except urllib.error.HTTPError as error:
        raise ValueError(f"XML配信先がHTTP {error.code}を返しました。") from None
    except urllib.error.URLError:
        raise ValueError("XML配信先に接続できませんでした。") from None


def _endpoint_region(hostname):
    match = re.search(r"execute-api\.([a-z0-9-]+)\.amazonaws\.com$", hostname or "")
    return match.group(1) if match else "unknown"


def _audit_operation(actor, action, request_id, details):
    if not STATE_TABLE_NAME:
        return
    now = int(time.time())
    _dynamodb.Table(STATE_TABLE_NAME).put_item(Item={
        "pk": f"ADMIN_AUDIT#{now:010d}#{request_id}",
        "actor": actor,
        "action": action,
        "request_id": request_id,
        "details": details,
        "created_at": now,
        "expires_at": now + 31_536_000,
    })


def _epoch_iso(value):
    if not value:
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError):
        return None


def _ec2_operation_label(operation):
    return {"start": "起動", "stop": "停止", "reboot": "再起動"}.get(operation, operation)


def _mode_label(mode):
    return {"automatic": "自動", "normal": "通常固定", "failover": "フェイルオーバー固定"}.get(mode, mode)


def _clean(value, limit):
    return str(value).strip()[:limit] if value is not None else ""


def _integer(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_limit(value):
    text = _clean(value, 20).casefold()
    if not text or text == "all":
        return None
    requested = _integer(text, MAX_LIMITED_RESULTS)
    return min(max(requested, 1), MAX_LIMITED_RESULTS)


def _response(status, body, headers=None):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            **(headers or {}),
        },
        "body": json.dumps(body, ensure_ascii=False, separators=(",", ":")),
    }

