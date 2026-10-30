/**
 * K1 的「离线那一半」:在后台舞台(角色 `back`、工作项 `probe`)逐张实测卡片代价,
 * 结果按 `(identityKey, device)` 写进 `out/card-costs.json`(`GET/PUT /api/data/costs`)。
 *
 *   node scripts/probe-card-costs.mjs [--origin http://127.0.0.1:5197]
 *                                     [--cards odometer,punch-pill | --project path/to/x.proc]
 *                                     [--fps 30] [--clip-sec 4] [--worst-frames 40]
 *                                     [--force] [--dry-run] [--limit N] [--gl-route perDocument]
 *                                     [--mode dev|build] [--json out/xxx.json]
 *
 * 第 4 步的常驻探针(`ProbeGate` + `back`)做的是同一件事,只是由编辑器在加载遮罩里驱动;
 * 这个脚本是它的离线版,用来在第 4 步准入前把成绩先跑出来、把端点和键跑通。
 *
 * # 和任务书 K1 的对应
 *
 * - **一次只测一个片段**:每张卡先 `setProject(缩水项目, { reset: true })`(一条轨道一个 clip),
 *   再测 —— `render` 没有 clipId,不缩水的话 `StageView.tsx:183` 会把此刻全部活跃卡一起推。
 * - `identityKey = cardCostKey(node, sourceVersion, fps, durationFrames)`,`node` 取
 *   `projectCardGraph(缩水项目, getCard).nodes` 里那个片段的节点,`sourceVersion` 照
 *   `ExportView.tsx:108-118` 的算法(user 卡带 dependencies、内置卡带 builtinCardSourceFiles)。
 * - `direct` 卡:固定随机抽本地帧,各发一次 `setTime(t, { probe: true })`,`catchUpMs = 0`、
 *   `kind: 'random'`。**抽满 `STEP_MIN_SAMPLES` 帧** —— 任务书 K1「8 次抽样不够
 *   `STEP_MIN_SAMPLES` 就补抽」,不补的话 8 个样本走不到百分位、`robustStep` 只好退回取最大。
 * - `stateful` 卡**分两趟**(任务书 K1,用户 2026-09-22 确认):见下一节。
 * - `capped = stepMs × COST_SCALE > B`。
 * - `vtOk` / `seekOk` / `seekMs` **离线不测**(留空):它们要在舞台里按 K3 的重挂载配方复位、
 *   用 `pinner.syncIn` 钉子树虚拟时间,那是第 4 步常驻探针的事,父页这一侧够不到 `pinner`。
 *
 * # 两趟(任务书 K1)
 *
 * **计时趟** `render(最后一帧, { jump: true, probe: 'time', maxCatchUp: Infinity })`:
 * 只推进,不生成快照、不 post `probe-frame`。**不按一拍预算截断** —— 旧做法(这一次 `render`
 * 的累计墙钟超过 B 就停,而那个预算里还含生成快照)让 61 张推帧卡全部只推了 1～10 帧,
 * `catchUpMs` 靠含挂载成本的前几帧外推、偏大 1.7～3.6 倍,5 张每帧 1 ms 的便宜卡因此被追帧
 * 上界错判成重。现在只为长片段留 `PROBE_MAX_FRAMES = 300` 帧 / `PROBE_MAX_MS = 500` ms 的封顶。
 * 回包带**每一帧**的活渲耗时 `steps`,统计由这个脚本做:
 *   - `stepMs`    = `robustStep(steps)`(第 `STEP_PERCENTILE` 百分位,样本不足时取最大);
 *   - `stepMaxMs` = 单次最大,**只作诊断**,不进判重和分派;
 *   - `catchUpMs` = 各帧之和;封顶没推完的,剩下的帧按**除首帧外的中位数**补上 —— 不用平均值,
 *     首帧要建树、解析关键帧,拿它进平均会系统性偏大(这就是上面那 1.7～3.6 倍的来源)。
 *
 * **快照趟**:先按 K3 的「重挂载定位配方」复位(`render(0, { jump: true })`),再逐帧
 * `render(k / fps, { probe: 'snapshot' })`,每帧生成一次快照;`inlineMs` / `rasterMs` /
 * `serializeMs` 同样取稳健值。逐帧单独发是因为整趟 `render` 的回包只报**累计**、拿不到逐帧数
 * (`probe-frame` 事件到父页的时间也不行:`advanceToAsync` 的 `yieldEvery: 8` 让 8 条
 * postMessage 在同一个让出点成批送达,时间戳几乎相同)。帧数由 `--worst-frames` 给(缺省 40),
 * 够不到片段尾部的长卡在表里标 `snapN`;没推到的帧交给后台预渲染,快照趟的截断不影响任何判定。
 *
 * # 五个数(任务书 3.8 + K1)
 *
 * 旧的 `frameMs`(含生成快照的单帧最差)**已删,不留兼容**。现在分开量、分开报:
 *   - `stepMs`      活渲单帧的**稳健值**,唯一进判重的数;
 *   - `stepMaxMs`   活渲单帧的单次最大,只作诊断;
 *   - `inlineMs`    样式内联单帧的稳健值;
 *   - `rasterMs`    画布栅格化单帧的稳健值(没有画布的卡是 0);
 *   - `serializeMs` 序列化单帧的稳健值。
 * 带 `probe: true` 的 `setTime` 里那次**真实 rAF 等待不计入任何一个数**(舞台在等 rAF 之前
 * 就取了 `stepMs`,三段快照耗时由 `createSnapshot` 自己量)—— 不这么做的话随机访问卡的
 * 成绩里至少含一个垂直同步(约 17 ms)。
 *
 * 统计全在 Node 这一侧做(页面只负责量、只回原始数组),`--json` 里留的因此是**原始样本**:
 * 换了系数重算、两次跑比判重名单差异,都不用重测。
 *
 * # 已测过的卡会跳过
 *
 * 开跑前 `GET /api/data/costs?device=<本机>`,`(identityKey, device)` 已有记录
 * **且 `demoted !== true`** 的整张跳过(pinned 渲染 5 末句:身份没变就直接复用)。`--force` 强制重测。
 *
 * # 系数变了 = 换了量法
 *
 * `STEP_PERCENTILE` / `STEP_MIN_SAMPLES` 决定 `stepMs` 怎么从样本里取,改了它们等于换了量法,
 * 旧成绩不该再用。所以这两个数**拼进 `device` 串**(和 `mode` 同一个办法):去重键是
 * `${identityKey} ${device}`,拼进去之后旧记录自然不命中、会被重测,两套量法的成绩各占一条。
 * `COST_SCALE` **不拼** —— 它只影响怎么用这些数(判重和权重),不影响量出来的数本身。
 *
 * 拼法本身在 `src/render/costDevice.mjs`,**常驻探针(`src/editor/probeRunner.ts`)import 同一份**:
 * 两条路各写一遍的话任何一处顺序 / 空格不一致,两套记录就互相看不见(R4a 报告 §8 第 10 条)。
 *
 * # dev 还是 build
 *
 * `--mode` 缺省自动判:`GET <origin>/@vite/client` 回 JS 模块就是 dev server,回别的
 * (`vite preview` 走 SPA 兜底把 `dist/index.html` 回过来,**状态码同样是 200**)就是构建产物。
 * 记录里带 `mode`,而且 **`mode` 同时拼进 `device` 串** —— `costs-store.mjs` 的去重键是
 * `${identityKey} ${device}`,不拼进去的话两种模式会互相覆盖,而两组数都要留着
 * (任务书 3.1:桌面版跑的就是 dev server,dev 的数才是真实运行环境;build 的数是给将来的
 *  在线浏览器模式的)。服务端把 `device` 当不透明字符串,所以键的代码一行都不用改。
 *
 * **注意**:宿主页的卡片注册表是直接 `import('/src/cards/index.ts')` 拿的,只有 dev server
 * 供得起;要在 `vite preview` 的构建产物上跑,还得先把注册表打成一个独立的探针 kit
 * (参考实现里的 `scripts/probes/build-probe-kit.mjs`),R1 没做,见报告。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

import { costDeviceString } from '../src/render/costDevice.mjs';
import { budgetOf, clipWeight } from '../src/render/pipelinePlan.mjs';
import { DEFAULT_TUNING, PROBE_MAX_FRAMES, PROBE_MAX_MS, resolveTuning } from '../src/render/pipelineTuning.mjs';
import { maxOf, percentile, summarizeProbe } from '../src/render/probeSummary.mjs';

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const origin = (flag('--origin') || process.env.PC_STAGE_TEST_URL || 'http://127.0.0.1:5197').replace(/\/+$/, '');
const fpsArg = Number(flag('--fps', '30')) || 30;
const clipSec = Number(flag('--clip-sec', '4')) || 4;
const worstFrames = Math.max(1, Number(flag('--worst-frames', '40')) || 40);
const cardsArg = flag('--cards');
const projectArg = flag('--project');
const glRouteArg = flag('--gl-route');
const limit = Number(flag('--limit', '0')) || 0;
const force = has('--force');
const dryRun = has('--dry-run');
const modeArg = flag('--mode');
/** 这一趟的全部原始数(每卡的分位数、trunc、maxAt…),给报告和「跑两遍比差异」用 */
const outJson = flag('--json');

