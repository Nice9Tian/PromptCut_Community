import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { CardFrameCache } from '../card-cache.mjs';

// 契约 E.3:plan() 要求环境指纹(M4)。这里只补输入,断言不变。
const ENV_FP = '0123456789abcdef';

// Cached samples are PNGs carrying their render record; a lookup validates the bytes it reads.
const paintedPng = () => {
  const png = new PNG({ width: 16, height: 8 });
  png.data.fill(255);
  return PNG.sync.write(png);
};

const graph = compositing => ({ definitions: [], nodes: [{ id: 'card', adapter: 'chrome', cardId: 'demo', capabilities: { compositing, need_prerendering: false }, inputs: {} }],
  outputs: [{ nodeId: 'card', clipId: 'clip', start: 1.01, end: 1.2, opacity: 1, frame: { x: 0 } }] });

test('independent controls use local MOV coordinates and never admit unknown Chrome cards', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-card-cache-'));
  try {
    const cache = new CardFrameCache({ root, project: { fps: 30, width: 16, height: 8, style: {} }, envFingerprint: ENV_FP });
    assert.equal(cache.plan(graph('unknown'))[0].cacheable, false);
    const [control] = cache.plan(graph('independent'));
    assert.equal(control.sampling.firstFrame, 31);
    assert.equal(control.count, 5);
    const before = await cache.renderState([control], [30, 31, 32]);
    assert.deepEqual(before.missing, {}, 'direct cards render live while their independent cache fills');
    await cache.put(control.key, 0, paintedPng());
    const after = await cache.renderState([control], [31, 32]);
    assert.match(after.frames.clip[31], /\/api\/frames\/control\//);
    assert.deepEqual(after.missing, {});
    await cache.close();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('required context controls remain explicit misses and phase never covers the end frame', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-card-cache-required-'));
  try {
    const cache = new CardFrameCache({ root, project: { fps: 30, width: 16, height: 8, style: {} }, envFingerprint: ENV_FP });
    const required = graph('context');
    required.nodes[0].capabilities.needPrerendering = true;
    const [control] = cache.plan(required);
    assert.equal(control.cacheable, false);
    const state = await cache.renderState([control], [30, 31, 32, 36]);
    assert.deepEqual(state.missing, { 31: ['clip'], 32: ['clip'] });
    // end=1.2 is frame 36 exactly, which is outside the half-open interval.
    const end = await cache.renderState([control], [36]);
    assert.deepEqual(end.missing, {}, 'end boundary is never covered');
    await cache.close();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
