"""TransNetV2 inference.

The model comes from the official TensorFlow weights, converted to PyTorch with the official convert_weights.py (official self-test
10/10 matched 100% frame by frame) and then exported to ONNX; see tools/build-transnetv2-onnx.md.

The input is uint8 [B, 100, 27, 48, 3]; normalization is done inside the model, so preprocessing only needs to scale the frames
to 48x27, and do not divide by 255 yourself.
"""

from __future__ import annotations

import subprocess
from typing import Any, Dict, List, Optional

MODEL_FILENAME = "transnetv2.onnx"

# Sliding window of the official inference: pad 25 frames at both the start and the end, window 100, stride 50, and take only the middle [25:75] of each window.
# This way every frame is predicted once in the middle of some window, with full context.
WINDOW = 100
STRIDE = 50
MARGIN = 25

FRAME_W, FRAME_H = 48, 27

# The Cloud Agent service fetches the asset into the chat's working directory and then passes the path: assets are uploaded by members, and a playlist disguised as a media file
# (HLS, concat) must not be allowed to make ffmpeg connect to network addresses. When set to True, `-protocol_whitelist file` is added before the input.
# The desktop app does not set it (it passes http addresses on the asset service).
LOCAL_ONLY = False


def decode_frames(ffmpeg: str, video: str):
    """Decode the whole video into 48x27 RGB frames.

    The model input is only 48x27, so even for a 4K asset the memory here is just
    frame count × 48 × 27 × 3 bytes (about 420 MB for 1 hour at 30fps), which can be read in one go.
    Truly large assets are left to the caller to decide whether to split them into segments.
    """
    import numpy as np

    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error",
         *(["-protocol_whitelist", "file"] if LOCAL_ONLY else []), "-i", video,
         "-vf", f"scale={FRAME_W}:{FRAME_H}", "-pix_fmt", "rgb24",
         "-f", "rawvideo", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[:500] or "ffmpeg decode failed")
    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    per_frame = FRAME_H * FRAME_W * 3
    if per_frame == 0 or buf.size < per_frame:
        raise RuntimeError("No video frames were decoded; this file may have no video track")
    return buf[: buf.size // per_frame * per_frame].reshape(-1, FRAME_H, FRAME_W, 3)


def predict(frames, session, on_progress=None):
    """Per-frame probabilities; returns two curves, (center, extent).

    The model has two outputs with different uses, and both are needed:
      - cut_prob (one_hot): where the **center** of a transition is. Both hard cuts and dissolves light up only a very narrow stretch.
      - many_hot: **every frame** that belongs to a transition. For hard cuts it is as narrow as one_hot; for dissolves it spreads over
        the whole gradual transition.

    Tested on a 1-second crossfade: one_hot gives only 3 frames (2.44~2.56s), many_hot gives 21 frames
    (2.12~2.96s), and the latter is the true span. To draw a dissolve on the timeline as two overlapping pictures, what we rely on
    is many_hot.
    """
    import numpy as np

    padded = np.concatenate(
        [frames[:1]] * MARGIN + [frames] + [frames[-1:]] * MARGIN
    )
    total_windows = max(1, (len(padded) - WINDOW) // STRIDE + 1)
    centers: List[Any] = []
    extents: List[Any] = []
    ptr = 0
    done = 0
    while ptr + WINDOW <= len(padded):
        window = padded[ptr : ptr + WINDOW][None]
        one, many = session.run(["cut_prob", "many_hot"], {"frames": window})
        centers.append(one[0, MARGIN : WINDOW - MARGIN, 0])
        extents.append(many[0, MARGIN : WINDOW - MARGIN, 0])
        ptr += STRIDE
        done += 1
        if on_progress:
            on_progress(done, total_windows)
    if not centers:
        zero = np.zeros(len(frames), dtype="float32")
        return zero, zero
    return (np.concatenate(centers)[: len(frames)],
            np.concatenate(extents)[: len(frames)])


def transitions_from_probs(centers, extents, fps: float,
                           threshold: float = 0.5) -> List[Dict[str, Any]]:
    """Turn the per-frame probabilities into transitions.

    First use centers to locate "there is a transition here", then use extents to stretch out its true span:
    a hard cut cannot be stretched (it is only one or two frames anyway), while a dissolve stretches to the whole gradual transition.
    """
    result: List[Dict[str, Any]] = []
    run: List[int] = []
    n = len(centers)

    def flush() -> None:
        if not run:
            return
        peak = max(run, key=lambda i: centers[i])
        # Walk outward from the peak on both sides until many_hot drops below the threshold, which gives the true extent of the gradual transition
        start = end = peak
        while start - 1 >= 0 and extents[start - 1] >= threshold:
            start -= 1
        while end + 1 < n and extents[end + 1] >= threshold:
            end += 1
        start, end = min(start, run[0]), max(end, run[-1])
        # Only a span of more than 3 frames counts as gradual; a hard cut is only one or two frames on both curves
        kind = "dissolve" if (end - start + 1) > 3 else "cut"
        result.append({
            "kind": kind,
            "startFrame": int(start),
            "endFrame": int(end),
            "frame": int(peak),
            "start": round(start / fps, 3),
            "end": round((end + 1) / fps, 3),
            "time": round(peak / fps, 3),
            "confidence": round(float(centers[peak]), 3),
        })

    for i, p in enumerate(centers):
        if p >= threshold:
            run.append(i)
        elif run:
            flush()
            run = []
    if run:
        flush()
    return result


def shots_from_transitions(transitions: List[Dict[str, Any]], duration: float) -> List[Dict[str, Any]]:
    """What lies between transitions are the shots. This list is mainly what the AI uses."""
    shots: List[Dict[str, Any]] = []
    cursor = 0.0
    for t in transitions:
        if t["start"] > cursor:
            shots.append({"start": round(cursor, 3), "end": round(t["start"], 3),
                          "inTransition": None if not shots else transitions[len(shots) - 1]["kind"],
                          "outTransition": t["kind"]})
        cursor = t["end"]
    if duration > cursor:
        shots.append({"start": round(cursor, 3), "end": round(duration, 3),
                      "inTransition": transitions[-1]["kind"] if transitions else None,
                      "outTransition": None})
    return shots


def load_session(model_path: str):
    import onnxruntime as ort

    # Explicitly use CPU only: whether this machine has CUDA should not affect the result, and when the GPU provider
    # is missing a DLL, onnxruntime prints a pile of scary warnings.
    return ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
