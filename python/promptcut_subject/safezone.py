"""从检测框算「哪一侧是空的」。

纯 numpy，不依赖任何推理引擎 —— 所以它能在内置解释器里单测，也能被 node 侧
以外的地方复用。

四个区域按卡片实际会摆的位置划：
  - left  : 左半屏  x ∈ [0, w/2)
  - right : 右半屏  x ∈ [w/2, w)
  - top   : 上三分之一带  y ∈ [0, h/3)
  - bottom: 下三分之一带  y ∈ [2h/3, h)

左右是「半屏」而上下是「三分之一带」不是笔误：卡片横向要么靠左要么靠右，
二选一各占半屏；纵向则是贴着上边或下边的一条带子，中间那三分之一是人脸最
常在的位置，不该算进任何一侧。四个区域故意互相重叠（左上角同时属于 left 和
top），occupancy 是四个独立的比例，不是一个和为 1 的分布。
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence

import numpy as np

# 掩膜格子数上限。1080p 的整张掩膜是 200 万格，bool 也就 2 MB、算一次不到 1 ms，
# 但 4K 就 800 万格了；超过这个数按面积等比降采样，量化误差在千分位以下，而
# occupancy 本来就只报到千分位。
GRID_MAX = 1_000_000

# 并列时的优先顺序。视频里人多半站中间偏左（采访机位习惯），右边更常是空的，
# 所以完全平手时先挑 right；上下带子比半屏窄，能放的东西少，排在最后。
SIDE_PRIORITY = ("right", "left", "bottom", "top")


def coverage_mask(width: int, height: int, boxes: Sequence[Dict[str, Any]]) -> np.ndarray:
    """把一组框糊成一张 bool 掩膜（并集，重叠的地方不重复计面积）。"""
    if width <= 0 or height <= 0:
        return np.zeros((1, 1), dtype=bool)

    scale = 1.0
    if width * height > GRID_MAX:
        scale = (GRID_MAX / float(width * height)) ** 0.5
    gw = max(1, int(round(width * scale)))
    gh = max(1, int(round(height * scale)))

    mask = np.zeros((gh, gw), dtype=bool)
    for box in boxes or []:
        x = float(box.get("x", 0.0))
        y = float(box.get("y", 0.0))
        w = float(box.get("w", 0.0))
        h = float(box.get("h", 0.0))
        if w <= 0 or h <= 0:
            continue
        x0 = int(round(x * gw / width))
        x1 = int(round((x + w) * gw / width))
        y0 = int(round(y * gh / height))
        y1 = int(round((y + h) * gh / height))
        x0 = max(0, min(gw, x0))
        x1 = max(0, min(gw, x1))
        y0 = max(0, min(gh, y0))
        y1 = max(0, min(gh, y1))
        # 框小到不足一格时也别丢：至少占一格，否则「有个小脸」会被算成完全没人
        if x1 <= x0:
            x1 = min(gw, x0 + 1)
            x0 = max(0, x1 - 1)
        if y1 <= y0:
            y1 = min(gh, y0 + 1)
            y0 = max(0, y1 - 1)
        mask[y0:y1, x0:x1] = True
    return mask


def occupancy(width: int, height: int, boxes: Sequence[Dict[str, Any]]) -> Dict[str, float]:
    """四个区域各被框覆盖了多少（0~1，报到千分位）。"""
    mask = coverage_mask(width, height, boxes)
    gh, gw = mask.shape

    half = max(1, gw // 2)
    third = max(1, gh // 3)

    def ratio(sub: np.ndarray) -> float:
        if sub.size == 0:
            return 0.0
        return round(float(sub.mean()), 3)

    return {
        "left": ratio(mask[:, :half]),
        "right": ratio(mask[:, half:]),
        "top": ratio(mask[:third, :]),
        "bottom": ratio(mask[gh - third:, :]),
    }


def safe_side(occ: Dict[str, float]) -> str:
    """被遮得最少的那一侧。并列时按 SIDE_PRIORITY 挑。

    比的是**已经四舍五入到千分位**的值，和输出给上层的数字是同一批 —— 否则
    会出现「报出来两边都是 0.120，却挑了看不出区别的那个」这种没法解释的结果。
    """
    best = min(occ.get(side, 0.0) for side in SIDE_PRIORITY)
    for side in SIDE_PRIORITY:
        if occ.get(side, 0.0) <= best:
            return side
    return SIDE_PRIORITY[0]


def analyze(width: int, height: int, boxes: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """一步到位：{"occupancy": {...}, "safeSide": "right"}。"""
    occ = occupancy(width, height, boxes)
    return {"occupancy": occ, "safeSide": safe_side(occ)}


def merge_occupancy(items: Sequence[Dict[str, float]]) -> Dict[str, float]:
    """多个样本的 occupancy 取平均（node 侧 subjectForRange 的同款算法）。"""
    keys = ("left", "right", "top", "bottom")
    if not items:
        return {k: 0.0 for k in keys}
    out: Dict[str, float] = {}
    for k in keys:
        vals: List[float] = [float(it.get(k, 0.0)) for it in items]
        out[k] = round(sum(vals) / len(vals), 3)
    return out
