"""status 子命令：两档都没装时也必须成功返回一行合契约的 JSON。

参数缺失、路径不存在这些情况也在这里验：这个进程是被 node 侧按行解析的，
任何一次「往 stdout 糊 traceback」都会让界面看到一堆解析失败。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# -I 隔离模式同时打开 -E，会连 PYTHONPATH 一起忽略；源码树里跑测试时得自己把
# 源码目录塞进 sys.path，用 runpy 起模块，既保住隔离又能定位到源码。
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
        self.assertEqual(len(lines), 1, msg=f"stdout 不是恰好一行：{proc.stdout!r}")
        data = json.loads(lines[0])

        self.assertEqual(data["event"], "status")
        for key in ("version", "engine", "light", "full", "ffmpeg"):
            self.assertIn(key, data)

        # 空目录下两档都不可能就绪，engine 必须是 null
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
        """一个环境变量都没设也不能崩，models 落到 ~/.promptcut/models。"""
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
        self.assertIn("找不到视频文件", data["message"])

    def test_detect_without_engine_reports_not_ready(self):
        """引擎没装时 detect 要给退出码 3 + 一条带 detail 的 error，不能是 traceback。"""
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
