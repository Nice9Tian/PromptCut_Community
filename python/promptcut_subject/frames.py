"""抽帧 + 缩放。

只在指定的几个时刻各抽一帧（样本数是几十个量级），所以每帧起一次 ffmpeg 是
划算的 —— 比把整段视频解出来再挑帧省几个数量级的 I/O。

缩放有两处：ffmpeg 那次是「把 4K 降到 max-side，别让后面的 numpy 搬 8 MB 的
数组」；模型输入那次（resize_bilinear / letterbox）是纯 numpy，因为用户机器上
**没有 cv2**，也不打算为了 resize 塞一个 opencv 进拓展包。
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# 云端 Agent 服务把素材取到对话的工作目录后再递路径来:素材是成员传的,伪装成媒体文件的
# 播放列表(HLS、concat)不能让 ffmpeg / ffprobe 去连网络地址。置 True 时每个输入前加
# `-protocol_whitelist file`。桌面版不设(它递的是素材服务上的 http 地址)。
LOCAL_ONLY = False


def _protocol_args() -> List[str]:
    return ["-protocol_whitelist", "file"] if LOCAL_ONLY else []


def _no_window() -> dict:
    """Windows 上别弹黑框：子进程是从窗口程序里起的，默认会闪一个控制台。"""
    if os.name != "nt":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return {"startupinfo": startupinfo, "creationflags": subprocess.CREATE_NO_WINDOW}


def ffprobe_path(ffmpeg: Optional[str]) -> Optional[str]:
    """ffprobe 就在 ffmpeg 旁边（安装包里是同一个目录），先按同目录找。"""
    if ffmpeg:
        d = os.path.dirname(os.path.abspath(ffmpeg))
        for name in ("ffprobe.exe", "ffprobe"):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
    return shutil.which("ffprobe")


def probe_size(ffmpeg: Optional[str], video: str) -> Tuple[int, int]:
    """读原始视频的宽高（像素）。读不出来就抛 RuntimeError。

    结果里的坐标必须是**原始视频像素**，所以这一步不能省：抽帧时缩过的比例
    要靠它换算回去。
    """
    probe = ffprobe_path(ffmpeg)
    if not probe:
        raise RuntimeError("找不到 ffprobe，读不出视频分辨率。")
    proc = subprocess.run(
        [probe, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=p=0:s=x", *_protocol_args(), video],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        **_no_window(),
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "").strip()[:400] or "ffprobe 读不出这个文件的视频信息")
    txt = (proc.stdout or "").strip().splitlines()
    if not txt:
        raise RuntimeError("这个文件里没有视频轨")
    try:
        w, h = txt[0].strip().split("x")[:2]
        return int(w), int(h)
    except Exception:
        raise RuntimeError(f"ffprobe 的输出看不懂：{txt[0]!r}")


def target_size(width: int, height: int, max_side: int) -> Tuple[int, int]:
    """按最长边缩到 max_side（只缩不放）。"""
    longest = max(width, height)
    if longest <= max_side or longest <= 0:
        return width, height
    s = max_side / float(longest)
    return max(1, int(round(width * s))), max(1, int(round(height * s)))


def grab_frame(ffmpeg: str, video: str, t: float, width: int, height: int) -> np.ndarray:
    """抽 t 秒那一帧，返回 HxWx3 的 BGR uint8。

    -ss 放在 -i **前面**：ffmpeg 会先跳到最近的关键帧再解码到目标时刻，比放在
    后面（从头解）快几十倍，且现代 ffmpeg 这条路依然是帧精确的。
    """
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, float(t)):.3f}", *_protocol_args(), "-i", video,
        "-frames:v", "1",
        "-vf", f"scale={width}:{height}",
        "-pix_fmt", "bgr24", "-f", "rawvideo", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, **_no_window())
    per_frame = width * height * 3
    if proc.returncode != 0 or len(proc.stdout) < per_frame:
        detail = proc.stderr.decode("utf-8", "replace").strip()[:300]
        raise RuntimeError(f"抽 {t:.3f}s 那一帧失败：{detail or '没有解出数据（时刻超出时长？）'}")
    buf = np.frombuffer(proc.stdout[:per_frame], dtype=np.uint8)
    return buf.reshape(height, width, 3)


def resize_bilinear(img: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """双线性缩放，返回 float32。

    采样点按 (dst + 0.5) * scale - 0.5 取，和 OpenCV / PIL 的 align_corners=False
    一致 —— 差半个像素的话，小脸的框会整体偏，NMS 之后偏得更明显。
    """
    ih, iw = img.shape[:2]
    src = img.astype(np.float32)
    if iw == out_w and ih == out_h:
        return src
    if out_w <= 0 or out_h <= 0 or iw <= 0 or ih <= 0:
        return np.zeros((max(1, out_h), max(1, out_w), img.shape[2]), dtype=np.float32)

    x = (np.arange(out_w, dtype=np.float32) + 0.5) * (iw / out_w) - 0.5
    y = (np.arange(out_h, dtype=np.float32) + 0.5) * (ih / out_h) - 0.5
    x = np.clip(x, 0.0, iw - 1.0)
    y = np.clip(y, 0.0, ih - 1.0)

    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = np.minimum(x0 + 1, iw - 1)
    y1 = np.minimum(y0 + 1, ih - 1)
    wx = (x - x0).astype(np.float32)[None, :, None]
    wy = (y - y0).astype(np.float32)[:, None, None]

    ia = src[y0[:, None], x0[None, :]]
    ib = src[y0[:, None], x1[None, :]]
    ic = src[y1[:, None], x0[None, :]]
    idd = src[y1[:, None], x1[None, :]]
    top = ia + (ib - ia) * wx
    bot = ic + (idd - ic) * wx
    return top + (bot - top) * wy


def letterbox(img: np.ndarray, size: int) -> Tuple[np.ndarray, float]:
    """保比例缩到 size×size 的画布里，右/下补黑，返回 (画布 float32, 缩放系数)。

    YuNet 那份 ONNX 的输入维度是写死的 640×640（OpenCV 自己的 dnn 会重塑图，
    onnxruntime 不会），直接拉伸会把脸压扁，所以要 letterbox。只往右下补，
    左上角对齐原点，框换算回去除以缩放系数就行，不用再减边距。
    """
    ih, iw = img.shape[:2]
    if iw <= 0 or ih <= 0:
        return np.zeros((size, size, 3), dtype=np.float32), 1.0
    scale = min(size / float(iw), size / float(ih))
    nw = max(1, min(size, int(round(iw * scale))))
    nh = max(1, min(size, int(round(ih * scale))))
    canvas = np.zeros((size, size, img.shape[2]), dtype=np.float32)
    canvas[:nh, :nw] = resize_bilinear(img, nw, nh)
    # 实际用到的缩放系数按取整后的尺寸重算，否则框换算回去会差一两个像素
    return canvas, nw / float(iw)


def scale_boxes(boxes: List[Dict[str, Any]], factor: float,
                width: int, height: int) -> List[Dict[str, Any]]:
    """把框从「抽出来的帧」的像素换算回原始视频像素，并夹进画面内。"""
    out: List[Dict[str, Any]] = []
    for b in boxes:
        x = float(b["x"]) * factor
        y = float(b["y"]) * factor
        w = float(b["w"]) * factor
        h = float(b["h"]) * factor
        x0 = max(0.0, min(float(width), x))
        y0 = max(0.0, min(float(height), y))
        x1 = max(0.0, min(float(width), x + w))
        y1 = max(0.0, min(float(height), y + h))
        if x1 - x0 <= 0 or y1 - y0 <= 0:
            continue
        item = dict(b)
        item.update({
            "x": round(x0, 1), "y": round(y0, 1),
            "w": round(x1 - x0, 1), "h": round(y1 - y0, 1),
        })
        out.append(item)
    return out
