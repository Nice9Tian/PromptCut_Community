/**
 * C6.6 可播性与导出拦截（`docs/plan/c66-design.md` 第 4 节「可播性」「导出」、第 8 节「可播性」；验收 T6、T7 的单进程部分）。
 * 跑：node --test server/test/c66-fetch.test.mjs
 *
 * 只照设计稿写，没看实现。可播性模块是 `src/render/playability.ts`（设计稿点了名），跑在测试装的假 DOM 上；
 * 浏览器主版本、超时计时、本地 / 远端的区分是假设 K4。导出拦截的模块名与形状是假设 K3。
 * 换档（T5）、主线程长任务（T4）、跨机（T9）要浏览器或两台机器，不在本文件。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAssetHarness } from './fake-asset-service.mjs';
import { createAssetClient } from '../asset-store/client.mjs';
import {
  installFakeDom, loadPlayability, loadMediaTier, loadExportGate, sha256, bytesOf,
} from './c66-kit.mjs';

const UA_152 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const H = (c) => c.repeat(64);

let dom = null;
let P = null, loadError = null;
before(async () => {
  dom = installFakeDom({ ua: UA_152 });
  try { P = await loadPlayability(); } catch (err) { loadError = err; }
});
after(() => dom?.restore());

function play() {
  if (loadError) throw loadError;
  P.forgetPlayable();
  dom.storage.clear();
  dom.ctl.created.length = 0;
  dom.ctl.timers.length = 0;
  dom.ctl.canPlay = 'maybe';
  dom.ctl.behavior = 'playable';
  dom.ctl.fireTimers = true;
  return P;
}

/** 在 ms 内等 promise；到点回 'pending' */
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), ms))]);

// ------------------------------------------------------------------ T6 可播性

// 集成改动：MOV 的 canPlayType 按 video/mp4 问（设计稿第 9 节认可 c66-fetch 报告第 3 节第 1 条：Chrome 152 对
// video/quicktime 恒回空串，按字面问会把 H.264 的 MOV 全判成放不了）；原断言是 /^video\/quicktime/。
test('C66-T6-02 canPlayType returns empty → judged unplayable directly, recorded in the local cache, no further attempt to play the first frame; MIME by container (mov → video/mp4)', async () => {
  const p = play();
  dom.ctl.canPlay = '';
  const hash = H('1');
  assert.equal(await within(p.probePlayable(hash, `/@media/${hash}`, 'mov', 'video'), 3000), false);
  assert.equal(p.playableOnThisHost(hash), false, 'the verdict is recorded');
  const el = dom.ctl.created[0];
  assert.ok(el, 'must create a video element to ask canPlayType');
  assert.match(String(el.askedMime), /^video\/mp4/, `mov is asked with video/mp4: ${el.askedMime}`);
  assert.ok(!dom.ctl.created.some((e) => e.src), 'when empty, do not attach src to try playing');
});

test('C66-T6-03 canPlayType not empty → try playing: first frame arrived, judged playable; error, judged unplayable; both recorded in the local cache', async () => {
  const p = play();
  const ok = H('2');
  assert.equal(await within(p.probePlayable(ok, `/@media/${ok}`, 'mp4', 'video'), 5000), true, 'first frame arrived, judged playable');
  assert.equal(p.playableOnThisHost(ok), true);
  dom.ctl.behavior = 'error';
  const bad = H('3');
  assert.equal(await within(p.probePlayable(bad, `/@media/${bad}`, 'mov', 'video'), 5000), false, 'error, judged unplayable');
  assert.equal(p.playableOnThisHost(bad), false);
  // 记进了 localStorage（新开页面还认得）
  p.forgetPlayable();
  assert.equal(p.playableOnThisHost(ok), true, 'read back from localStorage: playable');
  assert.equal(p.playableOnThisHost(bad), false, 'read back from localStorage: unplayable');
});

