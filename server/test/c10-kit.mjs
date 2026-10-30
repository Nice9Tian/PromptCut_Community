/**
 * 仅供测试，生产代码不得引用。
 *
 * C10 契约测试（`server/test/c10-*.test.mjs`）的公共件。依据只有 `docs/plan/c10-contract.md` 第 1 版（第 2～12 节）
 * 与它引的语义；测试方没看实现（`claude/c10-browser`、`claude/c10-ui`，以及还没合入 main 的 C10a、HT-a）。
 *
 * 契约没写死的模块路径、函数名、参数与回包形状全部集中在本文件，集成时对账只改这里，不改判据。
 * 每一处假设用「假设 K<n>」标出，报告 `docs/archive/agent-reports/AGENT-c10-tests.md` 按同样的编号列出。
 *
 * # 实现不在时怎么办（门）
 *
 * 每组用例开头用本文件的 `*Gate()` 静态查接口在不在（读源文件、找 `export` 的名字，不 import）：
 * 不在就把这组用例标成 `node:test` 的 skip，原因写「哪个文件不存在、哪个名字没出现」。
 * 门只看「实现有没有」，不看「实现对不对」：名字一出现，用例就真跑，形状对不上直接失败（由集成方改本文件对账），
 * 不会被静默跳过。所以 C10 集成前 `npm test` 的跳过数会多出这些；C10 集成后这些门必须全部打开（跳过数回到集成前的基数）。
 *
 * # 假设
 *
 *   K1  通用：被测的 `.ts` 模块经 `src/testing/registerTs.mjs` 的解析钩子在 Node 里 import（与现有单测同一做法），
 *       所以这些模块在 import 时不碰 `window`、`document`（碰了就把依赖做成惰性）。门靠静态找 `export` 的名字：
 *       `export function|const|let|class|async function <名>` 或 `export { … <名> … }`；名字在候选表里任取其一。
 *
 *   K2  页面内快照库 L2（契约第 4 节）：
 *       - 文件取 `L2_FILES` 里第一个存在的；打开函数取 `L2_OPEN_NAMES` 之一，调用 `await open(opts)`，
 *         `opts = { indexedDB, deviceMemory, estimate, now }`（2026-10-22 起软上限按环境分配，原来的档位参数删掉）：`indexedDB` 是工厂（测试传内存桩，同时装到全局），
 *         `estimate` 是 `() => Promise<{ quota, usage }>`（同时装成 `navigator.storage.estimate`），`now` 是毫秒时钟；
 *       - 回的对象上的方法（名字各取候选之一，见 `L2_METHODS`）：
 *         `putBlock(key, bytes, type)`（`key` 形如 `snap/<hash>` 或 `px/<hash>`，`bytes` 是 Uint8Array）、
 *         `getBlock(key)`（回 `{ bytes, type }`、或直接回字节、或 `undefined` / `null`）、
 *         `putCost(key, record)`、`getCost(key)`、`putRange(layerKey, from, to)`、`subscribe(cb)`（`ranges` 写入即回调；回退订函数）、
 *         `close()`（可选）；异步的方法回 Promise；
 *       - 库里的块能被认出来：`snapshots` 表的记录，其键或值里某个字符串字段等于 `putBlock` 的 `key`；
 *       - 软上限的两个数（256 MiB、64 MiB）作为数值常量从 L2 模块导出（名字不限，可以包在一层对象里）。
 *   K3  按拍换帧（契约第 6 节）：
 *       - `SWAP_MS`（= 3）从 `BEAT_FILES` 之一导出；同一组文件里导出一个纯函数（名字取 `BEAT_FIT_NAMES` 之一），
 *         `fn({ fps, occupiedMs, layers, swapMs })` → `{ swap: string[], placeholder: string[] }`（也认 `swapped` / `placeholders`），
 *         `swapMs` 缺省按 `SWAP_MS`；可以另带 `deadMs`（拍长或预算减去已占用）；
 *       - `src/editor/snapshotFeed.ts` 导出开关（名字取 `BEAT_SWITCH_NAMES` 之一），`开关(true)` 之后播放中的投递不受 33 ms 节流，
 *         暂停时仍受；`开关(false)`（桌面）照旧。门：`SWAP_MS` 出现。
 *   K4  层表（契约第 5 节）：`LAYER_FILES` 之一导出纯函数（名字取 `LAYER_REF_NAMES` 之一），`fn(table, clipId)`：
 *       层表形如 `{ v: 2, kind: 'layer-map', layers: [{ clipId, kind, key, resultKey, firstFrame, count, contentKey, envFingerprint, … }] }`
 *       （`layerEntry` / `layerTable`，集成时已按 `layerMapOf` 的真形状改）；
 *       对得上回一个对象，至少带 `contentKey`、`envFingerprint`（与层表记录的相同）；对不上（缺内容键、缺指纹、层表坏、没这一层）回
 *       `null` / `undefined`，不抛。
 *   K5  两个舞台的运行配置（契约第 2 节）：`STAGE_FILES` 之一导出
 *       - 解析函数（`STAGE_PARSE_NAMES` 之一）：`fn(config)`，`config` 是 `/editor/` 运行配置解析后的对象 `{ stageOrigins: [A 源, B 源] }`
 *         或它的 JSON 文本；回 `{ A, B }`（也认两项数组），读不到或不合法回 `null`，不抛；
 *       - 取舍函数（`STAGE_DECIDE_NAMES` 之一）：`fn({ single, origins, handshake })`（2026-10-22 起 `single` = 舞台闸门停在第一级，原来是档位），`handshake` 为 `'ok' | 'failed'`；
 *         回 `'dual' | 'single'`（也认布尔：true = 双舞台）。
 *   K6  页面发布 plan（契约第 7 节）：`PLAN_FILES` 之一导出工厂（`PLAN_FACTORY_NAMES` 之一），
 *       `factory({ endpoint, debounceMs? })`，`endpoint` 是 `createWsEndpoint` 的形状（`send(msg) → boolean`、`onMessage(handler)`）；
 *       回的对象上 `measured({ projectId, projectRev })`（测量落定）、`changed({ projectId, projectRev })`（项目改了）、`dispose()`，
 *       名字各取候选之一（`PLAN_METHODS`）。防抖用全局的 `setTimeout`（测试用 `mock.timers` 推时间）。
 *       发出去的是渲染任务队列的 `task.publish`（`server/render-queue/messages.mjs` 的 `parseInbound` 认得），
 *       `tasks[0]` 是 `plan`，`resultKey` 的 `#clips:` 之前那一段 = `<projectId>@<projectRev>`（集成对账：页面发清单计划，
 *       工厂另收 `clips`，发布前先报到，见 `planFactoryDeps`）。
 *   K7  用户卡与素材效果卡（契约第 9 节，2026-09-29 用户改语义）：在线开关沿用 `src/render/placeholderHost.ts` 的 `setOnlineBrowserMode(true)`；
 *       用户卡 = 注册表 `isUserCardId`（`userCardSources().fileOf` 里有的卡，或 `setSyncedUserCards` 同步来的卡），
 *       素材效果卡 = 定义里 `card` 是函数（与 `unsupportedHere` 同一判法）；`snapshotFeed.ts` 的 `planFeed` 在在线时把它们一律按重卡，
 *       照常选帧、报缺口，`deliverSnapshots` 照常取字节；暂停态「已精确」对它们不成立。
 *       门：C10-UI 的文案出现（K8）。
 *   K8  置灰与离线文案（契约第 10 节、第 17 节表 A）：文案以字面量写在 `src/` 的非测试源文件里（置灰的模板拆成
 *       「在线浏览器模式暂不支持」与「，请在电脑上的 PromptCut 里使用。」两段找）。门：`C10_UI_MARKERS` 任一出现。
 *   K9  `/api` 棘轮（契约第 10 节）：清单文件 `server/test/c10a-online-api-paths.json`（C10a 的做法），形如 `{ paths: [...] }`；
 *       基线是 `server/test/c10-api-ratchet-baseline.json`（从 `claude/c10a-integ@5b2fccc` 拷来）。门：清单文件存在。
 *   K10 离线备份（契约第 10 节）：`BACKUP_FILES` 之一导出工厂（`BACKUP_FACTORY_NAMES` 之一），`factory({ download })`，
 *       `download(filename, text)` 可选；回的对象上 `save(backup)`、`list()`、`download(index)`（名字取 `BACKUP_METHODS` 之一）。
 *       下载走 `download` 回调，或走 `document.createElement('a')` + `URL.createObjectURL(blob)` + `click()`，两种都认。
 *       `backup` 是 `src/store/docsync.ts` 的 `LocalBackup`。
 *   K11 L5 合并分发（契约第 11 节）：由 `server/asset-service.ts` 的 `assetServiceMiddleware` 处理，
 *       路径 `/api/asset/merge/<projectId>/<共享键>`（素材服务基址 `…/api/asset` 之下）。门：源文件里出现 `merge`。
 *   K12 逐帧导出续签票据（契约第 12 节）：`RENEW_FILES` 之一导出工厂（`RENEW_FACTORY_NAMES` 之一），
 *       `factory({ fetchTicket, now })`，`fetchTicket()` 回 `Promise<{ ticket, exp } | null>`（`exp` 毫秒时间戳）；
 *       回的对象 `start()`（取第一张，回 Promise）、`ticket()`（同步回当前票据）、`stop()`；按时限提前续签用全局 `setTimeout`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const repoPath = (rel) => path.join(ROOT, ...rel.split('/'));
export const repoUrl = (rel) => pathToFileURL(repoPath(rel)).href;
export const exists = (rel) => fs.existsSync(repoPath(rel));
export const MiB = 1024 * 1024;

/** 装上 `.ts` 解析钩子（K1）。重复调用无害 */
let tsHook = null;
export function useTs() {
  tsHook ??= import(repoUrl('src/testing/registerTs.mjs'));
  return tsHook;
}
export async function importRepo(rel) {
  if (rel.endsWith('.ts') || rel.endsWith('.tsx')) await useTs();
  return import(repoUrl(rel));
}

