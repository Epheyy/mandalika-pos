"""Exercise the real CLI in disposable script copies; no active dependency/source mutations."""
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

from dependency_policy import HERE, ROOT, PolicyError, govuln_findings


class DependencyGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = []
        cls.parser_root = Path(os.environ.get("DEPSEC_PARSER_ROOT", str(ROOT)))

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mandalika-depsec-proof-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.before = {}
        for file in HERE.glob("dependency*"):
            if file.is_file():
                shutil.copyfile(file, self.root / file.name)
                self.before[file] = hashlib.sha256(file.read_bytes()).hexdigest()
        shutil.copyfile(HERE / "depsec_helper.cjs", self.root / "depsec_helper.cjs")
        self.finding = {"id": "TEST-ADVISORY-1", "ecosystem": "npm", "package": "synthetic-package", "version": "1.2.3", "scope": "runtime", "reachability": "runtime_present_unproven", "severity": "high"}
        self.data = {"findings": [self.finding], "licenses": [], "exceptions": {"schema_version": 1, "policy_id": "DEPSEC-INITIAL-20260922", "security": [], "licenses": []}}

    def tearDown(self):
        self.assertEqual(self.before, {file: hashlib.sha256(file.read_bytes()).hexdigest() for file in self.before})

    def execute(self, expected):
        (self.root / "input.json").write_text(json.dumps(self.data), encoding="utf-8")
        result = subprocess.run([sys.executable, str(self.root / "dependency_security.py"), "evaluate", "--input", str(self.root / "input.json"), "--output", str(self.root / "result"), "--parser-root", str(self.parser_root)], capture_output=True, timeout=60)
        self.assertEqual(result.returncode, expected, result.stdout.decode() + result.stderr.decode())
        self.assertNotIn(b"DEPSEC_TEST_CREDENTIAL_", result.stdout + result.stderr)
        self.results.append({"scenario": self.id().split(".")[-1], "exit": result.returncode, "expected_exit": expected, "stdout": result.stdout.decode().strip(), "active_sources_unchanged": True})
        return json.loads((self.root / "result/policy-result.json").read_text()) if (self.root / "result").exists() else None

    def exception(self):
        today = dt.datetime.now(dt.timezone.utc).date()
        return {"id": self.finding["id"], "ecosystem": "npm", "package": "synthetic-package", "version_range": ">=1.2.3 <1.2.4", "scope": "runtime", "reachability": "runtime_present_unproven", "reason": "Synthetic test only", "compensating_control": "Isolated fixture", "owner": "Synthetic owner", "reviewer": "Synthetic reviewer", "created": str(today - dt.timedelta(days=1)), "expires": str(today + dt.timedelta(days=1)), "remediation": "Synthetic patch", "review_reference": "TEST-ONLY"}

    def test_high_runtime_fails(self):
        self.execute(1)

    def test_known_exploited_low_fails(self):
        self.finding.update(severity="low", known_exploited=True)
        self.execute(1)

    def test_malicious_low_build_fails(self):
        self.finding.update(severity="low", malicious=True, scope="build", reachability="build_executed")
        self.execute(1)

    def test_called_go_low_fails_even_json_exit_zero(self):
        raw = json.dumps({"config": {"scanner_version": "v1.8.0"}}) + json.dumps({"finding": {"osv": "GO-TEST-1", "trace": [{"module": "synthetic-package", "version": "1.2.3", "function": "Called"}]}})
        _, parsed = govuln_findings(raw)
        self.finding.update(ecosystem="Go", severity="low", called=parsed[0]["called"])
        self.execute(1)

    def test_empty_govuln_output_not_clean(self):
        with self.assertRaises(PolicyError):
            govuln_findings("")

    def test_moderate_report_only_passes(self):
        self.finding["severity"] = "moderate"
        result = self.execute(0)
        self.assertEqual(len(result["reported"]), 1)

    def test_unknown_runtime_reachability_fails(self):
        self.finding.update(severity="low", reachability="unknown")
        self.execute(1)

    def test_missing_runtime_license_fails(self):
        self.data["findings"] = []
        self.data["licenses"] = [{"ecosystem": "npm", "package": "synthetic-package", "version": "1.2.3", "scope": "runtime", "expression": "NOASSERTION", "evidence_present": False}]
        self.execute(1)

    def test_unknown_custom_license_fails(self):
        self.data["findings"] = []
        self.data["licenses"] = [{"ecosystem": "npm", "package": "synthetic-package", "version": "1.2.3", "scope": "runtime", "expression": "LicenseRef-unreviewed", "evidence_present": True}]
        self.execute(1)

    def test_named_spdx_not_automatically_denied(self):
        self.data["findings"] = []
        self.data["licenses"] = [{"ecosystem": "npm", "package": "synthetic-package", "version": "1.2.3", "scope": "runtime", "expression": "AGPL-3.0-or-later", "evidence_present": True}]
        result = self.execute(0)
        self.assertEqual(result["license_results"][0]["status"], "review_required")

    def test_expired_exception_fails(self):
        exception = self.exception()
        exception["expires"] = str(dt.datetime.now(dt.timezone.utc).date())
        self.data["exceptions"]["security"] = [exception]
        self.execute(2)

    def test_exact_exception_only_suppresses_matching_version(self):
        self.data["exceptions"]["security"] = [self.exception()]
        self.data["findings"].append(self.finding | {"version": "1.2.4"})
        result = self.execute(1)
        self.assertEqual([x["version"] for x in result["suppressed"]], ["1.2.3"])
        self.assertEqual([x["version"] for x in result["blocking"]], ["1.2.4"])

    def test_exact_valid_exception_passes(self):
        self.data["exceptions"]["security"] = [self.exception()]
        result = self.execute(0)
        self.assertEqual(len(result["suppressed"]), 1)

    def test_unrelated_finding_remains_blocked(self):
        self.data["exceptions"]["security"] = [self.exception()]
        self.data["findings"].append(self.finding | {"id": "TEST-ADVISORY-2"})
        result = self.execute(1)
        self.assertEqual([x["id"] for x in result["blocking"]], ["TEST-ADVISORY-2"])

    def test_mismatched_package_exception_fails(self):
        exception = self.exception() | {"package": "different"}
        self.data["exceptions"]["security"] = [exception]
        self.execute(2)

    def test_out_of_range_exception_fails(self):
        self.data["exceptions"]["security"] = [self.exception() | {"version_range": "2.0.0"}]
        self.execute(2)

    def test_credential_marker_rejected_before_artifact(self):
        self.finding["details"] = "DEPSEC_TEST_" + "CREDENTIAL_SYNTHETIC_ONLY"
        self.assertIsNone(self.execute(2))

    def test_pr_delta_high_development_fails(self):
        self.finding.update(scope="development-only", reachability="development_only")
        self.data["delta"] = True
        self.execute(1)

    def test_pr_delta_malicious_development_fails(self):
        self.finding.update(scope="development-only", reachability="development_only", severity="low", malicious=True)
        self.data["delta"] = True
        self.execute(1)

    @classmethod
    def tearDownClass(cls):
        if os.environ.get("DEPSEC_TEST_RESULTS"):
            Path(os.environ["DEPSEC_TEST_RESULTS"]).write_text(json.dumps({"disposable_copies": True, "results": cls.results}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main(verbosity=2)