const HOST_PATH = '/__probe-card-costs-host';

/* ------------------------------------------------------------------ 宿主页 */

// 同源的一张测试页:仓库里不留静态文件,由 puppeteer 请求拦截临时供给。
// 技法照 scripts/probes/stage-rpc-probe.mjs(那一份已知对 5197 可用)。
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>card cost probe host</title>
<!-- @vitejs/plugin-react 的前导:index.html 由插件自动注入,这张手写的页要自己带,
     否则任何 /src/**.tsx 一 import 就抛「can't detect preamble」。production 包里 /@react-refresh 不存在,
     所以吞掉失败(那时候也不需要它)。 -->
<script type="module">
try {
  const RefreshRuntime = await import('/@react-refresh');
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
} catch { /* 产物包:没有 react-refresh,也不需要 */ }
</script>
</head>
<body style="margin:0;background:#111">
<iframe id="f" src="/?stage=1&id=B&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
<script type="module">
// 最小 RPC 客户端(和 src/render/stageRpc.ts 同一协议),内联着写是为了这张页也能打产物包
function createStageRpc(target) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady','frame','ended','settled','probe','demote','probe-frame'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, location.origin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject','setTime','render','hitTest','rectsWithBounds','size','setProxy','setRole','setPlan','play','pause','setSuppressed','setStreamPlanes','setScrubbing','setPlaying','setMediaT','setLocalHashes','setSnapshots']) c[m] = call(m);
  return c;
}

