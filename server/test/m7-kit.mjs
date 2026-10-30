/**
 * 仅供测试，生产代码不得引用。
 *
 * M7 契约测试（M7-T，`server/test/m7-*.test.mjs`）的公共件。依据只有 `docs/plan/m7-contract.md` 第 1 版（第 3～5 节、
 * 第 10 节验收，按第 13 节主会话裁定）与 `docs/plan/render-queue-contract.md`；测试方没看实现分支
 * （`claude/rq-m7-queue`、以后的页面节点分支）。
 *
 * 契约没写死的模块路径、函数名、参数与回包形状全部集中在本文件，集成时对账只改这里，不改判据。
 * 每一处假设用「K<n>」标出，报告 `docs/archive/agent-reports/AGENT-rq-m7-tests.md` 按同样的编号列出。
 *
 * # 实现不在时怎么办（门）
 *
 * 每组用例开头调本文件的 `*Gate()`：静态读源文件，看实现的标志（某个字段名、某个导出名）出现没有，不 import、不执行。
 * 不在就把这组用例标成 `node:test` 的 skip，原因写「哪个文件、缺哪个标志」。门只看「实现有没有」，不看「对不对」：
 * 标志一出现，用例就真跑，形状对不上直接失败（由集成方改本文件对账），不会被静默跳过。
 * 所以 M7 集成前 `npm test` 的跳过数会多出这些；集成后这些门必须全部打开。
 *
 * 已经在代码里的约定（E5 两层、B2 的节点侧过滤、plan-profile、层表 v2 的读法）不设门，现在就跑，守回归。
 *
 * # 假设
 *
 *   K1  通用：`.ts` 模块经 `src/testing/registerTs.mjs` 的解析钩子在 Node 里 import（与现有单测同一做法）；
 *       门的「导出名」靠静态找 `export function|const|let|class <名>` 或 `export { … <名> … }`，名字在候选表里任取其一。
 *   K2  D9 凭证归属：render 票据带 `owner: { kind: 'browser' }`，连接上的 principal 形如
 *       `{ userId: '<用户名>@<设备>', tenantId, scope: 'member', role: 'render', owner: { kind: 'browser' } }`
 *       （与 `server/auth/handshake.mjs` 的 `memberPrincipal` 同形，只多一种 owner）。
 *       `server/auth/protocol.mjs` 的 `normalizeOwner({ kind: 'browser' })` 回 `{ kind: 'browser' }`，多带别的键回 null。
 *       队列模块（`server/docservice/modules/render-queue.mjs` 或队列本体，两层任一）对这种连接：
 *       `node.hello` 的 `profile` 不是 `'browser'` 回 `{ type: 'error', reason: 'forbidden' }`（同 `mayRegisterNode` 的拒绝形状），
 *       且节点不登记；`nodeId` 第一次由它报到后绑到它的 `userId`，别的 `userId`（不论 owner）拿同一个 `nodeId` 报到同样回
 *       `error forbidden`，原节点不受影响。门：两个文件任一出现 `.owner`。
 *   K3  D10 指纹由服务端算：浏览器归属的连接 `node.hello` 带 `environment: { platform, userAgent, renderer, vendor }`（`pageEnvironment()` 的原始值），
 *       服务端按 `describeEnvironment({ platform, renderer, vendor, chromeVersion: userAgent })`（与测量帧入库路由
 *       `vite-plugin-frames.ts` 同一换算）算指纹、记进节点，`node.welcome.envFingerprint` 回这个值；hello 里自报的 `envFingerprint`
 *       对这种连接不作数。门：两个文件任一出现 `describeEnvironment`。
 *       D14 在服务端的读法（本测试方的推论，见报告「需要主会话定的事」）：非 Chromium 的 UA 报上来，这个节点一个快照任务也认领不到
 *       （报到被拒，或认领一律不给，二者都认）。
 *   K4  D1 队列侧：细任务带 `input.dual: true`；某条锁键第一次由认领建锁时，同锁键、异指纹、`input.dual === true`、还 `open` 的任务
 *       一律进 `failed`、`lastError: 'superseded'`（`describe()` 可见），不计 attempts；不带 dual 的照旧。门：`queue.mjs` 出现 `dual`。
 *   K5  D2 队列侧：`card-locked` 的认领回包（`task.claim-rejected`）与发布回包（`task.published` 的 `results[i]`）另带
 *       `lockIdleMs`（此刻 − 锁的 `touchedAt`）与 `lockedByProfile`（建锁那次认领的节点的 profile）；`task.progress` 也刷新
 *       `touchedAt`（`describe().locks[i].touchedAt` 可见）。门：`queue.mjs` 出现 `lockIdleMs`。
 *   K6  D1 切分侧：`server/render-node/split.mjs` 的 `splitPlan` 从 `planTask.input.browser`（`{ nodeId, envFingerprint }`）读浏览器意向
 *       （测试同时也以同名选项 `browser` 传一份，二者任一被读都行）。浏览器可做的卡 = 共享档、`weightOf(control).class` 为
 *       light / medium、`compositing`（`control.compositing ?? control.capabilities.compositing`）为 `'independent'`、非用户卡素材效果卡、
 *       `cardSourceVersions` 里没有它、没锁在第三种环境上。这种卡每段出两份：切分方指纹一份、浏览器指纹一份，两份都 `input.dual: true`、
 *       都不带 `takeover`；浏览器那一份 `input.bake` 是带 `count` 与 `sampling` 两个键的对象，`input.compositing === 'independent'`。
 *       结果键照契约 B.1 自己算：`sha256(contentKey + '\n' + fp)`。门：`split.mjs` 出现 `dual`。
 *   K7  D4 节点侧：`server/render-node/filter.mjs` 的 `checkClaimable` 对纯浏览器节点只收 `input.compositing === 'independent'` 的快照任务。
 *       门：`filter.mjs` 出现 `compositing`。
 *   K8  D2 切分侧的判定：`IDLE_TAKEOVER_FILES` 之一导出纯函数（`IDLE_TAKEOVER_NAMES` 之一），
 *       `fn(lockKey, lockedBy, { lockIdleMs, lockedByProfile })` → 布尔：`lockIdleMs > 30000`（`server/card-lock.mjs` 的
 *       `CARD_LOCK_IDLE_MS`）才接手；没有 `lockIdleMs` 不接手。给 `createLocalNode({ takeoverLocked })` 用。
 *   K9  D12 层表 v3：页面读法仍是 `src/render/snapshotSource.ts` 的 `layerRefOf(table, clipId, opts)`；v3 的层形如
 *       `{ clipId, kind, key, resultKey, firstFrame, count, contentKey, envFingerprint, candidates: [{ resultKey, envFingerprint, key }] }`
 *       （层上的 `resultKey` / `envFingerprint` / `key` 等于第一个候选，旧读法照样能读）；`opts.alive` 是认定活着的结果键集合（`Set<string>`，
 *       由 `task.done` 与清单得出）。选中的候选整份回来（`resultKey`、`envFingerprint`、`key` 同出一个候选），认不出时回 null；
 *       v2 表当「一个候选」：有没有 `alive` 都照旧回那一层。门：`KNOWN_LAYER_MAP_VERSIONS` 里出现 3。
 *   K10 页面节点能不能开（第 2 节「当节点的条件」、D14、D16、身份）：`ELIGIBILITY_FILES` 之一导出纯函数（`ELIGIBILITY_NAMES` 之一），
 *       `fn({ online, codeVersion, phone, lowest, stageLayout: 'dual' | 'single', userAgent, member, measured })` → 布尔（2026-10-22 起
 *       原来的档位参数换成身份为手机 `phone` 与最低一档 `lowest`），
 *       或 `{ ok | eligible: 布尔, reason? }`。
 *   K11 页面节点编排（第 2、4 节；D6、D8、D10 页面侧）：`NODE_FILES` 之一导出工厂（`NODE_FACTORY_NAMES` 之一），
 *       `factory(deps)`，`deps` = `{ nodeId, projectId, userId, codeVersion, environment, now, isIdle(), send(message),
 *       keptProject(rev) → 项目 | null（发布时留存的已确认版本）, fetchSnapshot(rev) → Promise<项目 | null>（project.snapshot.get）,
 *       bakeFrame({ task, project, localFrame, signal }) → Promise<{ hash, bytes, htmlGz? }>, finishTask({ task, frames }) → Promise<object> }`；
 *       回的对象：`start()`（发 `node.hello` 与 `queue.watch`）、`receive(message)`（render 连接上收到的消息）、`tick()`（认领与续约的节拍）、
 *       `yieldFor(cause)`（`cause` ∈ `'play' | 'drag' | 'urgent' | 'hidden'`，名字取 `NODE_METHODS.yieldFor` 之一）、`stop()`。
 *       队列消息是 `render-queue-contract.md` A 节的形状（`task.claim { id, expectVersion }`、`task.release { id, token, reason }`、
 *       `task.progress { id, token, done }`、`task.complete { id, token, result? }`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createRouter } from '../docservice/router.mjs';
import { renderQueueModule } from '../docservice/modules/render-queue.mjs';
import { describeEnvironment } from '../render-node/fingerprint.mjs';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const repoPath = (rel) => path.join(ROOT, ...rel.split('/'));
export const repoUrl = (rel) => pathToFileURL(repoPath(rel)).href;
export const exists = (rel) => fs.existsSync(repoPath(rel));
const textOf = (rel) => (exists(rel) ? fs.readFileSync(repoPath(rel), 'utf8') : '');

/* ------------------------------------------------------------------ 门（K1） */

