"""Compute "which side is empty" from detection boxes.

Pure numpy, independent of any inference engine, so it can be unit-tested in the bundled interpreter and can be reused in places
other than the node side.

The four regions are drawn according to where cards are actually placed:
  - left  : left half of the screen  x ∈ [0, w/2)
  - right : right half of the screen  x ∈ [w/2, w)
  - top   : top-third band  y ∈ [0, h/3)
  - bottom: bottom-third band  y ∈ [2h/3, h)

Left/right being a "half screen" while top/bottom are a "third band" is not a typo: horizontally a card sits either at the left or at the right,
one of the two, each taking half the screen; vertically it is a band hugging the top or bottom edge, and the middle third is where faces most
often are, so it should not count toward either side. The four regions deliberately overlap (the top-left corner belongs to both left and
top), and occupancy is four independent ratios, not a distribution that sums to 1.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence

import numpy as np

# Upper limit of mask cells. A full 1080p mask is 2 million cells, only 2 MB as bool and under 1 ms to compute once,
# but 4K is already 8 million cells; above this number it is downsampled proportionally by area, and the quantization error is below the thousandths place, while
# occupancy is only reported to the thousandths place anyway.
GRID_MAX = 1_000_000

# Priority order for ties. People in videos mostly stand slightly left of center (interview camera habits), so the right side is more often empty,
# so in a complete tie pick right first; the top/bottom bands are narrower than the half screens and hold less, so they come last.
SIDE_PRIORITY = ("right", "left", "bottom", "top")


def coverage_mask(width: int, height: int, boxes: Sequence[Dict[str, Any]]) -> np.ndarray:
    """Paint a group of boxes into one bool mask (union; overlapping areas are not counted twice)."""
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
        # Do not drop a box that is smaller than one cell: make it occupy at least one cell, otherwise "there is a small face" would be counted as nobody being there at all
        if x1 <= x0:
            x1 = min(gw, x0 + 1)
            x0 = max(0, x1 - 1)
        if y1 <= y0:
            y1 = min(gh, y0 + 1)
            y0 = max(0, y1 - 1)
        mask[y0:y1, x0:x1] = True
    return mask


def occupancy(width: int, height: int, boxes: Sequence[Dict[str, Any]]) -> Dict[str, float]:
    """How much of each of the four regions is covered by boxes (0~1, reported to the thousandths place)."""
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
    """The side that is covered the least. Ties are broken by SIDE_PRIORITY.

    The comparison uses values **already rounded to the thousandths place**, the same numbers that are output to the upper layer; otherwise
    you would get unexplainable results like "both sides are reported as 0.120, yet the one that looks no different was picked".
    """
    best = min(occ.get(side, 0.0) for side in SIDE_PRIORITY)
    for side in SIDE_PRIORITY:
        if occ.get(side, 0.0) <= best:
            return side
    return SIDE_PRIORITY[0]


def analyze(width: int, height: int, boxes: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """All in one step: {"occupancy": {...}, "safeSide": "right"}."""
    occ = occupancy(width, height, boxes)
    return {"occupancy": occ, "safeSide": safe_side(occ)}


def merge_occupancy(items: Sequence[Dict[str, float]]) -> Dict[str, float]:
    """Average the occupancy of multiple samples (the same algorithm as subjectForRange on the node side)."""
    keys = ("left", "right", "top", "bottom")
    if not items:
        return {k: 0.0 for k in keys}
    out: Dict[str, float] = {}
    for k in keys:
        vals: List[float] = [float(it.get(k, 0.0)) for it in items]
        out[k] = round(sum(vals) / len(vals), 3)
    return out
