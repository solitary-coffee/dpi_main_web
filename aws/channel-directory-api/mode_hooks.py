"""Opt-in integration points shared by home, EC2 and AWS delivery processes.

Deploy alongside delivery_gate.py and operating_modes.py. DPI_MODE_ENABLED=1
requires explicit node/table configuration; missing control data fails closed.
No import-time SDK initialization and no extra network for disabled deployments.
"""
import json
import hashlib
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from functools import lru_cache

from delivery_gate import DeliveryGate, DeliveryBlocked, validate_record
from operating_modes import PROTOCOL_VERSION
from mode_observation import aggregate, local_rows, publish, write_atomic
from mode_transition import acquire_monitor, release_monitor

_gate = None
_lock = threading.Lock()
_file_lock = threading.Lock()
_registered = {}
_observer_started = False


@lru_cache(maxsize=1)
def configuration():
    path = Path(os.environ.get("DPI_MODE_CONFIG", str(Path(__file__).with_name("mode_runtime_config.json"))))
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def setting(name, default=""):
    return os.environ.get(name, configuration().get(name, default))


def enabled():
    return setting("DPI_MODE_ENABLED") == "1"


def _node():
    node = setting("DPI_MODE_NODE")
    if not node:
        raise DeliveryBlocked("mode_node_unconfigured", retryable=True)
    return node


def _load_file():
    path = setting("DPI_MODE_FILE")
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
                region = setting("DPI_MODE_REGION")
                table_name = setting("DPI_MODE_STATE_TABLE")
                if not region or not table_name:
                    raise ValueError("mode table/region missing")
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


def wait_source(received_at, automatic_policy=None, legacy_fast=False):
    if enabled():
        policy = automatic_policy or (lambda: {"delivery": "immediate", "waitSeconds": 0})
        return _get_gate().wait(_node(), admitted_at=received_at, automatic_policy=policy, legacy_fast=legacy_fast)


def check_source(received_at, automatic_policy=None):
    if enabled():
        policy = automatic_policy or (lambda: {"delivery": "immediate", "waitSeconds": 0})
        return _get_gate().check(_node(), admitted_at=received_at, automatic_policy=policy)


def prepare_source(payload):
    if not enabled():
        return
    stamp = admitted_at(payload)
    decision = check_source(stamp)
    marker = payload.get("_dpi_mode") or {}
    if marker.get("waited_revision") != decision.revision:
        wait_source(stamp)
    # Preserve the source timestamp through queues/retries; never refresh it at
    # the worker or a retry would resurrect pre-stop messages after resume.
    payload["_dpi_mode"] = {"admitted_at": stamp, "waited_revision": decision.revision}


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


def route_policy(route_id):
    if not enabled():
        return {"route": route_id, "priority": 1, "revision": 0, "mode": "disabled"}
    return _get_gate().route(route_id)


def route_allowed(route_id):
    try:
        route_policy(route_id)
        return True
    except DeliveryBlocked as error:
        if error.reason in {"maintenance_route_stopped", "emergency_stop"}:
            return False
        raise


def wait_route(route_id):
    """Apply maintenance route priority before an MRSC lease is attempted."""
    policy = route_policy(route_id)
    wait_seconds = int(policy.get("waitSeconds", 0))
    if wait_seconds > 0:
        time.sleep(wait_seconds)
        policy = route_policy(route_id)
    return policy


def candidate_route(payload):
    """Classify a durable regional copy without trusting user-facing fields."""
    test = payload.get("_dpi_test") or {}
    explicit = test.get("route") if isinstance(test, dict) else None
    if explicit in {"fast", "sqs", "regional-backup", "cross-region-backup"}:
        return explicit
    ha = payload.get("_ha") or {}
    current = setting("DPI_MODE_REGION")
    accepted = str(ha.get("accepted_region") or "")
    primary = str(ha.get("primary_region") or "")
    if current and accepted and current != accepted:
        return "cross-region-backup"
    if current and primary and current != primary:
        return "regional-backup"
    return "sqs"


def notification_allowed(kind="operational"):
    if not enabled():
        return True
    try:
        return _get_gate().notification_allowed(kind)
    except DeliveryBlocked:
        return str(kind) in {"critical", "security", "test", "test-failure"}


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
    path = Path(setting("DPI_MODE_FILE"))
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


def source_policy():
    node = _node()
    if node == "home" or node.startswith("aws-"):
        return {"delivery": "immediate", "waitSeconds": 0}
    if node.endswith("-eew"):
        from dpi_backup.mode_runtime import delivery_wait
    else:
        from mode_runtime import delivery_wait
    region = "ap-northeast-1" if node.startswith("tokyo-") else "ap-northeast-3"
    wait, _ = delivery_wait(region, baseline=node in {"tokyo-eew", "osaka-weather"})
    return {"delivery": "standby" if wait else "immediate", "waitSeconds": int(wait)}


