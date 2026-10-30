/**
 * 仅供测试，生产代码不得引用。
 *
 * C6.4 三个产物测试（`artifact-dedup` / `artifact-push` / `artifact-adopt`）共用的夹具，写法沿用 C6.2 的
 * `artifact-transfer.test.mjs`：
 *
 *   - 环境与指纹：`OWN_ENV`（两个 FramePipeline 自己的环境）、`TASK_FP`（任务的锁指纹，故意与之不同）；
 *   - 任务（TaskView，B.4 / E.5 / E.9 / F.1 的形状）：`snapshotTask`、`streamTask`；`dirKeyOf`、`manifestKey`、`refOf`；
 *   - 快照：`htmlOf`、`bigHtml`、`dataImageHtml`、`seedSnapshots`；流：`writeStreamFixture`（按 `frame-stream.mjs` 的格式手工造）；
 *   - 帧库：`makeRoots(FramePipeline)` 建临时帧库与管线，`cleanup()` 关管线、删目录；
 *   - 服务：`startServices(harness)` 起素材服务（memory，端口 0）与文档服务（内容库，memory，端口 0），
 *     回 `{ srv, client, docs, content, cleanup }`；
 *   - 其它：`unpack`（`collect*` 的回值）、`wire`（JSON 往返）、`filesOf`、`watchEntry`、`staged`、`range`。
 *
 * 引了 `frame-stream.mjs`（为 `segmentSignature`），所以要在测试文件 `mock.module` 了 `bakery/index.mjs` 之后再动态 import 本文件。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { segmentSignature } from '../frame-stream.mjs';
import { describeEnvironment, resultKeyOf } from '../render-node/fingerprint.mjs';
import { startContentService, connectContent } from './fake-manifest-env.mjs';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const sha16 = (buf) => sha256(buf).slice(0, 16);
export const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
export const wire = (v) => JSON.parse(JSON.stringify(v));

export const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
export const TASK_FP = describeEnvironment({
  platform: 'Win32', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)',
  chromeVersion: 'HeadlessChrome/138.0.7204.49',
}).fingerprint;
assert.notEqual(TASK_FP, OWN_ENV.fingerprint);

export const SHARED_CAPS = { compositing: 'independent', frameMode: 'stateful' };
export const LOCAL_CAPS = { compositing: 'belowDependent', frameMode: 'stateful' };
export const CANVAS_CAPS = { compositing: 'independent', frameMode: 'stateful', canvasHeavy: true };

export function snapshotTask({ tier = 'shared', contentKey, entryKey = null, from, to, clipId = 'clip-x', fp = TASK_FP }) {
  const inputKey = tier === 'local' ? `${entryKey}/${contentKey}` : contentKey;
  const resultKey = resultKeyOf(inputKey, fp);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier, resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1' },
    input: { clipId, cardId: null, entryKey: tier === 'local' ? entryKey : null, contentKey: inputKey },
    weight: { class: 'heavy', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: fp, codeVersion: 'c', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: tier === 'local' },
    priority: 10, state: 'claimed', version: 1, attempts: 1,
  };
}
/** 共享档的落盘键 = 结果键；本地档 = resultKeyOf(去掉 entryKey 前缀的内容键, 任务的锁指纹)（E.9） */
export const dirKeyOf = (task) => (task.tier === 'local'
  ? resultKeyOf(task.input.contentKey.slice(task.input.entryKey.length + 1), task.requires.envFingerprint)
  : task.resultKey);

