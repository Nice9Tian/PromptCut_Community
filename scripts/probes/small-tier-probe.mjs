/**
 * 预渲染小尺寸的渲染节点一侧(`docs/plan/c10a-contract.md` 第 9 节):真的预渲染 Chrome 里产 HTML 快照,
 * 看同一批帧一并生成 WebP 小位图、两档都推到素材服务、清单带 `small` 表、层表写进内容库、原尺寸产物一字不变。
 *
 *   node scripts/probes/small-tier-probe.mjs --origin http://127.0.0.1:5640 [--out <dir>] [--small-tier-off]
 *
 * 本进程里起一个 `FramePipeline`(和预渲染进程同一份代码),挂推送队列:素材服务、内容库都是内存替身(记下每一次写入)。
 * 项目:一张金句药丸(独立的 stateful 卡,没有成本记录时按声明进预渲染集合),框 960×540 居中,2 秒。
 *
 * 断言:
 *   S1 快照目录里每个 `<帧>.html` 旁边都有 `<帧>.small.webp`,WebP、尺寸 = 框 × 缩放比(1920×1080 → 400×225),带 alpha;
 *   S2 推到素材服务:HTML 进 `snap`,小位图进 `px`(扩展名 webp);每段清单的 `small` 表覆盖 `frames` 的每一帧,哈希对得上盘上的文件;
 *   S3 内容库里有层表 `layers:<项目 id>`,列着这张卡、键与清单的结果键一致;
 *   S4 原尺寸不受影响:`--small-tier-off`(`PROMPTCUT_SMALL_TIER=0`)再跑一遍,两边的 `<帧>.html` 与 `index.json` 逐字节相同。
 * 输出:最后一行一行 JSON。小位图拷一张到 `--out` 看。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { devOrigin, flagArg } from './probe-connect.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-small-tier-${Date.now().toString(36)}`));
await fs.mkdir(OUT, { recursive: true });
const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
const { createPushQueue } = await import('../../server/artifact-push.mjs');
const { webpSize, SMALL_SUFFIX } = await import('../../server/bakery/small-bitmap.mjs');

const PROJECT = {
  id: 'c10a-small-tier-probe', name: '小尺寸探针', width: 1920, height: 1080, fps: 30, duration: 2,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr-pill', name: 'pill', hidden: false, clips: [
    { id: 'clip-pill', kind: 'card', cardId: 'punch-pill', start: 0, end: 2, params: { text: '小尺寸' }, frame: { x: 960, y: 540, w: 960, h: 540, anchor: [0.5, 0.5] } },
  ] }],
};

function memAsset() {
  const blobs = new Map();
  return {
    blobs,
    async put(ns, bytes, { ext } = {}) { const hash = sha256(bytes); const id = `${ns}/${hash}`; const uploaded = !blobs.has(id); blobs.set(id, { bytes: Buffer.from(bytes), ext }); return { hash, uploaded }; },
    async has(ns, hash) { return blobs.has(`${ns}/${hash}`); },
    async get(ns, hash) { return blobs.get(`${ns}/${hash}`)?.bytes ?? null; },
  };
}
function memContent() {
  const items = new Map();
  return {
    items,
    async put(kind, key, body) { items.set(`${kind}|${key}`, structuredClone(body)); return { hash: 'x' }; },
    async get(kind, key) { const body = items.get(`${kind}|${key}`); return body === undefined ? null : { body: structuredClone(body), hash: 'x' }; },
    async list() { return { items: [], truncated: false }; },
  };
}

/** 跑一趟:预渲染到这张卡的快照全齐、推送队列排空 */
async function runOnce(label, smallTier) {
  const root = path.join(OUT, label);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const prev = process.env.PROMPTCUT_SMALL_TIER;
  if (!smallTier) process.env.PROMPTCUT_SMALL_TIER = '0'; else delete process.env.PROMPTCUT_SMALL_TIER;
  const pipeline = new FramePipeline({ root, origin: () => origin, interactive: false, dataRoot: root });
  const asset = memAsset();
  const content = memContent();
  const queue = createPushQueue({ pipeline, client: asset, content, dir: root, gate: false });
  queue.start();
  const t0 = Date.now();
  try {
    await pipeline.preload(PROJECT);
    const count = 60;
    let control = null, dir = null;
    const deadline = Date.now() + 300000;
    for (;;) {
      control ??= [...pipeline.entries.values()].flatMap((e) => e.cardPlan ?? []).find((c) => c.clipId === 'clip-pill' && c.snapshotKey);
      if (control) {
        dir = pipeline.snapshots().dir({ tier: 'shared', key: control.snapshotKey });
        const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: control.snapshotKey });
        const smalls = smallTier ? (await fs.readdir(dir).catch(() => [])).filter((n) => n.endsWith(SMALL_SUFFIX)).length : count;
        if (index.count >= count && smalls >= count) break;
      }
      if (Date.now() > deadline) { fails.push(`${label}:5 分钟内没产齐`); break; }
      await sleep(1000);
    }
    await pipeline.whenSmallSettled?.();
    await sleep(1500);
    await queue.drain();
    await sleep(500);
    return { root, pipeline, queue, asset, content, control, dir, ms: Date.now() - t0 };
  } finally {
    if (prev === undefined) delete process.env.PROMPTCUT_SMALL_TIER; else process.env.PROMPTCUT_SMALL_TIER = prev;
  }
}

