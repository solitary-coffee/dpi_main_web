"""Evidence aggregation; install capability and live application are separate."""
import hashlib
import json
import os
from pathlib import Path
import time


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def aggregate(manifest, rows, now, expected_pids=None):
    expected = manifest.get("members", {})
    allowed = {**manifest.get("optional_members", {}), **expected}
    installation = manifest.get("installation_id")
    if not expected or not installation:
        return {"verified": False, "capability_verified": False, "error": "manifest_missing"}
    chosen = []
    missing = []
    for member, code_sha in expected.items():
        candidates = [r for r in rows if r.get("member") == member
                      and r.get("installation_id") == installation and r.get("code_sha") == code_sha]
        if not candidates:
            missing.append(member)
        else:
            chosen.append(max(candidates, key=lambda r: int(r.get("observed_at", 0))))
    # Home: require ACKs from every running producer PID reported by the manager,
    # not merely one process which happened to import the common client.
    missing_pids = []
    revisions = {int(r.get("applied_revision", -1)) for r in chosen}
    policies = {(r.get("delivery"), r.get("wait_seconds")) for r in chosen}
    for pid in expected_pids or []:
        if not any(r.get("pid") == pid and r.get("installation_id") == installation
                   and r.get("member") in allowed and r.get("code_sha") == allowed[r["member"]]
                   and 0 <= now - int(r.get("observed_at", 0)) <= 90
                   and len(revisions) == 1 and int(r.get("applied_revision", -1)) in revisions
                   and len(policies) == 1 and (r.get("delivery"), r.get("wait_seconds")) in policies
                   and r.get("verified") is True for r in rows):
            missing_pids.append(pid)
    capable = not missing
    fresh = all(r.get("verified") is True and 0 <= now - int(r.get("observed_at", 0)) <= 90 for r in chosen)
    verified = capable and fresh and not missing_pids and len(revisions) == 1 and len(policies) == 1
    policy = next(iter(policies)) if len(policies) == 1 else (None, None)
    return {"protocol_version": 1, "installation_id": installation,
            "coverage_digest": digest(manifest.get("files") or allowed), "capability_verified": capable,
            "installed_at": manifest.get("created_at", 0),
            "verified": verified, "missing_members": missing, "missing_pids": missing_pids,
            "observed_at": min((int(r.get("observed_at", 0)) for r in chosen), default=0),
            "applied_revision": next(iter(revisions)) if len(revisions) == 1 else -1,
            "delivery": policy[0], "wait_seconds": policy[1]}


def write_atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def local_rows(directory):
    rows = []
    for path in Path(directory).glob("*.json"):
        try:
            rows.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    return rows


def publish(table, node, evidence):
    # A stale process cannot replace a newer deployment's live evidence.
    current = table.get_item(Key={"pk": f"MODE_RUNTIME#{node}"}, ConsistentRead=True).get("Item", {})
    if current.get("installation_id") and current["installation_id"] != evidence.get("installation_id"):
        if int(evidence.get("installed_at", 0)) <= int(current.get("installed_at", 0)):
            return False
    values = dict(evidence)
    values["pk"] = f"MODE_RUNTIME#{node}"
    try:
        table.put_item(Item=values,
                       ConditionExpression="attribute_not_exists(installation_id) OR (installation_id=:id AND (attribute_not_exists(observed_at) OR observed_at <= :at)) OR (installation_id=:old AND installed_at < :installed)",
                       ExpressionAttributeValues={":id": evidence.get("installation_id", ""), ":at": evidence.get("observed_at", 0),
                                                  ":old": current.get("installation_id", ""), ":installed": evidence.get("installed_at", 0)})
    except Exception as error:
        response = getattr(error, "response", {})
        if response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise
    return True
