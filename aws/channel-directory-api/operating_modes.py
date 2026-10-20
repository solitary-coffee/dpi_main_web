"""Versioned operating-mode contract. No network or side effects."""
PROTOCOL_VERSION = 1
# Phase 1 is deliberately not an end-to-end stop implementation. Enable only
# after sender/receiver/ingress/worker adapters and their integration tests land.
RUNTIME_INTEGRATION_COMPLETE = False
MODES = {"automatic", "normal", "standby", "backup", "manual", "emergency", "emergency_stop", "failover"}
NODES = ("home", "tokyo-eew", "tokyo-weather", "osaka-eew", "osaka-weather")
RUNTIME_COMPONENTS = (*NODES, "aws-tokyo", "aws-osaka")
LABELS = {"automatic": "自動監視", "normal": "通常モード", "standby": "スタンバイモード",
          "backup": "バックアップモード", "manual": "手動モード", "emergency": "緊急モード",
          "emergency_stop": "緊急停止モード", "failover": "バックアップ固定（旧設定）"}
REGIONAL_MODES = {"normal": "NORMAL", "standby": "BACKUP_STANDBY", "backup": "BACKUP",
                  "failover": "BACKUP", "manual": "MANUAL", "emergency": "EMERGENCY",
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
    elif mode == "manual":
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
        raise ValueError("ノード別設定は手動モードでのみ指定できます。")
    return plan


def runtime_readiness(records, now):
    missing = []
    for node in RUNTIME_COMPONENTS:
        record = records.get(node, {})
        seen = int(record.get("observed_at") or 0)
        if record.get("protocol_version") != PROTOCOL_VERSION or not 0 <= now - seen <= 90 or record.get("verified") is not True:
            missing.append(node)
    return {"ready": not missing, "missing": missing, "protocolVersion": PROTOCOL_VERSION}
