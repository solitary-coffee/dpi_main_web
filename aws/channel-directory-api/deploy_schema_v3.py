#!/usr/bin/env python3
"""Safely enable v1/v2/v3 supporter snapshot publishing in the deployed AWS Lambda.

Requires AWS CloudShell with boto3 and permission to GetFunction/UpdateFunctionCode.
By default this script is READ-ONLY against AWS and saves a verified rollback ZIP.

    python3 deploy_schema_v3.py --check
    python3 deploy_schema_v3.py --apply
    python3 deploy_schema_v3.py --rollback

Never invokes the Lambda, publishes an ACTIVE snapshot, or alters operating mode.
"""
import argparse
import ast
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import time
import urllib.request
import zipfile

NAME = "dpi-channel-directory-api"
REGION = "ap-northeast-1"
OLD_CHECK = 'int(value.get("schemaVersion", 0)) != 1'
NEW_CHECK = 'int(value.get("schemaVersion", 0)) not in (1, 2, 3)'
OLD_VERSION = '"schemaVersion": 1,'
NEW_VERSION = '"schemaVersion": int(value["schemaVersion"]),'


def sha(raw):
    return base64.b64encode(hashlib.sha256(raw).digest()).decode("ascii")


def function_source(source, name):
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, ast.FunctionDef) and node.name == name]
    if len(nodes) != 1:
        raise RuntimeError(f"Unexpected function {name} in deployed ZIP")
    lines = source.splitlines(keepends=True)
    return "".join(lines[nodes[0].lineno - 1:nodes[0].end_lineno])


def patch(source):
    validator = function_source(source, "_validate_supporter_snapshot")
    if NEW_CHECK in validator and NEW_VERSION in validator:
        return source, False
    if validator.count(OLD_CHECK) != 1 or validator.count(OLD_VERSION) != 1:
        raise RuntimeError("Unrecognized deployed validator; refusing update")
    updated = validator.replace(OLD_CHECK, NEW_CHECK).replace(OLD_VERSION, NEW_VERSION)
    candidate = source.replace(validator, updated, 1)
    ast.parse(candidate)
    if function_source(candidate, "_validate_supporter_snapshot") != updated:
        raise RuntimeError("Patch affected unexpected source")
    return candidate, True


def verify(source):
    tree = ast.parse(source)
    names = ("_clean", "_integer", "_validate_supporter_snapshot")
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    if len(nodes) != 3:
        raise RuntimeError("Validator helper signatures changed")
    ns = {"time": time}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<validator-only>", "exec"), ns)
    now = int(time.time())
    snapshot = {
        "schemaVersion": 1, "version": "offline-validation",
        "generatedAt": now - 5, "expiresAt": now + 3600,
        "rules": [{"id": "test-1", "guildId": "111111111111111111",
                   "channelIds": ["222222222222222222"], "type": "eew",
                   "detail": "forecast", "region": "all", "sendFinalReport": False}],
        "routing": {"dedicatedMinDestinations": 100, "urlsPerWorker": 25, "maxDedicatedWorkers": 10},
    }
    found = {}
    for version in (1, 2, 3, 4):
        snapshot["schemaVersion"] = version
        try:
            out = ns["_validate_supporter_snapshot"](snapshot, now)
            if out["schemaVersion"] != version or out["rules"][0]["sendFinalReport"] is not False:
                raise RuntimeError("Version or EEW final-report flag was lost")
            found[version] = "accepted"
        except ValueError:
            found[version] = "rejected"
    if found != {1: "accepted", 2: "accepted", 3: "accepted", 4: "rejected"}:
        raise RuntimeError(f"Unexpected compatibility results: {found}")
    snapshot["schemaVersion"] = 3
    snapshot["rules"][0]["channelIds"] = ["invalid"]
    try:
        ns["_validate_supporter_snapshot"](snapshot, now)
    except ValueError:
        return found
    raise RuntimeError("Validator accepted malformed channel IDs")


