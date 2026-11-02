/**
 * Project module: authoritative project of C6.5 (design draft `docs/plan/c65-design.md` sections 2
 * and 3), as well as backwards-compatible C6.3 project versions (`docs/plan/docservice-contract.md`
 * section 1) and M5b project snapshots (`docs/plan/render-queue-contract.md` J.1).
 *
 * **Authoritative project** (C6.5): the document service holds the current content of each project,
 * while everyone else holds replicas (semantics `docs/semantics/product/document-service.md`
 * "Responsibilities").
 * - `project.open`: returns `project.state` (current content, version number, recent writers) and
 *   subscribes to the `project:<projectId>` channel; when content is large, returns `project.state`
 *   without content first, then sends chunks of `project.state.part` throttled by backlog, and
 *   finally `project.state.end`.
 * - `project.op`: a batch of path operations (`../json-ops.mjs`), applied atomically as a batch,
 *   version incremented by one, returning `project.op.ok`; broadcasts `project.ops` on the channel
 *   to subscribers other than the submitter. When rejected, returns `project.op.rejected` with
 *   reason `stale` (carried `expectRev` but version did not match, with `since` attached),
 *   `bad-path`, `too-large` (ops exceeded 256 KiB serialized), or `forbidden`.
 * - When the same `opId` has already landed: directly returns the original `rev` (with
 *   `duplicate: true`), without applying or broadcasting again; this step precedes the `expectRev`
 *   check.
 * - Overwrite notifications: records the most recent writer by "entity" (`entitiesOf` in
 *   `json-ops.mjs`, naming criteria in `PROJECT_ENTITY_NAMES`); for entities written in a commit,
 *   if the most recent writer is a different write identity and within 10 minutes, the overwriting
 *   party's `ok` includes `overwrote`, while the overwritten party (its currently online
 *   connections that submitted under that identity) receives `project.overwritten` separately prior
 *   to `project.ops`.
 * - `project.follow { entity, on: false }`: this write identity stops tracking this entity, and will
 *   no longer receive `project.overwritten` when others overwrite it later.
 * - Write identity `actor` takes the connection's principal plus `session` from the message
 *   (`actor.mjs`); any other self-reported identities in messages are never accepted.
 * - Storage: one snapshot per project (`writeBlob`, `projects/<encoded>.state-<hash>.json`) plus an
 *   operation log (stream `projects/<projectId>.ops`, one commit per line). A snapshot is taken every
 *   200 commits, and the log is truncated after the snapshot accordingly (when storage supports
 *   `rewrite`); on first use of a project, reads the snapshot then replays the log.
 * - Large root replacements: `project.upload` uploads an entire project in chunks, referenced in
 *   `project.op` by `{ op: 'set', path: '', upload: <uploadId> }`; such a commit is too large to
 *   broadcast, so it is broadcast without `ops` as `project.ops { resync: true }`, and subscribers
 *   reopen via `project.open`.
 *
 * **Relationship with legacy messages**: there is only one version number. When a project does not
 * yet have an authoritative project (has never received `project.op`), `project.announce` issues
 * numbers, logs version history, and broadcasts `project.rev` according to C6.3; once it has an
 * authoritative project, **the digest is based on the authoritative project**: `announce` no longer
 * issues numbers, returning the current version number and the authoritative project's digest
 * (`sha256(JSON.stringify(authoritativeProject))`, with `changed: false`, `authoritative: true`,
 * and `matches` indicating whether the reported digest matches the authoritative project). M5b
 * snapshots are validated against the digest registered for that version as before; the current
 * version's digest is the authoritative project's digest, so the current version's snapshot can
 * also be sent back directly from the authoritative project (when that file does not exist in
 * storage).
 *
 * Other snapshot (J.1) details remain unchanged:
 * - Uploaded parts are gathered by `(projectId, projectRev)`, and can arrive out of order, be
 *   retransmitted, or come from different connections; if the digest does not match, all received
 *   parts are discarded. Incomplete uploads are kept in memory, dropping the oldest when idle for
 *   too long or exceeding capacity (see `SNAPSHOT_LIMITS`).
 * - On retrieval, first verify that the file content's sha256 equals the digest registered for this
 *   version: Windows file names are case-insensitive, so two projects differing only in case would
 *   end up in the same file for the same version; if it doesn't match, treat it as non-existent
 *   (return `missing`), preventing another project's content from being sent out.
 * - Parts sent back are throttled by backlog: if core outbound queue plus underlying backlog exceeds
 *   the limit (default 1 MiB), the connection is closed with 1013 (H.2); sending the entire payload
 *   at once would cause a disconnect. Before sending each part, wait until this connection's
 *   backlog (`ctx.pendingBytes`) drops below half the limit (`ctx.maxPendingBytes`) (J.11). Multiple
 *   retrievals on the same connection are queued and sent sequentially, stopping if the connection
 *   disconnects. Chunks for `project.state` use the same queue.
 */
import { createHash } from 'node:crypto';
import { createMemoryStore, fileNameOf } from '../store/index.mjs';
import { actorOf } from './actor.mjs';
import { applyOps, entitiesOf, normalizeEntity, parsePath, formatPath, idSegment, OpError } from '../json-ops.mjs';
import { canonical, digest as historyDigest, historyError } from './operation-history.mjs';
import { tr } from '../../i18n.mjs';
export const ROLLBACK_OP_PREFIX = 'logout-rollback:';
let customRollbackPolicy = null;
export function registerProjectRollbackPolicy(policy) {
  customRollbackPolicy = policy && typeof policy === 'object' ? policy : null;
}
export const isReservedOpId = opId =>
  customRollbackPolicy?.isReservedOpId
    ? customRollbackPolicy.isReservedOpId(opId)
    : typeof opId === 'string' && opId.startsWith(ROLLBACK_OP_PREFIX);
export const rollbackOpId = (eventId, attempt) =>
  customRollbackPolicy?.rollbackOpId
    ? customRollbackPolicy.rollbackOpId(eventId, attempt)
    : `${ROLLBACK_OP_PREFIX}${eventId}:${attempt}`;

/**
 * If an account project commit takes longer than this from receipt to response, log a line of
 * `project.op.slow` (diagnostic; tier-3 number)
 */
export const SLOW_OP_MS = 5_000;

export const PROJECT_MODULE = 'project';

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST_RE = /^[0-9a-f]{16,128}$/;
const TOKEN_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

/**
 * Snapshot limits (J.1): ≤ 512 KiB per part (UTF-8 bytes), at most 64 parts; at most this many
 * incomplete uploads kept, idle for this long
 */
export const SNAPSHOT_LIMITS = Object.freeze({
  PART_BYTES: 512 * 1024,
  MAX_PARTS: 64,
  /**
   * Upper limit per part when sending back (by bytes after JSON escaping); smaller than upload to
   * facilitate paced sending
   */
  OUT_PART_BYTES: 256 * 1024,
  MAX_PENDING_UPLOADS: 32,
  PENDING_IDLE_MS: 10 * 60_000,
});

/**
 * Snapshot send-back throttling (J.11): when backlog has not dropped below half the limit, check
 * again after `pollMs`
 */
export const SNAPSHOT_PACE = Object.freeze({ pollMs: 20 });

