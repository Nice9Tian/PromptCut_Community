"""Audio preparation: convert any media file to a 16 kHz mono 16-bit PCM wav.

The input sample rate of the Whisper family of models is fixed at 16 kHz mono, so extracting it uniformly first means the engines do not have to
each depend on another set of decoding libraries. ffmpeg is only looked up on PATH (for the desktop app the installer puts the ffmpeg directory into
PATH, and during development the user installs it); when it is not found, a plain-language sentence is given and no traceback is printed.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import wave
from typing import Optional, Tuple

# Target format: input spec of the Whisper family
TARGET_RATE = 16000
TARGET_CHANNELS = 1
TARGET_SAMPLE_WIDTH = 2  # 16-bit


class FfmpegNotFound(Exception):
    """There is no ffmpeg on PATH."""


class AudioExtractError(Exception):
    """ffmpeg ran but the extraction failed (corrupted file, no audio track, etc.).

    kind: 'no-audio' (no audio track) or 'audio-extract' (any other reason); the node side uses it to give the model an accurate sentence.
    """

    def __init__(self, message: str, kind: str = "audio-extract"):
        super().__init__(message)
        self.kind = kind


def _no_window() -> dict:
    """Do not pop up a black window on Windows: the subprocess is started from a windowed program, which by default would flash a console."""
    if os.name != "nt":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return {"startupinfo": startupinfo, "creationflags": subprocess.CREATE_NO_WINDOW}


def find_ffmpeg() -> str:
    """Return the absolute path of the ffmpeg executable; raise FfmpegNotFound if it cannot be found."""
    path = shutil.which("ffmpeg")
    if not path:
        raise FfmpegNotFound(
            "ffmpeg not found. Please make sure ffmpeg.exe is on PATH "
            "(the desktop app ships it in the installer; during development, install ffmpeg yourself and add it to PATH)."
        )
    return path


def probe_duration(path: str) -> Optional[float]:
    """Read the total duration (seconds) with ffprobe. Return None if it cannot be obtained; never raise an exception.

    The duration is only used to compute the progress percentage, and missing it does not affect transcription, so every failure here is swallowed.
    """
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        proc = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                path,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            **_no_window(),
        )
        if proc.returncode != 0:
            return None
        return float(proc.stdout.strip())
    except Exception:
        return None


def is_wav_16k_mono(path: str) -> bool:
    """Check whether the file is already a wav in the target format; return False if it is not a wav or cannot be read."""
    try:
        with wave.open(path, "rb") as wav:
            return (
                wav.getnchannels() == TARGET_CHANNELS
                and wav.getframerate() == TARGET_RATE
                and wav.getsampwidth() == TARGET_SAMPLE_WIDTH
            )
    except Exception:
        return False


def extract_wav(src: str, dst: str, local_only: bool = False) -> str:
    """Use ffmpeg to extract src into a wav in the target format, write it to dst and return dst.

    local_only (offline mode): add -protocol_whitelist file before the input, so ffmpeg reads local files only.
    The asset is uploaded by someone else, and a playlist disguised as media must not be able to use that to make ffmpeg connect to network addresses.
    """
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg,
        "-y",
        *(["-protocol_whitelist", "file"] if local_only else []),
        "-i",
        src,
        "-vn",                      # drop the video track
        "-ac", str(TARGET_CHANNELS),
        "-ar", str(TARGET_RATE),
        "-acodec", "pcm_s16le",
        "-f", "wav",
        dst,
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        **_no_window(),
    )
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-20:])
        no_audio = "does not contain any stream" in tail or (
            "Stream map" in tail and "matches no streams" in tail
        )
        raise AudioExtractError(
            f"ffmpeg audio extraction failed (exit code {proc.returncode}): {src}\n{tail}",
            kind="no-audio" if no_audio else "audio-extract",
        )
    if not os.path.isfile(dst):
        raise AudioExtractError(f"ffmpeg reported no error, but produced no file: {dst}")
    return dst


def ensure_wav(src: str, tmpdir: str, local_only: bool = False) -> Tuple[str, bool]:
    """Guarantee getting a wav in the target format.

    Returns (path, whether it is a newly extracted temporary file). When the second value is True the file is in tmpdir,
    and the caller (usually a TemporaryDirectory context) is responsible for cleaning it up.
    """
    if is_wav_16k_mono(src):
        return src, False
    dst = os.path.join(tmpdir, "input-16k.wav")
    extract_wav(src, dst, local_only=local_only)
    return dst, True
