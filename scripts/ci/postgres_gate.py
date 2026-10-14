#!/usr/bin/env python3
"""Mandatory synthetic PostgreSQL gates. No application environment or DSN input.

Hosted: python3 scripts/ci/postgres_gate.py --output artifacts/postgres/result.json
Local: add --runtime native --pg-bin <18.3/bin> --no-race if CGO is unavailable.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "public.ecr.aws/docker/library/postgres:18.3"  # official image via AWS mirror (no Docker Hub anonymous pull limits)
PACKAGE = "github.com/mandalika/pos-backend/internal/handlers"
GATES = (
    ("S0C", "TestSaleInputPostgres", 56439, "s0c"),
    ("S0D", "TestShiftDecodePostgres", 56440, "s0d"),
    ("BE", "TestBatchEnvelopePostgres", 56441, "be"),
    ("LF", "TestLinkedFulfillmentPostgres", 56442, "lf"),
    ("A26", "TestPaginationPostgres", 56443, "a26"),
    ("A27", "TestReportSummaryPostgres", 56444, "a27"),
    ("TR", "TestTransferConcurrencyPostgres", 56445, "tr"),
    ("OR", "TestOperationReceiptsPostgres", 56446, "or"),
    ("TD", "TestTenderRulesPostgres", 56447, "td"),
    ("EV", "TestCaptureEnvelopePostgres", 56448, "ev"),
    ("RF", "TestRefundParityPostgres", 56449, "rf"),
    ("RV", "TestSyncReviewPostgres", 56450, "rv"),
    ("SC", "TestStockCountPostgres", 56451, "sc"),
    ("SO", "TestShiftOwnershipPostgres", 56453, "so"),
    ("LO", "TestLockOrderPostgres", 56454, "lo"),
)
TABLES = "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"


class GateError(RuntimeError):
    pass


def sanitize(text: str, password: str = "") -> str:
    if password:
        text = text.replace(password, "[REDACTED]")
    text = re.sub(r"postgres(?:ql)?://[^\s\"']+", "[REDACTED_DSN]", text)
    return re.sub(r"(?i)(password\s*=\s*)(?:'[^']*'|\S+)", r"\1[REDACTED]", text)


def clean_env() -> dict[str, str]:
    # No inherited fixture variables (including optional output paths), libpq
    # defaults, Go flags/overlay, or application DB settings may select a target.
    return {k: v for k, v in os.environ.items() if not (
        k.upper().startswith(("PG", "MANDALIKA_", "POSTGRES", "DATABASE_"))
        or k.upper() in ("GOFLAGS", "GOENV")
    )} | {"GOENV": "off"}


def command(args: list[str], *, env: dict | None = None, timeout: float = 30,
            cwd: Path = ROOT) -> subprocess.CompletedProcess:
    """Bound the entire owned process tree, including a hung go-test binary."""
    opts = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
            if os.name == "nt" else {"start_new_session": True})
    # A daemon started by pg_ctl can inherit pipe handles on Windows. Wait for
    # the launcher process, not pipe EOF from its long-lived child.
    with tempfile.TemporaryFile() as output:
        p = subprocess.Popen(args, cwd=cwd, env=env or clean_env(), stdout=output,
                             stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **opts)
        try:
            p.wait(timeout=timeout)
        except BaseException:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                               capture_output=True, timeout=15, check=False)
            else:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            p.wait(timeout=15)
            raise
        output.seek(0)
        out = output.read().decode("utf-8", errors="replace")
    return subprocess.CompletedProcess(args, p.returncode, out)


def checked(args: list[str], **kwargs) -> str:
    result = command(args, **kwargs)
    if result.returncode:
        raise GateError(f"{Path(args[0]).name} exit {result.returncode}: {result.stdout[-6000:]}")
    return result.stdout.strip()


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", port)) == 0


def named_result(raw: str, name: str, exit_code: int) -> dict:
    """Exit zero/no-tests-to-run/skip are never evidence of a named PASS."""
    events = []
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue  # compiler output is allowed, but cannot establish success
        if isinstance(event, dict) and event.get("Package") == PACKAGE:
            events.append(event)
    named = [e["Action"] for e in events if e.get("Test") == name]
    bad = [e.get("Test", "<package>") for e in events if e.get("Action") in ("skip", "fail")]
    passed = [e["Test"] for e in events if e.get("Action") == "pass" and e.get("Test")]
    package_pass = any(e.get("Action") == "pass" and not e.get("Test") for e in events)
    ok = exit_code == 0 and named.count("run") == 1 and named.count("pass") == 1 and not bad and package_pass
    return {"status": "pass" if ok else "fail", "exit_code": exit_code,
            "named_actions": named, "passed_tests": passed, "failed_or_skipped": bad,
            "package_pass": package_pass}


class Fixture:
    def __init__(self, args, gate, evidence):
        self.args, self.gate, self.evidence = args, gate, evidence
        self.prefix, self.test, self.port, short = gate
        self.user, self.database = f"{short}_test", f"mandalika_{short}_synthetic"
        self.password, self.nonce = secrets.token_hex(24), uuid.uuid4().hex
        self.env = clean_env() | {"PGPASSWORD": self.password, "PGCONNECT_TIMEOUT": "2"}
        self.directory: Path | None = None
        self.container = f"mandalika-pg-ci-{self.nonce}"
        self.data_dir = f"/var/lib/postgresql/18/a34b-{self.nonce}"
        self.created = False
        self.evidence.update(host="127.0.0.1", port=self.port, database=self.database,
                             user=self.user, fixture_id=self.nonce, cleanup="not-started")

    def binary(self, name):
        return str(Path(self.args.pg_bin) / (name + (".exe" if os.name == "nt" else "")))

    def sql(self, query, timeout=5):
        if self.args.runtime == "docker":
            cmd = ["docker", "exec", "--env", "PGPASSWORD", self.container, "psql"]
            port = 5432
        else:
            cmd, port = [self.binary("psql")], self.port
        return checked(cmd + ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-At", "-h", "127.0.0.1",
                              "-p", str(port), "-U", self.user, "-d", self.database, "-c", query],
                       env=self.env, timeout=timeout)

    def start(self):
        if port_open(self.port):
            raise GateError("expected fixture port already occupied; no existing target used")
        if self.args.runtime == "docker":
            self.created = True  # cleanup by unique owned name even if create response is lost
            env = clean_env() | {"POSTGRES_PASSWORD": self.password}
            checked(["docker", "create", "--name", self.container, "--label", f"mandalika-ci={self.nonce}",
                     "--publish", f"127.0.0.1:{self.port}:5432", "--mount", "type=tmpfs,destination=/var/lib/postgresql",
                     "--env", "POSTGRES_PASSWORD", "--env", f"POSTGRES_USER={self.user}",
                     "--env", f"POSTGRES_DB={self.database}", "--env", f"PGDATA={self.data_dir}",
                     "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256",
                     self.args.image_id], env=env, timeout=60)
            details = json.loads(checked(["docker", "inspect", "--format",
                '{{json .Id}}', self.container]))
            self.evidence["container_id"] = details
            bindings = json.loads(checked(["docker", "inspect", "--format", '{{json .HostConfig.PortBindings}}', self.container]))
            if bindings != {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(self.port)}]}:
                raise GateError("unexpected container port bindings")
            checked(["docker", "start", self.container], timeout=30)
        else:
            self.directory = Path(tempfile.mkdtemp(prefix="mandalika-pg-ci-")).resolve()
            (self.directory / "owner").write_text(self.nonce, encoding="ascii")
            self.created = True
            self.data_dir = str(self.directory / "data")
            pwfile = self.directory / "password"
            pwfile.write_text(self.password, encoding="ascii")
            pwfile.chmod(0o600)
            try:
                checked([self.binary("initdb"), "-D", self.data_dir, "-U", self.user,
                         "--pwfile", str(pwfile), "--auth=scram-sha-256", "--encoding=UTF8", "--no-locale"], timeout=60)
            finally:
                pwfile.unlink(missing_ok=True)
            with (Path(self.data_dir) / "postgresql.conf").open("a", encoding="utf-8") as f:
                f.write(f"\nlisten_addresses='127.0.0.1'\nport={self.port}\ntimezone='UTC'\n")
            checked([self.binary("pg_ctl"), "-D", self.data_dir, "-l", str(self.directory / "server.log"), "-W", "start"])
        self.evidence["expected_data_directory"] = self.data_dir

    def ready(self):
        end = time.monotonic() + self.args.ready_timeout
        # Native initdb creates 'postgres'; create only our exact synthetic DB.
        target_db = self.database
        if self.args.runtime == "native":
            self.database = "postgres"
        try:
            while True:
                try:
                    if self.sql("SELECT 1", timeout=min(3, max(0.1, end - time.monotonic()))) == "1":
                        break
                except (GateError, subprocess.TimeoutExpired):
                    pass
                if time.monotonic() >= end:
                    raise GateError("readiness deadline exceeded")
                time.sleep(min(0.25, max(0, end - time.monotonic())))
            if self.args.runtime == "native":
                self.sql(f'CREATE DATABASE "{target_db}"', timeout=10)
        finally:
            self.database = target_db

    def identify(self):
        actual = self.sql("SELECT current_database(), current_user, current_setting('server_version_num'), current_setting('data_directory')")
        db, user, version, directory = actual.split("|", 3)
        if (db, user, version) != (self.database, self.user, "180003"):
            raise GateError("database/user/PostgreSQL 18.3 identity mismatch")
        if not directory or os.path.normcase(os.path.normpath(directory)) != os.path.normcase(os.path.normpath(self.data_dir)):
            raise GateError("SHOW data_directory identity mismatch")
        # Explicit SHOW independently retains the same identity contract as Go.
        if self.sql("SHOW data_directory") != directory:
            raise GateError("unstable data_directory identity")
        tables = int(self.sql(TABLES))
        if tables != 0:
            raise GateError("fixture public schema is not empty")
        self.evidence.update(actual_data_directory=directory, server_version_num=version,
                             public_tables_before=tables, identity="verified")

    def test_env(self):
        # Generated only here, from fixed constants; never printed or serialized.
        dsn = f"postgres://{self.user}:{self.password}@127.0.0.1:{self.port}/{self.database}?sslmode=disable"
        return clean_env() | {f"MANDALIKA_{self.prefix}_TEST_DSN": dsn,
                              f"MANDALIKA_{self.prefix}_TEST_DATA_DIR": self.data_dir}

    def cleanup(self):
        if not self.created:
            self.evidence["cleanup"] = "not-created"
            return
        if self.args.runtime == "docker":
            ids = checked(["docker", "ps", "-a", "--filter", f"name=^/{self.container}$", "--format", "{{.ID}}"])
            if ids:
                owner = checked(["docker", "inspect", "--format", '{{index .Config.Labels "mandalika-ci"}}', self.container])
                if owner != self.nonce:
                    raise GateError("cleanup container ownership uncertain")
                checked(["docker", "rm", "--force", "--volumes", self.container], timeout=30)
            if checked(["docker", "ps", "-a", "--filter", f"name=^/{self.container}$", "--format", "{{.ID}}"]):
                raise GateError("fixture container survived removal")
        else:
            directory = self.directory
            if (directory is None or directory.parent != Path(tempfile.gettempdir()).resolve()
                    or not directory.name.startswith("mandalika-pg-ci-")
                    or directory.is_symlink() or (directory / "owner").read_text() != self.nonce):
                raise GateError("cleanup directory ownership uncertain")
            if (Path(self.data_dir) / "postmaster.pid").exists():
                checked([self.binary("pg_ctl"), "-D", self.data_dir, "-w", "-t", "20", "-m", "fast", "stop"], timeout=25)
            if (Path(self.data_dir) / "postmaster.pid").exists() or port_open(self.port):
                raise GateError("fixture stop not confirmed; owned files retained")
            # Only the exact newly-created owned root; never historical fixtures.
            shutil.rmtree(directory)
            if directory.exists():
                raise GateError("fixture files survived removal")
        if port_open(self.port):
            raise GateError("fixture port still occupied after teardown")
        self.evidence["cleanup"] = "removed-and-port-closed"


def save(path: Path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def run(args) -> int:
    report = {"schema_version": 1, "runtime": args.runtime, "race": not args.no_race,
              "expected_gates": [g[1] for g in GATES], "gates": [], "status": "running"}
    started = time.monotonic()
    save(args.output, report)
    try:
        report["go_version"] = checked(["go", "version"])
        if args.runtime == "docker":
            report["docker_version"] = checked(["docker", "version", "--format", "{{.Server.Version}}"])
            checked(["docker", "pull", IMAGE], timeout=180)
            report["image"] = json.loads(checked(["docker", "image", "inspect", "--format",
                '{"id":{{json .Id}},"digests":{{json .RepoDigests}}}', IMAGE]))
            args.image_id = report["image"]["id"]
        else:
            if not args.pg_bin:
                raise GateError("native runtime requires explicit --pg-bin")
            for name in ("postgres", "initdb", "pg_ctl", "psql"):
                binary = str(Path(args.pg_bin) / (name + (".exe" if os.name == "nt" else "")))
                version = checked([binary, "--version"])
                if not re.search(r"\b18\.3\b", version):
                    raise GateError("native runtime must be PostgreSQL 18.3")
            report["postgres_version"] = version
        for gate in GATES:
            item = {"gate": gate[0], "test": gate[1], "stage": "start", "status": "running"}
            report["gates"].append(item)
            fixture = Fixture(args, gate, item)
            t0 = time.monotonic()
            try:
                fixture.start()
                item["stage"] = "readiness"
                fixture.ready()
                item["stage"] = "identity"
                fixture.identify()
                item["stage"] = "test"
                cmd = ["go", "test", "-mod=readonly", "./internal/handlers", "-run", f"^{gate[1]}$",
                       "-count=1", "-json", f"-timeout={args.test_timeout}s"]
                if not args.no_race:
                    cmd.append("-race")
                item["command"], item["cwd"] = cmd, str(ROOT / "backend")
                save(args.output, report)
                result = command(cmd, env=fixture.test_env(), timeout=args.test_timeout + 60, cwd=ROOT / "backend")
                item["result"] = named_result(result.stdout, gate[1], result.returncode)
                log = args.output.parent / f"{gate[0]}.go-test.jsonl"
                log.write_text(sanitize(result.stdout, fixture.password), encoding="utf-8")
                item["log"] = log.name
                item["public_tables_after"] = int(fixture.sql(TABLES))
                if item["result"]["status"] != "pass":
                    raise GateError("named integration test did not PASS without skips/failures")
                item["status"] = "pass"
            except (Exception, KeyboardInterrupt) as exc:
                item.update(status="fail", error=sanitize(str(exc), fixture.password))
            finally:
                try:
                    fixture.cleanup()
                except (Exception, KeyboardInterrupt) as exc:
                    item.update(status="fail", cleanup="uncertain", cleanup_error=sanitize(str(exc), fixture.password))
                item["duration_seconds"] = round(time.monotonic() - t0, 3)
                save(args.output, report)
            print(f"{gate[1]}: {item['status']}; cleanup={item['cleanup']}", flush=True)
            if item["status"] != "pass":
                raise GateError(f"{gate[1]} failed at {item['stage']}; see sanitized lifecycle evidence")
        report["status"] = "pass"
    except (Exception, KeyboardInterrupt) as exc:
        report.update(status="fail", error=sanitize(str(exc)))
    finally:
        report["duration_seconds"] = round(time.monotonic() - started, 3)
        save(args.output, report)
    print(f"PostgreSQL gate: {report['status']}; evidence={args.output}", flush=True)
    return 0 if report["status"] == "pass" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", choices=("docker", "native"), default="docker")
    parser.add_argument("--pg-bin", help="Explicit native PostgreSQL 18.3 bin directory")
    parser.add_argument("--no-race", action="store_true", help="Explicit local-only concession; hosted CI uses race")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ready-timeout", type=int, default=45)
    parser.add_argument("--test-timeout", type=int, default=180)
    args = parser.parse_args()
    if not 1 <= args.ready_timeout <= 120 or not 1 <= args.test_timeout <= 600:
        parser.error("timeouts must be bounded: readiness 1..120, test 1..600 seconds")
    def interrupted(*_):
        raise KeyboardInterrupt("termination requested")
    signal.signal(signal.SIGTERM, interrupted)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
