/**
 * Rate limiting on incorrect passphrase (contract `docs/plan/auth-contract.md` section 9).
 *
 * Counted by origin address: 5 failures within 1 minute puts this origin into a 60 s cooldown.
 * During cooldown, challenges return 429, handshakes always return 401, and creator operations
 * return `rate-limited`. Count resets to zero after cooldown ends. Loopback origins are not
 * counted (judged by caller, `fail` is not called).
 * In-memory only; evicts least recently active when there are too many origins.
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
  /** Origin → { failures: number[], until: number }; Map ordered by last modification */
  const sources = new Map();

  const keyOf = (remote) => String(remote ?? '');

  function touch(key, entry) {
    sources.delete(key);
    sources.set(key, entry);
    while (sources.size > maxSources) sources.delete(sources.keys().next().value);
  }

  return {
    /** This origin is in cooldown */
    blocked(remote) {
      const entry = sources.get(keyOf(remote));
      if (!entry) return false;
      const at = now();
      if (entry.until > at) return true;
      if (entry.until !== 0) sources.delete(keyOf(remote)); // Cooldown expired: reset to zero
      return false;
    },

    /** Records one failure; returns true if this failure puts it into cooldown */
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
     * Cooldown remaining in milliseconds (returns 0 if not in cooldown). Added in C10a: invite code
     * endpoint and challenge 429 responses include seconds, UI writes "Please try again in {seconds}
     * seconds" per Table A (`docs/plan/c10a-contract.md` section 14). Read-only, does not modify count.
     */
    retryAfterMs(remote) {
      const entry = sources.get(keyOf(remote));
      if (!entry) return 0;
      return Math.max(0, entry.until - now());
    },

    size: () => sources.size,
  };
}
