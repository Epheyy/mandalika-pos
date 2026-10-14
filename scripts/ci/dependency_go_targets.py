"""Required Go scan targets and completed, graph-bound evidence (not exceptions)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

from dependency_policy import PolicyError, govuln_findings, json_stream


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tools_from_mod(text):
    # Go's tool directive accepts one path or a parenthesized list. Refuse an
    # unfamiliar form rather than silently omitting a declared project tool.
    text = re.sub(r"//[^\n]*", "", text)
    paths = []
    in_block = False
    for line in text.splitlines():
        line = line.strip()
        if in_block:
            if line == ")":
                in_block = False
                continue
            if line:
                paths.append(line)
        elif line == "tool (":
            in_block = True
        elif line.startswith("tool "):
            paths.append(line[5:].strip())
    if in_block or not paths or len(set(paths)) != len(paths) or any(not re.fullmatch(r"[A-Za-z0-9_.~/-]+", p) for p in paths):
        raise PolicyError("Required Go tool declaration is missing or unsupported")
    return sorted(paths)


def required_targets(root):
    return [{"id": "application", "patterns": ["./..."], "role": "application-and-project-source"}] + [
        {"id": "tool-" + str(i), "patterns": [p], "role": "build-tool"}
        for i, p in enumerate(tools_from_mod((root / "backend/go.mod").read_text(encoding="utf8")))
    ]


def source_identity(root):
    # Include source, tests, guard and module inputs. No .env/config credentials.
    paths = sorted(p for p in (root / "backend").rglob("*.go") if "vendor" not in p.parts)
    paths += [root / "backend/go.mod", root / "backend/go.sum"]
    return {p.relative_to(root).as_posix(): digest(p) for p in paths}


def validate_target(text, target, modules):
    config, findings = govuln_findings(text)
    required = {"scanner_name": "govulncheck", "scanner_version": "v1.8.0", "go_version": "go1.26.9", "scan_level": "symbol", "scan_mode": "source"}
    if any(config.get(k) != v for k, v in required.items()):
        raise PolicyError("Go target scanner configuration mismatch")
    messages = json_stream(text)
    if any("error" in m for m in messages):
        raise PolicyError("Go target emitted an error")
    sboms = [m["SBOM"] for m in messages if "SBOM" in m]
    if len(sboms) != 1 or sboms[0].get("go_version") != "go1.26.9" or not sboms[0].get("modules"):
        raise PolicyError("Go target SBOM missing/incomplete")
    if not any("progress" in m and "Checking the code against" in m["progress"].get("message", "") for m in messages):
        raise PolicyError("Go symbol analysis was not reached")
    selected = {m["Path"]: m.get("Version", "") for m in modules}
    observed = {}
    for m in sboms[0]["modules"]:
        name, version = m["path"], m.get("version", "")
        if name in observed:
            raise PolicyError("Duplicate Go target SBOM module")
        observed[name] = version
        if name == "stdlib":
            if version != "v1.26.9":
                raise PolicyError("Wrong Go target standard library")
        elif name not in selected or selected[name] != version:
            raise PolicyError("Go target graph/version mismatch")
    if target["role"] == "build-tool":
        if sboms[0].get("roots") != target["patterns"]:
            raise PolicyError("Go target package roots mismatch")
        pattern = target["patterns"][0]
        parents = [m for m in selected if pattern == m or pattern.startswith(m + "/")]
        if not parents or max(parents, key=len) not in observed:
            raise PolicyError("Go target tool module missing")
    for f in findings:
        if f["package"] != "stdlib" and selected.get(f["package"]) != f["version"]:
            raise PolicyError("Go finding graph/version mismatch")
    return config, findings


def load_targets(raw, root):
    manifest = json.loads((raw / "go-targets.json").read_text(encoding="utf8"))
    expected = required_targets(root)
    if manifest.get("schema_version") != 1 or manifest.get("required") != expected:
        raise PolicyError("Required Go scan target inventory mismatch")
    if manifest.get("source_sha256") != source_identity(root):
        raise PolicyError("Go scan source identity mismatch")
    if manifest.get("modules_sha256") != digest(raw / "go-modules.json"):
        raise PolicyError("Go scan module inventory identity mismatch")
    runs = manifest.get("runs", [])
    if len(runs) != len(expected) or {r["id"] for r in runs} != {t["id"] for t in expected}:
        raise PolicyError("Required Go target is missing/duplicated")
    modules = json_stream((raw / "go-modules.json").read_text(encoding="utf8"))
    evidence, aggregated = [], []
    for target in expected:
        run = next(r for r in runs if r["id"] == target["id"])
        filename = "govulncheck.json" if target["id"] == "application" else "govulncheck-" + target["id"] + ".json"
        if run.get("output") != filename or run.get("status") != "completed" or run.get("exit") != 0 or run.get("patterns") != target["patterns"]:
            raise PolicyError("Required Go scan did not complete successfully")
        file = raw / filename
        if not file.is_file() or digest(file) != run.get("sha256") or file.stat().st_size != run.get("bytes"):
            raise PolicyError("Go target output missing/truncated/changed")
        text = file.read_text(encoding="utf8")
        config, findings = validate_target(text, target, modules)
        evidence.append({**target, "config": config, "run": run, "messages": json_stream(text)})
        aggregated.extend({**f, "target": target["id"], "role": target["role"]} for f in findings)
    return manifest, evidence, aggregated