def _state_table(authority=False):
    import boto3
    from botocore.config import Config
    region = setting("DPI_MODE_AUTHORITY_REGION") if authority else setting("DPI_MODE_REGION")
    if not region:
        raise ValueError("mode region missing")
    return boto3.resource("dynamodb", region_name=region,
                          config=Config(connect_timeout=1, read_timeout=2,
                                        retries={"total_max_attempts": 1})).Table(setting("DPI_MODE_STATE_TABLE"))


def coordinate_monitor(callback, context):
    if not enabled():
        return callback()
    table = _state_table(authority=True)
    owner = context.aws_request_id
    duration = max(1, int(context.get_remaining_time_in_millis() / 1000)) + 30
    try:
        acquire_monitor(table, owner=owner, now=int(time.time()), duration=duration)
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return {"ok": True, "manual_override_or_monitor_busy": True}
        raise  # Never perform infrastructure changes when coordination is unavailable.
    try:
        return callback()
    finally:
        try:
            release_monitor(table, owner)
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise


def monitor_allows_actions():
    if not enabled():
        return True
    record = _state_table(authority=True).get_item(Key={"pk": "ADMIN#SYSTEM_MODE"}, ConsistentRead=True).get("Item", {})
    return record.get("mode", "automatic") == "automatic"


def _manifest():
    path = setting("DPI_MODE_MANIFEST")
    if not path:
        raise ValueError("runtime manifest missing")
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _ack_directory():
    value = setting("DPI_MODE_ACK_DIRECTORY")
    if not value:
        raise ValueError("acknowledgement directory missing")
    return Path(value)


def observe_once():
    manifest = _manifest()
    ack = _get_gate().acknowledgement(_node(), automatic_policy=source_policy)
    for role, sha in list(_registered.items()):
        row = {**ack, "member": role, "pid": os.getpid(), "code_sha": sha,
               "installation_id": manifest["installation_id"]}
        row["verified"] = bool(ack.get("gate_loaded") and {**manifest.get("members", {}), **manifest.get("optional_members", {})}.get(role) == sha)
        write_atomic(_ack_directory() / f"{role}-{os.getpid()}.json", row)
    if _node() != "home":
        evidence = aggregate(manifest, local_rows(_ack_directory()), int(time.time()))
        publish(_state_table(), _node(), evidence)


def register(role, filename):
    global _observer_started
    _registered[role] = hashlib.sha256(Path(filename).read_bytes()).hexdigest()
    # Lambda runtimes are frozen between invocations. They use explicit probes
    # instead of background threads; no misleading heartbeat is manufactured.
    if not enabled() or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        return
    with _lock:
        if _observer_started:
            return
        _observer_started = True
    def run():
        while True:
            try:
                observe_once()
            except Exception as error:
                print("mode observation unavailable:", type(error).__name__)
            time.sleep(30)
    threading.Thread(target=run, name="dpi-mode-observer", daemon=True).start()


def home_evidence(manager_payload, required_names):
    if not enabled():
        return None
    try:
        programs = manager_payload.get("programs") or {}
        expected_pids = [int(p["pid"]) for name, p in programs.items()
                         if name in required_names and p.get("running") and p.get("pid")]
        if not programs:
            return {"verified": False, "capability_verified": False, "error": "manager_unavailable"}
        observe_once()
        return aggregate(_manifest(), local_rows(_ack_directory()), int(time.time()), expected_pids)
    except Exception as error:
        return {"verified": False, "capability_verified": False, "error": type(error).__name__}


def accept_home_evidence(table, payload):
    if enabled():
        evidence = payload.get("mode_runtime")
        if isinstance(evidence, dict) and evidence.get("installation_id"):
            publish(table, "home", evidence)


def probe():
    """Read-only function probe for private InvokeFunction deployment checks."""
    ack = _get_gate().acknowledgement(_node(), automatic_policy=source_policy)
    return {"mode_probe": True, "protocol_version": PROTOCOL_VERSION, "node": _node(),
            "members": dict(_registered), "acknowledgement": ack,
            "enabled": enabled()}


def timestamp():
    return time.time()


def direct_discord_post(post, *args, mode_admitted_at=None, **kwargs):
    if enabled():
        wait_source(mode_admitted_at)
        check_source(mode_admitted_at)
    return post(*args, **kwargs)
