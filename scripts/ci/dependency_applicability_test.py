"""AP01–18: reviewed snapshots plus actual scanner CLI in disposable source roots."""
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from dependency_applicability import (EVIDENCE, REGISTER, SCHEMA, assess_matches, counts,
                                     fingerprint, load_register, project_policy, SEMANTIC_FIELDS)
from dependency_policy import HERE, ROOT, PolicyError
from dependency_vendor import vendor_evidence

REVIEW_TIME = dt.datetime(2026, 9, 23, 12, tzinfo=dt.timezone.utc)


def live_review_active():
    # CLI uses the real clock. After expiry it must report retained blockers;
    # fixture tests must not stop the hosted job before that fresh scan runs.
    now = dt.datetime.now(dt.timezone.utc)
    return dt.datetime(2026, 9, 23, tzinfo=dt.timezone.utc) <= now < dt.datetime(2026, 10, 23, tzinfo=dt.timezone.utc)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())


class Applicability(unittest.TestCase):
    cli_results = []

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="mandalika-applicability-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.raw = self.root / "raw"
        self.raw.mkdir()
        self.initial_hashes = {str(f): hashlib.sha256(f.read_bytes()).hexdigest()
                               for f in HERE.glob("dependency*") if f.is_file()}
        for f in HERE.glob("dependency*"):
            if f.is_file():
                destination = self.root / "scripts/ci" / f.name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(f, destination)
        # The real register's entries must each match a live finding, which these
        # synthetic replays never produce; the disposable copy uses an empty register.
        write(self.root / "scripts/ci/dependency-exceptions.json",
              {"schema_version": 1, "policy_id": "DEPSEC-INITIAL-20260922", "security": [], "licenses": []})
        shutil.copyfile(HERE / "depsec_helper.cjs", self.root / "scripts/ci/depsec_helper.cjs")
        shutil.copytree(ROOT / EVIDENCE, self.root / EVIDENCE)
        shutil.copytree(ROOT / "vendor/sheetjs", self.root / "vendor/sheetjs")
        self.register = json.loads((self.root / REGISTER).read_text())
        self.subject = self.register["subject"]
        self.key = "xlsx@file:" + self.subject["path"]
        self.package = {"version": "0.20.3", "resolution": {"integrity": self.subject["integrity"], "tarball": "file:" + self.subject["path"]}}
        self.lock = {"lockfileVersion": "9.0", "packages": {self.key: self.package}, "snapshots": {self.key: {}},
                     "importers": {"apps/backoffice": {"dependencies": {"xlsx": {"specifier": "file:../../" + self.subject["path"], "version": "file:" + self.subject["path"]}}}}}
        write(self.root / "package.json", {})
        write(self.root / "apps/backoffice/package.json", {"dependencies": {"xlsx": "file:../../" + self.subject["path"]}})
        write(self.root / "pnpm-lock.yaml", self.lock)
        for name in ("go.mod", "go.sum"):
            path = self.root / "backend" / name
            path.parent.mkdir(exist_ok=True)
            path.write_text("synthetic replay; never compiled")
        self.component = vendor_evidence(self.root, self.key, self.package) | {"ecosystem": "npm", "package": "xlsx"}
        self.records = json.loads((self.root / EVIDENCE / "sheetjs-osv-reviewed.json").read_text())
        self.findings = json.loads((self.root / EVIDENCE / "sheetjs-findings-reviewed.json").read_text())
        self.archive = json.loads((HERE / "fixtures/applicability-baseline.json").read_text())["policy"]
        self.raw_two = {"status": "fail", "blocking": copy.deepcopy(self.findings), "reported": [], "suppressed": [], "license_results": []}
        self.make_raw()

    def tearDown(self):
        self.assertEqual(self.initial_hashes, {f: hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in self.initial_hashes})

    def make_raw(self):
        write(self.raw / "lock.json", self.lock)
        write(self.raw / "node-package-evidence.json", [self.component])
        write(self.raw / "go-modules.json", {"Main": True, "Path": "synthetic/replay"})
        for name in ("go-runtime.json", "go-packages.json", "go-download.json", "go-graph.json"):
            (self.raw / name).write_text("")
        for name in ("go-license-classifier.json", "go-license-files.json"):
            write(self.raw / name, [])
        write(self.raw / "toolchain.json", {"version": "go1.26.9"})
        from dependency_go_targets_test import synthetic_go_evidence
        synthetic_go_evidence(self.root, self.raw)
        write(self.raw / "pnpm-audit.json", {"advisories": {}, "metadata": {}})
        write(self.raw / "cisa-kev.json", {"vulnerabilities": []})
        write(self.raw / "osv-records.json", self.records)
        write(self.raw / "osv-query.json", {"queries": [{"package": {"name": "xlsx", "ecosystem": "npm"}, "version": "0.20.3"}],
                                          "results": [{"vulns": [{"id": r["id"]} for r in self.records]}]})

    def match(self, now=REVIEW_TIME):
        return assess_matches(self.root, self.lock, [self.component], self.records, self.findings, now=now)

    def cli(self, expected, extra=()):
        output = self.root / ("output-" + str(len(self.cli_results)))
        cmd = [sys.executable, str(self.root / "scripts/ci/dependency_security.py"), "scan", "--root", str(self.root),
               "--parser-root", str(ROOT), "--sha", "a" * 40, "--evidence", str(self.raw), "--output", str(output), *extra]
        result = subprocess.run(cmd, cwd=self.root, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, expected, result.stdout.decode() + result.stderr.decode())
        self.assertNotIn(b"DEPSEC_TEST_CREDENTIAL_", result.stdout + result.stderr)
        self.cli_results.append({"test": self.id(), "command": cmd, "cwd": str(self.root), "exit": result.returncode,
                                 "stdout": result.stdout.decode().strip(), "synthetic_disposable": True})
        return {p.name: json.loads(p.read_text()) for p in output.glob("*.json")} if output.exists() else {}

    def test_AP01_AP02_AP08_archived_48_46_2_zero_exceptions(self):
        before = copy.deepcopy(self.archive)
        eligible, report = self.match()
        result = project_policy(self.archive, eligible)
        self.assertEqual(counts(self.archive, result), {"raw_blocking": 48, "actionable_blocking": 46, "reviewed_not_affected": 2, "risk_exceptions": 0})
        self.assertEqual(self.archive, before)
        self.assertEqual(result["blocking"], [r for r in before["blocking"] if r.get("package") != "xlsx"])
        self.assertEqual([r["status"] for r in report["decisions"]], ["reviewed-not-affected"] * 2)

    def test_AP03_AP06_other_registry_version_and_fork(self):
        for change in ({"version": "0.18.5"}, {"version": "0.20.4"}, {"package": "xlsx-fork"}, {"distribution_kind": "registry"}):
            with self.subTest(change=change):
                saved = self.component
                self.component = saved | change
                eligible, _ = self.match()
                records = [f | {k: v for k, v in change.items() if k in ("version", "package")} for f in self.findings]
                self.assertEqual(project_policy(self.raw_two | {"blocking": records}, eligible)["blocking"], records)
                self.component = saved

    def test_AP04_identity_path_source_and_provenance_never_relax(self):
        for field in ("key", "local_path", "tarball", "provenance_sha256", "integrity", "tarball_sha256"):
            with self.subTest(field=field):
                saved = self.component[field]; self.component[field] = "mismatched"
                self.assertFalse(self.match()[0]); self.component[field] = saved

    def test_AP04_AP05_cli_missing_tampered_and_lock_mismatch(self):
        archive = self.root / self.subject["path"]
        original = archive.read_bytes()
        archive.unlink(); self.assertEqual(self.cli(2), {})
        archive.write_bytes(original + b"tamper"); self.assertEqual(self.cli(2), {})
        archive.write_bytes(original)
        self.package["resolution"]["integrity"] = "sha512-wrong"
        write(self.root / "pnpm-lock.yaml", self.lock); self.make_raw(); self.assertEqual(self.cli(2), {})

    def test_AP05_cli_unresolved_graph(self):
        self.lock["snapshots"][self.key] = {"dependencies": {"missing-child": "1.0.0"}}
        write(self.root / "pnpm-lock.yaml", self.lock); self.make_raw(); self.assertEqual(self.cli(2), {})

    def test_AP07_AP12_new_advisory_and_claimed_safe_ignored(self):
        new = self.findings[0] | {"id": "GHSA-NEW-TEST", "safe": True, "severity": "critical"}
        self.findings.append(new)
        eligible, _ = self.match()
        raw = self.raw_two | {"blocking": self.findings}
        self.assertEqual(project_policy(raw, eligible)["blocking"], [new])
        self.records.append(self.records[0] | {"id": new["id"]})
        self.make_raw()
        result = self.cli(1)
        expected = [new["id"]] if live_review_active() else [x["id"] for x in self.findings]
        self.assertEqual([x["id"] for x in result["policy-result.json"]["blocking"]], expected)

    def test_AP09_expiry_and_not_yet_valid_keep_raw_blockers(self):
        for when in (dt.datetime(2026, 9, 22, tzinfo=dt.timezone.utc), dt.datetime(2026, 10, 23, tzinfo=dt.timezone.utc)):
            eligible, report = self.match(now=when)
            self.assertFalse(eligible)
            self.assertEqual([x["status"] for x in report["decisions"]], ["review-required"] * 2)
            self.assertEqual(len(project_policy(self.archive, eligible)["blocking"]), 48)

    def test_AP09_AP12_AP18_cli_bad_register_never_relaxes(self):
        changes = [lambda r: r["decisions"].append(r["decisions"][0]),
                   lambda r: r["subject"].update(version=">=0.20.3"),
                   lambda r: r["subject"].update(sha256="0" * 64),
                   lambda r: r["decisions"][0].update(review_by="2026-09-22T00:00:00Z"),
                   lambda r: r["decisions"][0].update(review_by="2036-10-23T00:00:00Z"),
                   lambda r: r["decisions"][0].update(advisory_id=r["decisions"][1]["advisory_id"]),
                   lambda r: r["decisions"][0].update(safe=True)]
        for change in changes:
            modified = copy.deepcopy(self.register); change(modified); write(self.root / REGISTER, modified)
            self.assertEqual(self.cli(2), {})

    def test_AP10_material_evidence_and_risk_change(self):
        for field, value in (("details", "New regression in 0.20.3"), ("aliases", ["CVE-NEW"]), ("affected", []), ("withdrawn", "2026-09-23"), ("severity", [])):
            saved = copy.deepcopy(self.records[0]); self.records[0][field] = value
            eligible, report = self.match(); self.assertEqual(len(eligible), 1)
            self.assertEqual(report["decisions"][0]["status"], "review-required"); self.records[0] = saved
        for field, value in (("known_exploited", True), ("severity", "critical"), ("compromised", True)):
            saved = self.findings[0]; self.findings[0] = saved | {field: value}
            self.assertEqual(len(self.match()[0]), 1); self.findings[0] = saved

    def test_AP10_order_and_timestamp_not_material(self):
        before = fingerprint(self.records[0], SEMANTIC_FIELDS)
        self.records[0] = dict(reversed(list(self.records[0].items())))
        self.records[0]["references"] = list(reversed(self.records[0]["references"]))
        self.records[0]["modified"] = "2099-01-01T00:00:00Z"
        self.assertEqual(before, fingerprint(self.records[0], SEMANTIC_FIELDS))
        self.assertEqual(len(self.match()[0]), 2)

    def test_AP10_AP18_cli_changed_evidence_and_captured_bytes(self):
        self.records[0]["details"] += " Material new risk."
        self.make_raw(); result = self.cli(1)
        self.assertEqual(len(result["policy-result.json"]["blocking"]), 1 if live_review_active() else 2)
        evidence = self.root / EVIDENCE / "sheetjs-publisher-reviewed.json"
        evidence.write_bytes(evidence.read_bytes() + b" ")
        self.assertEqual(self.cli(2), {})

    def test_AP11_cli_corrected_and_withdrawn_upstream(self):
        # Required OSV query succeeds but no longer returns these advisories.
        write(self.raw / "osv-query.json", {"queries": [{"package": {"name": "xlsx", "ecosystem": "npm"}, "version": "0.20.3"}], "results": [{}]})
        write(self.raw / "osv-records.json", [])
        result = self.cli(0)
        self.assertEqual(result["applicability-result.json"]["baseline"]["reviewed_not_affected"], 0)
        self.assertTrue(all(x["status"] == "upstream-not-matched" for x in result["applicability-result.json"]["decisions"]))
        self.records = [r | {"withdrawn": "2026-09-23"} for r in self.records]
        self.make_raw(); self.assertEqual(self.cli(0)["findings.json"], [])

    def test_AP13_shared_baseline_and_delta_occurrences(self):
        eligible, _ = self.match()
        baseline = project_policy(self.archive, eligible)
        delta = project_policy(self.raw_two, eligible)
        self.assertEqual(len(baseline["blocking"]) + len(delta["blocking"]), 46)
        self.assertEqual(len(baseline["reviewed_not_affected"]) + len(delta["reviewed_not_affected"]), 4)

    def test_AP14_cli_missing_malformed_provider_and_credential_guard(self):
        (self.raw / "osv-query.json").unlink(); self.assertEqual(self.cli(2), {})
        self.make_raw(); write(self.raw / "osv-query.json", {"queries": [], "results": []}); self.assertEqual(self.cli(2), {})
        self.make_raw(); write(self.raw / "osv-query.json", {"queries": None, "results": None}); self.assertEqual(self.cli(2), {})
        self.records[0]["details"] = "DEPSEC_TEST_" + "CREDENTIAL_SYNTHETIC_ONLY"
        self.make_raw(); self.assertEqual(self.cli(2), {})

    def test_AP15_missing_and_inactive_restore_policy(self):
        for decision in self.register["decisions"]: decision["active"] = False
        write(self.root / REGISTER, self.register)
        self.assertEqual(len(project_policy(self.archive, self.match()[0])["blocking"]), 48)
        self.assertEqual(len(self.cli(1)["policy-result.json"]["blocking"]), 2)
        (self.root / REGISTER).unlink()
        self.assertEqual(len(project_policy(self.archive, self.match()[0])["blocking"]), 48)
        self.assertEqual(len(self.cli(1)["policy-result.json"]["blocking"]), 2)

    def test_AP17_cli_raw_and_assessed_reports_and_hashes(self):
        active = live_review_active()
        result = self.cli(0 if active else 1)
        self.assertEqual(result["applicability-result.json"]["baseline"], {"raw_blocking": 2, "actionable_blocking": 0 if active else 2, "reviewed_not_affected": 2 if active else 0, "risk_exceptions": 0})
        expected_status = "reviewed-not-affected" if active else "review-required"
        self.assertTrue(all(x["status"] == expected_status for x in result["applicability-result.json"]["decisions"]))
        self.assertEqual(result["findings.json"], self.findings)
        self.assertEqual(result["osv-records.json"], self.records)
        hashes = result["scan.json"]["source_input_sha256"]
        for file in (REGISTER, SCHEMA, "scripts/ci/dependency-policy.json", "scripts/ci/dependency-exceptions.json", self.subject["path"]):
            self.assertEqual(hashes[file], hashlib.sha256((self.root / file).read_bytes()).hexdigest())
        self.assertEqual(result["scan.json"]["evidence_mode"], "archived-raw-replay")

    @classmethod
    def tearDownClass(cls):
        if os.environ.get("DEPSEC_APPLICABILITY_RESULTS"):
            write(Path(os.environ["DEPSEC_APPLICABILITY_RESULTS"]), {"results": cls.cli_results})


if __name__ == "__main__":
    unittest.main(verbosity=2)
