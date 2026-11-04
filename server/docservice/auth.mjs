/**
 * Legacy entry point for document service handshake (M5a, `docs/plan/render-queue-contract.md` G.5);
 * from M6a onward, only cluster token admin identity remains.
 *
 * Data plane authentication is in `../auth/handshake.mjs` (`docs/plan/auth-contract.md` Section 5):
 * proof, connection ticket, local claim, and loopback local identity. Cluster tokens have completely
 * exited the data plane and only guard admin interfaces: connections with matching tokens receive
 * admin identity `{ userId: 'admin', tenantId: null, scope: 'admin' }`, and sending data plane
 * messages returns `forbidden` (admission check in the assembly layer).
 *
 * `createClusterAuth` is retained for occasions with only tokens and no credential store (tests,
 * processes exposing only admin interfaces):
 * - Token configured: `promptcut.v1` plus `promptcut.token.<token>` → admin identity; all others
 *   are rejected;
 * - No token configured, `allowAnonymous`: uniformly anonymous
 *   `{ userId: 'anonymous', tenantId: null }` (legacy clients, local development).
 * Raw token text never enters any logs, error messages, or diagnostic output: both sides compute
 * sha256 before comparison, followed by constant-time comparison.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { PROTOCOL, TOKEN_PREFIX } from '../auth/protocol.mjs';
import { offeredProtocols, checkTokenFormat, ADMIN_PRINCIPAL } from '../auth/handshake.mjs';

export { PROTOCOL, offeredProtocols, checkTokenFormat };

const ANONYMOUS = Object.freeze({ userId: 'anonymous', tenantId: null });

/** Loopback addresses: considered local only when binding exclusively to these addresses */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

const digest = (text) => createHash('sha256').update(text, 'utf8').digest();

/**
 * @param {object} options
 * @param {string} [options.token] Cluster token; operates in token mode if set
 * @param {boolean} [options.allowAnonymous] Whether to allow anonymous connections when no token is
 *   set; rejects all if not allowed
 * @param {(event: string, fields: object) => void} [options.log] Logs `auth.reject { remote, reason }`
 *   when handshake is rejected
 */
export function createClusterAuth({ token, allowAnonymous = false, log = () => {} } = {}) {
  const tokenMode = token !== undefined && token !== null;
  if (tokenMode && !checkTokenFormat(token)) throw new TypeError('createClusterAuth: invalid cluster token format (expected 32-256 base64url characters)');
  const expected = tokenMode ? digest(token) : null;

  function reject(req, reason) {
    log('auth.reject', { remote: req?.socket?.remoteAddress ?? null, reason });
    return null;
  }

  return {
    /** Returns principal; null indicates rejection (handshake returns 401) */
    authenticate(req) {
      if (!tokenMode) return allowAnonymous ? { ...ANONYMOUS } : reject(req, 'no-credential');
      const offered = offeredProtocols(req);
      if (!offered.includes(PROTOCOL)) return reject(req, 'bad-format');
      const given = offered.filter((p) => p.startsWith(TOKEN_PREFIX));
      if (given.length === 0) return reject(req, 'no-credential');
      // If multiple token entries are provided, do not guess which one is genuine
      if (given.length !== 1) return reject(req, 'multiple');
      const ok = timingSafeEqual(digest(given[0].slice(TOKEN_PREFIX.length)), expected);
      return ok ? { ...ADMIN_PRINCIPAL } : reject(req, 'bad-proof');
    },

    /** Subprotocol to echo on successful handshake; omitted if client did not supply `promptcut.v1` */
    protocolFor(req) {
      return offeredProtocols(req).includes(PROTOCOL) ? PROTOCOL : null;
    },
  };
}
