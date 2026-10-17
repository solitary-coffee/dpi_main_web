import hmac
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from base64 import b64decode
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import boto3
from botocore.config import Config


TABLE_NAME = os.environ.get("TABLE_NAME", "EarthquakeData").strip()
API_TOKEN = os.environ.get("DIRECTORY_API_TOKEN", "").strip()
HOME_SERVER_TABLE_NAME = os.environ.get("HOME_SERVER_TABLE_NAME", "").strip()
MONITORED_TABLE_NAMES = [name.strip() for name in os.environ.get("MONITORED_TABLE_NAMES", TABLE_NAME).split(",") if name.strip()]
STATE_TABLE_NAME = os.environ.get("STATE_TABLE_NAME", HOME_SERVER_TABLE_NAME or "DPI-BackupFleetState-v51").strip()
OPERATING_REGIONS = [name.strip() for name in os.environ.get("OPERATING_REGIONS", "ap-northeast-1,ap-northeast-3").split(",") if name.strip()]
AUTO_MONITOR_FUNCTION = os.environ.get("AUTO_MONITOR_FUNCTION", "dpi-backup-auto-failover-monitor").strip()
INGEST_ENDPOINTS = [url.strip() for url in os.environ.get("INGEST_ENDPOINTS", "").split(",") if url.strip()]
INGEST_HMAC_PARAMETER = os.environ.get("INGEST_HMAC_PARAMETER", "").strip()
MAX_LIMITED_RESULTS = 1000
MAX_XML_BYTES = 1_500_000
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
_secret_cache = {"expires_at": 0.0, "value": None}


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


def _json_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = b64decode(raw).decode("utf-8")
    if len(raw.encode("utf-8")) > MAX_XML_BYTES + 64_000:
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
    else:
        raise ValueError("指定された管理操作はありません。")

    _system_cache["expires_at"] = 0.0
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
    instances = []
    paginator = client.get_paginator("describe_instances")
    for page in paginator.paginate(
        Filters=[{"Name": f"tag:{MANAGED_INSTANCE_TAG}", "Values": ["true"]}],
        PaginationConfig={"MaxItems": 100},
    ):
        for reservation in page.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                tags = {str(tag.get("Key", "")): str(tag.get("Value", "")) for tag in instance.get("Tags", [])}
                instances.append({
                    "instanceId": _clean(instance.get("InstanceId"), 30),
                    "name": _clean(tags.get("Name"), 120) or _clean(instance.get("InstanceId"), 30),
                    "region": region,
                    "state": _clean((instance.get("State") or {}).get("Name"), 30) or "unknown",
                    "normalState": _clean(tags.get("dpi:normal-state"), 30) or "unknown",
                    "backupRole": _clean(tags.get("dpi:backup-role"), 80) or "unknown",
                    "availabilityZone": _clean((instance.get("Placement") or {}).get("AvailabilityZone"), 40),
                    "launchTime": _normalize_time(instance.get("LaunchTime")),
                    "controllable": True,
                })
    return instances


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
        text = _clean(item, 100)
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


def _xml_dispatch(body, actor, request_id):
    xml_text = _xml_text(body)
    preview = _parse_xml_summary(xml_text)
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
    payload = {
        "title": preview.get("headline") or preview.get("controlTitle") or "気象庁XML",
        "url": targets,
        "data": xml_text,
        "id": request_id,
        "delivery_id": request_id,
        "source_uuid": request_id,
        "times": now,
        "type": preview.get("controlTitle") or "XML",
        "send_data": send_data,
        "_home_trace": {"source": "admin-center", "actor": actor, "requested_at": now},
    }
    raw_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    secret = _get_ingest_secret()
    results = [_post_signed_ingest(endpoint, raw_body, secret) for endpoint in INGEST_ENDPOINTS]
    _audit_operation(actor, "xml.dispatch", request_id, {
        "delivery_slot": delivery_slot,
        "send_data": send_data,
        "target_count": len(targets),
        "endpoint_count": len(results),
        "xml_sha256": hashlib.sha256(xml_text.encode("utf-8")).hexdigest(),
    })
    return {
        "message": "XML配信を受け付けました。二重送信は既存の配信IDで抑止されます。",
        "deliverySlot": delivery_slot,
        "sendData": send_data,
        "targetCount": len(targets),
        "endpoints": results,
        "preview": preview,
    }


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
            slots = {_normalize_delivery_name(value) for value in _string_list(record.get("app"), 100)}
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


def _post_signed_ingest(endpoint, raw_body, secret):
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".amazonaws.com"):
        raise ValueError("XML配信エンドポイントが不正です。")
    timestamp = str(int(time.time()))
    signature = hmac.new(secret.encode("utf-8"), timestamp.encode("ascii") + b"." + raw_body, hashlib.sha256).hexdigest()
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

