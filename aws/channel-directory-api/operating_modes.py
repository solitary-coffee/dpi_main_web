"""Versioned operating-mode contract. No network or side effects."""
PROTOCOL_VERSION = 2
BASE_PROTOCOL_VERSION = 1
# Runtime adapters are included. Deployment capability evidence is independently
# required for every source and AWS region before new modes become available.
RUNTIME_INTEGRATION_COMPLETE = True
MODES = {"automatic", "normal", "standby", "backup", "manual", "maintenance", "emergency", "emergency_stop", "failover"}
NODES = ("home", "tokyo-eew", "tokyo-weather", "osaka-eew", "osaka-weather")
RUNTIME_COMPONENTS = (*NODES, "aws-tokyo", "aws-osaka")
ROUTES = ("fast", "sqs", "regional-backup", "cross-region-backup")
LABELS = {"automatic": "自動監視", "normal": "通常モード", "standby": "スタンバイモード",
          "backup": "バックアップモード", "manual": "手動モード", "maintenance": "メンテナンスモード",
          "emergency": "緊急モード",
          "emergency_stop": "緊急停止モード", "failover": "バックアップ固定（旧設定）"}
REGIONAL_MODES = {"normal": "NORMAL", "standby": "BACKUP_STANDBY", "backup": "BACKUP",
                  "failover": "BACKUP", "manual": "MANUAL", "maintenance": "MAINTENANCE",
                  "emergency": "EMERGENCY",
                  "emergency_stop": "EMERGENCY_STOP"}


def build_plan(mode, overrides=None):
    if mode not in MODES:
        raise ValueError("システムモードを選択してください。")
    if mode == "automatic":
        return {node: {"delivery": "automatic", "waitSeconds": None} for node in NODES}
    plan = {node: {"delivery": "immediate", "waitSeconds": 0} for node in NODES}
    if mode == "normal":
        for node in NODES[1:]:
            plan[node] = {"delivery": "standby" if node in {"tokyo-eew", "osaka-weather"} else "stopped", "waitSeconds": 3 if node in {"tokyo-eew", "osaka-weather"} else 0}
    elif mode == "standby":
        for node in ("tokyo-weather", "osaka-eew"):
            plan[node] = {"delivery": "standby", "waitSeconds": 3}
    elif mode == "emergency_stop":
        plan = {node: {"delivery": "stopped", "waitSeconds": 0} for node in NODES}
    elif mode in {"manual", "maintenance"}:
        if not isinstance(overrides, dict) or set(overrides) != set(NODES):
            raise ValueError("自宅とEC2の4台すべての動作を指定してください。")
        for node, policy in overrides.items():
            if not isinstance(policy, dict) or set(policy) != {"delivery", "waitSeconds"}:
                raise ValueError("ノード設定の形式が不正です。")
            delivery, wait = policy["delivery"], policy["waitSeconds"]
            if delivery not in {"immediate", "standby", "stopped"}:
                raise ValueError("即時配信・待機配信・配信停止から選択してください。")
            if type(wait) is not int or not 0 <= wait <= 300 or (delivery == "standby" and wait < 1):
                raise ValueError("待機時間は1〜300秒の整数で指定してください。")
            plan[node] = {"delivery": delivery, "waitSeconds": wait if delivery == "standby" else 0}
    elif overrides:
        raise ValueError("ノード別設定は手動・メンテナンスモードでのみ指定できます。")
    return plan


