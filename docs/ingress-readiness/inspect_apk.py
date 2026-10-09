"""Read selected APK metadata only; never execute, extract or infer installed fleet."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from urllib.parse import urlsplit
import zipfile


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def strict_json(raw):
    def invalid_constant(_):
        raise ValueError("non-finite JSON constant")
    return json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)


def safe_url(value):
    if value is None:
        return None
    if not isinstance(value, str) or any(ord(c) < 33 for c in value):
        raise ValueError("invalid URL type or whitespace")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("invalid absolute HTTP URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("credential/query-bearing URL withheld")
    return value


def inspect(path):
    path = Path(path)
    if path.stat().st_size > 64 * 1024 * 1024:
        raise ValueError("APK exceeds 64 MiB read bound")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(names) > 5000 or len(set(names)) != len(names):
            raise ValueError("duplicate members or excessive member count")
        if sum(entry.file_size for entry in entries) > 256 * 1024 * 1024:
            raise ValueError("archive exceeds uncompressed bound")
        for entry in entries:
            name = entry.orig_filename  # Inspect raw spelling before zipfile normalizes Windows paths.
            if "\x00" in name or "\\" in name or ":" in name or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
                raise ValueError("unsafe archive member path")
        config_name = "assets/capacitor.config.json"
        if config_name not in names:
            raise ValueError("required Capacitor config missing")
        if archive.getinfo(config_name).file_size > 65536:
            raise ValueError("config exceeds bound")
        config = strict_json(archive.read(config_name))
        if not isinstance(config, dict) or not isinstance(config.get("appId"), str):
            raise ValueError("invalid Capacitor app identity")
        plugins = config.get("plugins", {})
        if not isinstance(plugins, dict):
            raise ValueError("invalid plugins object")
        updater = plugins.get("CapacitorUpdater", {})
        if not isinstance(updater, dict):
            raise ValueError("invalid updater object")
        flags = {}
        for key in ("autoUpdate", "allowModifyUrl", "persistModifyUrl"):
            value = updater.get(key)
            if key in updater and not isinstance(value, bool):
                raise ValueError("invalid updater flag")
            flags[key] = {"present": key in updater, "value": value}
        url = safe_url(updater.get("updateUrl"))
        scripts, consumed = [], 0
        for entry in entries:
            if not entry.filename.startswith("assets/public/assets/") or not entry.filename.endswith(".js"):
                continue
            consumed += entry.file_size
            if entry.file_size > 8 * 1024 * 1024 or consumed > 24 * 1024 * 1024:
                raise ValueError("selected JavaScript exceeds bound")
            raw = archive.read(entry)
            text = raw.decode("utf-8")
            origins = set()
            for match in re.finditer(r'https?://[^\s"\'<>`\\]+', text):
                parsed = urlsplit(match.group())
                if parsed.username or parsed.password:
                    raise ValueError("credential-bearing JavaScript URL withheld")
                if parsed.hostname:
                    origins.add(parsed.scheme + "://" + parsed.netloc)
            scripts.append({"member": entry.filename, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "literal_origin_candidates": sorted(origins)})
        return {"artifact_sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size,
                "evidence_class": "artifact-contained", "app_id": config["appId"],
                "config_sha256": hashlib.sha256(archive.read(config_name)).hexdigest(),
                "updater_present": "CapacitorUpdater" in plugins, "updater_update_url": url,
                "updater_flags": flags, "scripts": scripts,
                "installed_cohort": "unknown", "plugin_binary_version": "unknown",
                "limits": ["Missing flag is unknown; do not substitute current plugin defaults.", "Literal URLs are candidates; an API caller needs separate source correlation.", "No app execution, signing-key inspection or installed-device claim."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("apk")
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.apk), indent=2))
    except (ValueError, OSError, zipfile.BadZipFile, UnicodeError) as error:
        parser.exit(1, type(error).__name__ + ": artifact inspection rejected; no raw content emitted\n")
