"""The three global options the Cloud Agent service uses when it launches promptcut_shots.

When the workspace launches a subprocess it rebuilds the environment variables from an allowlist (not a single PROMPTCUT_* is passed), so the model directory and the dependency directory
go through the command line; the media is passed in by members, so ffmpeg must be restricted to local files. No inference engine is needed here.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from promptcut_shots import __main__ as M  # noqa: E402
from promptcut_shots import detector as D  # noqa: E402


def run_main(argv, env=None):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=False), \
         redirect_stdout(out), redirect_stderr(err):
        code = M.main(argv)
    events = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    return code, events, err.getvalue()


class TestHostedGlobals(unittest.TestCase):
    def setUp(self):
        self._local_only = D.LOCAL_ONLY
        self._saved = {k: os.environ.get(k) for k in ("PROMPTCUT_MODELS", "PROMPTCUT_PYLIBS")}

    def tearDown(self):
        D.LOCAL_ONLY = self._local_only
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_models_dir_option_replaces_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, events, _ = run_main(["--models-dir", tmp, "status"],
                                       env={"PROMPTCUT_MODELS": "X:\not-this"})
        self.assertEqual(code, 0)
        status = events[0]
        self.assertEqual(status["event"], "status")
        self.assertEqual(os.path.normcase(os.path.dirname(status["model"]["path"])), os.path.normcase(tmp))

    def test_status_without_options_is_unchanged(self):
        code, events, _ = run_main(["status"])
        self.assertEqual(code, 0)
        self.assertIn("ready", events[0])
        self.assertFalse(D.LOCAL_ONLY)

    def test_local_only_adds_protocol_whitelist_to_ffmpeg(self):
        seen = []

        def fake_run(cmd, **kwargs):
            seen.append(list(cmd))
            return mock.Mock(returncode=1, stdout=b"", stderr=b"x")

        D.LOCAL_ONLY = True
        with mock.patch.object(D.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(RuntimeError):
                D.decode_frames("ffmpeg", "clip.mp4")
        i = seen[0].index("-protocol_whitelist")
        self.assertEqual(seen[0][i + 1], "file")
        self.assertLess(i, seen[0].index("-i"))

    def test_without_local_only_command_is_unchanged(self):
        seen = []

        def fake_run(cmd, **kwargs):
            seen.append(list(cmd))
            return mock.Mock(returncode=1, stdout=b"", stderr=b"x")

        D.LOCAL_ONLY = False
        with mock.patch.object(D.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(RuntimeError):
                D.decode_frames("ffmpeg", "clip.mp4")
        self.assertNotIn("-protocol_whitelist", seen[0])

    def test_local_only_flag_reaches_detector(self):
        run_main(["--local-only", "status"])
        self.assertTrue(D.LOCAL_ONLY)

    def test_local_only_refuses_network_address(self):
        fake_info = {"ready": True, "model": {"path": "m", "exists": True}, "runtime": {"installed": True}}
        with mock.patch.object(M, "probe", return_value=fake_info), \
             mock.patch.object(M, "env_paths", return_value={"pylibs": None, "models": None, "data_dir": None, "ffmpeg": "ffmpeg"}):
            code, events, _ = run_main(["--local-only", "detect", "http://127.0.0.1:9/a.mp4", "--fps", "25"])
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["event"], "error")


if __name__ == "__main__":
    unittest.main()