def repack(raw):
    with zipfile.ZipFile(io.BytesIO(raw), "r") as archive:
        if archive.testzip():
            raise RuntimeError("Invalid deployed ZIP checksum")
        infos = archive.infolist()
        if len(infos) != len({i.filename for i in infos}) or not any(i.filename == "lambda_function.py" for i in infos):
            raise RuntimeError("Missing/duplicate deployed Lambda entrypoint")
        files = {info.filename: archive.read(info.filename) for info in infos}
        source = files["lambda_function.py"].decode("utf-8")
        updated, changed = patch(source)
        verify(updated)
        if not changed:
            return raw, False
        files["lambda_function.py"] = updated.encode("utf-8")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as target:
            target.comment = archive.comment
            for info in infos:
                target.writestr(info, files[info.filename])
    new_zip = output.getvalue()
    with zipfile.ZipFile(io.BytesIO(new_zip)) as output, zipfile.ZipFile(io.BytesIO(raw)) as old:
        for name in old.namelist():
            if name != "lambda_function.py" and old.read(name) != output.read(name):
                raise RuntimeError(f"Unexpected Lambda member changed: {name}")
    return new_zip, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--apply", action="store_true")
    modes.add_argument("--rollback", action="store_true")
    parser.add_argument("--directory", type=Path, default=Path.home() / "dpi-snapshot-v3-rollback")
    args = parser.parse_args()
    import boto3
    client = boto3.client("lambda", region_name=REGION)
    state = client.get_function(FunctionName=NAME)
    cfg = state["Configuration"]
    directory = args.directory
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    original_file = directory / "original.zip"
    candidate_file = directory / "candidate.zip"
    report_file = directory / "report.json"
    if args.rollback:
        if not (original_file.is_file() and report_file.is_file()):
            raise RuntimeError("Saved ZIP and manifest are required for rollback")
        report = json.loads(report_file.read_text(encoding="utf-8"))
        original = original_file.read_bytes()
        if sha(original) != report["oldSha"] or cfg["CodeSha256"] != report["newSha"]:
            raise RuntimeError("Code changed since deployment; rollback is blocked")
        updated = client.update_function_code(FunctionName=NAME, ZipFile=original,
                                              RevisionId=cfg["RevisionId"], Publish=False)
        if updated["CodeSha256"] != report["oldSha"]:
            raise RuntimeError("Rollback hash verification failed")
        print("Rollback completed. Existing snapshots/operating modes unchanged.")
        return
    with urllib.request.urlopen(state["Code"]["Location"], timeout=45) as response:
        original = response.read(10 * 1024 * 1024)
    if sha(original) != cfg["CodeSha256"]:
        raise RuntimeError("Deployed ZIP does not match CodeSha256")
    candidate, changed = repack(original)
    if original_file.exists() and original_file.read_bytes() != original:
        raise RuntimeError("Saved original differs from live code; choose a new directory")
    original_file.write_bytes(original)
    candidate_file.write_bytes(candidate)
    os.chmod(original_file, 0o600)
    os.chmod(candidate_file, 0o600)
    report = {"function": NAME, "region": REGION, "oldSha": cfg["CodeSha256"],
              "newSha": sha(candidate), "revision": cfg["RevisionId"],
              "modified": changed, "schemaVersions": [1, 2, 3]}
    report_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if not changed:
        print("Already compatible with v1/v2/v3. AWS unchanged.")
    elif not args.apply:
        print("DRY RUN succeeded. Run --apply to update only the Lambda code.")
    else:
        result = client.update_function_code(FunctionName=NAME, ZipFile=candidate,
                                             RevisionId=cfg["RevisionId"], Publish=False)
        if result["CodeSha256"] != report["newSha"]:
            raise RuntimeError("Update returned incorrect hash")
        client.get_waiter("function_updated").wait(
            FunctionName=NAME, WaiterConfig={"Delay": 3, "MaxAttempts": 20})
        live = client.get_function_configuration(FunctionName=NAME)
        if live["CodeSha256"] != report["newSha"] or live["State"] != "Active":
            raise RuntimeError("Lambda post-deployment check failed")
        print("v1/v2/v3 validator applied. ACTIVE pointer and live delivery are untouched.")


if __name__ == "__main__":
    main()
