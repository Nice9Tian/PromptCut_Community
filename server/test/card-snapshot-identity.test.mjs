import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cardNodeIdentities, cardSnapshotIdentity, cardSampling } from '../card-identity.mjs';
import { snapshotCode, invalidateFrameCode } from '../frame-code.mjs';

/** Same card, same params in two clips: `clipId` written during `cardGraph` node synthesis differs. */
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
  // Contrast: clipId in `cardNodeIdentities` is intentional; it must still distinguish between two clips.
  const graph = clipId => ({ definitions: [], nodes: [node(clipId)], outputs: [{ nodeId: `@clip/${clipId}/source`, clipId }] });
  const left = cardNodeIdentities(graph('clip-a'));
  const right = cardNodeIdentities(graph('clip-b'));
  assert.notEqual(left.get('@clip/clip-a/source'), right.get('@clip/clip-b/source'));
});

test('shared key ignores placement inside the frame, opacity, fades, motion and emphasis', () => {
  const plain = key('clip-a');
  // x / y / anchor / scale / rotate: if box width and height remain unchanged, snapshot is the same.
  assert.equal(key('clip-a', { frame: { x: 400, y: 300, w: 800, h: 600, anchor: [0.5, 0.5], scale: 2, rotate: 35 } }), plain);
  // Opacity / fade / motion / emphasis are not arguments to this function at all: passing them in has
  // no effect; after A2(5) they do not enter snapshots and are applied by the stage at mount time.
  assert.equal(cardSnapshotIdentity(node('clip-a'), { ...base(), opacity: 0.3, fadeIn: 1, fadeOut: 1, motion: { kind: 'slide' }, emphasis: { kind: 'pop' } }), plain);
});

test('shared key is sensitive to params, parts, capabilities and source version', () => {
  const plain = key('clip-a');
  assert.notEqual(key('clip-a', {}, { params: { value: 43, label: 'a' } }), plain);
  assert.notEqual(key('clip-a', {}, { parts: [{ id: 'title' }] }), plain);
  // Review table contents (capabilities already in node).
  assert.notEqual(key('clip-a', {}, { capabilities: { frameMode: 'stateful', need_prerendering: true, compositing: 'sourceDependent' } }), plain);
  assert.notEqual(key('clip-a', { sourceVersions: { 'stat-proof': 'builtin:v2' } }), plain);
});

test('shared key is sensitive to duration, phase, fps, theme, font fingerprint and freeze code', () => {
  const plain = key('clip-a');
  assert.notEqual(key('clip-a', { duration: 4 }), plain);
  // Phase: clip starting at 10.005s samples at another moment within the clip.
  assert.notEqual(key('clip-a', { sampling: cardSampling(10.005, 30) }), plain);
  assert.notEqual(key('clip-a', { fps: 60 }), plain);
  assert.notEqual(key('clip-a', { themeId: 'light' }), plain);
  assert.notEqual(key('clip-a', { fontFingerprint: 'deadbeef' }), plain);
  assert.notEqual(key('clip-a', { snapshotCode: 'def456' }), plain);
  // Integer fps and rational pair notations must yield the same key, otherwise changing callers
  // invalidates everything.
  assert.equal(key('clip-a', { fps: { numerator: '60', denominator: '2' } }), plain);
});

