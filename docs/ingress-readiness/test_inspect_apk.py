import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location("inspect_apk", Path(__file__).with_name("inspect_apk.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InspectApkTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mandalika-readiness-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.apk = Path(self.temporary.name) / "synthetic.apk"

    def fixture(self, config=None, extra=()):
        if config is None:
            config = {"appId": "com.synthetic.test"}
        with warnings.catch_warnings(), zipfile.ZipFile(self.apk, "w") as archive:
            warnings.simplefilter("ignore", UserWarning)
            if config is not False:
                archive.writestr("assets/capacitor.config.json", config if isinstance(config, str) else json.dumps(config))
            for name, body in extra:
                info = zipfile.ZipInfo("placeholder")
                info.filename = name  # Keep adversarial raw spelling; Windows constructor normalizes separators.
                archive.writestr(info, body)
        return module.inspect(self.apk)

    def test_absent_flags_and_fleet_remain_unknown(self):
        result = self.fixture()
        self.assertEqual(result["installed_cohort"], "unknown")
        self.assertFalse(result["updater_present"])
        self.assertEqual(result["updater_flags"]["allowModifyUrl"], {"present": False, "value": None})

    def test_explicit_flags_are_not_defaulted(self):
        result = self.fixture({"appId": "com.synthetic.test", "plugins": {"CapacitorUpdater": {"allowModifyUrl": False, "persistModifyUrl": True, "updateUrl": "https://example.invalid/check"}}})
        self.assertEqual(result["updater_flags"]["allowModifyUrl"]["value"], False)
        self.assertEqual(result["updater_flags"]["persistModifyUrl"]["value"], True)
        self.assertEqual(result["updater_update_url"], "https://example.invalid/check")

    def test_duplicate_json_field_rejects(self):
        with self.assertRaises(ValueError):
            self.fixture('{"appId":"one","appId":"two"}')

    def test_malformed_json_rejects(self):
        with self.assertRaises(ValueError):
            self.fixture('{')

    def test_invalid_flag_type_rejects(self):
        with self.assertRaises(ValueError):
            self.fixture({"appId": "com.test", "plugins": {"CapacitorUpdater": {"allowModifyUrl": "false"}}})

    def test_duplicate_member_rejects(self):
        with self.assertRaises(ValueError):
            self.fixture(extra=[("assets/capacitor.config.json", "{}")])

    def test_missing_config_rejects(self):
        with self.assertRaises(ValueError):
            self.fixture(False)

    def test_unsafe_paths_reject(self):
        for name in ["../outside", "/absolute", "C:/absolute", "a\\b", "a\x00b"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.fixture(extra=[(name, "inert")])

    def test_oversize_config_rejects(self):
        with self.assertRaises(ValueError):
            self.fixture('{"appId":"' + 'x' * 65536 + '"}')

    def test_nonfinite_json_rejects(self):
        with self.assertRaises(ValueError):
            self.fixture('{"appId":"x","extra":NaN}')

    def test_conflicting_shape_rejects(self):
        with self.assertRaises(ValueError):
            self.fixture({"appId": "x", "plugins": []})

    def test_query_credential_not_emitted_by_cli(self):
        with self.assertRaises(ValueError):
            self.fixture({"appId": "x", "plugins": {"CapacitorUpdater": {"updateUrl": "https://example.invalid/check?key=SYNTHETIC_SENTINEL"}}})
        run = subprocess.run([sys.executable, "-B", str(Path(module.__file__)), str(self.apk)], capture_output=True, text=True, timeout=5)
        self.assertEqual(run.returncode, 1)
        self.assertNotIn("SYNTHETIC_SENTINEL", run.stdout + run.stderr)

    def test_javascript_is_only_hashed_and_origins_selected(self):
        result = self.fixture(extra=[("assets/public/assets/index.js", 'throw new Error("NEVER EXECUTE"); const u="https://example.invalid/a?synthetic=value";')])
        self.assertEqual(result["scripts"][0]["literal_origin_candidates"], ["https://example.invalid"])
        self.assertEqual(len(result["scripts"][0]["sha256"]), 64)

    def test_nonzip_rejects(self):
        self.apk.write_text("not an APK")
        with self.assertRaises(zipfile.BadZipFile):
            module.inspect(self.apk)


if __name__ == "__main__":
    unittest.main()
