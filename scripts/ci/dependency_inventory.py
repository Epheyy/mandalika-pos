"""Normalize exact lock/module evidence; conservative scopes, CycloneDX 1.6."""
from __future__ import annotations

import collections
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import quote

from dependency_policy import PolicyError, govuln_findings, helper, json_stream


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def node_inventory(raw):
    lock = load(raw / "lock.json")
    packages, snapshots, importers = lock["packages"], lock["snapshots"], lock["importers"]
    records = load(raw / "node-package-evidence.json")
    evidence = {x["key"]: x for x in records}
    if len(evidence) != len(records) or set(evidence) != set(packages):
        raise PolicyError("npm package evidence does not cover exact lockfile")
    nodes = {}
    edges = {}
    for key, snapshot in snapshots.items():
        base = key.split("(")[0]
        if base not in packages:
            raise PolicyError("Unresolved pnpm snapshot")
        children = []
        for name, version in (snapshot.get("dependencies", {}) | snapshot.get("optionalDependencies", {})).items():
            child = f"{name}@{version}"
            if child not in snapshots:
                raise PolicyError("Unresolved pnpm transitive edge")
            children.append(child)
        edges[key] = children
        if evidence[base].get("distribution_kind") == "official-vendor-tarball":
            manifest = evidence[base]["package_manifest"]
            required = manifest.get("dependencies", {}) | manifest.get("optionalDependencies", {})
            resolved = snapshot.get("dependencies", {}) | snapshot.get("optionalDependencies", {})
            if not set(required).issubset(resolved):
                raise PolicyError("Vendor manifest dependency edge missing from lock snapshot")
            peers = manifest.get("peerDependencies", {})
            for name in peers:
                optional = manifest.get("peerDependenciesMeta", {}).get(name, {}).get("optional", False)
                if name not in resolved and not optional:
                    raise PolicyError("Vendor peer dependency edge unresolved")
            for name, version in resolved.items():
                if name not in required and name not in peers:
                    raise PolicyError("Unexpected vendor dependency edge")
                child = evidence[(name + "@" + version).split("(")[0]]
                if child["name"] != name:
                    raise PolicyError("Vendor dependency edge identity mismatch")
                expected = required.get(name, peers.get(name))
                match = helper("ranges", [{"version": child["version"], "range": expected}])[0]
                if expected != "*" and (not match["valid"] or not match["matches"]):
                    raise PolicyError("Vendor dependency edge version conflicts with manifest")
        nodes.setdefault(base, {"scopes": set(), "paths": [], "direct": [], "snapshots": []})["snapshots"].append(key)
    for workspace, importer in importers.items():
        for group in ("dependencies", "optionalDependencies", "devDependencies"):
            scope = "build" if group == "devDependencies" else "runtime"
            for name, spec in importer.get(group, {}).items():
                if spec["version"].startswith("link:"):
                    continue  # Every workspace's own roots are enumerated independently.
                key = f"{name}@{spec['version']}"
                if key not in snapshots:
                    raise PolicyError("Unresolved pnpm workspace root")
                nodes[key.split("(")[0]]["direct"].append({"workspace": workspace, "group": group, "specifier": spec["specifier"]})
                queue = collections.deque([(key, [workspace, key])])
                seen = set()
                while queue:
                    current, path = queue.popleft()
                    if current in seen:
                        continue
                    seen.add(current)
                    node = nodes[current.split("(")[0]]
                    node["scopes"].add(scope)
                    # One witness per workspace/scope, full adjacency retained separately.
                    if not any(x["workspace"] == workspace and x["scope"] == scope for x in node["paths"]):
                        node["paths"].append({"workspace": workspace, "scope": scope, "path": path})
                    queue.extend((child, path + [child]) for child in edges[current])
    result = []
    for key, package in evidence.items():
        node = nodes.get(key, {"scopes": set(), "paths": [], "direct": [], "snapshots": []})
        scope = "runtime" if "runtime" in node["scopes"] else "build" if "build" in node["scopes"] else "unknown"
        result.append(package | {"ecosystem": "npm", "package": package["name"], "scope": scope,
                                "all_scopes": sorted(node["scopes"]), "direct": node["direct"],
                                "paths": node["paths"], "snapshots": node["snapshots"],
                                "reachability": "runtime_present_unproven" if scope == "runtime" else "build_executed" if scope == "build" else "unknown",
                                "lifecycle_scripts": {k: v for k, v in package["scripts"].items() if k in {"preinstall", "install", "postinstall"}}})
    return {"components": result, "importers": importers, "snapshot_edges": edges}


