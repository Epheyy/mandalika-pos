"""Two reviewed, exact-artifact SheetJS decisions; never a risk-exception engine."""
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import re

from dependency_policy import PolicyError
from dependency_vendor import unique_object, vendor_evidence

REGISTER = "scripts/ci/dependency-applicability.json"
SCHEMA = "scripts/ci/dependency-applicability.schema.json"
EVIDENCE = "scripts/ci/applicability-evidence"
SEMANTIC_FIELDS = ("id", "aliases", "details", "affected", "withdrawn", "severity",
                   "database_specific", "summary", "references")
RISK_FIELDS = ("severity", "source", "scope", "reachability", "affected_range", "fixed_range",
               "called", "imported", "known_exploited", "malicious", "compromised", "evidence_high_impact")
PAIRS = {"GHSA-4r6h-8v6p-xvw6": ("CVE-2023-30533", "0.19.3"),
         "GHSA-5pgg-2g8v-p4x9": ("CVE-2024-22363", "0.20.2")}


def fingerprint(value, fields):
    normalized = {key: value.get(key) for key in fields}
    # These OSV arrays are sets. Range event ordering is retained because it can
    # change the meaning of introduced/fixed intervals.
    for key in ("aliases", "references", "severity", "affected"):
        if isinstance(normalized.get(key), list):
            normalized[key] = sorted(normalized[key], key=lambda x: json.dumps(x, sort_keys=True, ensure_ascii=False))
    return hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def read_json(path):
    if path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
        raise PolicyError("Unsafe/oversized applicability evidence")
    return json.loads(path.read_text(encoding="utf8"), object_pairs_hook=unique_object)


def validate_shape(value, schema):
    """Enforce the small, checked-in schema's used keywords without a new dependency."""
    supported = {"$schema", "title", "type", "const", "enum", "pattern", "minLength",
                 "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems"}
    if set(schema) - supported:
        raise PolicyError("Unsupported applicability schema keyword")
    if "const" in schema and (type(value) is not type(schema["const"]) or value != schema["const"]) or "enum" in schema and value not in schema["enum"]:
        raise PolicyError("Applicability value outside exact reviewed contract")
    types = {"object": dict, "array": list, "string": str, "boolean": bool}
    if "type" in schema and type(value) is not types.get(schema["type"]):
        raise PolicyError("Malformed applicability type")
    if schema.get("type") == "object":
        if set(schema.get("required", [])) - set(value) or set(value) - set(schema["properties"]):
            raise PolicyError("Missing/unknown applicability field")
        for key, item in value.items():
            validate_shape(item, schema["properties"][key])
    elif schema.get("type") == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 2):
            raise PolicyError("Overbroad applicability list")
        if schema.get("uniqueItems") and len({json.dumps(x, sort_keys=True) for x in value}) != len(value):
            raise PolicyError("Duplicate applicability list entry")
        for item in value:
            validate_shape(item, schema["items"])
    elif schema.get("type") == "string":
        if len(value.strip()) < schema.get("minLength", 0) or "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            raise PolicyError("Malformed applicability string")


def rule_inputs(root):
    paths = [REGISTER, SCHEMA, "scripts/ci/dependency-policy.json", "scripts/ci/dependency-exceptions.json"]
    paths += ["scripts/ci/" + name for name in ("dependency_applicability.py", "dependency_policy.py",
              "dependency_security.py", "dependency_inventory.py", "dependency_vendor.py", "depsec_helper.cjs")]
    paths += [p.relative_to(root).as_posix() for p in sorted((root / EVIDENCE).glob("*.json"))]
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            if (root / name).is_file() else "absent" for name in paths}


def load_register(root):
    if not (root / REGISTER).exists():
        return None
    register = read_json(root / REGISTER)
    validate_shape(register, read_json(root / SCHEMA))
    seen = set()
    for decision in register["decisions"]:
        advisory = decision["advisory_id"]
        alias, fixed = PAIRS[advisory]
        if advisory in seen or decision["decision_id"] != "SJ-AP-" + alias or decision["explicit_aliases"] != [alias]:
            raise PolicyError("Duplicate/mismatched applicability identity")
        seen.add(advisory)
        if (decision["publisher_fixed_from"] != fixed
                or decision["publisher_source"] != "https://cdn.sheetjs.com/advisories/" + alias
                or decision["osv_source"] != "https://api.osv.dev/v1/vulns/" + advisory
                or decision["reviewed_at"] != "2026-10-15" or decision["captured_at"] != "2026-09-23"
                or decision["review_by"] != "2027-01-13T00:00:00Z"):
            raise PolicyError("Applicability review differs from approved evidence/deadline")
        for name, digest in decision["evidence_sha256"].items():
            path = root / EVIDENCE / name  # Names are fixed by the strict schema.
            if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise PolicyError("Reviewed applicability evidence digest mismatch")
        captured = read_json(root / EVIDENCE / "sheetjs-osv-reviewed.json")
        captured_findings = read_json(root / EVIDENCE / "sheetjs-findings-reviewed.json")
        osv = [x for x in captured if x["id"] == advisory]
        finding = [x for x in captured_findings if x["id"] == advisory]
        if (len(osv) != 1 or len(finding) != 1
                or fingerprint(osv[0], SEMANTIC_FIELDS) != decision["semantic_sha256"]
                or fingerprint(finding[0], RISK_FIELDS) != decision["risk_sha256"]):
            raise PolicyError("Reviewed applicability fingerprint conflicts with captured evidence")
    return register


