/**
 * 带宽闸:素材上传队列(`upload-queue.mjs`)与预渲染产物的推送队列(`artifact-push.mjs`,C6.4 的 A5)共用
 * (`docs/plan/c66-design.md` 第 3 节:「共用一个带宽闸,素材排在产物后面」)。
 *
 * 规则只有一条:**产物优先,素材让路**。
 *   - 产物(`beginArtifact`)从不等:推送队列照原来的并发推,只在闸上登记「我在推」;
 *   - 产物的需求(`artifactDemand(provider)`):推送队列登记一个函数,回「还有几段等着推」(不算在退避里的);
 *   - 素材(`acquireMedia`)按片取闸:同时只放一片;产物在推、产物还有需求、或跨进程探针说忙,都等。
 *     所以素材最多比产物多占一片(8 MiB)的时间,之后就让出来。
 *
 * 跨进程:推送队列跑在预渲染进程里,上传队列跑在编辑器进程里,两边的闸不是同一个对象。编辑器那一侧给
 * `external` 一个探针(`pushQueueFileProbe`):读推送队列落盘的 `push-queue.json`,有新近写过、还没失败过的段
 * 就算忙。两者同在一个进程时(单测、将来合并进程)直接共用 `sharedBandwidthGate()`,探针可以不给。
 *
 * 只用 Node 内置模块。
 */
import fsSync from 'node:fs';

const GATE_KEY = Symbol.for('promptcut.bandwidth-gate');

/**
 * @param {object} [options]
 * @param {(() => boolean | Promise<boolean>) | null} [options.external]  跨进程的「产物还在推」探针
 * @param {number} [options.pollMs]  素材在等时多久再看一次(探针与需求函数没有通知,只能轮询),缺省 250
 */
export function createBandwidthGate({ external = null, pollMs = 250 } = {}) {
  let artifactActive = 0;
  let mediaActive = 0;
  const providers = new Set();
  /** 在等的素材:{ wake } */
  const waiters = new Set();
  let externalFn = typeof external === 'function' ? external : null;

  const demand = () => {
    let n = 0;
    for (const fn of providers) {
      try { n += Math.max(0, Number(fn()) || 0); } catch { /* 需求函数出错当 0 */ }
    }
    return n;
  };
  const wakeAll = () => { for (const w of waiters) w.wake(); };

  async function externalBusy() {
    if (!externalFn) return false;
    try { return (await externalFn()) === true; } catch { return false; }
  }

  return {
    /** 产物开始推一段;回的函数在推完时调。从不等 */
    beginArtifact() {
      artifactActive++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        artifactActive--;
        wakeAll();
      };
    },
    /** 登记产物的需求函数(回还有几段等着推);回注销函数 */
    artifactDemand(provider) {
      if (typeof provider !== 'function') return () => {};
      providers.add(provider);
      return () => { providers.delete(provider); wakeAll(); };
    },
    /** 换跨进程探针(null 去掉) */
    setExternal(fn) { externalFn = typeof fn === 'function' ? fn : null; wakeAll(); },
    /**
     * 素材取一片的闸。回 release 函数;`signal` 中止时抛 `AbortError`。
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<() => void>}
     */
    async acquireMedia({ signal } = {}) {
      for (;;) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (mediaActive === 0 && artifactActive === 0 && demand() === 0 && !(await externalBusy())
          && mediaActive === 0 && artifactActive === 0) {
          mediaActive++;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            mediaActive--;
            wakeAll();
          };
        }
        await new Promise((resolve) => {
          const w = { wake: () => { clearTimeout(timer); waiters.delete(w); signal?.removeEventListener?.('abort', w.wake); resolve(); } };
          const timer = setTimeout(w.wake, pollMs);
          timer.unref?.();
          waiters.add(w);
          signal?.addEventListener?.('abort', w.wake, { once: true });
        });
      }
    },
    state() {
      return { artifactActive, artifactDemand: demand(), mediaActive, mediaWaiting: waiters.size, external: !!externalFn };
    },
  };
}

/** 本进程共用的那一个闸(推送队列与上传队列都缺省取它) */
export function sharedBandwidthGate() {
  const holder = /** @type {any} */ (globalThis);
  holder[GATE_KEY] ??= createBandwidthGate();
  return holder[GATE_KEY];
}

/**
 * 跨进程探针:读预渲染进程推送队列的 `push-queue.json`(`artifact-push.mjs` 每次进队、完成、失败都写回)。
 * 文件在 `staleMs` 内写过、且里面有没失败过的段(`attempts === 0`)就算忙。失败过的段在退避里,不挡素材;
 * 文件久未更新(推送队列没建、进程早退了留下的旧文件)也不挡。读的结果缓存 `cacheMs`。
 * @param {string} file
 * @param {{ staleMs?: number, cacheMs?: number, now?: () => number }} [options]
 */
export function pushQueueFileProbe(file, { staleMs = 120_000, cacheMs = 1000, now = Date.now } = {}) {
  let cached = null;
  return () => {
    const t = now();
    if (cached && t - cached.at < cacheMs) return cached.busy;
    let busy = false;
    try {
      const stat = fsSync.statSync(file);
      if (t - stat.mtimeMs <= staleMs) {
        const saved = JSON.parse(fsSync.readFileSync(file, 'utf8'));
        busy = Array.isArray(saved?.items) && saved.items.some((item) => !(Number(item?.attempts) > 0));
      }
    } catch { busy = false; }
    cached = { at: t, busy };
    return busy;
  };
}