/* ------------------------------------------------------------------ 静态找导出（K1） */

const exportCache = new Map();
/** 一个源文件静态导出的名字 */
export function staticExports(rel) {
  if (exportCache.has(rel)) return exportCache.get(rel);
  let names = new Set();
  if (exists(rel)) {
    const src = fs.readFileSync(repoPath(rel), 'utf8');
    for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const seg = part.trim().replace(/^type\s+/, '');
        if (!seg) continue;
        const as = seg.split(/\s+as\s+/);
        names.add((as[1] ?? as[0]).trim());
      }
    }
  }
  exportCache.set(rel, names);
  return names;
}

/** 在一组文件里找第一个导出了候选名之一的：回 `{ file, name }` 或 null */
export function findExport(files, names) {
  for (const file of files) {
    const got = staticExports(file);
    for (const name of names) if (got.has(name)) return { file, name };
  }
  return null;
}

/** 候选名里第一个在对象上是函数的 */
export function pickMethod(obj, names) {
  for (const n of names) if (obj && typeof obj[n] === 'function') return n;
  return null;
}

/** skip 原因：什么文件、什么名字（任务书「写明原因」） */
export function missingWhat(files, names) {
  const present = files.filter(exists);
  const fileText = present.length ? `文件 ${present.join('、')} 在，但` : `文件 ${files.join('、')} 都不存在，`;
  return `${fileText}没有导出 ${names.join(' / ')} 中的任何一个`;
}
export const skipReason = (what) => `接口缺失：${what}（C10 实现未集成，集成后自动转为真跑）`;