test('C66-T6-04 trial playback timeout → record "unknown, retry later": not judged unplayable, no verdict stored, and the next probe tries playback again', async () => {
  const p = play();
  dom.ctl.behavior = 'hang';
  const hash = H('4');
  const r = await within(p.probePlayable(hash, `/@media/${hash}`, 'mp4', 'video'), 12_000);
  assert.notEqual(r, 'pending', 'probing must finish after the timeout (the fake DOM\'s real wall-clock timer fires at 20 ms)');
  assert.ok(r === undefined || r === null, `timeout returns "unknown" (undefined or null), not ${r}`);
  assert.equal(p.playableOnThisHost(hash), undefined, 'a timeout does not record "unplayable"');
  const stored = [...dom.storage._map.entries()].filter(([k]) => k.includes(hash));
  assert.ok(!stored.some(([, v]) => v === '0' || v === 'false'), `must not be recorded as unplayable in localStorage: ${JSON.stringify(stored)}`);
  const before = dom.ctl.created.length;
  dom.ctl.behavior = 'playable';
  assert.equal(await within(p.probePlayable(hash, `/@media/${hash}`, 'mp4', 'video'), 5000), true, 'retry later: probe once more, and this time it plays');
  assert.ok(dom.ctl.created.length > before, 'the retry really did create an element again to try playing');
});

test('C66-T6-05 cache key includes the browser major version: the key that stores the verdict contains the hash and the major version number; old keys without a version are not recognized', () => {
  const p = play();
  const hash = H('5');
  p.rememberPlayable(hash, false);
  const keys = [...dom.storage._map.keys()].filter((k) => k.toLowerCase().includes(hash));
  assert.equal(keys.length, 1, `one entry recorded for this hash: ${keys}`);
  assert.match(keys[0], /152/, `the key must contain browser major version 152: ${keys[0]}`);
  // 旧格式（C6.5 及以前）：pc.playable.<hash>，不带版本 —— 浏览器升级后结论可能已经不对，不认
  const old = H('6');
  dom.storage.setItem(`pc.playable.${old}`, '0');
  p.forgetPlayable();
  assert.equal(p.playableOnThisHost(old), undefined, 'old keys without a major version do not count');
  assert.equal(p.playableOnThisHost(hash), false, 'new keys with a major version are read back as usual');
});

test('C66-T6-06 timeout limits: local address 5 s, remote (absolute http(s) address) 10 s (section 8, "local 5 s, remote 10 s")', async () => {
  const p = play();
  dom.ctl.behavior = 'hang';
  const a = H('7'), b = H('8');
  await within(p.probePlayable(a, `/@media/${a}`, 'mp4', 'video'), 12_000);
  assert.ok(dom.ctl.timers.includes(5000), `local address is timed at 5000 ms: ${dom.ctl.timers}`);
  dom.ctl.timers.length = 0;
  await within(p.probePlayable(b, `https://assets.example/@media/${b}`, 'mp4', 'video'), 12_000);
  assert.ok(dom.ctl.timers.includes(10_000), `remote address is timed at 10000 ms: ${dom.ctl.timers}`);
});

test('C66-T6-07 original-size asset judged unplayable on this machine: when both tiers are complete, the preview stays on the small-size asset; the tier-switch criterion does not look at the project document', async () => {
  const p = play();
  const { playbackUrl } = await loadMediaTier();
  const O = H('a'), S = H('b');
  const media = { url: `/@media/${O}`, hash: O, ext: 'mov', kind: 'video', tiers: { original: O, small: S } };
  p.rememberPlayable(O, false);
  assert.equal(playbackUrl(media, [S, O], { probe: false }), `/@media/${S}`, 'unplayable: always use the small-size asset');
  assert.equal(playbackUrl({ ...media, playable: true }, [S, O], { probe: false }), `/@media/${S}`, 'whatever the project document says does not count');
  assert.equal(media.url, `/@media/${O}`, 'media.url used for export is still the original-size asset');
});

