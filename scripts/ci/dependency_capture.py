"""Bounded public-source collection. Never reads application .env or database state."""
from __future__ import annotations

import base64
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request

from dependency_policy import PolicyError, helper, json_stream
from dependency_vendor import vendor_evidence
from dependency_go_targets import required_targets, source_identity, digest, validate_target


def write(path, data):
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def fetch(url, data=None):
    if urllib.parse.urlparse(url).hostname not in {"registry.npmjs.org", "api.osv.dev", "www.cisa.gov"}:
        raise PolicyError("Unapproved dependency evidence host")
    request = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(),
                                     headers={"User-Agent": "Mandalika-depsec/1.0", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        if urllib.parse.urlparse(response.url).hostname != urllib.parse.urlparse(url).hostname:
            raise PolicyError("Unexpected dependency evidence redirect")
        content = response.read(64 * 1024 * 1024 + 1)
    if len(content) > 64 * 1024 * 1024:
        raise PolicyError("Dependency evidence exceeds bounded size")
    return content


def request_json(url, data=None):
    return json.loads(fetch(url, data))


def run(args, cwd, env, output, accepted=(0,), timeout=300):
    executable = shutil.which(str(args[0]))
    if not executable:
        raise PolicyError("Required dependency tool unavailable")
    result = subprocess.run([executable, *map(str, args[1:])], cwd=cwd, env=env, capture_output=True, timeout=timeout)
    output.write_bytes(result.stdout)
    output.with_suffix(output.suffix + ".stderr").write_bytes(result.stderr)
    if result.returncode not in accepted:
        raise PolicyError(f"Dependency collection command failed ({Path(executable).name}, exit {result.returncode}); output held outside artifact directory")
    return result.stdout.decode("utf-8")


def node_evidence(key, package, root=None):
    name, version = key.rsplit("@", 1)
    if version.startswith("file:"):
        if root is None:
            raise PolicyError("Vendor evidence requires an explicit repository root")
        return vendor_evidence(root, key, package)
    resolution = package["resolution"]
    metadata = request_json("https://registry.npmjs.org/" + urllib.parse.quote(name, safe="") + "/" + version)
    tarball = metadata["dist"]["tarball"]
    content = fetch(tarball)
    integrity = resolution.get("integrity")
    if not integrity or len(integrity.split()) != 1:
        raise PolicyError("Missing/unsupported exact pnpm integrity")
    algorithm, expected = integrity.split("-", 1)
    if algorithm not in {"sha512", "sha256", "sha1"} or base64.b64encode(hashlib.new(algorithm, content).digest()).decode() != expected:
        raise PolicyError("Registry tarball differs from locked integrity")
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
        roots = [x for x in archive.getmembers() if x.isfile() and len(Path(x.name).parts) == 2 and x.name.endswith("/package.json")]
        if len(roots) != 1:
            raise PolicyError("Ambiguous package metadata")
        package_json = json.load(archive.extractfile(roots[0]))
        if package_json["name"] != name or package_json["version"] != version:
            raise PolicyError("Package identity differs from lockfile")
        declared = package_json.get("license")
        referenced_files = re.findall(r"SEE LICENSE IN ([^\s()]+)", declared, re.IGNORECASE) if isinstance(declared, str) else []
        files = []
        for member in archive.getmembers():
            license_name = Path(member.name).name.upper()
            conventional = any(license_name == x or license_name.startswith(x + ".") or license_name.startswith(x + "-") for x in {"LICENSE", "LICENCE", "COPYING", "COPYRIGHT", "NOTICE"})
            referenced = any(member.name.endswith("/" + x) for x in referenced_files)
            if member.isfile() and (len(Path(member.name).parts) == 2 and conventional or referenced):
                if member.size > 2 * 1024 * 1024:
                    raise PolicyError("License file exceeds bounded size")
                files.append({"path": member.name, "sha256": hashlib.sha256(archive.extractfile(member).read()).hexdigest(), "bytes": member.size})
    return {"key": key, "name": name, "version": version, "declared_license": package_json.get("license"), "license_files": files,
            "scripts": package_json.get("scripts", {}), "tarball": tarball, "integrity": integrity,
            "tarball_sha256": hashlib.sha256(content).hexdigest(), "provenance": "Exact registry tarball; locked integrity verified; contents never executed"}


def osv_capture(components, raw):
    queries = [{"package": {"name": x["package"], "ecosystem": x["ecosystem"]}, "version": x["version"]} for x in components]
    results = []
    for offset in range(0, len(queries), 100):
        batch = queries[offset:offset + 100]
        response = request_json("https://api.osv.dev/v1/querybatch", {"queries": batch})["results"]
        if len(response) != len(batch):
            raise PolicyError("Incomplete OSV batch")
        for query, result in zip(batch, response):
            seen = set()
            while result.get("next_page_token"):
                token = result.pop("next_page_token")
                if token in seen or len(seen) >= 100:
                    raise PolicyError("OSV pagination incomplete")
                seen.add(token)
                page = request_json("https://api.osv.dev/v1/query", query | {"page_token": token})
                result["vulns"] = result.get("vulns", []) + page.get("vulns", [])
                result["next_page_token"] = page.get("next_page_token")
        results.extend(response)
    write(raw / "osv-query.json", {"queries": queries, "results": results})
    ids = sorted({x["id"] for r in results for x in r.get("vulns", [])})
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        records = list(pool.map(lambda id: request_json("https://api.osv.dev/v1/vulns/" + id), ids))
    write(raw / "osv-records.json", records)
    write(raw / "cisa-kev.json", request_json("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"))


def capture(root, raw, parser_root):
    raw.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    env.update({"GOTOOLCHAIN": "go1.26.10", "GOENV": "off", "GOFLAGS": "-mod=readonly", "GOWORK": "off", "GOPROXY": "https://proxy.golang.org", "GOSUMDB": "sum.golang.org", "GONOSUMDB": "", "GONOPROXY": "", "GOPRIVATE": ""})
    for executable, module, version in [("govulncheck", "golang.org/x/vuln", "v1.8.0"), ("identify_license", "github.com/google/licenseclassifier/v2", "v2.0.0")]:
        binary = shutil.which(executable)
        if not binary:
            raise PolicyError("Required pinned Go scanner unavailable")
        info = run(["go", "version", "-m", binary], root, env, raw / (executable + "-build.txt"))
        if f"mod\t{module}\t{version}\t" not in info:
            raise PolicyError("Go scanner module/version mismatch")
    lock = helper("lock", (root / "pnpm-lock.yaml").read_text(encoding="utf-8"), parser_root)
    write(raw / "lock.json", lock)
    with tempfile.TemporaryDirectory(prefix="mandalika-depsec-config-") as config:
        empty_config = Path(config) / "npmrc"
        empty_config.write_text("", encoding="utf-8")
        env["npm_config_userconfig"] = str(empty_config)
        version = run(["corepack", "pnpm", "--version"], root, env, raw / "pnpm-version.txt").strip()
        if version != "9.15.0":
            raise PolicyError("pnpm scanner version mismatch")
        run(["corepack", "pnpm", "audit", "--json", "--registry=https://registry.npmjs.org"], root, env, raw / "pnpm-audit.json", accepted=(0, 1))
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        evidence = list(pool.map(lambda pair: node_evidence(*pair, root=root), lock["packages"].items()))
    write(raw / "node-package-evidence.json", evidence)
    backend = root / "backend"
    for filename, args in [
        ("go-modules.json", ["list", "-mod=readonly", "-m", "-json", "all"]),
        ("go-graph.json", ["mod", "graph"]),
        ("go-runtime.json", ["list", "-mod=readonly", "-deps", "-json", "./cmd/server"]),
        ("go-packages.json", ["list", "-mod=readonly", "-deps", "-test", "-json", "./...", "github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen"]),
    ]:
        run(["go", *args], backend, env, raw / filename)
    # `go mod download all` adds graph-only checksums even when source builds are
    # readonly. Keep that necessary discovery mutation out of the checkout.
    with tempfile.TemporaryDirectory(prefix="mandalika-depsec-module-") as module_directory:
        for filename in ["go.mod", "go.sum"]:
            shutil.copyfile(backend / filename, Path(module_directory) / filename)
        run(["go", "mod", "download", "-json", "all"], module_directory, env, raw / "go-download.json")
    version = run(["go", "env", "GOVERSION"], backend, env, raw / "go-version.txt").strip()
    goroot = run(["go", "env", "GOROOT"], backend, env, raw / "go-root.txt").strip()
    if version != "go1.26.10":
        raise PolicyError("Go toolchain mismatch")
    write(raw / "toolchain.json", {"version": version, "license": "BSD-3-Clause", "license_sha256": hashlib.sha256((Path(goroot) / "LICENSE").read_bytes()).hexdigest()})
    targets = required_targets(root)
    source_before = source_identity(root)
    modules = json_stream((raw / "go-modules.json").read_text(encoding="utf8"))
    target_runs = []
    for target in targets:
        filename = "govulncheck.json" if target["id"] == "application" else "govulncheck-" + target["id"] + ".json"
        text = run(["govulncheck", "-json", *target["patterns"]], backend, env, raw / filename, timeout=600)
        validate_target(text, target, modules)
        target_runs.append({"id": target["id"], "patterns": target["patterns"], "status": "completed", "exit": 0,
                            "output": filename, "sha256": digest(raw / filename), "bytes": (raw / filename).stat().st_size})
    if source_before != source_identity(root):
        raise PolicyError("Go source changed during target scans")
    write(raw / "go-targets.json", {"schema_version": 1, "required": targets, "runs": target_runs,
                                  "source_sha256": source_before, "modules_sha256": digest(raw / "go-modules.json")})
    with tempfile.TemporaryDirectory(prefix="mandalika-depsec-license-") as directory:
        mapping = []
        for module in json_stream((raw / "go-download.json").read_text(encoding="utf-8")):
            for file in Path(module["Dir"]).iterdir():
                if file.is_file() and file.name.upper().split(".")[0] in {"LICENSE", "LICENCE", "COPYING", "COPYRIGHT", "NOTICE"}:
                    filename = str(len(mapping)) + ".txt"
                    shutil.copyfile(file, Path(directory) / filename)
                    mapping.append({"file": filename, "module": module["Path"], "version": module["Version"], "path": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
        write(raw / "go-license-files.json", mapping)
        run(["identify_license", "-headers", "-tasks", "4", "-json", raw / "go-license-classifier.json", directory], backend, env, raw / "classifier-stdout.txt", timeout=180)
    modules = json_stream((raw / "go-modules.json").read_text(encoding="utf-8"))
    osv_capture([{"package": x["name"], "ecosystem": "npm", "version": x["version"]} for x in evidence] +
                [{"package": x["Path"], "ecosystem": "Go", "version": x["Version"]} for x in modules if not x.get("Main")], raw)
