"""Unit tests for the full-tier backend (Grounding DINO).

Two layers:
  - Pure-function layer (prompt normalization, size conversion, path resolution, label cleaning): no torch needed,
    so it can run completely in the built-in interpreter (numpy only), on every commit;
  - Inference layer: skipped if any one of torch / transformers / the model directory is missing. On the dev machine
    "C:/Users/admin/anaconda3/envs/cuda_Vit/python.exe" together with PROMPTCUT_MODELS
    pointing at tools/subject/out does it actually run.

No network: models are always local_files_only, and the tests never download anything.
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

import numpy as np

from promptcut_subject import dino


class TestPromptNormalize(unittest.TestCase):
    """Grounding DINO is picky about the prompt format: lowercase + " . " separators + a trailing period."""

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
    """Never upscale (upscaling only burns compute, see the measurements at NATIVE_SIZE)."""

    def test_native_keeps_frame_size(self):
        """Default None: the frame stays at its own size, not a pixel changed."""
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
        """max_side <= 0 means handing control back to the official preprocessing (800/1333); None is returned here so nothing is overridden."""
        self.assertIsNone(dino._size_for(640, 360, 0))
        self.assertIsNone(dino._size_for(640, 360, -1))


class TestModelDir(unittest.TestCase):
    """Path resolution must be exactly the same as models_dir() of promptcut_shots."""

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
            # Only config.json is there and the weights are missing: not counted as ready
            with open(os.path.join(tmp, "config.json"), "w") as fh:
                fh.write("{}")
            self.assertFalse(dino.model_ready(tmp))
            for name in dino.REQUIRED_FILES:
                with open(os.path.join(tmp, name), "w") as fh:
                    fh.write("{}")
            # All required files are present, but there is no vocabulary at all: still not counted as ready (a real load would blow up with TypeError)
            self.assertFalse(dino.model_ready(tmp))
            with open(os.path.join(tmp, "tokenizer.json"), "w") as fh:
                fh.write("{}")
            self.assertTrue(dino.model_ready(tmp))

    def test_model_ready_rejects_missing_tokenizer(self):
        """This is a scenario found by the validator in real testing: an interrupted copy / antivirus software blocking small files leaves only the three big files.

        The old criterion (config + safetensors + preprocessor_config) would say "ready",
        so status reported engine=full, and detect went all the way into transformers before blowing up with
        "TypeError: stat: path should be string, ... not NoneType", a message that
        neither shows what is missing nor falls back to light.
        """
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("config.json", "model.safetensors", "preprocessor_config.json"):
                with open(os.path.join(tmp, name), "w") as fh:
                    fh.write("{}")
            self.assertFalse(dino.model_ready(tmp), "Only the three big files left must not count as ready")
            lacks = dino.missing_files(tmp)
            self.assertIn("tokenizer_config.json", lacks)
            self.assertTrue(any("vocab.txt" in x for x in lacks), lacks)

    def test_tokenizer_json_or_vocab_txt_either_is_enough(self):
        """Measured (transformers 4.57.6): deleting either one of the two vocabularies still loads, only deleting both blows up."""
        import tempfile
        for keep in dino.TOKENIZER_FILES:
            with tempfile.TemporaryDirectory() as tmp:
                for name in dino.REQUIRED_FILES + (keep,):
                    with open(os.path.join(tmp, name), "w") as fh:
                        fh.write("{}")
                self.assertTrue(dino.model_ready(tmp), f"Keeping only {keep} should also count as ready")

    def test_missing_files_names_the_whole_dir(self):
        lacks = dino.missing_files(os.path.join(os.path.dirname(__file__), "no-such-dir"))
        self.assertEqual(len(lacks), 1)
        self.assertIn("no-such-dir", lacks[0])

    @unittest.skipUnless(os.path.isdir(dino.default_model_dir()),
                         "No real weights directory (set PROMPTCUT_MODELS to point at tools/subject/out to run)")
    def test_real_snapshot_satisfies_the_criteria(self):
        """The criteria must not be stricter than a real HF snapshot, otherwise a correct install is reported as not installed."""
        self.assertEqual(dino.missing_files(), [], dino.default_model_dir())


class TestCleanLabel(unittest.TestCase):
    def test_strips_periods(self):
        self.assertEqual(dino._clean_label("person .", "x"), "person")

    def test_int_label_falls_back(self):
        """In newer transformers the labels field becomes integer ids, in which case the nouns in the prompt are used as the fallback."""
        self.assertEqual(dino._clean_label(3, "person"), "person")

    def test_blank_falls_back(self):
        self.assertEqual(dino._clean_label("  . ", "face"), "face")


class TestEmptyInput(unittest.TestCase):
    def test_no_frames_no_model_load(self):
        """An empty list must return **before** the model is loaded, otherwise a machine without the engine blows up for nothing."""
        self.assertEqual(dino.detect([]), [])


def engine_missing() -> str:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except Exception as exc:
        return f"No torch/transformers: {exc}"
    if not dino.model_ready():
        return f"The model directory is incomplete: {dino.default_model_dir()}"
    return ""


@unittest.skipIf(engine_missing(), engine_missing() or "engine ok")
class TestDetectContract(unittest.TestCase):
    """Run real inference once, verifying only the interface contract.

    It deliberately does **not** verify "whether a drawn human shape gets detected": a fake person on a synthetic image does not represent real performance,
    and such an assertion would only turn red at random. The results on real media are in the measurement records in tools/subject/README.md.
    """

    @classmethod
    def setUpClass(cls):
        # 360x640 portrait, the same shape as after __main__ scales to max-side 640
        rng = np.random.default_rng(0)
        cls.frames = [rng.integers(0, 256, (640, 360, 3), dtype=np.uint8) for _ in range(2)]

    def test_shape_of_result(self):
        out = dino.detect(self.frames, prompt="person . face .")
        self.assertIsInstance(out, list)
        self.assertEqual(len(out), len(self.frames), "The number of returned frames must match the number passed in")
        for per_frame in out:
            self.assertIsInstance(per_frame, list)

    def test_boxes_are_in_frame_and_well_formed(self):
        h, w = self.frames[0].shape[:2]
        # Set the threshold very low to force it to produce a few boxes, so the coordinate validation actually runs
        out = dino.detect(self.frames[:1], prompt="person . face .", box_threshold=0.01,
                          text_threshold=0.01)
        self.assertGreater(len(out[0]), 0, "Not a single box even at threshold 0.01 means something is wrong in the inference chain")
        for box in out[0]:
            self.assertEqual(set(box), {"label", "x", "y", "w", "h", "conf"})
            self.assertIsInstance(box["label"], str)
            self.assertTrue(box["label"])
            for k in ("x", "y", "w", "h"):
                self.assertIsInstance(box[k], int, f"{k} must be integer pixels")
            self.assertGreaterEqual(box["x"], 0)
            self.assertGreaterEqual(box["y"], 0)
            self.assertGreater(box["w"], 0)
            self.assertGreater(box["h"], 0)
            self.assertLessEqual(box["x"] + box["w"], w, "The box exceeds the right edge of the frame, so the clamping did not take effect")
            self.assertLessEqual(box["y"] + box["h"], h, "The box exceeds the bottom edge of the frame")
            self.assertGreater(box["conf"], 0.0)
            self.assertLessEqual(box["conf"], 1.0)

    def test_labels_come_from_prompt(self):
        out = dino.detect(self.frames[:1], prompt="dog . bicycle .", box_threshold=0.01,
                          text_threshold=0.01)
        terms = set(dino.prompt_terms("dog . bicycle ."))
        for box in out[0]:
            # The label is part of a noun phrase in the prompt (DINO splits the phrase apart for matching)
            self.assertTrue(
                any(t in box["label"] or box["label"] in t for t in terms),
                f"Label {box['label']!r} does not match prompt {terms}",
            )

    def test_sorted_by_confidence(self):
        out = dino.detect(self.frames[:1], prompt="person . face .", box_threshold=0.01,
                          text_threshold=0.01)
        confs = [b["conf"] for b in out[0]]
        self.assertEqual(confs, sorted(confs, reverse=True))

    def test_model_path_alias(self):
        """__main__ passes the path to all three backends uniformly as model_path=, so do not recognize only model_dir."""
        out = dino.detect(self.frames[:1], prompt="person .",
                          model_path=dino.default_model_dir())
        self.assertEqual(len(out), 1)

    def test_bad_shape_rejected(self):
        with self.assertRaises(ValueError):
            dino.detect([np.zeros((64, 64), dtype=np.uint8)])


if __name__ == "__main__":
    unittest.main()