/** 非测试的 `src/` 源文件（`.ts`、`.tsx`、`.mjs`、`.js`），缓存一次 */
let srcFilesCache = null;
export function srcSourceFiles() {
  if (srcFilesCache) return srcFilesCache;
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'testing') continue;
        walk(p);
      } else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.(mjs|ts|js)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(repoPath('src'));
  srcFilesCache = out.map((p) => ({ rel: path.relative(ROOT, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));
  return srcFilesCache;
}
/** 含这段字面文字的非测试源文件 */
export const srcFilesContaining = (needle) => srcSourceFiles().filter((f) => f.text.includes(needle)).map((f) => f.rel);

/** 一个 Promise 在限定时间里落定，不然报错（实现挂住时让用例失败而不是卡死整个文件） */
export function within(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}：${ms} ms 内没有落定（挂住了？事务的 error / abort 有没有接）`)), ms); }),
  ]);
}

/** 把一个全局替换掉（`navigator` 在 Node 里是只读的 getter，用 defineProperty），回还原函数 */
export function stubGlobal(name, value) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (saved) Object.defineProperty(globalThis, name, saved);
    else delete globalThis[name];
  };
}

/* ================================================================== K2 L2 */

export const L2_FILES = [
  'src/online/l2.ts', 'src/online/l2Store.ts', 'src/online/snapshotStore.ts', 'src/online/snapshotDb.ts',
  'src/online/pageStore.ts', 'src/online/pageCache.ts', 'src/render/l2Store.ts', 'src/render/snapshotStore.ts',
];
export const L2_OPEN_NAMES = ['openL2', 'openL2Store', 'openSnapshotStore', 'openSnapshotDb', 'openPageStore', 'createL2', 'createL2Store', 'createSnapshotStore'];
export const L2_METHODS = {
  putBlock: ['putBlock', 'putSnapshot', 'writeBlock', 'storeBlock', 'put'],
  getBlock: ['getBlock', 'getSnapshot', 'readBlock', 'loadBlock', 'get'],
  putCost: ['putCost', 'writeCost', 'setCost', 'saveCost'],
  getCost: ['getCost', 'readCost', 'loadCost'],
  putRange: ['putRange', 'markRange', 'writeRange', 'setRange', 'addRange'],
  subscribe: ['subscribeReady', 'onReady', 'subscribe', 'onRange'],
  close: ['close', 'dispose'],
};
/** 契约第 4 节 */
export const L2_TABLES = ['costs', 'ranges', 'snapshots'];
/** 软上限按环境分配（2026-10-22 起；原来按档 256 / 64 MiB）：额度的 10% 夹在 [min, max]；拿不到额度按内存（GiB × 32 MiB，夹在 64～256 MiB），都没有取 fallback */
export const L2_SOFT_LIMIT = { min: 32 * MiB, max: 1024 * MiB, fallback: 128 * MiB, memoryMin: 64 * MiB, memoryMax: 256 * MiB };
export const L2_RECLAIM = { min: 16 * MiB, max: 64 * MiB };
/** 「剩余额度的 10%」 */
export const l2Limit = ({ remaining }) => Math.min(remaining, Math.max(L2_SOFT_LIMIT.min, Math.min(L2_SOFT_LIMIT.max, 0.1 * remaining)));

export function l2Gate() {
  const hit = findExport(L2_FILES, L2_OPEN_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(L2_FILES, L2_OPEN_NAMES)) };
}

/** 打开 L2，并把方法按候选名接成统一的形状（K2） */
export async function openL2(gate, { indexedDB, deviceMemory, estimate, now = () => Date.now() }) {
  const mod = await importRepo(gate.file);
  const store = await within(mod[gate.name]({ indexedDB, deviceMemory, estimate, now }), 5000, `L2 ${gate.name}() 打开`);
  if (!store || typeof store !== 'object') throw new Error(`假设 K2：${gate.name}() 没回对象`);
  const m = {};
  for (const [k, names] of Object.entries(L2_METHODS)) m[k] = pickMethod(store, names);
  for (const k of ['putBlock', 'getBlock', 'putCost', 'getCost', 'putRange', 'subscribe']) {
    if (!m[k]) throw new Error(`假设 K2：L2 对象上找不到 ${k}（候选 ${L2_METHODS[k].join(' / ')}）；有的方法：${Object.keys(store).join(', ')}`);
  }
  const call = (k, ...args) => within(store[m[k]](...args), 5000, `L2 ${m[k]}()`);
  return {
    raw: store,
    module: mod,
    putBlock: (key, bytes, type = 'text/html') => call('putBlock', key, bytes, type),
    async getBlock(key) {
      const v = await call('getBlock', key);
      if (v === undefined || v === null) return null;
      if (v instanceof Uint8Array || v instanceof ArrayBuffer) return v;
      if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
      if (typeof v === 'object' && 'bytes' in v) return v.bytes;
      return v;
    },
    putCost: (key, rec) => call('putCost', key, rec),
    getCost: (key) => call('getCost', key),
    putRange: (layerKey, from, to) => call('putRange', layerKey, from, to),
    subscribe: (cb) => store[m.subscribe](cb),
    close: () => (m.close ? store[m.close]() : undefined),
  };
}

/** 一个 64 位十六进制的内容哈希 */
export const hashOf = (i, salt = 'a') => (salt + String(i).padStart(8, '0')).padEnd(64, '0').replace(/[^0-9a-f]/g, 'e').slice(0, 64);
export const snapKey = (i, salt) => `snap/${hashOf(i, salt)}`;

/** 值里嵌的字节类的总长度（块的字节数） */
export function bytesIn(v, depth = 0) {
  if (v === null || v === undefined || depth > 4) return 0;
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v.byteLength;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v.size;
  if (typeof v !== 'object') return 0;
  let s = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) s += bytesIn(x, depth + 1);
  return s;
}

/** 字符串认不认得出这个块：等于 `snap/<hash>`，或以 `<hash>` 结尾（库里只存哈希、或带别的前缀） */
const strMatches = (s, needle) => typeof s === 'string' && (s === needle || s.endsWith(needle.split('/').pop()));
/** 值里有没有认得出这个块的字符串 */
function hasString(v, needle, depth = 0) {
  if (typeof v === 'string') return strMatches(v, needle);
  if (!v || typeof v !== 'object' || depth > 4 || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  return (Array.isArray(v) ? v : Object.values(v)).some((x) => hasString(x, needle, depth + 1));
}
const keyMatches = (k, needle) => strMatches(k, needle) || (Array.isArray(k) && k.some((x) => keyMatches(x, needle)));

/** 桩里 L2 那个库（契约：一个库） */
export function l2DbName(factory) {
  const names = factory.dbNames();
  return names.length === 1 ? names[0] : null;
}
/** `snapshots` 表里认得出这个块的记录（K2） */
export function blockRecords(factory, key) {
  const db = l2DbName(factory);
  if (!db) return [];
  return factory.records(db, 'snapshots').filter((r) => keyMatches(r.key, key) || hasString(r.value, key));
}
/** `snapshots` 表里全部块的字节数之和 */
export function storedBlockBytes(factory) {
  const db = l2DbName(factory);
  if (!db) return 0;
  return factory.records(db, 'snapshots').reduce((s, r) => s + bytesIn(r.value), 0);
}
/** 事务日志里对某个块的写入 */
export const putsOf = (factory, key) => factory.log.flatMap((tx) => tx.ops.filter((o) => o.store === 'snapshots' && (o.op === 'put' || o.op === 'add') && keyMatches(o.key, key)).map((o) => ({ tx, op: o })));

/** 模块导出里（含一层对象）出现的全部数值 */
export function exportedNumbers(mod) {
  const out = [];
  for (const v of Object.values(mod)) {
    if (typeof v === 'number') out.push(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const x of Object.values(v)) if (typeof x === 'number') out.push(x);
  }
  return out;
}

/* ================================================================== K3 按拍换帧 */

export const BEAT_FILES = [
  'src/render/pipelinePlan.mjs', 'src/render/beatSwap.mjs', 'src/render/beatSwap.ts', 'src/editor/snapshotFeed.ts',
  'src/editor/beatSwap.ts', 'src/online/beatSwap.ts', 'src/online/beatBudget.ts', 'src/render/swapBudget.mjs',
];
export const BEAT_FIT_NAMES = ['fitBeatSwaps', 'planBeatSwaps', 'beatSwapPlan', 'fitSwaps', 'fitSwapBudget', 'swapBudget'];
export const BEAT_SWITCH_NAMES = ['setBeatSwap', 'setPerBeatSwap', 'setOnlineBeatSwap', 'setSwapEveryBeat', 'setBeatSwapMode'];
export const SWAP_MS_DEFAULT = 3;

export function beatGate() {
  const hit = findExport(BEAT_FILES, ['SWAP_MS']);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(BEAT_FILES, ['SWAP_MS'])) };
}
export function beatFitOf() {
  return findExport(BEAT_FILES, BEAT_FIT_NAMES);
}
/** 统一回 `{ swap, placeholder, deadMs? }` */
export function normalizeFit(r) {
  if (!r || typeof r !== 'object') throw new Error(`假设 K3：换帧取舍函数没回对象：${JSON.stringify(r)}`);
  const swap = r.swap ?? r.swapped ?? r.fit;
  const placeholder = r.placeholder ?? r.placeholders ?? r.over;
  if (!Array.isArray(swap) || !Array.isArray(placeholder)) throw new Error(`假设 K3：回包要有 swap / placeholder 两个数组：${JSON.stringify(r)}`);
  return { swap: [...swap], placeholder: [...placeholder], deadMs: r.deadMs };
}

/* ================================================================== K4 层表 */

export const LAYER_FILES = [
  'src/render/snapshotSource.ts', 'src/render/onlineSnapshotSource.ts', 'src/online/onlineSnapshotSource.ts',
  'src/online/layerTable.ts', 'src/online/layers.ts', 'src/render/layerTable.ts', 'src/render/layerMap.ts', 'src/online/layerMap.ts',
];
export const LAYER_REF_NAMES = ['layerRefOf', 'resolveLayer', 'usableLayer', 'layerEntryOf', 'pickLayerEntry', 'layerSourceOf'];
export function layerGate() {
  const hit = findExport(LAYER_FILES, LAYER_REF_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(LAYER_FILES, LAYER_REF_NAMES)) };
}
/**
 * 层表里的一层（K4）。集成对账（`claude/c10-integ`，2026-09-28）：按渲染节点写的真形状，即 `server/artifact-transfer.mjs` 的
 * `layerMapOf`（层表 v 2，契约第 18 节第 3 条）：每层 `{ clipId, kind: 'html' | 'local', key, tier, resultKey, dirKey, entryKey,
 * firstFrame, count, contentKey, envFingerprint }`；页面的 `parseLayerMap` 要 `kind`、`key`、`resultKey`、`firstFrame`、`count` 齐。
 */
export const layerEntry = ({ clipId, contentKey, envFingerprint, resultKey = `r-${clipId}` }) => ({
  clipId, kind: 'html', key: `k-${clipId}`, tier: 'snapshot', resultKey, dirKey: resultKey, entryKey: null,
  firstFrame: 0, count: 300, contentKey, envFingerprint,
});
/** 整张层表（K4）：`layerMapOf` 的外形，`v: 2` 与 `kind: 'layer-map'`（不认得的 `v` 或没有 `kind` 整张当没有） */
export const layerTable = (layers) => ({ v: 2, kind: 'layer-map', projectId: 'proj-c10', entryKey: null, fps: 30, span: 60, at: 0, layers });

/* ================================================================== K5 舞台 */

export const STAGE_FILES = [
  'src/online/stageOrigins.ts', 'src/online/stageConfig.ts', 'src/online/runtimeConfig.ts', 'src/online/stages.ts',
  'src/online/config.ts', 'src/editor/previewMode.ts', 'src/editor/stageOrigins.ts',
];
export const STAGE_PARSE_NAMES = ['parseStageOrigins', 'stageOriginsFromConfig', 'readStageOrigins', 'stageOriginsOf'];
export const STAGE_DECIDE_NAMES = ['stageLayout', 'chooseStageLayout', 'decideStages', 'stageLayoutOf', 'pickStageLayout'];
export function stageGate() {
  const hit = findExport(STAGE_FILES, STAGE_PARSE_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(STAGE_FILES, STAGE_PARSE_NAMES)) };
}
export function normalizeOrigins(r) {
  if (r === null || r === undefined) return null;
  if (Array.isArray(r)) return r.length === 2 ? { A: r[0], B: r[1] } : r;
  return r;
}
export function normalizeLayout(r) {
  if (r === true || r === 'dual') return 'dual';
  if (r === false || r === 'single') return 'single';
  if (r && typeof r === 'object') {
    if (r.dual === true || r.layout === 'dual' || r.mode === 'dual') return 'dual';
    if (r.dual === false || r.layout === 'single' || r.mode === 'single') return 'single';
  }
  throw new Error(`假设 K5：认不出舞台取舍的回包：${JSON.stringify(r)}`);
}

/* ================================================================== K6 发布 plan */

export const PLAN_FILES = [
  'src/online/planPublisher.ts', 'src/online/publishPlan.ts', 'src/online/plan.ts', 'src/online/planTask.ts',
  'src/editor/sync/planPublisher.ts', 'src/editor/sync/publishPlan.ts', 'src/editor/planPublisher.ts',
];
export const PLAN_FACTORY_NAMES = ['createPlanPublisher', 'planPublisher', 'createOnlinePlanPublisher', 'startPlanPublisher'];
export const PLAN_METHODS = {
  measured: ['measured', 'markMeasured', 'setMeasured', 'onMeasured', 'measureSettled'],
  changed: ['changed', 'projectChanged', 'onProjectChange', 'notifyChange', 'update'],
  dispose: ['dispose', 'stop', 'close'],
};
export function planGate() {
  const hit = findExport(PLAN_FILES, PLAN_FACTORY_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(PLAN_FILES, PLAN_FACTORY_NAMES)) };
}

/*
 * K6 集成对账（`claude/c10-integ`，2026-09-28；依据契约第 18 节第 9 条〔裁〕与 `AGENT-c10-browser.md` 的对账表）：
 *   - 页面发的是「清单计划」：`plan`，`resultKey` = `<projectId>@<projectRev>#clips:<清单签名>`（不是裸的 `<projectId>@<projectRev>`）；
 *     `parseInbound` 认得，`#clips:` 之前那一段仍是 `<projectId>@<projectRev>`。用例比结果键时比这一段（`planKeyBase`）。
 *   - 发布器要知道页面判重的片段清单：工厂参数加 `clips: () => string[]`，清单空不发。测试给一份固定的清单（`PLAN_TEST_CLIPS`）。
 *   - 发布前按渲染任务队列的协议先 `publisher.hello` 报到、等 `publisher.welcome`（`server/render-queue/queue.mjs`）。用例的假连接
 *     只模拟 `task.publish` 的回包，所以这里包一层：报到消息照常交给假连接（断着就回 false，与假连接一致），回包由这一层给
 *     `publisher.welcome`，假连接对报到的回包不往上传。`task.publish` 与它的回包原样经过，不改。
 */
export const PLAN_TEST_CLIPS = ['clip-h1', 'clip-h2'];
const CLIPS_MARK = '#clips:';
/** 结果键里 `#clips:` 之前的那一段（K6） */
export const planKeyBase = (resultKey) => (typeof resultKey === 'string' && resultKey.includes(CLIPS_MARK) ? resultKey.slice(0, resultKey.indexOf(CLIPS_MARK)) : resultKey);

/** 发布器工厂的参数（K6）：`endpoint` 包一层报到应答，另给片段清单 */
export function planFactoryDeps({ endpoint, ...rest }) {
  const handlers = [];
  const helloIds = new Set();
  endpoint.onMessage((m) => {
    if (m && m.reqId !== undefined && helloIds.has(String(m.reqId))) return; // 假连接对报到的回包不往上传
    for (const h of handlers) h(m);
  });
  const wrapped = {
    send(msg) {
      if (msg?.type !== 'publisher.hello') return endpoint.send(msg);
      if (msg.reqId !== undefined) helloIds.add(String(msg.reqId));
      if (!endpoint.send(msg)) return false;
      queueMicrotask(() => { for (const h of handlers) h({ type: 'publisher.welcome', reqId: msg.reqId, publisherId: msg.publisherId }); });
      return true;
    },
    onMessage(h) { handlers.push(h); return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); }; },
  };
  return { ...rest, endpoint: wrapped, clips: () => PLAN_TEST_CLIPS };
}

