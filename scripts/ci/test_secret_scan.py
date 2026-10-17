"""Unit tests for secret_scan.py. Fixtures are assembled at runtime so this file holds no secret-shaped literal."""
import contextlib
import io
import os
import subprocess
import tempfile
import unittest

import secret_scan

# Distinctive marker embedded in every fake secret; must never appear in scanner output.
MARK = "Zq7" + "Kd9" + "Lm2"
PW = MARK + "Xp4Rt8"  # 15-char fake password
JWT = "eyJ" + "hbGciOiJI" + "." + "eyJ" + "zdWIiOiIx" + "MjM0" + "." + "sig" + "natureAbc" + "123"


def make_repo(files):
    d = tempfile.mkdtemp(prefix="secscan-")

    def run(*a):
        subprocess.run(["git", *a], cwd=d, check=True, capture_output=True)

    run("init", "-q")
    run("config", "user.email", "t@example.com")
    run("config", "user.name", "t")
    for rel, content in files.items():
        full = os.path.join(d, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as fh:
            fh.write(content if isinstance(content, bytes) else content.encode())
    run("add", "-f", "-A")
    run("commit", "-q", "-m", "x")
    return d


def run_scan(files, allowlist_text=None):
    d = make_repo(files)
    al = os.path.join(d, "al.txt")
    with open(al, "w", encoding="utf-8") as fh:
        fh.write(allowlist_text or "")
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = secret_scan.main(["--root", d, "--allowlist", al])
    return code, out.getvalue()


def rules_of(output):
    return {ln.rsplit(": ", 1)[1] for ln in output.splitlines()
            if ": " in ln and not ln.startswith("secret-scan")}


class RuleTests(unittest.TestCase):
    def assertFires(self, rule, name, content):
        code, out = run_scan({name: content})
        self.assertEqual(code, 1, out)
        self.assertIn(rule, rules_of(out))
        self.assertIn(f"{name}:1: {rule}", out)
        self.assertNotIn(MARK, out)

    def assertClean(self, name, content):
        code, out = run_scan({name: content})
        self.assertEqual((code, rules_of(out)), (0, set()), out)

    def test_db_url_fires(self):
        for scheme in ("postgres", "postgresql", "mysql", "mongodb", "redis", "rediss", "amqp"):
            self.assertFires("db-url-password", "a.txt", f"U={scheme}://app:{PW}@db.neon.tech/x\n")

    def test_db_url_placeholders_clean(self):
        for url in ("postgres://u:password@db.neon.tech/x", "postgres://u:changeme1@db.neon.tech/x",
                    "postgres://u:<pw>@db.neon.tech/x", "postgres://u:${DB_PW}@db.neon.tech/x",
                    "postgres://u:$DB_PW@db.neon.tech/x", "postgres://u:{self.password}@db.neon.tech/x",
                    f"postgres://u:{PW}@localhost/x", f"postgres://u:{PW}@127.0.0.1:5432/x",
                    f"postgres://u:{PW}@0.0.0.0/x", f"postgres://u:{PW}@db.invalid/x",
                    f"postgres://u:{PW}@example.com/x", "postgres://u:p@db.neon.tech/x",
                    "postgres://mandalika:mandalika@db.neon.tech/x", "postgres://u:xxxxxxxx@db.neon.tech/x"):
            self.assertClean("a.txt", url + "\n")

    def test_password_assignment_fires(self):
        for name in ("SEED_ADMIN_PASSWORD", "ADMIN_PASSWORD", "DB_PASSWORD"):
            self.assertFires("password-assignment", "a.txt", f"{name}={PW}\n")
        self.assertFires("password-assignment", "a.yml", f"DB_PASSWORD: {PW}\n")
        self.assertFires("password-assignment", "a.json", 'Bash(export SEED_ADMIN_PASSWORD="' + PW + '")\n')

    def test_password_assignment_placeholders_clean(self):
        for line in ("DB_PASSWORD=short", "DB_PASSWORD=<from gen-secrets>", "DB_PASSWORD=${DB_PASSWORD}",
                     "DB_PASSWORD=$DB_PASSWORD", "DB_PASSWORD=change-me-now", "DB_PASSWORD=changeme123",
                     "SEED_ADMIN_PASSWORD=SEED_ADMIN_PASSWORD:latest",
                     'X = {"PGPASSWORD": self.password}',
                     "DB_PASSWORD=your-password-here", "DB_PASSWORD=password"):
            self.assertClean("a.txt", line + "\n")

    def test_token_rules_fire(self):
        cases = {
            "private-key": "-----BEGIN " + "RSA PRIVATE KEY-----",
            "jwt-token": "t=" + JWT,
            "aws-access-key": "k=" + "AKIA" + "ABCDEFGH12345678",
            "github-token": "t=" + "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
            "google-api-key": "k=" + "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
            "slack-token": "t=" + "xoxb-" + "1234567890-abcdefABCDEF",
            "sentry-dsn": "d=https://" + "0123456789abcdef0123456789abcdef" + "@o1.ingest.sentry.io/123",
        }
        for rule, content in cases.items():
            with self.subTest(rule=rule):
                self.assertFires(rule, "a.txt", content + "\n")

    def test_token_lookalikes_clean(self):
        self.assertClean("a.txt", "eyJ.eyJ.x AKIA-short ghp_short xoxb-1 AIza-short\n")

    def test_forbidden_files(self):
        for name in (".claude/settings.local.json", ".env", ".env.production", "app/.env.local", "a.jks",
                     "k.keystore", "x.pem", "y.p12", "id_rsa", "id_rsa.pub"):
            code, out = run_scan({name: "harmless\n"})
            self.assertEqual(code, 1, name)
            self.assertIn(f"{name}: forbidden-file", out)
        for name in (".env.example", ".env.sample", "backend/.env.production.example", "README.md"):
            self.assertEqual(run_scan({name: "harmless\n"})[0], 0, name)

    def test_lockfiles_binaries_and_large_files_skipped(self):
        line = f"DB_PASSWORD={PW}\n"
        code, out = run_scan({"pnpm-lock.yaml": line, "bin.dat": b"\0\0" + line.encode(),
                              "big.txt": line + "a" * (2 * 1024 * 1024 + 1)})
        self.assertEqual(code, 0, out)

    def test_never_prints_value(self):
        code, out = run_scan({"a.txt": f"DB_PASSWORD={PW}\nU=postgres://app:{PW}@db.neon.tech/x\nt={JWT}\n"})
        self.assertEqual(code, 1)
        for needle in (MARK, PW, "hbGciOiJI", "MjM0", "neon.tech"):
            self.assertNotIn(needle, out)

    def test_rev_scans_old_tree(self):
        d = make_repo({"a.txt": f"DB_PASSWORD={PW}\n"})
        subprocess.run(["git", "rm", "-q", "a.txt"], cwd=d, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "rm"], cwd=d, check=True)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            self.assertEqual(secret_scan.main(["--root", d, "--allowlist", os.devnull]), 0)
            self.assertEqual(secret_scan.main(["--root", d, "--allowlist", os.devnull, "--rev", "HEAD~1"]), 1)
        self.assertNotIn(MARK, out.getvalue())


