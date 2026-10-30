"""音频准备：把任意媒体文件转成 16 kHz 单声道 16-bit PCM wav。

Whisper 系列模型的输入采样率固定 16 kHz 单声道，先统一抽出来，引擎那边就不用
各自再依赖一套解码库。ffmpeg 只从 PATH 找（桌面版由安装包把 ffmpeg 目录塞进
PATH，开发期由使用者自己装），找不到时给一句人话，不打印堆栈。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import wave
from typing import Optional, Tuple

# 目标格式：Whisper 系列的输入规格
TARGET_RATE = 16000
TARGET_CHANNELS = 1
TARGET_SAMPLE_WIDTH = 2  # 16-bit


class FfmpegNotFound(Exception):
    """PATH 上没有 ffmpeg。"""


class AudioExtractError(Exception):
    """ffmpeg 跑起来了但抽取失败（文件损坏、没有音轨等）。

    kind：'no-audio'（没有音轨）或 'audio-extract'（其它原因）；node 侧据此给模型一句准话。
    """

    def __init__(self, message: str, kind: str = "audio-extract"):
        super().__init__(message)
        self.kind = kind


def _no_window() -> dict:
    """Windows 上别弹黑框：子进程是从窗口程序里起的，默认会闪一个控制台。"""
    if os.name != "nt":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return {"startupinfo": startupinfo, "creationflags": subprocess.CREATE_NO_WINDOW}


def find_ffmpeg() -> str:
    """返回 ffmpeg 可执行文件的绝对路径，找不到抛 FfmpegNotFound。"""
    path = shutil.which("ffmpeg")
    if not path:
        raise FfmpegNotFound(
            "未找到 ffmpeg。请确认 ffmpeg.exe 在 PATH 中"
            "（桌面版由安装包自带，开发期请自行安装 ffmpeg 并加入 PATH）。"
        )
    return path


def probe_duration(path: str) -> Optional[float]:
    """用 ffprobe 读总时长（秒）。拿不到就返回 None，绝不抛异常。

    时长只用来算进度百分比，缺了不影响转写，所以这里所有失败都吞掉。
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
    """判断文件是否已经就是目标格式的 wav；不是 wav 或读不动都返回 False。"""
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
    """用 ffmpeg 把 src 抽成目标格式的 wav 写到 dst，返回 dst。

    local_only（离线模式）：输入前加 -protocol_whitelist file，ffmpeg 只读本地文件。
    素材是别人传来的，伪装成媒体的播放列表不能借此让 ffmpeg 去连网络地址。
    """
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg,
        "-y",
        *(["-protocol_whitelist", "file"] if local_only else []),
        "-i",
        src,
        "-vn",                      # 丢掉视频轨
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
            f"ffmpeg 抽取音频失败（退出码 {proc.returncode}）：{src}\n{tail}",
            kind="no-audio" if no_audio else "audio-extract",
        )
    if not os.path.isfile(dst):
        raise AudioExtractError(f"ffmpeg 没有报错，但没有产出文件：{dst}")
    return dst


def ensure_wav(src: str, tmpdir: str, local_only: bool = False) -> Tuple[str, bool]:
    """保证拿到一个目标格式的 wav。

    返回 (路径, 是否是新抽出来的临时文件)。第二个值为 True 时文件在 tmpdir 里，
    由调用方（通常是一个 TemporaryDirectory 上下文）负责清理。
    """
    if is_wav_16k_mono(src):
        return src, False
    dst = os.path.join(tmpdir, "input-16k.wav")
    extract_wav(src, dst, local_only=local_only)
    return dst, True
