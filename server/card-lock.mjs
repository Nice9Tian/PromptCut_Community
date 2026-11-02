import fs from 'node:fs/promises';
import path from 'node:path';
import { atomic } from './frame-mov.mjs';

/**
 * Per-card fingerprint lock on this machine (Contract F.3; semantics `mechanism/rendering.md`
 * "Do not mix outputs from different environments" and "Reuse of prerender output").
 *
 * This machine only locks one type of output: **shared-tier snapshots**. The lock key is the card's
 * content key `control.contentKey` (64-character lowercase hex). Only outputs from a single
 * environment are produced and delivered under the same lock: whichever produces for this card first
 * between the page's measurement frame (user browser fingerprint) and this machine's prerender process
 * (SwiftShader fingerprint) locks the card to its environment; the other party either directly delivers
 * the locked party's output, or waits until the locked party has been idle long enough to **take over**
 * the entire card using its own fingerprint.
 *
 * Local tier, track streams, and standalone card PNG caches have only one producer on this machine
 * (the prerender process), so they are not locked.
 *
 * # Lock store
 *
 * Directory `<store-root>/controls-lock/`, one file per lock `<contentKey>.json`, containing
 * `{ envFingerprint, source: 'page' | 'prerender', since, touchedAt }`.
 *
 * Both reads and writes take memory as the source of truth and complete synchronously (callers check
 * locks on the hot path of writing frames and cannot wait for disk); disk writes are queued
 * asynchronously behind them, and consecutive modifications to the same lock only write the final
 * state (every frame refreshes `touchedAt`, and cannot flush to disk every frame). `flush()` waits
 * for all queued disk writes to settle.
 */

export const CARD_LOCK_IDLE_MS = 30_000;

const CONTENT_KEY = /^[0-9a-f]{64}$/;
const isContentKey = value => typeof value === 'string' && CONTENT_KEY.test(value);
const isFingerprint = value => typeof value === 'string' && value.length > 0;

function checkKey(contentKey) {
  if (!isContentKey(contentKey)) throw new TypeError(`The content key of a card lock must be 64 lowercase hex characters: ${JSON.stringify(contentKey)}`);
}
function checkFingerprint(envFingerprint) {
  if (!isFingerprint(envFingerprint)) throw new TypeError(`The environment fingerprint of a card lock must be a non-empty string: ${JSON.stringify(envFingerprint)}`);
}

/** Whether a lock read back from disk is usable; unusable files are skipped entirely */
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
  /** Modified lock keys not yet written to disk */
  const dirty = new Set();
  let draining = null;

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  /*
   * Disk writes: runs only one pass at a time, writing keys in `dirty` one by one as they look in
   * memory **at this moment** (`atomic` writes a temp file first and then renames it, so readers
   * never read a partial file). Write failures do not affect locks in memory; the lock will be
   * written again the next time it changes.
   */
  async function drain() {
    while (dirty.size) {
      const keys = [...dirty];
      dirty.clear();
      for (const contentKey of keys) {
        const lock = locks.get(contentKey);
        if (!lock) continue;
        try { await atomic(path.join(dir, `${contentKey}.json`), JSON.stringify(lock)); } catch { /* See above */ }
      }
    }
  }
  function schedule(contentKey) {
    dirty.add(contentKey);
    if (!draining) draining = Promise.resolve().then(drain).finally(() => { draining = null; });
  }

  return {
    /**
     * Reads all `*.json` in the directory; skips corrupt files, non-existent directory is not an error.
     * Locks already in memory (modified before load) take memory as the source of truth.
     */
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
        } catch { /* Skip corrupt files */ }
      }
    },
    /** Synchronous; returns null if absent. Returns a replica */
    get(contentKey) {
      return copy(locks.get(contentKey));
    },
    /**
     * Acquire lock (synchronous): creates lock if absent; refreshes `touchedAt` on same fingerprint;
     * `granted: false` and lock unchanged on different fingerprint.
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
    /**
     * Take over (synchronous overwrite): transfers lock to `envFingerprint`, `since = touchedAt = now()`.
     * Returns a replica of the new lock.
     */
    takeover(contentKey, envFingerprint, source) {
      checkKey(contentKey);
      checkFingerprint(envFingerprint);
      const at = clock();
      const lock = { envFingerprint, source: String(source || ''), since: at, touchedAt: at };
      locks.set(contentKey, lock);
      schedule(contentKey);
      return copy(lock);
    },
    /** `[{ contentKey, envFingerprint, source, since, touchedAt }]`, sorted by `contentKey` */
    list() {
      return [...locks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([contentKey, lock]) => ({ contentKey, ...lock }));
    },
    /** Waits for all queued disk writes to settle */
    async flush() {
      while (draining) await draining;
    },
  };
}

/**
 * What the prerender process on this machine does when encountering a shared-tier card
 * (pure function, evaluated in order):
 *
 *   1. No lock, or locked on its own fingerprint → `'own'`: render as normal, acquire lock before rendering;
 *   2. Locked party's output is ready (`complete`) → `'reuse'`: deliver locked party's output directly, no render;
 *   3. Locked party produced within `idleMs` → `'defer'`: it may still be producing, work on other cards first;
 *   4. Otherwise → `'takeover'`: start a new set of keys with own fingerprint and produce this card from scratch.
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
