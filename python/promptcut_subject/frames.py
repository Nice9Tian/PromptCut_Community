"""Frame extraction + scaling.

Only one frame is extracted at each of a few given times (the sample count is in the tens), so launching ffmpeg once per frame is
worth it: it saves several orders of magnitude of I/O compared with decoding the whole video and then picking frames.

There are two places that scale: the ffmpeg one is "bring 4K down to max-side, so the numpy code afterwards does not move an 8 MB
array"; the model-input one (resize_bilinear / letterbox) is pure numpy, because the user's machine
**has no cv2**, and there is no plan to stuff opencv into the extension pack just for resize.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# The Cloud Agent service fetches the asset into the chat's working directory and then passes the path: assets are uploaded by members, and a playlist disguised as a media file
# Playlists (HLS, concat) must not let ffmpeg / ffprobe connect to network addresses. When set to True, each input is preceded by
# `-protocol_whitelist file`. The desktop app does not set it (it passes http addresses on the asset service).
LOCAL_ONLY = False


def _protocol_args() -> List[str]:
    return ["-protocol_whitelist", "file"] if LOCAL_ONLY else []


def _no_window() -> dict:
    """Do not pop up a black window on Windows: the subprocess is started from a windowed program, which by default would flash a console."""
    if os.name != "nt":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return {"startupinfo": startupinfo, "creationflags": subprocess.CREATE_NO_WINDOW}


def ffprobe_path(ffmpeg: Optional[str]) -> Optional[str]:
    """ffprobe sits next to ffmpeg (the same directory in the installer package), so look in the same directory first."""
    if ffmpeg:
        d = os.path.dirname(os.path.abspath(ffmpeg))
        for name in ("ffprobe.exe", "ffprobe"):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
    return shutil.which("ffprobe")


def probe_size(ffmpeg: Optional[str], video: str) -> Tuple[int, int]:
    """Read the width and height (pixels) of the original video. Raise RuntimeError if it cannot be read.

    The coordinates in the result must be in **original video pixels**, so this step cannot be skipped: the scale applied during frame extraction
    has to be converted back with it.
    """
    probe = ffprobe_path(ffmpeg)
    if not probe:
        raise RuntimeError("ffprobe not found, cannot read the video resolution.")
    proc = subprocess.run(
        [probe, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=p=0:s=x", *_protocol_args(), video],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        **_no_window(),
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "").strip()[:400] or "ffprobe cannot read the video information of this file")
    txt = (proc.stdout or "").strip().splitlines()
    if not txt:
        raise RuntimeError("This file has no video track")
    try:
        w, h = txt[0].strip().split("x")[:2]
        return int(w), int(h)
    except Exception:
        raise RuntimeError(f"Cannot parse the ffprobe output: {txt[0]!r}")


def target_size(width: int, height: int, max_side: int) -> Tuple[int, int]:
    """Scale down to max_side by the longest side (shrink only, never enlarge)."""
    longest = max(width, height)
    if longest <= max_side or longest <= 0:
        return width, height
    s = max_side / float(longest)
    return max(1, int(round(width * s))), max(1, int(round(height * s)))


def grab_frame(ffmpeg: str, video: str, t: float, width: int, height: int) -> np.ndarray:
    """Extract the frame at t seconds and return an HxWx3 BGR uint8 array.

    -ss goes **before** -i: ffmpeg first jumps to the nearest keyframe and then decodes up to the target time, which compared with putting it
    after -i (decoding from the start) is dozens of times faster, and on modern ffmpeg this path is still frame-accurate.
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
        raise RuntimeError(f"Failed to extract the frame at {t:.3f}s: {detail or 'no data decoded (time beyond the duration?)'}")
    buf = np.frombuffer(proc.stdout[:per_frame], dtype=np.uint8)
    return buf.reshape(height, width, 3)


def resize_bilinear(img: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """Bilinear scaling, returns float32.

    Sample points are taken at (dst + 0.5) * scale - 0.5, the same as align_corners=False in OpenCV / PIL;
    if it is off by half a pixel, the boxes of small faces shift as a whole, and more visibly after NMS.
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
    """Scale proportionally into a size×size canvas, pad right/bottom with black, return (canvas float32, scale factor).

    The input dimensions of that YuNet ONNX are hard-coded to 640×640 (OpenCV's own dnn reshapes the graph,
    onnxruntime does not), and stretching directly would squash faces flat, hence the letterbox. Pad only to the right and bottom,
    so the top-left corner stays aligned with the origin; converting boxes back is just dividing by the scale factor, with no margin to subtract.
    """
    ih, iw = img.shape[:2]
    if iw <= 0 or ih <= 0:
        return np.zeros((size, size, 3), dtype=np.float32), 1.0
    scale = min(size / float(iw), size / float(ih))
    nw = max(1, min(size, int(round(iw * scale))))
    nh = max(1, min(size, int(round(ih * scale))))
    canvas = np.zeros((size, size, img.shape[2]), dtype=np.float32)
    canvas[:nh, :nw] = resize_bilinear(img, nw, nh)
    # Recompute the scale factor actually used from the rounded size, otherwise converted boxes are off by a pixel or two
    return canvas, nw / float(iw)


def scale_boxes(boxes: List[Dict[str, Any]], factor: float,
                width: int, height: int) -> List[Dict[str, Any]]:
    """Convert boxes from the pixels of the "extracted frame" back to original video pixels and clamp them into the picture."""
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
