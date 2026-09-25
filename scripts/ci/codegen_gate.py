#!/usr/bin/env python3
"""Required canonical generation and approved-contract qualification; offline fixtures."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("bounded_xmod", HERE / "xmod-consumer-test.py")
bounded_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bounded_module)

GUARD = {"TestGuardValidRecursiveAndDeterministic", "TestGuardBoundaryRejectsKOObservations", "TestGuardLocalReferenceSnapshot", "TestGuardPreservesOutputOnFailures", "TestGuardConcurrentWriterAndCommitPoint", "TestGuardOutputPrecedenceAndUnsupportedInputs", "TestGuardWorkerProcess", "TestGuardInertEscaping"}
CONTRACT = {"TestApprovedNullableFields", "TestNullableConstructorsAndActualSyncPointer", "TestAllApprovedOptionalAdapters", "TestGeneratedResponseEncodingBeforeStatus", "TestGeneratedKeyAndNamedTypes"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = HERE.parents[1] / "backend"
    env = dict(os.environ, GOTOOLCHAIN="local", GOWORK="off", GOFLAGS="-mod=readonly")
    version = subprocess.check_output(["go", "version"], cwd=root, env=env, text=True, timeout=30).strip()
    if not version.startswith("go version go1.26.8 "):
        raise RuntimeError("select the qualified Go1.26.8 executable per process")
    temp = Path(tempfile.mkdtemp(prefix="mandalika-codegen-gate-")).resolve()
    report = {"status": "fail", "go": version, "commands": [], "tests": {}, "network": "owned local specs only; no reference HTTP client", "bounds": "60s worker deadline; 16MiB output; 256MiB Go soft heap/2MiB stack; fixture CLI Windows512MiB commit/Linux4GiB AS+15s CPU"}

    def run(label, command, cwd, expected=0, constrain=False):
        result = bounded_module.bounded([str(x) for x in command], cwd, env, 240 if command[0] == "go" else 75, 2 << 20, constrain=constrain)
        report["commands"].append({"label": label, **result})
        if result["exit"] != expected or result["timeout"] or result["outputLimitExceeded"] or not result["reaped"]:
            raise RuntimeError("required codegen command failed: " + label)
        return result["output"]

    def tests(label, command, cwd, required, named_count=None):
        output = run(label, command, cwd)
        events = [json.loads(x) for x in output.splitlines() if x.startswith("{")]
        passed = [e["Test"] for e in events if e.get("Test") and e["Action"] == "pass"]
        top = {name for name in passed if "/" not in name}
        if top != required or any(e["Action"] in {"fail", "skip"} for e in events) or named_count is not None and len(passed) != named_count:
            raise RuntimeError("required tests absent/skipped/failed: " + label)
        report["tests"][label] = {"passed": passed, "skipped": 0}

    try:
        tests("guard", ["go", "test", "-json", "-count=1", "-timeout=90s", "./internal/codegen"], root, GUARD)
        tests("contract", ["go", "test", "-json", "-count=1", "-timeout=90s", "./internal/api"], root, CONTRACT)
        binary = temp / ("codegen.exe" if os.name == "nt" else "codegen")
        run("build", ["go", "build", "-o", binary, "./cmd/codegen"], root)
        report["binary_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        owned = temp / "fixture"
        (owned / "api").mkdir(parents=True)
        fixtures = root / "internal/codegen/testdata"
        for name in ["go.mod", "go.sum"]:
            shutil.copyfile(root / name, owned / name)
        shutil.copyfile(fixtures / "typed.json", owned / "api/openapi.yaml")
        (owned / "api/oapi-codegen.yaml").write_text("package: fixture\noutput: generated.go\ngenerate:\n  models: true\n  chi-server: true\n  strict-server: true\n  embedded-spec: true\noutput-options:\n  nullable-type: true\n")
        run("canonical-fixture-generate", [binary], owned, constrain=True)
        first = (owned / "generated.go").read_bytes()
        run("canonical-repeat", [binary], owned, constrain=True)
        if first != (owned / "generated.go").read_bytes():
            raise RuntimeError("nondeterministic generation")
        run("canonical-check", [binary, "-check"], owned, constrain=True)
        (owned / "generated.go").write_bytes(first + b"\n// controlled drift\n")
        run("canonical-drift-reject", [binary, "-check"], owned, expected=1, constrain=True)
        if (owned / "generated.go").read_bytes() != first + b"\n// controlled drift\n":
            raise RuntimeError("check rewrote drifted output")
        (owned / "generated.go").write_bytes(first)
        shutil.copyfile(fixtures / "fixture_test.go", owned / "fixture_test.go")
        tests("binding-typed-responses", ["go", "test", "-json", "-count=1", "-timeout=45s", "."], owned, {"TestRequiredBindings", "TestTypedRoundTrip", "TestResponseWriters"}, 19)
        report["status"] = "pass"
        return 0
    finally:
        if temp.parent != Path(tempfile.gettempdir()).resolve() or not temp.name.startswith("mandalika-codegen-gate-") or temp.is_symlink():
            raise RuntimeError("owned fixture identity changed")
        shutil.rmtree(temp)
        report["cleanup"] = "owned fixture/processes removed" if not temp.exists() else "uncertain"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
