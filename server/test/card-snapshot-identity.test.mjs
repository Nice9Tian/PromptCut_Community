import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cardNodeIdentities, cardSnapshotIdentity, cardSampling } from '../card-identity.mjs';
import { snapshotCode, invalidateFrameCode } from '../frame-code.mjs';

/** 同一张卡、同参数,放在两个片段里:`cardGraph` 合成节点时写进去的 `clipId` 不同。 */
const node = (clipId, overrides = {}) => ({
  id: `@clip/${clipId}/source`, adapter: 'chrome', cardId: 'stat-proof', clipId,
  params: { value: 42, label: 'a' }, parts: [], inputs: {},
  capabilities: { frameMode: 'stateful', need_prerendering: true, compositing: 'independent', independentCache: true },
  ...overrides,
});

const base = () => ({
  style: { color: 'red' }, environment: { width: 1920, height: 1080, fps: 30, theme: 'dark', fontFingerprint: 'ff00ff00' },
  sourceVersions: { 'stat-proof': 'builtin:v1' }, inputKeys: {},
  fps: 30, sampling: cardSampling(10, 30), duration: 3,
  stage: { width: 1920, height: 1080, camera3dFov: 50 },
  frame: { x: 0, y: 0, w: 800, h: 600 },
  themeId: 'dark', fontFingerprint: 'ff00ff00', snapshotCode: 'abc123',
});

const key = (clipId, opts = {}, nodeOverrides = {}) => cardSnapshotIdentity(node(clipId, nodeOverrides), { ...base(), ...opts });

test('shared key ignores clip identity: the same card in two clips is one snapshot', () => {
  assert.equal(key('clip-a'), key('clip-b'));
  // 对照:`cardNodeIdentities` 的 clipId 是刻意的,它必须仍然区分两个片段。
  const graph = clipId => ({ definitions: [], nodes: [node(clipId)], outputs: [{ nodeId: `@clip/${clipId}/source`, clipId }] });
  const left = cardNodeIdentities(graph('clip-a'));
  const right = cardNodeIdentities(graph('clip-b'));
  assert.notEqual(left.get('@clip/clip-a/source'), right.get('@clip/clip-b/source'));
});

test('shared key ignores placement inside the frame, opacity, fades, motion and emphasis', () => {
  const plain = key('clip-a');
  // x / y / anchor / scale / rotate:框宽高不变,快照就是同一张。
  assert.equal(key('clip-a', { frame: { x: 400, y: 300, w: 800, h: 600, anchor: [0.5, 0.5], scale: 2, rotate: 35 } }), plain);
  // 不透明度 / 淡入淡出 / motion / 强调根本不是这个函数的入参 —— 传进来也不影响,
  // A2(5) 之后它们不进快照,由舞台在挂载时施加。
  assert.equal(cardSnapshotIdentity(node('clip-a'), { ...base(), opacity: 0.3, fadeIn: 1, fadeOut: 1, motion: { kind: 'slide' }, emphasis: { kind: 'pop' } }), plain);
});

test('shared key is sensitive to params, parts, capabilities and source version', () => {
  const plain = key('clip-a');
  assert.notEqual(key('clip-a', {}, { params: { value: 43, label: 'a' } }), plain);
  assert.notEqual(key('clip-a', {}, { parts: [{ id: 'title' }] }), plain);
  // 审阅表内容(capabilities 已经在节点里)。
  assert.notEqual(key('clip-a', {}, { capabilities: { frameMode: 'stateful', need_prerendering: true, compositing: 'sourceDependent' } }), plain);
  assert.notEqual(key('clip-a', { sourceVersions: { 'stat-proof': 'builtin:v2' } }), plain);
});

test('shared key is sensitive to duration, phase, fps, theme, font fingerprint and freeze code', () => {
  const plain = key('clip-a');
  assert.notEqual(key('clip-a', { duration: 4 }), plain);
  // 相位:10.005s 起的片段采样落在片段内的另一个瞬间。
  assert.notEqual(key('clip-a', { sampling: cardSampling(10.005, 30) }), plain);
  assert.notEqual(key('clip-a', { fps: 60 }), plain);
  assert.notEqual(key('clip-a', { themeId: 'light' }), plain);
  assert.notEqual(key('clip-a', { fontFingerprint: 'deadbeef' }), plain);
  assert.notEqual(key('clip-a', { snapshotCode: 'def456' }), plain);
  // 整数 fps 和有理数对写法必须同键,否则换个调用方就全体失效。
  assert.equal(key('clip-a', { fps: { numerator: '60', denominator: '2' } }), plain);
});

