/**
 * 挑战用的一次性随机数（契约 `docs/plan/auth-contract.md` 第 4、7 节）。
 *
 * `nonce` 是 32 字节随机数（base64url），只能用一次，60 s 过期，绑定一组字段（进入：`projectId`、`username`、
 * `deviceId`、`as`；创建者操作：连接与项目）。核对时不论成败，`nonce` 立即作废。
 * 只在内存里：文档服务重启后，没用掉的全部失效，客户端重新取即可。
 *
 * 用过的 nonce 在原定的过期时刻之前还记着（`spent`），核对时能分出「重放了一个用过的」（`used`）。
 * 握手据此不把重放计入口令错误限速：Node 内置的 WebSocket（undici）在握手回 401 时会用同一组子协议原样再请求一次，
 * 一次输错口令会被数成两次；而重放用过的 nonce 永远进不来，不计数也不帮猜口令的人任何忙。
 */
import { randomBytes } from 'node:crypto';

export const CHALLENGE_DEFAULTS = Object.freeze({ TTL_MS: 60_000, MAX: 20_000 });

/** 绑定的字段拼成一个键：各字段 JSON 化后按顺序拼，字段里有什么字符都不会串 */
const bindingKey = (binding) => JSON.stringify(binding);

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.max] 同时在册的上限；超出时丢最早发的
 */
export function createChallenges({ now = Date.now, ttlMs = CHALLENGE_DEFAULTS.TTL_MS, max = CHALLENGE_DEFAULTS.MAX } = {}) {
  /** nonce → { key, expires }；Map 按插入顺序，最早发的在前 */
  const live = new Map();
  /** 用过的 nonce → 原定的过期时刻 */
  const spent = new Map();

  function prune(at) {
    for (const [nonce, entry] of live) {
      if (entry.expires > at) break;
      live.delete(nonce);
    }
    while (live.size >= max) live.delete(live.keys().next().value);
    for (const [nonce, expires] of spent) {
      if (expires > at && spent.size < max) break;
      spent.delete(nonce);
    }
  }

  return {
    /** 发一个 nonce，绑定 `binding`（数组，字段按固定顺序） */
    issue(binding) {
      const at = now();
      prune(at);
      const nonce = randomBytes(32).toString('base64url');
      live.set(nonce, { key: bindingKey(binding), expires: at + ttlMs });
      return nonce;
    },

    /**
     * 核对并作废，回 `'ok'`，或失败原因：`'used'`（用过的，重放）、`'expired'`、`'mismatch'`（绑定不符）、`'unknown'`。
     * 不论成败，这个 nonce 都作废。
     */
    check(nonce, binding) {
      if (typeof nonce !== 'string') return 'unknown';
      const entry = live.get(nonce);
      if (!entry) return spent.has(nonce) ? 'used' : 'unknown';
      live.delete(nonce);
      spent.set(nonce, entry.expires);
      if (entry.expires <= now()) return 'expired';
      return entry.key === bindingKey(binding) ? 'ok' : 'mismatch';
    },

    /** `check` 的布尔版 */
    consume(nonce, binding) {
      return this.check(nonce, binding) === 'ok';
    },

    /** 作废满足条件的 nonce（连接断开时清它的创建者挑战） */
    dropWhere(predicate) {
      for (const [nonce, entry] of live) {
        if (predicate(JSON.parse(entry.key))) {
          live.delete(nonce);
          spent.set(nonce, entry.expires);
        }
      }
    },

    size: () => live.size,
  };
}
