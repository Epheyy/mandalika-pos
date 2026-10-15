"""Runner contract tests; no claims of database/business-concurrency coverage."""
import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import postgres_gate as gate


class RunnerContract(unittest.TestCase):
    name = "TestSaleInputPostgres"

    def events(self, *actions):
        return "\n".join(json.dumps({"Package": gate.PACKAGE, "Action": a, **({"Test": n} if n else {})})
                         for a, n in actions)

    def test_requires_named_run_and_pass_and_package_pass(self):
        raw = self.events(("run", self.name), ("pass", self.name), ("pass", None))
        self.assertEqual(gate.named_result(raw, self.name, 0)["status"], "pass")
        self.assertEqual(gate.named_result(raw, self.name, 1)["status"], "fail")
        for missing in ["", self.events(("pass", None)), self.events(("pass", self.name))]:
            self.assertEqual(gate.named_result(missing, self.name, 0)["status"], "fail")

    def test_successful_process_with_skipped_named_test_fails(self):
        raw = self.events(("run", self.name), ("skip", self.name), ("pass", None))
        self.assertEqual(gate.named_result(raw, self.name, 0)["status"], "fail")

    def test_skipped_child_and_other_package_cannot_manufacture_success(self):
        raw = self.events(("run", self.name), ("skip", self.name + "/child"), ("pass", self.name), ("pass", None))
        self.assertEqual(gate.named_result(raw, self.name, 0)["status"], "fail")
        self.assertEqual(gate.named_result(raw.replace(gate.PACKAGE, "other"), self.name, 0)["status"], "fail")

    def test_sanitizer_does_not_publish_password_or_dsn(self):
        raw = "failure postgres://someone:private@localhost/db password='private' private"
        safe = gate.sanitize(raw, "private")
        self.assertNotIn("private", safe)
        self.assertNotIn("postgres://", safe)

    def test_environment_does_not_inherit_fixture_or_output_or_libpq_defaults(self):
        with patch.dict(gate.os.environ, {"PGSERVICE": "live", "PGPASSFILE": "secret", "DATABASE_URL": "live",
             "MANDALIKA_A26_TEST_OUTPUT": "elsewhere", "MANDALIKA_S0C_TEST_DSN": "live", "GOFLAGS": "-overlay=x"}):
            clean = gate.clean_env()
        self.assertFalse(any(k.startswith(("PG", "MANDALIKA_", "DATABASE_")) for k in clean))
        self.assertNotIn("GOFLAGS", clean)

    def test_cleanup_uncertainty_overrides_pass_and_stops_following_gates(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = argparse.Namespace(runtime="native", pg_bin=tmp, no_race=True,
                output=Path(tmp) / "result.json", ready_timeout=1, test_timeout=1)
            raw = self.events(("run", self.name), ("pass", self.name), ("pass", None))
            with patch.object(gate, "checked", return_value="PostgreSQL 18.3"), \
                 patch.object(gate.Fixture, "start") as start, \
                 patch.object(gate.Fixture, "ready"), patch.object(gate.Fixture, "identify"), \
                 patch.object(gate.Fixture, "sql", return_value="0"), \
                 patch.object(gate, "command", return_value=gate.subprocess.CompletedProcess([], 0, raw)), \
                 patch.object(gate.Fixture, "cleanup", side_effect=gate.GateError("owned fixture removal unconfirmed")):
                self.assertEqual(gate.run(args), 1)
                self.assertEqual(start.call_count, 1)
            result = json.loads(args.output.read_text())
            self.assertEqual(result["gates"][0]["cleanup"], "uncertain")
            self.assertEqual(result["gates"][0]["result"]["status"], "pass")
            self.assertEqual(result["status"], "fail")

    def test_image_pull_is_digest_pinned_and_falls_back_across_mirrors(self):
        first, second = (f"{m}@{gate.IMAGE_DIGEST}" for m in gate.IMAGE_MIRRORS[:2])
        inspect = json.dumps({"id": "sha256:local", "digests": [second]})
        calls = []

        def fake(args, **kwargs):
            calls.append(args)
            if args[:2] == ["docker", "pull"] and args[2] == first:
                raise gate.GateError("docker exit 1: toomanyrequests: Data limit exceeded")
            return inspect if args[:3] == ["docker", "image", "inspect"] else "ok"

        with patch.object(gate, "checked", side_effect=fake):
            image = gate.pull_image()
        self.assertEqual([c[2] for c in calls if c[:2] == ["docker", "pull"]], [first, second])
        self.assertEqual(image["source"], second)
        self.assertEqual(image["id"], "sha256:local")
        self.assertTrue(all("@sha256:" in c[2] for c in calls if c[:2] == ["docker", "pull"]))

    def test_image_pull_fails_when_every_mirror_fails(self):
        with patch.object(gate, "checked", side_effect=gate.GateError("toomanyrequests")):
            with self.assertRaises(gate.GateError):
                gate.pull_image()

    def test_image_pull_refuses_a_digest_mismatch(self):
        wrong = json.dumps({"id": "sha256:local", "digests": ["x/postgres@sha256:" + "0" * 64]})

        def fake(args, **kwargs):
            return wrong if args[:3] == ["docker", "image", "inspect"] else "ok"

        calls = []

        def counting(args, **kwargs):
            calls.append(args)
            return fake(args, **kwargs)

        with patch.object(gate, "checked", side_effect=counting):
            with self.assertRaises(gate.GateError):
                gate.pull_image()
        self.assertEqual(len([c for c in calls if c[:2] == ["docker", "pull"]]), 1)  # no fallback after a mismatch

    def test_hung_pull_falls_back_to_next_mirror(self):
        first = f"{gate.IMAGE_MIRRORS[0]}@{gate.IMAGE_DIGEST}"
        second = f"{gate.IMAGE_MIRRORS[1]}@{gate.IMAGE_DIGEST}"

        def fake(args, **kwargs):
            if args[:2] == ["docker", "pull"] and args[2] == first:
                raise gate.subprocess.TimeoutExpired(args, 180)
            return json.dumps({"id": "sha256:local", "digests": [second]}) if args[:3] == ["docker", "image", "inspect"] else "ok"

        with patch.object(gate, "checked", side_effect=fake):
            self.assertEqual(gate.pull_image()["source"], second)

    def test_docker_creation_is_loopback_tmpfs_and_uses_resolved_image(self):
        args = argparse.Namespace(runtime="docker", image_id="sha256:synthetic-image")
        f = gate.Fixture(args, gate.GATES[0], {})
        bindings = {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "56439"}]}
        with patch.object(gate, "port_open", return_value=False), \
             patch.object(gate, "checked", side_effect=["created", '"owned-id"', json.dumps(bindings), "started"]) as run:
            f.start()
        cmd = run.call_args_list[0].args[0]
        self.assertIn("127.0.0.1:56439:5432", cmd)
        self.assertIn("type=tmpfs,destination=/var/lib/postgresql", cmd)
        self.assertEqual(cmd[-1], args.image_id)
        self.assertNotIn(f.password, " ".join(cmd))
        self.assertEqual(run.call_args_list[0].kwargs["env"]["POSTGRES_PASSWORD"], f.password)

    def test_cleanup_refuses_container_with_wrong_owner(self):
        f = gate.Fixture(argparse.Namespace(runtime="docker"), gate.GATES[0], {})
        f.created = True
        with patch.object(gate, "checked", side_effect=["container-id", "somebody-else"]) as run:
            with self.assertRaisesRegex(gate.GateError, "ownership uncertain"):
                f.cleanup()
        self.assertEqual(run.call_count, 2)  # no rm of the mismatched container

    def test_unestablished_data_directory_cannot_reach_empty_schema_check(self):
        f = gate.Fixture(argparse.Namespace(runtime="docker"), gate.GATES[0], {})
        with patch.object(f, "sql", return_value=f"{f.database}|{f.user}|180003|") as sql:
            with self.assertRaisesRegex(gate.GateError, "data_directory identity mismatch"):
                f.identify()
        self.assertEqual(sql.call_count, 1)


if __name__ == "__main__":
    unittest.main()