class AllowlistTests(unittest.TestCase):
    FILES = {"fixtures/a.txt": f"DB_PASSWORD={PW}\n", "other/b.txt": f"DB_PASSWORD={PW}\n"}

    def test_allowlist_suppresses_only_matching_path_and_rule(self):
        code, out = run_scan(self.FILES, "fixtures/* | password-assignment | synthetic test fixture\n")
        self.assertEqual(code, 1)
        self.assertIn("other/b.txt:1: password-assignment", out)
        self.assertNotIn("fixtures/a.txt", out)
        code, out = run_scan(self.FILES, "fixtures/* | jwt-token | wrong rule\n")
        self.assertIn("fixtures/a.txt:1: password-assignment", out)

    def test_allowlist_can_whitelist_forbidden_file(self):
        code, _ = run_scan({"k.pem": "x\n"}, "k.pem | forbidden-file | public test certificate\n")
        self.assertEqual(code, 0)

    def test_allowlist_requires_reason(self):
        for bad in ("fixtures/* | password-assignment\n", "fixtures/* | password-assignment | \n"):
            with self.assertRaises(SystemExit):
                run_scan(self.FILES, bad)

    def test_comments_and_blank_lines_ignored(self):
        code, _ = run_scan({"ok.txt": "hi\n"}, "# comment\n\n")
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
