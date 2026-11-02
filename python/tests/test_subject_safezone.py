"""safezone: synthetic boxes verify the occupancy algorithm and the tie-breaking rule of safeSide.

Pure numpy, no inference engine needs to be installed, and it runs in the built-in interpreter too.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from promptcut_subject.safezone import (analyze, coverage_mask,  # noqa: E402
                                        merge_occupancy, occupancy, safe_side)

# Deliberately pick a size whose width and height are both divisible by 2 and 3 and whose cell count is below the downsampling threshold,
# so the expected values are exactly 0 / 1 / 1/3 and no margin is needed for quantization.
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
        # The top and bottom bands are each half covered by the right half
        self.assertEqual(occ["top"], 0.5)
        self.assertEqual(occ["bottom"], 0.5)

    def test_top_band_fully_covered(self):
        occ = occupancy(W, H, [box(0, 0, W, H / 3)])
        self.assertEqual(occ["top"], 1.0)
        self.assertEqual(occ["bottom"], 0.0)
        self.assertAlmostEqual(occ["left"], 1 / 3, places=2)
        self.assertAlmostEqual(occ["right"], 1 / 3, places=2)

    def test_overlapping_boxes_count_once(self):
        """Two completely overlapping boxes must not make occupancy 2."""
        one = occupancy(W, H, [box(0, 0, W / 2, H)])
        two = occupancy(W, H, [box(0, 0, W / 2, H), box(0, 0, W / 2, H)])
        self.assertEqual(one, two)
        self.assertEqual(two["left"], 1.0)

    def test_tiny_box_is_not_lost_from_the_mask(self):
        """A face smaller than one cell must still leave one cell on the mask.

        Note that occupancy itself is still 0.000: one cell is two millionths of 4000×4000,
        the thousandths place is 0, which is right: a small face really takes up almost no room. What is guarded here is that the mask must not drop
        it entirely (however small the area, it still means "there is something here"), while other judgments can be based on the box itself.
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
        """When the whole screen is people (all four sides 1.0), pick right according to the priority order."""
        self.assertEqual(analyze(W, H, [box(0, 0, W, H)])["safeSide"], "right")
        self.assertEqual(analyze(W, H, [])["safeSide"], "right")

    def test_bottom_beats_top_when_tied(self):
        """The middle band is fully occupied: left and right are both 1/3, top and bottom are both 0, and on a tie bottom ranks ahead of top."""
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
        """The comparison uses the thousandths-rounded numbers that are reported, so "both sides say 0.12 yet the other one was picked" must not happen."""
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