// ------------------------------------------------------------------ T7 导出拦截

const harness = createAssetHarness();
after(() => harness.cleanup());

/** 三个素材：两个视频（两档）、一张图片（只有素材原尺寸），都被片段引用 */
function projectOf(h) {
  return {
    id: 'p-c66',
    name: 'c66',
    fps: 30,
    media: [
      { id: 'm1', kind: 'video', name: 'one.mp4', url: `/@media/${h.o1}`, hash: h.o1, ext: 'mp4', tiers: { small: h.s1, original: h.o1 } },
      { id: 'm2', kind: 'video', name: 'two.mov', url: `/@media/${h.o2}`, hash: h.o2, ext: 'mov', tiers: { small: h.s2, original: h.o2 } },
      { id: 'm3', kind: 'image', name: 'three.png', url: `/@media/${h.o3}`, hash: h.o3, ext: 'png', tiers: { original: h.o3 } },
    ],
    tracks: [{ id: 'v', kind: 'video', clips: [
      { id: 'c1', mediaId: 'm1', start: 0, end: 2 },
      { id: 'c2', mediaId: 'm2', start: 2, end: 4 },
      { id: 'c3', mediaId: 'm3', start: 4, end: 5 },
    ] }],
  };
}

async function gateEnv(present) {
  const check = await loadExportGate();
  const srv = await harness.serve({ chunkSize: 64 * 1024, isTrusted: () => true });
  const client = createAssetClient({ base: srv.base, chunkSize: 64 * 1024 });
  const bytes = {};
  const h = {};
  let seed = 100;
  for (const k of ['o1', 's1', 'o2', 's2', 'o3']) { bytes[k] = bytesOf(3000 + seed, seed++); h[k] = sha256(bytes[k]); }
  for (const k of present) await client.put('media', bytes[k], { ext: 'mp4' });
  const asked = [];
  const has = async (hash) => { asked.push(String(hash).toLowerCase()); return client.has('media', hash); };
  return { check, srv, h, has, asked, project: projectOf(h) };
}

test('C66-T7-01 all original-size assets complete (no small-size assets at all) → let through; asks only for original-size assets, not small-size assets', async () => {
  const env = await gateEnv(['o1', 'o2', 'o3']);
  const r = await env.check({ project: env.project, has: env.has });
  assert.equal(r.ok, true, `let through once the original-size assets are all there: ${JSON.stringify(r)}`);
  assert.ok(!env.asked.includes(env.h.s1) && !env.asked.includes(env.h.s2), `export uses only original-size assets and should not ask for small-size assets: ${env.asked.map((x) => x.slice(0, 6))}`);
  await env.srv.close();
});

test('C66-T7-02 an original-size asset has not arrived (arrived small-size assets do not count) → blocked, shows "waiting for the uploader", lists the missing assets', async () => {
  const env = await gateEnv(['o1', 's1', 's2', 'o3']);
  const r = await env.check({ project: env.project, has: env.has });
  assert.equal(r.ok, false, 'no final video is produced while an original-size asset has not arrived');
  assert.match(String(r.message ?? ''), /Waiting for uploader/, `the notice contains "waiting for the uploader": ${r.message}`);
  assert.deepEqual(r.missingHashes, [env.h.o2], 'the missing one is exactly m2\'s original-size asset');
  assert.equal(r.missing[0].mediaId, 'm2', 'the missing asset carries a mediaId');
  await env.srv.close();
});

test('C66-T7-03 several missing (including images, which have only the original-size tier) → all are listed', async () => {
  const env = await gateEnv(['s1', 'o2', 's2']);
  const r = await env.check({ project: env.project, has: env.has });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingHashes, [env.h.o1, env.h.o3].sort(), 'missing m1\'s original-size asset and m3\'s image');
  assert.deepEqual(r.missing.map((m) => m.mediaId).sort(), ['m1', 'm3']);
  await env.srv.close();
});
