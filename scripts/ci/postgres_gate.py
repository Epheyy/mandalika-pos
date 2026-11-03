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
# Official postgres:18.3 pinned by content digest, so every mirror must serve identical bytes.
# Mirrors are tried in order; a quota error ("toomanyrequests") or a hung pull falls through to the next.
# Bump procedure when 18.3 is rebuilt and mirrors drop this digest: pull postgres:18.3, read its
# RepoDigests (`docker image inspect --format '{{json .RepoDigests}}'`), update IMAGE_DIGEST.
IMAGE_DIGEST = "sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db"
IMAGE_MIRRORS = ("mirror.gcr.io/library/postgres", "public.ecr.aws/docker/library/postgres")
PACKAGE = "github.com/mandalika/pos-backend/internal/handlers"
GATES = (
    ("S0C", "TestSaleInputPostgres", 26439, "s0c"),
    ("S0D", "TestShiftDecodePostgres", 26440, "s0d"),
    ("BE", "TestBatchEnvelopePostgres", 26441, "be"),
    ("LF", "TestLinkedFulfillmentPostgres", 26442, "lf"),
    ("A26", "TestPaginationPostgres", 26443, "a26"),
    ("A27", "TestReportSummaryPostgres", 26444, "a27"),
    ("TR", "TestTransferConcurrencyPostgres", 26445, "tr"),
    ("OR", "TestOperationReceiptsPostgres", 26446, "or"),
    ("TD", "TestTenderRulesPostgres", 26447, "td"),
    ("EV", "TestCaptureEnvelopePostgres", 26448, "ev"),
    ("RF", "TestRefundParityPostgres", 26449, "rf"),
    ("RV", "TestSyncReviewPostgres", 26450, "rv"),
    ("SC", "TestStockCountPostgres", 26451, "sc"),
    ("DV", "TestDeviceRegisterPostgres", 26452, "dv"),
    ("SO", "TestShiftOwnershipPostgres", 26453, "so"),
    ("LO", "TestLockOrderPostgres", 26454, "lo"),
    ("AU", "TestAuthAuthorityPostgres", 26455, "au"),
    ("OS", "TestOversellPostgres", 26457, "os"),
    ("IM", "TestCsvImportPostgres", 26456, "im"),
    ("EL", "TestErrorLogsPostgres", 26459, "el"),
    ("PL", "TestPromoLinkedParityPostgres", 26460, "pl"),
    ("QT", "TestQuotedReceiptPostgres", 26461, "qt"),
    ("BD", "TestBusinessDatePostgres", 26462, "bd"),
    ("OC", "TestOfflineCapPostgres", 26463, "oc"),
    ("CP", "TestCustomerPrivacyPostgres", 26464, "cp"),
    ("OF", "TestOfflineReturnPostgres", 26465, "of"),
    ("RA", "TestReceiveApprovalPostgres", 26466, "ra"),
    ("SL", "TestStockLedgerPostgres", 26467, "sl"),
    ("ST", "TestStockSeqPostgres", 26458, "st"),
    ("ER", "TestErpIntegrationPostgres", 26468, "er"),
    ("OB", "TestErpOutboxPostgres", 26470, "ob"),
    ("MV", "TestStockMovementsReadPostgres", 26469, "mv"),
    ("GW", "TestGiveawayPostgres", 26471, "gw"),
    ("AP", "TestInventoryApprovalPostgres", 26472, "ap"),
    ("CV", "TestStockCountCsvPostgres", 26473, "cv"),
    ("RQ", "TestRequisitionPostgres", 26474, "rq"),
    ("CPR", "TestCustomerProfilePostgres", 26475, "cpr"),
    ("RL", "TestRefundLinesPostgres", 26476, "rl"),
    ("SP", "TestSplitTenderPostgres", 26477, "sp"),
    ("LP", "TestListParamsPostgres", 26478, "lp"),
)
# Fixture ports must stay below Linux's default ephemeral range (32768-60999): an earlier test's client socket can
# be assigned a fixed port in that range and sit in TIME-WAIT for ~60 s, failing the next fixture start with
# "expected fixture port already occupied" (cleanup=not-created). Tests pin the same ports (gate_fixture_test.go).
EPHEMERAL_PORT_MIN = 32768
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


def pull_image() -> dict:
    """Pull the digest-pinned image from the first mirror that serves it; refuse any other digest."""
    failures = []
    for mirror in IMAGE_MIRRORS:
        ref = f"{mirror}@{IMAGE_DIGEST}"
        try:
            checked(["docker", "pull", ref], timeout=180)
        except (GateError, subprocess.TimeoutExpired) as e:
            failures.append(f"{mirror}: {str(e)[-300:]}")
            continue
        image = json.loads(checked(["docker", "image", "inspect", "--format",
            '{"id":{{json .Id}},"digests":{{json .RepoDigests}}}', ref]))
        if not any(d.endswith("@" + IMAGE_DIGEST) for d in image.get("digests") or []):
            raise GateError(f"pulled image digest mismatch from {mirror}")
        return image | {"source": ref}
    raise GateError("image pull failed on every mirror: " + " | ".join(failures))


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.25)
        return s.connect_ex(("127.0.0.1", port)) == 0


