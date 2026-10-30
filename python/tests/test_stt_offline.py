"""云节点用的离线转写：status 报已放齐的权重、--offline 不联网、--requirements 指定锁定依赖、错误带 kind。

这些都是 P2（云端语音转写）新增的开关；不带开关时的行为由 test_status.py 等原有用例守着。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from unittest import mock

from .test_status import PACKAGE_ROOT, run_subcommand

if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

from promptcut_stt import audio  # noqa: E402


def make_snapshot(models_dir: str, name: str, complete: bool = True) -> None:
    base = os.path.join(models_dir, "models--Systran--faster-whisper-" + name, "snapshots", "rev1")
    os.makedirs(base)
    with open(os.path.join(base, "config.json"), "w", encoding="utf-8") as handle:
        handle.write("{}")
    if complete:
        with open(os.path.join(base, "model.bin"), "wb") as handle:
            handle.write(b"x")


def make_wav(path: str, seconds: float = 0.5) -> None:
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(b"\x00\x00" * int(16000 * seconds))


class TestStatusAvailableModels(unittest.TestCase):
    def test_only_complete_snapshots_are_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            models = os.path.join(tmp, "models")
            make_snapshot(models, "small", complete=True)
            make_snapshot(models, "tiny", complete=False)  # 缺 model.bin，不算
            proc = run_subcommand(["status"], {"PROMPTCUT_PYLIBS": os.path.join(tmp, "pylibs"), "PROMPTCUT_MODELS": models})
            self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
            data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["available_models"]["faster-whisper"], ["small"])
        self.assertEqual(data["available_models"]["whisper"], [])

    def test_empty_models_dir_reports_nothing_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = run_subcommand(["status"], {"PROMPTCUT_PYLIBS": os.path.join(tmp, "pylibs"), "PROMPTCUT_MODELS": os.path.join(tmp, "none")})
            data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["available_models"], {"faster-whisper": [], "whisper": []})


class TestOfflineTranscribe(unittest.TestCase):
    def run_offline(self, *extra, models=None, expect_input=True):
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "silence.wav")
            make_wav(wav)
            env = {
                "PROMPTCUT_PYLIBS": os.path.join(tmp, "pylibs"),
                "PROMPTCUT_MODELS": models or os.path.join(tmp, "models"),
            }
            proc = run_subcommand(["transcribe", "--input", wav, "--offline", *extra], env)
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        return proc, [json.loads(ln) for ln in lines]

    def test_unknown_model_name_is_refused_before_anything_loads(self):
        proc, events = self.run_offline("--model", "C:/evil/path")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(events[-1]["event"], "error")
        self.assertEqual(events[-1]["kind"], "model-missing")

    def test_missing_weights_report_instead_of_downloading(self):
        # 没装引擎时先报 engine-missing；装了而没权重时报 model-missing。两者都不许联网
        proc, events = self.run_offline("--model", "small")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(events[-1]["event"], "error")
        self.assertIn(events[-1]["kind"], ("engine-missing", "model-missing"))
        self.assertNotIn("下载", events[-1]["message"].replace("不会联网下载", "").replace("不联网下载", ""))

    def test_missing_input_has_kind(self):
        proc = run_subcommand(["transcribe", "--input", "no-such-file.mp4", "--offline"])
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["kind"], "input-missing")


class TestInstallRequirements(unittest.TestCase):
    def test_missing_requirements_file_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = run_subcommand(
                ["install", "--engine", "faster-whisper", "--requirements", os.path.join(tmp, "nope.txt")],
                {"PROMPTCUT_PYLIBS": os.path.join(tmp, "pylibs")},
            )
        self.assertEqual(proc.returncode, 1)
        data = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(data["kind"], "requirements-missing")


class TestExtractWavFlags(unittest.TestCase):
    def fake_run(self, captured, returncode=0, stderr=""):
        def run(cmd, **_kwargs):
            captured.append(cmd)
            if returncode == 0:
                with open(cmd[-1], "wb") as handle:
                    handle.write(b"RIFF")
            return subprocess.CompletedProcess(cmd, returncode, stdout="", stderr=stderr)
        return run

    def test_local_only_adds_protocol_whitelist_before_input(self):
        captured = []
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(audio, "find_ffmpeg", return_value="ffmpeg"), \
                mock.patch.object(audio.subprocess, "run", self.fake_run(captured)):
            audio.extract_wav("in.mp4", os.path.join(tmp, "out.wav"), local_only=True)
        cmd = captured[0]
        self.assertEqual(cmd[cmd.index("-protocol_whitelist") + 1], "file")
        self.assertLess(cmd.index("-protocol_whitelist"), cmd.index("-i"))

    def test_default_command_is_unchanged(self):
        captured = []
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(audio, "find_ffmpeg", return_value="ffmpeg"), \
                mock.patch.object(audio.subprocess, "run", self.fake_run(captured)):
            audio.extract_wav("in.mp4", os.path.join(tmp, "out.wav"))
        self.assertNotIn("-protocol_whitelist", captured[0])

    def test_no_audio_stream_is_classified(self):
        captured = []
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(audio, "find_ffmpeg", return_value="ffmpeg"), \
                mock.patch.object(audio.subprocess, "run",
                                  self.fake_run(captured, returncode=234, stderr="Output file does not contain any stream")):
            with self.assertRaises(audio.AudioExtractError) as caught:
                audio.extract_wav("in.mp4", os.path.join(tmp, "out.wav"))
        self.assertEqual(caught.exception.kind, "no-audio")


if __name__ == "__main__":
    unittest.main()
