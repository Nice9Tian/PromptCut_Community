/**
 * 预渲染产物的无条件推送队列(C6.4,`docs/plan/manifest-contract.md` 第 4 节;`cloud-task.md` A3b、A5)。
 *
 * 本机预渲染进程自己产的产物 —— 不经渲染任务队列的那些也算 —— 按段(与队列细任务的切分一一对应)
 * 排进这里,在后台推到素材服务,再把这一段的清单写进文档服务的内容库。别的机器按键查得到清单、
 * 按哈希拉块,不用重新预渲染(换机取用,第 5 节)。
 *
 *   进队:`enqueue(unit, priority)`。`unit = { kind: 'snapshot' | 'stream', tier?, resultKey, dirKey?, entryKey?, range, canvasHeavy? }`;
 *         同一段(`<kind>:<resultKey>:<from>-<to>`)已经在队里就不重复,只合并优先级;正在推的那一段又进队,
 *         推完再推一遍(推的时候读的是旧的帧库,新写的帧要补上)。
 *   优先级:数字越小越先推 —— 0 `normal`、1 `low`、2 `lowest`。卡级(调用方给的 `priority`,以及这一段自己看得出的:
 *         流、本地档、`canvasHeavy` 一律至少 1)与块级(这一段 `data:image` 字节过半 → 1;有超体积帧 → 2)取低的那个。
 *         块级在这一段轮到之前读帧库算(`index.json` 的 `oversize`,帧文件的 `data:image` 占比)。
 *   执行:并发 `concurrency` 段;每段 `collect*` → `pushResult` → `content.put` 清单。失败的段按指数退避重试
 *         (5 s、30 s、120 s,之后每 10 min),不放弃。清单超过 256 KiB 的段永远写不进内容库,记日志后丢掉。
 *         段的键目录已不在帧库里(按上限淘汰或「清理缓存」删了,`frame-library-storage.mjs`)的,推之前、推空了、
 *         推失败时各判一次,不在就丢掉、记 `push.evicted`,不重试(存储占用计划 `docs/plan/storage-plan.md`)。
 *   落盘:`<dir>/push-queue.json`(`dir` 是帧库根),每次进队、完成时经 `atomic` 写回;重启时读回接着推;
 *         已完成的段不留在文件里。
 *
 * 推送在后台跑,预渲染的每一帧不等它;这里不开 Chrome、不渲染。素材服务客户端(`createAssetClient`)和
 * 内容库客户端(`createContentClient`)都由调用方传进来。
 */
import fsSync from 'node:fs';
import path from 'node:path';
import { atomic } from './frame-mov.mjs';
import { rangeHas } from './snapshot-store.mjs';
import { collectSnapshotResult, collectStreamResult, pushResult, manifestKindOf, manifestKeyOf, assertResultSize, layerMapKeyOf, mergedForWrite } from './artifact-transfer.mjs';
import { sharedBandwidthGate } from './bandwidth-gate.mjs';

/** 优先级:数字越小越先推 */
export const PUSH_PRIORITY = Object.freeze({ normal: 0, low: 1, lowest: 2 });
const PRIORITY_NAMES = ['normal', 'low', 'lowest'];
/** 失败后的退避:第 1、2、3 次失败后等 5 s、30 s、120 s,之后每次 10 min */
export const PUSH_BACKOFF_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]);
/** 判不了范围、先扣在内存里的段最多这么多(满了丢最早的) */
export const PUSH_DEFERRED_MAX = 5000;
/** 队列文件名(在帧库根下) */
export const PUSH_QUEUE_FILE = 'push-queue.json';
const FILE_VERSION = 1;

const KEY_RE = /^[a-f0-9]{64}$/;
const SAFE_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const safeKey = value => typeof value === 'string' && SAFE_KEY_RE.test(value) && value !== '.' && value !== '..';

/**
 * 一段 HTML 里 `data:image` 占了多少字节。算法照抄 `scripts/probes/snapshot-size-probe.mjs` 的 `dataImageBytes`
 * (按匹配串的长度计;这些串全是 ASCII,长度就是字节数)。不引用探针。
 */
const DATA_IMG = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
export const dataImageBytes = s => { let n = 0; for (const m of (s || '').match(DATA_IMG) || []) n += m.length; return n; };