/* ================================================================== K7 / K8 C10-UI */

/** 第 17 节表 A（契约原文） */
export const TABLE_A = [
  '当前没有网络连接。',
  '连不上服务器，请稍后再试。你的修改先留在本页，恢复后会自动提交。',
  '连不上素材服务，素材原尺寸和预渲染结果暂时显示不了。',
  '已恢复连接，正在提交离线时的修改…',
  '离线时的修改已全部提交。',
  // 离线常驻提示按改动存没存下来分两句(〔裁:2026-10-22 主会话〕,原「当前离线，有未提交的修改。关闭页面将丢失这些操作。」作废)
  '当前离线。你的改动已存在本机，连上网络后会合并回项目。',
  '当前离线。你的改动只在这个页面里，关掉页面就会丢失。',
  '在线浏览器模式暂不支持',
  '，请在电脑上的 PromptCut 里使用。',
];
export const C10_UI_MARKERS = ['，请在电脑上的 PromptCut 里使用。', '当前离线。你的改动已存在本机，连上网络后会合并回项目。'];
/** 第 9 节：并入图标，不另报错 */
export const DROPPED_TEXTS = ['该模式暂不支持素材输入的音频素材效果卡', '该模式暂不支持自定义卡',
  // 2026-10-21 用户定:「无论哪种都不存在『本地PC辅助渲染』这个情况」—— 舞台图标与时间轴徽标一并撤掉
  '需要本地 PC 渲染辅助'];
