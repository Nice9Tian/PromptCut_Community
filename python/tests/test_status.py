"""status subcommand: even when the engine is not installed it must still return one line of contract-conformant JSON."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# -I isolated mode also turns on -E, which ignores PYTHONPATH as well; when the package is already installed into site-packages
# a plain -m promptcut_stt is enough, but when running tests in the source tree you have to put the source directory on sys.path yourself.
# Launching the module via runpy keeps the isolation and still locates the source.
BOOTSTRAP = (
    "import sys, runpy; sys.path.insert(0, r'{root}'); "
    "runpy.run_module('promptcut_stt', run_name='__main__', alter_sys=True)"
)


def run_subcommand(args, extra_env=None):
    """Run a subcommand with the current interpreter in -I isolated mode and return the CompletedProcess."""
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
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )


class TestStatus(unittest.TestCase):
    def test_status_returns_one_json_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            pylibs = os.path.join(tmp, "pylibs")
            models = os.path.join(tmp, "models")
            proc = run_subcommand(
                ["status"],
                {"PROMPTCUT_PYLIBS": pylibs, "PROMPTCUT_MODELS": models},
            )
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)

        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, msg=f"stdout is not exactly one line: {proc.stdout!r}")
        data = json.loads(lines[0])

        for key in ("python", "executable", "pylibs", "models_dir", "engines", "cuda", "models", "ffmpeg"):
            self.assertIn(key, data)

        self.assertTrue(data["python"].startswith("3."))
        self.assertIsInstance(data["cuda"], bool)
        self.assertIsInstance(data["models"], list)

        # In a clean environment the pylibs directory is created by status, and is writable
        self.assertEqual(data["pylibs"]["path"], pylibs)
        self.assertTrue(data["pylibs"]["writable"])

        # Both engines must be reported, and installed must be a boolean (its value is not asserted, installed or not)
        self.assertEqual(set(data["engines"]), {"faster-whisper", "whisper"})
        for name, info in data["engines"].items():
            self.assertIsInstance(info["installed"], bool, msg=name)
            self.assertIn("version", info)
            self.assertIn("error", info)

    def test_status_without_pylibs_env(self):
        """It must not crash when PROMPTCUT_PYLIBS is unset; path is just null."""
        proc = run_subcommand(["status"])
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertIsNone(data["pylibs"]["path"])
        self.assertFalse(data["pylibs"]["exists"])
        self.assertFalse(data["pylibs"]["writable"])

    def test_models_returns_one_json_line(self):
        proc = run_subcommand(["models"])
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1)
        data = json.loads(lines[0])
        self.assertEqual(data["default_engine"], "faster-whisper")
        self.assertEqual(set(data["engines"]), {"faster-whisper", "whisper"})
        names = [m["name"] for m in data["engines"]["faster-whisper"]["models"]]
        self.assertIn("small", names)
        self.assertIn("large-v3", names)

    def test_install_without_pylibs_env_reports_error(self):
        proc = run_subcommand(["install", "--engine", "faster-whisper"])
        self.assertEqual(proc.returncode, 1)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["event"], "error")
        self.assertIn("PROMPTCUT_PYLIBS", data["message"])

    def test_transcribe_missing_input_reports_error(self):
        proc = run_subcommand(["transcribe", "--input", "no-such-file.mp4"])
        self.assertEqual(proc.returncode, 1)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["event"], "error")
        self.assertIn("does not exist", data["message"])


if __name__ == "__main__":
    unittest.main()
