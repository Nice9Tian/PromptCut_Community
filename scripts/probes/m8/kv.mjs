/**
 * M8 探针的协调口 KV 约定（计划 `docs/plan/m8-plan.md` 第 4 节第 1 项）。协调口就是 `scripts/probes/probe-coord.mjs`
 * （本机替身起一个，跨机用阿里云的 `/coord`）；本文件只是它的 KV 客户端加一层键名约定。
 *
 * ## 键名：`<前缀>.<本轮 id>.<名>`（协调口要求 `[A-Za-z0-9._-]{1,64}`，拼出来超长就抛错）
 *   <前缀>.latest              creator → 其它：本轮 id（别的角色没给 --run 时从这里取，10 分钟内写的才认）
 *   <前缀>.<run>.config        creator → 其它：托管地址、项目 id、成员名与口令、本轮参数（口令只进 KV，不打印）
 *   <前缀>.<run>.ready.<角色>   角色 → creator：起来了（带指纹、代码版本、端口等）
 *   <前缀>.<run>.signal.<名>    任意 → 任意：一次性信号（如 `host.holding`、`cut.done`、`stall.done`）
 *   <前缀>.<run>.result.<角色>  角色的结果行（同 stdout 最后一行）
 *   <前缀>.<run>.abort          任一角色出错时写；别的角色看到就收尾
 *   <前缀>.<run>.done           creator 汇总完、别的角色可以退出了
 * 角色名可以带编号（`node-a`、`host-b`）：只要拼出的键合法。
 *
 * ## 401（L19：T9 协调口「笔记本 creator 第一次 KV 写回 401，原因没查明」）
 * 写 / 读回 401 时带状态码、响应体（截 200 字）、请求有没有带令牌、令牌长度记一行（令牌本身不记），隔 500 ms 再试一次；
 * 还是 401 就抛错。网络错误与 5xx 按退避重试（暂时性故障，不算失败），到 deadline 为止。
 *
 * 令牌只从环境变量 `PROBE_MAIL_TOKEN` 取（协调口开了信箱时 KV 要它），不收命令行参数、不打印。
 */
import { setTimeout as delay } from 'node:timers/promises';

export const KV_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** 拼一个 KV 键并校验 */
export function kvKey(...parts) {
  const key = parts.filter((p) => p !== null && p !== undefined && p !== '').join('.');
  if (!KV_KEY_RE.test(key)) throw new RangeError(`KV 键不合法或超过 64 个字符：${key}`);
  return key;
}

/**
 * 协调口 KV 客户端（与 `probe-coord.mjs` 的 `coordClient` 同一条接口，另加 401 记录与重试）。
 * @param {string} base 协调口基址
 * @param {{ token?: string, log?: (event: string, fields: object) => void, fetch?: typeof fetch }} [o]
 */
