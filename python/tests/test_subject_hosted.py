"""云端 Agent 服务起 promptcut_subject 时用的三个全局选项和 install --requirements。

工作区起子进程时环境变量按白名单重建(一个 PROMPTCUT_* 都不传),所以模型目录、依赖目录
走命令行;素材是成员传的,ffmpeg / ffprobe 要被限制在本地文件。这里不需要任何推理引擎。
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

from promptcut_subject import __main__ as M  # noqa: E402
from promptcut_subject import frames as F  # noqa: E402


def run_main(argv, env=None):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=False), \
         redirect_stdout(out), redirect_stderr(err):
        code = M.main(argv)
    events = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    return code, events, err.getvalue()


class TestHostedGlobals(unittest.TestCase):
    def setUp(self):
        self._local_only = F.LOCAL_ONLY
        self._saved = {k: os.environ.get(k) for k in ("PROMPTCUT_MODELS", "PROMPTCUT_PYLIBS")}

    def tearDown(self):
        F.LOCAL_ONLY = self._local_only
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
        self.assertEqual(os.path.normcase(status["modelsDir"]), os.path.normcase(tmp))

    def test_status_without_options_is_unchanged(self):
        code, events, _ = run_main(["status"])
        self.assertEqual(code, 0)
        self.assertIn("engine", events[0])
        self.assertFalse(F.LOCAL_ONLY)

    def test_local_only_adds_protocol_whitelist_to_ffmpeg_and_ffprobe(self):
        seen = []

        def fake_run(cmd, **kwargs):
            seen.append(list(cmd))
            return mock.Mock(returncode=0, stdout="640x360\n", stderr="")

        F.LOCAL_ONLY = True
        with mock.patch.object(F.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(F, "ffprobe_path", return_value="ffprobe"):
            self.assertEqual(F.probe_size("ffmpeg", "clip.mp4"), (640, 360))
        probe_cmd = seen[0]
        i = probe_cmd.index("-protocol_whitelist")
        self.assertEqual(probe_cmd[i + 1], "file")
        self.assertLess(i, probe_cmd.index("clip.mp4"))

        seen.clear()

        def fake_grab(cmd, **kwargs):
            seen.append(list(cmd))
            return mock.Mock(returncode=0, stdout=b"\0" * (4 * 2 * 3), stderr=b"")

        with mock.patch.object(F.subprocess, "run", side_effect=fake_grab):
            F.grab_frame("ffmpeg", "clip.mp4", 1.0, 4, 2)
        grab_cmd = seen[0]
        j = grab_cmd.index("-protocol_whitelist")
        self.assertEqual(grab_cmd[j + 1], "file")
        self.assertLess(j, grab_cmd.index("-i"))

    def test_without_local_only_commands_are_unchanged(self):
        seen = []

        def fake_run(cmd, **kwargs):
            seen.append(list(cmd))
            return mock.Mock(returncode=0, stdout="640x360\n", stderr="")

        F.LOCAL_ONLY = False
        with mock.patch.object(F.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(F, "ffprobe_path", return_value="ffprobe"):
            F.probe_size("ffmpeg", "http://127.0.0.1:1/x.mp4")
        self.assertNotIn("-protocol_whitelist", seen[0])

    def test_local_only_flag_reaches_frames(self):
        F.LOCAL_ONLY = False
        run_main(["--local-only", "status"])
        self.assertTrue(F.LOCAL_ONLY)


class TestInstallRequirements(unittest.TestCase):
    def test_requirements_file_overrides_package_list(self):
        captured = {}

        class FakeProc:
            stdout = iter([])

            def wait(self):
                return 0

        def fake_popen(cmd, **kwargs):
            captured["cmd"] = list(cmd)
            return FakeProc()

        with tempfile.TemporaryDirectory() as tmp:
            req = os.path.join(tmp, "locked.txt")
            open(req, "w").write("# empty on purpose\n")
            libs = os.path.join(tmp, "libs")
            with mock.patch.object(M.subprocess, "Popen", side_effect=fake_popen):
                code, events, _ = run_main(["--pylibs", libs, "install", "--tier", "light",
                                            "--requirements", req])
        self.assertEqual(code, 0)
        cmd = captured["cmd"]
        self.assertEqual(cmd[cmd.index("-r") + 1], req)
        self.assertEqual(cmd[cmd.index("--target") + 1], libs)
        self.assertEqual(events[-1]["event"], "installed")

    def test_missing_requirements_file_is_a_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, events, _ = run_main(["--pylibs", tmp, "install",
                                        "--requirements", os.path.join(tmp, "nope.txt")])
        self.assertEqual(code, 2)
        self.assertEqual(events[0]["event"], "error")
        self.assertIn("nope.txt", events[0]["message"])


if __name__ == "__main__":
    unittest.main()
