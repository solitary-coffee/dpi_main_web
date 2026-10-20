"""Transport-independent delivery gate; no AWS/Discord access at import time.

Integrators call wait() BEFORE taking a delivery claim and check() immediately
before EVERY outbound attempt (including retries). Existing deduplication remains
the responsibility of the sender. A blocked delivery is not a successful send.
The loader returns a fresh authoritative mode record or raises on read failure.
"""
import copy
import math
import threading
import time
from dataclasses import dataclass

from operating_modes import NODES, build_plan


class DeliveryBlocked(RuntimeError):
    """A terminal suppression or temporary control-plane outage."""
    def __init__(self, reason, *, retryable=False):
        super().__init__(reason)
        self.reason = reason
        self.retryable = retryable


@dataclass(frozen=True)
class Decision:
    revision: int
    mode: str
    delivery: str
    wait_seconds: int


def _integer(value):
    # DynamoDB resources decode numbers as Decimal; bool is never a revision.
    if isinstance(value, bool) or not isinstance(value, (int, float)) and type(value).__name__ != "Decimal":
        raise ValueError("invalid integer")
    result = int(value)
    if result != value or result < 0:
        raise ValueError("invalid integer")
    return result


def validate_record(record):
    if not isinstance(record, dict) or not record:
        raise ValueError("mode record missing")
    revision = _integer(record.get("revision"))
    mode = record.get("mode")
    overrides = record.get("node_overrides") or None
    # Normalize Decimal waits through strict integral validation.
    if mode == "manual" and isinstance(overrides, dict):
        overrides = {node: {**p, "waitSeconds": _integer(p["waitSeconds"])} for node, p in overrides.items()}
    plan = build_plan(mode, overrides)
    cutoff = _integer(record.get("discard_before_epoch", 0))
    return {"revision": revision, "mode": mode, "plan": plan, "cutoff": cutoff}


class DeliveryGate:
    def __init__(self, loader, *, refresh_seconds=5, max_age_seconds=10,
                 clock=time.monotonic, epoch=time.time, sleep=time.sleep):
        if not 0 < refresh_seconds <= max_age_seconds <= 90:
            raise ValueError("invalid refresh/lease bounds")
        self.loader = loader
        self.refresh_seconds = refresh_seconds
        self.max_age_seconds = max_age_seconds
        self.clock, self.epoch, self.sleep = clock, epoch, sleep
        self._lock = threading.Lock()
        self._record = None
        self._last_success = float("-inf")
        self._next_refresh = float("-inf")

    def _snapshot(self):
        with self._lock:
            now = self.clock()
            if now >= self._next_refresh:
                self._next_refresh = now + self.refresh_seconds
                try:
                    candidate = validate_record(self.loader())
                    if self._record:
                        if candidate["revision"] < self._record["revision"]:
                            raise ValueError("stale replica")
                        if candidate["revision"] == self._record["revision"] and candidate != self._record:
                            raise ValueError("conflicting revision")
                        if candidate["cutoff"] < self._record["cutoff"]:
                            raise ValueError("stop cutoff rollback")
                    self._record = candidate
                    self._last_success = now
                except Exception:
                    # Bounded use of the last valid read, never indefinite fail-open.
                    pass
            if self._record is None or now - self._last_success >= self.max_age_seconds:
                raise DeliveryBlocked("mode_control_unavailable", retryable=True)
            return copy.deepcopy(self._record)

    def check(self, node, *, admitted_at, automatic_policy=None):
        record = self._snapshot()
        if record["mode"] == "emergency_stop":
            raise DeliveryBlocked("emergency_stop")
        if record["cutoff"]:
            if (isinstance(admitted_at, bool) or not isinstance(admitted_at, (int, float))
                    or not math.isfinite(admitted_at)
                    or admitted_at <= record["cutoff"] or admitted_at > self.epoch() + 5):
                raise DeliveryBlocked("pre_stop_or_unstamped_message")
        # Regional workers use the global stop/cutoff; source decisions happen
        # before ingestion. Do not wait twice or infer origin from user payloads.
        if node in {"aws-tokyo", "aws-osaka"}:
            return Decision(record["revision"], record["mode"], "immediate", 0)
        if node not in NODES:
            raise DeliveryBlocked("unknown_source")
        policy = record["plan"][node]
        if record["mode"] == "automatic":
            if automatic_policy is None:
                raise DeliveryBlocked("automatic_policy_missing", retryable=True)
            policy = automatic_policy()
        if not isinstance(policy, dict) or policy.get("delivery") not in {"immediate", "standby", "stopped"}:
            raise DeliveryBlocked("invalid_source_policy", retryable=True)
        if policy["delivery"] == "stopped":
            raise DeliveryBlocked("source_stopped")
        try:
            wait = _integer(policy.get("waitSeconds", 0))
            if wait > 300 or policy["delivery"] == "standby" and wait < 1:
                raise ValueError("invalid wait")
        except (ValueError, TypeError, OverflowError):
            raise DeliveryBlocked("invalid_source_policy", retryable=True) from None
        return Decision(record["revision"], record["mode"], policy["delivery"],
                        wait if policy["delivery"] == "standby" else 0)

    def wait(self, node, *, admitted_at, automatic_policy=None, legacy_fast=False):
        started = self.clock()
        if isinstance(admitted_at, (int, float)) and not isinstance(admitted_at, bool) and math.isfinite(admitted_at):
            started -= max(0, self.epoch() - admitted_at)
        while True:
            decision = self.check(node, admitted_at=admitted_at, automatic_policy=automatic_policy)
            if legacy_fast and node.endswith("-eew") and decision.mode in {"normal", "standby"}:
                return Decision(decision.revision, decision.mode, "immediate", 0)
            remaining = decision.wait_seconds - (self.clock() - started)
            if remaining <= 0:
                return decision
            # Refresh shared cache at its normal interval, not once per webhook.
            self.sleep(min(0.1, remaining))

    def acknowledgement(self, node, *, automatic_policy=None):
        try:
            before = self._snapshot()
            decision = self.check(node, admitted_at=self.epoch(), automatic_policy=automatic_policy)
            delivery, wait = decision.delivery, decision.wait_seconds
        except DeliveryBlocked as error:
            if error.reason not in {"emergency_stop", "source_stopped"}:
                return {"verified": False, "error": error.reason}
            delivery, wait = "stopped", 0
        # This ACK only asserts this gate is loaded. Deployment must separately
        # verify that every actual egress calls it before publishing verified=True.
        record = self._snapshot()
        if record != before:
            return {"verified": False, "error": "mode_changed_during_observation"}
        return {"protocol_version": 1, "applied_revision": record["revision"],
                "delivery": delivery, "wait_seconds": wait,
                "observed_at": int(self.epoch()), "verified": False,
                "gate_loaded": True}
