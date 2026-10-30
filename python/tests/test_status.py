"""status 子命令：引擎没装时也必须成功返回一行合契约的 JSON。"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# -I 隔离模式同时打开 -E，会连 PYTHONPATH 一起忽略；包已经装进 site-packages 时
# 直接 -m promptcut_stt 就行，但源码树里跑测试时得自己把源码目录塞进 sys.path。
# 用 runpy 起模块，既保住隔离又能定位到源码。
BOOTSTRAP = (
    "import sys, runpy; sys.path.insert(0, r'{root}'); "
    "runpy.run_module('promptcut_stt', run_name='__main__', alter_sys=True)"
)


def run_subcommand(args, extra_env=None):
    """用当前解释器以 -I 隔离模式跑一个子命令，返回 CompletedProcess。"""
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
        self.assertEqual(len(lines), 1, msg=f"stdout 不是恰好一行：{proc.stdout!r}")
        data = json.loads(lines[0])

        for key in ("python", "executable", "pylibs", "models_dir", "engines", "cuda", "models", "ffmpeg"):
            self.assertIn(key, data)

        self.assertTrue(data["python"].startswith("3."))
        self.assertIsInstance(data["cuda"], bool)
        self.assertIsInstance(data["models"], list)

        # 干净环境下 pylibs 目录由 status 建出来，且可写
        self.assertEqual(data["pylibs"]["path"], pylibs)
        self.assertTrue(data["pylibs"]["writable"])

        # 两个引擎都要报告，installed 必须是布尔（装没装都不断言值）
        self.assertEqual(set(data["engines"]), {"faster-whisper", "whisper"})
        for name, info in data["engines"].items():
            self.assertIsInstance(info["installed"], bool, msg=name)
            self.assertIn("version", info)
            self.assertIn("error", info)

    def test_status_without_pylibs_env(self):
        """没设 PROMPTCUT_PYLIBS 也不能崩，只是 path 为 null。"""
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
        self.assertIn("不存在", data["message"])


if __name__ == "__main__":
    unittest.main()
