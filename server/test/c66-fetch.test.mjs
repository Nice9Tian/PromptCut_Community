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
test('C66-T6-02 canPlayType 回空 → 直接判放不了、记进本机缓存，不再试放首帧；MIME 按容器（mov → video/mp4）', async () => {
  const p = play();
  dom.ctl.canPlay = '';
  const hash = H('1');
  assert.equal(await within(p.probePlayable(hash, `/@media/${hash}`, 'mov', 'video'), 3000), false);
  assert.equal(p.playableOnThisHost(hash), false, '结论记下');
  const el = dom.ctl.created[0];
  assert.ok(el, '要建一个 video 元素问 canPlayType');
  assert.match(String(el.askedMime), /^video\/mp4/, `mov 用 video/mp4 问：${el.askedMime}`);
  assert.ok(!dom.ctl.created.some((e) => e.src), '回空就不挂 src 试放');
});

test('C66-T6-03 canPlayType 不为空 → 试放：首帧到了判能放；出错判放不了；都记进本机缓存', async () => {
  const p = play();
  const ok = H('2');
  assert.equal(await within(p.probePlayable(ok, `/@media/${ok}`, 'mp4', 'video'), 5000), true, '首帧到了判能放');
  assert.equal(p.playableOnThisHost(ok), true);
  dom.ctl.behavior = 'error';
  const bad = H('3');
  assert.equal(await within(p.probePlayable(bad, `/@media/${bad}`, 'mov', 'video'), 5000), false, 'error 判放不了');
  assert.equal(p.playableOnThisHost(bad), false);
  // 记进了 localStorage（新开页面还认得）
  p.forgetPlayable();
  assert.equal(p.playableOnThisHost(ok), true, '从 localStorage 读回能放');
  assert.equal(p.playableOnThisHost(bad), false, '从 localStorage 读回放不了');
});

test('C66-T6-04 试放超时 → 记「未知、稍后重试」：不判放不了、不落结论，下次再探会重新试放', async () => {
  const p = play();
  dom.ctl.behavior = 'hang';
  const hash = H('4');
  const r = await within(p.probePlayable(hash, `/@media/${hash}`, 'mp4', 'video'), 12_000);
  assert.notEqual(r, 'pending', '超时后探测要结束（假 DOM 的真墙钟计时 20 ms 就到点）');
  assert.ok(r === undefined || r === null, `超时回「未知」（undefined 或 null），不是 ${r}`);
  assert.equal(p.playableOnThisHost(hash), undefined, '超时不落「放不了」');
  const stored = [...dom.storage._map.entries()].filter(([k]) => k.includes(hash));
  assert.ok(!stored.some(([, v]) => v === '0' || v === 'false'), `localStorage 里不能记成放不了：${JSON.stringify(stored)}`);
  const before = dom.ctl.created.length;
  dom.ctl.behavior = 'playable';
  assert.equal(await within(p.probePlayable(hash, `/@media/${hash}`, 'mp4', 'video'), 5000), true, '稍后重试：再探一次，这回能放');
  assert.ok(dom.ctl.created.length > before, '重试真的又建了元素去试放');
});

test('C66-T6-05 缓存键带浏览器主版本：存结论的键里有哈希和主版本号；不带版本的旧键不认', () => {
  const p = play();
  const hash = H('5');
  p.rememberPlayable(hash, false);
  const keys = [...dom.storage._map.keys()].filter((k) => k.toLowerCase().includes(hash));
  assert.equal(keys.length, 1, `这个哈希记了一条：${keys}`);
  assert.match(keys[0], /152/, `键里要有浏览器主版本 152：${keys[0]}`);
  // 旧格式（C6.5 及以前）：pc.playable.<hash>，不带版本 —— 浏览器升级后结论可能已经不对，不认
  const old = H('6');
  dom.storage.setItem(`pc.playable.${old}`, '0');
  p.forgetPlayable();
  assert.equal(p.playableOnThisHost(old), undefined, '不带主版本的旧键不算数');
  assert.equal(p.playableOnThisHost(hash), false, '带主版本的新键照常读回');
});

test('C66-T6-06 超时时限：本地地址 5 s，远端（绝对 http(s) 地址）10 s（第 8 节「本地 5 s、远端 10 s」）', async () => {
  const p = play();
  dom.ctl.behavior = 'hang';
  const a = H('7'), b = H('8');
  await within(p.probePlayable(a, `/@media/${a}`, 'mp4', 'video'), 12_000);
  assert.ok(dom.ctl.timers.includes(5000), `本地地址按 5000 ms 计时：${dom.ctl.timers}`);
  dom.ctl.timers.length = 0;
  await within(p.probePlayable(b, `https://assets.example/@media/${b}`, 'mp4', 'video'), 12_000);
  assert.ok(dom.ctl.timers.includes(10_000), `远端地址按 10000 ms 计时：${dom.ctl.timers}`);
});

test('C66-T6-07 本机判为放不了的素材原尺寸：两档都 complete 时预览停在素材小尺寸；换档判据不看项目文档', async () => {
  const p = play();
  const { playbackUrl } = await loadMediaTier();
  const O = H('a'), S = H('b');
  const media = { url: `/@media/${O}`, hash: O, ext: 'mov', kind: 'video', tiers: { original: O, small: S } };
  p.rememberPlayable(O, false);
  assert.equal(playbackUrl(media, [S, O], { probe: false }), `/@media/${S}`, '放不了：一直用素材小尺寸');
  assert.equal(playbackUrl({ ...media, playable: true }, [S, O], { probe: false }), `/@media/${S}`, '项目文档里写什么都不算');
  assert.equal(media.url, `/@media/${O}`, '导出用的 media.url 仍是素材原尺寸');
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

test('C66-T7-01 素材原尺寸都 complete（素材小尺寸一个没有）→ 放行；只问素材原尺寸、不问素材小尺寸', async () => {
  const env = await gateEnv(['o1', 'o2', 'o3']);
  const r = await env.check({ project: env.project, has: env.has });
  assert.equal(r.ok, true, `素材原尺寸齐了就放行：${JSON.stringify(r)}`);
  assert.ok(!env.asked.includes(env.h.s1) && !env.asked.includes(env.h.s2), `导出只用素材原尺寸，不该问素材小尺寸：${env.asked.map((x) => x.slice(0, 6))}`);
  await env.srv.close();
});

test('C66-T7-02 有素材原尺寸没到（素材小尺寸到了也不算）→ 拦下、提示「等待上传方」、列出缺的素材', async () => {
  const env = await gateEnv(['o1', 's1', 's2', 'o3']);
  const r = await env.check({ project: env.project, has: env.has });
  assert.equal(r.ok, false, '素材原尺寸没到不出片');
  assert.match(String(r.message ?? ''), /等待上传方/, `提示里有「等待上传方」：${r.message}`);
  assert.deepEqual(r.missingHashes, [env.h.o2], '缺的正是 m2 的素材原尺寸');
  assert.equal(r.missing[0].mediaId, 'm2', '缺的素材带 mediaId');
  await env.srv.close();
});

test('C66-T7-03 缺多个（含只有素材原尺寸一档的图片）→ 全部列出', async () => {
  const env = await gateEnv(['s1', 'o2', 's2']);
  const r = await env.check({ project: env.project, has: env.has });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingHashes, [env.h.o1, env.h.o3].sort(), '缺 m1 的素材原尺寸与 m3 的图片');
  assert.deepEqual(r.missing.map((m) => m.mediaId).sort(), ['m1', 'm3']);
  await env.srv.close();
});