export function streamTask({ streamKey, contentKey, from, to, clipId = 'clip-s', fp = TASK_FP }) {
  return {
    id: `stream:${streamKey}:${from}-${to}`, kind: 'stream', resultKey: streamKey,
    range: { unit: 'segment', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1' },
    input: { clipId, cardId: null, entryKey: null, contentKey },
    weight: { class: 'heavy', estMs: null, frames: (to - from + 1) * 15 },
    requires: { envFingerprint: fp, codeVersion: 'c', cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false },
    priority: 10, state: 'claimed', version: 1, attempts: 1,
  };
}

/** 内容库清单的键：`<resultKey>:<from>-<to>`（契约第 1 节） */
export const manifestKey = (task) => `${task.resultKey}:${task.range.from}-${task.range.to}`;
/** 清单的 kind：快照 → snapshot-manifest，流 → render-manifest */
export const manifestKind = (task) => (task.kind === 'stream' ? 'render-manifest' : 'snapshot-manifest');
/** sink 的 ref（C6.2 第 11 节第 3 条：带上任务的 input 与 requires） */
export const refOf = (t) => ({ resultKey: t.resultKey, kind: t.kind, tier: t.kind === 'stream' ? null : t.tier, range: t.range, input: t.input, requires: t.requires });
export const metaOf = (t) => ({ taskId: t.id, nodeId: 'node-1', token: 1 });

export const htmlOf = (n, tag = 'A') => `<div data-pc-scene="" data-f="${n}">${tag} frame ${n} ${'·'.repeat(n % 7)}</div>`;
export const bigHtml = (n = 0) => `<div data-pc-scene="" data-f="${n}">${'x'.repeat(310 * 1024)}</div>`;
/**
 * `data:image` 占比约为 `share` 的一帧 HTML（按 `scripts/archive/probes/snapshot-size-probe.mjs` 的 `dataImageBytes` 口径（该探针 2026-10-23 归档，算法在这里是复制的，不受影响）：
 * 匹配 `data:image/<type>;base64,<base64>` 的字符数，除以整帧 UTF-8 字节数）。
 */
export function dataImageHtml(n, share, total = 8000) {
  const img = Math.round(total * share);
  const uri = `data:image/png;base64,${'A'.repeat(Math.max(1, img - 'data:image/png;base64,'.length - 1))}${String.fromCharCode(66 + (n % 20))}`;
  const head = `<div data-pc-scene="" data-f="${n}"><img src="`;
  const tail = `">`;
  const pad = Math.max(0, total - head.length - uri.length - tail.length - 6);
  return `${head}${uri}${tail}${'p'.repeat(pad)}</div>`;
}
/** 与 `scripts/archive/probes/snapshot-size-probe.mjs`（2026-10-23 归档） 的 `dataImageBytes` 相同的算法（复制，不引用探针） */
const DATA_IMG = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
export const dataImageBytes = (s) => { let n = 0; for (const m of (s || '').match(DATA_IMG) || []) n += m.length; return n; };

/** 往 pipeline 的帧库写 `frames` 这些帧（走 `commitSnapshots`，这是写快照的唯一入口） */
export async function seedSnapshots(pipeline, task, frames, { html = htmlOf, tag = 'A', capabilities, clipId } = {}) {
  const caps = capabilities ?? (task.tier === 'local' ? LOCAL_CAPS : SHARED_CAPS);
  const items = frames.map((n) => ({ localFrame: n, html: html(n, tag) }));
  return pipeline.snapshots().commitSnapshots({
    tier: task.tier, entryKey: task.input.entryKey ?? undefined, key: dirKeyOf(task), clipId: clipId ?? task.input.clipId, capabilities: caps, items,
  });
}

/** `collect*` 的回值（C6.2 第 11 节第 1 条：`{ result, readBlob }`） */
export function unpack(out) {
  assert.ok(out && typeof out === 'object', 'collect* 要回一个对象');
  const direct = out.v !== undefined || out.kind !== undefined;
  const result = direct ? out : out.result;
  const readBlob = direct ? out.readBlob : (out.readBlob ?? out.result?.readBlob);
  assert.ok(result && typeof result === 'object', '拿不到清单（result）');
  assert.equal(typeof readBlob, 'function', 'collect* 要同时给出 readBlob(hash)');
  return { result: wire(result), readBlob, raw: result };
}

export async function filesOf(dir) {
  let names = [];
  try { names = await fs.readdir(dir); } catch { return {}; }
  const out = {};
  for (const name of names.sort()) {
    const st = await fs.stat(path.join(dir, name));
    if (st.isFile()) out[name] = await fs.readFile(path.join(dir, name));
  }
  return out;
}

/** 递归列出一棵目录里的全部文件：{ 相对路径: Buffer } */
export async function treeOf(dir) {
  const out = {};
  const walk = async (d, rel) => {
    let items = [];
    try { items = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) await walk(p, r);
      else out[r] = await fs.readFile(p);
    }
  };
  await walk(dir, '');
  return out;
}

export const A_ENCODER = 'h264_nvenc';
export const B_ENCODER = 'libx264';

