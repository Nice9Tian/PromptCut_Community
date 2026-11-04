/**
 * Project snapshot client (M5b, contract `docs/plan/render-queue-contract.md` J.2; server protocol
 * see J.1 in the same document and `docs/plan/docservice-contract.md` section 1).
 *
 * Shares the same M5a `WsEndpoint` (return value of `createWsEndpoint`) with the node, sending
 * `project.announce`, `project.snapshot.put`, `project.snapshot.get` over it, matching responses
 * by `reqId`. Pairing, timeout, and disconnection semantics follow C6.4's `content-client.mjs`
 * (`manifest-contract.md` section 2):
 *   - Each request carries a `reqId` unique to this instance (`project#<instance-id>-<seq>`);
 *     messages with other `reqId` are ignored;
 *   - If `error` is returned for the same `reqId`, reject, with error carrying `reason` (same as
 *     `code`) and `detail`;
 *   - If no response returns past `timeoutMs`, reject with `code: 'timeout'`, discarding late
 *     responses. Responses for snapshot retrieval arrive in a series, restarting the timer on each
 *     receipt, so `timeoutMs` is the upper limit "between two responses", not for the entire
 *     retrieval;
 *   - If unable to send (not connected) or connection drops, in-flight requests fail immediately
 *     with `code: 'disconnected'` without replay.
 *
 * Uploads are sliced by "JSON-escaped UTF-8 byte count ≤ 512 KiB": each slice's raw text is
 * definitely ≤ 512 KiB (upper limit in J.1), and the entire message is also definitely within
 * document service's single-message limit of 1 MiB. Send slice by slice, wait slice by slice for
 * `project.snapshot.stored`, completing only when response for the last slice has `complete: true`.
 * If sliced into more than 64 slices, do not send, `code: 'too-large'`.
 *
 * On retrieval, concatenate by `index`, verify slice continuity and consistent `count`, then
 * verify `sha256(full text)` equals `end.digest`, and finally `JSON.parse`. Mismatches correspond
 * to `bad-reply`, `digest-mismatch`, `bad-json`.
 *
 * Depends only on Node built-in modules (gatekeeper test `render-node-deps` D1); timers can be
 * injected so tests do not need to wait in real time.
 */
import { createHash, randomUUID } from 'node:crypto';

export const PROJECT_CLIENT_DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  /** Upper limit per chunk, calculated in UTF-8 bytes after JSON escaping (J.1: per chunk ≤ 512 KiB) */
  partBytes: 512 * 1024,
  /** J.1: up to 64 chunks */
  maxParts: 64,
});

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 */
function clientError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.reason = extra.reason ?? code;
  if (extra.detail !== undefined) error.detail = extra.detail;
  return error;
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** UTF-8 byte count of a UTF-16 code unit escaped in a JSON string; surrogate pairs count as 4 overall */
function escapedWidth(text, i) {
  const c = text.charCodeAt(i);
  if (c === 0x22 || c === 0x5c) return [2, 1];
  if (c < 0x20) return [c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6, 1];
  if (c < 0x80) return [1, 1];
  if (c < 0x800) return [2, 1];
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = text.charCodeAt(i + 1);
    return d >= 0xdc00 && d <= 0xdfff ? [4, 2] : [6, 1];
  }
  if (c >= 0xdc00 && c <= 0xdfff) return [6, 1];
  return [3, 1];
}

/**
 * Splits text by "escaped UTF-8 byte count in JSON ≤ limit" without splitting surrogate pairs;
 * returns one chunk even for empty text.
 */
function splitText(text, limit) {
  const parts = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length;) {
    const [w, step] = escapedWidth(text, i);
    if (bytes + w > limit && i > start) {
      parts.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += w;
    i += step;
  }
  if (start < text.length || parts.length === 0) parts.push(text.slice(start));
  return parts;
}

