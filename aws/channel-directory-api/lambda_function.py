import hmac
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import boto3
from botocore.config import Config


TABLE_NAME = os.environ.get("TABLE_NAME", "EarthquakeData").strip()
API_TOKEN = os.environ.get("DIRECTORY_API_TOKEN", "").strip()
HOME_SERVER_TABLE_NAME = os.environ.get("HOME_SERVER_TABLE_NAME", "").strip()
MONITORED_TABLE_NAMES = [name.strip() for name in os.environ.get("MONITORED_TABLE_NAMES", TABLE_NAME).split(",") if name.strip()]
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
_system_cache = {"expires_at": 0.0, "value": None}


def lambda_handler(event, context):
    if not _authorized(event):
        return _response(401, {"success": False, "message": "認証に失敗しました。"})
    if event.get("requestContext", {}).get("http", {}).get("method", "GET") != "GET":
        return _response(405, {"success": False, "message": "許可されていない操作です。"}, {"Allow": "GET"})

    params = event.get("queryStringParameters") or {}
    if _clean(params.get("view"), 30).casefold() == "system":
        return _response(200, {
            "success": True,
            "system": _load_system_summary(),
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
        "deliveryDirectory": _delivery_directory_summary,
    }
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {name: executor.submit(_safe_section, loader) for name, loader in loaders.items()}
        summary = {"region": os.environ.get("AWS_REGION", "")}
        summary.update({name: future.result() for name, future in futures.items()})
    _system_cache["value"] = summary
    _system_cache["expires_at"] = now + 20
    return summary


def _client(service):
    return boto3.client(service, config=Config(
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
    functions = []
    paginator = _client("lambda").get_paginator("list_functions")
    for page in paginator.paginate(PaginationConfig={"MaxItems": 500}):
        functions.extend(page.get("Functions", []))
    return {
        "available": True,
        "count": len(functions),
        "names": sorted(_clean(item.get("FunctionName"), 100) for item in functions if item.get("FunctionName"))[:100],
    }


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
    client = _client("sqs")
    urls = client.list_queues(MaxResults=1000).get("QueueUrls", [])
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
        queues.append({"name": name[:100], "visible": count, "inFlight": _integer(attributes.get("ApproximateNumberOfMessagesNotVisible"), 0)})
    return {"available": True, "count": len(urls), "visibleMessages": visible, "deadLetterMessages": dead_letter, "queues": queues}


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
    paginator = _client("ec2").get_paginator("describe_instances")
    for page in paginator.paginate(Filters=[{"Name": "tag:DPI-Bot-Role", "Values": ["backup", "standby"]}], PaginationConfig={"MaxItems": 100}):
        for reservation in page.get("Reservations", []):
            instances.extend(reservation.get("Instances", []))
    states = {}
    for instance in instances:
        state = _clean((instance.get("State") or {}).get("Name"), 30) or "unknown"
        states[state] = states.get(state, 0) + 1
    return {"available": True, "count": len(instances), "states": states}


def _stack_summary():
    stacks = []
    paginator = _client("cloudformation").get_paginator("describe_stacks")
    for page in paginator.paginate(PaginationConfig={"MaxItems": 200}):
        stacks.extend(page.get("Stacks", []))
    return {
        "available": True,
        "count": len(stacks),
        "failed": sum(1 for stack in stacks if any(word in _clean(stack.get("StackStatus"), 80) for word in ("FAILED", "ROLLBACK"))),
        "items": [{"name": _clean(stack.get("StackName"), 120), "status": _clean(stack.get("StackStatus"), 80)} for stack in stacks[:100]],
    }


def _home_server_summary():
    if not HOME_SERVER_TABLE_NAME:
        return {"available": False, "configured": False, "healthy": 0, "unhealthy": 0, "lastHeartbeat": None}
    records = _dynamodb.Table(HOME_SERVER_TABLE_NAME).scan(Limit=100).get("Items", [])
    now = datetime.now(tz=timezone.utc).timestamp()
    healthy = 0
    last_heartbeat = None
    for record in records:
        raw_time = next((record.get(key) for key in ("lastHeartbeat", "last_heartbeat", "updatedAt", "updated_at", "time") if record.get(key)), None)
        normalized = _normalize_time(raw_time)
        if normalized and (last_heartbeat is None or normalized > last_heartbeat):
            last_heartbeat = normalized
        timestamp = _timestamp(raw_time)
        status = _clean(record.get("status"), 40).casefold()
        if status in {"healthy", "ok", "online", "running"} and timestamp is not None and now - timestamp <= 300:
            healthy += 1
    return {"available": True, "configured": True, "count": len(records), "healthy": healthy, "unhealthy": max(0, len(records) - healthy), "lastHeartbeat": last_heartbeat}


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
            by_type[delivery_type] = by_type.get(delivery_type, 0) + 1
    return {
        "available": True,
        "entries": len(entries),
        "servers": len(servers),
        "channels": len(channels),
        "byType": dict(sorted(by_type.items(), key=lambda item: (-item[1], item[0]))[:100]),
    }


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