/** 在 root 下按 `frame-stream.mjs` 的格式手工造一条流（字节是造的，不是真 fMP4）。回 { manifest, files, dir } */
export async function writeStreamFixture(root, { streamKey, segments, encoder = A_ENCODER, seed = 1, originFrame = 0, lastFrame }) {
  const dir = path.join(root, 'streams', streamKey);
  await fs.mkdir(dir, { recursive: true });
  const bound = { x: 0, y: 0, w: 64, h: 64 };
  const tight = { x: 8, y: 8, w: 48, h: 48 };
  const init1 = Buffer.concat([Buffer.from('....ftypiso6'), crypto.createHash('sha512').update(`init1-${seed}`).digest()]);
  const id1 = sha16(init1);
  const files = { [`init-${id1}.mp4`]: init1 };
  const manifest = {
    // `originFrame`:这条流自己的第一帧(分段从它起数);清单不带它的结果别处不收(`streamAdoption`)
    // `lastFrame`(给了才写):这条流自己的最后一帧,推送时清单 header 带上它(写内容库时按它截 8 段一桶的终点)
    version: 1, streamKey, kind: 'card', plane: 'local', clipIds: ['clip-s'], fps: 30, originFrame, ...(Number.isInteger(lastFrame) ? { lastFrame } : {}), bound, offset: { x: 32, y: 32 }, tight,
    inits: { [id1]: { codec: 'avc1.64001f', width: 48, height: 96, timescale: 15360, rect: tight, encoder, bytes: init1.length } },
    segments: {},
  };
  for (const n of segments) {
    const bytes = Buffer.concat([Buffer.from('....moof'), crypto.createHash('sha512').update(`seg-${seed}-${n}`).digest(), Buffer.alloc(200 + n, n)]);
    const file = `${n}-${sha16(bytes)}.m4s`;
    files[file] = bytes;
    manifest.segments[n] = {
      file, init: id1, stride: 1, samples: 15, bytes: bytes.length, encodeMs: 20, tailMs: 5,
      sig: segmentSignature({ streamKey, segment: n, stride: 1, encoder, rect: tight }), dropped: [], at: 1,
    };
  }
  for (const [name, buf] of Object.entries(files)) await fs.writeFile(path.join(dir, name), buf);
  await fs.writeFile(path.join(dir, 'stream.json'), JSON.stringify(manifest));
  return { manifest, files, dir };
}

/**
 * 建临时帧库与管线。`make(root, { interactive })` 建一个 FramePipeline（注入环境、不探测），`root()` 建一个临时目录。
 * `cleanup()` 关掉全部管线、删掉全部目录。
 */
export function makeRoots(FramePipeline, prefix = 'pc-c64-lib-') {
  const roots = [];
  const pipelines = [];
  return {
    async root() { const r = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(r); return r; },
    make(root, { interactive = false } = {}) {
      const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive });
      pipelines.push(p);
      return p;
    },
    async cleanup() {
      await Promise.allSettled(pipelines.map((p) => p.close()));
      await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
    },
  };
}

/** 流生产者：接上读口、定下编码器名（不探测、不开 worker） */
export function producerOf(pipeline, encoder = B_ENCODER) {
  const p = pipeline.streamProducer();
  assert.ok(p, '拿不到流生产者（streamProducer()，只在 interactive: true 的管线上有）');
  p.attachRoute();
  p.encoderName = encoder;
  return p;
}

/** 在 pipeline 上挂一个 entry 和一个页面会话：用来看发布之后会话收没收到 layer */
export function watchEntry(pipeline, entry) {
  pipeline.entries.set(entry.key, entry);
  const seen = [];
  pipeline.ready.subscribe('page', (m) => seen.push(m));
  pipeline.ready.adopt('page', entry.key, 1);
  return { entry, seen, layers: () => seen.filter((m) => m.type === 'layer') };
}
export const staged = (pipeline, kind, key) => pipeline.ready.stagedKeys().find((s) => s.kind === kind && s.key === key) ?? null;

/**
 * 素材服务（memory，端口 0）+ 文档服务（内容库，memory，端口 0）。
 * `newClient(base)` 由调用方给（载不进 client.mjs 时各条用例各自失败）。
 */
export async function startServices(harness, newClient) {
  const srv = await harness.serve();
  let docs = null;
  let client, content;
  try {
    client = newClient(srv.base);
    docs = await startContentService();
    ({ content } = await connectContent(docs));
  } catch (err) {
    // 载不进被测模块时也要把起了的服务关掉，否则进程不退出
    await docs?.cleanup();
    await srv.close();
    throw err;
  }
  return {
    srv, client, docs, content,
    /** 再连一条内容库客户端（另一台机器） */
    async another(user = 'node-b') { return (await connectContent(docs, { user })).content; },
    async cleanup() { await docs.cleanup(); await srv.close(); },
  };
}
