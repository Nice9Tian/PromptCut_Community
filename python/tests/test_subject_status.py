"""status subcommand: even when neither tier is installed it must still return one line of contract-conformant JSON.

Cases such as missing arguments and non-existent paths are verified here too: this process is parsed line by line on the node side,
so any single case of "smearing a traceback onto stdout" makes the UI see a pile of parse failures.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# -I isolated mode also turns on -E, which ignores PYTHONPATH as well; when running tests in the source tree you have to put the
# source directory on sys.path yourself and launch the module via runpy, which keeps the isolation and still locates the source.
BOOTSTRAP = (
    "import sys, runpy; sys.path.insert(0, r'{root}'); "
    "runpy.run_module('promptcut_subject', run_name='__main__', alter_sys=True)"
)


def run_subcommand(args, extra_env=None):
    env = {
        "SystemRoot": os.environ.get("SystemRoot", ""),
        "PATH": os.environ.get("PATH", ""),
        "PYTHONUTF8": "1",
        "PYTHONNOUSERSITE": "1",
    }
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, "-I", "-c", BOOTSTRAP.format(root=PACKAGE_ROOT)] + args,
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
    )


class TestStatus(unittest.TestCase):
    def test_status_returns_one_json_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            pylibs = os.path.join(tmp, "pylibs")
            models = os.path.join(tmp, "models")
            proc = run_subcommand(
                ["status"], {"PROMPTCUT_PYLIBS": pylibs, "PROMPTCUT_MODELS": models})
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)

        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, msg=f"stdout is not exactly one line: {proc.stdout!r}")
        data = json.loads(lines[0])

        self.assertEqual(data["event"], "status")
        for key in ("version", "engine", "light", "full", "ffmpeg"):
            self.assertIn(key, data)

        # In an empty directory neither tier can be ready, so engine must be null
        self.assertIsNone(data["engine"])

        for tier, names in (("light", ("yunet", "rtdetr")), ("full", ("dino",))):
            info = data[tier]
            self.assertIsInstance(info["ready"], bool, msg=tier)
            self.assertFalse(info["ready"], msg=tier)
            self.assertIsInstance(info["runtime"]["installed"], bool, msg=tier)
            self.assertIn("version", info["runtime"])
            self.assertEqual(set(info["models"]), set(names), msg=tier)
            for name in names:
                entry = info["models"][name]
                self.assertIn("path", entry)
                self.assertIs(entry["exists"], False, msg=f"{tier}.{name}")
                self.assertEqual(os.path.dirname(entry["path"].rstrip("\\/")), models)

    def test_status_without_any_env(self):
        """It must not crash when not a single environment variable is set; models falls back to ~/.promptcut/models."""
        proc = run_subcommand(["status"])
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["event"], "status")
        self.assertIn("modelsDir", data)

    def test_install_without_pylibs_env_reports_error(self):
        proc = run_subcommand(["install"])
        self.assertEqual(proc.returncode, 2)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["event"], "error")
        self.assertIn("PROMPTCUT_PYLIBS", data["message"])

    def test_detect_missing_video_reports_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = run_subcommand(
                ["detect", "no-such-file.mp4", "--times", "1.0"],
                {"PROMPTCUT_MODELS": tmp, "PROMPTCUT_FFMPEG": "ffmpeg"})
        self.assertEqual(proc.returncode, 2)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["event"], "error")
        self.assertIn("video file not found", data["message"])

    def test_detect_without_engine_reports_not_ready(self):
        """When the engine is not installed, detect must give exit code 3 + an error carrying detail, not a traceback."""
        with tempfile.TemporaryDirectory() as tmp:
            video = os.path.join(tmp, "fake.mp4")
            with open(video, "wb") as fh:
                fh.write(b"not really a video")
            proc = run_subcommand(
                ["detect", video, "--times", "1.0"],
                {"PROMPTCUT_MODELS": os.path.join(tmp, "models"),
                 "PROMPTCUT_FFMPEG": "ffmpeg"})
        self.assertEqual(proc.returncode, 3, msg=proc.stdout + proc.stderr)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["event"], "error")
        self.assertIsNone(data["detail"]["engine"])


if __name__ == "__main__":
    unittest.main()
