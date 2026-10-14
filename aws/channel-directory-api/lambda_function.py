import hmac
import json
import os
from datetime import datetime, timezone

import boto3
from botocore.config import Config


TABLE_NAME = os.environ.get("TABLE_NAME", "EarthquakeData").strip()
API_TOKEN = os.environ.get("DIRECTORY_API_TOKEN", "").strip()
MAX_LIMITED_RESULTS = 1000
SNOWFLAKE_LENGTHS = {17, 18, 19, 20}
RESERVED_FIELDS = {"id", "Ch_Name", "app", "time", "URL", "url"}

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


def lambda_handler(event, context):
    if not _authorized(event):
        return _response(401, {"success": False, "message": "認証に失敗しました。"})
    if event.get("requestContext", {}).get("http", {}).get("method", "GET") != "GET":
        return _response(405, {"success": False, "message": "許可されていない操作です。"}, {"Allow": "GET"})

    params = event.get("queryStringParameters") or {}
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

    return _response(200, {
        "success": True,
        "items": matched,
        "count": len(matched),
        "source": {"region": os.environ.get("AWS_REGION", ""), "table": TABLE_NAME},
    })


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


def _directory_entries(record):
    channel_id = _clean(record.get("id"), 30)
    channel_name = _clean(record.get("Ch_Name"), 100)
    deliveries = _string_list(record.get("app"), 100)
    updated_at = _normalize_time(record.get("time"))

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


def _string_list(value, limit):
    if not isinstance(value, (list, tuple, set)):
        return []
    result = []
    for item in value:
        text = _clean(item, 100)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


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
