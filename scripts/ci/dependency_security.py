#!/usr/bin/env python3
"""Fail-closed dependency-security CLI. Exit 1 is a policy blocker, 2 an invalid scan."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from dependency_capture import capture
from dependency_inventory import findings, go_inventory, license_inventory, load, node_inventory, sbom
from dependency_policy import HERE, ROOT, PolicyError, check_artifact, evaluate
from dependency_vendor import changed_components, source_inputs
from dependency_policy import helper
from dependency_applicability import assess_matches, counts, finding_key, project_policy, rule_inputs


def publish(output, documents):
    # Check ALL contents before writing ANY uploadable document. Error text never echoes a value.
    for document in documents.values():
        check_artifact(document)
    if output.exists():
        raise PolicyError("Refusing to mix with an existing evidence directory")
    output.mkdir(parents=True)
    manifest = []
    for name, document in documents.items():
        data = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode()
        (output / name).write_bytes(data)
        manifest.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    (output / "manifest.json").write_text(json.dumps({"artifact_guard": "pass", "files": manifest}, indent=2) + "\n", encoding="utf-8")


def assess(raw, root, output, sha, parser_root, delta_base=None, *, replay=False):
    timestamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    node, go = node_inventory(raw), go_inventory(raw)
    components = node["components"] + go["components"]
    licenses = license_inventory(components)
    vulnerabilities, scanner = findings(raw, components, root)
    policy = load(root / "scripts/ci/dependency-policy.json")
    register = load(root / "scripts/ci/dependency-exceptions.json")
    lock = load(raw / "lock.json")
    if lock != helper("lock", (root / "pnpm-lock.yaml").read_text(encoding="utf8"), parser_root):
        raise PolicyError("Captured/replay lock differs from current validated source")
    inputs = source_inputs(root, lock) | rule_inputs(root)
    eligible, applicability = assess_matches(root, lock, components, load(raw / "osv-records.json"), vulnerabilities)
    applicability["raw_advisory_matches"] = len(vulnerabilities)
    if (root / ".git").exists():
        dirty = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", *inputs], cwd=root, timeout=30).returncode
        if dirty not in {0, 1}:
            raise PolicyError("Cannot establish source input identity")
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", "--", *inputs], cwd=root, capture_output=True, timeout=30)
        source_kind = "committed-inputs" if dirty == 0 and tracked.returncode == 0 else "working-tree-inputs-based-on-sha"
    else:
        source_kind = "explicit-archive-inputs"
    result = evaluate(vulnerabilities, licenses, register, policy, parser_root=parser_root)
    # Unknown graph coverage is blocking even if no advisory happened to be returned.
    for c in components:
        if c["scope"] == "unknown":
            result["blocking"].append({"id": "SCOPE-UNKNOWN", "package": c["package"], "version": c["version"], "reasons": ["unclassified locked component"]})
    result["status"] = "fail" if result["blocking"] else "pass"
    raw_result = result
    result = project_policy(raw_result, eligible)
    applicability["baseline"] = counts(raw_result, result)
    delta = {"status": "not-a-PR", "note": "Full current-lock baseline is always enforced"}
    raw_delta = delta.copy()
    if delta_base:
        previous = subprocess.run(["git", "show", f"{delta_base}:pnpm-lock.yaml"], cwd=root, capture_output=True, timeout=60)
        if previous.returncode:
            raise PolicyError("PR base lockfile unavailable; delta cannot be declared clean")
        old = helper("lock", previous.stdout.decode("utf-8"), parser_root)["packages"]
        old_provenance = {}
        for c in node["components"]:
            if c.get("provenance_path"):
                blob = subprocess.run(["git", "show", f"{delta_base}:{c['provenance_path']}"], cwd=root, capture_output=True, timeout=30)
                if blob.returncode == 0:
                    old_provenance[c["provenance_path"]] = hashlib.sha256(blob.stdout).hexdigest()
        introduced = changed_components(old, node["components"], old_provenance)
        identities = {(c["package"], c["version"]) for c in introduced}
        delta_findings = [x for x in vulnerabilities if x["ecosystem"] == "npm" and (x["package"], x["version"]) in identities]
        # Full register already validated; exact exceptions are applied by the baseline.
        suppressed = {(x["id"], x["package"], x["version"]) for x in result["suppressed"]}
        delta_findings = [x for x in delta_findings if (x["id"], x["package"], x["version"]) not in suppressed]
        empty = {"schema_version": 1, "policy_id": policy["id"], "security": [], "licenses": []}
        delta_licenses = [x for x in licenses if x["ecosystem"] == "npm" and (x["package"], x["version"]) in identities]
        raw_delta = evaluate(delta_findings, delta_licenses, empty, policy, parser_root=parser_root, delta=True)
        delta = project_policy(raw_delta, eligible)
        applicability["delta"] = counts(raw_delta, delta)
        delta["introduced_npm_versions"] = sorted(name + "@" + version for name, version in identities)
        delta["changed_distributions"] = [{k: c[k] for k in ["key", "package", "version", "integrity", "tarball_sha256"]} for c in introduced]
        delta["base_sha"] = delta_base
        result["blocking"].extend(delta["blocking"])
        result["reviewed_not_affected"].extend(delta["reviewed_not_affected"])
    result["status"] = "fail" if result["blocking"] else "pass"
    applicability["combined_occurrences"] = {
        "raw_blocking": len(raw_result["blocking"]) + len(raw_delta.get("blocking", [])),
        "actionable_blocking": len(result["blocking"]),
        "reviewed_not_affected": len(result["reviewed_not_affected"]),
        "risk_exceptions": len(result["suppressed"]),
        "reviewed_unique_findings": len({finding_key(x["original_record"]) for x in result["reviewed_not_affected"]}),
    }
    assessed_findings = [{"finding": f, "assessment": {"status": "reviewed-not-affected", "decision_id": eligible[finding_key(f)]["decision_id"]}
                         if finding_key(f) in eligible else {"status": "normal-policy"}} for f in vulnerabilities]
    documents = {"node-inventory.json": node, "go-inventory.json": go, "licenses.json": licenses,
                 "findings.json": vulnerabilities, "policy-result.json": result, "delta-result.json": delta,
                 "raw-policy-result.json": {"baseline": raw_result, "delta": raw_delta},
                 "applicability-result.json": applicability, "assessed-findings.json": assessed_findings,
                 "node.cdx.json": sbom(node, licenses, sha, timestamp, parser_root),
                 "go.cdx.json": sbom(go, licenses, sha, timestamp, parser_root),
                 "pnpm-audit.json": load(raw / "pnpm-audit.json"), "osv-query.json": load(raw / "osv-query.json"),
                 "osv-records.json": load(raw / "osv-records.json"),
                 "go-targets.json": scanner,
                 "govulncheck.json": __import__("dependency_policy").json_stream((raw / "govulncheck.json").read_text(encoding="utf-8")),
                 "kev-match-source.json": load(raw / "cisa-kev.json"),
                 "scan.json": {"source_sha": sha, "source_kind": source_kind, "source_input_sha256": inputs, "generated_at": timestamp, "policy_id": policy["id"], "tools": policy["tools"],
                               "govulncheck_config": {t["id"]: t["config"] for t in scanner["targets"]}, "npm_count": len(node["components"]), "go_module_count": len(go["components"]),
                               "advisory_count": len(vulnerabilities), "blocker_records": len(result["blocking"]),
                               "applicability_counts": applicability["combined_occurrences"],
                               "evidence_mode": "archived-raw-replay" if replay else "fresh-collection",
                               "limitations": ["Presence/path classification for JavaScript is conservative; no symbol reachability claim", "License text classification is evidence, not legal approval", "OSV/npm/KEV are live advisory snapshots; unavailable sources fail closed", "PR delta currently covers npm; full Go baseline always runs", "No malware feed can establish absence of all undisclosed compromises"],
                               "input_hashes": [{"path": f.name, "sha256": hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(raw.glob("*.json"))]}}
    publish(output, documents)
    print(json.dumps({"status": result["status"], "source_sha": sha, "npm": len(node["components"]), "go": len(go["components"]), "blockers": len(result["blocking"])}))
    return 1 if result["blocking"] else 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    scan = sub.add_parser("scan")
    scan.add_argument("--root", type=Path, default=ROOT)
    scan.add_argument("--parser-root", type=Path, default=ROOT)
    scan.add_argument("--sha", required=True)
    scan.add_argument("--output", type=Path, required=True)
    scan.add_argument("--evidence", type=Path, help="Replay captured evidence (review/testing only); hosted CI always captures fresh")
    scan.add_argument("--delta-base")
    evaluate_cmd = sub.add_parser("evaluate")
    evaluate_cmd.add_argument("--input", type=Path, required=True)
    evaluate_cmd.add_argument("--output", type=Path, required=True)
    evaluate_cmd.add_argument("--parser-root", type=Path, default=ROOT)
    args = parser.parse_args()
    if args.command == "evaluate":
        data = load(args.input)
        check_artifact(data)
        result = evaluate(data["findings"], data["licenses"], data["exceptions"], load(HERE / "dependency-policy.json"),
                          parser_root=args.parser_root, delta=data.get("delta", False))
        publish(args.output, {"policy-result.json": result})
        print(json.dumps({"status": result["status"], "blockers": len(result["blocking"])}))
        return 1 if result["blocking"] else 0
    if not re.fullmatch(r"[a-f0-9]{40}", args.sha) or args.delta_base and not re.fullmatch(r"[a-f0-9]{40}", args.delta_base):
        raise PolicyError("Exact source/base commit SHA required")
    if args.evidence:
        return assess(args.evidence.resolve(), args.root.resolve(), args.output.resolve(), args.sha, args.parser_root.resolve(), args.delta_base, replay=True)
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.root, text=True, timeout=30).strip()
    if actual != args.sha:
        raise PolicyError("Requested source SHA differs from checkout")
    with tempfile.TemporaryDirectory(prefix="mandalika-depsec-raw-") as temporary:
        raw = Path(temporary) / "raw"
        lock = helper("lock", (args.root / "pnpm-lock.yaml").read_text(encoding="utf8"), args.parser_root.resolve())
        before = source_inputs(args.root.resolve(), lock) | rule_inputs(args.root.resolve())
        capture(args.root.resolve(), raw, args.parser_root.resolve())
        after_lock = helper("lock", (args.root / "pnpm-lock.yaml").read_text(encoding="utf8"), args.parser_root.resolve())
        if before != (source_inputs(args.root.resolve(), after_lock) | rule_inputs(args.root.resolve())):
            raise PolicyError("Dependency inputs changed during collection")
        return assess(raw, args.root.resolve(), args.output.resolve(), args.sha, args.parser_root.resolve(), args.delta_base)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (PolicyError, OSError, ValueError, KeyError, TypeError, AttributeError, IndexError, subprocess.SubprocessError) as error:
        # Never dump unexpected subprocess/network responses: they may contain credentials.
        print(json.dumps({"status": "invalid-scan", "reason": str(error) if isinstance(error, PolicyError) else type(error).__name__, "details": "Sensitive values omitted"}))
        sys.exit(2)
