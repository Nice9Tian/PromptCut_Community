"""BootsTAPIR 任意点追踪：解码视频 → 跑模型 → 出轨迹。

模型是 google-deepmind 的 BootsTAPIR（Apache 2.0，权重同许可），代码在
vendor/tapnet_torch 下。选它而不是 CoTracker：CoTracker 全仓库是 CC-BY-NC，
不能随安装包分发，用户拿它接商单也违约。

为什么带 PyTorch 而不是转 ONNX：TAPIR 里有 4 处 5 维 grid_sample，
torch 2.5 的四条导出路径（torch.export / strict=False / TorchScript /
内部 Dynamo）全都导不出来。改上游模型代码能绕开，但那等于长期维护一份分叉，
先不做——拓展包是可选下载，多 190 MB 换零模型改动，这笔账划算。
"""

from __future__ import annotations

import subprocess
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import ffmpeg_input

MODEL_FILENAME = "bootstapir_v2.pt"

# 模型是按 256×256 训练的，喂别的尺寸精度会掉。查询点和输出轨迹都在这个
# 坐标系里，调用方给的原始像素坐标由 scale_points 来回换算。
INPUT_SIZE = 256

# 一次喂给模型的帧数上限。TAPIR 是全序列一次算完的，帧数越多显存/内存越吃紧，
# 超过这个数就分块跑，块之间重叠 OVERLAP 帧好把轨迹接起来。
CHUNK_FRAMES = 48
OVERLAP = 8


def decode_frames(ffmpeg: str, video: str, size: int = INPUT_SIZE) -> Tuple[np.ndarray, Tuple[int, int]]:
    """把整段视频解成 (T, size, size, 3) 的 uint8，同时回报原始分辨率。

    直接拉伸到正方形，不保持宽高比——模型就是这么训练的，保比例加黑边反而
    让有效像素变少。坐标换算在 scale_points 里按同样的拉伸做逆变换。
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
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[:500] or "ffmpeg 解码失败")

    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    per = size * size * 3
    if buf.size < per:
        raise RuntimeError("视频没有解出任何一帧")
    frames = buf[: buf.size - buf.size % per].reshape(-1, size, size, 3)
    return frames, (src_w, src_h)


def _parse_size(stderr: str) -> Tuple[int, int]:
    """从 ffmpeg 的日志里抠出原始分辨率。抠不到就退回 0，交给调用方处理。"""
    import re

    m = re.search(r"Stream #.*Video:.*?(\d{2,5})x(\d{2,5})", stderr)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def estimate_frames(ffmpeg: str, video: str) -> Optional[int]:
    """从 ffmpeg 的探测日志里估视频总帧数(时长 × 帧率)。估不出来回 None,不阻止追踪。"""
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
    """原始像素坐标 ↔ 模型的 256×256 坐标。src 是 (宽, 高)。"""
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
    """加载 BootsTAPIR。torch 和模型文件都就位才调得到这里。"""
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
    """追踪一批点。

    queries 每项是 (帧号, x, y)，坐标已经在模型的 256 空间里。
    返回 tracks (N, T, 2)、visible (N, T) 布尔。

    长视频分块跑：块与块之间重叠 OVERLAP 帧，后一块用重叠段的位移把自己
    对齐到前一块的末尾，避免接缝处轨迹跳变。
    """
    import torch

    total = len(frames)
    n = len(queries)
    tracks = np.zeros((n, total, 2), dtype=np.float32)
    visible = np.zeros((n, total), dtype=bool)

    # 每个点「最后一次确信的位置」，分块时用它接力。初值是调用方给的查询点。
    seed = [(float(qt), float(qx), float(qy)) for (qt, qx, qy) in queries]

    starts = list(range(0, total, CHUNK_FRAMES - OVERLAP)) or [0]
    for i, start in enumerate(starts):
        end = min(start + CHUNK_FRAMES, total)
        if start and end - start <= OVERLAP:
            break
        chunk = frames[start:end]

        # 查询点要落在本块内。
        #
        # 第一块直接用调用方给的点。后续块**必须用上一块追到的位置重新播种**——
        # 一直拿原始坐标去查，物体早就移走了，那个位置只剩背景，整块输出都是垃圾
        # （最初就是这个 bug 让最后两帧跳了 480 px）。
        q = []
        for k, (qt, qx, qy) in enumerate(seed):
            local = min(max(int(qt) - start, 0), len(chunk) - 1)
            q.append((local, qy, qx))          # 模型吃 (t, y, x)
        qt_arr = torch.tensor([q], dtype=torch.float32)

        video = torch.from_numpy(chunk.astype(np.float32) / 127.5 - 1.0)[None]
        with torch.no_grad():
            out = model(video=video, query_points=qt_arr)

        # 模型输出 (1, N, T, 2)，坐标是 (x, y)
        ct = out["tracks"][0].cpu().numpy()
        # occlusion / expected_dist 越小越可信，官方推荐用这个组合判可见性
        occ = torch.sigmoid(out["occlusion"][0]).cpu().numpy()
        dist = torch.sigmoid(out["expected_dist"][0]).cpu().numpy()
        vis = (1 - occ) * (1 - dist) > 0.5

        write_from = start if i == 0 else start + OVERLAP
        off = write_from - start
        tracks[:, write_from:end] = ct[:, off:]
        visible[:, write_from:end] = vis[:, off:]

        # 给下一块播种。两条约束缺一不可：
        #   1. 位置和帧号必须是**同一帧**的。拿第 47 帧的位置说成第 40 帧，
        #      模型会去第 40 帧的那个坐标找东西，那里还是背景。
        #   2. 播种帧必须落在两块的**重叠区** [next_start, end) 里，
        #      否则它不在下一块的范围内，帧号会被夹回 0，又回到问题 1。
        # 所以从块尾往回找，只在重叠区里挑最后一个可见帧。
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
