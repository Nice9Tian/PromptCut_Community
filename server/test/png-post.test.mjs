// Pixel work done in the render worker (server/png-post.mjs): resize, underlay background
// color, count transparent pixels, composite asset layer
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

test("shrink scales proportionally so the long edge is MAX_EDGE, and the output is opaque", () => {
  const src = png(1920, 1080, (d, o) => { d[o] = 255; d[o + 3] = 255; });
  const { png: out, width, height } = shrink(src);
  assert.equal(width, MAX_EDGE);
  assert.equal(height, Math.round(1080 * (MAX_EDGE / 1920)));
  assert.equal(out.data[3], 255);
  assert.equal(out.data[0], 255); // Checkerboard is not visible where fully covered
});

test("shrink: fully transparent areas get a checkerboard (not black)", () => {
  const src = png(64, 64, () => {});
  const { png: out } = shrink(src);
  assert.ok(out.data[0] > 0x50, "Transparent areas should have a mid-tone checker color");
});

test("flatten composites transparency onto the background color", () => {
  const p = png(2, 1, (d, o, x) => { if (x === 0) { d[o] = 10; d[o + 3] = 255; } });
  flatten(p, "ff0000");
  assert.deepEqual([...p.data.subarray(0, 4)], [10, 0, 0, 255]);
  assert.deepEqual([...p.data.subarray(4, 8)], [255, 0, 0, 255]);
});

test("transparentRatio counts fully transparent pixels", () => {
  const p = png(4, 1, (d, o, x) => { if (x < 1) d[o + 3] = 255; });
  assert.equal(transparentRatio(p), 0.75);
});

test("postFrame: when nothing needs doing, copy as is without decoding", async () => {
  const dir = tmpDir();
  const cards = path.join(dir, "c.png");
  fs.writeFileSync(cards, PNG.sync.write(png(8, 8, (d, o) => { d[o + 3] = 255; })));
  const out = path.join(dir, "o.png");
  const r = await postFrame({ cards, out });
  assert.equal(r.width, null);
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(cards));
});

test("postFrame: the media layer goes under the card, then composite the background color and count transparency", async () => {
  const dir = tmpDir();
  const cards = path.join(dir, "c.png");
  const layer = path.join(dir, "l.png");
  // Card covers only the left half (blue), asset layer fills completely (green)
  fs.writeFileSync(cards, PNG.sync.write(png(4, 2, (d, o, x) => { if (x < 2) { d[o + 2] = 255; d[o + 3] = 255; } })));
  fs.writeFileSync(layer, PNG.sync.write(png(4, 2, (d, o) => { d[o + 1] = 255; d[o + 3] = 255; })));
  const out = path.join(dir, "o.png");
  const r = await postFrame({ cards, layers: [layer], out, stats: true });
  assert.equal(r.width, 4);
  assert.equal(r.transparentRatio, 0);
  const img = PNG.sync.read(fs.readFileSync(out));
  assert.deepEqual([...img.data.subarray(0, 4)], [0, 0, 255, 255]); // Card is on top
  assert.deepEqual([...img.data.subarray(12, 16)], [0, 255, 0, 255]); // Asset is exposed on the right
});

test("postFrame: the order of bg + stats is the same as before (composite the background color first, then count)", async () => {
  const dir = tmpDir();
  const cards = path.join(dir, "c.png");
  fs.writeFileSync(cards, PNG.sync.write(png(2, 2, () => {})));
  const r = await postFrame({ cards, out: path.join(dir, "o.png"), bg: "0b0f17", stats: true });
  assert.equal(r.transparentRatio, 0);
});
