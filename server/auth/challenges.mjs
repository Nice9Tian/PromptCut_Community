/**
 * One-time nonce for challenges (contract `docs/plan/auth-contract.md` Sections 4 and 7).
 *
 * A `nonce` is a 32-byte random number (base64url), single-use, expires in 60 s, bound to a set of
 * fields (entry: `projectId`, `username`, `deviceId`, `as`; creator operations: connection and
 * project). Upon verification, whether success or failure, the `nonce` is invalidated immediately.
 * In-memory only: after the document service restarts, all unused ones are invalidated, and clients
 * simply fetch a new one.
 *
 * Used nonces are kept until their original expiration time (`spent`), so verification can
 * distinguish "replayed a used one" (`used`). The handshake uses this to avoid counting replays
 * toward passphrase error rate limits: Node's built-in WebSocket (undici) requests again with the
 * exact same subprotocols when handshake returns 401, counting a single wrong passphrase twice;
 * replaying a used nonce can never get in, neither counting nor helping passphrase guessers.
 */
import { randomBytes } from 'node:crypto';

export const CHALLENGE_DEFAULTS = Object.freeze({ TTL_MS: 60_000, MAX: 20_000 });

/** Bound fields concatenated into a key: fields are JSON-stringified and joined in order, so field characters never collide */
const bindingKey = (binding) => JSON.stringify(binding);

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.max] Concurrency limit; drops the earliest issued when exceeded
 */
export function createChallenges({ now = Date.now, ttlMs = CHALLENGE_DEFAULTS.TTL_MS, max = CHALLENGE_DEFAULTS.MAX } = {}) {
  /** nonce → { key, expires }; Map in insertion order, earliest issued comes first */
  const live = new Map();
  /** Used nonce → original expiration time */
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
    /** Issues a nonce, bound to `binding` (array, fields in fixed order) */
    issue(binding) {
      const at = now();
      prune(at);
      const nonce = randomBytes(32).toString('base64url');
      live.set(nonce, { key: bindingKey(binding), expires: at + ttlMs });
      return nonce;
    },

    /**
     * Verifies and invalidates, returning `'ok'` or failure reason: `'used'` (already used, replay),
     * `'expired'`, `'mismatch'` (binding mismatch), `'unknown'`. This nonce is invalidated regardless
     * of success or failure.
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

    /** Boolean version of `check` */
    consume(nonce, binding) {
      return this.check(nonce, binding) === 'ok';
    },

    /** Invalidates matching nonces (clears its creator challenges when connection disconnects) */
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