const f = document.getElementById('f');
window.__probeFrames = 0;
window.__ready = new Promise((res, rej) => {
  setTimeout(() => rej(new Error('stage ready timeout')), 180000);
  window.addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    window.__caps = e.data.hostCapabilities;
    window.__rpc = createStageRpc(f.contentWindow);
    // probe-frame 只计数:逐帧 html 在这一侧没用,攒下来白占内存
    window.__rpc.onEvent((ev) => { if (ev.type === 'probe-frame') window.__probeFrames++; });
    res(true);
  });
});

/* 卡片注册表 / 图 / 身份键。dev 模式下 /src/* 由 vite 现场变换,直接 import 即可。 */
window.__kit = (async () => {
  await import('/src/cards/index.ts');                       // 模块级 registerCards
  const registry = await import('/src/kernel/registry.ts');
  const { projectCardGraph } = await import('/src/kernel/cardGraph.mjs');
  const { cardCostKey } = await import('/src/render/cardCostKey.mjs');
  const { cardSourceVersion } = await import('/src/render/cardSourceVersion.mjs');
  const { builtinCardSourceFiles } = await import('/src/render/cardSourceFiles.mjs');
  const { cardFrameMode, reviewedCard } = await import('/src/kernel/frameMode.mjs');
  const assets = await import('/src/cards/assets/index.ts');
  // 源码版本照 ExportView.tsx:108-118 那份算法
  const sourceVersionOf = (card) => {
    const user = registry.userCardSources();
    const file = user.fileOf[card.id];
    return file && user.files[file] !== undefined
      ? 'user:' + cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, '/src/cards/user/' + file + '.tsx')
      : 'builtin:' + cardSourceVersion(card, builtinCardSourceFiles);
  };
  return { ...registry, projectCardGraph, cardCostKey, cardFrameMode, reviewedCard, sourceVersionOf, featuredParticleIds: assets.featuredParticleIds };
})();

/* 本机身份(J4):UA + WebGL 渲染器 + compact(只有一个舞台;串里的字段名仍叫 lowMemory,见 costDevice.mjs)/ offscreenGl / glRoute。
   一次性的丢弃上下文在**宿主页**里开,不碰舞台自己那个共享 WebGL 上下文。
   读法和拼法都在 src/render/costDevice.mjs,常驻探针 import 的是同一份。 */