def build_route_plan(mode, overrides=None):
    default = {
        "fast": {"enabled": True, "priority": 1},
        "sqs": {"enabled": True, "priority": 2},
        "regional-backup": {"enabled": True, "priority": 3},
        "cross-region-backup": {"enabled": True, "priority": 4},
    }
    if mode != "maintenance":
        if overrides:
            raise ValueError("配信系統の個別設定はメンテナンスモードでのみ指定できます。")
        return default
    if not isinstance(overrides, dict) or set(overrides) != set(ROUTES):
        raise ValueError("高速・SQS・リージョン内・相互バックアップの全系統を指定してください。")
    plan = {}
    enabled_priorities = []
    for route in ROUTES:
        policy = overrides.get(route)
        if not isinstance(policy, dict) or set(policy) != {"enabled", "priority"}:
            raise ValueError("配信系統設定の形式が不正です。")
        enabled = policy.get("enabled")
        priority = policy.get("priority")
        if type(enabled) is not bool or type(priority) is not int or not 1 <= priority <= len(ROUTES):
            raise ValueError("配信系統の有効状態と優先順位を確認してください。")
        plan[route] = {"enabled": enabled, "priority": priority}
        if enabled:
            enabled_priorities.append(priority)
    if not enabled_priorities:
        raise ValueError("メンテナンス中も最低1つの配信系統を有効にしてください。")
    if len(enabled_priorities) != len(set(enabled_priorities)):
        raise ValueError("有効な配信系統の優先順位は重複できません。")
    return plan


def notification_policy(mode):
    if mode == "maintenance":
        return {
            "suppressNonEssential": True,
            "allowedKinds": ["critical", "security", "test", "test-failure"],
        }
    return {"suppressNonEssential": False, "allowedKinds": []}


def runtime_readiness(records, now, minimum_protocol=BASE_PROTOCOL_VERSION):
    missing = []
    stale = []
    for node in RUNTIME_COMPONENTS:
        record = records.get(node, {})
        try:
            seen = int(record.get("observed_at") or 0)
        except (ValueError, TypeError):
            seen = 0
        try:
            compatible = int(record.get("protocol_version") or 0) >= int(minimum_protocol)
        except (TypeError, ValueError):
            compatible = False
        if not (compatible
                and record.get("capability_verified") is True
                and record.get("installation_id") and record.get("coverage_digest")):
            missing.append(node)
        if record.get("verified") is not True or not 0 <= now - seen <= 90:
            stale.append(node)
    return {"ready": not missing, "missing": missing, "stale": stale, "protocolVersion": PROTOCOL_VERSION}


def application_status(record, revision, now, requested=None):
    """Installation proof is never evidence that a live sender has stopped."""
    try:
        compatible = int(record.get("protocol_version") or 0) >= BASE_PROTOCOL_VERSION
    except (TypeError, ValueError):
        compatible = False
    if not compatible or record.get("capability_verified") is not True:
        return "unconfirmed"
    try:
        fresh = 0 <= now - int(record.get("observed_at", 0)) <= 90
        same_revision = int(record.get("applied_revision", -1)) == revision
    except (ValueError, TypeError):
        return "unconfirmed"
    if not fresh or record.get("verified") is not True:
        return "unconfirmed"
    if not same_revision:
        return "pending"
    if requested and requested.get("delivery") != "automatic":
        if record.get("delivery") != requested.get("delivery"):
            return "pending"
        if record.get("delivery") == "standby" and record.get("wait_seconds") != requested.get("waitSeconds"):
            return "pending"
    return "applied"


def stored_plan(mode, overrides=None):
    if mode in {"manual", "maintenance"} and isinstance(overrides, dict):
        from decimal import Decimal
        overrides = {node: {**policy, "waitSeconds": int(policy["waitSeconds"])
                            if isinstance(policy.get("waitSeconds"), Decimal) and policy["waitSeconds"] == int(policy["waitSeconds"])
                            else policy.get("waitSeconds")} for node, policy in overrides.items()}
    return build_plan(mode, overrides)


def stored_route_plan(mode, overrides=None):
    if isinstance(overrides, dict):
        from decimal import Decimal
        overrides = {route: {**policy, "priority": int(policy["priority"])
                             if isinstance(policy.get("priority"), Decimal)
                             and policy["priority"] == int(policy["priority"])
                             else policy.get("priority")}
                     for route, policy in overrides.items()}
    return build_route_plan(mode, overrides)