/** Limits and criteria for authoritative projects (C6.5 section 3) */
export const PROJECT_LIMITS = Object.freeze({
  /** Upper limit for serialized `ops` in a single commit (UTF-8 bytes) */
  MAX_OPS_BYTES: 256 * 1024,
  /** How many commits between taking a snapshot and truncating the log */
  SNAPSHOT_EVERY: 200,
  /** Time window for overwrite notifications */
  OVERWRITE_WINDOW_MS: 10 * 60_000,
  /** Number of commit summary entries kept for `stale.since` */
  HISTORY: 1000,
  /**
   * Maximum commits listed in `since` in a single `stale` response (if more, lists only the most
   * recent with `sinceComplete: false`)
   */
  SINCE_MAX: 200,
  /** Maximum paths listed per commit summary */
  PATHS_PER_COMMIT: 256,
  /** For idempotency: how many recent `opId`s to remember */
  OP_IDS: 5000,
  /** Maximum number of entities listed in `project.state.writers` */
  WRITERS_IN_STATE: 200,
  /**
   * When serialized content is within this limit, `project.state` carries content directly;
   * `project.ops` exceeding it switches to `resync`.
   */
  INLINE_BYTES: 256 * 1024,
  /** Large root replacement: per-chunk limit, max chunk count, max unused uploads kept */
  UPLOAD_PART_BYTES: 512 * 1024,
  UPLOAD_MAX_PARTS: 64,
  UPLOAD_MAX_PENDING: 8,
});

/**
 * Entity scope (c65-ops-spec.md Section 4): pairs of `/<name>/@<id>` starting from the root;
 * names after the first pair can only be these few.
 * This is the only project structure recognized by this module, used only to define the
 * granularity of overwrite notifications; can be overridden by the assembly layer via `entityNames`.
 */
export const PROJECT_ENTITY_NAMES = Object.freeze(['tracks', 'clips', 'transitions']);

/** Used as the limit when core omits `ctx.maxPendingBytes` (same as the core default, H.2) */
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }

/** Business error: returns `error { reason }`, not counted as bad-message */
class Refused extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

function checkProjectId(v) {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('projectId is invalid');
  return v;
}

function checkDigest(v) {
  if (typeof v !== 'string' || !DIGEST_RE.test(v)) bad('digest must be 16-128 lowercase hex characters');
  return v;
}

function checkRev(v) {
  if (!Number.isSafeInteger(v) || v < 1) bad('projectRev must be a positive integer');
  return v;
}

/** `session` is optional: recorded as null if omitted (or null); if provided, must be a 1-128 character string */
function checkSession(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad('session must be a string of 1-128 characters');
  return v;
}

/** `opId`, `undoOf`, `uploadId`: 1-128 character string (any character set, client ensures global uniqueness) */
function checkToken(v, name) {
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad(`${name} must be a string of 1-128 characters`);
  return v;
}

const streamOf = (projectId) => `projects/${projectId}`;
const opsStreamOf = (projectId) => `projects/${projectId}.ops`;
const channelOf = (projectId) => `project:${projectId}`;
/** Snapshot filename (J.1): projectId encoded per C6.3 Section 10 Item 10, `@<projectRev>.json` as is */
export const snapshotBlobName = (projectId, projectRev) => `projects/${fileNameOf(projectId)}@${projectRev}.json`;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Write identities and op numbers sent to pages omit event numbers for password-change logout
 * rollbacks (security review Q5 / SEC-01: event numbers are credentials for claiming numbers).
 * Storage remains complete as before.
 */
const shownActor = (actor) => {
  if (!actor || typeof actor !== 'object' || actor.rollbackEventId === undefined) return actor;
  const { rollbackEventId: _event, ...rest } = actor;
  return { ...rest, rollback: true };
};
const shownOpId = (opId) => (isReservedOpId(opId) ? `${ROLLBACK_OP_PREFIX}${sha256(opId).slice(0, 24)}` : opId);

/**
 * Body snapshot filename: encoded projectId plus its hash prefix. Windows filenames are
 * case-insensitive, so two projects differing only in case collide after encoding; adding a hash
 * computed as-is avoids collisions (M5b snapshots verify digests on read-back; here uses filenames).
 */