export function uiGate() {
  const hits = C10_UI_MARKERS.flatMap(srcFilesContaining);
  return hits.length ? { ok: true, files: hits } : { ok: false, reason: skipReason(`src/ 的非测试源文件里没有表 A 的「${C10_UI_MARKERS.join('」或「')}」`) };
}

/* ================================================================== K9 棘轮 */

export const RATCHET_FILE = 'server/test/c10a-online-api-paths.json';
export const RATCHET_BASELINE = 'server/test/c10-api-ratchet-baseline.json';
export function ratchetGate() {
  return exists(RATCHET_FILE) ? { ok: true } : { ok: false, reason: skipReason(`${RATCHET_FILE} 不存在（C10a 的棘轮清单还在 claude/c10a-integ，没进 main）`) };
}

/* ================================================================== K10 备份 */

export const BACKUP_FILES = [
  'src/online/backups.ts', 'src/online/backup.ts', 'src/online/offlineBackup.ts', 'src/online/localBackups.ts',
  'src/editor/sync/onlineBackups.ts', 'src/editor/sync/backupDownload.ts', 'src/editor/sync/memoryBackups.ts',
];
export const BACKUP_FACTORY_NAMES = ['createOnlineBackups', 'createBackupSink', 'onlineBackupSink', 'createMemoryBackups', 'createOnlineBackupSink'];
export const BACKUP_METHODS = {
  save: ['save', 'saveBackup', 'add', 'push'],
  list: ['list', 'items', 'all', 'backups'],
  download: ['download', 'downloadBackup', 'offerDownload'],
};
export function backupGate() {
  const hit = findExport(BACKUP_FILES, BACKUP_FACTORY_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(BACKUP_FILES, BACKUP_FACTORY_NAMES)) };
}