window.__deviceParts = async () => {
  const { readGpuRenderer, resolveGlRoute } = await import('/src/render/costDevice.mjs');
  const caps = window.__caps || {};
  const compact = !!caps.compact;
  return { ua: navigator.userAgent, renderer: readGpuRenderer(document), compact,
    offscreenGl: !!caps.offscreenGl, glRoute: resolveGlRoute(caps.glRoute ?? null, compact ? 'shared' : 'perDocument') };
};

/* 缩水项目:一条轨道一个 clip(形状同 FrameScene.tsx 的 legacyTimeline) */
window.__mkProject = (cardId, fps, lenSec, params) => ({
  version: 1, id: 'probe', name: 'probe', width: 1920, height: 1080, fps, duration: lenSec,
  themeId: 'midnight', media: [],
  tracks: [{ id: 'probe-track', clips: [{ id: 'c0', cardId, start: 0, end: lenSec, params: params || {} }] }],
});

/* 身份键 + 声明的帧模式。只算不测,给「跳过已测过的卡」用 */
window.__identify = async (jobs) => {
  const kit = await window.__kit;
  return jobs.map((job) => {
    const def = kit.getCard(job.cardId);
    if (!def) return { ...job, error: '注册表里没有这张卡' };
    try {
      const project = window.__mkProject(job.cardId, job.fps, job.lenSec, job.params);
      const node = kit.projectCardGraph(project, kit.getCard).nodes.find((n) => n.clipId === 'c0');
      if (!node) return { ...job, error: '图里没有这个片段的节点' };
      const durationFrames = Math.max(1, Math.round(job.lenSec * job.fps));
      return { ...job, durationFrames,
        identityKey: kit.cardCostKey(node, kit.sourceVersionOf(def), job.fps, durationFrames),
        canvasHeavy: ['canvas2d', 'webgl'].includes(kit.reviewedCard(job.cardId)?.surface),
        mode: kit.cardFrameMode(def, def.defaults) };
    } catch (err) { return { ...job, error: String(err && err.message || err) }; }
  });
};

/* 面板默认可见的那 62 张(inventory :19):非粒子卡全要 + 目录标了 featured 的粒子卡 */
window.__highFrequencyIds = async () => {
  const kit = await window.__kit;
  return kit.allCards().map((c) => c.id).filter((id) => !id.startsWith('particles-') || kit.featuredParticleIds.has(id));
};

/* -------- 一张卡的实测。整趟都在页面里跑,免得每帧一次 puppeteer 往返。
      **这里只负责量,不做统计** —— 分位数、外推、判重全在 Node 那一侧(见文件头)。 -------- */
const seedOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