def finding_key(finding):
    return tuple(finding.get(k) for k in ("ecosystem", "package", "version", "id"))


def assess_matches(root, lock, components, records, findings, *, now=None):
    """Revalidate source bytes before deriving eligible identities; ignore claimed safe flags."""
    now = now or dt.datetime.now(dt.timezone.utc)
    register = load_register(root)
    report = {"format": "mandalika-reviewed-applicability-v1 (not standard VEX)",
              "register_status": "present" if register else "absent", "decisions": []}
    eligible = {}
    if register is None:
        return eligible, report
    subject = register["subject"]
    candidates = [c for c in components if all(c.get(k) == subject[k] for k in ("ecosystem", "package", "version"))]
    actual = None
    if len(candidates) == 1:
        component = candidates[0]
        expected_key = subject["package"] + "@file:" + subject["path"]
        if component.get("key") == expected_key and expected_key in lock["packages"]:
            verified = vendor_evidence(root, expected_key, lock["packages"][expected_key])
            mapping = {"name": "package", "version": "version", "distribution_kind": "distribution_kind",
                       "local_path": "path", "tarball": "source_url", "tarball_sha256": "sha256",
                       "integrity": "integrity", "provenance_sha256": "provenance_sha256"}
            if (all(component.get(k) == verified[k] == subject[v] for k, v in mapping.items())
                    and (root / subject["path"]).stat().st_size == subject["bytes"]):
                actual = verified
    by_id = {r["id"]: r for r in records}
    if len(by_id) != len(records):
        raise PolicyError("Duplicate raw advisory identity")
    for decision in register["decisions"]:
        row = {"decision_id": decision["decision_id"], "advisory_id": decision["advisory_id"],
               "subject": subject, "reviewer": decision["reviewer"], "reviewed_at": decision["reviewed_at"],
               "review_by": decision["review_by"], "rationale": decision["rationale"],
               "evidence_sha256": decision["evidence_sha256"], "reviewed_semantic_sha256": decision["semantic_sha256"]}
        matching = [f for f in findings if all(f.get(k) == subject[k] for k in ("ecosystem", "package", "version"))
                    and f["id"] == decision["advisory_id"]]
        if not decision["active"]:
            row.update(status="inactive", explanation="No assessment applied")
        elif actual is None:
            row.update(status="not-current-artifact", explanation="Normal policy; exact validated artifact identity not present")
        elif not matching:
            row.update(status="upstream-not-matched", explanation="No assessment applied; required scan returned no current match (including withdrawn/corrected records)")
        elif not dt.datetime.fromisoformat(decision["reviewed_at"]).replace(tzinfo=dt.timezone.utc) <= now < dt.datetime.fromisoformat(decision["review_by"].replace("Z", "+00:00")):
            row.update(status="review-required", explanation="Review expired or not yet valid; raw enforcement retained")
        else:
            record = by_id.get(decision["advisory_id"])
            if record is None:
                raise PolicyError("Matched advisory has no required raw source record")
            row["current_semantic_sha256"] = fingerprint(record, SEMANTIC_FIELDS)
            row["current_record_sha256"] = hashlib.sha256(json.dumps(record, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            unchanged = (row["current_semantic_sha256"] == decision["semantic_sha256"] and len(matching) == 1
                         and matching[0].get("aliases") == decision["explicit_aliases"]
                         and fingerprint(matching[0], RISK_FIELDS) == decision["risk_sha256"])
            if unchanged:
                row.update(status="reviewed-not-affected", explanation="Exact reviewed publisher-fixed artifact and unchanged material advisory/risk evidence")
                eligible[finding_key(matching[0])] = row
            else:
                row.update(status="review-required", explanation="Material advisory/alias/range/risk evidence changed; raw enforcement retained")
        report["decisions"].append(row)
    return eligible, report


def project_policy(raw, eligible):
    result = copy.deepcopy(raw)
    result["reviewed_not_affected"] = []
    for category in ("blocking", "reported"):
        kept = []
        for record in result[category]:
            decision = eligible.get(finding_key(record))
            if decision:
                result["reviewed_not_affected"].append({"decision_id": decision["decision_id"],
                    "artifact": decision["subject"], "rationale": decision["rationale"],
                    "original_policy_category": category, "original_record": record})
            else:
                kept.append(record)
        result[category] = kept
    result["status"] = "fail" if result["blocking"] else "pass"
    return result


def counts(raw, assessed):
    return {"raw_blocking": len(raw["blocking"]), "actionable_blocking": len(assessed["blocking"]),
            "reviewed_not_affected": len(assessed["reviewed_not_affected"]),
            "risk_exceptions": len(assessed["suppressed"])}