let tsHook = null;
export async function importRepo(rel) {
  if (rel.endsWith('.ts') || rel.endsWith('.tsx')) {
    tsHook ??= import(repoUrl('src/testing/registerTs.mjs'));
    await tsHook;
  }
  return import(repoUrl(rel));
}

/** 一个源文件静态导出的名字 */
export function staticExports(rel) {
  const names = new Set();
  const src = textOf(rel);
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().replace(/^type\s+/, '');
      if (!seg) continue;
      const as = seg.split(/\s+as\s+/);
      names.add((as[1] ?? as[0]).trim());
    }
  }
  return names;
}
export function findExport(files, names) {
  for (const file of files) {
    const got = staticExports(file);
    for (const name of names) if (got.has(name)) return { file, name };
  }
  return null;
}
export function pickMethod(obj, names) {
  for (const n of names) if (obj && typeof obj[n] === 'function') return n;
  return null;
}

const SKIP_TAIL = '（M7 实现未集成，集成后自动转为真跑）';
/** 源文件里出现某个标志（字符串或正则）才算实现在 */
function markerGate(files, marker, what) {
  const hit = files.find((f) => (marker instanceof RegExp ? marker.test(textOf(f)) : textOf(f).includes(marker)));
  return hit ? { ok: true, file: hit } : { ok: false, reason: `实现缺失：${files.join('、')} 里没有 ${what}${SKIP_TAIL}` };
}
function exportGate(files, names) {
  const hit = findExport(files, names);
  if (hit) return { ok: true, ...hit };
  const present = files.filter(exists);
  const where = present.length ? `文件 ${present.join('、')} 在，但没有导出 ${names.join(' / ')}` : `文件 ${files.join('、')} 都不存在`;
  return { ok: false, reason: `实现缺失：${where}${SKIP_TAIL}` };
}
/** `test(name, gateOpts(gate), fn)`：门没开就 skip 并写原因 */
export const gateOpts = (gate) => (gate.ok ? {} : { skip: gate.reason });