export function kvClient(base, { token = process.env.PROBE_MAIL_TOKEN, log = () => {}, fetch: f = globalThis.fetch } = {}) {
  const root = String(base).replace(/\/+$/, '');
  const auth = token ? { 'X-Mail-Token': token } : {};
  const stats = { puts: 0, gets: 0, unauthorized: 0, retries: 0 };

  /** 发一次请求；401 记一行、隔 500 ms 再试一次；网络错误与 5xx 退避重试到 deadline */
  async function request(method, key, { body, waitMs = 0, deadline = Date.now() + 60_000 } = {}) {
    let tried401 = false;
    let backoff = 300;
    for (;;) {
      let res;
      try {
        const url = `${root}/kv/${encodeURIComponent(key)}${method === 'GET' ? `?wait=${Math.max(0, waitMs)}` : ''}`;
        res = await f(url, {
          method, headers: { ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(waitMs + 15_000),
        });
      } catch (error) {
        if (Date.now() + backoff > deadline) throw new Error(`协调口 ${method} ${key} 连不上：${error?.cause?.code ?? error?.message ?? error}`);
        stats.retries += 1;
        await delay(backoff);
        backoff = Math.min(backoff * 2, 5000);
        continue;
      }
      if (res.status === 401) {
        stats.unauthorized += 1;
        const text = (await res.text().catch(() => '')).slice(0, 200);
        log('kv.unauthorized', { method, key, status: 401, body: text, hasToken: !!token, tokenLength: token ? token.length : 0, retry: !tried401 });
        if (tried401) throw Object.assign(new Error(`协调口 ${method} ${key} 回 401（已重试一次）`), { status: 401 });
        tried401 = true;
        await delay(500);
        continue;
      }
      if (res.status >= 500 && Date.now() + backoff <= deadline) {
        stats.retries += 1;
        await res.body?.cancel().catch(() => {});
        await delay(backoff);
        backoff = Math.min(backoff * 2, 5000);
        continue;
      }
      return res;
    }
  }

  const client = {
    base: root,
    stats,
    async put(key, value) {
      stats.puts += 1;
      const res = await request('PUT', key, { body: value });
      if (!res.ok) throw Object.assign(new Error(`协调口 PUT ${key} 回 ${res.status}`), { status: res.status });
      await res.body?.cancel().catch(() => {});
    },
    /** 取一次（最多等 waitMs）；没有回 null。连不上时退避重试到 deadline（缺省 60 s 后） */
    async get(key, waitMs = 0, deadline = Date.now() + waitMs + 60_000) {
      stats.gets += 1;
      const res = await request('GET', key, { waitMs, deadline });
      if (res.status === 404) { await res.body?.cancel().catch(() => {}); return null; }
      if (!res.ok) throw Object.assign(new Error(`协调口 GET ${key} 回 ${res.status}`), { status: res.status });
      return (await res.json()).value ?? null;
    },
    /** 等到这个键出现，或到 deadline（毫秒时间戳）；暂时连不上就重试 */
    async take(key, deadline) {
      while (Date.now() < deadline) {
        const wait = Math.max(1, Math.min(30_000, deadline - Date.now()));
        try {
          const v = await client.get(key, wait, deadline);
          if (v !== null) return v;
        } catch (error) {
          if (error?.status === 401) throw error;
          await delay(500);
        }
      }
      return null;
    },
  };
  return client;
}

/**
 * 一个角色在一轮里的 KV 视图：按上面的键名约定包一层。
 * @param {{ coord: string, prefix: string, run: string, role: string, log?: Function, token?: string }} o
 */
export function roleKv({ coord, prefix, run, role, log = () => {}, token }) {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(prefix)) throw new RangeError(`KV 前缀要 1～16 个 [A-Za-z0-9_-]：${prefix}`);
  const c = kvClient(coord, { log, ...(token === undefined ? {} : { token }) });
  const K = (...name) => kvKey(prefix, run, ...name);
  const kv = {
    client: c,
    run,
    role,
    key: K,
    put: (name, value) => c.put(K(name), value),
    get: (name, waitMs = 0) => c.get(K(name), waitMs),
    take: (name, deadline) => c.take(K(name), deadline),
    /** 写不进去只记一行、不抛（收尾路径用） */
    async tryPut(name, value) {
      try { await c.put(K(name), value); return true; } catch (error) { log('kv.put-failed', { key: K(name), message: String(error?.message ?? error) }); return false; }
    },
    config: (value) => c.put(K('config'), value),
    takeConfig: (deadline) => c.take(K('config'), deadline),
    ready: (fields = {}) => c.put(K('ready', role), { role, at: Date.now(), ...fields }),
    takeReady: (who, deadline) => c.take(K('ready', who), deadline),
    signal: (name, fields = {}) => c.put(K('signal', name), { by: role, at: Date.now(), ...fields }),
    takeSignal: (name, deadline) => c.take(K('signal', name), deadline),
    peekSignal: (name) => c.get(K('signal', name), 0).catch(() => null),
    result: (line) => kv.tryPut(`result.${role}`, line),
    takeResult: (who, deadline) => c.take(K('result', who), deadline),
    abort: (reason) => kv.tryPut('abort', { by: role, reason: String(reason).slice(0, 300), at: Date.now() }),
    aborted: () => c.get(K('abort'), 0).catch(() => null),
    done: (fields = {}) => kv.tryPut('done', { by: role, at: Date.now(), ...fields }),
    takeDone: (deadline) => c.take(K('done'), deadline),
  };
  return kv;
}

/**
 * 定本轮 id：给了就用；creator 没给就新生成并写 `<前缀>.latest`；别的角色没给就从 `<前缀>.latest` 取（maxAgeMs 内写的才认）。
 * @param {{ coord: string, prefix: string, run?: string | null, isCreator: boolean, newRun: () => string, deadline: number, maxAgeMs?: number, log?: Function, token?: string }} o
 */
export async function resolveRun({ coord, prefix, run = null, isCreator, newRun, deadline, maxAgeMs = 10 * 60_000, log, token }) {
  const c = kvClient(coord, { log, ...(token === undefined ? {} : { token }) });
  const latest = kvKey(prefix, 'latest');
  if (isCreator) {
    const id = run ?? newRun();
    await c.put(latest, { run: id, at: Date.now() });
    return id;
  }
  if (run) return run;
  while (Date.now() < deadline) {
    const v = await c.get(latest, Math.min(10_000, Math.max(0, deadline - Date.now())), deadline).catch(() => null);
    if (v?.run && Date.now() - (v.at ?? 0) <= maxAgeMs) return v.run;
    await delay(500);
  }
  throw new Error(`KV 里没有本轮 id（${latest}）`);
}
