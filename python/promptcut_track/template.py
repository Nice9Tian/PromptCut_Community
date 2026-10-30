"""未装拓展时的兜底追踪：归一化互相关（ZNCC）模板匹配。

和 BootsTAPIR 的关系是「能用」和「好用」的关系，不是同一个东西的两种实现：

- 神经网络那档理解画面内容，目标转个身、被挡住再出来都还认得，遮挡与否
  由模型自己判断；
- 这一档只会拿一小块像素去别处找最像的地方。目标一旦转向、缩放、进出阴影，
  相似度就塌了。所以它只适合纹理清晰、无遮挡、位移平缓的场景。

之所以还是值得做：拓展包是 190 MB torch + 208 MB 权重，多数用户一开始不会装，
而「追不了」和「追得糙」对用户是完全不同的两件事。这一档只依赖 numpy——
numpy 在基础运行时里就有，装不装拓展都能跑。

刻意保留的局限，不要「顺手修好」：
- 不做多尺度搜索。目标明显缩放时本档就该失败，硬撑着给出结果只会让用户
  拿着一份错的轨迹去绑卡片，比明说追不住更糟。
- 遮挡判定就是「相似度掉到阈值以下」，没有别的依据。它会把「被挡住」和
  「转了个身」判成同一件事——这正是这一档的能力边界。
"""

from __future__ import annotations

import subprocess
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import ffmpeg_input
from .tracker import _parse_size

# 解码时长边缩到这个尺寸。模板匹配是在解码后的像素上做的，太小则模板里
# 没有足够纹理，太大则每帧的搜索开销和内存都上去（整段视频要留在内存里，
# 因为要从查询帧向前**和**向后各跑一遍）。
MAX_SIDE = 720

# 模板边长（奇数，保证有正中心）。21 px 在 720p 上大约是一个指节、一颗纽扣
# 那么大——小到能贴着目标走，大到还带着足够纹理。
TEMPLATE = 21

# 每帧的搜索半径。目标每帧位移超过这个值就会跟丢；调大则每帧开销按平方增长。
SEARCH = 16

# 跟丢之后把搜索半径放大到这个值去重新咬住。只在丢失期间用，所以放大不影响
# 正常帧的开销。实测这一条很要紧：目标被挡十来帧，等它出来时已经离开了
# 16 px 的常规搜索窗，不放大就再也找不回来，整条轨迹从此报废。
REACQUIRE = 48

# 相似度低于此值判为不可见。ZNCC 的取值是 [-1, 1]，同一块纹理正常在 0.8 以上。
OCCLUDED_BELOW = 0.55

# 相似度高于此值时把当前样子掺进模板，慢慢跟上光照和形变。
# 掺得太快会「跟着噪声跑」，几十帧后模板就漂成了背景。
ADAPT_ABOVE = 0.85
ADAPT_RATE = 0.10

# 模板本身的对比度下限。低于这个值说明用户点在了纯色区域，匹配无从谈起，
# 与其给一条乱跑的轨迹，不如直接说这个点追不了。
MIN_TEXTURE = 6.0


