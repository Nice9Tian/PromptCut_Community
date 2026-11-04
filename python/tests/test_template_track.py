"""Template-matching fallback tier: no network, no ffmpeg needed, synthetic frames are fed in directly.

These pinned cases are all pitfalls that were hit, or nearly hit, in real testing, not written to pad coverage:

- Sub-pixel precision: integer-level peak localization makes the card jump once per frame, which is visible to the naked eye.
- Re-acquiring after occlusion: **this is the most important one**. The first version decayed the velocity by 0.5 when the target was lost,
  which amounts to assuming the target had stopped; the target kept moving at constant speed, ran out of the search window within about ten frames, and the whole trajectory from then on
  could never reconnect, and it "looked" as if it were still outputting coordinates normally, only all of them wrong.
- With no texture it must say plainly that it cannot track, instead of giving a wildly wandering trajectory.
"""

import os
import sys
import unittest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None


@unittest.skipIf(np is None, "numpy is not available")
class TemplateTrackTest(unittest.TestCase):
    W, H, T = 320, 200, 60

    def setUp(self):
        from promptcut_track import template

        self.tm = template
        rng = np.random.default_rng(3)
        # A textured background + a textured target
        bg = rng.integers(40, 210, size=(self.H // 4, self.W // 4), dtype=np.uint8)
        self.bg = np.repeat(np.repeat(bg, 4, axis=0), 4, axis=1).astype(np.uint8)
        self.patch = rng.integers(0, 255, size=(20, 20), dtype=np.uint8)

    def _make(self, path, occlude=None):
        """Generate a frame sequence along the given trajectory. path is [(x, y), ...], and its length is the frame count."""
        frames = []
        for i, (x, y) in enumerate(path):
            img = self.bg.copy()
            xi, yi = int(round(x)) - 10, int(round(y)) - 10
            img[yi:yi + 20, xi:xi + 20] = self.patch
            if occlude and occlude[0] <= i <= occlude[1]:
                # A dark vertical bar covers the target
                img[:, xi - 6:xi + 26] = 15
            frames.append(img)
        return np.stack(frames)

    def test_uniform_straight_line_subpixel_precision(self):
        path = [(60.0 + t * 2.0, 70.0 + t * 0.8) for t in range(self.T)]
        frames = self._make(path)
        r = self.tm.track_template(frames, [(0, path[0][0], path[0][1])])

        xy = r["tracks"][0]
        vis = r["visible"][0]
        self.assertIsNone(r["notes"][0])
        self.assertGreaterEqual(int(vis.sum()), self.T - 2, "Almost every frame should be visible")

        gt = np.asarray(path, dtype=np.float32)
        err = np.linalg.norm(xy[vis] - gt[vis], axis=1)
        # Sub-pixel: with integer-level localization the mean error would be above 0.5 with obvious jitter
        self.assertLess(float(err.mean()), 0.6, f"Mean error {err.mean():.2f}px is too large")

    def test_must_reacquire_after_being_occluded(self):
        """Regression: while lost it must extrapolate at constant velocity, and must not decay the velocity to 0."""
        path = [(50.0 + t * 2.2, 100.0) for t in range(self.T)]
        frames = self._make(path, occlude=(20, 34))
        r = self.tm.track_template(frames, [(0, path[0][0], path[0][1])])

        vis = r["visible"][0]
        xy = r["tracks"][0]
        gt = np.asarray(path, dtype=np.float32)

        # Within the occlusion interval it should be judged invisible
        self.assertGreater(int((~vis[20:35]).sum()), 8, "Occluded frames should basically all be judged invisible")
        # Key point: **after** the occlusion it must re-acquire, rather than staying wrong from then on
        tail = slice(45, self.T)
        self.assertTrue(bool(vis[tail].all()), "It should re-acquire after the occlusion ends")
        err = np.linalg.norm(xy[tail] - gt[tail], axis=1)
        self.assertLess(float(err.max()), 2.0, f"Error {err.max():.2f}px after re-acquiring is too large")

    def test_textureless_point_must_say_it_cannot_be_tracked(self):
        path = [(60.0 + t * 1.5, 80.0) for t in range(self.T)]
        frames = self._make(path)
        # Smear a patch of solid color into the bottom-right corner of the frame and place a point right in its middle
        frames[:, 140:190, 240:300] = 255
        r = self.tm.track_template(frames, [(0, 270.0, 165.0)])

        self.assertIsNotNone(r["notes"][0], "A textureless point must carry a note saying it cannot be tracked")
        self.assertIn("texture", r["notes"][0])
        self.assertEqual(int(r["visible"][0].sum()), 0, "When it cannot be tracked, no frame may be marked visible")

    def test_starting_from_a_middle_frame_tracks_both_forward_and_backward(self):
        path = [(40.0 + t * 2.0, 90.0) for t in range(self.T)]
        frames = self._make(path)
        mid = self.T // 2
        r = self.tm.track_template(frames, [(mid, path[mid][0], path[mid][1])])

        vis = r["visible"][0]
        gt = np.asarray(path, dtype=np.float32)
        err = np.linalg.norm(r["tracks"][0] - gt, axis=1)
        # There must be a trajectory before the query frame too: only going forward would leave the first half missing out of thin air
        self.assertTrue(bool(vis[:mid].all()), "Frames before the query frame should be tracked too")
        self.assertLess(float(err.max()), 2.0)

    def test_point_at_the_edge_does_not_crash(self):
        """When a complete template cannot be extracted, a note must be given, and no exception may be raised."""
        path = [(60.0, 60.0)] * self.T
        frames = self._make(path)
        r = self.tm.track_template(frames, [(0, 2.0, 2.0)])
        self.assertIsNotNone(r["notes"][0])
        self.assertEqual(int(r["visible"][0].sum()), 0)


if __name__ == "__main__":
    unittest.main()