/**
 * @typedef {object} ProjectClient
 * @property {(projectId: string, digest: string, session?: string) => Promise<{ projectRev: number, changed: boolean }>} announce
 * @property {(projectId: string, projectRev: number, digest: string, text: string) => Promise<void>} putSnapshot
 * @property {(projectId: string, projectRev: number) => Promise<object | null>} get  Returns null if this snapshot is missing
 * @property {() => number} pending  In-flight request count (for diagnostics)
 */

/**
 * @param {import('./ws-transport.mjs').WsEndpoint} endpoint
 * @param {object} [options]
 * @param {number} [options.timeoutMs]  Timeout waiting for a response, defaults to 30 s
 * @param {(fn: () => void, ms: number) => any} [options.setTimeout]
 * @param {(handle: any) => void} [options.clearTimeout]
 * @returns {ProjectClient}
 */
export function createProjectClient(endpoint, {
  timeoutMs = PROJECT_CLIENT_DEFAULTS.timeoutMs,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
} = {}) {
  if (!endpoint || typeof endpoint.send !== 'function' || typeof endpoint.onMessage !== 'function') {
    throw new TypeError('createProjectClient: endpoint must have send and onMessage');
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new TypeError('createProjectClient: timeoutMs must be a positive number');
  }

  const instance = randomUUID().slice(0, 8);
  let seq = 0;
  /**
   * reqId → { type, onReply(message) → 'done' | 'more', reject, timer }:
   * `onReply` returning 'more' indicates waiting for the next one (snapshot retrieval chunks);
   * the timer restarts.
   */
  const inflight = new Map();

  function settle(reqId) {
    const entry = inflight.get(reqId);
    if (!entry) return null;
    inflight.delete(reqId);
    clearTimer(entry.timer);
    return entry;
  }

  function arm(reqId, entry) {
    const timer = setTimer(() => {
      const e = settle(reqId);
      if (e) e.reject(clientError('timeout', `Project ${e.type}: no reply within ${timeoutMs} ms`));
    }, timeoutMs);
    timer?.unref?.();
    entry.timer = timer;
  }

  endpoint.onMessage((message) => {
    const reqId = message?.reqId;
    if (typeof reqId !== 'string' || !inflight.has(reqId)) return;
    const entry = inflight.get(reqId);
    if (message.type === 'error') {
      settle(reqId);
      const reason = typeof message.reason === 'string' ? message.reason : 'error';
      entry.reject(clientError(reason, `Project ${entry.type} failed: ${reason}`, { reason, detail: message.detail }));
      return;
    }
    let verdict;
    try {
      verdict = entry.onReply(message);
    } catch (err) {
      settle(reqId);
      entry.reject(err);
      return;
    }
    if (verdict === 'more') {
      clearTimer(entry.timer);
      arm(reqId, entry);
      return;
    }
    settle(reqId);
  });

  if (typeof endpoint.onClose === 'function') {
    endpoint.onClose(() => {
      for (const reqId of [...inflight.keys()]) {
        const entry = settle(reqId);
        entry.reject(clientError('disconnected', `Project ${entry.type}: connection closed`));
      }
    });
  }

  /**
   * Sends a request. `onReply(message, resolve)` handles each non-error response with the same
   * `reqId`: throwing rejects; returning 'more' keeps waiting; everything else is treated as
   * complete (resolve should have been called beforehand).
   */
  function request(type, fields, onReply) {
    return new Promise((resolve, reject) => {
      const reqId = `project#${instance}-${++seq}`;
      const message = { type, ...fields, reqId };
      try {
        JSON.stringify(message);
      } catch {
        reject(clientError('bad-message', `Project ${type}: message cannot be serialized`));
        return;
      }
      const entry = { type, reject, timer: null, onReply: (m) => onReply(m, resolve) };
      arm(reqId, entry);
      inflight.set(reqId, entry);
      let sent = false;
      try {
        sent = endpoint.send(message) !== false;
      } catch {
        sent = false;
      }
      // Endpoint may receive a response synchronously inside send (test double); it has already settled by then
      if (!sent && inflight.has(reqId)) {
        settle(reqId);
        reject(clientError('disconnected', `Project ${type}: connection not ready, nothing was sent`));
      }
    });
  }

  const unexpected = (type, message) => clientError('bad-reply', `Project ${type} got an unexpected reply ${String(message?.type)}`);

  return {
    announce(projectId, digest, session) {
      const fields = { projectId, digest };
      if (session !== undefined && session !== null) fields.session = session;
      return request('project.announce', fields, (m, resolve) => {
        if (m.type !== 'project.announced') throw unexpected('project.announce', m);
        // When the project has an authoritative copy (C6.5), the document service no longer issues
        // revisions: `authoritative: true`, `digest` is the digest of the authoritative copy, and `matches`
        // indicates the reported digest matches it
        const out = { projectRev: m.projectRev, changed: m.changed === true };
        if (m.authoritative === true) Object.assign(out, { authoritative: true, digest: m.digest, matches: m.matches === true });
        resolve(out);
      });
    },

    async putSnapshot(projectId, projectRev, digest, text) {
      if (typeof text !== 'string') throw new TypeError('putSnapshot: text must be a string');
      const parts = splitText(text, PROJECT_CLIENT_DEFAULTS.partBytes);
      const count = parts.length;
      if (count > PROJECT_CLIENT_DEFAULTS.maxParts) {
        throw clientError('too-large', `Project snapshot was split into ${count} parts, over the limit of ${PROJECT_CLIENT_DEFAULTS.maxParts} parts`);
      }
      let last = null;
      for (let index = 0; index < count; index += 1) {
        last = await request('project.snapshot.put', { projectId, projectRev, digest, index, count, data: parts[index] }, (m, resolve) => {
          if (m.type !== 'project.snapshot.stored') throw unexpected('project.snapshot.put', m);
          resolve(m);
        });
      }
      if (last?.complete !== true) {
        throw clientError('incomplete', `Project snapshot upload finished ${count} parts, but the server received only ${String(last?.received)} parts`);
      }
    },

    /**
     * Fetches the project snapshot for this revision, along with "which revision is current when missing"
     * (contract J.15):
     *   exists    → `{ project, projectRev }`
     *   missing   → `{ project: null, currentRev }`; `currentRev` is the current revision returned by the
     *               document service (only present when the project has an authoritative copy and the
     *               requested revision is not current), otherwise null.
     */
    locate(projectId, projectRev) {
      const parts = [];
      let count = null;
      return request('project.snapshot.get', { projectId, projectRev }, (m, resolve) => {
        if (m.type === 'project.snapshot.part') {
          if (m.missing === true) {
            resolve({ project: null, currentRev: Number.isSafeInteger(m.currentRev) ? m.currentRev : null });
            return 'done';
          }
          if (typeof m.data !== 'string' || !Number.isSafeInteger(m.count) || m.count < 1) {
            throw clientError('bad-reply', 'Project snapshot part has wrong fields');
          }
          if (count === null) count = m.count;
          if (m.count !== count || m.index !== parts.length || parts.length >= count) {
            throw clientError('bad-reply', `Project snapshot parts out of order: expected part ${parts.length} (of ${count}), received part ${String(m.index)} (of ${m.count})`);
          }
          parts.push(m.data);
          return 'more';
        }
        if (m.type === 'project.snapshot.end') {
          if (count === null || parts.length !== count) {
            throw clientError('bad-reply', `Project snapshot ended before all parts arrived: received ${parts.length} parts, expected ${String(count)}`);
          }
          const text = parts.join('');
          if (typeof m.digest !== 'string' || sha256(text) !== m.digest) {
            throw clientError('digest-mismatch', 'Reassembled project snapshot does not match its digest');
          }
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            throw clientError('bad-json', 'Project snapshot is not valid JSON');
          }
          resolve({ project: json, projectRev });
          return 'done';
        }
        throw unexpected('project.snapshot.get', m);
      });
    },

    /** Fetches the project snapshot for this revision; returns null if missing (J.2) */
    get(projectId, projectRev) {
      return this.locate(projectId, projectRev).then((found) => found.project);
    },

    pending() {
      return inflight.size;
    },
  };
}
