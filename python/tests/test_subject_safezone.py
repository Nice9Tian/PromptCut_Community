"""safezone：合成框验 occupancy 的算法和 safeSide 的并列规则。

纯 numpy，不需要装任何推理引擎，内置解释器里也能跑。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from promptcut_subject.safezone import (analyze, coverage_mask,  # noqa: E402
                                        merge_occupancy, occupancy, safe_side)

# 故意选一个宽高都能被 2 和 3 整除、且格子数不到降采样阈值的尺寸，
# 这样期望值是精确的 0 / 1 / 1/3，不用为量化留余量。
W, H = 1200, 600


def box(x, y, w, h, label="person"):
    return {"label": label, "x": x, "y": y, "w": w, "h": h, "conf": 0.9}


class TestOccupancy(unittest.TestCase):
    def test_no_boxes_is_all_zero(self):
        occ = occupancy(W, H, [])
        self.assertEqual(occ, {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0})

    def test_right_half_fully_covered(self):
        occ = occupancy(W, H, [box(W / 2, 0, W / 2, H)])
        self.assertEqual(occ["right"], 1.0)
        self.assertEqual(occ["left"], 0.0)
        # 上下带子各被右半边盖掉一半
        self.assertEqual(occ["top"], 0.5)
        self.assertEqual(occ["bottom"], 0.5)

    def test_top_band_fully_covered(self):
        occ = occupancy(W, H, [box(0, 0, W, H / 3)])
        self.assertEqual(occ["top"], 1.0)
        self.assertEqual(occ["bottom"], 0.0)
        self.assertAlmostEqual(occ["left"], 1 / 3, places=2)
        self.assertAlmostEqual(occ["right"], 1 / 3, places=2)

    def test_overlapping_boxes_count_once(self):
        """两个完全重合的框不能把 occupancy 算成 2。"""
        one = occupancy(W, H, [box(0, 0, W / 2, H)])
        two = occupancy(W, H, [box(0, 0, W / 2, H), box(0, 0, W / 2, H)])
        self.assertEqual(one, two)
        self.assertEqual(two["left"], 1.0)

    def test_tiny_box_is_not_lost_from_the_mask(self):
        """小到不足一格的脸在掩膜上也要留一格。

        注意 occupancy 本身仍会是 0.000 —— 一格占 4000×4000 的百万分之二，
        千分位就是 0，这是对的：一张小脸确实几乎不占地方。这里守的是掩膜别把
        它整个丢掉（面积再小也是「这儿有东西」），别的判断可以基于框本身。
        """
        mask = coverage_mask(4000, 4000, [box(10, 10, 0.5, 0.5, "face")])
        self.assertEqual(int(mask.sum()), 1)

    def test_degenerate_frame_size(self):
        self.assertEqual(occupancy(0, 0, [box(0, 0, 10, 10)]),
                         {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0})


class TestSafeSide(unittest.TestCase):
    def test_person_on_the_left_pushes_card_right(self):
        self.assertEqual(analyze(W, H, [box(0, 0, W / 2, H)])["safeSide"], "right")

    def test_person_on_the_right_pushes_card_left(self):
        self.assertEqual(analyze(W, H, [box(W / 2, 0, W / 2, H)])["safeSide"], "left")

    def test_all_tied_prefers_right(self):
        """满屏都是人（四边都 1.0）时按优先顺序挑 right。"""
        self.assertEqual(analyze(W, H, [box(0, 0, W, H)])["safeSide"], "right")
        self.assertEqual(analyze(W, H, [])["safeSide"], "right")

    def test_bottom_beats_top_when_tied(self):
        """中间带被占满：左右都是 1/3，上下都是 0，并列时 bottom 排在 top 前面。"""
        occ = occupancy(W, H, [box(0, H / 3, W, H / 3)])
        self.assertEqual(occ["top"], 0.0)
        self.assertEqual(occ["bottom"], 0.0)
        self.assertEqual(safe_side(occ), "bottom")

    def test_top_only_when_bottom_is_worse(self):
        occ = occupancy(W, H, [box(0, H * 2 / 3, W, H / 3)])
        self.assertEqual(occ["bottom"], 1.0)
        self.assertEqual(occ["top"], 0.0)
        self.assertEqual(safe_side(occ), "top")

    def test_compares_rounded_values(self):
        """比较用的是报出去的千分位数字，不能出现「两边都写 0.12 却挑了另一个」。"""
        occ = {"left": 0.1234, "right": 0.1236, "top": 0.9, "bottom": 0.9}
        self.assertEqual(safe_side({k: round(v, 3) for k, v in occ.items()}), "left")


class TestMerge(unittest.TestCase):
    def test_average(self):
        merged = merge_occupancy([
            {"left": 0.0, "right": 1.0, "top": 0.5, "bottom": 0.0},
            {"left": 1.0, "right": 0.0, "top": 0.5, "bottom": 1.0},
        ])
        self.assertEqual(merged, {"left": 0.5, "right": 0.5, "top": 0.5, "bottom": 0.5})

    def test_empty(self):
        self.assertEqual(merge_occupancy([]),
                         {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0})


if __name__ == "__main__":
    unittest.main()
