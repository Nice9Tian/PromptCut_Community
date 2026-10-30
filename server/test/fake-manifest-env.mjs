/**
 * 仅供测试，生产代码不得引用。
 *
 * C6.4（契约 `docs/plan/manifest-contract.md` 第 6 节）四个测试文件共用的小工具：
 *
 *   loadContentClient()                     动态 import `server/render-node/content-client.mjs`，缺失时抛出带原因的错误
 *   startContentService({ modules?, ... })  独立模式的真文档服务（端口 0、`autoTick: false`），缺省挂 C6.3 的内容库模块、memory 存储
 *   connectEndpoint(url)                    M5a 的 `createWsEndpoint`，等到连上
 *   connectContent(env, { user, timeoutMs }) 上面两步 + `createContentClient(endpoint)`；回 { endpoint, content }
 *   countingContent(content)                记 put / get / list 调用的包装
 *   countingAsset(client)                   记 put / get / has 调用的包装（put 记下字节的 sha256）
 *   createManualClock(start)                可注入的假时钟：{ now, setTimeout, clearTimeout, advance(ms), pending() }
 *   until(cond, { timeoutMs, stepMs, what }) 用真时间轮询到条件成立
 *
 * `startContentService` 回 `{ url(user), cleanup(), service, port, logs }`；
 * `cleanup()` 关掉本文件建过的全部端点（停止重连）与服务，可重复调用。
 *
 * 只引 Node 内置模块、同目录的 `fake-docservice-env.mjs`，以及被测的 `ws-transport.mjs` / 内容库模块。
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
  if (contentClientError) throw new Error(`载不进 server/render-node/content-client.mjs：${contentClientError.message}`);
  assert.equal(typeof contentClientMod.createContentClient, 'function', `content-client.mjs 要导出 createContentClient；导出：${Object.keys(contentClientMod).join(', ')}`);
  return contentClientMod;
}

/** 独立模式起一台文档服务。缺省挂内容库模块（memory 存储）；`modules` 给了就用给的 */
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
    for (const ep of endpoints) { try { ep.close(); } catch { /* 已关 */ } }
    await env.cleanup();
  };
  return { ...env, url, endpoints, cleanup };
}

/** 连上一条 M5a 端点；`env` 给了就登记进去，cleanup 时一起关（停止重连） */
export async function connectEndpoint(url, { env, ms = 3000 } = {}) {
  const endpoint = createWsEndpoint({ url, backoff: { baseMs: 50, maxMs: 200 } });
  env?.endpoints?.add(endpoint);
  if (!endpoint.connected) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`端点 ${ms} ms 内没连上：${url}`)), ms);
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

/** `hooks.beforePut({ ns, hash, bytes })` 可以抛错或返回 promise（阻塞），用来注入失败与卡住 */
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
 * 可注入的假时钟。`setTimeout(fn, ms)` 只登记，`advance(ms)` 把时间推过去并按到期先后调；
 * 调完之后让出几次事件循环，让续体跑完。`delays` 记下每次登记的 ms（诊断用）。
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
        try { next[1].fn(); } catch { /* 计时器回调的错误不往外抛 */ }
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

/** 用真时间轮询，直到 cond() 为真（可以是 async）；超时抛出，带 what() 的诊断 */
export async function until(cond, { timeoutMs = 10_000, stepMs = 10, what = () => '' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) {
      let info = '';
      try { info = await what(); } catch (err) { info = `（诊断出错：${err.message}）`; }
      throw new Error(`等了 ${timeoutMs} ms 条件仍不成立。${info}`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
