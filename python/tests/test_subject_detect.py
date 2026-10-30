"""detect 子命令的降级行为：抽帧失败要留标记、full 档跑不动要退回 light、
参数写错要说人话。

这里**不需要任何推理引擎**：probe / grab_frame / 三个后端的 detect 全部打桩，
所以内置解释器（只有 numpy）也能跑完整套。真跑推理的部分在
test_subject_light.py / test_subject_dino.py 里，缺引擎时跳过。

为什么值得单独写一个文件：这三条都是「出错时的样子」，而出错路径恰恰是最没人
手工试过的。校验员实测过的两个坑就在这里 ——
  - `detect out/test.mp4 --times 0.5,999`（999 超出 5.0s 时长）以前给出
    {"t":999.0,"boxes":[],"safeSide":"right","occupancy":{四个 0}}，和「这一帧
    真的没有人」逐字段相同；
  - DINO 目录缺分词器时 status 报 full 就绪，detect 崩在 transformers 内部。
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

import numpy as np  # noqa: E402

from promptcut_subject import __main__ as M  # noqa: E402
from promptcut_subject import dino, frames as F, rtdetr, yunet  # noqa: E402


def fake_info(*, light_ready: bool = True, full_ready: bool = True) -> dict:
    """probe() 的返回值，字段和真的那份一一对应（只是不看磁盘）。"""
    return {
        "engine": "full" if full_ready else ("light" if light_ready else None),
        "light": {
            "ready": light_ready,
            "runtime": {"installed": light_ready, "version": "1.20.1",
                        "error": None if light_ready else "No module named 'onnxruntime'"},
            "models": {"yunet": {"path": r"X:\m\yunet.onnx", "exists": light_ready},
                       "rtdetr": {"path": r"X:\m\rtdetr_r18vd.onnx", "exists": light_ready}},
        },
        "full": {
            "ready": full_ready,
            "runtime": {"installed": full_ready, "version": "2.5.1", "torch": "2.5.1",
                        "transformers": "4.57.6", "error": None},
            "models": {"dino": {"path": r"X:\m\grounding-dino-tiny", "exists": full_ready}},
        },
        "modelsDir": r"X:\m",
        "ffmpeg": "ffmpeg",
    }


FRAME = np.zeros((360, 640, 3), dtype=np.uint8)
ONE_BOX = [{"label": "person", "x": 10, "y": 10, "w": 100, "h": 200, "conf": 0.9}]


class DetectHarness(unittest.TestCase):
    """把 detect 跑在打桩的世界里，返回 (退出码, stdout 的 JSON 行, stderr)。"""

    def run_detect(self, argv, *, info=None, grab=None,
                   light=None, full=None):
        info = info or fake_info()
        grab = grab or (lambda *a, **k: FRAME)
        light = light or (lambda *a, **k: [list(ONE_BOX)])
        full = full or (lambda *a, **k: [list(ONE_BOX)])

        with tempfile.TemporaryDirectory() as tmp:
            video = os.path.join(tmp, "clip.mp4")
            with open(video, "wb") as fh:
                fh.write(b"not really a video")
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.object(M, "probe", return_value=info), \
                 mock.patch.object(M, "env_paths", return_value={
                     "pylibs": None, "models": r"X:\m", "data_dir": None, "ffmpeg": "ffmpeg"}), \
                 mock.patch.object(F, "probe_size", return_value=(1280, 720)), \
                 mock.patch.object(F, "grab_frame", side_effect=grab), \
                 mock.patch.object(yunet, "detect", side_effect=light), \
                 mock.patch.object(rtdetr, "detect", side_effect=lambda *a, **k: [[]]), \
                 mock.patch.object(dino, "detect", side_effect=full), \
                 redirect_stdout(out), redirect_stderr(err):
                code = M.main(["detect", video] + argv)
        lines = [json.loads(ln) for ln in out.getvalue().splitlines() if ln.strip()]
        return code, lines, err.getvalue()

    @staticmethod
    def result_of(lines):
        for obj in lines:
            if obj.get("event") == "result":
                return obj
        return None

    @staticmethod
    def error_of(lines):
        for obj in lines:
            if obj.get("event") == "error":
                return obj
        return None


class TestBadTimes(DetectHarness):
    """--times 写错是参数错误（退 2），不是「未预期的错误」（退 1）。"""

    def test_non_numeric_chunk_named_in_message(self):
        code, lines, _ = self.run_detect(["--times", "1.0,abc,2.0"])
        self.assertEqual(code, 2)
        err = self.error_of(lines)
        self.assertIn("abc", err["message"])
        self.assertIn("1.2,5.4,8.8", err["message"], "得给个能照抄的写法")
        self.assertNotIn("未预期的错误", err["message"])

    def test_all_bad_chunks_listed(self):
        code, lines, _ = self.run_detect(["--times", "abc,1.0,第二秒"])
        self.assertEqual(code, 2)
        msg = self.error_of(lines)["message"]
        for bad in ("abc", "第二秒"):
            self.assertIn(bad, msg)

    def test_nan_and_inf_rejected(self):
        """float("nan") 不抛异常，但拿去 seek 只会更难查，所以也算写错了。"""
        code, lines, _ = self.run_detect(["--times", "nan,inf"])
        self.assertEqual(code, 2)
        self.assertIn("不是秒数", self.error_of(lines)["message"])

    def test_good_times_still_work(self):
        code, lines, _ = self.run_detect(["--times", "1.2, 5.4,8.8"])
        self.assertEqual(code, 0)
        self.assertEqual([s["t"] for s in self.result_of(lines)["samples"]], [1.2, 5.4, 8.8])


class TestGrabFailureIsMarked(DetectHarness):
    """抽帧失败的样本不能和「这一帧真的没有人」长得一模一样。"""

    def _grab_fails_at(self, bad_t):
        def grab(ffmpeg, video, t, w, h):
            if abs(t - bad_t) < 1e-6:
                raise RuntimeError(f"抽 {t:.3f}s 那一帧失败：没有解出数据（时刻超出时长？）")
            return FRAME
        return grab

    def test_failed_sample_carries_flag_and_reason(self):
        code, lines, err = self.run_detect(
            ["--times", "0.5,999", "--engine", "light"], grab=self._grab_fails_at(999.0))
        self.assertEqual(code, 0, "一个时刻抽不出来不该让整批失败")
        res = self.result_of(lines)
        ok, bad = res["samples"]
        self.assertNotIn("failed", ok, "抽出来的那一帧不该带 failed")
        self.assertIs(bad["failed"], True)
        self.assertIn("999", bad["reason"])
        self.assertEqual(bad["boxes"], [])
        # 原因也照旧写一份到 stderr（node 侧的 stderrTail 会转发给界面）
        self.assertIn("999", err)

    def test_failed_count_in_result(self):
        code, lines, _ = self.run_detect(
            ["--times", "0.5,900,999", "--engine", "light"],
            grab=lambda ffmpeg, video, t, w, h: (
                FRAME if t < 100 else (_ for _ in ()).throw(RuntimeError(f"{t} 抽不出来"))))
        self.assertEqual(code, 0)
        res = self.result_of(lines)
        self.assertEqual(res["failedCount"], 2)
        self.assertEqual(sum(1 for s in res["samples"] if s.get("failed")), 2)

    def test_failed_count_is_zero_when_everything_works(self):
        code, lines, _ = self.run_detect(["--times", "0.5,1.5", "--engine", "light"])
        self.assertEqual(code, 0)
        self.assertEqual(self.result_of(lines)["failedCount"], 0)

    def test_real_empty_frame_has_no_failed_flag(self):
        """真的没人（检测返回空框）和抽帧失败必须分得开。"""
        code, lines, _ = self.run_detect(
            ["--times", "0.5", "--engine", "light"], light=lambda *a, **k: [[]])
        res = self.result_of(lines)
        self.assertEqual(res["samples"][0]["boxes"], [])
        self.assertNotIn("failed", res["samples"][0])
        self.assertEqual(res["failedCount"], 0)


class TestFullFallsBackToLight(DetectHarness):
    """full 档第一帧就推理失败：退回 light 重跑，别崩。"""

    BOOM = RuntimeError("stat: path should be string, bytes, os.PathLike or integer, not NoneType")

    def test_falls_back_and_marks_it(self):
        code, lines, err = self.run_detect(
            ["--times", "0.5,1.5,2.5", "--engine", "full"],
            full=lambda *a, **k: (_ for _ in ()).throw(self.BOOM))
        self.assertEqual(code, 0)
        res = self.result_of(lines)
        self.assertEqual(res["engine"], "light", "实际跑的是 light")
        self.assertEqual(res["fellBackFrom"], "full", "但得说清本来该跑 full")
        self.assertIn("RuntimeError", res["fallbackReason"], "原因要带异常类型")
        self.assertIn("NoneType", res["fallbackReason"])
        self.assertEqual(len(res["samples"]), 3, "退档之后要把**全部**时刻重跑一遍")
        self.assertTrue(all(s["boxes"] for s in res["samples"]))
        self.assertIn("grounding-dino-tiny", err, "stderr 里要点名 DINO 目录，人才知道去修哪")

    def test_fallback_notes_prompt_was_dropped(self):
        """带提示词退到 light：light 只认 person/face，这件事必须写出来。"""
        code, lines, _ = self.run_detect(
            ["--times", "0.5", "--engine", "full", "--prompt", "cat . dog ."],
            full=lambda *a, **k: (_ for _ in ()).throw(self.BOOM))
        self.assertEqual(code, 0)
        res = self.result_of(lines)
        self.assertEqual(res["engine"], "light")
        self.assertIn("提示词", res["fallbackReason"])
        self.assertEqual(res["prompt"], "cat . dog .", "提示词原样回显，免得分不清这批结果怎么来的")

    def test_no_fallback_field_on_normal_run(self):
        code, lines, _ = self.run_detect(["--times", "0.5", "--engine", "full"])
        res = self.result_of(lines)
        self.assertEqual(res["engine"], "full")
        self.assertNotIn("fellBackFrom", res)
        self.assertNotIn("fallbackReason", res)

    def test_light_not_ready_reports_locatable_error(self):
        """light 也不可用时只能报错，但那句话得能定位：异常类型 + DINO 目录。"""
        code, lines, _ = self.run_detect(
            ["--times", "0.5", "--engine", "full"],
            info=fake_info(light_ready=False, full_ready=True),
            full=lambda *a, **k: (_ for _ in ()).throw(self.BOOM))
        self.assertEqual(code, 3)
        err = self.error_of(lines)
        self.assertIn("RuntimeError", err["message"])
        self.assertIn("grounding-dino-tiny", err["message"])
        self.assertIn("onnxruntime", err["message"], "还要说清 light 为什么也用不了")
        self.assertIsNotNone(err.get("detail"), "detail 里带完整 status，界面据此提示装哪个包")
        self.assertNotIn("未预期的错误", err["message"])

    def test_light_first_frame_failure_reports_light_paths(self):
        code, lines, _ = self.run_detect(
            ["--times", "0.5", "--engine", "light"],
            light=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("onnx 图坏了")))
        self.assertEqual(code, 3)
        msg = self.error_of(lines)["message"]
        self.assertIn("RuntimeError", msg)
        self.assertIn("yunet.onnx", msg)

    def test_failure_after_first_frame_is_not_swallowed(self):
        """跑到第二帧才炸不算「这一档跑不起来」，退回去重跑没意义，交给兜底报错。"""
        calls = {"n": 0}

        def flaky(*a, **k):
            calls["n"] += 1
            if calls["n"] == 1:
                return [list(ONE_BOX)]
            raise RuntimeError("第二帧炸了")

        code, lines, _ = self.run_detect(
            ["--times", "0.5,1.5", "--engine", "full"], full=flaky)
        self.assertEqual(code, 1)
        self.assertIn("第二帧炸了", self.error_of(lines)["message"])
        self.assertIsNone(self.result_of(lines), "半截结果不能当成功结果发出去")


if __name__ == "__main__":
    unittest.main()