const out = { ok: false, origin, out: OUT };
let a = null, b = null;
try {
  a = await runOnce('with-small', true);
  const { control, dir, asset, content } = a;
  out.control = control && { snapshotKey: control.snapshotKey, count: control.count, frame: control.appearance?.frame };
  out.ms = a.ms;
  const names = await fs.readdir(dir);
  const htmls = names.filter((n) => /^\d+\.html$/.test(n)).map((n) => Number(n.split('.')[0])).sort((x, y) => x - y);
  const smalls = names.filter((n) => n.endsWith(SMALL_SUFFIX));
  out.S1 = { html: htmls.length, small: smalls.length };
  check(htmls.length === 60 && smalls.length === 60, 'S1 每一帧 HTML 快照旁边都有小位图', out.S1);
  const sizes = new Set();
  let alpha = true;
  for (const n of smalls) {
    const buf = await fs.readFile(path.join(dir, n));
    const s = webpSize(buf);
    sizes.add(s ? `${s.width}x${s.height}` : 'bad');
    if (buf.toString('ascii', 12, 16) === 'VP8X' && !(buf[20] & 0x10)) alpha = false;
  }
  out.S1.sizes = [...sizes];
  check(sizes.size === 1 && sizes.has('400x225'), 'S1 小位图尺寸 = 框 960×540 × (800/1920) = 400×225', [...sizes]);
  check(alpha, 'S1 小位图带 alpha(VP8X 的 alpha 标志)');
  await fs.copyFile(path.join(dir, `30${SMALL_SUFFIX}`), path.join(OUT, 'frame30.small.webp'));
  await fs.copyFile(path.join(dir, `30${SMALL_SUFFIX}`), path.join(OUT, 'frame30.small.webp.png')).catch(() => {});

  // S2 清单与推送
  const manifests = [...content.items.entries()].filter(([k]) => k.startsWith('snapshot-manifest|') && !k.includes('|layers:')).map(([, v]) => v);
  out.S2 = { manifests: manifests.map((m) => ({ range: m.range, frames: m.frames.length, small: m.small?.length ?? 0 })) };
  check(manifests.length >= 1, 'S2 内容库里有段清单', out.S2);
  let bad = 0;
  for (const m of manifests) {
    const smallFrames = new Set((m.small ?? []).map(([f]) => f));
    for (const [f] of m.frames) if (!smallFrames.has(f)) bad++;
    for (const [f, hash] of m.small ?? []) {
      const disk = await fs.readFile(path.join(dir, `${f}${SMALL_SUFFIX}`));
      if (sha256(disk) !== hash) bad++;
      const blob = asset.blobs.get(`px/${hash}`);
      if (!blob || blob.ext !== 'webp') bad++;
    }
    for (const [, hash] of m.frames) if (!asset.blobs.has(`snap/${hash}`)) bad++;
  }
  out.S2.bad = bad;
  check(bad === 0, 'S2 small 表覆盖每一帧、哈希对得上、两档都在素材服务上(snap + px/webp)', out.S2);
  // S3 层表
  const map = content.items.get(`snapshot-manifest|layers:${PROJECT.id}`);
  out.S3 = map ? { layers: map.layers, span: map.span, fps: map.fps } : null;
  check(map?.kind === 'layer-map' && map.layers.some((l) => l.clipId === 'clip-pill' && l.key === control.snapshotKey && l.resultKey === control.snapshotKey && l.count === 60),
    'S3 内容库里有层表,列着这张卡', out.S3);
  out.pushStats = a.queue.stats();
  out.smallStats = a.pipeline.smallStats;
  // S4 关掉小尺寸再跑一遍,原尺寸逐字节相同
  b = await runOnce('without-small', false);
  const namesB = await fs.readdir(b.dir);
  check(!namesB.some((n) => n.endsWith(SMALL_SUFFIX)), 'S4 关掉小尺寸时不生成');
  let diff = 0;
  for (const f of htmls) {
    const x = await fs.readFile(path.join(dir, `${f}.html`));
    const y = await fs.readFile(path.join(b.dir, `${f}.html`)).catch(() => null);
    if (!y || !x.equals(y)) diff++;
  }
  const ia = await fs.readFile(path.join(dir, 'index.json'), 'utf8');
  const ib = await fs.readFile(path.join(b.dir, 'index.json'), 'utf8');
  out.S4 = { htmlDiff: diff, indexSame: ia === ib, keySame: a.control?.snapshotKey === b.control?.snapshotKey };
  check(diff === 0 && ia === ib && out.S4.keySame, 'S4 原尺寸 HTML 快照、index.json、键逐字节不变', out.S4);
  const mB = [...b.content.items.entries()].filter(([k]) => k.startsWith('snapshot-manifest|') && !k.includes('|layers:')).map(([, v]) => v);
  check(mB.every((m) => !('small' in m)), 'S4 关掉小尺寸时清单不带 small 项(与 C6.4 一字不差)');
} catch (e) {
  fails.push('探针异常:' + (e?.stack || e));
} finally {
  for (const r of [a, b]) { if (r) { await r.queue.stop().catch(() => {}); await r.pipeline.close().catch(() => {}); } }
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
