"""Validate reviewed local package bytes without extracting or executing them."""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

from dependency_policy import PolicyError, ROOT

MAX_ARCHIVE = 16 * 1024 * 1024
MAX_UNPACKED = 128 * 1024 * 1024


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PolicyError("Duplicate vendor JSON field")
        result[key] = value
    return result


def local_path(root, spec, base=None):
    if not isinstance(spec, str) or not spec.startswith("file:"):
        raise PolicyError("Expected local vendor file locator")
    relative = spec[5:]
    if not relative or any(x in relative for x in ["\\", ":", "\x00", "%", "?", "#"]) or relative.startswith("/"):
        raise PolicyError("Unsafe vendor locator")
    root = root.resolve()
    path = (base or root).joinpath(relative)
    resolved = path.resolve()
    if not resolved.is_relative_to(root / "vendor") or resolved.suffix != ".tgz":
        raise PolicyError("Vendor path escapes repository vendor directory")
    for parent in [path, *path.parents]:
        if parent == root:
            break
        if parent.is_symlink() or getattr(parent, "is_junction", lambda: False)():
            raise PolicyError("Vendor symlink/junction is not allowed")
    return resolved


def inspect_archive(content):
    if len(content) > MAX_ARCHIVE:
        raise PolicyError("Vendor archive exceeds size bound")
    files, total, names = {}, 0, set()
    try:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
            for member in archive:
                path = PurePosixPath(member.name)
                if (not path.parts or path.parts[0] != "package" or path.is_absolute()
                        or ".." in path.parts or "\\" in member.name or ":" in member.name
                        or "\x00" in member.name or not (member.isfile() or member.isdir())
                        or member.issparse()):
                    raise PolicyError("Unsafe vendor archive member")
                key = str(path).casefold()
                if key in names or len(names) >= 2048:
                    raise PolicyError("Ambiguous/oversized vendor archive inventory")
                names.add(key)
                total += member.size
                if member.size < 0 or total > MAX_UNPACKED:
                    raise PolicyError("Vendor unpacked size exceeds bound")
                if member.isfile():
                    # Bounded in-memory reads; never extract paths to disk.
                    data = archive.extractfile(member).read(member.size + 1)
                    if len(data) != member.size:
                        raise PolicyError("Truncated vendor archive member")
                    files[str(path)] = data
    except (tarfile.TarError, EOFError, OSError) as error:
        raise PolicyError("Invalid vendor archive") from error
    if "package/package.json" not in files:
        raise PolicyError("Vendor package manifest missing")
    manifest = json.loads(files["package/package.json"], object_pairs_hook=unique_object)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("name"), str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[\w.-]+)?", str(manifest.get("version"))):
        raise PolicyError("Invalid vendor package identity")
    for field in ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies", "scripts"]:
        value = manifest.get(field, {})
        if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
            raise PolicyError("Invalid vendor dependency/script metadata")
    referenced = re.findall(r"SEE LICENSE IN ([^\s()]+)", str(manifest.get("license", "")), re.I)
    licenses = []
    for name, data in files.items():
        leaf = PurePosixPath(name).name.upper()
        if any(leaf == term or leaf.startswith(term + ".") or leaf.startswith(term + "-") for term in ["LICENSE", "LICENCE", "COPYING", "COPYRIGHT", "NOTICE"]) or any(name.endswith("/" + x) for x in referenced):
            if len(data) > 2 * 1024 * 1024:
                raise PolicyError("Vendor license exceeds size bound")
            licenses.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return manifest, sorted(licenses, key=lambda x: x["path"])


