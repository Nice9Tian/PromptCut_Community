"""audio extraction: use ffmpeg to build a 2-second sine-wave mp4 and extract it to a 16k mono wav.

Skipped when ffmpeg is absent: these cases verify our interface to ffmpeg, not ffmpeg itself.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
import wave

from promptcut_stt import audio

HAS_FFMPEG = shutil.which("ffmpeg") is not None


def make_test_mp4(path):
    """2-second 440 Hz sine wave + black-background video. Falls back to mpeg4 when libx264 is unavailable."""
    base = [
        shutil.which("ffmpeg"),
        "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2",
        "-shortest",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
    ]
    for vcodec in ("libx264", "mpeg4"):
        proc = subprocess.run(
            base + ["-c:v", vcodec, path],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if proc.returncode == 0 and os.path.isfile(path):
            return vcodec
    raise RuntimeError("ffmpeg failed to build the test video:\n" + (proc.stderr or "")[-2000:])


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg not found")
class TestAudio(unittest.TestCase):
    def test_extract_16k_mono_from_mp4(self):
        with tempfile.TemporaryDirectory() as tmp:
            mp4 = os.path.join(tmp, "sample.mp4")
            make_test_mp4(mp4)

            # an mp4 is obviously not the target wav
            self.assertFalse(audio.is_wav_16k_mono(mp4))

            wav_path, converted = audio.ensure_wav(mp4, tmp)
            self.assertTrue(converted)
            self.assertTrue(os.path.isfile(wav_path))
            self.assertTrue(audio.is_wav_16k_mono(wav_path))

            with wave.open(wav_path, "rb") as wav:
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getframerate(), 16000)
                self.assertEqual(wav.getsampwidth(), 2)
                seconds = wav.getnframes() / float(wav.getframerate())
            self.assertAlmostEqual(seconds, 2.0, delta=0.3)

    def test_ensure_wav_passes_through_conforming_wav(self):
        with tempfile.TemporaryDirectory() as tmp:
            mp4 = os.path.join(tmp, "sample.mp4")
            make_test_mp4(mp4)
            wav_path, _ = audio.ensure_wav(mp4, tmp)

            # A wav that is already 16k mono: return it as is, without extracting again
            again, converted = audio.ensure_wav(wav_path, tmp)
            self.assertFalse(converted)
            self.assertEqual(again, wav_path)

    def test_probe_duration(self):
        if not shutil.which("ffprobe"):
            self.skipTest("ffprobe not found")
        with tempfile.TemporaryDirectory() as tmp:
            mp4 = os.path.join(tmp, "sample.mp4")
            make_test_mp4(mp4)
            self.assertAlmostEqual(audio.probe_duration(mp4), 2.0, delta=0.3)

    def test_probe_duration_returns_none_for_garbage(self):
        with tempfile.TemporaryDirectory() as tmp:
            junk = os.path.join(tmp, "junk.bin")
            with open(junk, "wb") as handle:
                handle.write(b"not media")
            self.assertIsNone(audio.probe_duration(junk))

    def test_extract_error_on_garbage(self):
        with tempfile.TemporaryDirectory() as tmp:
            junk = os.path.join(tmp, "junk.bin")
            with open(junk, "wb") as handle:
                handle.write(b"not media")
            with self.assertRaises(audio.AudioExtractError):
                audio.ensure_wav(junk, tmp)


class TestIsWav(unittest.TestCase):
    def test_non_wav_returns_false_not_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            junk = os.path.join(tmp, "junk.bin")
            with open(junk, "wb") as handle:
                handle.write(b"not a wav")
            self.assertFalse(audio.is_wav_16k_mono(junk))
            self.assertFalse(audio.is_wav_16k_mono(os.path.join(tmp, "missing.wav")))


if __name__ == "__main__":
    unittest.main()
