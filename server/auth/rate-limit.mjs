/**
 * 口令错误限速（契约 `docs/plan/auth-contract.md` 第 9 节）。
 *
 * 按来源地址计数：1 分钟内失败 5 次，这个来源进入 60 s 冷却。冷却期内挑战回 429、握手一律 401、创建者操作回
 * `rate-limited`。冷却结束后计数清零。回环来源不计数（由调用方判断，不调 `fail`）。
 * 只在内存里；来源太多时丢最久没动的。
 */

export const RATE_DEFAULTS = Object.freeze({ WINDOW_MS: 60_000, MAX_FAILURES: 5, COOLDOWN_MS: 60_000, MAX_SOURCES: 50_000 });

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.windowMs]
 * @param {number} [options.maxFailures]
 * @param {number} [options.cooldownMs]
 */
export function createRateLimiter({
  now = Date.now,
  windowMs = RATE_DEFAULTS.WINDOW_MS,
  maxFailures = RATE_DEFAULTS.MAX_FAILURES,
  cooldownMs = RATE_DEFAULTS.COOLDOWN_MS,
  maxSources = RATE_DEFAULTS.MAX_SOURCES,
} = {}) {
  /** 来源 → { failures: number[], until: number }；Map 按最后一次改动的顺序 */
  const sources = new Map();

  const keyOf = (remote) => String(remote ?? '');

  function touch(key, entry) {
    sources.delete(key);
    sources.set(key, entry);
    while (sources.size > maxSources) sources.delete(sources.keys().next().value);
  }

  return {
    /** 这个来源正在冷却 */
    blocked(remote) {
      const entry = sources.get(keyOf(remote));
      if (!entry) return false;
      const at = now();
      if (entry.until > at) return true;
      if (entry.until !== 0) sources.delete(keyOf(remote)); // 冷却过了：清零
      return false;
    },

    /** 记一次失败；这一次让它进入冷却时回 true */
    fail(remote) {
      const key = keyOf(remote);
      const at = now();
      let entry = sources.get(key);
      if (entry && entry.until !== 0 && entry.until <= at) entry = undefined;
      if (!entry) entry = { failures: [], until: 0 };
      if (entry.until > at) {
        touch(key, entry);
        return false;
      }
      entry.failures = entry.failures.filter((t) => t > at - windowMs);
      entry.failures.push(at);
      let started = false;
      if (entry.failures.length >= maxFailures) {
        entry.until = at + cooldownMs;
        entry.failures = [];
        started = true;
      }
      touch(key, entry);
      return started;
    },

    /**
     * 冷却还剩多少毫秒（不在冷却回 0）。C10a 补：邀请码端点与挑战的 429 回包带上秒数，界面照表 A 写
     * 「请 {秒数} 秒后再试」（`docs/plan/c10a-contract.md` 第 14 节）。只读，不改计数。
     */
    retryAfterMs(remote) {
      const entry = sources.get(keyOf(remote));
      if (!entry) return 0;
      return Math.max(0, entry.until - now());
    },

    size: () => sources.size,
  };
}
