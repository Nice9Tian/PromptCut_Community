"""light 档：抽帧/缩放这些纯 numpy 的部分逐个验；真推理的部分在引擎缺失时跳过。

内置解释器只有 numpy，所以这里默认只跑得到「几何」那几组；装了 onnxruntime
并且 PROMPTCUT_MODELS 指到真权重时，才会连 YuNet / RT-DETR 一起验。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402

from promptcut_subject import frames as F  # noqa: E402
from promptcut_subject.__main__ import (  # noqa: E402
    DINO_DIR, RTDETR_FILE, YUNET_FILE, parse_times, parse_times_strict, pick_engine,
)


def models_dir():
    return os.environ.get("PROMPTCUT_MODELS") or ""


def require_light():
    """没装 onnxruntime 或没有权重就跳过，不算失败。"""
    try:
        import onnxruntime  # noqa: F401
    except Exception as exc:
        raise unittest.SkipTest(f"没装 onnxruntime：{exc}")
    md = models_dir()
    if not md:
        raise unittest.SkipTest("没设 PROMPTCUT_MODELS，找不到权重")
    for name in (YUNET_FILE, RTDETR_FILE):
        if not os.path.isfile(os.path.join(md, name)):
            raise unittest.SkipTest(f"缺权重 {name}")
    return md


class TestGeometry(unittest.TestCase):
    def test_target_size_only_shrinks(self):
        self.assertEqual(F.target_size(1920, 1080, 640), (640, 360))
        self.assertEqual(F.target_size(1080, 1920, 640), (360, 640))
        self.assertEqual(F.target_size(320, 240, 640), (320, 240))  # 小的不放大

    def test_resize_keeps_constant_image(self):
        img = np.full((30, 40, 3), 137, dtype=np.uint8)
        out = F.resize_bilinear(img, 17, 23)
        self.assertEqual(out.shape, (23, 17, 3))
        self.assertTrue(np.allclose(out, 137.0))

    def test_resize_is_a_noop_on_same_size(self):
        img = (np.arange(12 * 8 * 3, dtype=np.uint8).reshape(12, 8, 3))
        out = F.resize_bilinear(img, 8, 12)
        self.assertTrue(np.array_equal(out, img.astype(np.float32)))

    def test_resize_gradient_stays_monotonic(self):
        """横向渐变缩放后仍然是单调递增的 —— 采样点算错会出现来回抖。"""
        row = np.linspace(0, 255, 64, dtype=np.float32)
        img = np.repeat(row[None, :, None], 4, axis=0).repeat(3, axis=2).astype(np.uint8)
        out = F.resize_bilinear(img, 21, 4)[0, :, 0]
        self.assertTrue(np.all(np.diff(out) > 0), msg=str(out))

    def test_letterbox_pads_and_reports_scale(self):
        img = np.full((100, 200, 3), 200, dtype=np.uint8)
        canvas, scale = F.letterbox(img, 640)
        self.assertEqual(canvas.shape, (640, 640, 3))
        self.assertAlmostEqual(scale, 3.2, places=2)
        # 右下补的黑边确实是 0，上半部分是原图的值
        self.assertTrue(np.all(canvas[400:, :] == 0))
        self.assertTrue(np.allclose(canvas[10, 10], 200.0))

    def test_scale_boxes_back_to_original_pixels(self):
        got = F.scale_boxes([{"label": "face", "x": 10, "y": 20, "w": 30, "h": 40, "conf": 0.9}],
                            3.0, 1920, 1080)
        self.assertEqual(got[0]["x"], 30.0)
        self.assertEqual(got[0]["w"], 90.0)
        self.assertEqual(got[0]["label"], "face")

    def test_scale_boxes_clamps_to_frame(self):
        got = F.scale_boxes([{"label": "person", "x": -50, "y": -50, "w": 400, "h": 400}],
                            2.0, 640, 360)
        self.assertEqual(got[0]["x"], 0.0)
        self.assertEqual(got[0]["y"], 0.0)
        self.assertEqual(got[0]["w"], 640.0)
        self.assertEqual(got[0]["h"], 360.0)

    def test_scale_boxes_drops_fully_outside(self):
        self.assertEqual(F.scale_boxes([{"x": 700, "y": 0, "w": 10, "h": 10}], 1.0, 640, 360), [])


class TestArgs(unittest.TestCase):
    def test_parse_times(self):
        self.assertEqual(parse_times("1.2,5.4, 8.8"), [1.2, 5.4, 8.8])
        self.assertEqual(parse_times(""), [])
        self.assertEqual(parse_times("-3,0"), [0.0, 0.0])  # 负数夹到 0

    def test_parse_times_strict_collects_bad_chunks(self):
        """看不懂的片段要被单独收走，好让 detect 报「参数写错了」而不是「内部故障」。"""
        self.assertEqual(parse_times_strict("1.2,abc,5.4"), ([1.2, 5.4], ["abc"]))
        self.assertEqual(parse_times_strict("abc,第二秒")[1], ["abc", "第二秒"])
        self.assertEqual(parse_times_strict("1.2,5.4"), ([1.2, 5.4], []))
        # nan / inf 是 float() 认的，但不是秒数
        self.assertEqual(parse_times_strict("nan,inf,-inf,1")[0], [1.0])
        self.assertEqual(parse_times_strict("nan,inf,-inf,1")[1], ["nan", "inf", "-inf"])

    def test_pick_engine(self):
        both = {"light": {"ready": True}, "full": {"ready": True}}
        only_light = {"light": {"ready": True}, "full": {"ready": False}}
        neither = {"light": {"ready": False}, "full": {"ready": False}}
        # 默认走 light（CPU 上快一个数量级）
        self.assertEqual(pick_engine(both, None, None), "light")
        # 给了提示词且 full 在，才升到 full
        self.assertEqual(pick_engine(both, None, "dog ."), "full")
        # full 没装时提示词也只能走 light
        self.assertEqual(pick_engine(only_light, None, "dog ."), "light")
        # 显式指定优先
        self.assertEqual(pick_engine(both, "full", None), "full")
        self.assertIsNone(pick_engine(neither, None, None))


class TestEngines(unittest.TestCase):
    """真推理：需要 onnxruntime + 权重，缺了就跳过。"""

    def _person_frame(self):
        """合成一帧：灰底 + 右侧一个竖长方形。只验管线通不通，不验精度。"""
        img = np.full((360, 640, 3), 90, dtype=np.uint8)
        img[80:330, 380:520] = 200
        return img

    def test_yunet_runs_and_returns_face_boxes(self):
        md = require_light()
        from promptcut_subject import yunet

        out = yunet.detect([self._person_frame()], model_path=os.path.join(md, YUNET_FILE))
        self.assertEqual(len(out), 1)
        for b in out[0]:
            self.assertEqual(b["label"], "face")
            for k in ("x", "y", "w", "h", "conf"):
                self.assertIn(k, b)
            self.assertGreaterEqual(b["conf"], yunet.DEFAULT_SCORE)

    def test_rtdetr_runs_and_returns_person_boxes(self):
        md = require_light()
        from promptcut_subject import rtdetr

        out = rtdetr.detect([self._person_frame()], model_path=os.path.join(md, RTDETR_FILE))
        self.assertEqual(len(out), 1)
        for b in out[0]:
            self.assertEqual(b["label"], "person")
            self.assertGreaterEqual(b["conf"], rtdetr.DEFAULT_THRESHOLD)
            # 框必须落在传入帧的像素坐标系里（宽 640 高 360），不是归一化值
            self.assertLessEqual(b["x"] + b["w"], 640 * 1.05)
            self.assertLessEqual(b["y"] + b["h"], 360 * 1.05)

    def test_batch_of_two_frames(self):
        md = require_light()
        from promptcut_subject import rtdetr

        out = rtdetr.detect([self._person_frame(), self._person_frame()],
                            model_path=os.path.join(md, RTDETR_FILE))
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0], out[1])


class TestModelNames(unittest.TestCase):
    def test_filenames_match_the_contract(self):
        self.assertEqual(YUNET_FILE, "yunet.onnx")
        self.assertEqual(RTDETR_FILE, "rtdetr_r18vd.onnx")
        self.assertEqual(DINO_DIR, "grounding-dino-tiny")


if __name__ == "__main__":
    unittest.main()
