#!/usr/bin/env python3
"""Tracked-file secret scan. Prints file:line and rule NAME only, never a matched value.

Usage: python scripts/ci/secret_scan.py [--rev <commit>] [--allowlist <file>]
Exit 0 = clean, 1 = findings, 2 = usage/allowlist error.
"""
import argparse
import fnmatch
import os
import re
import subprocess
import sys

MAX_BYTES = 2 * 1024 * 1024
SKIP_NAMES = {"pnpm-lock.yaml", "package-lock.json", "yarn.lock", "go.sum", "Cargo.lock", "poetry.lock"}
DEFAULT_ALLOWLIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "secret_scan.allowlist")

# Tracked paths that must never exist (rule: forbidden-file).
FORBIDDEN_PATTERNS = [
    ".claude/settings.local.json", ".env", ".env.*", "*.jks", "*.keystore", "*.pem", "*.p12", "id_rsa*",
]
FORBIDDEN_EXCEPT = {".env.example", ".env.sample"}

DB_URL = re.compile(r"\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp)://([^\s:/@'\"`]+):([^\s@/'\"`]+)@([^\s:/?#'\"`]+)", re.I)
PASSWORD_ASSIGN = re.compile(r"\b([A-Z][A-Z0-9_]*PASSWORD)\b[\"']?\s*[=:]\s*[\"']?([^\s\"'`#,;)}\]]+)")
PRIVATE_KEY = re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----")
JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{7,}\.eyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}")
AWS_KEY = re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")
GITHUB_TOKEN = re.compile(r"\b(?:gh[pos]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})")
GOOGLE_KEY = re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")
SLACK_TOKEN = re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}")
SENTRY_DSN = re.compile(r"https://[0-9a-f]{16,}(?::[^@\s]*)?@[\w.-]*sentry[\w.-]*/\d+", re.I)

SIMPLE_RULES = [
    ("private-key", PRIVATE_KEY), ("jwt-token", JWT), ("aws-access-key", AWS_KEY),
    ("github-token", GITHUB_TOKEN), ("google-api-key", GOOGLE_KEY), ("slack-token", SLACK_TOKEN),
    ("sentry-dsn", SENTRY_DSN),
]

PLACEHOLDER_WORDS = {"password", "pass", "postgres", "secret", "test", "example", "dummy", "placeholder",
                     "changeme", "change-me", "admin", "root", "user", "mandalika"}
PLACEHOLDER_PREFIXES = ("changeme", "change-me", "change_me", "xxxx", "your", "example", "placeholder", "dummy", "redacted", "***", "...")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def is_placeholder_secret(value):
    v = value.strip()
    low = v.lower()
    if len(v) < 4:  # u:p / x:x style fixtures; not a credible secret
        return True
    if v[0] in "<$%{" or v.startswith(("{{", "${")) or "${" in v or low.startswith("$"):
        return True
    if low in PLACEHOLDER_WORDS or low.startswith(PLACEHOLDER_PREFIXES):
        return True
    return False


def is_reference(value):
    """Env-var names (secret refs like FOO_PASSWORD:latest) and code expressions, not literals."""
    if re.fullmatch(r"[A-Z][A-Z0-9_]*(?::\w+)?", value):
        return True
    return value.endswith("(") or bool(re.match(r"(?:self|this|os|process|secrets|env|args|opts|config|cfg)\b[.\[]", value))


def is_placeholder_host(host):
    h = host.lower().strip("[]")
    return (h in LOCAL_HOSTS or h.endswith(".invalid") or h.startswith("example.")
            or h.endswith(".example") or h.endswith(".example.com") or h.startswith(("{", "$", "<")))


def scan_text(text):
    """Yield (line_number, rule) for each finding. Never yields values."""
    for n, line in enumerate(text.splitlines(), 1):
        if len(line) > 4000:
            line = line[:4000]
        for m in DB_URL.finditer(line):
            if not (is_placeholder_secret(m.group(2)) or is_placeholder_host(m.group(3))):
                yield n, "db-url-password"
        for m in PASSWORD_ASSIGN.finditer(line):
            val = m.group(2)
            if len(val) >= 8 and not is_placeholder_secret(val) and not is_reference(val):
                yield n, "password-assignment"
        for rule, rx in SIMPLE_RULES:
            if rx.search(line):
                yield n, rule


def forbidden(path):
    base = path.rsplit("/", 1)[-1]
    if base in FORBIDDEN_EXCEPT or (base.startswith(".env.") and base.endswith((".example", ".sample"))):
        return False
    for pat in FORBIDDEN_PATTERNS:
        if "/" in pat:
            if path == pat:
                return True
        elif fnmatch.fnmatch(base, pat):
            return True
    return False


def load_allowlist(path):
    entries = []
    if not os.path.exists(path):
        return entries
    with open(path, encoding="utf-8") as fh:
        for n, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|", 2)]
            if len(parts) != 3 or not all(parts):
                raise SystemExit(f"{path}:{n}: allowlist entry must be 'path | rule | reason' with a reason")
            entries.append((parts[0], parts[1]))
    return entries


def allowed(entries, path, rule):
    return any(rule == r and fnmatch.fnmatch(path, p) for p, r in entries)


def git(args, root, text=False):
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=text).stdout


def list_files(root, rev):
    if rev:
        out = git(["ls-tree", "-r", "-z", "--name-only", rev], root)
    else:
        out = git(["ls-files", "-z"], root)
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


def read_blobs(root, rev, paths):
    """Yield (path, bytes|None); None means unreadable/too large."""
    if rev:
        for p in paths:
            try:
                data = git(["show", f"{rev}:{p}"], root)
            except subprocess.CalledProcessError:
                data = None
            yield p, data
        return
    for p in paths:
        full = os.path.join(root, p)
        try:
            with open(full, "rb") as fh:
                yield p, fh.read()
        except OSError:
            yield p, None


def scan(root, rev=None, allowlist=DEFAULT_ALLOWLIST):
    entries = load_allowlist(allowlist)
    findings = []
    paths = list_files(root, rev)
    for p in paths:
        if forbidden(p) and not allowed(entries, p, "forbidden-file"):
            findings.append((p, 0, "forbidden-file"))
    scannable = [p for p in paths if p.rsplit("/", 1)[-1] not in SKIP_NAMES]
    for p, data in read_blobs(root, rev, scannable):
        if data is None or len(data) > MAX_BYTES or b"\0" in data[:8192]:
            continue
        for n, rule in scan_text(data.decode("utf-8", "replace")):
            if not allowed(entries, p, rule):
                findings.append((p, n, rule))
    return sorted(set(findings))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rev", help="scan this commit's tree instead of the index")
    ap.add_argument("--allowlist", default=DEFAULT_ALLOWLIST)
    ap.add_argument("--root", default=".", help="repository root (default: cwd)")
    args = ap.parse_args(argv)
    findings = scan(os.path.abspath(args.root), args.rev, args.allowlist)
    for path, line, rule in findings:
        print(f"{path}:{line}: {rule}" if line else f"{path}: {rule}")
    if findings:
        counts = {}
        for _, _, r in findings:
            counts[r] = counts.get(r, 0) + 1
        print("secret-scan FAILED: " + ", ".join(f"{r}={c}" for r, c in sorted(counts.items())), file=sys.stderr)
        return 1
    print("secret-scan OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
