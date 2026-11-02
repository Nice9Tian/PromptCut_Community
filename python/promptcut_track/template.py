"""Fallback tracking when the extension is not installed: normalized cross-correlation (ZNCC) template matching.

Its relationship to BootsTAPIR is that of "usable" versus "good", not two implementations of the same thing:

- The neural-network tier understands the picture content: it still recognizes a target that turns around or comes back after being blocked, and whether it is occluded
  is judged by the model itself;
- This tier only takes a small patch of pixels and looks elsewhere for the most similar spot. Once the target turns, scales, or moves in and out of shadow,
  the similarity collapses. So it only suits scenes with clear texture, no occlusion, and gentle movement.

Why it is still worth building: the extension pack is 190 MB of torch + 208 MB of weights, and most users will not install it at first,
and "cannot track" versus "tracks roughly" are two completely different things to the user. This tier depends only on numpy:
numpy is already in the base runtime, so it runs whether or not the extension is installed.

Limitations kept on purpose; do not "fix them while you are at it":
- No multi-scale search. When the target visibly scales, this tier should fail; forcing out a result would only leave the user
  binding cards to a wrong trajectory, which is worse than saying plainly that it cannot track.
- Occlusion is decided purely by "similarity falls below the threshold", with no other basis. It treats "blocked" and
  "turned around" as the same thing; this is exactly the capability boundary of this tier.
"""

from __future__ import annotations

import subprocess
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import ffmpeg_input
from .tracker import _parse_size

# Decoding scales the long side to this size. Template matching works on decoded pixels: if it is too small, the template
# lacks enough texture; if it is too large, the per-frame search cost and memory both go up (the whole video has to stay in memory,
# since it must run both forward **and** backward from the query frame).
MAX_SIDE = 720

# Template side length (odd, to guarantee a true center). 21 px at 720p is about the size of a knuckle or a button,
# small enough to stick to the target, large enough to still carry enough texture.
TEMPLATE = 21

# Per-frame search radius. A target that moves more than this per frame is lost; raising it grows the per-frame cost quadratically.
SEARCH = 16

# After losing the target, the search radius is widened to this value to lock on again. It is used only during loss, so widening does not affect
# the cost of normal frames. This one matters a lot in practice: when the target is blocked for a dozen or so frames, by the time it comes out it has already left
# the regular 16 px search window, and without widening it can never be found again, ruining the whole trajectory from then on.
REACQUIRE = 48

# Similarity below this value is judged invisible. ZNCC ranges over [-1, 1], and the same texture is normally above 0.8.
OCCLUDED_BELOW = 0.55

# When similarity is above this value, the current appearance is blended into the template so it slowly keeps up with lighting and deformation.
# Blending too fast makes it "chase the noise", and after a few dozen frames the template drifts into the background.
ADAPT_ABOVE = 0.85
ADAPT_RATE = 0.10

# Lower limit on the template's own contrast. Below this value the user clicked on a solid-color area, where matching is out of the question,
# so rather than return a wandering trajectory, just say this point cannot be tracked.
MIN_TEXTURE = 6.0


