#!/usr/bin/env python3
"""Safely enable v1/v2/v3/v4 supporter snapshot publishing in the deployed AWS Lambda.

Schema v4 adds the paid image rules (hires-radar / tsunami-map / weather-map, since
2026-11-18 earthquake-map, and since 2026-11-21 eew-map (also Basic, tier "supporter") and
warning-table). A Lambda that already runs an older v4 validator (without earthquake-map or
without eew-map / warning-table) is upgraded too; it would otherwise reject every snapshot
that contains such a rule and the ACTIVE pointer would stop advancing.
Turn SUPPORTER_IMAGE_RULES_V2_ENABLED on in the website only after this patch is applied.
Deploy order: home server (dpi_code) FIRST -> this Lambda patch -> website.
Keep SUPPORTER_IMAGE_RULES_ENABLED off on the website until every home server
understands v4: an old home server rejects unknown rule types and would stop
ALL paid delivery, not only the image rules.

Requires AWS CloudShell with boto3 and permission to GetFunction/UpdateFunctionCode.
Upload this file together with lambda_function.py from the same commit: the
validator in that file is the single source copied into the live ZIP.
By default this script is READ-ONLY against AWS and saves a verified rollback ZIP.

    python3 deploy_schema_v4.py --check
    python3 deploy_schema_v4.py --apply
    python3 deploy_schema_v4.py --rollback

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
VALIDATOR = "_validate_supporter_snapshot"
V4_CHECK = 'int(value.get("schemaVersion", 0)) not in (1, 2, 3, 4)'
# Validator shapes this script knows how to upgrade (v1-only, the v3 patch, and the first v4
# validator that predates earthquake-map).
KNOWN_CHECKS = (
    'int(value.get("schemaVersion", 0)) != 1',
    'int(value.get("schemaVersion", 0)) not in (1, 2, 3)',
    V4_CHECK,
)
# Markers of the current target validator (all six image rule types).
CURRENT_MARKER = '"warning-table"'
CURRENT_MARKERS = ('"earthquake-map"', '"eew-map"', CURRENT_MARKER)
LOCAL_SOURCE = Path(__file__).resolve().with_name("lambda_function.py")


def sha(raw):
    return base64.b64encode(hashlib.sha256(raw).digest()).decode("ascii")


def function_source(source, name):
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, ast.FunctionDef) and node.name == name]
    if len(nodes) != 1:
        raise RuntimeError(f"Unexpected function {name} in source")
    lines = source.splitlines(keepends=True)
    return "".join(lines[nodes[0].lineno - 1:nodes[0].end_lineno])


def target_validator():
    validator = function_source(LOCAL_SOURCE.read_text(encoding="utf-8"), VALIDATOR)
    if V4_CHECK not in validator or '"hires-radar"' not in validator or not all(m in validator for m in CURRENT_MARKERS):
        raise RuntimeError("Local lambda_function.py is not the v4 validator")
    return validator


def patch(source, validator=None):
    validator = validator or target_validator()
    live = function_source(source, VALIDATOR)
    if V4_CHECK in live and '"hires-radar"' in live and all(m in live for m in CURRENT_MARKERS):
        return source, False
    if sum(check in live for check in KNOWN_CHECKS) != 1 or '"rain-radar"' not in live:
        raise RuntimeError("Unrecognized deployed validator; refusing update")
    if not live.endswith("\n"):
        validator = validator.rstrip("\n")
    candidate = source.replace(live, validator, 1)
    ast.parse(candidate)
    if function_source(candidate, VALIDATOR) != validator:
        raise RuntimeError("Patch affected unexpected source")
    return candidate, True


def verify(source):
    tree = ast.parse(source)
    names = ("_clean", "_integer", VALIDATOR)
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    if len(nodes) != 3:
        raise RuntimeError("Validator helper signatures changed")
    ns = {"time": time}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<validator-only>", "exec"), ns)
    validate = ns[VALIDATOR]
    now = int(time.time())

    def snapshot(version, rule):
        return {
            "schemaVersion": version, "version": "offline-validation",
            "generatedAt": now - 5, "expiresAt": now + 3600,
            "rules": [{"id": "test-1", "guildId": "111111111111111111",
                       "channelIds": ["222222222222222222"], **rule}],
            "routing": {"dedicatedMinDestinations": 100, "urlsPerWorker": 25, "maxDedicatedWorkers": 10},
        }

    def outcome(version, rule):
        try:
            return validate(snapshot(version, rule), now)
        except ValueError:
            return None

    eew = {"type": "eew", "detail": "forecast", "region": "all", "sendFinalReport": False}
    found = {}
    for version in (1, 2, 3, 4, 5):
        out = outcome(version, eew)
        if out is not None and (out["schemaVersion"] != version or out["rules"][0]["sendFinalReport"] is not False):
            raise RuntimeError("Version or EEW final-report flag was lost")
        found[version] = "accepted" if out else "rejected"
    if found != {1: "accepted", 2: "accepted", 3: "accepted", 4: "accepted", 5: "rejected"}:
        raise RuntimeError(f"Unexpected compatibility results: {found}")
    image = {"type": "weather-map", "region": "kanto-koshin", "tier": "pro",
             "products": ["VPWW55"], "minSeverity": "warning", "prefecture": "13",
             "municipalities": ["1310100"], "municipalityDetail": True}
    out = outcome(4, image)
    if not out or out["rules"][0]["municipalities"] != ["1310100"] or out["rules"][0]["tier"] != "pro":
        raise RuntimeError("v4 image rule was rejected or altered")
    for bad_version, bad_rule in ((3, image), (4, {**image, "tier": "supporter"}),
                                  (4, {**image, "tier": ""}), (4, {**image, "region": "kanto"}),
                                  (4, {**eew, "channelIds": ["invalid"]})):
        if outcome(bad_version, bad_rule) is not None:
            raise RuntimeError("Validator accepted a malformed rule")
    for kind in ("hires-radar", "tsunami-map", "earthquake-map", "eew-map", "warning-table"):
        if outcome(4, {"type": kind, "region": "all", "tier": "plus"}) is None:
            raise RuntimeError(f"v4 {kind} rule was rejected")
    if outcome(4, {"type": "eew-map", "region": "all", "tier": "supporter", "regions": []}) is None:
        raise RuntimeError("v4 Basic eew-map rule was rejected")
    if outcome(4, {"type": "warning-table", "region": "all", "tier": "supporter"}) is not None:
        raise RuntimeError("Validator accepted a Basic warning-table rule")
    found[5] = "rejected"
    return found


def repack(raw, validator=None):
    with zipfile.ZipFile(io.BytesIO(raw), "r") as archive:
        if archive.testzip():
            raise RuntimeError("Invalid deployed ZIP checksum")
        infos = archive.infolist()
        if len(infos) != len({i.filename for i in infos}) or not any(i.filename == "lambda_function.py" for i in infos):
            raise RuntimeError("Missing/duplicate deployed Lambda entrypoint")
        files = {info.filename: archive.read(info.filename) for info in infos}
        source = files["lambda_function.py"].decode("utf-8")
        updated, changed = patch(source, validator)
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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--apply", action="store_true")
    modes.add_argument("--rollback", action="store_true")
    parser.add_argument("--directory", type=Path, default=Path.home() / "dpi-snapshot-v4-rollback")
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
              "modified": changed, "schemaVersions": [1, 2, 3, 4]}
    report_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if not changed:
        print("Already compatible with v1/v2/v3/v4. AWS unchanged.")
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
        print("v1/v2/v3/v4 validator applied. ACTIVE pointer and live delivery are untouched.")


if __name__ == "__main__":
    main()
