"""BootsTAPIR any-point tracking: decode the video → run the model → output trajectories.

The model is google-deepmind's BootsTAPIR (Apache 2.0, weights under the same license), and the code is under
vendor/tapnet_torch. It was chosen over CoTracker because the entire CoTracker repo is CC-BY-NC,
so it cannot be distributed with the installer, and users taking commercial jobs with it would also be in breach.

Why PyTorch is bundled instead of converting to ONNX: TAPIR has 4 five-dimensional grid_sample ops,
and none of the four export paths in torch 2.5 (torch.export / strict=False / TorchScript /
internal Dynamo) can export them. Modifying the upstream model code could work around that, but it would mean maintaining a fork long-term,
so not for now: the extension pack is an optional download, and trading 190 MB extra for zero model changes is a good deal.
"""

from __future__ import annotations

import subprocess
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import ffmpeg_input

MODEL_FILENAME = "bootstapir_v2.pt"

# The model was trained at 256×256, and feeding other sizes lowers the accuracy. Query points and output trajectories are both in this
# coordinate system, and the original pixel coordinates given by the caller are converted back and forth by scale_points.
INPUT_SIZE = 256

# Upper limit on the number of frames fed to the model at once. TAPIR computes the whole sequence in one go, so the more frames, the tighter the VRAM/memory,
# and beyond this number it runs in chunks, with OVERLAP frames overlapping between chunks so the trajectories can be joined.
CHUNK_FRAMES = 48
OVERLAP = 8