def decode_gray(ffmpeg: str, video: str, max_side: int = MAX_SIDE
                ) -> Tuple[np.ndarray, Tuple[int, int], Tuple[int, int]]:
    """解成灰度 (T, H, W) uint8，保持宽高比。返回 (帧, 原始尺寸, 解码尺寸)。

    和神经网络那档不同，这里**保持宽高比**：模板匹配没有「模型就是这么训练的」
    这层约束，拉伸只会让模板在一个方向上被挤扁，白白降低匹配质量。
    """
    probe = subprocess.run(
        [ffmpeg, "-hide_banner", *ffmpeg_input(video)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    src_w, src_h = _parse_size(probe.stderr.decode("utf-8", "replace"))
    if not src_w or not src_h:
        raise RuntimeError("读不出视频分辨率，无法追踪")

    scale = min(1.0, max_side / max(src_w, src_h))
    # 宽高都取偶数：奇数尺寸在部分 ffmpeg 缩放器上会被悄悄调整，那样解出来的
    # 每帧字节数和我们算的对不上，reshape 会错位。
    dst_w = max(2, int(round(src_w * scale)) // 2 * 2)
    dst_h = max(2, int(round(src_h * scale)) // 2 * 2)

    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", *ffmpeg_input(video),
         "-vf", f"scale={dst_w}:{dst_h}", "-pix_fmt", "gray",
         "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[:500] or "ffmpeg 解码失败")

    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    per = dst_w * dst_h
    if buf.size < per:
        raise RuntimeError("视频没有解出任何一帧")
    frames = buf[: buf.size - buf.size % per].reshape(-1, dst_h, dst_w)
    return frames, (src_w, src_h), (dst_w, dst_h)


def _zncc_map(window: np.ndarray, templ: np.ndarray) -> np.ndarray:
    """在 window 里滑动 templ，返回每个位置的 ZNCC 得分图。

    ZNCC 而不是差值平方和：前者对整体明暗变化免疫（云飘过、自动曝光跳一下
    都不至于让匹配崩掉），后者会。
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
    # 逐候选块的模长。加 eps 防止纯色块（模长 0）除出 inf
    norms = np.sqrt((centered * centered).sum(axis=2)) + 1e-6
    return (centered @ t) / (norms * t_norm)


def _subpixel(score: np.ndarray, iy: int, ix: int) -> Tuple[float, float]:
    """在得分图的峰值附近做抛物线拟合，把整数峰值细化到亚像素。

    只用峰值和左右各一个点。偏移量夹在 ±0.5 内——超出这个范围说明峰不是峰
    （平顶或者双峰），这时候硬拟合出来的值不可信，宁可退回整数位置。
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
    """取以 (cx, cy) 为中心、边长 2*half+1 的方块。越界返回 None。"""
    x, y = int(round(cx)), int(round(cy))
    if x - half < 0 or y - half < 0:
        return None
    if x + half + 1 > frame.shape[1] or y + half + 1 > frame.shape[0]:
        return None
    return frame[y - half:y + half + 1, x - half:x + half + 1]


def _walk(frames: np.ndarray, start: int, order: Sequence[int],
          templ0: np.ndarray, x0: float, y0: float,
          ) -> Dict[int, Tuple[float, float, bool]]:
    """从查询帧沿 order 走一遍，逐帧定位。返回 {帧号: (x, y, 可见)}。

    跟丢之后不放弃：位置按最后一段速度外推着往前带，模板**不再更新**。
    目标被挡住几帧又露出来是常事，把外推的位置作为下一次搜索的中心，
    比停在原地更可能重新咬住。外推期间一律标成不可见。
    """
    half = templ0.shape[0] // 2
    templ = templ0.astype(np.float32).copy()
    x, y = x0, y0
    vx = vy = 0.0
    gap = 0  # 已经连续丢了多少帧，重新咬住时用它把速度摊平
    out: Dict[int, Tuple[float, float, bool]] = {start: (x0, y0, True)}

    lost = False
    for f in order:
        frame = frames[f]
        px, py = x + vx, y + vy  # 先按上一段速度预测，再在预测点附近搜
        radius = REACQUIRE if lost else SEARCH
        pad = half + radius
        # 画面比搜索窗还小的话没法搜，直接算不可见
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

        # 得分图左上角对应的中心坐标是 (cx - radius, cy - radius)
        nx = cx - radius + float(ix) + dx
        ny = cy - radius + float(iy) + dy

        visible = best >= OCCLUDED_BELOW
        if visible:
            # 重新咬住之后速度要按**实际走过的帧数**摊，不能拿一帧的位移当速度：
            # 挡了 30 帧再出来时 nx - x 是三十帧的总位移，直接当速度会让下一帧
            # 的预测冲出去一大截，刚咬住又丢。
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
            # 跟丢：按**匀速**继续外推，不衰减。
            # 衰减等于假设目标停下了，而挡住它的东西通常是别的物体从前面划过，
            # 目标自己还在按原速走——实测衰减会让预测点原地不动，目标出来时
            # 已经离开搜索窗，整条轨迹从此再也接不上。
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
    """在解码分辨率上追一组点。queries 是 [(帧号, x, y), ...]，坐标同解码分辨率。

    每个点从自己的查询帧出发，向后走到片尾、向前走到片头——用户在中间某帧
    指的目标，前后都该有轨迹，只往后走会让前半段凭空缺失。
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
            notes.append("查询点太靠近画面边缘，取不出完整模板")
            tracks.append([[float(qx), float(qy)]] * total)
            visible.append([False] * total)
            if on_progress:
                on_progress(qi + 1, len(queries))
            continue

        texture = float(templ.astype(np.float32).std())
        if texture < MIN_TEXTURE:
            # 纯色区域内部没有可对应的局部特征，匹配结果纯属噪声。
            # 与其给一条乱跑的轨迹，不如整条标成不可见并说明原因。
            notes.append(f"查询点周围几乎没有纹理（对比度 {texture:.1f}），这一档追不住")
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