PORT_WAIT_TRIES = 10
PORT_WAIT_DELAY = 1.0
TAIL_LINES = 80
RETRYABLE_START = ("address already in use", "port is already allocated", "already occupied",
                   "readiness deadline exceeded")


def port_free(port: int) -> bool:
    """Closed to connects AND bindable: a releasing docker proxy can refuse a bind while connects fail."""
    if port_open(port):
        return False
    with socket.socket() as s:
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def port_diagnosis(port: int) -> str:
    """Which check tripped, plus Linux socket state for the port, so a busy-port failure names its holder."""
    parts = [f"connect_open={port_open(port)}"]
    with socket.socket() as s:
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            parts.append("bind=ok")
        except OSError as e:
            parts.append(f"bind={e.errno}")
    if shutil.which("ss"):
        try:
            out = command(["ss", "-tanp", "sport", "=", f":{port}", "or", "dport", "=", f":{port}"], timeout=5).stdout
            parts.append("ss=" + " | ".join(out.strip().splitlines()[:6]))
        except (OSError, subprocess.TimeoutExpired):
            pass
    return "; ".join(parts)


def wait_port_free(port: int, tries: int = PORT_WAIT_TRIES, delay: float = PORT_WAIT_DELAY) -> bool:
    """Bounded wait (tries x delay) for a previous container to release the port."""
    for attempt in range(tries):
        if port_free(port):
            return True
        if attempt < tries - 1:
            time.sleep(delay)
    return port_free(port)


