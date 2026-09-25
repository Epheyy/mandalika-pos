"""KC13–15: target completeness, retained real old traces and unchanged policy."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from dependency_go_targets import digest, load_targets, required_targets, source_identity, tools_from_mod
from dependency_inventory import findings
from dependency_policy import HERE, ROOT, PolicyError, evaluate


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf8")


def synthetic_go_evidence(root, raw):
    """Complete synthetic zero-finding protocol for scanner CLI fixture tests."""
    (root / "backend").mkdir(exist_ok=True)
    (root / "backend/go.mod").write_text("module synthetic/replay\ngo 1.26.0\ntool synthetic/replay/cmd/tool\n")
    (root / "backend/go.sum").write_text("")
    write(raw / "go-modules.json", {"Main": True, "Path": "synthetic/replay"})
    targets = required_targets(root)
    config = {"scanner_name": "govulncheck", "scanner_version": "v1.8.0", "go_version": "go1.26.8", "scan_level": "symbol", "scan_mode": "source"}
    messages = [{"config": config}, {"SBOM": {"go_version": "go1.26.8", "modules": [{"path": "synthetic/replay"}, {"path": "stdlib", "version": "v1.26.8"}]}},
                {"progress": {"message": "Checking the code against the vulnerabilities..."}}]
    runs = []
    for t in targets:
        filename = "govulncheck.json" if t["id"] == "application" else "govulncheck-" + t["id"] + ".json"
        messages[1]["SBOM"]["roots"] = t["patterns"] if t["role"] == "build-tool" else ["synthetic/replay"]
        (raw / filename).write_text("\n".join(json.dumps(v) for v in messages))
        runs.append({"id": t["id"], "patterns": t["patterns"], "status": "completed", "exit": 0, "output": filename, "sha256": digest(raw / filename), "bytes": (raw / filename).stat().st_size})
    manifest = {"schema_version": 1, "required": targets, "runs": runs, "source_sha256": source_identity(root), "modules_sha256": digest(raw / "go-modules.json")}
    write(raw / "go-targets.json", manifest)
    return manifest


class TargetEvidence(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="mandalika-go-targets-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        self.manifest = synthetic_go_evidence(self.root, self.raw)

    def test_zero_findings_requires_completed_evidence(self):
        _, evidence, values = load_targets(self.raw, self.root)
        self.assertEqual(len(evidence), 2)
        self.assertEqual(values, [])

    def test_missing_failed_skipped_target(self):
        for field, value in [("exit", 1), ("status", "skipped"), ("patterns", ["./wrong"])]:
            manifest = copy.deepcopy(self.manifest)
            manifest["runs"][1][field] = value
            write(self.raw / "go-targets.json", manifest)
            with self.assertRaises(PolicyError): load_targets(self.raw, self.root)
        manifest = copy.deepcopy(self.manifest)
        manifest["runs"].pop()
        write(self.raw / "go-targets.json", manifest)
        with self.assertRaises(PolicyError): load_targets(self.raw, self.root)

    def test_missing_truncated_invalid_and_empty_output(self):
        file = self.raw / "govulncheck-tool-0.json"
        original = file.read_text()
        for text in ["", original[:len(original)//2], "{}", original[:-1]]:
            file.write_text(text)
            with self.assertRaises(PolicyError): load_targets(self.raw, self.root)
        file.unlink()
        with self.assertRaises(PolicyError): load_targets(self.raw, self.root)

    def test_wrong_source_and_graph(self):
        (self.root / "backend/go.sum").write_text("changed graph")
        with self.assertRaises(PolicyError): load_targets(self.raw, self.root)
        self.manifest = synthetic_go_evidence(self.root, self.raw)
        write(self.raw / "go-modules.json", {"Path": "wrong", "Main": True})
        with self.assertRaises(PolicyError): load_targets(self.raw, self.root)

    def test_valid_json_prefix_is_not_completion(self):
        file = self.raw / "govulncheck-tool-0.json"
        text = file.read_text().splitlines()[0]  # complete config object; no SBOM/progress
        file.write_text(text)
        m = self.manifest
        m["runs"][1].update(sha256=digest(file), bytes=file.stat().st_size)
        write(self.raw / "go-targets.json", m)
        with self.assertRaises(PolicyError): load_targets(self.raw, self.root)

    def test_tool_inventory_includes_every_declared_tool(self):
        self.assertEqual(tools_from_mod("tool (\n example/a\n example/b // comment\n)"), ["example/a", "example/b"])
        (self.root / "backend/go.mod").write_text("module synthetic/replay\ntool (\n synthetic/replay/cmd/tool\n synthetic/replay/cmd/second\n)\n")
        with self.assertRaises(PolicyError): load_targets(self.raw, self.root)

    def test_attested_wrong_configuration_and_tool_identity(self):
        for kind in ["scanner", "go", "root", "module", "error"]:
            self.manifest = synthetic_go_evidence(self.root, self.raw)
            file = self.raw / "govulncheck-tool-0.json"
            messages = [json.loads(line) for line in file.read_text().splitlines()]
            if kind == "scanner": messages[0]["config"]["scanner_version"] = "v0.0.0"
            if kind == "go": messages[0]["config"]["go_version"] = "go1.26.2"
            if kind == "root": messages[1]["SBOM"]["roots"] = ["synthetic/replay/other"]
            if kind == "module": messages[1]["SBOM"]["modules"][0]["version"] = "v9.9.9"
            if kind == "error": messages.append({"error": {"message": "controlled compiler error"}})
            file.write_text("\n".join(json.dumps(m) for m in messages))
            self.manifest["runs"][1].update(sha256=digest(file), bytes=file.stat().st_size)
            write(self.raw / "go-targets.json", self.manifest)
            with self.assertRaises(PolicyError): load_targets(self.raw, self.root)

    def test_real_old_generator_called_evidence_reaches_policy(self):
        from dependency_policy import govuln_findings
        fixture = json.loads((HERE / "fixtures/generator-before.json").read_text())
        _, old = govuln_findings("\n".join(json.dumps(x) for x in fixture["messages"]))
        called = [x for x in old if x["called"]]
        self.assertEqual({x["id"] for x in called}, {"GO-2026-6016"})
        self.assertEqual(len(called), 18)  # exact archived replay, not a fresh scan count
        policy = json.loads((HERE / "dependency-policy.json").read_text())
        register = {"schema_version": 1, "policy_id": policy["id"], "security": [], "licenses": []}
        f = called[0] | {"ecosystem": "Go", "scope": "build", "severity": "moderate", "reachability": "build_executed", "aliases": [], "known_exploited": False, "malicious": False}
        result = evaluate([f], [], register, policy)
        self.assertTrue(result["blocking"])
        self.assertIn("govulncheck called/reachable symbol", result["blocking"][0]["reasons"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