const QUEUE_FILE = 'server/render-queue/queue.mjs';
const MODULE_FILE = 'server/docservice/modules/render-queue.mjs';
export const ownerGate = () => markerGate([MODULE_FILE, QUEUE_FILE], /\.owner\b/, '`.owner`（K2，D9 profile 与 nodeId 绑凭证）');
export const authOwnerGate = () => markerGate(['server/auth/protocol.mjs'], /kind\s*===\s*'browser'/, "`kind === 'browser'`（K2，normalizeOwner 认 browser）");
export const serverFpGate = () => markerGate([MODULE_FILE, QUEUE_FILE], 'describeEnvironment', '`describeEnvironment`（K3，D10 指纹由服务端算）');
export const queueDualGate = () => markerGate([QUEUE_FILE], 'dual', '`dual`（K4，D1 建锁时作废另一份）');
export const lockIdleGate = () => markerGate([QUEUE_FILE], 'lockIdleMs', '`lockIdleMs`（K5，D2 锁闲置）');
export const splitDualGate = () => markerGate(['server/render-node/split.mjs'], 'dual', '`dual`（K6，D1 双份出键）');
export const filterIndependentGate = () => markerGate(['server/render-node/filter.mjs'], 'compositing', '`compositing`（K7，D4 只收独立卡）');
export const layerV3Gate = () => markerGate(['src/render/snapshotSource.ts'], /KNOWN_LAYER_MAP_VERSIONS[^=]*=\s*\[[^\]]*\b3\b/, 'KNOWN_LAYER_MAP_VERSIONS 含 3（K9，层表 v3）');

/* K8 */
export const IDLE_TAKEOVER_FILES = [
  'server/render-node/local-node.mjs', 'server/render-node/lock-idle.mjs', 'server/render-node/takeover.mjs',
  'server/render-node/split.mjs', 'server/card-lock.mjs', 'server/queue-publish.mjs', 'server/prerender-executor.mjs',
];
export const IDLE_TAKEOVER_NAMES = ['idleLockTakeover', 'takeoverIdleLock', 'shouldTakeoverLock', 'lockIdleTakeover', 'takeoverWhenIdle', 'takeoverIfIdle'];
export const idleTakeoverGate = () => exportGate(IDLE_TAKEOVER_FILES, IDLE_TAKEOVER_NAMES);