export const stateBlobName = (projectId) => `projects/${fileNameOf(projectId)}.state-${sha256(projectId).slice(0, 16)}.json`;

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
export function splitSnapshotText(text, limit) {
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
 * Comparison key for write identity: user + device + role + chat + session
 * (semantics: "which page of which user, or which chat of which Agent").
 */
export function identityOf(actor) {
  return JSON.stringify([actor?.userId ?? null, actor?.deviceId ?? null, actor?.role ?? null, actor?.conversation ?? null, actor?.session ?? null]);
}

/**
 * Target locations written by a batch of operations (`insert` is path of new element),
 * normalized, deduplicated, order-preserving; malformed operations are skipped.
 */
function targetsOf(ops) {
  const out = new Set();
  for (const op of Array.isArray(ops) ? ops : []) {
    const segs = parsePath(op?.path);
    if (segs === null) continue;
    const path = formatPath(segs);
    out.add(op.op === 'insert' && isObj(op.value) && typeof op.value.id === 'string' ? `${path}/${idSegment(op.value.id)}` : path);
  }
  return [...out];
}

function capPaths(paths) {
  return paths.length > PROJECT_LIMITS.PATHS_PER_COMMIT ? paths.slice(0, PROJECT_LIMITS.PATHS_PER_COMMIT) : paths;
}

/**
 * @param {object} [options]
 * @param {{ append(stream: string, record: object): void, read(stream: string): object[],
 *   writeBlob?(name: string, text: string): void, readBlob?(name: string): string | null,
 *   rewrite?(stream: string, records: object[]): void }} [options.store]
 *   Log and snapshot store (`../store/index.mjs`); defaults to in-memory store, does not persist
 *   across restarts. Stores without `writeBlob` / `readBlob` do not support snapshots (M5b
 *   snapshot messages return `unsupported`, body relies only on log replay); stores without
 *   `rewrite` do not truncate logs.
 * @param {() => number} [options.now] Defaults to `ctx.now()`
 * @param {number} [options.pollMs] How often to re-check when backlog has not dropped, defaults
 *   to `SNAPSHOT_PACE.pollMs` (20 ms)
 * @param {number} [options.snapshotEvery] Commits between body snapshots, defaults to 200
 * @param {number} [options.maxOpsBytes] Upper limit per commit, defaults to 256 KiB
 * @param {number} [options.overwriteWindowMs] Time window for overwrite notifications, defaults
 *   to 10 minutes
 * @param {string[] | null} [options.entityNames] Entity scope, defaults to `PROJECT_ENTITY_NAMES`
 */
export function projectModule({
  store = createMemoryStore(),
  now,
  pollMs = SNAPSHOT_PACE.pollMs,
  snapshotEvery = PROJECT_LIMITS.SNAPSHOT_EVERY,
  maxOpsBytes = PROJECT_LIMITS.MAX_OPS_BYTES,
  overwriteWindowMs = PROJECT_LIMITS.OVERWRITE_WINDOW_MS,
  entityNames = PROJECT_ENTITY_NAMES,
  operationCoordinator,
} = {}) {
  const entityOpts = { names: entityNames === null ? null : [...entityNames] };
  /**
   * projectId → project state; recovered from logs and snapshots on first use:
   * { projectRev, digest, at,                 C6.3: revision number (shared with body),
   *                                           digest of most recent announce, time of most recent write
   *   hasBody, body, bodyDigest,              C6.5: whether there is a body (received project.op),
   *                                           current content, { rev, digest } cache
   *   writers: Map<entity, { actor, identity, at, rev }>, history: commit digest[],
   *   opIds: Map<opId, rev>, sinceSnapshot }
   */
  const projects = new Map();
  /** projectId → Map<rev, digest>: registered digest for each revision, which snapshots verify against */
  const revDigests = new Map();
  /** connId → principal */
  const principals = new Map();
  /** `${projectId}@${rev}` → { projectId, projectRev, digest, count, parts: Map<index, data>, bytes, touched } */
  const uploads = new Map();
  /** `${projectId}|${uploadId}` → { count, parts: Map, touched, value? }: large root replacement */
  const bodyUploads = new Map();
  /**
   * connId → { chain: Promise, alive: boolean }: chunked sending queue
   * (shared between snapshot retrieval and `project.state`)
   */
  const senders = new Map();
  /** write identity → online connections that committed with it; connId → write identities it used */
  const identityConns = new Map();
  const connIdentities = new Map();
  /** projectId → Map<identity, Set<entity>>: tracked for logout */
  const unfollowed = new Map();
  const stats = {
    snapshotsStored: 0, snapshotsServed: 0, digestMismatches: 0, uploadsEvicted: 0,
    commits: 0, rejected: 0, duplicates: 0, stateSnapshots: 0, overwrites: 0,
  };
  /** Most recently obtained context: used when event module broadcasts via project channel (`publishToProject`) */
  let lastCtx = null;

  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  const snapshotOf = (projectId, st) => ({ v: 1, projectId, rev: st.projectRev, at: st.at, project: st.body,
    writers: [...st.writers].map(([entity, w]) => [entity, { actor: w.actor, at: w.at, rev: w.rev }]),
    history: st.history, opIds: [...st.opIds] });
  operationCoordinator?.bind({
    fenceRequested(fence, assertUnfenced) {
      for (const [connId, principal] of principals) {
        if (principal.projectId !== fence.projectId) continue;
        try { assertUnfenced({ projectId: fence.projectId, actor: principal }); }
        catch {
          lastCtx?.unsubscribe(connId, channelOf(fence.projectId));
          const sender = senders.get(connId); if (sender) sender.alive = false;
          lastCtx?.close(connId, 1008, 'operation-fenced');
        }
      }
    },
    read(projectId) {
      const st = stateOf(projectId);
      const raw = store.readBlob?.(stateBlobName(projectId));
      return { projectRev: st.projectRev, value: st.body, orderProjection: raw ? JSON.parse(raw).orderProjection : null };
    },
    /**
     * Rolls back a project upon password-change logout (invoked by `server/account/logout-rollback.mjs`
     * via `doc-assembly.mjs`). Computes rollback against content at the time inside project lock
     * (`plan(content)` returns `{ ops, reverted, kept }`); if there are changes to revert, commits
     * them as a compensating operation: write identity is `{ accountId, rollbackEventId }`, broadcast
     * to connections subscribed to this project (applied normally by all parties), and sends a bubble
     * `shared.notice { event: 'content-rolled-back', name }` to each currently online member page of
     * this project. Offline pages do not receive catch-ups; already-committed instances (`duplicate`)
     * recognized after restart are not re-sent. If nothing to revert, does not commit or send bubbles.
     */
    async rollback({ projectId, eventId, accountId, attempt = 1, name = null, notify = true, plan }) {
      if (typeof plan !== 'function' || !Number.isSafeInteger(attempt) || attempt < 1) throw historyError('bad-rollback', 400);
      const opId = rollbackOpId(eventId, attempt);
      const actor = { userId: accountId, deviceId: null, role: 'system', conversation: null, session: null,
        identityVersion: 2, realm: 'account', accountId, rollbackEventId: eventId };
      let planned = null, notified = false;
      const out = await operationCoordinator.executeSystem({ projectId, principal: { kind: 'logout-rollback', eventId, accountId }, opId }, (binding) => {
        const st = stateOf(projectId);
        planned = plan(st.body);
        if (!planned.ops.length) return null;
        const applied = applyOps(st.body, planned.ops);
        const at = typeof now === 'function' ? now() : (lastCtx?.now?.() ?? Date.now());
        const record = { projectId, rev: st.projectRev + 1, opId, ops: planned.ops, actor, at, entities: entitiesOf(applied.effects, entityOpts) };
        const next = { ...st, writers: new Map(st.writers), history: [...st.history], opIds: new Map(st.opIds) };
        landCommit(next, record, applied.root);
        return { ...binding, projectId, opId, expectedRev: st.projectRev, actor, ops: planned.ops,
          beforeProjection: snapshotOf(projectId, st), projection: snapshotOf(projectId, next),
          result: { record, overwrote: [], victims: [], used: [], rollback: { eventId, reverted: planned.reverted, kept: planned.kept,
            remaining: planned.remaining ?? 0, overLimit: planned.overLimit ?? 0 } } };
      }, ({ operation, duplicate }) => {
        if (duplicate) return;
        const { record } = operation.result;
        stats.commits++;
        // Broadcast omits event number (security review Q5): members only need to know whose rollback it is
        lastCtx?.publish(channelOf(projectId), { type: 'project.ops', projectId, rev: record.rev, opId: shownOpId(opId), ops: record.ops,
          actor: shownActor(record.actor), at: record.at });
        if (!notify) return; // When rolling back the same project in batches, only send bubbles for the first batch
        for (const [connId, principal] of principals) {
          if (principal?.projectId !== projectId || principal.role !== 'page' || principal.scope === 'service' || typeof principal.service === 'string') continue;
          lastCtx?.send(connId, { type: 'shared.notice', event: 'content-rolled-back', projectId, name });
          notified = true;
        }
        log('project.rollback', { projectId, opId, reverted: operation.result.rollback.reverted.length, kept: operation.result.rollback.kept.length });
      });
      if (!out) return { state: 'done', opId: null, reverted: [], kept: planned?.kept ?? [], remaining: planned?.remaining ?? 0,
        overLimit: planned?.overLimit ?? 0, notified: false };
      if (out.cancelled) return { state: 'cancelled', opId };
      const result = out.operation.result.rollback;
      return { state: 'done', opId, reverted: result.reverted, kept: result.kept, remaining: result.remaining ?? 0, overLimit: result.overLimit ?? 0,
        notified, duplicate: out.duplicate };
    },
    materialize(operation, projection) {
      const { projectId } = operation;
      const expected = { ...operation.projection, orderProjection: { opId: operation.opId, requestId: operation.requestId,
        preparedDigest: operation.preparedDigest, witnessId: operation.witness.witnessId, orderSeq: operation.witness.orderSeq } };
      if (expected.projectId !== projectId || expected.rev !== operation.projectRev || historyDigest(expected.project) !== historyDigest(operation.after) ||
          canonical(operation.result.record.actor) !== canonical(operation.actor) || operation.result.record.opId !== operation.opId ||
          operation.result.record.rev !== operation.projectRev) throw historyError('needs-reconciliation');
      // Reload the real store, including a rename that succeeded just before a prior crash/error.
      projects.delete(projectId);
      const current = stateOf(projectId);
      const text = store.readBlob?.(stateBlobName(projectId));
      if (current.projectRev === operation.projectRev) {
        if (!text || canonical(JSON.parse(text)) !== canonical(expected)) throw historyError('needs-reconciliation');
      } else {
        if (current.projectRev !== operation.expectedRev || historyDigest(current.body) !== historyDigest(operation.before) ||
            canonical(snapshotOf(projectId, current)) !== canonical(operation.beforeProjection)) throw historyError('needs-reconciliation');
      }
      // Repeat durability completion even after a previous rename, never infer fsync from readback.
      projection.write(stateBlobName(projectId), expected);
      // Exact complete projection, including actor/rev/opId and all historical metadata.
      if (canonical(JSON.parse(store.readBlob(stateBlobName(projectId)))) !== canonical(expected)) throw historyError('needs-reconciliation');
      projects.delete(projectId);
      const landed = stateOf(projectId);
      if (landed.projectRev !== operation.projectRev || historyDigest(landed.body) !== historyDigest(operation.after)) throw historyError('needs-reconciliation');
    },
  });

  function log(event, fields) {
    try {
      lastCtx?.log(event, fields);
    } catch { /* Logging failure does not affect business operations */ }
  }

  function pushHistory(st, entry) {
    st.history.push(entry);
    if (st.history.length > PROJECT_LIMITS.HISTORY) st.history.splice(0, st.history.length - PROJECT_LIMITS.HISTORY);
  }

  function rememberOpId(st, opId, rev) {
    st.opIds.set(opId, rev);
    if (st.opIds.size > PROJECT_LIMITS.OP_IDS) {
      const drop = st.opIds.size - PROJECT_LIMITS.OP_IDS;
      let n = 0;
      for (const key of st.opIds.keys()) {
        if (n >= drop) break;
        st.opIds.delete(key);
        n += 1;
      }
    }
  }

  function noteWriters(st, entities, actor, identity, at, rev) {
    for (const entity of entities) st.writers.set(entity, { actor, identity, at, rev });
  }

  /** Applies a commit record to in-memory state (shared between real-time commits and replay) */
  function landCommit(st, rec, body) {
    st.body = body;
    st.hasBody = true;
    st.bodyDigest = null;
    st.projectRev = rec.rev;
    st.at = rec.at;
    const entities = Array.isArray(rec.entities) ? rec.entities : [];
    noteWriters(st, entities, rec.actor, identityOf(rec.actor), rec.at, rec.rev);
    const entry = { rev: rec.rev, opId: rec.opId, actor: rec.actor, at: rec.at, paths: capPaths(targetsOf(rec.ops)), entities };
    if (rec.undoOf !== undefined) entry.undoOf = rec.undoOf;
    pushHistory(st, entry);
    rememberOpId(st, rec.opId, rec.rev);
  }

  function stateOf(projectId) {
    let st = projects.get(projectId);
    if (st) return st;
    st = {
      projectRev: 0, digest: null, at: null,
      hasBody: false, body: null, bodyDigest: null,
      writers: new Map(), history: [], opIds: new Map(), sinceSnapshot: 0,
    };
    const revs = new Map();
    for (const rec of store.read(streamOf(projectId))) {
      // Projects differing only in case may be mixed into the same file (Windows filenames are
      // case-insensitive); filter by record's own key
      if (rec.projectId !== projectId) continue;
      if (!Number.isSafeInteger(rec.rev) || rec.rev <= st.projectRev) continue;
      if (typeof rec.digest !== 'string') continue;
      st.projectRev = rec.rev;
      st.digest = rec.digest;
      st.at = Number.isFinite(rec.at) ? rec.at : null;
      revs.set(rec.rev, rec.digest);
      pushHistory(st, { rev: rec.rev, actor: rec.actor ?? null, at: st.at, paths: [], entities: [], announce: true });
    }

    // Body: read snapshot first, then replay logs after snapshot
    let snapRev = 0;
    if (typeof store.readBlob === 'function') {
      let snap = null;
      try {
        const text = store.readBlob(stateBlobName(projectId));
        if (text !== null) snap = JSON.parse(text);
      } catch (err) {
        log('project.state-snapshot.bad', { projectId, message: String(err?.message ?? err) });
      }
      if (isObj(snap) && snap.projectId === projectId && Number.isSafeInteger(snap.rev) && snap.rev >= 1) {
        snapRev = snap.rev;
        st.hasBody = true;
        st.body = snap.project ?? null;
        st.projectRev = Math.max(st.projectRev, snap.rev);
        st.at = Number.isFinite(snap.at) ? snap.at : st.at;
        for (const [entity, w] of Array.isArray(snap.writers) ? snap.writers : []) {
          if (typeof entity === 'string' && isObj(w)) st.writers.set(entity, { ...w, identity: identityOf(w.actor) });
        }
        st.history = Array.isArray(snap.history) ? snap.history.slice(-PROJECT_LIMITS.HISTORY) : [];
        for (const [opId, rev] of Array.isArray(snap.opIds) ? snap.opIds : []) st.opIds.set(opId, rev);
      }
    }
    for (const rec of store.read(opsStreamOf(projectId))) {
      if (rec.projectId !== projectId || !Number.isSafeInteger(rec.rev) || rec.rev <= snapRev) continue;
      if (rec.rev <= st.projectRev && st.hasBody) continue;
      if (typeof rec.opId !== 'string' || !Array.isArray(rec.ops)) continue;
      let applied;
      try {
        applied = applyOps(st.body, rec.ops);
      } catch (err) {
        // Commits in the log were all committed previously, replay should not fail; failure indicates
        // corrupted log, stop here, do not continue replaying on incorrect content
        log('project.replay-failed', { projectId, rev: rec.rev, message: String(err?.message ?? err) });
        break;
      }
      if (rec.rev !== st.projectRev + 1) log('project.replay-gap', { projectId, expected: st.projectRev + 1, got: rec.rev });
      landCommit(st, rec, applied.root);
      st.sinceSnapshot += 1;
    }
    projects.set(projectId, st);
    revDigests.set(projectId, revs);
    return st;
  }

  /**
   * Body digest (cached by revision); also registered as digest for this revision for M5b snapshot
   * verification.
   */
  function bodyDigestOf(projectId, st, text) {
    if (st.bodyDigest && st.bodyDigest.rev === st.projectRev) return st.bodyDigest.digest;
    const digest = sha256(text ?? JSON.stringify(st.body));
    st.bodyDigest = { rev: st.projectRev, digest };
    revDigests.get(projectId)?.set(st.projectRev, digest);
    return digest;
  }

  /**
   * Registered digest for this revision; returns undefined if not registered. When there is a body,
   * the current revision's digest is the body digest.
   */
  function digestOfRev(projectId, rev) {
    const st = stateOf(projectId);
    const known = revDigests.get(projectId)?.get(rev);
    if (known !== undefined) return known;
    if (st.hasBody && rev === st.projectRev) return bodyDigestOf(projectId, st);
    return undefined;
  }

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  /** Recent writers within time window, ordered newest to oldest by revision, up to `WRITERS_IN_STATE` */
  function recentWriters(st, nowMs) {
    return [...st.writers.entries()]
      .filter(([, w]) => nowMs - w.at <= overwriteWindowMs)
      .sort((a, b) => b[1].rev - a[1].rev)
      .slice(0, PROJECT_LIMITS.WRITERS_IN_STATE)
      .map(([entity, w]) => ({ entity, actor: shownActor(w.actor), at: w.at, rev: w.rev }));
  }

  function open(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const st = stateOf(projectId);
    ctx.subscribe(connId, channelOf(projectId));
    const rev = st.projectRev;
    const head = {
      type: 'project.state', projectId, rev, projectRev: rev, digest: st.digest, at: st.at,
      hasBody: st.hasBody, writers: recentWriters(st, clock(ctx)),
    };
    if (!st.hasBody) {
      head.project = null;
      return reply(ctx, connId, head, reqId);
    }
    const text = JSON.stringify(st.body);
    const digest = bodyDigestOf(projectId, st, text);
    head.digest = digest;
    if (Buffer.byteLength(text, 'utf8') <= PROJECT_LIMITS.INLINE_BYTES) {
      head.project = st.body;
      return reply(ctx, connId, head, reqId);
    }
    // Large projects: return header without content first, then chunk (same throttling queue as
    // M5b snapshots)
    const withReq = (m) => (reqId === undefined ? m : { ...m, reqId });
    const parts = splitSnapshotText(text, partBytesOf(ctx));
    head.parts = parts.length;
    reply(ctx, connId, head, reqId);
    const messages = parts.map((data, index) => withReq({ type: 'project.state.part', projectId, rev, index, count: parts.length, data }));
    messages.push(withReq({ type: 'project.state.end', projectId, rev, digest }));
    enqueue(ctx, connId, messages, 'project.open');
  }

  function announce(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const digest = checkDigest(msg.digest);
    const session = checkSession(msg.session);
    const st = stateOf(projectId);
    if (st.hasBody) {
      // Has body: digest is determined by body, announce no longer issues numbers
      // (see "Relationship with legacy messages" in file header)
      const bodyDigest = bodyDigestOf(projectId, st);
      return reply(ctx, connId, {
        type: 'project.announced', projectId, projectRev: st.projectRev, changed: false,
        digest: bodyDigest, authoritative: true, matches: bodyDigest === digest,
      }, reqId);
    }
    if (st.digest === digest) {
      return reply(ctx, connId, { type: 'project.announced', projectId, projectRev: st.projectRev, changed: false }, reqId);
    }
    const principal = principals.get(connId);
    const actor = actorOf(principal, session);
    const at = clock(ctx);
    const rev = st.projectRev + 1;
    // Append to log before updating memory: state remains unchanged on disk failure, core returns internal
    store.append(streamOf(projectId), { projectId, rev, digest, actor, at });
    st.projectRev = rev;
    st.digest = digest;
    st.at = at;
    revDigests.get(projectId).set(rev, digest);
    pushHistory(st, { rev, actor, at, paths: [], entities: [], announce: true });
    reply(ctx, connId, { type: 'project.announced', projectId, projectRev: rev, changed: true }, reqId);
    ctx.publish(channelOf(projectId), { type: 'project.rev', projectId, projectRev: rev, digest, actor, at }, { coalesceKey: `project-rev:${projectId}` });
  }

  function close(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    ctx.unsubscribe(connId, channelOf(projectId));
    reply(ctx, connId, { type: 'project.closed', projectId }, reqId);
  }

  // ---------- Body: Commit ----------

  function trackIdentity(connId, identity) {
    let set = identityConns.get(identity);
    if (!set) identityConns.set(identity, (set = new Set()));
    set.add(connId);
    let mine = connIdentities.get(connId);
    if (!mine) connIdentities.set(connId, (mine = new Set()));
    mine.add(identity);
  }

  function isUnfollowed(projectId, identity, entity) {
    const set = unfollowed.get(projectId)?.get(identity);
    return !!set && (set.has(entity) || set.has('*'));
  }

  /** Replaces `{ op: 'set', path: '', upload }` with uploaded content; returns null and reason if not found */
  function resolveUploads(projectId, ops) {
    let used = null;
    const out = ops.map((op) => {
      if (!isObj(op) || op.op !== 'set' || op.path !== '' || !Object.hasOwn(op, 'upload') || Object.hasOwn(op, 'value')) return op;
      const key = `${projectId}|${op.upload}`;
      const up = typeof op.upload === 'string' ? bodyUploads.get(key) : undefined;
      if (!up || !Object.hasOwn(up, 'value')) throw new OpError('bad-path', ops.indexOf(op), `Upload ${String(op.upload)} does not exist or was not fully received`);
      (used ??= []).push(key);
      const { upload, ...rest } = op;
      return { ...rest, value: up.value };
    });
    return { ops: out, used };
  }

  /**
   * `expectRev`, `since` (others' commit digests in the interim), and `sinceComplete` in `stale` response.
   * Shared between non-account and account paths; the model relies on this to see "you read rev X,
   * now it is rev Y, who changed what in the interim".
   */
  function staleDetail(st, expectRev) {
    const later = st.history.filter((h) => h.rev > expectRev && h.rev <= st.projectRev);
    const covered = expectRev >= st.projectRev || (later.length > 0 && later[0].rev === expectRev + 1)
      || (later.length === 0 && st.projectRev === expectRev);
    const shown = later.slice(-PROJECT_LIMITS.SINCE_MAX);
    return {
      expectRev,
      since: shown.map((h) => {
        const s = { rev: h.rev, actor: shownActor(h.actor), paths: h.paths, entities: h.entities, at: h.at };
        if (h.opId !== undefined) s.opId = shownOpId(h.opId);
        if (h.undoOf !== undefined) s.undoOf = h.undoOf;
        if (h.announce) s.announce = true;
        return s;
      }),
      sinceComplete: covered && shown.length === later.length,
    };
  }

  function submit(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const opId = checkToken(msg.opId, 'opId');
    const session = checkSession(msg.session);
    const undoOf = msg.undoOf === undefined || msg.undoOf === null ? undefined : checkToken(msg.undoOf, 'undoOf');
    let expectRev;
    if (msg.expectRev !== undefined && msg.expectRev !== null) {
      if (!Number.isSafeInteger(msg.expectRev) || msg.expectRev < 0) bad('expectRev must be a non-negative integer');
      expectRev = msg.expectRev;
    }
    const st = stateOf(projectId);
    const reject = (reason, extra = {}) => {
      stats.rejected += 1;
      reply(ctx, connId, { type: 'project.op.rejected', projectId, opId, reason, currentRev: st.projectRev, ...extra }, reqId);
    };

    const principal = principals.get(connId);
    if (principal?.role === 'render') return reject('forbidden', { detail: 'A render node connection cannot modify the project' });
    // Cloud Agent connection for read-only member (principal has `access: 'r'`, Section 4.6 of
    // `docs/plan/cloud-agent-contract.md`); assembly layer gate has already blocked it once
    if (principal?.access === 'r') return reject('forbidden', { detail: tr("A read-only connection cannot modify the project") });

    const done = st.opIds.get(opId);
    if (done !== undefined) {
      stats.duplicates += 1;
      return reply(ctx, connId, { type: 'project.op.ok', projectId, opId, rev: done, overwrote: [], duplicate: true }, reqId);
    }

    if (!Array.isArray(msg.ops) || msg.ops.length === 0) return reject('bad-path', { detail: 'ops must be a non-empty array', index: -1 });
    if (Buffer.byteLength(JSON.stringify(msg.ops), 'utf8') > maxOpsBytes) {
      return reject('too-large', { detail: `ops exceeds ${maxOpsBytes} bytes when serialized` });
    }

    if (expectRev !== undefined && expectRev !== st.projectRev) {
      return reject('stale', staleDetail(st, expectRev));
    }

    let ops;
    let used;
    let applied;
    try {
      ({ ops, used } = resolveUploads(projectId, msg.ops));
      applied = applyOps(st.body, ops);
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      // Malformed (bad-op) and unreachable (bad-path) are identical to submitter: entire batch is not
      // committed. Only four external reasons exist, all recorded as bad-path
      return reject('bad-path', { detail: err.message, index: err.index });
    }

    const entities = entitiesOf(applied.effects, entityOpts);
    const actor = actorOf(principal, session);
    const identity = identityOf(actor);
    const at = clock(ctx);
    const rev = st.projectRev + 1;
    const record = { projectId, rev, opId, ops, actor, at, entities };
    if (undoOf !== undefined) record.undoOf = undoOf;
    // Append to log before updating memory: state remains unchanged on disk failure, core returns internal
    store.append(opsStreamOf(projectId), record);
    for (const key of used ?? []) bodyUploads.delete(key);

    // Overwrite: written entity belonged to another write identity last time and within time window
    // (compute first, then record new writer)
    const overwrote = [];
    const victims = [];
    for (const entity of entities) {
      const prev = st.writers.get(entity);
      if (!prev || prev.identity === identity || at - prev.at > overwriteWindowMs) continue;
      overwrote.push({ entity, by: prev.actor, rev: prev.rev, at: prev.at });
      if (!isUnfollowed(projectId, prev.identity, entity)) victims.push({ identity: prev.identity, entity, writer: prev.actor });
    }
    landCommit(st, record, applied.root);
    st.sinceSnapshot += 1;
    stats.commits += 1;
    stats.overwrites += overwrote.length;
    trackIdentity(connId, identity);

    reply(ctx, connId, { type: 'project.op.ok', projectId, opId, rev, overwrote }, reqId);
    // Overwritten party receives overwritten first, then ops: it must save its revision as a local
    // backup before applying the new revision.
    // `writer` is identity of overwritten write: when multiple sessions run on one connection
    // (e.g., multiple chats on Agent server), dispatches to corresponding session accordingly;
    // so if submitter's own connection also submitted with overwritten identity, it receives it as well
    for (const v of victims) {
      for (const target of identityConns.get(v.identity) ?? []) {
        ctx.send(target, { type: 'project.overwritten', projectId, entity: v.entity, by: actor, writer: shownActor(v.writer), rev, at });
      }
    }
    const broadcast = { type: 'project.ops', projectId, rev, opId, ops, actor, at };
    if (undoOf !== undefined) broadcast.undoOf = undoOf;
    let out = broadcast;
    if (used && Buffer.byteLength(JSON.stringify(broadcast), 'utf8') > PROJECT_LIMITS.INLINE_BYTES) {
      out = { type: 'project.ops', projectId, rev, opId, actor, at, resync: true };
      if (undoOf !== undefined) out.undoOf = undoOf;
    }
    ctx.publish(channelOf(projectId), out, { except: connId });

    if (st.sinceSnapshot >= snapshotEvery) persistState(ctx, projectId, st);
  }

  async function submitAccount(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const opId = checkToken(msg.opId, 'opId');
    const session = checkSession(msg.session);
    const principal = principals.get(connId);
    const actor = actorOf(principal, session);
    if (!operationCoordinator) throw historyError('order-unavailable', 503);
    if (principal.role === 'render' || principal.access === 'r') throw historyError('operation-forbidden', 403);
    if (!Array.isArray(msg.ops) || !msg.ops.length) throw historyError('bad-path', 400);
    if (Buffer.byteLength(JSON.stringify(msg.ops)) > maxOpsBytes) throw historyError('too-large', 413);
    if (msg.expectRev != null && (!Number.isSafeInteger(msg.expectRev) || msg.expectRev < 0)) bad('expectRev must be a non-negative integer');
    const undoOf = msg.undoOf == null ? null : checkToken(msg.undoOf, 'undoOf');
    const request = { opId, ops: msg.ops, expectRev: msg.expectRev ?? null, undoOf, session };
    /*
     * Diagnostics for slow commits (production 2026-10-21: Agent's switch_cut took ~60s to commit,
     * logs could not show where it was stuck; `docs/archive/agent-reports/AGENT-cut-stream-fix.md`
     * Defect 5): logs a line `project.op.slow` when receipt-to-response time exceeds `SLOW_OP_MS`,
     * breaking down queuing (before ordered commit: auth check, project lock) and commit (after
     * acquiring lock) durations.
     */
    const t0 = Date.now();
    let tPrepare = null, tCommitted = null;
    const slow = (outcome) => {
      const ms = Date.now() - t0;
      if (ms < SLOW_OP_MS) return;
      log('project.op.slow', { projectId, opId: String(opId).slice(0, 48), role: principal?.role ?? null, ms, outcome,
        queuedMs: tPrepare === null ? null : tPrepare - t0, landMs: tPrepare === null || tCommitted === null ? null : tCommitted - tPrepare });
    };
    return operationCoordinator.execute({ projectId, principal, actor, request }, (binding) => {
      tPrepare = Date.now();
      const st = stateOf(projectId);
      if (request.expectRev !== null && request.expectRev !== st.projectRev) throw historyError('stale');
      let ops, used, applied;
      try { ({ ops, used } = resolveUploads(projectId, msg.ops)); applied = applyOps(st.body, ops); }
      catch (error) { if (error instanceof OpError) throw historyError('bad-path', 400); throw error; }
      const entities = entitiesOf(applied.effects, entityOpts);
      const at = clock(ctx), rev = st.projectRev + 1, identity = identityOf(actor);
      const record = { projectId, rev, opId, ops, actor, at, entities, ...(undoOf ? { undoOf } : {}) };
      const overwrote = [], victims = [];
      for (const entity of entities) {
        const prev = st.writers.get(entity);
        if (!prev || prev.identity === identity || at - prev.at > overwriteWindowMs) continue;
        overwrote.push({ entity, by: prev.actor, rev: prev.rev, at: prev.at });
        if (!isUnfollowed(projectId, prev.identity, entity)) victims.push({ identity: prev.identity, entity, writer: prev.actor });
      }
      const next = { ...st, writers: new Map(st.writers), history: [...st.history], opIds: new Map(st.opIds) };
      landCommit(next, record, applied.root);
      return { ...binding, projectId, opId, expectedRev: st.projectRev, actor, ops,
        beforeProjection: snapshotOf(projectId, st), projection: snapshotOf(projectId, next), result: { record, overwrote, victims, used: used ?? [] } };
    }, result => {
      tCommitted = Date.now();
      const { operation, duplicate } = result;
      const { record, overwrote, victims, used } = operation.result;
      for (const key of used) bodyUploads.delete(key);
      trackIdentity(connId, identityOf(actor));
      reply(ctx, connId, { type: 'project.op.ok', projectId, opId, rev: record.rev, overwrote: duplicate ? [] : overwrote,
        ...(duplicate ? { duplicate: true } : {}), orderSeq: operation.witness.orderSeq }, reqId);
      if (duplicate) { stats.duplicates++; return; }
      stats.commits++; stats.overwrites += overwrote.length;
      for (const victim of victims) for (const target of identityConns.get(victim.identity) ?? []) {
        ctx.send(target, { type: 'project.overwritten', projectId, entity: victim.entity, by: record.actor,
          writer: shownActor(victim.writer), rev: record.rev, at: record.at });
      }
      const broadcast = { type: 'project.ops', projectId, rev: record.rev, opId, ops: record.ops, actor: record.actor, at: record.at,
        ...(record.undoOf ? { undoOf: record.undoOf } : {}) };
      if (used.length && Buffer.byteLength(JSON.stringify(broadcast)) > PROJECT_LIMITS.INLINE_BYTES) {
        delete broadcast.ops; broadcast.resync = true;
      }
      ctx.publish(channelOf(projectId), broadcast, { except: connId });
    }).then((out) => { slow('ok'); return out; }, (error) => { slow(String(error?.code ?? 'error').slice(0, 40)); throw error; });
  }

  /**
   * Takes a body snapshot, then truncates logs up to snapshot (when storage supports it).
   * On error, only logs: log itself is already complete.
   */
  function persistState(ctx, projectId, st) {
    if (typeof store.writeBlob !== 'function') return;
    try {
      const nowMs = clock(ctx);
      const snap = {
        v: 1,
        projectId,
        rev: st.projectRev,
        at: st.at,
        project: st.body,
        writers: [...st.writers.entries()]
          .filter(([, w]) => nowMs - w.at <= overwriteWindowMs)
          .map(([entity, w]) => [entity, { actor: w.actor, at: w.at, rev: w.rev }]),
        history: st.history.slice(-PROJECT_LIMITS.HISTORY),
        opIds: [...st.opIds.entries()],
      };
      store.writeBlob(stateBlobName(projectId), JSON.stringify(snap));
      st.sinceSnapshot = 0;
      stats.stateSnapshots += 1;
      // Writers outside the time window are no longer needed; discard them along the way
      for (const [entity, w] of st.writers) if (nowMs - w.at > overwriteWindowMs) st.writers.delete(entity);
      if (typeof store.rewrite === 'function') {
        const stream = opsStreamOf(projectId);
        // Only discard records of this project already included in snapshot; keep records of other
        // projects in the same file (differing only in case) as is
        const keep = store.read(stream).filter((r) => r.projectId !== projectId || !(Number.isSafeInteger(r.rev) && r.rev <= snap.rev));
        store.rewrite(stream, keep);
      }
      ctx.log('project.state-snapshot', { projectId, rev: snap.rev });
    } catch (err) {
      ctx.log('project.state-snapshot.failed', { projectId, message: String(err?.message ?? err) });
    }
  }

  function follow(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const session = checkSession(msg.session);
    if (typeof msg.entity !== 'string') bad('entity must be a path string');
    const entity = normalizeEntity(msg.entity, entityOpts);
    if (entity === null) bad('entity must be an empty string or a JSON pointer starting with /');
    if (typeof msg.on !== 'boolean') bad('on must be a boolean');
    const identity = identityOf(actorOf(principals.get(connId), session));
    let byIdentity = unfollowed.get(projectId);
    if (!byIdentity) unfollowed.set(projectId, (byIdentity = new Map()));
    let set = byIdentity.get(identity);
    if (!set) byIdentity.set(identity, (set = new Set()));
    if (msg.on) set.delete(entity);
    else set.add(entity);
    if (set.size === 0) byIdentity.delete(identity);
    if (byIdentity.size === 0) unfollowed.delete(projectId);
    trackIdentity(connId, identity);
    reply(ctx, connId, { type: 'project.following', projectId, entity, on: msg.on }, reqId);
  }

  /**
   * Large root replacement: receives an entire project in chunks, parses once fully collected,
   * awaits `project.op` reference.
   */
  function upload(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const uploadId = checkToken(msg.uploadId, 'uploadId');
    if (principals.get(connId)?.access === 'r') return reply(ctx, connId, { type: 'error', reason: 'forbidden', detail: tr("A read-only connection cannot upload the project") }, reqId);
    const { index, count, data } = msg;
    if (!Number.isSafeInteger(count) || count < 1 || count > PROJECT_LIMITS.UPLOAD_MAX_PARTS) bad(`count must be an integer from 1 to ${PROJECT_LIMITS.UPLOAD_MAX_PARTS}`);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) bad('index must be an integer from 0 to count-1');
    if (typeof data !== 'string') bad('data must be a string');
    if (Buffer.byteLength(data, 'utf8') > PROJECT_LIMITS.UPLOAD_PART_BYTES) bad(`Each part cannot exceed ${PROJECT_LIMITS.UPLOAD_PART_BYTES} bytes`);
    const key = `${projectId}|${uploadId}`;
    const nowMs = Date.now();
    let up = bodyUploads.get(key);
    if (up && (up.count !== count || Object.hasOwn(up, 'value'))) {
      bodyUploads.delete(key);
      up = undefined;
    }
    if (!up) bodyUploads.set(key, (up = { count, parts: new Map(), touched: nowMs }));
    up.parts.set(index, data);
    up.touched = nowMs;
    for (const [k, u] of bodyUploads) if (k !== key && nowMs - u.touched > SNAPSHOT_LIMITS.PENDING_IDLE_MS) bodyUploads.delete(k);
    while (bodyUploads.size > PROJECT_LIMITS.UPLOAD_MAX_PENDING) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, u] of bodyUploads) if (k !== key && u.touched < oldest) { oldest = u.touched; oldestKey = k; }
      if (oldestKey === null) break;
      bodyUploads.delete(oldestKey);
    }
    if (up.parts.size < count) {
      return reply(ctx, connId, { type: 'project.uploaded', projectId, uploadId, received: up.parts.size, count, complete: false }, reqId);
    }
    let text = '';
    for (let i = 0; i < count; i += 1) text += up.parts.get(i);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      bodyUploads.delete(key);
      bad('The received content is not valid JSON');
    }
    if (!isObj(value)) {
      bodyUploads.delete(key);
      bad('The received content must be a JSON object');
    }
    up.parts.clear();
    up.value = value;
    reply(ctx, connId, { type: 'project.uploaded', projectId, uploadId, received: count, count, complete: true }, reqId);
  }

  // ---------- Snapshot: Upload ----------

  function requireBlobStore() {
    if (typeof store.writeBlob !== 'function' || typeof store.readBlob !== 'function') {
      throw new Refused('unsupported', tr("This storage does not support project snapshots"));
    }
  }

  /** Discards uploads idle for too long; discards oldest when exceeding max upload count */
  function evictUploads(nowMs, keep) {
    for (const [key, up] of uploads) {
      if (key !== keep && nowMs - up.touched > SNAPSHOT_LIMITS.PENDING_IDLE_MS) {
        uploads.delete(key);
        stats.uploadsEvicted += 1;
      }
    }
    while (uploads.size > SNAPSHOT_LIMITS.MAX_PENDING_UPLOADS) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, up] of uploads) {
        if (key !== keep && up.touched < oldest) { oldest = up.touched; oldestKey = key; }
      }
      if (oldestKey === null) break;
      uploads.delete(oldestKey);
      stats.uploadsEvicted += 1;
    }
  }

  function snapshotPut(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const projectRev = checkRev(msg.projectRev);
    const digest = checkDigest(msg.digest);
    const { index, count, data } = msg;
    if (!Number.isSafeInteger(count) || count < 1 || count > SNAPSHOT_LIMITS.MAX_PARTS) bad(`count must be an integer from 1 to ${SNAPSHOT_LIMITS.MAX_PARTS}`);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) bad('index must be an integer from 0 to count-1');
    if (typeof data !== 'string') bad('data must be a string');
    if (Buffer.byteLength(data, 'utf8') > SNAPSHOT_LIMITS.PART_BYTES) bad(`Each part cannot exceed ${SNAPSHOT_LIMITS.PART_BYTES} bytes`);
    requireBlobStore();

    const key = `${projectId}@${projectRev}`;
    const announced = digestOfRev(projectId, projectRev);
    if (announced === undefined) {
      uploads.delete(key);
      throw new Refused('unknown-rev', tr("Project {0} has no registered version {1}", projectId, projectRev));
    }
    if (announced !== digest) {
      uploads.delete(key);
      stats.digestMismatches += 1;
      throw new Refused('digest-mismatch', 'The digest does not match the one registered for this version');
    }

    const nowMs = Date.now();
    let up = uploads.get(key);
    // Chunk count changed (publisher retransmitted with a different chunking strategy):
    // receive from scratch using new chunking
    if (up && up.count !== count) {
      uploads.delete(key);
      up = undefined;
    }
    if (!up) {
      up = { projectId, projectRev, digest, count, parts: new Map(), touched: nowMs };
      uploads.set(key, up);
    }
    up.parts.set(index, data);
    up.touched = nowMs;
    evictUploads(nowMs, key);

    if (up.parts.size < up.count) {
      return reply(ctx, connId, { type: 'project.snapshot.stored', projectId, projectRev, received: up.parts.size, count, complete: false }, reqId);
    }

    uploads.delete(key);
    let text = '';
    for (let i = 0; i < up.count; i += 1) text += up.parts.get(i);
    if (sha256(text) !== digest) {
      stats.digestMismatches += 1;
      throw new Refused('digest-mismatch', 'The received content does not match the digest');
    }
    store.writeBlob(snapshotBlobName(projectId, projectRev), text);
    stats.snapshotsStored += 1;
    ctx.log('project.snapshot.stored', { projectId, projectRev, bytes: Buffer.byteLength(text, 'utf8'), count });
    reply(ctx, connId, { type: 'project.snapshot.stored', projectId, projectRev, received: count, count, complete: true }, reqId);
  }

  // ---------- Chunked sending (shared between snapshot retrieval and project.state) ----------

  const wait = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
  const maxPendingOf = (ctx) => (Number.isFinite(ctx.maxPendingBytes) && ctx.maxPendingBytes > 0 ? ctx.maxPendingBytes : DEFAULT_MAX_PENDING_BYTES);
  /**
   * Each chunk does not exceed 256 KiB or one-fourth of backlog limit: throttling threshold is half
   * the limit, leaving headroom after sending a chunk.
   */
  const partBytesOf = (ctx) => Math.max(1024, Math.min(SNAPSHOT_LIMITS.OUT_PART_BYTES, Math.floor(maxPendingOf(ctx) / 4)));

  /**
   * Throttles by backlog, sending a sequence of messages to a connection (J.11): before sending
   * each message, the connection's backlog (core outbound queue + underlying buffer,
   * `ctx.pendingBytes`) must be below half the limit (`ctx.maxPendingBytes`), otherwise re-checks
   * after `pollMs`.
   * Each chunk ≤ min(256 KiB, one-fourth of limit), so backlog after sending does not exceed
   * three-fourths of limit, never reaching 1013. Stops if connection disconnects or is closed by core.
   * When core lacks these two interfaces (test double), assumes 1 MiB limit and 0 backlog,
   * yielding to event loop once between messages.
   */
  async function stream(ctx, connId, sender, messages) {
    const limit = maxPendingOf(ctx);
    const pendingOf = typeof ctx.pendingBytes === 'function' ? (id) => ctx.pendingBytes(id) : () => 0;
    for (let i = 0; i < messages.length; i += 1) {
      if (!sender.alive) return;
      if (i > 0) await nextTurn();
      while (sender.alive && pendingOf(connId) >= limit / 2) await wait(pollMs);
      if (!sender.alive) return;
      if (ctx.send(connId, messages[i]) === false) return;
    }
  }

  /**
   * Enqueues into this connection's send queue (sent sequentially on the same connection,
   * stops on disconnect).
   */
  function enqueue(ctx, connId, messages, type) {
    let sender = senders.get(connId);
    if (!sender) senders.set(connId, (sender = { chain: Promise.resolve(), alive: true }));
    const s = sender;
    s.chain = s.chain
      .then(() => stream(ctx, connId, s, messages))
      .catch((err) => ctx.log('module.error', { module: PROJECT_MODULE, type, message: String(err?.message ?? err) }));
  }

  function snapshotGet(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const projectRev = checkRev(msg.projectRev);
    requireBlobStore();

    const withReq = (m) => (reqId === undefined ? m : { ...m, reqId });
    /*
     * Projects with a body can only provide the current revision (no one uploaded snapshots for older
     * revisions). When requested revision is not current, response includes an extra `currentRev`:
     * render nodes use this to verify tasks at hand against current revision instead (proceed if
     * content unchanged, invalidate if content replaced), not treating "project moved forward" as
     * a failure (`docs/plan/render-queue-contract.md` J.15). Projects without a body omit this field,
     * behaving as before.
     */
    const missing = () => {
      const st = stateOf(projectId);
      const message = { type: 'project.snapshot.part', projectId, projectRev, missing: true };
      if (st.hasBody && st.projectRev !== projectRev) message.currentRev = st.projectRev;
      reply(ctx, connId, message, reqId);
    };
    const digest = digestOfRev(projectId, projectRev);
    if (digest === undefined) return missing();
    let text = store.readBlob(snapshotBlobName(projectId, projectRev));
    if (text === null) {
      // Storage has no file for this revision, but it is the current body: send back directly from the body
      const st = stateOf(projectId);
      if (!st.hasBody || projectRev !== st.projectRev) return missing();
      text = JSON.stringify(st.body);
    }
    if (sha256(text) !== digest) {
      ctx.log('project.snapshot.foreign', { projectId, projectRev });
      return missing();
    }

    const parts = splitSnapshotText(text, partBytesOf(ctx));
    const count = parts.length;
    const messages = parts.map((data, index) => withReq({ type: 'project.snapshot.part', projectId, projectRev, index, count, data }));
    messages.push(withReq({ type: 'project.snapshot.end', projectId, projectRev, digest }));
    stats.snapshotsServed += 1;
    enqueue(ctx, connId, messages, 'project.snapshot.get');
  }

  const HANDLERS = {
    'project.open': open,
    'project.announce': announce,
    'project.close': close,
    'project.op': submit,
    'project.follow': follow,
    'project.upload': upload,
    'project.snapshot.put': snapshotPut,
    'project.snapshot.get': snapshotGet,
  };

  return {
    name: PROJECT_MODULE,
    types: ['project.'],
    channels: ['project'],

    connect(ctx, connId, principal) {
      lastCtx = ctx;
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      // Channel subscriptions are cleaned up by core upon disconnect
      principals.delete(connId);
      const sender = senders.get(connId);
      if (sender) {
        sender.alive = false;
        senders.delete(connId);
      }
      for (const identity of connIdentities.get(connId) ?? []) {
        const set = identityConns.get(identity);
        if (!set) continue;
        set.delete(connId);
        if (set.size === 0) identityConns.delete(identity);
      }
      connIdentities.delete(connId);
    },

    handle(ctx, connId, msg) {
      lastCtx = ctx;
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: 'The project module does not support this message' }, reqId);
      const principal = principals.get(connId);
      if (principal?.realm === 'account' || principal?.identityVersion === 2) {
        return Promise.resolve().then(async () => {
          if (msg.type === 'project.op') return submitAccount(ctx, connId, msg, reqId);
          const projectId = checkProjectId(msg.projectId);
          // Existing authority-gated readers remain usable before the owner mounts order.
          // A projection that already belongs to order can never be read without recovery.
          if (!operationCoordinator) {
            const text = store.readBlob?.(stateBlobName(projectId));
            if (text && JSON.parse(text).orderProjection) throw historyError('order-unavailable', 503);
            return fn(ctx, connId, msg, reqId);
          }
          return operationCoordinator.read(projectId, principal, () => {
            if (msg.type === 'project.announce' && !stateOf(projectId).hasBody) throw historyError('operation-required');
            return fn(ctx, connId, msg, reqId);
          }, ['project.upload', 'project.snapshot.put'].includes(msg.type) ? 'write' : 'read');
        }).catch(error => {
          const reason = error instanceof BadMessage ? 'bad-message' : error.code ?? 'operation-unavailable';
          if (msg.type === 'project.op') {
            stats.rejected++;
            // Stale is only evaluated after authorization passes and entering ordered commit: includes current
            // revision and interim changes like non-account path, and model re-reads accordingly.
            // Other rejection reasons (unauthorized, ordering service unavailable...) omit revision number,
            // avoiding revealing project progress to unauthorized connections.
            const stale = reason === 'stale' && Number.isSafeInteger(msg.expectRev) && msg.expectRev >= 0 && PROJECT_ID_RE.test(String(msg.projectId))
              ? (() => { const st = stateOf(msg.projectId); return { currentRev: st.projectRev, ...staleDetail(st, msg.expectRev) }; })() : {};
            return reply(ctx, connId, { type: 'project.op.rejected', projectId: msg.projectId, opId: msg.opId, reason, ...stale }, reqId);
          }
          return reply(ctx, connId, { type: 'error', reason }, reqId);
        });
      }
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof Refused) return reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
        if (!(err instanceof BadMessage)) throw err;
        reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
      }
    },

    describe() {
      return {
        projects: [...projects.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([projectId, st]) => ({ projectId, projectRev: st.projectRev, digest: st.digest, at: st.at, hasBody: st.hasBody })),
        snapshots: { ...stats, pendingUploads: uploads.size, bodyUploads: bodyUploads.size },
      };
    },

    /**
     * Broadcasts a message via the project channel (C6.5 Section 7: tool call events go through
     * the project channel). Used by other modules in the same space; channel name and subscriptions
     * are managed by this module. Returns 0 when no connection has connected yet.
     * @param {string} projectId
     * @param {object} message
     * @param {{ except?: string }} [opts]
     */
    publishToProject(projectId, message, opts) {
      if (!lastCtx || typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return 0;
      return lastCtx.publish(channelOf(projectId), message, opts);
    },

    /** Current revision number (for other modules and diagnostics); returns 0 for unseen projects */
    revOf(projectId) {
      return PROJECT_ID_RE.test(projectId) ? stateOf(projectId).projectRev : 0;
    },
    /** Server-internal snapshot inspection; never expose the mutable cached body. */
    bodyOf(projectId) {
      if (!PROJECT_ID_RE.test(projectId)) return null;
      if (operationCoordinator && !operationCoordinator.isReady(projectId)) return null;
      const state = stateOf(projectId);
      return state.hasBody ? structuredClone(state.body) : null;
    },
  };
}

/** Alias: aligned with naming conventions of other factories */
export const createProjectModule = projectModule;
export default projectModule;
