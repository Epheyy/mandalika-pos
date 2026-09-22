"""DEPSEC-INITIAL-20260922 evaluator; no network or implicit exceptions."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCOPES = {"runtime", "build", "development-only", "unknown"}
REACHABILITY = {"runtime_reachable", "runtime_present_unproven", "build_executed", "development_only", "unknown"}


class PolicyError(ValueError):
    pass


def helper(mode, data, parser_root=ROOT):
    if mode == "lock" and isinstance(data, str):
        data = {"text": data}
    result = subprocess.run(["node", str(HERE / "depsec_helper.cjs"), str(parser_root), mode],
                            input=json.dumps(data).encode(), capture_output=True, timeout=60)
    if result.returncode:
        raise PolicyError(f"Pinned {mode} parser failed (exit {result.returncode})")
    return json.loads(result.stdout)


def json_stream(text):
    decoder = json.JSONDecoder()
    values = []
    while text.strip():
        text = text.lstrip()
        value, end = decoder.raw_decode(text)
        if not isinstance(value, dict):
            raise PolicyError("Expected JSON object stream")
        values.append(value)
        text = text[end:]
    return values


def govuln_findings(text):
    messages = json_stream(text)
    configs = [x["config"] for x in messages if "config" in x]
    if len(configs) != 1 or not configs[0].get("scanner_version"):
        raise PolicyError("govulncheck configuration missing; empty output is not a clean scan")
    findings = []
    for message in messages:
        if "finding" not in message:
            continue
        f = message["finding"]
        if not f.get("osv") or not f.get("trace") or not f["trace"][0].get("module"):
            raise PolicyError("Malformed govulncheck finding")
        first = f["trace"][0]
        findings.append({"id": f["osv"], "package": first["module"], "version": first.get("version"),
                         "called": bool(first.get("function")), "imported": bool(first.get("package")),
                         "fixed_version": f.get("fixed_version"), "trace": f["trace"]})
    return configs[0], findings


def check_artifact(data):
    text = json.dumps(data, ensure_ascii=False) if not isinstance(data, str) else data
    patterns = {
        "test_credential_marker": r"DEPSEC_TEST_CREDENTIAL_[A-Za-z0-9_-]+",
        "private_key": r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
        "provider_token": r"\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b",
        "credential_uri": r"(?i)(?:postgres(?:ql)?|rediss?|https?)://[^\s\x22\x27<>:@/]+:[^\s\x22\x27<>@/]+@",
        "jwt": r"\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b",
        "literal_credential": r'(?i)"(?:password|authorization|access_token|refresh_token|api_key)"\s*:\s*"[^"\s]{6,}"',
    }
    for rule, pattern in patterns.items():
        if re.search(pattern, text):
            raise PolicyError(f"Artifact rejected by {rule}; value omitted")


def date(value, field):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise PolicyError(f"Invalid exception {field}")
    try:
        return dt.date.fromisoformat(value)
    except ValueError as error:
        raise PolicyError(f"Invalid exception {field}") from error


def nonempty(item, fields):
    if not isinstance(item, dict) or any(not isinstance(item.get(k), str) or not item[k].strip() for k in fields):
        raise PolicyError("Malformed exception: required nonempty fields missing")


def validate_exceptions(register, findings, licenses, today, parser_root=ROOT):
    if set(register) != {"schema_version", "policy_id", "security", "licenses"} or register["schema_version"] != 1 or register["policy_id"] != "DEPSEC-INITIAL-20260922":
        raise PolicyError("Wrong exceptions schema/policy")
    if not isinstance(register["security"], list) or not isinstance(register["licenses"], list):
        raise PolicyError("Exception lists required")
    security_matches, license_matches = {}, {}
    required = {"id", "ecosystem", "package", "version_range", "scope", "reachability", "reason", "compensating_control", "owner", "reviewer", "created", "expires", "remediation", "review_reference"}
    for index, item in enumerate(register["security"]):
        nonempty(item, required)
        if set(item) != required or item["scope"] not in SCOPES or item["reachability"] not in REACHABILITY:
            raise PolicyError("Malformed security exception")
        if not date(item["created"], "created") <= today < date(item["expires"], "expires"):
            raise PolicyError("Expired/not-yet-valid security exception")
        candidates = [i for i, f in enumerate(findings) if all(f.get(k) == item[k] for k in ["id", "ecosystem", "package", "scope", "reachability"])]
        ranges = helper("ranges", [{"version": findings[i]["version"], "range": item["version_range"]} for i in candidates], parser_root)
        if not candidates or not all(r["valid"] for r in ranges):
            raise PolicyError("Exception package/advisory mismatch or invalid range")
        matched = [i for i, result in zip(candidates, ranges) if result["matches"]]
        if not matched:
            raise PolicyError("Exception outside actual affected version range")
        for i in matched:
            if i in security_matches:
                raise PolicyError("Duplicate matching security exception")
            security_matches[i] = index
    required_license = {"ecosystem", "package", "version", "expression", "scope", "distribution_context", "reviewer", "decision", "review_date", "review_reference"}
    for index, item in enumerate(register["licenses"]):
        nonempty(item, required_license)
        if set(item) - required_license - {"review_by"} or item["decision"] != "approved" or item["scope"] not in SCOPES:
            raise PolicyError("Malformed license exception")
        if date(item["review_date"], "review_date") > today or ("review_by" in item and today >= date(item["review_by"], "review_by")):
            raise PolicyError("Expired/not-yet-valid license review")
        matched = [i for i, f in enumerate(licenses) if all(f.get(k) == item[k] for k in ["ecosystem", "package", "version", "expression", "scope"])]
        if not matched:
            raise PolicyError("License exception does not match exact evidence")
        for i in matched:
            if i in license_matches:
                raise PolicyError("Duplicate license exception")
            license_matches[i] = index
    return security_matches, license_matches


def evaluate(findings, licenses, register, policy, *, today=None, parser_root=ROOT, delta=False):
    today = today or dt.datetime.now(dt.timezone.utc).date()
    if policy.get("id") != "DEPSEC-INITIAL-20260922":
        raise PolicyError("Wrong dependency policy")
    security_matches, license_matches = validate_exceptions(register, findings, licenses, today, parser_root)
    result = {"policy_id": policy["id"], "status": "pass", "blocking": [], "reported": [], "suppressed": [], "license_results": []}
    for index, f in enumerate(findings):
        required = ["id", "ecosystem", "package", "version", "scope", "reachability", "severity"]
        if any(not isinstance(f.get(k), str) or not f[k] for k in required) or f["scope"] not in SCOPES or f["reachability"] not in REACHABILITY:
            raise PolicyError("Malformed/unclassified finding")
        production = f["scope"] in {"runtime", "build", "unknown"}
        risk = any(f.get(k) is True for k in ["malicious", "compromised", "known_exploited", "evidence_high_impact"])
        reasons = []
        if (production or delta) and risk:
            reasons.append("malicious/compromised/known-exploited or direct high-impact evidence")
        if (production or delta) and f["severity"].lower() in {"high", "critical"}:
            reasons.append("High/Critical runtime/build/CI finding" if not delta else "High/Critical dependency delta")
        if f["ecosystem"] == "Go" and f.get("called") is True:
            reasons.append("govulncheck called/reachable symbol")
        if production and (f["scope"] == "unknown" or f["reachability"] == "unknown" or f["severity"].lower() not in {"info", "low", "moderate", "medium", "high", "critical"}):
            reasons.append("unclassified production severity/reachability")
        record = f | {"reasons": reasons}
        if index in security_matches:
            result["suppressed"].append(record | {"exception_index": security_matches[index]})
        elif reasons:
            result["blocking"].append(record)
        else:
            result["reported"].append(record)
    parsed = helper("licenses", [x.get("expression") for x in licenses], parser_root)
    for index, (license, valid) in enumerate(zip(licenses, parsed)):
        if license.get("scope") not in SCOPES or any(not license.get(k) for k in ["ecosystem", "package", "version"]):
            raise PolicyError("Malformed license inventory")
        known = valid and license.get("evidence_present") is True and not license.get("missing_referenced_terms")
        # No inferred GPL/AGPL/etc policy. Only an explicitly reviewed deny expression can block a named SPDX term.
        explicitly_denied = license.get("expression") in policy["licenses"]["deny_licenses"]
        status = "review_required" if known and not explicitly_denied else "blocked_unknown"
        record = license | {"status": status}
        if index in license_matches:
            record["status"] = "approved_exception"
        elif (not known or explicitly_denied) and license["scope"] in {"runtime", "build", "unknown"}:
            result["blocking"].append(record | {"id": "LICENSE-EVIDENCE", "reasons": ["license classification incomplete" if not known else "explicit reviewed license policy"]})
        result["license_results"].append(record)
    result["status"] = "fail" if result["blocking"] else "pass"
    return result