def decode_gray(ffmpeg: str, video: str, max_side: int = MAX_SIDE
                ) -> Tuple[np.ndarray, Tuple[int, int], Tuple[int, int]]:
    """Decode to grayscale (T, H, W) uint8, keeping the aspect ratio. Returns (frames, original size, decoded size).

    Unlike the neural-network tier, the aspect ratio is **kept** here: template matching has no "that is how the model was trained"
    constraint, and stretching would only squash the template in one direction and lower the matching quality for nothing.
    """
    probe = subprocess.run(
        [ffmpeg, "-hide_banner", *ffmpeg_input(video)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    src_w, src_h = _parse_size(probe.stderr.decode("utf-8", "replace"))
    if not src_w or not src_h:
        raise RuntimeError("Cannot read the video resolution, tracking is impossible")

    scale = min(1.0, max_side / max(src_w, src_h))
    # Use even values for both width and height: odd sizes are silently adjusted by some ffmpeg scalers, and then the
    # bytes per decoded frame no longer match our calculation and reshape would misalign.
    dst_w = max(2, int(round(src_w * scale)) // 2 * 2)
    dst_h = max(2, int(round(src_h * scale)) // 2 * 2)

    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", *ffmpeg_input(video),
         "-vf", f"scale={dst_w}:{dst_h}", "-pix_fmt", "gray",
         "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[:500] or "ffmpeg decode failed")

    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    per = dst_w * dst_h
    if buf.size < per:
        raise RuntimeError("No frame was decoded from the video")
    frames = buf[: buf.size - buf.size % per].reshape(-1, dst_h, dst_w)
    return frames, (src_w, src_h), (dst_w, dst_h)


def _zncc_map(window: np.ndarray, templ: np.ndarray) -> np.ndarray:
    """Slide templ over window and return the ZNCC score map for every position.

    ZNCC rather than the sum of squared differences: the former is immune to overall brightness changes (a cloud drifting past, an auto-exposure jump
    will not make the matching collapse), whereas the latter would.
    """
    n = templ.size
    t = templ.astype(np.float32).ravel()
    t -= t.mean()
    t_norm = float(np.sqrt((t * t).sum()))
    if t_norm < 1e-6:
        return np.zeros(
            (window.shape[0] - templ.shape[0] + 1, window.shape[1] - templ.shape[1] + 1),
            dtype=np.float32,
        )

    views = np.lib.stride_tricks.sliding_window_view(
        window.astype(np.float32), templ.shape)
    flat = views.reshape(views.shape[0], views.shape[1], n)
    mean = flat.mean(axis=2, keepdims=True)
    centered = flat - mean
    # Norm of every candidate block. Add eps to keep a solid-color block (norm 0) from dividing out to inf
    norms = np.sqrt((centered * centered).sum(axis=2)) + 1e-6
    return (centered @ t) / (norms * t_norm)


def _subpixel(score: np.ndarray, iy: int, ix: int) -> Tuple[float, float]:
    """Fit a parabola near the peak of the score map to refine the integer peak to sub-pixel precision.

    Uses only the peak and one point on each side. The offset is clamped to ±0.5: beyond that range the peak is not a real peak
    (flat-topped or double-peaked), so a forced fit cannot be trusted and it is better to fall back to the integer position.
    """
    def refine(a: float, b: float, c: float) -> float:
        denom = a - 2.0 * b + c
        if abs(denom) < 1e-6:
            return 0.0
        return float(np.clip(0.5 * (a - c) / denom, -0.5, 0.5))

    dy = 0.0
    if 0 < iy < score.shape[0] - 1:
        dy = refine(score[iy - 1, ix], score[iy, ix], score[iy + 1, ix])
    dx = 0.0
    if 0 < ix < score.shape[1] - 1:
        dx = refine(score[iy, ix - 1], score[iy, ix], score[iy, ix + 1])
    return dx, dy


def _grab(frame: np.ndarray, cx: float, cy: float, half: int) -> Optional[np.ndarray]:
    """Take the square centered at (cx, cy) with side 2*half+1. Returns None if it is out of bounds."""
    x, y = int(round(cx)), int(round(cy))
    if x - half < 0 or y - half < 0:
        return None
    if x + half + 1 > frame.shape[1] or y + half + 1 > frame.shape[0]:
        return None
    return frame[y - half:y + half + 1, x - half:x + half + 1]


def _walk(frames: np.ndarray, start: int, order: Sequence[int],
          templ0: np.ndarray, x0: float, y0: float,
          ) -> Dict[int, Tuple[float, float, bool]]:
    """Walk along order from the query frame, locating frame by frame. Returns {frame number: (x, y, visible)}.

    After losing the target, do not give up: the position is extrapolated forward at the last velocity and the template is **no longer updated**.
    A target blocked for a few frames and then reappearing is common, and using the extrapolated position as the center of the next search
    is more likely to lock on again than staying put. During extrapolation everything is marked invisible.
    """
    half = templ0.shape[0] // 2
    templ = templ0.astype(np.float32).copy()
    x, y = x0, y0
    vx = vy = 0.0
    gap = 0  # how many frames in a row have been lost, used to spread the velocity out when the target is locked on again
    out: Dict[int, Tuple[float, float, bool]] = {start: (x0, y0, True)}

    lost = False
    for f in order:
        frame = frames[f]
        px, py = x + vx, y + vy  # predict from the previous velocity first, then search around the predicted point
        radius = REACQUIRE if lost else SEARCH
        pad = half + radius
        # If the frame is smaller than the search window there is nothing to search, so count it as invisible directly
        if frame.shape[0] < 2 * pad + 1 or frame.shape[1] < 2 * pad + 1:
            out[f] = (px, py, False)
            x, y, lost = px, py, True
            continue
        cx = float(np.clip(px, pad, frame.shape[1] - pad - 1))
        cy = float(np.clip(py, pad, frame.shape[0] - pad - 1))
        window = _grab(frame, cx, cy, pad)
        if window is None:
            out[f] = (px, py, False)
            x, y, lost = px, py, True
            continue

        score = _zncc_map(window, templ)
        iy, ix = np.unravel_index(int(np.argmax(score)), score.shape)
        best = float(score[iy, ix])
        dx, dy = _subpixel(score, int(iy), int(ix))

        # The center coordinate corresponding to the top-left corner of the score map is (cx - radius, cy - radius)
        nx = cx - radius + float(ix) + dx
        ny = cy - radius + float(iy) + dy

        visible = best >= OCCLUDED_BELOW
        if visible:
            # After locking on again, the velocity must be spread over the **number of frames actually traversed**; the displacement of one frame cannot be used as the velocity:
            # when it comes out after being blocked for 30 frames, nx - x is the total displacement of thirty frames, and using it directly as the velocity makes the next frame's
            # prediction overshoot by a large distance, so it is lost again right after locking on.
            span = max(1, gap + 1)
            vx, vy = (nx - x) / span, (ny - y) / span
            x, y = nx, ny
            lost = False
            gap = 0
            if best >= ADAPT_ABOVE:
                patch = _grab(frame, x, y, half)
                if patch is not None:
                    templ = (1.0 - ADAPT_RATE) * templ + ADAPT_RATE * patch.astype(np.float32)
        else:
            # Lost: keep extrapolating at **constant velocity**, with no decay.
            # Decay amounts to assuming the target has stopped, whereas what blocks it is usually another object sweeping past in front,
            # and the target itself is still moving at its original speed; in practice decay makes the predicted point stand still, so when the target comes out
            # it has already left the search window, and the whole trajectory can never be reconnected.
            x, y = px, py
            lost = True
            gap += 1
        out[f] = (x, y, visible)

    return out


def track_template(
    frames: np.ndarray,
    queries: Sequence[Sequence[float]],
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> Dict[str, Any]:
    """Track a group of points at the decode resolution. queries is [(frame number, x, y), ...], with coordinates at the decode resolution as well.

    Each point starts from its own query frame and walks to the end of the clip and back to the start of the clip: a target the user
    picked at some middle frame should have a trajectory both before and after it, and walking only toward the end would leave the first half missing out of thin air.
    """
    total = int(frames.shape[0])
    half = TEMPLATE // 2
    tracks: List[List[List[float]]] = []
    visible: List[List[bool]] = []
    notes: List[Optional[str]] = []

    for qi, (qf, qx, qy) in enumerate(queries):
        f0 = int(np.clip(round(qf), 0, total - 1))
        templ = _grab(frames[f0], qx, qy, half)

        if templ is None:
            notes.append("The query point is too close to the edge of the frame to extract a complete template")
            tracks.append([[float(qx), float(qy)]] * total)
            visible.append([False] * total)
            if on_progress:
                on_progress(qi + 1, len(queries))
            continue

        texture = float(templ.astype(np.float32).std())
        if texture < MIN_TEXTURE:
            # A solid-color area has no local features to match against, so the match result is pure noise.
            # Rather than return a wandering trajectory, mark the whole trajectory invisible and explain why.
            notes.append(f"There is almost no texture around the query point (contrast {texture:.1f}), so this tier cannot track it")
            tracks.append([[float(qx), float(qy)]] * total)
            visible.append([False] * total)
            if on_progress:
                on_progress(qi + 1, len(queries))
            continue

        found = _walk(frames, f0, range(f0 + 1, total), templ, float(qx), float(qy))
        found.update(_walk(frames, f0, range(f0 - 1, -1, -1), templ, float(qx), float(qy)))
        found[f0] = (float(qx), float(qy), True)

        tracks.append([[found[f][0], found[f][1]] for f in range(total)])
        visible.append([found[f][2] for f in range(total)])
        notes.append(None)
        if on_progress:
            on_progress(qi + 1, len(queries))

    return {"tracks": np.asarray(tracks, dtype=np.float32),
            "visible": np.asarray(visible, dtype=bool),
            "notes": notes}