def go_inventory(raw):
    modules = json_stream((raw / "go-modules.json").read_text(encoding="utf-8"))
    runtime = json_stream((raw / "go-runtime.json").read_text(encoding="utf-8"))
    compiled = json_stream((raw / "go-packages.json").read_text(encoding="utf-8"))
    runtime_modules = {x.get("Module", {}).get("Path") for x in runtime}
    compiled_modules = {x.get("Module", {}).get("Path") for x in compiled}
    classifiers = {Path(x["Filepath"]).name: x.get("Classifications", []) for x in load(raw / "go-license-classifier.json")}
    files = load(raw / "go-license-files.json")
    downloads = {x["Path"]: x for x in json_stream((raw / "go-download.json").read_text(encoding="utf-8"))}
    result = []
    for module in modules:
        if module.get("Main"):
            continue
        name, version = module["Path"], module["Version"]
        if module.get("Replace"):
            raise PolicyError("Go replacement requires explicit provenance support")
        scope = "runtime" if name in runtime_modules else "build" if name in compiled_modules else "development-only"
        license_files = []
        ids = set()
        for file in files:
            if file["module"] != name:
                continue
            classifications = [x for x in classifiers.get(file["file"], []) if x["Name"] not in {"Copyright", "Disclaimer"}]
            ids.update(x["Name"] for x in classifications)
            license_files.append({k: file[k] for k in ["path", "sha256"]} | {"classifications": classifications})
        # AND conservatively preserves all detected terms; this is evidence, not legal approval.
        expression = " AND ".join(sorted(ids)) or "NOASSERTION"
        result.append({"ecosystem": "Go", "package": name, "version": version, "direct": not module.get("Indirect", False),
                       "scope": scope, "reachability": {"runtime": "runtime_present_unproven", "build": "build_executed", "development-only": "development_only"}[scope],
                       "declared_license": expression, "license_files": license_files,
                       "sum": downloads.get(name, {}).get("Sum"), "go_mod_sum": downloads.get(name, {}).get("GoModSum"),
                       "scope_evidence": "cmd/server imports" if scope == "runtime" else "source/test/codegen imports" if scope == "build" else "module graph only; absent from current source/test/codegen imports"})
    return {"components": result, "main": [x["Path"] for x in modules if x.get("Main")],
            "module_graph": (raw / "go-graph.json").read_text(encoding="utf-8").splitlines(),
            "toolchain": load(raw / "toolchain.json")}


def license_inventory(components):
    result = []
    for c in components:
        expression = c.get("declared_license")
        if isinstance(expression, dict):
            expression = expression.get("type")
        if not isinstance(expression, str):
            expression = "NOASSERTION"
        references = re.findall(r"SEE LICENSE IN ([^\s()]+)", expression, re.IGNORECASE)
        result.append({k: c[k] for k in ["ecosystem", "package", "version", "scope"]} |
                      {"expression": expression, "evidence_present": bool(c.get("declared_license") or c.get("license_files")),
                       "missing_referenced_terms": any(not any(x["path"].endswith("/" + reference) or x["path"] == reference for x in c["license_files"]) for reference in references),
                       "license_files": c["license_files"], "distribution_context": "locked application/workspace build; legal compatibility not inferred"})
    return result


def findings(raw, components, root):
    index = {(x["ecosystem"], x["package"], x["version"]): x for x in components}
    if len(index) != len(components):
        raise PolicyError("Ambiguous advisory identity across component distributions")
    records = {x["id"]: x for x in load(raw / "osv-records.json")}
    audit = load(raw / "pnpm-audit.json")
    if not isinstance(audit.get("advisories"), dict) or "metadata" not in audit:
        raise PolicyError("Incomplete pnpm audit response")
    severity_by_id = {}
    for record in records.values():
        severity = record.get("database_specific", {}).get("severity")
        if severity:
            for id in [record["id"]] + record.get("aliases", []):
                severity_by_id[id] = severity.lower()
    for advisory in audit["advisories"].values():
        for id in [advisory["github_advisory_id"]] + advisory.get("cves", []):
            severity_by_id[id] = advisory["severity"].lower()
    kev = {x["cveID"] for x in load(raw / "cisa-kev.json")["vulnerabilities"]}
    result = {}

    def add(id, component, aliases, severity, source, **extra):
        key = (id, component["ecosystem"], component["package"], component["version"])
        record = {k: component[k] for k in ["ecosystem", "package", "version", "scope", "reachability"]}
        record |= {"id": id, "aliases": aliases, "severity": severity, "source": source,
                   "known_exploited": bool(kev.intersection([id] + aliases)), "malicious": id.startswith("MAL-")}
        result[key] = result.get(key, {}) | record | extra

    queries = load(raw / "osv-query.json")
    if len(queries["queries"]) != len(queries["results"]) or len(queries["queries"]) != len(components):
        raise PolicyError("OSV inventory/response count mismatch")
    queried = [(q["package"]["ecosystem"], q["package"]["name"], q["version"]) for q in queries["queries"]]
    if len(set(queried)) != len(queried) or set(queried) != set(index):
        raise PolicyError("OSV queries do not cover exact component identities")
    for query, response in zip(queries["queries"], queries["results"]):
        component = index[(query["package"]["ecosystem"], query["package"]["name"], query["version"])]
        for finding in response.get("vulns", []):
            record = records[finding["id"]]
            if record.get("withdrawn"):
                continue
            aliases = record.get("aliases", [])
            severity = next((severity_by_id[x] for x in [record["id"]] + aliases if x in severity_by_id), "unknown")
            add(record["id"], component, aliases, severity, "OSV", affected=record.get("affected"), modified=record.get("modified"))
    for advisory in audit["advisories"].values():
        for match in advisory["findings"]:
            component = index.get(("npm", advisory["module_name"], match["version"]))
            if component is None:
                raise PolicyError("npm advisory cannot be mapped to exact inventory")
            add(advisory["github_advisory_id"], component, advisory.get("cves", []), advisory["severity"], "pnpm+OSV",
                affected_range=advisory["vulnerable_versions"], fixed_range=advisory["patched_versions"])
    from dependency_go_targets import load_targets
    manifest, targets, go_findings = load_targets(raw, root)
    # Each canonical advisory/module/version receives every target trace. A
    # module/imported observation can never erase earlier called evidence.
    for f in sorted(go_findings, key=lambda x: x["called"]):
        component = index.get(("Go", f["package"], f["version"]))
        if f["package"] == "stdlib":
            component = {"ecosystem": "Go", "package": "stdlib", "version": f["version"], "scope": "runtime", "reachability": "runtime_present_unproven"}
        if component is None:
            raise PolicyError("govulncheck module cannot be mapped")
        osv = records.get(f["id"], {})
        aliases = osv.get("aliases", [])
        severity = next((severity_by_id[x] for x in [f["id"]] + aliases if x in severity_by_id), "unknown")
        key = (f["id"], "Go", component["package"], component["version"])
        previous = result.get(key, {})
        called = previous.get("called", False) or f["called"]
        imported = previous.get("imported", False) or f["imported"]
        traces = previous.get("target_traces", []) + [{k: f[k] for k in ["target", "role", "called", "imported", "trace"]}]
        # ./... includes build commands and tests. Do not label these calls as
        # deployed runtime merely because they occur in the application scan.
        reachability = component["reachability"]
        if called and component["scope"] == "build":
            reachability = "build_executed"
        add(f["id"], component, aliases, severity, "govulncheck", called=called, imported=imported,
            trace=f["trace"], target_traces=traces, fixed_version=f["fixed_version"], reachability=reachability)
    return list(result.values()), {"manifest": manifest, "targets": targets}



