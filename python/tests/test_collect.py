"""素材收集包：不联网、不要求装 yt-dlp 也要过的那部分。

- 站点预设：链接归一化、匹配、可重试判断；
- 格式选择串、文件名清洗；
- status / presets 子命令：yt-dlp 没装时也退出 0、一行 JSON、字段齐全。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PACKAGE_ROOT)

from promptcut_collect import presets  # noqa: E402
from promptcut_collect.presets import bilibili, generic  # noqa: E402
from promptcut_collect.ytdl import format_selector, safe_name  # noqa: E402

BOOTSTRAP = (
    "import sys, runpy; sys.path.insert(0, r'{root}'); "
    "runpy.run_module('promptcut_collect', run_name='__main__', alter_sys=True)"
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


class TestBilibiliPreset(unittest.TestCase):
    def test_match(self):
        for u in (
            "https://www.bilibili.com/video/BV1BYtB6GEFV",
            "bilibili.com/video/BV1BYtB6GEFV",
            "https://m.bilibili.com/video/BV1BYtB6GEFV?p=2",
            "https://b23.tv/abc123",
            "BV1BYtB6GEFV",
            "av170001",
        ):
            self.assertTrue(bilibili.match(u), u)
        self.assertFalse(bilibili.match("https://www.youtube.com/watch?v=xyz"))
        self.assertFalse(bilibili.match("https://example.com/BV1BYtB6GEFV.html"))

    def test_normalize(self):
        std = "https://www.bilibili.com/video/BV1BYtB6GEFV"
        self.assertEqual(bilibili.normalize("BV1BYtB6GEFV"), std)
        self.assertEqual(bilibili.normalize("bilibili.com/video/BV1BYtB6GEFV"), std)
        self.assertEqual(bilibili.normalize(
            "https://www.bilibili.com/video/BV1BYtB6GEFV/?spm_id_from=333.1007&vd_source=abc"), std)
        self.assertEqual(bilibili.normalize("https://m.bilibili.com/video/BV1BYtB6GEFV?p=3"), std + "?p=3")
        # p=1 和不带 p 等价，去掉
        self.assertEqual(bilibili.normalize("https://www.bilibili.com/video/BV1BYtB6GEFV?p=1"), std)
        self.assertEqual(bilibili.normalize("av170001"), "https://www.bilibili.com/video/av170001")
        # 短链留给 yt-dlp 跟重定向
        self.assertEqual(bilibili.normalize("https://b23.tv/abc123"), "https://b23.tv/abc123")

    def test_retryable(self):
        self.assertTrue(bilibili.retryable("HTTP Error 412: Precondition Failed"))
        self.assertFalse(bilibili.retryable("HTTP Error 404: Not Found"))
        self.assertFalse(generic.retryable("HTTP Error 412: Precondition Failed"))

    def test_headers(self):
        opts = bilibili.ydl_opts("https://www.bilibili.com/video/BV1BYtB6GEFV", 1080)
        self.assertIn("Mozilla", opts["http_headers"]["User-Agent"])
        self.assertEqual(opts["http_headers"]["Referer"], "https://www.bilibili.com/")
        self.assertTrue(opts["noplaylist"])


class TestResolve(unittest.TestCase):
    def test_auto(self):
        self.assertIs(presets.resolve("BV1BYtB6GEFV"), bilibili)
        self.assertIs(presets.resolve("https://www.youtube.com/watch?v=xyz"), generic)

    def test_forced(self):
        self.assertIs(presets.resolve("https://example.com/x", "bilibili"), bilibili)
        with self.assertRaises(KeyError):
            presets.by_name("nope")

    def test_names(self):
        self.assertEqual(presets.names(), ["bilibili", "generic"])


class TestHelpers(unittest.TestCase):
    def test_format_selector_prefers_avc1(self):
        s = format_selector(720)
        self.assertTrue(s.startswith("bestvideo[vcodec^=avc1][height<=720]+bestaudio[ext=m4a]"))
        self.assertIn("/best", s)
        self.assertEqual(format_selector(1080, audio_only=True), "bestaudio[ext=m4a]/bestaudio/best")

    def test_safe_name(self):
        self.assertEqual(safe_name('DeepSeek不行了？我实测: "半个月" <告诉你> #答案'),
                         "DeepSeek不行了？我实测 半个月 告诉你 答案")
        self.assertEqual(safe_name("a/b\\c|d*e"), "a b c d e")
        self.assertEqual(safe_name("   "), "video")
        self.assertEqual(safe_name("..."), "video")
        self.assertLessEqual(len(safe_name("x" * 200)), 80)


class TestSubcommands(unittest.TestCase):
    def test_status_without_ytdlp(self):
        with tempfile.TemporaryDirectory() as tmp:
            pylibs = os.path.join(tmp, "pylibs")
            proc = run_subcommand(["status"], {"PROMPTCUT_PYLIBS": pylibs})
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1, msg=f"stdout 不是恰好一行：{proc.stdout!r}")
        data = json.loads(lines[0])
        self.assertEqual(data["event"], "status")
        for key in ("ready", "ytdlp", "ffmpeg", "presets", "version"):
            self.assertIn(key, data)
        self.assertIsInstance(data["ytdlp"]["installed"], bool)
        self.assertEqual([p["name"] for p in data["presets"]], ["bilibili", "generic"])

    def test_presets(self):
        proc = run_subcommand(["presets"])
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["event"], "presets")

    def test_install_without_pylibs(self):
        proc = run_subcommand(["install"])
        self.assertEqual(proc.returncode, 2)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["event"], "error")

    def test_probe_without_ytdlp_reports_not_installed(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = run_subcommand(["probe", "--url", "BV1BYtB6GEFV"],
                                  {"PROMPTCUT_PYLIBS": os.path.join(tmp, "empty")})
        self.assertEqual(proc.returncode, 3, msg=proc.stdout + proc.stderr)
        data = json.loads(proc.stdout.splitlines()[-1])
        self.assertEqual(data["event"], "error")
        self.assertTrue(data.get("notInstalled"))


if __name__ == "__main__":
    unittest.main()