window.__probeOne = async (job) => {
  const rpc = window.__rpc;
  const { cardId, fps, lenSec, params, mode, identityKey, durationFrames } = job;
  const out = { cardId, identityKey, fps, mode, durationFrames };
  const project = window.__mkProject(cardId, fps, lenSec, params);
  await rpc.setRole('back', { job: 'probe' });
  await rpc.setProject(project, { reset: true });
  // 挂载那一下 React 要建树、Motion 要解析关键帧:给一个真任务边界再开测,
  // 否则第一张卡的第一帧会把整个模块的首次求值算进去。canvas 卡(three.js / tsParticles)
  // 还要等它异步把画布装起来,不然量的是一个空壳(实测 particles-basic 差 30 倍)。
  await rpc.setTime(0);
  await new Promise((r) => setTimeout(r, 150));
  if (job.canvasHeavy) {
    const w = document.getElementById('f').contentWindow;
    for (let i = 0; i < 100; i++) {
      const cv = w.document.querySelector('[data-pc-clip] canvas');
      if (cv && cv.width > 1) { await new Promise((r) => setTimeout(r, 150)); break; }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (mode === 'direct') {
    /*
     * 固定随机抽本地帧(按 cardId 播种,复跑同一台机器结果可比)。
     * **抽满 job.minSamples 帧**(任务书 K1:8 次不够 STEP_MIN_SAMPLES 就补抽);
     * 片段比这还短的按帧数抽满、不重复。
     */
    const want = Math.max(8, Math.min(job.minSamples, durationFrames));
    const rnd = mulberry32(seedOf(cardId));
    const picks = new Set();
    for (let i = 0; i < want * 64 && picks.size < Math.min(want, durationFrames); i++) picks.add(Math.floor(rnd() * durationFrames));
    const frames = [...picks].sort((a, b) => a - b);
    const steps = [], inline = [], raster = [], serialize = [];
    for (const n of frames) {
      const r = await rpc.setTime(n / fps, { probe: true });
      // stepMs 是舞台在等那一次真 rAF **之前**取的,所以这里拿到的已经不含垂直同步(3.8 末条)
      steps.push(Number(r?.stepMs) || 0);
      inline.push(Number(r?.snapshot?.inlineMs) || 0);
      raster.push(Number(r?.snapshot?.rasterMs) || 0);
      serialize.push(Number(r?.snapshot?.serializeMs) || 0);
    }
    out.kind = 'random';
    out.steps = steps;
    out.inline = inline;
    out.raster = raster;
    out.serialize = serialize;
    out.pushedFrames = steps.length;
    out.totalFrames = durationFrames;
    out.truncated = false;
    return out;
  }

  /* ---- 计时趟:只推进、不生成快照,按 PROBE_MAX_* 封顶,回包带每帧耗时 ---- */
  const target = Math.max(0, lenSec - 1 / fps);
  const totalFrames = Math.max(1, Math.round(target * fps) + 1);
  window.__probeFrames = 0;
  const timePass = await rpc.render(target, { jump: true, probe: 'time', maxCatchUp: Infinity, maxFrames: job.maxProbeFrames });
  out.kind = 'stepped';
  out.steps = Array.isArray(timePass?.steps) ? timePass.steps.map(Number) : [];
  out.pushedFrames = Number(timePass?.frames) || out.steps.length;
  out.totalFrames = totalFrames;
  out.runMs = Number(timePass?.elapsedMs) || 0;
  out.truncated = !!timePass?.truncated;
  // 计时趟一帧快照都不该生成,这个数应当恒为 0;不为 0 就是舞台那一侧的分支串了
  out.timePassProbeFrames = window.__probeFrames;

  /* ---- 快照趟:按 K3 的重挂载定位配方复位,再逐帧生成一次快照 ---- */
  const n = Math.max(1, Math.min(totalFrames - 1, job.worstFrames));
  out.snapN = n;
  window.__probeFrames = 0;
  await rpc.render(0, { jump: true, maxCatchUp: Infinity });   // 重挂载定位配方:复位到挂载帧
  const inline = [], raster = [], serialize = [];
  for (let k = 1; k <= n; k++) {
    const r = await rpc.render(k / fps, { probe: 'snapshot', maxCatchUp: Infinity });
    inline.push(Number(r?.snapshot?.inlineMs) || 0);
    raster.push(Number(r?.snapshot?.rasterMs) || 0);
    serialize.push(Number(r?.snapshot?.serializeMs) || 0);
  }
  out.inline = inline;
  out.raster = raster;
  out.serialize = serialize;
  out.snapPassProbeFrames = window.__probeFrames;
  return out;
};
</script></body></html>`;

/* ------------------------------------------------------------------ 要测哪些卡 */

function jobsFromProject(file, fps) {
  const raw = fs.readFileSync(file, 'utf8');
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`${file} 不是 JSON 项目(${e.message})`); }
  // .proc 是 { format, version, project: {...} };裸项目也收
  const proj = doc?.project ?? doc;
  const projFps = Number(proj.fps) || fps;
  const jobs = [];
  for (const track of proj.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId) continue;
      const len = Math.max(1 / projFps, Number(clip.end) - Number(clip.start));
      jobs.push({ cardId: clip.cardId, fps: projFps, lenSec: Number(len.toFixed(6)), params: clip.params ?? {} });
    }
  }
  return jobs;
}

/* ------------------------------------------------------------------ 端点 */

/**
 * dev server 还是 `vite preview` 的构建产物。判据是 `/@vite/client` 回的 **Content-Type**:
 * dev server 回 JS 模块,`vite preview` 走 SPA 兜底把 `dist/index.html` 回过来
 * (**状态码同样是 200**,所以不能拿 `res.ok` 判)。`--mode` 可以强制。
 */
async function detectMode() {
  if (modeArg === 'dev' || modeArg === 'build') return modeArg;
  try {
    const res = await fetch(`${origin}/@vite/client`, { method: 'GET' });
    return res.ok && /javascript|ecmascript/i.test(res.headers.get('content-type') || '') ? 'dev' : 'build';
  } catch {
    return 'build';
  }
}

/**
 * `GET /api/data/costs` 一并回 K2 的可调系数(`out/pipeline-tuning.json`,没有这个文件 = 全用缺省)。
 * 插件还没挂上 / `--dry-run` 时用缺省,这一趟的量法就和缺省那一套一致。
 */
async function getCosts(device) {
  const res = await fetch(`${origin}/api/data/costs${device ? `?device=${encodeURIComponent(device)}` : ''}`);
  if (res.status === 404) return { missing: true, costs: [], tuning: resolveTuning(null) };
  if (!res.ok) throw new Error(`GET /api/data/costs → HTTP ${res.status}`);
  const data = await res.json();
  return { missing: false, costs: Array.isArray(data?.costs) ? data.costs : [], tuning: resolveTuning(data?.tuning) };
}

async function putCosts(records) {
  const res = await fetch(`${origin}/api/data/costs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(`PUT /api/data/costs → HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/* ------------------------------------------------------------------ 主流程 */

const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
/** 统计全在 `src/render/probeSummary.mjs` 里,常驻探针 import 的是同一份(见文件头) */
const pct = percentile;

function table(rows, columns) {
  const head = columns.map((c) => c.title);
  const body = rows.map((r) => columns.map((c) => String(c.get(r) ?? '')));
  const width = head.map((h, i) => Math.max([...h].length, ...body.map((r) => [...r[i]].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ');
  return [line(head), width.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

const mode = await detectMode();

const browser = await puppeteer.launch({
  headless: true,
  // 关掉后台节流:舞台补跑每 8 帧让出一个真 setTimeout(stageClock 的 yieldEvery),
  // 被后台页节流成 1 秒一次的话一张卡要跑几十秒,量出来的也不是卡自己的代价。
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === HOST_PATH) req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: hostHtml });
    else req.continue();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin + HOST_PATH, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.evaluate(() => window.__ready);
  await page.evaluate(async () => { await window.__kit; return true; });

  const parts = await page.evaluate(() => window.__deviceParts());
  if (glRouteArg) parts.glRoute = glRouteArg;

  /*
   * 系数要先拿到:`STEP_PERCENTILE` / `STEP_MIN_SAMPLES` 既决定 `stepMs` 怎么从样本里取,
   * 又要拼进 `device` 串(见文件头「系数变了 = 换了量法」),所以这一次 GET 不带 device。
   */
  const boot = dryRun ? { missing: true, costs: [], tuning: resolveTuning(null) } : await getCosts(null);
  const tuning = boot.tuning;

  /*
   * `mode` 也拼进 device:`costs-store.mjs` 的去重键是 `${identityKey} ${device}`,不拼进去的话
   * dev 那一趟和 build 那一趟会互相覆盖,而两组都要留着(见文件头)。服务端只把 device 当
   * 不透明字符串,不解析,所以键的代码不用动。
   * 量法的两个系数同理:改了它们旧成绩就不是一回事了,拼进去旧记录自然不命中、会被重测。
   * 拼法住在 `src/render/costDevice.mjs`,常驻探针用的是同一个函数。
   */
  const device = costDeviceString({ ...parts, mode, tuning });
  console.log(`mode: ${mode}（${origin}）`);
  console.log(`tuning: COST_SCALE=${tuning.COST_SCALE} STEP_PERCENTILE=${tuning.STEP_PERCENTILE} STEP_MIN_SAMPLES=${tuning.STEP_MIN_SAMPLES}`
    + (JSON.stringify(tuning) === JSON.stringify(DEFAULT_TUNING) ? '（缺省）' : '（out/pipeline-tuning.json 覆盖过）'));
  console.log(`probe caps: PROBE_MAX_FRAMES=${PROBE_MAX_FRAMES} PROBE_MAX_MS=${PROBE_MAX_MS}`);
  console.log(`device: ${device}\n`);

  let jobs;
  if (projectArg) {
    jobs = jobsFromProject(path.resolve(projectArg), fpsArg);
  } else if (cardsArg) {
    jobs = cardsArg.split(',').map((s) => s.trim()).filter(Boolean).map((cardId) => ({ cardId, fps: fpsArg, lenSec: clipSec, params: {} }));
  } else {
    const ids = await page.evaluate(() => window.__highFrequencyIds());
    jobs = ids.map((cardId) => ({ cardId, fps: fpsArg, lenSec: clipSec, params: {} }));
  }
  if (limit) jobs = jobs.slice(0, limit);

  const identified = await page.evaluate((j) => window.__identify(j), jobs);
  const broken = identified.filter((j) => j.error);
  for (const j of broken) console.warn(`跳过 ${j.cardId}:${j.error}`);

  const existing = dryRun ? { missing: true, costs: [] } : await getCosts(device);
  if (existing.missing) console.warn('GET /api/data/costs 回了 404 —— 插件还没挂上(或者在 --dry-run 里),这一趟不跳过任何卡。');
  const known = new Map(existing.costs.map((r) => [r.identityKey, r]));
  const todo = [], skipped = [];
  const seen = new Set();
  for (const j of identified) {
    if (j.error) continue;
    if (seen.has(j.identityKey)) continue;   // 同一张卡的多个片段身份相同,只测一次
    seen.add(j.identityKey);
    const hit = known.get(j.identityKey);
    if (!force && hit && hit.demoted !== true) { skipped.push({ ...j, hit }); continue; }
    todo.push({ ...j, worstFrames, minSamples: tuning.STEP_MIN_SAMPLES, maxProbeFrames: PROBE_MAX_FRAMES });
  }
  console.log(`共 ${identified.length} 个片段 → ${todo.length} 张要测,${skipped.length} 张已有记录跳过,${broken.length} 张有问题。\n`);

  const B = budgetOf(fpsArg);
  const records = [], results = [];
  for (const [i, job] of todo.entries()) {
    process.stdout.write(`[${i + 1}/${todo.length}] ${job.cardId} (${job.mode}) … `);
    let raw;
    try {
      raw = await page.evaluate((j) => window.__probeOne(j), job);
    } catch (err) {
      console.log('失败');
      results.push({ ...job, error: String(err && err.message || err) });
      continue;
    }
    // 统计在这一侧做:页面只回原始样本(见文件头)
    const out = { ...raw, ...summarizeProbe(raw, tuning) };
    out.capped = out.stepMs * tuning.COST_SCALE > B;
    /*
     * 这张卡按 K2 会走哪一档、哪些位置判重 —— 只作诊断打印,真正的分派由 `planPipelines`
     * 对着整个项目算(轻重是「(位置, 卡)」的属性,单张卡本身没有轻重)。离线探针不测
     * `seekOk`,所以这里的档位对可定位的长 CSS 卡偏保守,和 K2 对 `seekOk` 缺席时的兜底一致。
     */
    out.tier = clipWeight({ ...out, capped: out.capped }, job.mode, out.fps, tuning).tier;
    console.log(`stepMs=${num(out.stepMs, 2)}(max ${num(out.stepMaxMs, 2)}) inline=${num(out.inlineMs, 1)} raster=${num(out.rasterMs, 1)}`
      + ` serial=${num(out.serializeMs, 1)} catchUpMs=${num(out.catchUpMs, 0)} ${out.tier}${out.capped ? ' CAPPED' : ''}`);
    results.push(out);
    records.push({
      identityKey: out.identityKey,
      fps: out.fps,
      // 五个数分开报(任务书 3.8 + K1);旧的 frameMs 已删,不留兼容
      stepMs: Number(out.stepMs.toFixed(3)),
      stepMaxMs: Number(out.stepMaxMs.toFixed(3)),
      inlineMs: Number(out.inlineMs.toFixed(3)),
      rasterMs: Number(out.rasterMs.toFixed(3)),
      serializeMs: Number(out.serializeMs.toFixed(3)),
      catchUpMs: Number(out.catchUpMs.toFixed(3)),
      ...(out.capped ? { capped: true } : {}),
      kind: out.kind,
      mode,
      /*
       * **显式写 false**(任务书 3.3):`costs-store.mjs` 的 STICKY_FLAGS 是「新记录没带这个字段
       * 就沿用旧值,带了哪怕 false 也以新的为准」,而存档是落盘的 —— 不显式带,K6 写过一次 true
       * 之后每次重测都会被贴回 true,这张卡就永久判重了。「只在本次会话生效」正是靠这一条成立。
       * `pinnedHeavy` 留给将来的人工钉死,本任务不写它(3.3)。
       */
      demoted: false,
      measuredAt: Date.now(),
      device,
    });
  }

  console.log(`\nB = 1000/${fpsArg} × 70% = ${B.toFixed(2)} ms\n`);
  console.log(table(results.filter((r) => !r.error), [
    { title: 'card', get: (r) => r.cardId },
    { title: 'kind', get: (r) => r.kind },
    { title: 'stepMs', get: (r) => num(r.stepMs, 2) },
    { title: 'stepMax', get: (r) => num(r.stepMaxMs, 2) },
    { title: 'inlineMs', get: (r) => num(r.inlineMs, 2) },
    { title: 'rasterMs', get: (r) => num(r.rasterMs, 2) },
    { title: 'serialMs', get: (r) => num(r.serializeMs, 2) },
    { title: 'catchUpMs', get: (r) => num(r.catchUpMs, 0) },
    { title: 'oldCatchUp', get: (r) => num(r.legacyCatchUpMs, 0) },
    { title: 'stepP50', get: (r) => num(r.stepP50, 2) },
    { title: 'stepP90', get: (r) => num(r.stepP90, 2) },
    { title: '1st', get: (r) => num(r.firstMs, 2) },
    { title: 'run', get: (r) => (r.kind === 'stepped' ? `${r.samples}/${r.totalFrames}` : `${r.samples}`) },
    { title: 'snapN', get: (r) => r.snapN ?? '—' },
    { title: 'trunc', get: (r) => (r.truncated ? 'yes' : 'no') },
    { title: 'tier', get: (r) => r.tier ?? '' },
    { title: 'capped', get: (r) => (r.capped ? 'YES' : '') },
  ]));

  /* 按 K2 的三档分一分 —— 报告要的「各多少张、哪些卡被追帧上界判重」 */
  const ok = results.filter((r) => !r.error);
  const byTier = new Map();
  for (const r of ok) byTier.set(r.tier, [...(byTier.get(r.tier) ?? []), r.cardId]);
  console.log('\n按 K2 的档位分（离线不测 seekOk，所以长 CSS 卡也落在推帧那几档）：');
  for (const [tier, list] of [...byTier].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${tier.padEnd(14)} ${String(list.length).padStart(3)} 张  ${list.join(', ')}`);
  }
  const steps = ok.map((r) => r.stepMs);
  console.log(`\nstepMs p50 / p90 / max = ${num(pct(steps, 0.5), 2)} / ${num(pct(steps, 0.9), 2)} / ${num(maxOf(steps), 2)} ms`);
  const cappedCards = ok.filter((r) => r.capped).map((r) => r.cardId);
  console.log(`单帧越过 B 的（capped）：${cappedCards.length} 张${cappedCards.length ? ' —— ' + cappedCards.join(', ') : ''}`);
  const overCatchUp = ok.filter((r) => r.tier === 'over-catchup' && !r.capped).map((r) => r.cardId);
  console.log(`被追帧上界判重的：${overCatchUp.length} 张${overCatchUp.length ? ' —— ' + overCatchUp.join(', ') : ''}`);

  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.log('\n失败:');
    for (const f of failed) console.log(`  ${f.cardId}: ${f.error}`);
  }
  if (skipped.length) console.log(`\n已有记录跳过:${skipped.map((s) => s.cardId).join(', ')}`);

  if (!dryRun && records.length) {
    const put = await putCosts(records);
    console.log(`\nPUT /api/data/costs → ok,存档共 ${put.count} 条(新增 ${put.added}、更新 ${put.updated})。`);
    const back = await getCosts(device);
    const got = new Set(back.costs.map((r) => r.identityKey));
    const missing = records.filter((r) => !got.has(r.identityKey));
    console.log(`GET /api/data/costs?device=… → ${back.costs.length} 条;本趟 ${records.length} 条里缺 ${missing.length} 条。`);
    if (missing.length) exitCode = 1;
  } else if (dryRun) {
    console.log('\n--dry-run:没有写 /api/data/costs。');
  }

  if (outJson) {
    const file = path.resolve(outJson);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ origin, mode, device, fps: fpsArg, clipSec, worstFrames, B,
      tuning, probeCaps: { PROBE_MAX_FRAMES, PROBE_MAX_MS },
      at: new Date().toISOString(), results, skipped: skipped.map((s) => s.cardId),
      broken: broken.map((b) => ({ cardId: b.cardId, error: b.error })) }, null, 2), 'utf8');
    console.log(`\n原始数据写到 ${file}`);
  }

  const noise = errors.filter((e) => !/favicon|React DevTools|Failed to load resource/i.test(e));
  if (noise.length) {
    console.log(`\n页面报错 ${noise.length} 条(前 5 条):`);
    for (const e of noise.slice(0, 5)) console.log('  ' + e);
  }
} catch (err) {
  console.error(err && err.stack || err);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
