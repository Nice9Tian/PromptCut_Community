import fs from 'node:fs/promises';
import path from 'node:path';
import { atomic } from './frame-mov.mjs';

/**
 * 本机的卡片级指纹锁(契约 F.3;语义 `mechanism/rendering.md`「不同环境的结果不混用」「预渲染结果的复用」)。
 *
 * 本机只锁**共享档快照**这一种结果,锁键就是卡的内容键 `control.contentKey`(64 位小写十六进制)。
 * 同一把锁下只有一个环境的结果被产出、投递:页面的测量帧(用户浏览器的指纹)和本机预渲染进程
 * (SwiftShader 的指纹)谁先为这张卡产出,这张卡就锁在谁的环境上;另一方要么直接投递锁定方的结果,
 * 要么等锁定方闲置够久后用自己的指纹**接手**整张卡。
 *
 * 本地档、轨道流、独立卡 PNG 缓存本机只有预渲染进程一个产出者,不加锁。
 *
 * # 锁库
 *
 * 目录 `<库根>/controls-lock/`,一把锁一个文件 `<contentKey>.json`,内容
 * `{ envFingerprint, source: 'page' | 'prerender', since, touchedAt }`。
 *
 * 读写都以内存为准、同步完成(调用方在写帧的热路径上判锁,不能等盘);写盘排在后面异步做,
 * 同一把锁连续改多次只写最后的样子(每帧都刷新 `touchedAt`,不能每帧落一次盘)。`flush()` 等
 * 排着的写盘全部落定。
 */

export const CARD_LOCK_IDLE_MS = 30_000;

const CONTENT_KEY = /^[0-9a-f]{64}$/;
const isContentKey = value => typeof value === 'string' && CONTENT_KEY.test(value);
const isFingerprint = value => typeof value === 'string' && value.length > 0;

function checkKey(contentKey) {
  if (!isContentKey(contentKey)) throw new TypeError(`卡片锁的内容键必须是 64 位小写十六进制:${JSON.stringify(contentKey)}`);
}
function checkFingerprint(envFingerprint) {
  if (!isFingerprint(envFingerprint)) throw new TypeError(`卡片锁的环境指纹必须是非空字符串:${JSON.stringify(envFingerprint)}`);
}

/** 盘上读回来的一把锁是否可用;不可用的文件整个跳过 */
function validLock(value) {
  if (!value || typeof value !== 'object') return null;
  const { envFingerprint, source, since, touchedAt } = value;
  if (!isFingerprint(envFingerprint) || typeof source !== 'string' || !source) return null;
  if (!Number.isFinite(since) || !Number.isFinite(touchedAt)) return null;
  return { envFingerprint, source, since, touchedAt };
}

const copy = lock => (lock ? { ...lock } : null);

/**
 * @param {{ dir: string, now?: () => number }} options
 */
export function createCardLockStore({ dir, now = Date.now }) {
  /** contentKey → { envFingerprint, source, since, touchedAt } */
  const locks = new Map();
  /** 改过、还没落盘的锁键 */
  const dirty = new Set();
  let draining = null;

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  /*
   * 写盘:一次只跑一趟,把 `dirty` 里的键逐个写成**此刻**内存里的样子(`atomic` 先写临时文件再改名,
   * 读的一方不会读到半个文件)。写失败不影响内存里的锁,下次改这把锁再写。
   */
  async function drain() {
    while (dirty.size) {
      const keys = [...dirty];
      dirty.clear();
      for (const contentKey of keys) {
        const lock = locks.get(contentKey);
        if (!lock) continue;
        try { await atomic(path.join(dir, `${contentKey}.json`), JSON.stringify(lock)); } catch { /* 见上 */ }
      }
    }
  }
  function schedule(contentKey) {
    dirty.add(contentKey);
    if (!draining) draining = Promise.resolve().then(drain).finally(() => { draining = null; });
  }

  return {
    /** 读目录里全部 `*.json`;坏文件跳过,目录不存在不算错。内存里已有的锁(load 之前就改过的)以内存为准 */
    async load() {
      let names = [];
      try { names = await fs.readdir(dir); } catch { return; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const contentKey = name.slice(0, -'.json'.length);
        if (!isContentKey(contentKey) || locks.has(contentKey)) continue;
        try {
          const lock = validLock(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')));
          if (lock && !locks.has(contentKey)) locks.set(contentKey, lock);
        } catch { /* 坏文件跳过 */ }
      }
    },
    /** 同步;没有回 null。回的是副本 */
    get(contentKey) {
      return copy(locks.get(contentKey));
    },
    /**
     * 得锁(同步):没锁建锁;同指纹刷新 `touchedAt`;不同指纹 `granted: false`、锁不变。
     * @returns {{ granted: boolean, lock: { envFingerprint: string, source: string, since: number, touchedAt: number } }}
     */
    acquire(contentKey, envFingerprint, source) {
      checkKey(contentKey);
      checkFingerprint(envFingerprint);
      const current = locks.get(contentKey);
      const at = clock();
      if (!current) {
        const lock = { envFingerprint, source: String(source || ''), since: at, touchedAt: at };
        locks.set(contentKey, lock);
        schedule(contentKey);
        return { granted: true, lock: copy(lock) };
      }
      if (current.envFingerprint === envFingerprint) {
        current.touchedAt = at;
        schedule(contentKey);
        return { granted: true, lock: copy(current) };
      }
      return { granted: false, lock: copy(current) };
    },
    /** 接手(同步覆盖):锁转给 `envFingerprint`,`since = touchedAt = now()`。回新锁的副本 */
    takeover(contentKey, envFingerprint, source) {
      checkKey(contentKey);
      checkFingerprint(envFingerprint);
      const at = clock();
      const lock = { envFingerprint, source: String(source || ''), since: at, touchedAt: at };
      locks.set(contentKey, lock);
      schedule(contentKey);
      return copy(lock);
    },
    /** `[{ contentKey, envFingerprint, source, since, touchedAt }]`,按 `contentKey` 排序 */
    list() {
      return [...locks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([contentKey, lock]) => ({ contentKey, ...lock }));
    },
    /** 等排着的写盘全部落定 */
    async flush() {
      while (draining) await draining;
    },
  };
}

/**
 * 本机预渲染进程遇到一张共享档卡时怎么办(纯函数,按顺序判):
 *
 *   1. 没锁,或锁在自己的指纹上 → `'own'`:照常渲,渲之前得锁;
 *   2. 锁定方的结果已齐(`complete`)→ `'reuse'`:直接投递锁定方的结果,不渲;
 *   3. 锁定方 `idleMs` 之内还产过 → `'defer'`:它可能还在产,先做别的卡;
 *   4. 其余 → `'takeover'`:用自己的指纹另起一套键、从头产这张卡。
 *
 * @param {{ lock: { envFingerprint: string, touchedAt: number } | null | undefined, ownFingerprint: string | null | undefined,
 *           complete: boolean, now?: number, idleMs?: number }} input
 * @returns {'own' | 'reuse' | 'defer' | 'takeover'}
 */
export function cardLockDecision({ lock, ownFingerprint, complete, now = Date.now(), idleMs = CARD_LOCK_IDLE_MS }) {
  if (!lock || lock.envFingerprint === ownFingerprint) return 'own';
  if (complete) return 'reuse';
  if (now - lock.touchedAt < idleMs) return 'defer';
  return 'takeover';
}
