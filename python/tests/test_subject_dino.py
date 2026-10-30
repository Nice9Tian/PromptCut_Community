"""full 档后端（Grounding DINO）的单测。

分两层：
  - 纯函数层（提示归一化、尺寸换算、路径解析、标签清洗）：不需要 torch，
    内置解释器（只有 numpy）里也能全跑，随每次提交跑；
  - 推理层：torch / transformers / 模型目录任缺其一就 skip。开发机上
    "C:/Users/admin/anaconda3/envs/cuda_Vit/python.exe" 配 PROMPTCUT_MODELS
    指向 tools/subject/out 才会真的跑起来。

不联网：模型一律 local_files_only，测试也从不下载任何东西。
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

import numpy as np

from promptcut_subject import dino


class TestPromptNormalize(unittest.TestCase):
    """Grounding DINO 对提示的格式很挑：小写 + 「 . 」分隔 + 结尾句点。"""

    def test_adds_trailing_period(self):
        self.assertTrue(dino._normalize_prompt("person . face").endswith("."))

    def test_lowercases(self):
        self.assertEqual(dino._normalize_prompt("Person . FACE ."), "person . face .")

    def test_empty_falls_back_to_default(self):
        for bad in (None, "", "   "):
            self.assertEqual(dino._normalize_prompt(bad), dino.DEFAULT_PROMPT)

    def test_terms(self):
        self.assertEqual(dino.prompt_terms("person . face . red cup ."),
                         ["person", "face", "red cup"])


class TestSizeFor(unittest.TestCase):
    """绝不放大（放大只烧算力，见 NATIVE_SIZE 那段实测）。"""

    def test_native_keeps_frame_size(self):
        """默认 None：帧多大就多大，一个像素不动。"""
        self.assertEqual(dino._size_for(640, 360, None),
                         {"shortest_edge": 360, "longest_edge": 640})

    def test_no_upscale_when_under_limit(self):
        self.assertEqual(dino._size_for(640, 360, 640),
                         {"shortest_edge": 360, "longest_edge": 640})
        self.assertEqual(dino._size_for(640, 360, 1333),
                         {"shortest_edge": 360, "longest_edge": 640})

    def test_downscale_keeps_ratio(self):
        size = dino._size_for(1920, 1080, 640)
        self.assertEqual(size["longest_edge"], 640)
        # 1080 * 640 / 1920 = 360
        self.assertEqual(size["shortest_edge"], 360)

    def test_landscape(self):
        size = dino._size_for(720, 1280, 640)
        self.assertEqual(size, {"shortest_edge": 360, "longest_edge": 640})

    def test_official_preprocessing(self):
        """max_side <= 0 表示交还给官方预处理（800/1333），这里返回 None 不覆盖。"""
        self.assertIsNone(dino._size_for(640, 360, 0))
        self.assertIsNone(dino._size_for(640, 360, -1))


class TestModelDir(unittest.TestCase):
    """路径解析要和 promptcut_shots 的 models_dir() 完全一致。"""

    def test_models_env_wins(self):
        with mock.patch.dict(os.environ, {"PROMPTCUT_MODELS": r"X:\m",
                                          "PROMPTCUT_DATA_DIR": r"X:\d"}, clear=False):
            self.assertEqual(dino.models_dir(), r"X:\m")

    def test_data_dir_fallback(self):
        env = dict(os.environ)
        env.pop("PROMPTCUT_MODELS", None)
        env["PROMPTCUT_DATA_DIR"] = os.path.join("X:", "d")
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(dino.models_dir(), os.path.join("X:", "d", "models"))

    def test_default_model_dir_ends_with_dirname(self):
        self.assertTrue(dino.default_model_dir().endswith(dino.MODEL_DIRNAME))

    def test_model_ready_false_on_missing(self):
        self.assertFalse(dino.model_ready(os.path.join(os.path.dirname(__file__), "no-such-dir")))

    def test_model_ready_needs_all_files(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            # 只放 config.json，缺权重 —— 不算就绪
            with open(os.path.join(tmp, "config.json"), "w") as fh:
                fh.write("{}")
            self.assertFalse(dino.model_ready(tmp))
            for name in dino.REQUIRED_FILES:
                with open(os.path.join(tmp, name), "w") as fh:
                    fh.write("{}")
            # 必需文件齐了，但一个词表都没有 —— 还是不算就绪（真加载会炸 TypeError）
            self.assertFalse(dino.model_ready(tmp))
            with open(os.path.join(tmp, "tokenizer.json"), "w") as fh:
                fh.write("{}")
            self.assertTrue(dino.model_ready(tmp))

    def test_model_ready_rejects_missing_tokenizer(self):
        """这是校验员实测出的场景：拷贝中断/杀毒软件拦小文件，只剩三个大件。

        以前的判据（config + safetensors + preprocessor_config）会说「就绪」，
        于是 status 报 engine=full，detect 一路走到 transformers 内部才炸出
        「TypeError: stat: path should be string, ... not NoneType」——这句话
        既看不出缺什么、也不会退回 light。
        """
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("config.json", "model.safetensors", "preprocessor_config.json"):
                with open(os.path.join(tmp, name), "w") as fh:
                    fh.write("{}")
            self.assertFalse(dino.model_ready(tmp), "只剩三个大件不能算就绪")
            lacks = dino.missing_files(tmp)
            self.assertIn("tokenizer_config.json", lacks)
            self.assertTrue(any("vocab.txt" in x for x in lacks), lacks)

    def test_tokenizer_json_or_vocab_txt_either_is_enough(self):
        """实测（transformers 4.57.6）：两个词表删掉任一个还能加载，两个都删才炸。"""
        import tempfile
        for keep in dino.TOKENIZER_FILES:
            with tempfile.TemporaryDirectory() as tmp:
                for name in dino.REQUIRED_FILES + (keep,):
                    with open(os.path.join(tmp, name), "w") as fh:
                        fh.write("{}")
                self.assertTrue(dino.model_ready(tmp), f"只留 {keep} 应该也算就绪")

    def test_missing_files_names_the_whole_dir(self):
        lacks = dino.missing_files(os.path.join(os.path.dirname(__file__), "no-such-dir"))
        self.assertEqual(len(lacks), 1)
        self.assertIn("no-such-dir", lacks[0])

    @unittest.skipUnless(os.path.isdir(dino.default_model_dir()),
                         "没有真权重目录（设 PROMPTCUT_MODELS 指向 tools/subject/out 才跑）")
    def test_real_snapshot_satisfies_the_criteria(self):
        """判据不能比真实的 HF snapshot 还严，否则装对了也报没装。"""
        self.assertEqual(dino.missing_files(), [], dino.default_model_dir())


class TestCleanLabel(unittest.TestCase):
    def test_strips_periods(self):
        self.assertEqual(dino._clean_label("person .", "x"), "person")

    def test_int_label_falls_back(self):
        """新版 transformers 的 labels 字段会变成整数 id，这时用提示里的名词兜底。"""
        self.assertEqual(dino._clean_label(3, "person"), "person")

    def test_blank_falls_back(self):
        self.assertEqual(dino._clean_label("  . ", "face"), "face")


class TestEmptyInput(unittest.TestCase):
    def test_no_frames_no_model_load(self):
        """空列表要在加载模型**之前**就返回，否则没装引擎的机器上会白炸一次。"""
        self.assertEqual(dino.detect([]), [])


def engine_missing() -> str:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except Exception as exc:
        return f"没有 torch/transformers：{exc}"
    if not dino.model_ready():
        return f"模型目录不完整：{dino.default_model_dir()}"
    return ""


@unittest.skipIf(engine_missing(), engine_missing() or "engine ok")
class TestDetectContract(unittest.TestCase):
    """真跑一次推理，只验接口契约。

    刻意**不**验「画一个人形能不能检出来」：合成图上的假人不代表真实表现，
    那种断言只会随机红。真实素材上的效果由 tools/subject/README.md 里的实测记录。
    """

    @classmethod
    def setUpClass(cls):
        # 360x640 竖屏，和 __main__ 缩到 max-side 640 之后的形状一致
        rng = np.random.default_rng(0)
        cls.frames = [rng.integers(0, 256, (640, 360, 3), dtype=np.uint8) for _ in range(2)]

    def test_shape_of_result(self):
        out = dino.detect(self.frames, prompt="person . face .")
        self.assertIsInstance(out, list)
        self.assertEqual(len(out), len(self.frames), "返回的帧数必须和传入的一致")
        for per_frame in out:
            self.assertIsInstance(per_frame, list)

    def test_boxes_are_in_frame_and_well_formed(self):
        h, w = self.frames[0].shape[:2]
        # 阈值放到很低，逼它出几个框，好把坐标校验真的跑起来
        out = dino.detect(self.frames[:1], prompt="person . face .", box_threshold=0.01,
                          text_threshold=0.01)
        self.assertGreater(len(out[0]), 0, "阈值 0.01 还一个框都没有，说明推理链路有问题")
        for box in out[0]:
            self.assertEqual(set(box), {"label", "x", "y", "w", "h", "conf"})
            self.assertIsInstance(box["label"], str)
            self.assertTrue(box["label"])
            for k in ("x", "y", "w", "h"):
                self.assertIsInstance(box[k], int, f"{k} 要是整数像素")
            self.assertGreaterEqual(box["x"], 0)
            self.assertGreaterEqual(box["y"], 0)
            self.assertGreater(box["w"], 0)
            self.assertGreater(box["h"], 0)
            self.assertLessEqual(box["x"] + box["w"], w, "框超出帧右边界，说明夹取没生效")
            self.assertLessEqual(box["y"] + box["h"], h, "框超出帧下边界")
            self.assertGreater(box["conf"], 0.0)
            self.assertLessEqual(box["conf"], 1.0)

    def test_labels_come_from_prompt(self):
        out = dino.detect(self.frames[:1], prompt="dog . bicycle .", box_threshold=0.01,
                          text_threshold=0.01)
        terms = set(dino.prompt_terms("dog . bicycle ."))
        for box in out[0]:
            # 标签是提示里名词短语的一部分（DINO 会把短语切开来匹配）
            self.assertTrue(
                any(t in box["label"] or box["label"] in t for t in terms),
                f"标签 {box['label']!r} 和提示 {terms} 对不上",
            )

    def test_sorted_by_confidence(self):
        out = dino.detect(self.frames[:1], prompt="person . face .", box_threshold=0.01,
                          text_threshold=0.01)
        confs = [b["conf"] for b in out[0]]
        self.assertEqual(confs, sorted(confs, reverse=True))

    def test_model_path_alias(self):
        """__main__ 对三个后端统一用 model_path= 传路径，别只认 model_dir。"""
        out = dino.detect(self.frames[:1], prompt="person .",
                          model_path=dino.default_model_dir())
        self.assertEqual(len(out), 1)

    def test_bad_shape_rejected(self):
        with self.assertRaises(ValueError):
            dino.detect([np.zeros((64, 64), dtype=np.uint8)])


if __name__ == "__main__":
    unittest.main()