/* K10 */
export const ELIGIBILITY_FILES = [
  'src/online/browserNode.ts', 'src/online/renderNode.ts', 'src/online/nodeEligibility.ts', 'src/online/pageNode.ts',
  'src/editor/browserNode.ts', 'src/editor/sync/browserNode.ts', 'src/online/browserNodeGate.ts',
];
export const ELIGIBILITY_NAMES = ['browserNodeEligibility', 'nodeEligibility', 'canBeNode', 'mayBeNode', 'browserNodeAllowed', 'judgeBrowserNode', 'canServeAsNode'];
export const eligibilityGate = () => exportGate(ELIGIBILITY_FILES, ELIGIBILITY_NAMES);
export function normalizeEligible(r) {
  if (typeof r === 'boolean') return r;
  if (r && typeof r === 'object') {
    if (typeof r.ok === 'boolean') return r.ok;
    if (typeof r.eligible === 'boolean') return r.eligible;
  }
  throw new Error(`假设 K10：认不出节点资格的回包：${JSON.stringify(r)}`);
}

/* K11 */
export const NODE_FILES = [
  'src/online/browserNode.ts', 'src/online/renderNode.ts', 'src/online/pageNode.ts', 'src/editor/browserNode.ts',
  'src/editor/sync/browserNode.ts', 'src/online/browserRenderNode.ts',
];
export const NODE_FACTORY_NAMES = ['createBrowserNode', 'createPageNode', 'createBrowserRenderNode', 'createOnlineNode'];
export const NODE_METHODS = {
  start: ['start', 'begin', 'open'],
  receive: ['receive', 'onMessage', 'handle'],
  tick: ['tick', 'step'],
  yieldFor: ['yieldFor', 'giveWay', 'yield', 'standDown'],
  stop: ['stop', 'dispose', 'close'],
};
export const browserNodeGate = () => exportGate(NODE_FILES, NODE_FACTORY_NAMES);

/* ------------------------------------------------------------------ 指纹与键 */

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
/** 契约 B.1：结果键 = sha256(contentKey \n fp) */
export const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp ?? ''}`);

export const UA = Object.freeze({
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
});
/** `pageEnvironment()` 的原始值（K3） */
export const ENV = Object.freeze({
  winNvidiaChrome: Object.freeze({ platform: 'Windows', userAgent: UA.chrome, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)' }),
  winNvidiaFirefox: Object.freeze({ platform: 'Win32', userAgent: UA.firefox, renderer: 'NVIDIA GeForce GTX 980, or similar', vendor: 'Mozilla' }),
  macSafari: Object.freeze({ platform: 'MacIntel', userAgent: UA.safari, renderer: 'Apple GPU', vendor: 'Apple Inc.' }),
});
/** K3：服务端应得的指纹（与测量帧入库路由同一换算） */
export const serverFingerprintOf = (env) => describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;

/* ------------------------------------------------------------------ 任务 */

export const taskIdOf = ({ kind, resultKey, range }) => (kind === 'plan' ? `plan:${resultKey}` : `${kind}:${resultKey}:${range.from}-${range.to}`);

/** 一段共享档快照任务（契约 A.4 形状，id 自己算） */
export function snapTask({
  projectId = 'p1', projectRev = 1, contentKey = 'ck-1', fp, seg = 0, span = 60, weight = 'medium', tier = 'shared',
  input = {}, requires = {}, priority, derivedFrom,
} = {}) {
  const from = seg * span;
  const range = { unit: 'localFrame', from, to: from + span - 1 };
  const resultKey = rk(contentKey, fp);
  const t = {
    id: taskIdOf({ kind: 'snapshot', resultKey, range }), kind: 'snapshot', tier, resultKey, range,
    source: { projectId, projectRev, ...(derivedFrom !== undefined ? { derivedFrom } : {}) },
    input: { clipId: `clip-${contentKey}`, cardId: 'motion', entryKey: null, contentKey, canvasHeavy: false, compositing: 'independent', ...input },
    weight: { class: weight, estMs: null, frames: span },
    requires: { envFingerprint: fp, codeVersion: 'cv-1', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, ...requires },
  };
  if (priority !== undefined) t.priority = priority;
  return t;
}
export function streamTask({ projectId = 'p1', projectRev = 1, contentKey = 'st-1', fp, seg = 0 } = {}) {
  const from = seg * 8;
  const range = { unit: 'segment', from, to: from + 7 };
  const resultKey = rk(contentKey, fp);
  return {
    id: taskIdOf({ kind: 'stream', resultKey, range }), kind: 'stream', resultKey, range,
    source: { projectId, projectRev },
    input: { clipId: 'clip-bg', cardId: null, entryKey: null, contentKey },
    weight: { class: 'medium', estMs: null, frames: 120 },
    requires: { envFingerprint: fp, codeVersion: 'cv-1', cardSources: {}, transcode: true, capabilities: { streams: true } },
  };
}
/** 清单计划（C10 第 18 节第 9 条的形状） */
export function clipsPlan({ projectId = 'p1', projectRev = 1, sig = 'abc123', clips = ['clip-a'], input = {} } = {}) {
  const resultKey = `${projectId}@${projectRev}#clips:${sig}`;
  return {
    id: `plan:${resultKey}`, kind: 'plan', resultKey, range: null, source: { projectId, projectRev },
    input: { clips, ...input }, weight: { class: 'medium', estMs: null, frames: null }, requires: { codeVersion: 'cv-1' }, priority: 'normal',
  };
}

