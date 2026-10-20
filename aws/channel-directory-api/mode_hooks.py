"""Opt-in integration points shared by home, EC2 and AWS delivery processes.

Deploy alongside delivery_gate.py and operating_modes.py. DPI_MODE_ENABLED=1
requires explicit node/table configuration; missing control data fails closed.
No import-time SDK initialization and no extra network for disabled deployments.
"""
import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path

from delivery_gate import DeliveryGate, DeliveryBlocked, validate_record

_gate = None
_lock = threading.Lock()
_file_lock = threading.Lock()


def enabled():
    return os.environ.get("DPI_MODE_ENABLED") == "1"


def _node():
    node = os.environ.get("DPI_MODE_NODE", "")
    if not node:
        raise DeliveryBlocked("mode_node_unconfigured", retryable=True)
    return node


def _load_file():
    path = os.environ.get("DPI_MODE_FILE")
    if not path:
        raise ValueError("DPI_MODE_FILE missing")
    wrapper = json.loads(Path(path).read_text(encoding="utf-8"))
    age = time.time() - float(wrapper["received_at"])
    if not 0 <= age <= 45:
        raise ValueError("heartbeat mode response expired")
    return wrapper["record"]


def _get_gate():
    global _gate
    with _lock:
        if _gate is None:
            if _node() == "home":
                loader = _load_file
            else:
                import boto3
                from botocore.config import Config
                # Explicit region: never accidentally create a second writer.
                region = os.environ["DPI_MODE_REGION"]
                table_name = os.environ["DPI_MODE_STATE_TABLE"]
                table = boto3.resource("dynamodb", region_name=region,
                                       config=Config(connect_timeout=1, read_timeout=2,
                                                     retries={"total_max_attempts": 1})).Table(table_name)
                loader = lambda: table.get_item(Key={"pk": "ADMIN#SYSTEM_MODE"}, ConsistentRead=True).get("Item")
            _gate = DeliveryGate(loader)
        return _gate


def admitted_at(payload):
    marker = payload.get("_dpi_mode") or {}
    value = marker.get("admitted_at") if isinstance(marker, dict) else None
    if value is None:
        value = (payload.get("_home_trace") or {}).get("home_event_received_at_ms")
    if value is None:
        value = payload.get("times")
    try:
        if isinstance(value, str) and "T" in value:
            stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return stamp.timestamp() if stamp.tzinfo else None
        if isinstance(value, bool):
            return None
        number = float(value)
        return number / 1000 if number >= 100_000_000_000 else number
    except (TypeError, ValueError, OverflowError):
        return None


def wait_source(received_at, automatic_policy=None):
    if enabled():
        policy = automatic_policy or (lambda: {"delivery": "immediate", "waitSeconds": 0})
        return _get_gate().wait(_node(), admitted_at=received_at, automatic_policy=policy)


def check_source(received_at, automatic_policy=None):
    if enabled():
        policy = automatic_policy or (lambda: {"delivery": "immediate", "waitSeconds": 0})
        return _get_gate().check(_node(), admitted_at=received_at, automatic_policy=policy)


def prepare_source(payload):
    if not enabled():
        return
    stamp = admitted_at(payload)
    wait_source(stamp)
    # Preserve the source timestamp through queues/retries; never refresh it at
    # the worker or a retry would resurrect pre-stop messages after resume.
    payload["_dpi_mode"] = {"admitted_at": stamp}


def before_source_http(raw_body):
    if enabled():
        check_source(admitted_at(json.loads(raw_body)))


def worker_check(marker):
    if not enabled():
        return None
    try:
        _get_gate().check(_node(), admitted_at=(marker or {}).get("admitted_at"))
    except DeliveryBlocked as error:
        return {"error_kind": error.reason, "retryable": error.retryable,
                "reason": error.reason, "suppressed_by_mode": True}
    return None


def ingress_check(payload):
    if not enabled():
        return None
    # Called after request authentication but before HOME_SEEN/lease acquisition.
    marker = {"admitted_at": admitted_at(payload)}
    error = worker_check(marker)
    if not error:
        payload["_dpi_mode"] = marker
    return error


def save_heartbeat_policy(response):
    """Call only with a successful authenticated heartbeat HTTPS response."""
    if not enabled():
        return
    record = response.get("operating_mode")
    candidate = validate_record(record)
    path = Path(os.environ["DPI_MODE_FILE"])
    with _file_lock:
        if path.exists():
            previous = validate_record(json.loads(path.read_text(encoding="utf-8"))["record"])
            if candidate["revision"] < previous["revision"]:
                return  # A lagging regional response must not renew freshness.
            if candidate["revision"] == previous["revision"] and candidate != previous:
                raise ValueError("conflicting heartbeat mode revision")
            if candidate["cutoff"] < previous["cutoff"]:
                raise ValueError("heartbeat stop cutoff rollback")
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        data = {"record": record, "received_at": time.time()}
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