test('shared key is sensitive to the resolved frame size, stage size and camera3dFov', () => {
  const plain = key('clip-a');
  // 快照内联的是使用值(px):框宽高不同必须是两张快照。
  assert.notEqual(key('clip-a', { frame: { x: 0, y: 0, w: 801, h: 600 } }), plain);
  assert.notEqual(key('clip-a', { frame: { x: 0, y: 0, w: 800, h: 601 } }), plain);
  assert.notEqual(key('clip-a', { stage: { width: 1280, height: 1080, camera3dFov: 50 } }), plain);
  assert.notEqual(key('clip-a', { stage: { width: 1920, height: 1080, camera3dFov: 35 } }), plain);
  // 没有 frame = 铺满画幅:和显式写成画幅大小的框同键(resolveFrameSize 的默认值)。
  assert.equal(key('clip-a', { frame: undefined }), key('clip-a', { frame: { w: 1920, h: 1080 } }));
  // 调用方自己算好的宽高覆盖解析结果。
  assert.equal(key('clip-a', { frame: undefined, frameWidth: 800, frameHeight: 600 }), plain);
});

test('upstream input keys enter the shared key explicitly, never via cardNodeIdentities', () => {
  const plain = key('clip-a');
  const chained = key('clip-a', { inputKeys: { source: { key: 'upstream-1', offset: 0, rate: 1 } } });
  assert.notEqual(chained, plain);
  assert.notEqual(chained, key('clip-a', { inputKeys: { source: { key: 'upstream-2', offset: 0, rate: 1 } } }));
});

test('snapshotCode covers only the snapshot files and reports missing ones deterministically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-freeze-'));
  const write = async (file, text) => {
    await fs.mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  await write('server/bakery/chrome.mjs', 'freeze v1');
  await write('server/bakery/capture-snapshot.mjs', 'restore v1');
  // 截图相关但和生成快照无关的文件不进指纹。
  await write('server/bakery/capture-frame.mjs', 'shot v1');
  const first = snapshotCode(root);
  await write('server/bakery/capture-frame.mjs', 'shot v2');
  invalidateFrameCode(root);
  assert.equal(snapshotCode(root), first, 'screenshot-only code must not retire snapshots');
  await write('server/bakery/chrome.mjs', 'freeze v2');
  invalidateFrameCode(root);
  assert.notEqual(snapshotCode(root), first, 'changing snapshot code must change the key');
  // J1:生成快照的逻辑搬进 src/ 之后集合不变,但那两个文件从 'missing' 变成有内容,
  // 指纹必然变一次 —— 这正是搬家那一刻该发生的事。
  await write('src/render/createSnapshot.ts', 'export function createSnapshot() {}');
  invalidateFrameCode(root);
  const moved = snapshotCode(root);
  assert.notEqual(moved, snapshotCode(path.join(root, 'nowhere')));
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * 服务端的键和舞台画出来的框必须是同一个宽高 —— 快照内联的是使用值(px)。
 * 两边各写一遍 `frame?.w ?? parent.width` 的话,将来改默认值会漏一处,而漏掉不
 * 报错:键和实际的框悄悄对不上,B 机贴到一张按别的宽高冻出来的快照。
 * 所以直接把 Node 端的 `resolveFrameSize` 和舞台 `layout.ts` 的 `frameBox` 对账。
 *
 * 注:`ClipFrame` 的 w / h 是像素数,没有百分比写法(百分比在 parts 那一层),
 * 所以这里覆盖的是「缺省 = 铺满画幅」和各种锚点 / 缩放 / 旋转 / 三维的组合。
 */
test('resolveFrameSize agrees with layout.ts frameBox for every frame shape', async () => {
  const { frameBox } = await import('../../src/kernel/layout.ts');
  const { resolveFrameSize } = await import('../../src/kernel/frameSize.mjs');
  const stage = { width: 1920, height: 1080 };
  const cases = [
    undefined,                                             // 没有 frame = 铺满画幅
    {},                                                    // 有 frame 但没写宽高
    { x: 0, y: 0 },
    { x: 10, y: 20, w: 800, h: 600 },
    { x: 10, y: 20, w: 800, h: 600, anchor: [0.5, 0.5] },  // 锚点只挪左上角,不动宽高
    { x: 10, y: 20, w: 800, h: 600, anchor: [1, 1], scale: 2, rotate: 35 },
    { w: 640 },                                            // 只写一边,另一边取画幅
    { h: 360 },
    { x: 0, y: 0, w: 1920, h: 1080 },                      // 显式写成画幅大小
    { w: 801, h: 601, rotateX: 30, rotateY: -12, translateZ: 90 },
    { w: 0.5, h: 1e-3 },                                   // 亚像素框不被取整
  ];
  for (const frame of cases) {
    const box = frameBox(frame, stage);
    const size = resolveFrameSize(frame, stage);
    assert.deepEqual({ w: size.w, h: size.h }, { w: box.width, h: box.height }, JSON.stringify(frame ?? null));
  }
  // 和共享键联动:框宽高一样就同键,差一像素就换键(上面 frameBox 已证明这两个
  // frame 在舞台上就是同一个宽高 / 不同宽高)。
  assert.equal(key('clip-a', { frame: { x: 0, y: 0, w: 1920, h: 1080 } }), key('clip-b', { frame: undefined }));
  assert.notEqual(key('clip-a', { frame: { w: 640 } }), key('clip-a', { frame: { w: 640, h: 360 } }));
});