/** `'normal' | 'low' | 'lowest' | 0 | 1 | 2` → 0～2;认不出的当 0 */
export function priorityOf(value) {
  if (typeof value === 'string') {
    const at = PRIORITY_NAMES.indexOf(value);
    return at >= 0 ? at : 0;
  }
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0;
}

/** 段的标识:与渲染任务 id 同形(`<kind>:<resultKey>:<from>-<to>`) */
export function unitId(unit) {
  return `${unit.kind}:${unit.resultKey}:${unit.range.from}-${unit.range.to}`;
}

/** 校验并整理一段;不合格回 null(不猜) */
export function normalizeUnit(unit) {
  if (!unit || typeof unit !== 'object') return null;
  const { kind, resultKey } = unit;
  const from = unit.range?.from, to = unit.range?.to;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  if (kind === 'stream') {
    if (!KEY_RE.test(String(resultKey))) return null;
    return { kind, resultKey, range: { from, to } };
  }
  if (kind !== 'snapshot' || !safeKey(resultKey)) return null;
  const tier = unit.tier ?? 'shared';
  if (tier === 'shared') {
    const dirKey = unit.dirKey ?? resultKey;
    if (!safeKey(dirKey)) return null;
    return { kind, tier, resultKey, dirKey, entryKey: null, range: { from, to }, canvasHeavy: unit.canvasHeavy === true };
  }
  if (tier !== 'local' || !safeKey(unit.dirKey) || !safeKey(unit.entryKey)) return null;
  return { kind, tier, resultKey, dirKey: unit.dirKey, entryKey: unit.entryKey, range: { from, to }, canvasHeavy: unit.canvasHeavy === true };
}

/** 这一段自己看得出的卡级下限:流、本地档、`canvasHeavy` 至少 `low`(A5;流一律按 1) */
function unitFloor(unit) {
  if (unit.kind === 'stream') return PUSH_PRIORITY.low;
  if (unit.tier === 'local' || unit.canvasHeavy) return PUSH_PRIORITY.low;
  return PUSH_PRIORITY.normal;
}

/**
 * 块级优先级(A3b):有超体积帧 → 2;`data:image` 字节占全部 HTML 字节一半以上 → 1;否则 0。
 * 只看快照;流回 0(流的卡级已经是 1)。读不到当 0,不挡推送。
 */
export async function blockPriorityOf(pipeline, unit) {
  if (unit.kind !== 'snapshot') return PUSH_PRIORITY.normal;
  const store = pipeline.snapshots();
  const target = { tier: unit.tier, entryKey: unit.tier === 'local' ? unit.entryKey : undefined, key: unit.dirKey };
  const index = await store.snapshotIndex(target);
  const { from, to } = unit.range;
  for (let f = from; f <= to; f++) if (rangeHas(index.oversize, f)) return PUSH_PRIORITY.lowest;
  let total = 0, images = 0;
  for (let f = from; f <= to; f++) {
    if (!rangeHas(index.frames, f)) continue;
    const html = await store.readSnapshot({ ...target, localFrame: f });
    if (html === null) continue;
    total += Buffer.byteLength(html, 'utf8');
    images += dataImageBytes(html);
  }
  return total > 0 && images * 2 > total ? PUSH_PRIORITY.low : PUSH_PRIORITY.normal;
}

/**
 * 这一段在帧库里的键目录:快照 = `snapshots().dir(...)`(共享档 `controls-html/<dirKey>`、本地档
 * `controls-local/<entryKey>/<dirKey>`);流 = `<帧库>/streams/<resultKey>`。算不出回 null(不判,当它在)。
 */
export function unitDirOf(pipeline, unit) {
  try {
    if (unit.kind === 'stream') return typeof pipeline?.root === 'string' && pipeline.root ? path.join(pipeline.root, 'streams', unit.resultKey) : null;
    const dir = pipeline?.snapshots?.()?.dir?.({ tier: unit.tier, entryKey: unit.tier === 'local' ? unit.entryKey : undefined, key: unit.dirKey });
    return typeof dir === 'string' && dir ? dir : null;
  } catch { return null; }
}

/**
 * 这一段的键目录是不是已经不在了(帧库按上限淘汰、或「清理缓存」删掉了它,`frame-library-storage.mjs`)。
 * 只有确实 ENOENT 才算不在;别的错(没权限、被占)不算,照常重试。
 */
