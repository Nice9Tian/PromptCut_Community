/**
 * For testing only; production code must not import this.
 *
 * Shared utilities for four test files in C6.4 (contract `docs/plan/manifest-contract.md`
 * Section 6):
 *
 *   loadContentClient()                     dynamically imports
 *                                           `server/render-node/content-client.mjs`; throws an
 *                                           error with reason when missing
 *   startContentService({ modules?, ... })  real document service in standalone mode (port 0,
 *                                           `autoTick: false`); mounts C6.3 content store module
 *                                           and memory storage by default
 *   connectEndpoint(url)                    `createWsEndpoint` from M5a, waits until connected
 *   connectContent(env, { user, timeoutMs }) the two steps above + `createContentClient(endpoint)`;
 *                                           returns { endpoint, content }
 *   countingContent(content)                wrapper recording put / get / list calls
 *   countingAsset(client)                   wrapper recording put / get / has calls (put records
 *                                           sha256 of bytes)
 *   createManualClock(start)                injectable fake clock: { now, setTimeout, clearTimeout,
 *                                           advance(ms), pending() }
 *   until(cond, { timeoutMs, stepMs, what }) polls with real time until condition is met
 *
 * `startContentService` returns `{ url(user), cleanup(), service, port, logs }`; `cleanup()` closes
 * all endpoints created by this file (stops reconnecting) and the service; can be called
 * repeatedly.
 *
 * Only imports Node built-in modules, `fake-docservice-env.mjs` in the same directory, and the
 * `ws-transport.mjs` / content store modules under test.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startStandalone } from './fake-docservice-env.mjs';
import { createWsEndpoint } from '../render-node/ws-transport.mjs';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let contentClientMod = null, contentClientError = null;
export async function loadContentClient() {
  if (!contentClientMod && !contentClientError) {
    try { contentClientMod = await import('../render-node/content-client.mjs'); } catch (err) { contentClientError = err; }
  }
  if (contentClientError) throw new Error(`cannot load server/render-node/content-client.mjs: ${contentClientError.message}`);
  assert.equal(typeof contentClientMod.createContentClient, 'function', `content-client.mjs must export createContentClient; exports: ${Object.keys(contentClientMod).join(', ')}`);
  return contentClientMod;
}

/** Starts a document service in standalone mode. Attaches content store module by default (memory storage); uses `modules` if provided */
export async function startContentService({ modules, ...rest } = {}) {
  let mods = modules;
  if (!mods) {
    const { contentModule } = await import('../docservice/modules/content.mjs');
    const { createMemoryStore } = await import('../docservice/store/index.mjs');
    mods = [contentModule({ store: createMemoryStore() })];
  }
  const env = await startStandalone({ modules: mods, ...rest });
  const endpoints = new Set();
  const url = (user = 'node-a') => `ws://127.0.0.1:${env.port}/?user=${encodeURIComponent(user)}`;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    for (const ep of endpoints) { try { ep.close(); } catch { /* Closed */ } }
    await env.cleanup();
  };
  return { ...env, url, endpoints, cleanup };
}

/** Connects an M5a endpoint; registers into `env` if provided, and closes together during cleanup (stops reconnecting) */
export async function connectEndpoint(url, { env, ms = 3000 } = {}) {
  const endpoint = createWsEndpoint({ url, backoff: { baseMs: 50, maxMs: 200 } });
  env?.endpoints?.add(endpoint);
  if (!endpoint.connected) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`endpoint did not connect within ${ms} ms: ${url}`)), ms);
      endpoint.onOpen(() => { clearTimeout(t); resolve(); });
    });
  }
  return endpoint;
}

export async function connectContent(env, { user = 'node-a', timeoutMs } = {}) {
  const { createContentClient } = await loadContentClient();
  const endpoint = await connectEndpoint(env.url(user), { env });
  const content = createContentClient(endpoint, timeoutMs === undefined ? undefined : { timeoutMs });
  return { endpoint, content };
}

export function countingContent(content) {
  const calls = [];
  return {
    calls,
    puts: () => calls.filter((c) => c.op === 'put'),
    gets: () => calls.filter((c) => c.op === 'get'),
    put: (kind, key, body) => { calls.push({ op: 'put', kind, key, body: JSON.parse(JSON.stringify(body)) }); return content.put(kind, key, body); },
    get: (kind, key) => { calls.push({ op: 'get', kind, key }); return content.get(kind, key); },
    list: (kind, prefix) => { calls.push({ op: 'list', kind, prefix }); return content.list(kind, prefix); },
  };
}

/** `hooks.beforePut({ ns, hash, bytes })` can throw or return a promise (blocking), used to inject failures and hangs */
export function countingAsset(client, hooks = {}) {
  const puts = [], gets = [], hases = [];
  return {
    puts, gets, hases,
    async put(ns, bytes, opts) {
      const hash = sha256(bytes);
      const rec = { ns, hash, size: bytes.length, ok: false };
      puts.push(rec);
      if (hooks.beforePut) await hooks.beforePut({ ns, hash, bytes });
      const out = await client.put(ns, bytes, opts);
      rec.ok = true;
      rec.uploaded = out?.uploaded;
      return out;
    },
    get(ns, hash) { gets.push({ ns, hash }); return client.get(ns, hash); },
    has(ns, hash) { hases.push({ ns, hash }); return client.has(ns, hash); },
  };
}

/**
 * Injectable fake clock. `setTimeout(fn, ms)` only registers; `advance(ms)` advances time and
 * invokes callbacks in expiration order; yields the event loop a few times after invocation so
 * continuations finish running. `delays` records the ms of each registration (for diagnostics).
 */
export function createManualClock(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const delays = [];
  const clock = {
    delays,
    now: () => t,
    setTimeout(fn, ms = 0, ...args) {
      const id = ++seq;
      const d = Math.max(0, Number(ms) || 0);
      delays.push(d);
      timers.set(id, { at: t + d, fn: () => fn(...args) });
      return { id, unref() { return this; }, ref() { return this; }, hasRef: () => false, [Symbol.toPrimitive]: () => id };
    },
    clearTimeout(handle) {
      const id = typeof handle === 'object' && handle ? handle.id : handle;
      timers.delete(id);
    },
    pending: () => timers.size,
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= target && (!next || tm.at < next[1].at || (tm.at === next[1].at && id < next[0]))) next = [id, tm];
        if (!next) break;
        timers.delete(next[0]);
        t = Math.max(t, next[1].at);
        try { next[1].fn(); } catch { /* Errors from timer callbacks are not rethrown */ }
        await settleTicks();
      }
      t = target;
      await settleTicks();
    },
  };
  return clock;
}

export async function settleTicks(n = 5) {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Polls with real time until cond() is true (can be async); throws on timeout with what() diagnostics */
export async function until(cond, { timeoutMs = 10_000, stepMs = 10, what = () => '' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) {
      let info = '';
      try { info = await what(); } catch (err) { info = `(diagnostics error: ${err.message})`; }
      throw new Error(`waited ${timeoutMs} ms and the condition still does not hold. ${info}`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