/* ================================================================== K11 合并分发 */

export function mergeGate() {
  const src = exists('server/asset-service.ts') ? fs.readFileSync(repoPath('server/asset-service.ts'), 'utf8') : '';
  return /\bmerge\b/.test(src) ? { ok: true } : { ok: false, reason: skipReason('server/asset-service.ts 里没有出现 merge 路由') };
}
export const MERGE_PATH = (projectId, key) => `/api/asset/merge/${projectId}/${key}`;

/* ================================================================== K12 续签 */

export const RENEW_FILES = [
  'src/export/ticketRenewal.ts', 'src/export/tickets.ts', 'src/export/renewTicket.ts', 'src/export/ticketRenewer.ts',
  'src/online/ticketRenewal.ts', 'src/online/tickets.ts', 'src/online/ticketRenewer.ts', 'src/export/originals.ts',
];
export const RENEW_FACTORY_NAMES = ['createTicketRenewer', 'keepTicketFresh', 'createTicketKeeper', 'renewingTicket'];
export const RENEW_METHODS = {
  start: ['start', 'ready', 'init'],
  ticket: ['ticket', 'current', 'get'],
  stop: ['stop', 'dispose', 'close'],
};
export function renewGate() {
  const hit = findExport(RENEW_FILES, RENEW_FACTORY_NAMES);
  return hit ? { ok: true, ...hit } : { ok: false, reason: skipReason(missingWhat(RENEW_FILES, RENEW_FACTORY_NAMES)) };
}
