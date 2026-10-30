"""audio 抽取：用 ffmpeg 造一段 2 秒正弦波 mp4，抽成 16k 单声道 wav。

没有 ffmpeg 就跳过——这些用例验的是我们跟 ffmpeg 的接口，不是 ffmpeg 本身。
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
    """2 秒 440 Hz 正弦波 + 黑底视频。libx264 不可用时退回 mpeg4。"""
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
    raise RuntimeError("ffmpeg 造测试视频失败：\n" + (proc.stderr or "")[-2000:])


@unittest.skipUnless(HAS_FFMPEG, "未找到 ffmpeg")
class TestAudio(unittest.TestCase):
    def test_extract_16k_mono_from_mp4(self):
        with tempfile.TemporaryDirectory() as tmp:
            mp4 = os.path.join(tmp, "sample.mp4")
            make_test_mp4(mp4)

            # mp4 显然不是目标 wav
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

            # 已经是 16k 单声道的 wav：原样返回，不再抽一次
            again, converted = audio.ensure_wav(wav_path, tmp)
            self.assertFalse(converted)
            self.assertEqual(again, wav_path)

    def test_probe_duration(self):
        if not shutil.which("ffprobe"):
            self.skipTest("未找到 ffprobe")
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
