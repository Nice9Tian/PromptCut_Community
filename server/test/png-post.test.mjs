// 渲染 worker 里做的像素活(server/png-post.mjs):缩图、压底色、数透明像素、合成素材层
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { postFrame, shrink, flatten, transparentRatio, MAX_EDGE } from "../png-post.mjs";

function png(w, h, fill) {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) fill(p.data, i << 2, i % w, Math.floor(i / w));
  return p;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pc-post-"));
}

test("shrink 等比缩到长边 MAX_EDGE,输出不透明", () => {
  const src = png(1920, 1080, (d, o) => { d[o] = 255; d[o + 3] = 255; });
  const { png: out, width, height } = shrink(src);
  assert.equal(width, MAX_EDGE);
  assert.equal(height, Math.round(1080 * (MAX_EDGE / 1920)));
  assert.equal(out.data[3], 255);
  assert.equal(out.data[0], 255); // 全盖住的地方看不到棋盘格
});

test("shrink:全透明的地方铺棋盘格(不是黑色)", () => {
  const src = png(64, 64, () => {});
  const { png: out } = shrink(src);
  assert.ok(out.data[0] > 0x50, "透明处应该是中间调的格子色");
});

test("flatten 把透明压到底色上", () => {
  const p = png(2, 1, (d, o, x) => { if (x === 0) { d[o] = 10; d[o + 3] = 255; } });
  flatten(p, "ff0000");
  assert.deepEqual([...p.data.subarray(0, 4)], [10, 0, 0, 255]);
  assert.deepEqual([...p.data.subarray(4, 8)], [255, 0, 0, 255]);
});

test("transparentRatio 数全透明像素", () => {
  const p = png(4, 1, (d, o, x) => { if (x < 1) d[o + 3] = 255; });
  assert.equal(transparentRatio(p), 0.75);
});

test("postFrame:什么都不用做就原样拷贝,不解码", async () => {
  const dir = tmpDir();
  const cards = path.join(dir, "c.png");
  fs.writeFileSync(cards, PNG.sync.write(png(8, 8, (d, o) => { d[o + 3] = 255; })));
  const out = path.join(dir, "o.png");
  const r = await postFrame({ cards, out });
  assert.equal(r.width, null);
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(cards));
});

test("postFrame:素材层垫在卡片下面,再压底色、数透明", async () => {
  const dir = tmpDir();
  const cards = path.join(dir, "c.png");
  const layer = path.join(dir, "l.png");
  // 卡片只盖左半边(蓝),素材层铺满(绿)
  fs.writeFileSync(cards, PNG.sync.write(png(4, 2, (d, o, x) => { if (x < 2) { d[o + 2] = 255; d[o + 3] = 255; } })));
  fs.writeFileSync(layer, PNG.sync.write(png(4, 2, (d, o) => { d[o + 1] = 255; d[o + 3] = 255; })));
  const out = path.join(dir, "o.png");
  const r = await postFrame({ cards, layers: [layer], out, stats: true });
  assert.equal(r.width, 4);
  assert.equal(r.transparentRatio, 0);
  const img = PNG.sync.read(fs.readFileSync(out));
  assert.deepEqual([...img.data.subarray(0, 4)], [0, 0, 255, 255]); // 卡片在上
  assert.deepEqual([...img.data.subarray(12, 16)], [0, 255, 0, 255]); // 右边露出素材
});

test("postFrame:bg + stats 的顺序和原来一致(先压底色,再数)", async () => {
  const dir = tmpDir();
  const cards = path.join(dir, "c.png");
  fs.writeFileSync(cards, PNG.sync.write(png(2, 2, () => {})));
  const r = await postFrame({ cards, out: path.join(dir, "o.png"), bg: "0b0f17", stats: true });
  assert.equal(r.transparentRatio, 0);
});
