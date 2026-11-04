"""Downgrade behavior of the detect subcommand: a failed frame grab must leave a marker, a full tier that cannot run must fall back to light,
and a wrong argument must be reported in plain language.

**No inference engine is needed here**: probe / grab_frame / the detect of all three backends are stubbed,
so the built-in interpreter (numpy only) can run the whole suite. The parts that run real inference are in
test_subject_light.py / test_subject_dino.py, and are skipped when the engine is missing.

Why this deserves a file of its own: all three are "what it looks like when something goes wrong", and the error path is exactly the one nobody
tries by hand. The two pitfalls the validator hit in real testing are right here:
  - `detect out/test.mp4 --times 0.5,999` (999 is beyond the 5.0s duration) used to give
    {"t":999.0,"boxes":[],"safeSide":"right","occupancy":{four 0s}}, which is identical, field by field, to "this frame
    really has nobody in it";
  - When the DINO directory lacks the tokenizer, status reports full as ready and detect crashes inside transformers.
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
    """The return value of probe(), with fields matching the real one one-to-one (it just doesn't look at the disk)."""
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
    """Run detect in the stubbed world and return (exit code, JSON lines from stdout, stderr)."""

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
    """A wrong --times is an argument error (exit 2), not an "unexpected error" (exit 1)."""

    def test_non_numeric_chunk_named_in_message(self):
        code, lines, _ = self.run_detect(["--times", "1.0,abc,2.0"])
        self.assertEqual(code, 2)
        err = self.error_of(lines)
        self.assertIn("abc", err["message"])
        self.assertIn("1.2,5.4,8.8", err["message"], "It must give a form that can be copied verbatim")
        self.assertNotIn("unexpected error", err["message"])

    def test_all_bad_chunks_listed(self):
        code, lines, _ = self.run_detect(["--times", "abc,1.0,second-two"])
        self.assertEqual(code, 2)
        msg = self.error_of(lines)["message"]
        for bad in ("abc", "second-two"):
            self.assertIn(bad, msg)

    def test_nan_and_inf_rejected(self):
        """float("nan") does not raise, but using it for a seek would only be harder to debug, so it also counts as a bad value."""
        code, lines, _ = self.run_detect(["--times", "nan,inf"])
        self.assertEqual(code, 2)
        self.assertIn("is not a number of seconds", self.error_of(lines)["message"])

    def test_good_times_still_work(self):
        code, lines, _ = self.run_detect(["--times", "1.2, 5.4,8.8"])
        self.assertEqual(code, 0)
        self.assertEqual([s["t"] for s in self.result_of(lines)["samples"]], [1.2, 5.4, 8.8])


class TestGrabFailureIsMarked(DetectHarness):
    """A sample whose frame grab failed must not look exactly like "this frame really has nobody in it"."""

    def _grab_fails_at(self, bad_t):
        def grab(ffmpeg, video, t, w, h):
            if abs(t - bad_t) < 1e-6:
                raise RuntimeError(f"Grabbing the frame at {t:.3f}s failed: no data was decoded (time beyond the duration?)")
            return FRAME
        return grab

    def test_failed_sample_carries_flag_and_reason(self):
        code, lines, err = self.run_detect(
            ["--times", "0.5,999", "--engine", "light"], grab=self._grab_fails_at(999.0))
        self.assertEqual(code, 0, "One time that cannot be grabbed must not fail the whole batch")
        res = self.result_of(lines)
        ok, bad = res["samples"]
        self.assertNotIn("failed", ok, "A frame that was grabbed must not carry failed")
        self.assertIs(bad["failed"], True)
        self.assertIn("999", bad["reason"])
        self.assertEqual(bad["boxes"], [])
        # The reason is also written to stderr as before (the stderrTail on the node side forwards it to the UI)
        self.assertIn("999", err)

    def test_failed_count_in_result(self):
        code, lines, _ = self.run_detect(
            ["--times", "0.5,900,999", "--engine", "light"],
            grab=lambda ffmpeg, video, t, w, h: (
                FRAME if t < 100 else (_ for _ in ()).throw(RuntimeError(f"{t} cannot be grabbed"))))
        self.assertEqual(code, 0)
        res = self.result_of(lines)
        self.assertEqual(res["failedCount"], 2)
        self.assertEqual(sum(1 for s in res["samples"] if s.get("failed")), 2)

    def test_failed_count_is_zero_when_everything_works(self):
        code, lines, _ = self.run_detect(["--times", "0.5,1.5", "--engine", "light"])
        self.assertEqual(code, 0)
        self.assertEqual(self.result_of(lines)["failedCount"], 0)

    def test_real_empty_frame_has_no_failed_flag(self):
        """A frame that really has nobody (detection returns empty boxes) must be distinguishable from a failed frame grab."""
        code, lines, _ = self.run_detect(
            ["--times", "0.5", "--engine", "light"], light=lambda *a, **k: [[]])
        res = self.result_of(lines)
        self.assertEqual(res["samples"][0]["boxes"], [])
        self.assertNotIn("failed", res["samples"][0])
        self.assertEqual(res["failedCount"], 0)


class TestFullFallsBackToLight(DetectHarness):
    """Inference fails already on the first frame of the full tier: fall back to light and rerun, do not crash."""

    BOOM = RuntimeError("stat: path should be string, bytes, os.PathLike or integer, not NoneType")

    def test_falls_back_and_marks_it(self):
        code, lines, err = self.run_detect(
            ["--times", "0.5,1.5,2.5", "--engine", "full"],
            full=lambda *a, **k: (_ for _ in ()).throw(self.BOOM))
        self.assertEqual(code, 0)
        res = self.result_of(lines)
        self.assertEqual(res["engine"], "light", "What actually ran is light")
        self.assertEqual(res["fellBackFrom"], "full", "But it must say that full was supposed to run")
        self.assertIn("RuntimeError", res["fallbackReason"], "The reason must carry the exception type")
        self.assertIn("NoneType", res["fallbackReason"])
        self.assertEqual(len(res["samples"]), 3, "After falling back a tier, **all** times must be rerun")
        self.assertTrue(all(s["boxes"] for s in res["samples"]))
        self.assertIn("grounding-dino-tiny", err, "stderr must name the DINO directory so people know where to fix")

    def test_fallback_notes_prompt_was_dropped(self):
        """Falling back to light with a prompt: light only recognizes person/face, and this must be spelled out."""
        code, lines, _ = self.run_detect(
            ["--times", "0.5", "--engine", "full", "--prompt", "cat . dog ."],
            full=lambda *a, **k: (_ for _ in ()).throw(self.BOOM))
        self.assertEqual(code, 0)
        res = self.result_of(lines)
        self.assertEqual(res["engine"], "light")
        self.assertIn("prompt", res["fallbackReason"])
        self.assertEqual(res["prompt"], "cat . dog .", "The prompt is echoed back as is, so one can tell how this batch of results came about")

    def test_no_fallback_field_on_normal_run(self):
        code, lines, _ = self.run_detect(["--times", "0.5", "--engine", "full"])
        res = self.result_of(lines)
        self.assertEqual(res["engine"], "full")
        self.assertNotIn("fellBackFrom", res)
        self.assertNotIn("fallbackReason", res)

    def test_light_not_ready_reports_locatable_error(self):
        """When light is also unavailable all it can do is report an error, but that message must be locatable: exception type + DINO directory."""
        code, lines, _ = self.run_detect(
            ["--times", "0.5", "--engine", "full"],
            info=fake_info(light_ready=False, full_ready=True),
            full=lambda *a, **k: (_ for _ in ()).throw(self.BOOM))
        self.assertEqual(code, 3)
        err = self.error_of(lines)
        self.assertIn("RuntimeError", err["message"])
        self.assertIn("grounding-dino-tiny", err["message"])
        self.assertIn("onnxruntime", err["message"], "It must also say why light cannot be used either")
        self.assertIsNotNone(err.get("detail"), "detail carries the full status, from which the UI tells which package to install")
        self.assertNotIn("unexpected error", err["message"])

    def test_light_first_frame_failure_reports_light_paths(self):
        code, lines, _ = self.run_detect(
            ["--times", "0.5", "--engine", "light"],
            light=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("onnx graph is broken")))
        self.assertEqual(code, 3)
        msg = self.error_of(lines)["message"]
        self.assertIn("RuntimeError", msg)
        self.assertIn("yunet.onnx", msg)

    def test_failure_after_first_frame_is_not_swallowed(self):
        """Blowing up only at the second frame does not count as "this tier cannot run"; falling back and rerunning is pointless, so leave it to the fallback error report."""
        calls = {"n": 0}

        def flaky(*a, **k):
            calls["n"] += 1
            if calls["n"] == 1:
                return [list(ONE_BOX)]
            raise RuntimeError("The second frame blew up")

        code, lines, _ = self.run_detect(
            ["--times", "0.5,1.5", "--engine", "full"], full=flaky)
        self.assertEqual(code, 1)
        self.assertIn("The second frame blew up", self.error_of(lines)["message"])
        self.assertIsNone(self.result_of(lines), "A half-finished result must not be sent out as a successful one")


if __name__ == "__main__":
    unittest.main()