export async function unitEvicted(pipeline, unit) {
  const dir = unitDirOf(pipeline, unit);
  if (!dir) return false;
  try { await fsSync.promises.lstat(dir); return false; }
  catch (error) { return error?.code === 'ENOENT'; }
}

/**
 * @param {object} options
 * @param {any} options.pipeline  `FramePipeline`(用它的帧库 `snapshots()` 与 `root`)
 * @param {any} options.client  素材服务客户端(`put` / `has` / `get`)
 * @param {any} [options.content]  内容库客户端(`put` / `get` / `list`);不给就只推块、不写清单
 * @param {string} [options.dir]  队列文件所在目录,缺省帧库根 `pipeline.root`
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.concurrency]  同时推几段,缺省 2
 * @param {number[]} [options.backoff]  退避表,缺省 `PUSH_BACKOFF_MS`(最后一项一直沿用)
 * @param {number} [options.settleMs]  一段最后一次进队后静置多久才推,缺省 0(接线里给正值,免得边渲边推)
 * @param {{ now?: () => number, setTimeout?: Function, clearTimeout?: Function }} [options.clock]  注入时钟(测试)
 * @param {() => number} [options.now]  同 `clock.now`
 * @param {Function} [options.setTimeout]  同 `clock.setTimeout`
 * @param {Function} [options.clearTimeout]  同 `clock.clearTimeout`
 * @param {boolean} [options.attach]  建好后挂到 `pipeline.pushQueue`(管线的钩子只认这一个),缺省 true
 * @param {any} [options.gate]  带宽闸(C6.6,`bandwidth-gate.mjs`),缺省本进程共用的那一个;`false` 不接。
 *        产物从不等闸,只登记「在推」与「还有几段等着推」,让素材上传队列排在后面
 * @param {{ accepts(unit: object): boolean | null, acceptsProject(projectId: string): boolean | null, describe?(): any } | null} [options.scope]
 *        只推绑定项目的(`push-scope.mjs`):进队时判这一段属不属于绑定项目,不属于的不进队(留在本机);
 *        判不了(null,绑定项目的文档 id 还没到)的先扣在内存里,`rescope()` 时再判(最多扣 `PUSH_DEFERRED_MAX` 段)。
 *        层表同样按项目 id 判。不给 = 不限(原来的行为)。重启时从队列文件读回的段不再判(文件按项目分目录)
 */