def decode_frames(ffmpeg: str, video: str, size: int = INPUT_SIZE) -> Tuple[np.ndarray, Tuple[int, int]]:
    """Decode the whole video into a (T, size, size, 3) uint8 array and also report the original resolution.

    Stretch directly to a square without keeping the aspect ratio: that is how the model was trained, and keeping the ratio with black bars would instead
    reduce the number of effective pixels. Coordinate conversion applies the inverse of the same stretch inside scale_points.
    """
    probe = subprocess.run(
        [ffmpeg, "-hide_banner", *ffmpeg_input(video)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    src_w, src_h = _parse_size(probe.stderr.decode("utf-8", "replace"))

    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", *ffmpeg_input(video),
         "-vf", f"scale={size}:{size}", "-pix_fmt", "rgb24",
         "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[:500] or "ffmpeg decode failed")

    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    per = size * size * 3
    if buf.size < per:
        raise RuntimeError("No frame was decoded from the video")
    frames = buf[: buf.size - buf.size % per].reshape(-1, size, size, 3)
    return frames, (src_w, src_h)


def _parse_size(stderr: str) -> Tuple[int, int]:
    """Dig the original resolution out of ffmpeg's log. If it cannot be found, return 0 and leave it to the caller."""
    import re

    m = re.search(r"Stream #.*Video:.*?(\d{2,5})x(\d{2,5})", stderr)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def estimate_frames(ffmpeg: str, video: str) -> Optional[int]:
    """Estimate the total frame count of the video (duration × frame rate) from ffmpeg's probe log. If it cannot be estimated, return None, which does not block tracking."""
    import re

    probe = subprocess.run(
        [ffmpeg, "-hide_banner", *ffmpeg_input(video)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    text = probe.stderr.decode("utf-8", "replace")
    d = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    f = re.search(r"Stream #.*Video:.*?(\d+(?:\.\d+)?)\s*fps", text)
    if not d or not f:
        return None
    seconds = int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3))
    return int(round(seconds * float(f.group(1))))


def scale_points(points: Sequence[Sequence[float]], src: Tuple[int, int],
                 to_model: bool) -> np.ndarray:
    """Original pixel coordinates ↔ the model's 256×256 coordinates. src is (width, height)."""
    w, h = src
    if not w or not h:
        return np.asarray(points, dtype=np.float32)
    arr = np.asarray(points, dtype=np.float32).copy()
    fx, fy = INPUT_SIZE / w, INPUT_SIZE / h
    if to_model:
        arr[..., 0] *= fx
        arr[..., 1] *= fy
    else:
        arr[..., 0] /= fx
        arr[..., 1] /= fy
    return arr


def load_model(model_path: str):
    """Load BootsTAPIR. This is only reached once torch and the model files are both in place."""
    import torch

    from .vendor.tapnet_torch import tapir_model

    model = tapir_model.TAPIR(pyramid_level=1, extra_convs=True, softmax_temperature=10.0)
    state = torch.load(model_path, map_location="cpu", weights_only=True)
    model.load_state_dict(state)
    model.eval()
    return model


def track(
    model,
    frames: np.ndarray,
    queries: Sequence[Tuple[float, float, float]],
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> Dict[str, np.ndarray]:
    """Track a batch of points.

    Each item of queries is (frame number, x, y), with coordinates already in the model's 256 space.
    Returns tracks (N, T, 2) and visible (N, T) booleans.

    Long videos run in chunks: adjacent chunks overlap by OVERLAP frames, and each later chunk uses the displacement of the overlapping part to align itself
    to the end of the previous chunk, avoiding trajectory jumps at the seam.
    """
    import torch

    total = len(frames)
    n = len(queries)
    tracks = np.zeros((n, total, 2), dtype=np.float32)
    visible = np.zeros((n, total), dtype=bool)

    # The "last confidently known position" of every point, used to hand off between chunks. The initial value is the query point given by the caller.
    seed = [(float(qt), float(qx), float(qy)) for (qt, qx, qy) in queries]

    starts = list(range(0, total, CHUNK_FRAMES - OVERLAP)) or [0]
    for i, start in enumerate(starts):
        end = min(start + CHUNK_FRAMES, total)
        if start and end - start <= OVERLAP:
            break
        chunk = frames[start:end]

        # The query point has to fall inside this chunk.
        #
        # The first chunk uses the caller's points directly. Later chunks **must be re-seeded with the positions tracked in the previous chunk**:
        # querying with the original coordinates all the way finds the object long gone, only background left at that position, and the whole chunk's output is garbage
        # (this very bug originally made the last two frames jump by 480 px).
        q = []
        for k, (qt, qx, qy) in enumerate(seed):
            local = min(max(int(qt) - start, 0), len(chunk) - 1)
            q.append((local, qy, qx))          # the model takes (t, y, x)
        qt_arr = torch.tensor([q], dtype=torch.float32)

        video = torch.from_numpy(chunk.astype(np.float32) / 127.5 - 1.0)[None]
        with torch.no_grad():
            out = model(video=video, query_points=qt_arr)

        # The model outputs (1, N, T, 2), with coordinates being (x, y)
        ct = out["tracks"][0].cpu().numpy()
        # The smaller occlusion / expected_dist are, the more trustworthy; the official recommendation is to use this combination to judge visibility
        occ = torch.sigmoid(out["occlusion"][0]).cpu().numpy()
        dist = torch.sigmoid(out["expected_dist"][0]).cpu().numpy()
        vis = (1 - occ) * (1 - dist) > 0.5

        write_from = start if i == 0 else start + OVERLAP
        off = write_from - start
        tracks[:, write_from:end] = ct[:, off:]
        visible[:, write_from:end] = vis[:, off:]

        # Seed the next chunk. Neither of the two constraints can be dropped:
        #   1. The position and the frame number must belong to the **same frame**. If the position from frame 47 is presented as frame 40,
        #      the model will look for something at that coordinate in frame 40, where there is still only background.
        #   2. The seed frame must fall inside the **overlap region** [next_start, end) of the two chunks,
        #      otherwise it is outside the next chunk's range, the frame number gets clamped back to 0, and we are back at problem 1.
        # So search backward from the end of the chunk and pick the last visible frame only within the overlap region.
        if end < total:
            next_start = start + (CHUNK_FRAMES - OVERLAP)
            lo = max(next_start - start, 0)
            for k in range(n):
                for f in range(len(chunk) - 1, lo - 1, -1):
                    if vis[k, f]:
                        seed[k] = (float(start + f), float(ct[k, f, 0]), float(ct[k, f, 1]))
                        break

        if on_progress:
            on_progress(min(end, total), total)
        if end >= total:
            break

    return {"tracks": tracks, "visible": visible}