def vendor_evidence(root, key, package):
    name, locator = key.rsplit("@", 1)
    if package.get("resolution", {}).get("tarball") != locator:
        raise PolicyError("Vendor resolution tarball conflicts with lock locator")
    path = local_path(root, locator)
    if not path.is_file() or path.stat().st_size > MAX_ARCHIVE:
        raise PolicyError("Vendor tarball missing/oversized")
    provenance_path = path.with_suffix(".provenance.json")
    if provenance_path.is_symlink() or not provenance_path.is_file() or provenance_path.stat().st_size > 1024 * 1024:
        raise PolicyError("Vendor provenance missing/unsafe/oversized")
    provenance = json.loads(provenance_path.read_text(encoding="utf8"), object_pairs_hook=unique_object)
    try:
        retrieved = dt.datetime.fromisoformat(provenance["retrieved_at"].replace("Z", "+00:00"))
        if retrieved.tzinfo is None:
            raise ValueError("Timezone required")
    except (KeyError, ValueError, TypeError, AttributeError) as error:
        raise PolicyError("Vendor retrieval provenance timestamp missing/invalid") from error
    content = path.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(content).digest()).decode()
    relative = path.relative_to(root.resolve()).as_posix()
    if (provenance.get("schema_version") != 1 or provenance.get("path") != relative
            or provenance.get("sha256") != digest or provenance.get("integrity") != integrity
            or provenance.get("bytes") != len(content) or package.get("resolution", {}).get("integrity") != integrity):
        raise PolicyError("Vendor bytes differ from pinned provenance/lock integrity")
    manifest, licenses = inspect_archive(content)
    if not licenses:
        raise PolicyError("Vendor license/notice evidence missing")
    version = manifest["version"]
    if (manifest["name"] != name or provenance.get("name") != name or provenance.get("version") != version
            or package.get("version", version) != version or package.get("name", name) != name
            or provenance.get("license") != manifest.get("license")
            or provenance.get("package_manifest") != manifest
            or sorted(provenance.get("license_files", []), key=lambda x: x["path"]) != licenses):
        raise PolicyError("Vendor manifest/license identity conflicts with provenance/lock")
    # This slice approves one distribution source, not arbitrary local forks.
    if name != "xlsx" or provenance.get("source_url") != f"https://cdn.sheetjs.com/xlsx-{version}/xlsx-{version}.tgz" or provenance.get("distribution_kind") != "official-vendor-tarball":
        raise PolicyError("Vendor source is outside the reviewed distribution contract")
    return {"key": key, "name": name, "version": version, "declared_license": manifest.get("license"),
            "license_files": licenses, "scripts": manifest.get("scripts", {}), "package_manifest": manifest,
            "tarball": provenance["source_url"], "integrity": integrity, "tarball_sha256": digest,
            "distribution_kind": "official-vendor-tarball", "local_path": relative,
            "provenance_path": provenance_path.relative_to(root.resolve()).as_posix(),
            "provenance_sha256": hashlib.sha256(provenance_path.read_bytes()).hexdigest(),
            "provenance": "Reviewed official vendor bytes; local hash and lock verified; archive never executed"}


def validate_declared(root):
    """Pre-install check requires only Python stdlib, not installed npm parsers."""
    found = []
    manifests = [root / "package.json", *root.glob("apps/*/package.json"), *root.glob("packages/*/package.json")]
    for manifest_path in manifests:
        manifest = json.loads(manifest_path.read_text(encoding="utf8"), object_pairs_hook=unique_object)
        for group in ["dependencies", "optionalDependencies", "devDependencies"]:
            for name, spec in manifest.get(group, {}).items():
                if not spec.startswith("file:"):
                    continue
                path = local_path(root, spec, manifest_path.parent)
                provenance_path = path.with_suffix(".provenance.json")
                if not provenance_path.is_file():
                    raise PolicyError("Vendor provenance missing")
                provenance = json.loads(provenance_path.read_text(encoding="utf8"), object_pairs_hook=unique_object)
                key = name + "@file:" + path.relative_to(root.resolve()).as_posix()
                found.append(vendor_evidence(root, key, {"resolution": {"integrity": provenance.get("integrity"), "tarball": key.rsplit("@", 1)[1]}}))
    return found


def source_inputs(root, lock):
    root = root.resolve()
    paths = {"pnpm-lock.yaml", "backend/go.mod", "backend/go.sum"}
    paths.update(str(p.relative_to(root)).replace("\\", "/") for p in
                 [root / "package.json", *root.glob("apps/*/package.json"), *root.glob("packages/*/package.json")])
    for workspace, importer in lock["importers"].items():
        workspace_root = (root / workspace).resolve()
        if not workspace_root.is_relative_to(root):
            raise PolicyError("Workspace manifest escapes repository")
        declared = json.loads((workspace_root / "package.json").read_text(encoding="utf8"))
        for group in ["dependencies", "optionalDependencies", "devDependencies"]:
            for name, spec in importer.get(group, {}).items():
                locator = spec["version"].split("(")[0]
                if not locator.startswith("file:"):
                    continue
                if declared.get(group, {}).get(name) != spec["specifier"]:
                    raise PolicyError("Vendor workspace declaration conflicts with lockfile")
                if local_path(root, spec["specifier"], workspace_root) != local_path(root, locator):
                    raise PolicyError("Vendor workspace and locked paths differ")
                if name + "@" + locator not in lock["packages"]:
                    raise PolicyError("Vendor workspace component missing from lockfile")
    for key, package in lock["packages"].items():
        if key.rsplit("@", 1)[1].startswith("file:"):
            evidence = vendor_evidence(root, key, package)
            paths.update([evidence["local_path"], evidence["provenance_path"]])
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sorted(paths)}


def changed_components(old_packages, components, old_provenance_hashes=None):
    """A changed distribution/digest is a dependency change even at the same version."""
    changed = []
    for component in components:
        previous = old_packages.get(component["key"])
        if (previous is None or previous.get("resolution", {}).get("integrity") != component["integrity"]
                or component.get("provenance_path") and (old_provenance_hashes or {}).get(component["provenance_path"]) != component["provenance_sha256"]):
            changed.append(component)
    return changed


if __name__ == "__main__":
    try:
        entries = validate_declared(ROOT)
        print(json.dumps({"vendor_preinstall": "pass", "components": [{k: x[k] for k in ["name", "version", "local_path", "tarball_sha256"]} for x in entries]}))
    except (PolicyError, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"vendor_preinstall": "fail", "reason": str(error) if isinstance(error, PolicyError) else type(error).__name__}))
        sys.exit(2)