export function createPushQueue({
  pipeline, client, content = null, dir, log = () => {}, concurrency = 2,
  backoff = PUSH_BACKOFF_MS, settleMs = 0, clock = null,
  now: nowOpt, setTimeout: setTimeoutOpt, clearTimeout: clearTimeoutOpt, attach = true, gate: gateOpt, scope = null,
} = /** @type {any} */ ({})) {
  if (!pipeline) throw new TypeError('createPushQueue needs a pipeline');
  if (!client || typeof client.put !== 'function') throw new TypeError('createPushQueue needs an asset client');
  const now = nowOpt ?? clock?.now ?? (() => Date.now());
  const setTimer = setTimeoutOpt ?? clock?.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = clearTimeoutOpt ?? clock?.clearTimeout ?? (handle => globalThis.clearTimeout(handle));
  const lanes = Math.max(1, Math.floor(Number(concurrency) || 1));
  const delays = Array.isArray(backoff) && backoff.length ? backoff.map(ms => Math.max(0, Number(ms) || 0)) : [...PUSH_BACKOFF_MS];
  const settle = Math.max(0, Number(settleMs) || 0);
  const root = dir ?? pipeline.root;
  const file = typeof root === 'string' && root ? path.join(root, PUSH_QUEUE_FILE) : null;
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志出错不影响推送 */ } };

  /** id → item。item = { id, unit, priority(卡级), block(块级,null = 还没算), seq, attempts, nextAt, readyAt, inflight, again } */
  const items = new Map();
  let seq = 0;
  let running = false;
  let stopped = false;
  let timer = null;
  let timerAt = Infinity;
  let pumping = false;
  let pumpAgain = false;
  let pumpQueued = false;
  const inflight = new Set();
  const waiters = [];
  const counters = { enqueued: 0, merged: 0, pushed: 0, failures: 0, uploaded: 0, skipped: 0, manifests: 0, dropped: 0, restored: 0, layerMaps: 0,
    outOfScope: 0, layerMapsOutOfScope: 0, deferredDropped: 0, evicted: 0 };
  /** 判不了范围、先扣着的段:id → { unit, priority }(只在内存里;按进队先后,满了丢最早的) */
  const deferred = new Map();
  /** 范围判定:true 进队、false 不进、null 扣着;没给 scope 一律 true */
  const judge = unit => {
    if (!scope || typeof scope.accepts !== 'function') return true;
    try { const v = scope.accepts(unit); return v === true ? true : v === false ? false : null; } catch { return false; }
  };
  let outOfScopeLogged = 0;
  const noteOutOfScope = unit => {
    counters.outOfScope++;
    // 别的项目边渲边写,每批都会来一次:只记前几条和之后每 500 条一条
    if (outOfScopeLogged < 3 || counters.outOfScope % 500 === 0) {
      outOfScopeLogged++;
      say('push.out-of-scope', { id: unitId(unit), count: counters.outOfScope });
    }
  };
  let lastError = null;

  const effective = item => Math.max(item.priority, unitFloor(item.unit), item.block ?? 0);

  // 带宽闸(C6.6):登记「还有几段等着推」—— 在推的、等着轮到的、静置中的都算,退避中的不算(失败的段不挡素材)
  const gate = gateOpt === false ? null : (gateOpt ?? sharedBandwidthGate());
  let unregisterDemand = () => {};

  /* ---------------- 落盘 ---------------- */

  /**
   * 写回串成一条链(契约第 9 节第 1 条):`pending` 是排在链尾、还没开始的那次写入 —— 它开始时才取队列的快照,
   * 所以在它开始之前的所有改动都由它一并写下,这期间调 `persist()` 的都拿到它。已经开始的写入不再收新改动,
   * 之后的改动另排一次。于是每次 `persist()` 回的 promise 都在「包含了调用那一刻状态」的写入完成后才兑现。
   */
  let chain = Promise.resolve();
  let pending = null;
  const snapshotFile = () => JSON.stringify({
    v: FILE_VERSION,
    items: [...items.values()].sort((a, b) => a.seq - b.seq).map(item => ({ unit: item.unit, priority: item.priority, attempts: item.attempts })),
  });
  const persist = () => {
    if (!file) return Promise.resolve();
    if (pending) return pending;
    const write = chain.then(async () => {
      if (pending === write) pending = null;
      // 快照在这里(写入开始时)同步取,之后的改动归下一次写入
      try { await atomic(file, snapshotFile()); }
      catch (error) { say('push.persist-failed', { message: String(error?.message ?? error) }); }
    });
    pending = write;
    chain = write;
    return write;
  };

  const restore = () => {
    if (!file) return;
    let saved = null;
    try { saved = JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return; }
    if (!saved || saved.v !== FILE_VERSION || !Array.isArray(saved.items)) return;
    for (const record of saved.items) {
      const unit = normalizeUnit(record?.unit);
      if (!unit) continue;
      const id = unitId(unit);
      if (items.has(id)) continue;
      items.set(id, { id, unit, priority: priorityOf(record.priority), block: null, seq: seq++, attempts: Math.max(0, Math.floor(Number(record.attempts) || 0)),
        nextAt: 0, readyAt: 0, inflight: false, again: false });
      counters.restored++;
    }
  };
  restore();

  /* ---------------- 调度 ---------------- */

  const settleWaiters = () => {
    if (items.size) return;
    for (const resolve of waiters.splice(0)) resolve();
  };

  const schedule = () => {
    if (!running || pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(() => { pumpQueued = false; void pump(); });
  };

  const armTimer = () => {
    if (!running) return;
    let next = Infinity;
    for (const item of items.values()) {
      if (item.inflight) continue;
      const at = Math.max(item.nextAt, item.readyAt);
      if (at < next) next = at;
    }
    const t = now();
    if (next === Infinity || next <= t) {
      if (timer !== null) { clearTimer(timer); timer = null; timerAt = Infinity; }
      return;
    }
    if (timer !== null && timerAt === next) return;
    if (timer !== null) clearTimer(timer);
    timerAt = next;
    timer = setTimer(() => { timer = null; timerAt = Infinity; schedule(); }, next - t);
    timer?.unref?.();
  };

  const eligible = (item, t) => !item.inflight && item.nextAt <= t && item.readyAt <= t;

  async function pump() {
    if (!running) return;
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        // 块级优先级在这一段轮到之前算(读帧库);算过的不再算,直到它再进队
        for (const item of [...items.values()]) {
          if (!running) return;
          if (item.block !== null || !eligible(item, now())) continue;
          try { item.block = await blockPriorityOf(pipeline, item.unit); }
          catch { item.block = PUSH_PRIORITY.normal; }
        }
        while (running && inflight.size < lanes) {
          const t = now();
          let best = null;
          for (const item of items.values()) {
            if (!eligible(item, t) || item.block === null) continue;
            if (!best || effective(item) < effective(best) || (effective(item) === effective(best) && item.seq < best.seq)) best = item;
          }
          if (!best) break;
          run(best);
        }
      } while (pumpAgain && running);
    } finally {
      pumping = false;
      armTimer();
    }
  }

  function run(item) {
    item.inflight = true;
    item.again = false;
    const endGate = gate ? gate.beginArtifact() : () => {};
    const work = pushOne(item).finally(() => {
      endGate();
      inflight.delete(work);
      item.inflight = false;
      schedule();
    });
    inflight.add(work);
  }

  /**
   * 键目录被淘汰了:这一段在本机已经没有可推的,丢掉、不重试,也不挡队里别的段。日志只记前几条和之后每 100 条一条
   * (一次淘汰可能带走很多段)。
   */
  let evictedLogged = 0;
  function dropEvicted(item) {
    counters.evicted++;
    if (evictedLogged < 3 || counters.evicted % 100 === 0) {
      evictedLogged++;
      say('push.evicted', { id: item.id, count: counters.evicted });
    }
    finish(item, { dropped: true });
  }

  async function pushOne(item) {
    const { unit } = item;
    const priority = PRIORITY_NAMES[effective(item)];
    if (await unitEvicted(pipeline, unit)) { dropEvicted(item); return; }
    try {
      const task = { kind: unit.kind, tier: unit.tier, resultKey: unit.resultKey, range: unit.range, input: { canvasHeavy: unit.canvasHeavy === true } };
      const collected = unit.kind === 'snapshot'
        ? await collectSnapshotResult(pipeline, task, { location: { tier: unit.tier, entryKey: unit.entryKey, dirKey: unit.dirKey }, canvasHeavy: unit.canvasHeavy === true })
        : await collectStreamResult(pipeline, task);
      const { result } = collected;
      const empty = result.kind === 'snapshot' ? !result.frames.length : !Object.keys(result.segments ?? {}).length;
      if (empty) {
        // 帧库里这一段什么都没有(被清掉了,或者进队的只是超出实际长度的空段):没有可推的,不写空清单
        if (await unitEvicted(pipeline, unit)) { dropEvicted(item); return; }
        finish(item, { dropped: true });
        say('push.empty', { id: item.id });
        return;
      }
      const pushed = await pushResult(client, result, collected.readBlob);
      counters.uploaded += pushed.uploaded;
      counters.skipped += pushed.skipped;
      if (content && typeof content.put === 'function') {
        assertResultSize(result);
        // 流清单先和内容库里已有的那一份合并(不降级:别的节点补过的满密度分段、本机还没产到的分段都留着)
        await content.put(manifestKindOf(result.kind), manifestKeyOf(result), await mergedForWrite(content, result));
        counters.manifests++;
      }
      counters.pushed++;
      say('push.done', { id: item.id, priority, uploaded: pushed.uploaded, skipped: pushed.skipped });
      finish(item, {});
    } catch (error) {
      const code = error?.code ?? error?.reason ?? null;
      lastError = { id: item.id, code, message: String(error?.message ?? error), at: now() };
      if (code === 'result-too-large' || code === 'too-large') {
        // 永远写不进内容库(第 1 节),重试也没用
        say('push.too-large', { id: item.id, bytes: error?.bytes ?? null });
        counters.dropped++;
        finish(item, { dropped: true });
        return;
      }
      // 推到一半键目录被淘汰(文件读不到、流清单没了):丢掉,不按失败无限重试
      if (await unitEvicted(pipeline, unit)) { dropEvicted(item); return; }
      counters.failures++;
      item.attempts++;
      const delay = delays[Math.min(item.attempts - 1, delays.length - 1)];
      item.nextAt = now() + delay;
      say('push.retry', { id: item.id, attempts: item.attempts, delayMs: delay, code, message: lastError.message });
      void persist();
    }
  }

  /** 一段推完(或丢掉):推的时候又进过队就留着再推一遍,否则出队 */
  function finish(item, { dropped = false } = {}) {
    if (item.again && !dropped) {
      item.again = false;
      item.attempts = 0;
      item.nextAt = 0;
      item.block = null;
    } else {
      items.delete(item.id);
    }
    void persist();
    settleWaiters();
  }

  /* ---------------- c10a 第 9 节:给在线页面的层表 ---------------- */

  /**
   * 最新的一份层表(`artifact-transfer.mjs` 的 `layerMapOf`),后写的赢:攒 300 ms 再写,失败按同一张退避表重试,
   * 期间来了更新的就只写更新的。和段清单同类(`snapshot-manifest`),键 `layers:<项目 id>`。内容相同(不算 `at`)就不重写。
   */
  let layerMap = null;
  let layerMapTimer = null;
  let layerMapAttempts = 0;
  let layerMapWritten = '';
  let layerMapFlying = false;
  const layerMapSig = body => { try { const { at, ...rest } = body; void at; return JSON.stringify(rest); } catch { return ''; } };
  const armLayerMap = ms => {
    if (layerMapTimer !== null) clearTimer(layerMapTimer);
    layerMapTimer = setTimer(() => { layerMapTimer = null; void flushLayerMap(); }, ms);
    layerMapTimer?.unref?.();
  };
  async function flushLayerMap() {
    if (layerMapFlying || !layerMap || stopped) return;
    const job = layerMap;
    const sig = `${job.key}
${layerMapSig(job.body)}`;
    if (sig === layerMapWritten) { if (layerMap === job) layerMap = null; return; }
    layerMapFlying = true;
    try {
      await content.put('snapshot-manifest', job.key, job.body);
      layerMapWritten = sig;
      layerMapAttempts = 0;
      counters.layerMaps++;
      if (layerMap === job) layerMap = null;
      say('push.layer-map', { key: job.key, layers: job.body?.layers?.length ?? 0 });
    } catch (error) {
      layerMapAttempts++;
      say('push.layer-map-retry', { key: job.key, attempts: layerMapAttempts, message: String(error?.message ?? error) });
      if (layerMap === job) armLayerMap(delays[Math.min(layerMapAttempts - 1, delays.length - 1)]);
    } finally {
      layerMapFlying = false;
      if (layerMap && layerMap !== job) armLayerMap(0);
    }
  }

  /* ---------------- 对外 ---------------- */

  const queue = {
    get client() { return client; },
    get content() { return content; },
    get file() { return file; },
    /**
     * 进队(契约第 9 节第 1 条)。进队本身同步生效(同一段已在队里就只合并优先级);回的 promise 在
     * 包含这一次进队的队列文件写回完成后才兑现。钩子里不 `await` 它;测试和要确认落盘的调用方 `await`。
     * 不合格的段不进队,回一个已兑现的 promise(记日志)。
     * @returns {Promise<void>}
     */
    enqueue(unit, priority = PUSH_PRIORITY.normal) {
      const normalized = normalizeUnit(unit);
      if (!normalized) { say('push.bad-unit', { unit: unit ?? null }); return Promise.resolve(); }
      const id = unitId(normalized);
      const level = priorityOf(priority);
      // 只推绑定项目的:已经在队里的段不再判(进队时判过);不在队里的先判范围
      if (!items.has(id)) {
        const verdict = judge(normalized);
        if (verdict === false) { deferred.delete(id); noteOutOfScope(normalized); return Promise.resolve(); }
        if (verdict === null) {
          const held = deferred.get(id);
          deferred.delete(id);
          deferred.set(id, { unit: held?.unit.canvasHeavy && normalized.kind === 'snapshot' ? { ...normalized, canvasHeavy: true } : normalized,
            priority: Math.max(level, held?.priority ?? 0) });
          while (deferred.size > PUSH_DEFERRED_MAX) { deferred.delete(deferred.keys().next().value); counters.deferredDropped++; }
          return Promise.resolve();
        }
        deferred.delete(id);
      }
      const t = now();
      const existing = items.get(id);
      if (existing) {
        existing.priority = Math.max(existing.priority, level);
        if (normalized.kind === 'snapshot' && normalized.canvasHeavy) existing.unit.canvasHeavy = true;
        existing.readyAt = settle ? t + settle : 0;
        existing.block = null;
        if (existing.inflight) existing.again = true;
        counters.merged++;
        const saved = persist();
        schedule();
        return saved;
      }
      items.set(id, { id, unit: normalized, priority: level, block: null, seq: seq++, attempts: 0, nextAt: 0, readyAt: settle ? t + settle : 0, inflight: false, again: false });
      counters.enqueued++;
      const saved = persist();
      schedule();
      return saved;
    },
    start() {
      if (running) return;
      running = true;
      stopped = false;
      if (gate) {
        unregisterDemand();
        unregisterDemand = gate.artifactDemand(() => {
          const t = now();
          let n = 0;
          for (const item of items.values()) if (item.inflight || item.nextAt <= t) n++;
          return n;
        });
      }
      schedule();
    },
    /**
     * 停止派新活,等队列文件写完就返回。**不等在推的段**:它们可能卡在网络上(W4 就是在推的段卡住时停),
     * 它们之后自己收尾 —— 成功就出队、失败就留在文件里,都照常写回;不再派下一段。
     * 队里没推完的段留在文件里,下次重建时接着推。
     */
    async stop() {
      running = false;
      stopped = true;
      unregisterDemand();
      unregisterDemand = () => {};
      if (timer !== null) { clearTimer(timer); timer = null; timerAt = Infinity; }
      if (layerMapTimer !== null) { clearTimer(layerMapTimer); layerMapTimer = null; }
      await persist();
      for (const resolve of waiters.splice(0)) resolve();
    },
    /**
     * c10a 第 9 节:写一份层表(后写的赢,攒 300 ms;见上)。没给内容库、项目没有 id 回 false。
     * @returns {boolean}
     */
    putLayerMap(projectId, body) {
      const key = layerMapKeyOf(projectId);
      if (!content || typeof content.put !== 'function' || !key || !body) return false;
      // 只写绑定项目的层表(判不了的也不写:知道项目文档 id 之后补推时会再写一次)
      if (scope && typeof scope.acceptsProject === 'function') {
        let v = null;
        try { v = scope.acceptsProject(projectId); } catch { v = false; }
        if (v !== true) { counters.layerMapsOutOfScope++; return false; }
      }
      layerMap = { key, body };
      armLayerMap(300);
      return true;
    },
    /** 立即重排一次(测试或调用方拨快了时钟之后用) */
    poke() { schedule(); },
    /**
     * 扣着的段再判一次范围(绑定项目的文档 id 到了之后调):属于的进队,不属于的丢掉,仍判不了的继续扣着。
     * 回 `{ queued, dropped, held }`。
     */
    rescope() {
      let queued = 0, dropped = 0;
      for (const [id, held] of [...deferred]) {
        const verdict = judge(held.unit);
        if (verdict === null) continue;
        deferred.delete(id);
        if (verdict === false) { dropped++; noteOutOfScope(held.unit); continue; }
        void queue.enqueue(held.unit, held.priority);
        queued++;
      }
      if (queued || dropped) say('push.rescope', { queued, dropped, held: deferred.size });
      return { queued, dropped, held: deferred.size };
    },
    /** 等队列空(全部推完或丢掉);已停止的队列立即返回 */
    drain() {
      if (!items.size || stopped) return Promise.resolve();
      return new Promise(resolve => waiters.push(resolve));
    },
    stats() {
      const byPriority = { normal: 0, low: 0, lowest: 0 };
      let backingOff = 0;
      const t = now();
      for (const item of items.values()) {
        byPriority[PRIORITY_NAMES[effective(item)]]++;
        if (!item.inflight && item.nextAt > t) backingOff++;
      }
      return { running, pending: items.size - inflight.size, inflight: inflight.size, backingOff, byPriority, ...counters, deferred: deferred.size, lastError,
        scope: scope && typeof scope.describe === 'function' ? scope.describe() : null,
        items: [...items.values()].sort((a, b) => a.seq - b.seq).map(item => ({ id: item.id, priority: PRIORITY_NAMES[effective(item)], attempts: item.attempts, inflight: item.inflight })) };
    },
  };
  if (attach !== false) pipeline.pushQueue = queue;
  return queue;
}