/* ------------------------------------------------------------------ 文档服务 + 队列模块 + 队列 */

/** 成员连接的 principal（K2）。`owner` 给 `'browser'` 时是浏览器归属的 render 连接 */
export function memberPrincipal({ username, device, role = 'render', owner = null, projectId = 'p1' }) {
  return {
    userId: `${username}@${device}`, tenantId: projectId, scope: 'member', username, deviceId: device, deviceName: device,
    creator: false, role, conversation: null, owner: owner === 'browser' ? { kind: 'browser' } : owner === 'user' ? { kind: 'user' } : null,
  };
}

/**
 * 真路由 + 真队列模块 + 真队列，不起网络，假时钟（照 `m6c-kit.mjs` 的 `createDocQueueRig`）。
 * 收件箱按 connId 分，存 JSON 往返后的消息。
 */
export function createDocQueueRig({ constants, start = 1_000_000 } = {}) {
  let t = start;
  const now = () => t;
  const inbox = new Map();
  const router = createRouter({
    now,
    write: (connId, text) => {
      if (!inbox.has(connId)) inbox.set(connId, []);
      inbox.get(connId).push(JSON.parse(text));
    },
  });
  let mod = null;
  const q = createRenderQueue({
    now, ...(constants ? { constants } : {}),
    send: (connId, message) => {
      let opts;
      if (typeof mod?.outbound === 'function') {
        opts = mod.outbound(connId, message);
        if (opts === null) return;
      }
      router.send(connId, message, opts);
    },
  });
  mod = renderQueueModule(q, {});
  router.mount(mod);
  let seq = 0;
  const rig = {
    q, router, mod, now,
    advance(ms) { t += ms; },
    tick() { router.tick(); },
    connect(connId, principal) { router.connect(connId, principal); },
    send(connId, message) { router.dispatch(connId, JSON.stringify(message)); },
    /** 发一条带 reqId 的消息，回同一 reqId 的回包（没有回 undefined） */
    ask(connId, message) {
      const reqId = `r${++seq}`;
      rig.send(connId, { ...message, reqId });
      return rig.inbox(connId).find((m) => m.reqId === reqId);
    },
    inbox: (connId) => inbox.get(connId) ?? [],
    of: (connId, type) => (inbox.get(connId) ?? []).filter((m) => (Array.isArray(type) ? type.includes(m.type) : m.type === type)),
    clear(connId) { if (connId === undefined) inbox.clear(); else inbox.set(connId, []); },
    describe: () => q.describe(),
  };
  return rig;
}

/* ------------------------------------------------------------------ 进程内：队列 + 节点会话 */

/** 同步直连：队列的 send 按 connId 交给注册的收件函数；另记下每条连接收到的全部消息 */
export function createDirectQueue({ constants, start = 1_000_000 } = {}) {
  let t = start;
  const routes = new Map();
  const log = new Map();
  const q = createRenderQueue({
    now: () => t, ...(constants ? { constants } : {}),
    send: (connId, message) => {
      const m = JSON.parse(JSON.stringify(message));
      if (!log.has(connId)) log.set(connId, []);
      log.get(connId).push(m);
      routes.get(connId)?.(m);
    },
  });
  return {
    q,
    now: () => t,
    advance(ms) { t += ms; },
    route(connId, fn) { routes.set(connId, fn); },
    log: (connId) => log.get(connId) ?? [],
  };
}

/* ------------------------------------------------------------------ 异步 */

/** 让出若干个宏任务回合（不是计时断言：只等已排好的 Promise 链走完，忙机上也不影响顺序） */
export async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}
/** 可在外面落定的 Promise */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