test('shared key is sensitive to the resolved frame size, stage size and camera3dFov', () => {
  const plain = key('clip-a');
  // Snapshots inline used values (px): differing box width and height must be two distinct snapshots.
  assert.notEqual(key('clip-a', { frame: { x: 0, y: 0, w: 801, h: 600 } }), plain);
  assert.notEqual(key('clip-a', { frame: { x: 0, y: 0, w: 800, h: 601 } }), plain);
  assert.notEqual(key('clip-a', { stage: { width: 1280, height: 1080, camera3dFov: 50 } }), plain);
  assert.notEqual(key('clip-a', { stage: { width: 1920, height: 1080, camera3dFov: 35 } }), plain);
  // No frame = fill aspect ratio: same key as box explicitly sized to aspect ratio
  // (resolveFrameSize default).
  assert.equal(key('clip-a', { frame: undefined }), key('clip-a', { frame: { w: 1920, h: 1080 } }));
  // Width and height precomputed by caller override resolution results.
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
  // Files related to screenshotting but unrelated to generating snapshots do not enter fingerprint.
  await write('server/bakery/capture-frame.mjs', 'shot v1');
  const first = snapshotCode(root);
  await write('server/bakery/capture-frame.mjs', 'shot v2');
  invalidateFrameCode(root);
  assert.equal(snapshotCode(root), first, 'screenshot-only code must not retire snapshots');
  await write('server/bakery/chrome.mjs', 'freeze v2');
  invalidateFrameCode(root);
  assert.notEqual(snapshotCode(root), first, 'changing snapshot code must change the key');
  // J1: after snapshot generation logic moves into src/, the set is unchanged, but those two files
  // turn from 'missing' to having content; fingerprint must change once: exactly what migration calls for.
  await write('src/render/createSnapshot.ts', 'export function createSnapshot() {}');
  invalidateFrameCode(root);
  const moved = snapshotCode(root);
  assert.notEqual(moved, snapshotCode(path.join(root, 'nowhere')));
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * The server key and the box drawn by the stage must have the same width and height: snapshots inline
 * used values (px). If both sides write `frame?.w ?? parent.width` separately, changing the default
 * later will miss one side without throwing errors: key and actual box quietly mismatch, and machine B
 * pastes a snapshot frozen at different dimensions. Thus, Node-side `resolveFrameSize` is directly
 * reconciled with stage `layout.ts`'s `frameBox`.
 *
 * Note: `ClipFrame`'s w / h are in pixels with no percentage notation (percentages are at the parts
 * layer), so this covers "default = fill aspect ratio" and combinations of anchor / scale / rotate / 3D.
 */
test('resolveFrameSize agrees with layout.ts frameBox for every frame shape', async () => {
  const { frameBox } = await import('../../src/kernel/layout.ts');
  const { resolveFrameSize } = await import('../../src/kernel/frameSize.mjs');
  const stage = { width: 1920, height: 1080 };
  const cases = [
    undefined,                                             // No frame = fill the aspect ratio
    {},                                                    // Has frame but width and height are not specified
    { x: 0, y: 0 },
    { x: 10, y: 20, w: 800, h: 600 },
    { x: 10, y: 20, w: 800, h: 600, anchor: [0.5, 0.5] },  // Anchor point only moves top-left corner, leaving width and height unchanged
    { x: 10, y: 20, w: 800, h: 600, anchor: [1, 1], scale: 2, rotate: 35 },
    { w: 640 },                                            // Specify only one side, the other side takes the aspect ratio
    { h: 360 },
    { x: 0, y: 0, w: 1920, h: 1080 },                      // Explicitly set to the aspect ratio size
    { w: 801, h: 601, rotateX: 30, rotateY: -12, translateZ: 90 },
    { w: 0.5, h: 1e-3 },                                   // Subpixel box is not rounded
  ];
  for (const frame of cases) {
    const box = frameBox(frame, stage);
    const size = resolveFrameSize(frame, stage);
    assert.deepEqual({ w: size.w, h: size.h }, { w: box.width, h: box.height }, JSON.stringify(frame ?? null));
  }
  // Linked with the shared key: same box width and height means the same key, a one-pixel difference
  // switches the key (frameBox above already proved that these two frames on stage have the same
  // width and height / different widths and heights).
  assert.equal(key('clip-a', { frame: { x: 0, y: 0, w: 1920, h: 1080 } }), key('clip-b', { frame: undefined }));
  assert.notEqual(key('clip-a', { frame: { w: 640 } }), key('clip-a', { frame: { w: 640, h: 360 } }));
});
