/**
 * Render node side of small size prerendering (`docs/plan/c10a-contract.md` Section 9): produces
 * HTML snapshots in real prerender Chrome, checks that the same batch of frames generates WebP small
 * bitmaps together, both tiers are pushed to asset service, manifest includes `small` table,
 * layer table is written into content store, and original-size artifacts remain verbatim unchanged.
 *
 *   node scripts/probes/small-tier-probe.mjs --origin http://127.0.0.1:5640 [--out <dir>] [--small-tier-off]
 *
 * Spawns a `FramePipeline` in this process (same code as prerender process), hooked to a push queue:
 * asset service and content store are in-memory stand-ins (recording every write).
 * Project: one punchline pill (standalone stateful card; enters prerender set by declaration when
 * without cost records), bounding box 960×540 centered, 2 seconds.
 *
 * Assertions:
 *   S1 In snapshot directory, next to every `<frame>.html` there is `<frame>.small.webp`, WebP,
 *      size = box × scale ratio (1920×1080 → 400×225), with alpha;
 *   S2 Push to asset service: HTML goes into `snap`, small bitmap goes into `px` (extension webp);
 *      each segment manifest's `small` table covers every frame of `frames`, hashes match files on disk;
 *   S3 Content store contains layer table `layers:<project id>`, listing this card with its key
 *      matching the manifest's result key;
 *   S4 Original size unaffected: running again with `--small-tier-off` (`PROMPTCUT_SMALL_TIER=0`),
 *      `<frame>.html` and `index.json` on both sides are byte-for-byte identical.
 * Output: last line is a single line of JSON. Copy one small bitmap to `--out` to view.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
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
  id: 'c10a-small-tier-probe', name: 'Small size probe', width: 1920, height: 1080, fps: 30, duration: 2,
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

/** Run a pass: prerenders until all snapshots for this card are complete and push queue is drained */
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
      if (Date.now() > deadline) { fails.push(`${label}: not all produced within 5 minutes`); break; }
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
  check(htmls.length === 60 && smalls.length === 60, 'S1 every frame\'s HTML snapshot has a small bitmap next to it', out.S1);
  const sizes = new Set();
  let alpha = true;
  for (const n of smalls) {
    const buf = await fs.readFile(path.join(dir, n));
    const s = webpSize(buf);
    sizes.add(s ? `${s.width}x${s.height}` : 'bad');
    if (buf.toString('ascii', 12, 16) === 'VP8X' && !(buf[20] & 0x10)) alpha = false;
  }
  out.S1.sizes = [...sizes];
  check(sizes.size === 1 && sizes.has('400x225'), 'S1 small bitmap size = box 960×540 × (800/1920) = 400×225', [...sizes]);
  check(alpha, 'S1 small bitmap has alpha (VP8X alpha flag)');
  await fs.copyFile(path.join(dir, `30${SMALL_SUFFIX}`), path.join(OUT, 'frame30.small.webp'));
  await fs.copyFile(path.join(dir, `30${SMALL_SUFFIX}`), path.join(OUT, 'frame30.small.webp.png')).catch(() => {});

  // S2 Manifest and push
  const manifests = [...content.items.entries()].filter(([k]) => k.startsWith('snapshot-manifest|') && !k.includes('|layers:')).map(([, v]) => v);
  out.S2 = { manifests: manifests.map((m) => ({ range: m.range, frames: m.frames.length, small: m.small?.length ?? 0 })) };
  check(manifests.length >= 1, 'S2 the content store has a segment manifest', out.S2);
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
  check(bad === 0, 'S2 the small table covers every frame, the hashes match, and both tiers are on the asset service (snap + px/webp)', out.S2);
  // S3 Layer table
  const map = content.items.get(`snapshot-manifest|layers:${PROJECT.id}`);
  out.S3 = map ? { layers: map.layers, span: map.span, fps: map.fps } : null;
  check(map?.kind === 'layer-map' && map.layers.some((l) => l.clipId === 'clip-pill' && l.key === control.snapshotKey && l.resultKey === control.snapshotKey && l.count === 60),
    'S3 the content store has a layer table that lists this card', out.S3);
  out.pushStats = a.queue.stats();
  out.smallStats = a.pipeline.smallStats;
  // S4 Disable small size and run again; original size is byte-for-byte identical
  b = await runOnce('without-small', false);
  const namesB = await fs.readdir(b.dir);
  check(!namesB.some((n) => n.endsWith(SMALL_SUFFIX)), 'S4 nothing is generated when small size is turned off');
  let diff = 0;
  for (const f of htmls) {
    const x = await fs.readFile(path.join(dir, `${f}.html`));
    const y = await fs.readFile(path.join(b.dir, `${f}.html`)).catch(() => null);
    if (!y || !x.equals(y)) diff++;
  }
  const ia = await fs.readFile(path.join(dir, 'index.json'), 'utf8');
  const ib = await fs.readFile(path.join(b.dir, 'index.json'), 'utf8');
  out.S4 = { htmlDiff: diff, indexSame: ia === ib, keySame: a.control?.snapshotKey === b.control?.snapshotKey };
  check(diff === 0 && ia === ib && out.S4.keySame, 'S4 original-size HTML snapshots, index.json and keys are byte-for-byte unchanged', out.S4);
  const mB = [...b.content.items.entries()].filter(([k]) => k.startsWith('snapshot-manifest|') && !k.includes('|layers:')).map(([, v]) => v);
  check(mB.every((m) => !('small' in m)), 'S4 with small size turned off, the manifest has no small entry (identical to C6.4, character for character)');
} catch (e) {
  fails.push('Probe exception:' + (e?.stack || e));
} finally {
  for (const r of [a, b]) { if (r) { await r.queue.stop().catch(() => {}); await r.pipeline.close().catch(() => {}); } }
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