def sbom(inventory, licenses, sha, timestamp, parser_root):
    components = inventory["components"]
    parsed = helper("licenses", [x["expression"] for x in licenses], parser_root)
    license_by_key = {(x["ecosystem"], x["package"], x["version"]): (x, valid) for x, valid in zip(licenses, parsed)}
    rows = []
    refs = {}
    for c in components:
        kind = "npm" if c["ecosystem"] == "npm" else "golang"
        ref = f"pkg:{kind}/{quote(c['package'], safe='/')}@{quote(c['version'], safe='')}"
        refs[c.get("key", c["package"] + "@" + c["version"])] = ref
        license, valid = license_by_key[(c["ecosystem"], c["package"], c["version"])]
        row = {"type": "library", "bom-ref": ref, "name": c["package"], "version": c["version"], "purl": ref,
               "scope": "required" if c["scope"] in {"runtime", "build"} else "optional",
               "properties": [{"name": "mandalika:dependency-scope", "value": c["scope"]}, {"name": "mandalika:reachability", "value": c["reachability"]}]}
        row["licenses"] = [{"expression": license["expression"]}] if valid else [{"license": {"name": license["expression"]}}]
        if c.get("tarball_sha256"):
            row["hashes"] = [{"alg": "SHA-256", "content": c["tarball_sha256"]}]
        if c.get("distribution_kind") == "official-vendor-tarball":
            row["externalReferences"] = [{"type": "distribution", "url": c["tarball"],
                                           "hashes": [{"alg": "SHA-256", "content": c["tarball_sha256"]}]}]
            row["properties"].extend({"name": "mandalika:" + field.replace("_", "-"), "value": c[field]}
                                     for field in ["distribution_kind", "key", "local_path", "integrity", "provenance_sha256"])
        rows.append(row)
    edges = collections.defaultdict(set)
    if "snapshot_edges" in inventory:
        for key, children in inventory["snapshot_edges"].items():
            edges[refs[key.split("(")[0]]].update(refs[x.split("(")[0]] for x in children)
    else:
        modules_by_name = {c["package"]: refs[c["package"] + "@" + c["version"]] for c in components}
        for edge in inventory["module_graph"]:
            parent, child = edge.split()
            # Go's graph records minimum requirements; SBOM edges target selected MVS versions.
            if parent.rsplit("@", 1)[0] in modules_by_name and child.rsplit("@", 1)[0] in modules_by_name:
                edges[modules_by_name[parent.rsplit("@", 1)[0]]].add(modules_by_name[child.rsplit("@", 1)[0]])
    return {"$schema": "http://cyclonedx.org/schema/bom-1.6.schema.json", "bomFormat": "CycloneDX", "specVersion": "1.6", "version": 1,
            "metadata": {"timestamp": timestamp, "tools": [{"vendor": "Mandalika", "name": "dependency-inventory", "version": "1.0.0"}],
                         "properties": [{"name": "mandalika:source-sha", "value": sha}]},
            "components": rows, "dependencies": [{"ref": ref, "dependsOn": sorted(edges[ref])} for ref in sorted(refs.values())]}