def failure_diagnostics(raw: str, password: str) -> dict:
    """Failing test names and the tail of the go test -json stream, so a CI artifact is self-diagnosing."""
    failed = []
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get("Action") == "fail" and event.get("Test"):
            failed.append(event["Test"])
    tail = chr(10).join(raw.splitlines()[-TAIL_LINES:])
    return {"failed_tests": sorted(set(failed)), "output_tail": sanitize(tail, password)}


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
        # --go-runner docker joins this container's network namespace, so Postgres must listen on the gate port itself.
        self.pg_port = self.port if getattr(args, "go_runner", "host") == "docker" else 5432
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
            port = self.pg_port
        else:
            cmd, port = [self.binary("psql")], self.port
        return checked(cmd + ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-At", "-h", "127.0.0.1",
                              "-p", str(port), "-U", self.user, "-d", self.database, "-c", query],
                       env=self.env, timeout=timeout)

    def start(self):
        if not wait_port_free(self.port):
            raise GateError("expected fixture port already occupied; no existing target used: "
                            + port_diagnosis(self.port))
        if self.args.runtime == "docker":
            self.created = True  # cleanup by unique owned name even if create response is lost
            env = clean_env() | {"POSTGRES_PASSWORD": self.password}
            checked(["docker", "create", "--name", self.container, "--label", f"mandalika-ci={self.nonce}",
                     "--publish", f"127.0.0.1:{self.port}:{self.pg_port}", "--mount", "type=tmpfs,destination=/var/lib/postgresql",
                     "--env", "POSTGRES_PASSWORD", "--env", f"POSTGRES_USER={self.user}",
                     "--env", f"POSTGRES_DB={self.database}", "--env", f"PGDATA={self.data_dir}",
                     "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256",
                     self.args.image_id] + (["-c", f"port={self.pg_port}"] if self.pg_port != 5432 else []), env=env, timeout=60)
            details = json.loads(checked(["docker", "inspect", "--format",
                '{{json .Id}}', self.container]))
            self.evidence["container_id"] = details
            bindings = json.loads(checked(["docker", "inspect", "--format", '{{json .HostConfig.PortBindings}}', self.container]))
            if bindings != {f"{self.pg_port}/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(self.port)}]}:
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

    def test_env(self, host: str = "127.0.0.1"):
        # Generated only here, from fixed constants; never printed or serialized.
        dsn = f"postgres://{self.user}:{self.password}@{host}:{self.port}/{self.database}?sslmode=disable"
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
        if not wait_port_free(self.port):
            raise GateError("fixture port still occupied after teardown: " + port_diagnosis(self.port))
        self.evidence["cleanup"] = "removed-and-port-closed"


def save(path: Path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


GO_IMAGE_DEFAULT = "golang:1.26.10"


def docker_go_cmd(args, go_cmd: list, prefix: str, container: str | None = None) -> list:
    """Run the `go test` command inside the pinned Linux Go image: the race detector needs CGO, which this
    Windows host lacks. The Go container joins the fixture container's network namespace, so the test's
    127.0.0.1:<gate port> guard holds unchanged. The DSN travels as an inherited env NAME, never as a value on
    the command line (the command is saved as evidence)."""
    network = ["--network", f"container:{container}"] if container else []
    return ["docker", "run", "--rm", *network,
            "--mount", f"type=bind,source={ROOT},target=/src",
            "--mount", "type=volume,source=mandalika-ci-gomod,target=/go/pkg/mod",
            "--mount", "type=volume,source=mandalika-ci-gocache,target=/root/.cache/go-build",
            "--workdir", "/src/backend",
            "--env", f"MANDALIKA_{prefix}_TEST_DSN", "--env", f"MANDALIKA_{prefix}_TEST_DATA_DIR",
            "--env", "CGO_ENABLED=1", getattr(args, "go_image", GO_IMAGE_DEFAULT)] + go_cmd


def ensure_go_image(args) -> str:
    image = getattr(args, "go_image", GO_IMAGE_DEFAULT)
    try:
        checked(["docker", "image", "inspect", "--format", "{{.Id}}", image])
    except GateError:
        checked(["docker", "pull", image], timeout=600)
    # Warm the module and build caches once so the per-gate test timeout is not spent downloading.
    checked(docker_go_cmd(args, ["go", "mod", "download"], "WARM"), timeout=900)
    return checked(["docker", "image", "inspect", "--format", "{{.Id}}", image])


def selected_gates(args):
    only = getattr(args, "only", None)
    if not only:
        return GATES
    wanted = {x.strip().upper() for x in only.split(",") if x.strip()}
    unknown = wanted - {g[0] for g in GATES}
    if unknown:
        raise GateError(f"unknown gate prefix: {sorted(unknown)}")
    return tuple(g for g in GATES if g[0] in wanted)


def run(args) -> int:
    go_runner = getattr(args, "go_runner", "host")
    gates = selected_gates(args)
    report = {"schema_version": 1, "runtime": args.runtime, "race": not args.no_race, "go_runner": go_runner,
              "expected_gates": [g[1] for g in gates], "gates": [], "status": "running"}
    started = time.monotonic()
    save(args.output, report)
    try:
        report["go_version"] = checked(["go", "version"])
        if go_runner == "docker":
            if args.runtime != "docker":
                raise GateError("--go-runner docker requires --runtime docker (shared container network namespace)")
            report["go_image"] = ensure_go_image(args)
        if args.runtime == "docker":
            report["docker_version"] = checked(["docker", "version", "--format", "{{.Server.Version}}"])
            report["image"] = pull_image()
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
        for gate in gates:
            item = {"gate": gate[0], "test": gate[1], "stage": "start", "status": "running"}
            report["gates"].append(item)
            fixture = Fixture(args, gate, item)
            t0 = time.monotonic()
            try:
                for attempt in (1, 2):
                    try:
                        item["stage"] = "start"
                        fixture.start()
                        item["stage"] = "readiness"
                        fixture.ready()
                        break
                    except (GateError, subprocess.TimeoutExpired) as exc:
                        # Start-stage only (never a test failure): retry once with a fresh container.
                        if attempt == 2 or not any(m in str(exc).lower() for m in RETRYABLE_START):
                            raise
                        item.setdefault("start_retries", []).append(
                            {"attempt": attempt, "stage": item["stage"], "reason": sanitize(str(exc), fixture.password)[-500:]})
                        fixture.cleanup()
                        fixture = Fixture(args, gate, item)
                item["stage"] = "identity"
                fixture.identify()
                item["stage"] = "test"
                cmd = ["go", "test", "-mod=readonly", "./internal/handlers", "-run", f"^{gate[1]}$",
                       "-count=1", "-json", f"-timeout={args.test_timeout}s"]
                if not args.no_race:
                    cmd.append("-race")
                if go_runner == "docker":
                    cmd, test_env = docker_go_cmd(args, cmd, fixture.prefix, fixture.container), fixture.test_env()
                else:
                    test_env = fixture.test_env()
                item["command"], item["cwd"] = cmd, str(ROOT / "backend")
                save(args.output, report)
                result = command(cmd, env=test_env, timeout=args.test_timeout + 60, cwd=ROOT / "backend")
                item["result"] = named_result(result.stdout, gate[1], result.returncode)
                if item["result"]["status"] != "pass":
                    item["result"].update(failure_diagnostics(result.stdout, fixture.password))
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
    parser.add_argument("--go-runner", choices=("host", "docker"), default="host",
                        help="docker: run go test (with race) inside the pinned Linux Go image; no CGO needed on the host")
    parser.add_argument("--go-image", default=GO_IMAGE_DEFAULT, help="Go image for --go-runner docker (pinned)")
    parser.add_argument("--only", help="Comma-separated gate prefixes to run (default: all)")
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
