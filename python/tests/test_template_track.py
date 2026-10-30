"""模板匹配兜底档：不联网、不要 ffmpeg，直接喂合成帧。

这几条钉住的都是实测踩过或差点踩过的坑，不是为了凑覆盖率：

- 亚像素精度：整数级的峰值定位会让卡片一帧一跳，肉眼看得出来。
- 遮挡后重新咬住：**这条是最要紧的**。第一版丢失时把速度按 0.5 衰减，
  等于假设目标停下了；目标继续匀速走，十来帧就跑出了搜索窗，整条轨迹从此
  再也接不上——而且它「看起来」还在正常输出坐标，只是全都错的。
- 无纹理必须明说追不住，而不是给一条乱跑的轨迹。
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


@unittest.skipIf(np is None, "没有 numpy")
class TemplateTrackTest(unittest.TestCase):
    W, H, T = 320, 200, 60

    def setUp(self):
        from promptcut_track import template

        self.tm = template
        rng = np.random.default_rng(3)
        # 有纹理的背景 + 一块有纹理的目标
        bg = rng.integers(40, 210, size=(self.H // 4, self.W // 4), dtype=np.uint8)
        self.bg = np.repeat(np.repeat(bg, 4, axis=0), 4, axis=1).astype(np.uint8)
        self.patch = rng.integers(0, 255, size=(20, 20), dtype=np.uint8)

    def _make(self, path, occlude=None):
        """按给定轨迹生成帧序列。path 是 [(x, y), ...]，长度即帧数。"""
        frames = []
        for i, (x, y) in enumerate(path):
            img = self.bg.copy()
            xi, yi = int(round(x)) - 10, int(round(y)) - 10
            img[yi:yi + 20, xi:xi + 20] = self.patch
            if occlude and occlude[0] <= i <= occlude[1]:
                # 一条深色竖条盖住目标
                img[:, xi - 6:xi + 26] = 15
            frames.append(img)
        return np.stack(frames)

    def test_匀速直线_亚像素精度(self):
        path = [(60.0 + t * 2.0, 70.0 + t * 0.8) for t in range(self.T)]
        frames = self._make(path)
        r = self.tm.track_template(frames, [(0, path[0][0], path[0][1])])

        xy = r["tracks"][0]
        vis = r["visible"][0]
        self.assertIsNone(r["notes"][0])
        self.assertGreaterEqual(int(vis.sum()), self.T - 2, "几乎每帧都该可见")

        gt = np.asarray(path, dtype=np.float32)
        err = np.linalg.norm(xy[vis] - gt[vis], axis=1)
        # 亚像素：整数级定位的话平均误差会在 0.5 以上并且抖动明显
        self.assertLess(float(err.mean()), 0.6, f"平均误差 {err.mean():.2f}px 偏大")

    def test_被挡住之后要重新咬住(self):
        """回归：丢失期间必须按匀速外推，不能把速度衰减到 0。"""
        path = [(50.0 + t * 2.2, 100.0) for t in range(self.T)]
        frames = self._make(path, occlude=(20, 34))
        r = self.tm.track_template(frames, [(0, path[0][0], path[0][1])])

        vis = r["visible"][0]
        xy = r["tracks"][0]
        gt = np.asarray(path, dtype=np.float32)

        # 遮挡区间里应该判为不可见
        self.assertGreater(int((~vis[20:35]).sum()), 8, "遮挡帧基本都该判成不可见")
        # 关键：遮挡**之后**要重新咬住，而不是从此一路错下去
        tail = slice(45, self.T)
        self.assertTrue(bool(vis[tail].all()), "遮挡结束后应该重新咬住")
        err = np.linalg.norm(xy[tail] - gt[tail], axis=1)
        self.assertLess(float(err.max()), 2.0, f"重新咬住后误差 {err.max():.2f}px 偏大")

    def test_无纹理的点要明说追不住(self):
        path = [(60.0 + t * 1.5, 80.0) for t in range(self.T)]
        frames = self._make(path)
        # 画面右下角糊一块纯色，往它正中指一个点
        frames[:, 140:190, 240:300] = 255
        r = self.tm.track_template(frames, [(0, 270.0, 165.0)])

        self.assertIsNotNone(r["notes"][0], "无纹理的点必须带 note 说明追不住")
        self.assertIn("纹理", r["notes"][0])
        self.assertEqual(int(r["visible"][0].sum()), 0, "追不住时不能有任何一帧标成可见")

    def test_从中间某帧出发要往前也往后追(self):
        path = [(40.0 + t * 2.0, 90.0) for t in range(self.T)]
        frames = self._make(path)
        mid = self.T // 2
        r = self.tm.track_template(frames, [(mid, path[mid][0], path[mid][1])])

        vis = r["visible"][0]
        gt = np.asarray(path, dtype=np.float32)
        err = np.linalg.norm(r["tracks"][0] - gt, axis=1)
        # 查询帧之前也要有轨迹：只往后走会让前半段凭空缺失
        self.assertTrue(bool(vis[:mid].all()), "查询帧之前也该追出来")
        self.assertLess(float(err.max()), 2.0)

    def test_贴边的点不崩(self):
        """取不出完整模板时要给 note，不能抛异常。"""
        path = [(60.0, 60.0)] * self.T
        frames = self._make(path)
        r = self.tm.track_template(frames, [(0, 2.0, 2.0)])
        self.assertIsNotNone(r["notes"][0])
        self.assertEqual(int(r["visible"][0].sum()), 0)


if __name__ == "__main__":
    unittest.main()
