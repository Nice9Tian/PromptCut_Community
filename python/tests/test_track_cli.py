"""运动追踪命令行:部署参数覆盖环境变量、错误带 code、超长视频直接拒绝(不截断)。

云端 Agent 服务经工作区起这个进程,工作区会剥掉所有 PROMPTCUT_* 环境变量,
所以解释器之外的路径(依赖、权重、ffmpeg、依赖清单)靠命令行总开关递进来。
这里钉住两件事:总开关真的盖过环境变量;超长视频的拒绝带 code 字段,
调用方(Node)据此区分「视频太长」和别的失败。
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

FFMPEG = os.environ.get("PROMPTCUT_FFMPEG") or shutil.which("ffmpeg")


def run_main(argv):
    """跑 main(argv),回 (退出码, [stdout 里的 JSON 事件])。"""
    from promptcut_track import __main__ as cli

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = cli.main(argv)
    events = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip().startswith("{")]
    return code, events


class OverrideTest(unittest.TestCase):
    def test_总开关盖过环境变量(self):
        from promptcut_track import __main__ as cli

        saved = {k: os.environ.get(k) for k in ("PROMPTCUT_MODELS", "PROMPTCUT_PYLIBS")}
        os.environ["PROMPTCUT_MODELS"] = "/from/env/models"
        os.environ["PROMPTCUT_PYLIBS"] = "/from/env/libs"
        try:
            code, events = run_main(["--models", "/from/flag/models", "--pylibs", "/from/flag/libs", "status"])
            self.assertEqual(code, 0)
            status = events[0]
            self.assertEqual(status["event"], "status")
            self.assertTrue(status["model"]["path"].replace("\\", "/").startswith("/from/flag/models"))
            # 总开关只在这一次调用里生效,不留在模块里影响下一次
            code, events = run_main(["status"])
            self.assertTrue(events[0]["model"]["path"].replace("\\", "/").startswith("/from/env/models"))
            self.assertEqual(cli.env_paths()["pylibs"], "/from/env/libs")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


@unittest.skipIf(not FFMPEG, "没有 ffmpeg")
class TrackErrorCodeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="pc-track-cli-")
        cls.video = os.path.join(cls.tmp, "five.mp4")
        subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
             "-i", "testsrc=size=160x120:rate=10", "-t", "5", "-pix_fmt", "yuv420p", cls.video],
            check=True,
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_超过上限直接拒绝并带code(self):
        code, events = run_main(["--ffmpeg", FFMPEG, "track", "--video", self.video,
                                 "--points", "[[0,40,40]]", "--max-frames", "20"])
        self.assertEqual(code, 2)
        err = events[-1]
        self.assertEqual(err["event"], "error")
        self.assertEqual(err["code"], "too-long")
        self.assertEqual(err["limit"], 20)
        # 5 秒 × 10 fps = 50 帧;估计值允许差一两帧(容器时长取整)
        self.assertTrue(48 <= err["frames"] <= 52, err)
        # 拒绝发生在解码之前:没有 progress 事件
        self.assertFalse([e for e in events if e["event"] == "progress"])

    def test_上限之内正常追踪(self):
        code, events = run_main(["--ffmpeg", FFMPEG, "track", "--video", self.video,
                                 "--points", "[[0,80,60]]", "--engine", "template", "--max-frames", "500"])
        self.assertEqual(code, 0)
        result = events[-1]
        self.assertEqual(result["event"], "result")
        self.assertEqual(result["engine"], "template")
        self.assertEqual(result["frames"], len(result["points"][0]["xy"]))

    def test_坏的点带code(self):
        code, events = run_main(["--ffmpeg", FFMPEG, "track", "--video", self.video, "--points", "[[0,1]]"])
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["code"], "bad-points")

    def test_找不到视频带code(self):
        code, events = run_main(["--ffmpeg", FFMPEG, "track", "--video", os.path.join(self.tmp, "nope.mp4"),
                                 "--points", "[[0,1,1]]"])
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["code"], "video-missing")


class FfmpegInputTest(unittest.TestCase):
    def test_本地文件加协议白名单_素材服务地址不加(self):
        from promptcut_track import ffmpeg_input

        self.assertEqual(ffmpeg_input("/work/a.mp4"), ["-protocol_whitelist", "file", "-i", "/work/a.mp4"])
        self.assertEqual(ffmpeg_input("http://127.0.0.1:1/a"), ["-i", "http://127.0.0.1:1/a"])

    @unittest.skipIf(not FFMPEG, "没有 ffmpeg")
    def test_伪装成视频的播放列表连不了网络(self):
        """回归守卫:concat 清单里写一个本地 http 地址,ffmpeg 不去连。
        (新版 ffmpeg 对本地清单默认也拦;`-protocol_whitelist file` 是不依赖版本的兜底,上面的参数测试钉它。)"""
        import socket
        from promptcut_track.tracker import estimate_frames

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(0.5)
        port = listener.getsockname()[1]
        tmp = tempfile.mkdtemp(prefix="pc-track-playlist-")
        try:
            playlist = os.path.join(tmp, "fake.ffconcat")
            with open(playlist, "w", encoding="utf-8") as fh:
                fh.write(f"ffconcat version 1.0\nfile 'http://127.0.0.1:{port}/x.mp4'\n")
            estimate_frames(FFMPEG, playlist)
            try:
                conn, _ = listener.accept()
                conn.close()
                connected = True
            except socket.timeout:
                connected = False
            self.assertFalse(connected, "ffmpeg 不该去连播放列表里的网络地址")
        finally:
            listener.close()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
