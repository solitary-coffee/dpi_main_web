"""Serialize administrator operations in the authoritative regional table.

The lease exceeds this API's 120 second Lambda timeout. A crashed invocation
can therefore be retried without allowing two live invocations to act together.
Never use a replica in another region for writes to this record.
"""
from decimal import Decimal

KEY = "ADMIN#SYSTEM_MODE"
LEASE_SECONDS = 180


def reserve(table, current, *, mode, plan, overrides, actor, reason,
            request_id, expected_revision, now, previous_concurrency):
    revision = int(current.get("revision", 0))
    if type(expected_revision) is not int or expected_revision != revision:
        raise ValueError("別の管理操作でモードが変更されました。最新情報に更新してください。")
    if current.get("transition_status") == "applying" and int(current.get("lease_until", 0)) > now:
        raise ValueError("別のモード変更を処理中です。完了後に最新情報に更新してください。")
    item = dict(current)
    item.update(pk=KEY, mode=mode, node_plan=plan, node_overrides=overrides or {},
                reason=reason, requested_by=actor, requested_at=now,
                revision=revision + 1, operation_id=request_id,
                transition_status="applying", transition_error="",
                lease_until=now + LEASE_SECONDS,
                previous_concurrency=previous_concurrency)
    # Preserve a durable cutoff through every subsequent automatic/manual mode.
    # Workers must reject messages admitted before this boundary after resume.
    if mode == "emergency_stop":
        item["discard_before_epoch"] = now
    elif current.get("mode") == "emergency_stop":
        item["discard_before_epoch"] = now
    condition = "(attribute_not_exists(revision) OR revision = :revision) AND (attribute_not_exists(transition_status) OR transition_status <> :applying OR lease_until <= :now)"
    table.put_item(Item=item, ConditionExpression=condition,
                   ExpressionAttributeValues={":revision": Decimal(revision),
                                              ":applying": "applying", ":now": now})
    return item


def finish(table, operation, *, status, error=""):
    table.update_item(
        Key={"pk": KEY},
        UpdateExpression="SET transition_status=:status, transition_error=:error REMOVE lease_until",
        ConditionExpression="revision=:revision AND operation_id=:operation",
        ExpressionAttributeValues={":status": status, ":error": error[:300],
                                   ":revision": operation["revision"],
                                   ":operation": operation["operation_id"]},
    )
