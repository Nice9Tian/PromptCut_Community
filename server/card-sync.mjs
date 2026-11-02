/**
 * Card source code sync (C6.6 design doc `docs/plan/c66-design.md` section 5;
 * `docs/plan/cloud-task.md` A6, B2).
 *
 * The editor process (not the page) uses its own WebSocket connection to write card source code
 * into the content store of the **current project space**
 * (`content.put({ kind: 'card-source', key: <repo-relative path>, body: <source code> })`),
 * and installs others' versions locally according to changes in the content store.
 *
 * # Write
 * - Every time a card file is saved (`edit_card`, `create_card`, install), call `saved(rel)`:
 *   mark as "pending upload", call `content.put` immediately; `rev` in the response becomes the
 *   new `cardRev`. The local machine records `{ rev, hash, mine }` from this file's last sync
 *   (`hash` uses the same algorithm as content store, `sha256(JSON.stringify(source))`, where
 *   source normalizes CRLF to LF first). When disconnected, keep in "pending upload" and
 *   upload catch-up upon connecting.
 * - When opening a shared project (`bind` with `keys`), upload user cards and modified built-in
 *   cards used by the project that are not yet on the server.
 *
 * # Read (shared projects only; this half is a no-op for local project `local` space, `cardRev`
 *   increments as usual)
 * - After connecting, call `content.watch(['card-source'])`, then `content.list('card-source')`,
 *   and process each item according to the rules below;
 * - Process each subsequent `content.changed` the same way (sync on the fly when others modify cards).
 * - Rules (`rec` is local record, `cur` is local content right now):
 *   - Server version is not newer than `rec.rev`: install nothing; if modified locally after that,
 *     upload (upload if modified locally, A6);
 *   - Server updated:
 *     - Local machine does not have this file, or content is already identical → install / record only;
 *     - Local machine has not modified it (`cur` matches `rec.hash`) → install;
 *     - Both local and server modified → last write wins: back up local copy first, install
 *       server version, and show overwrite notice;
 *     - Local copy was written by this client last time (`rec.mine`) and is now overwritten by
 *       someone else → likewise back up first then install, and notify (B2, B3: overwritten party
 *       must know).
 *     - **Changes during offline periods** (detected during reconciliation upon reconnecting:
 *       synced card was modified locally afterwards and updated on server as well) → do not use
 *       "last write wins": back up local copy first, install server version, and emit `conflict`
 *       (with both local and cloud source code); page places it in "conflict merge" window (one
 *       per card), where user chooses "Merge" (keep local, `takeMine`) or "Delete selected"
 *       (keep cloud state). Semantics: `workflow/editing.md` "Undo, redo",
 *       `product/document-service.md` "Conflicts" (user decision, 2026-10-22).
 * - When our own write returns in the channel (`actor.session` is this instance's), if
 *   `previousActor` belongs to someone else, notify "You overwrote X" (overwriting party must know).
 * - When an upload for the same key is in flight, changes for this key wait until upload response
 *   arrives before processing: version number from earlier response is ours, and older changes
 *   are discarded directly to avoid mistaking someone else's earlier version for "server updated".
 *
 * # Scope
 * Only sync `.tsx` / `.ts` / `.css` under `src/cards/` and `src/parts/` (excluding test files),
 * and only sync user cards and modified built-in cards; unmodified built-in cards exist on both sides
 * and are not synced (section 5 [ruling]). "Modified" is determined by caller's `files.changed(rel)`.
 *
 * How files are read, installed (review, write to overlay layer, hot reload, re-test), and backed up
 * are all injected by caller (`server/vite-plugin-cards.ts`). This module only manages rules,
 * bookkeeping, and connections; depends only on Node built-in modules, and WebSocket endpoints
 * can be injected (tests do not need to start the editor).
 *
 * # Connection
 * The default connection is a **session** (`createDocEndpoint` in
 * `server/render-node/session-link.mjs`, HT-a contract `docs/plan/http-transport-contract.md`
 * section 9; semantics `docs/semantics/product/document-service.md` "Sessions and transports"):
 * Transport disconnect only detaches the session; resuming within retention period ensures
 * requests sent and server-sent `content.changed` during that time are neither lost nor duplicated,
 * so resume (`onResume`) does not re-subscribe or re-reconcile; only when session ends (`onClose`)
 * is it considered disconnected, after which creating a new session (`onOpen`) re-runs
 * `content.watch` and reconciliation. `protocols()` is called only when creating a new session
 * (shared projects must request a ticket from the page), not on resume. For legacy servers without
 * a session layer, the endpoint degrades to "one transport per session", behaving the same as the
 * original `createWsEndpoint`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createDocEndpoint } from './render-node/session-link.mjs';
import { tr } from './i18n.mjs';

export const CARD_SOURCE = 'card-source';

export const CARD_SYNC_DEFAULTS = Object.freeze({
  /** Maximum wait time for a content store request response */
  requestTimeoutMs: 10_000,
  /** Retry delay after upload failure (not a disconnect) */
  retryMs: 3_000,
  /** How many recent notifications to keep (inspected via diagnostic endpoint) */
  noticesKeep: 50,
});

const SYNC_EXT = /\.(tsx|ts|css)$/;

/** Normalize line endings: local files may be CRLF; comparing content between both sides should not treat line ending differences as modifications */
export function normalizeSource(source) {
  return String(source).replace(/\r\n/g, '\n');
}

/** Same algorithm as content store (`docservice-contract.md` section 2: `sha256(JSON.stringify(body))`); body is the source code string */
export function sourceHash(source) {
  return createHash('sha256').update(JSON.stringify(normalizeSource(source)), 'utf8').digest('hex');
}

/** Whether this repo-relative path is within sync scope (checks shape only; "whether modified" judged separately) */
export function isSyncablePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return false;
  if (rel.includes('\\') || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (!(rel.startsWith('src/cards/') || rel.startsWith('src/parts/'))) return false;
  if (/\.test\.(ts|tsx|mjs)$/.test(rel)) return false;
  return SYNC_EXT.test(rel);
}

/** Record filename for space: one for local projects (`local`), one for each shared project */
export function spaceIdOf({ local, projectId }) {
  if (local) return 'local';
  return `shared-${createHash('sha256').update(`shared\n${projectId}`, 'utf8').digest('hex').slice(0, 16)}`;
}

/** Read and write sync records: `<stateDir>/<spaceId>.json`, `{ records: { [rel]: { rev, hash, mine } }, pending: string[] }` */
function createLedger(stateDir, spaceId) {
  const file = stateDir ? path.join(stateDir, `${spaceId}.json`) : null;
  let records = {};
  let pending = new Set();
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw.records === 'object' && raw.records) records = raw.records;
      if (Array.isArray(raw?.pending)) pending = new Set(raw.pending.filter(isSyncablePath));
    } catch { /* Missing or corrupted: treat as empty, re-record on next sync */ }
  }
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ records, pending: [...pending].sort() }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch { /* Failure to persist only affects decisions on next startup, not this sync */ }
  };
  return {
    get: (rel) => records[rel] ?? null,
    set(rel, rec) { records[rel] = rec; save(); },
    pending: () => [...pending],
    isPending: (rel) => pending.has(rel),
    mark(rel) { if (!pending.has(rel)) { pending.add(rel); save(); } },
    unmark(rel) { if (pending.delete(rel)) save(); },
    snapshot: () => ({ records: structuredClone(records), pending: [...pending].sort() }),
  };
}

/** Session state in diagnostics (available only when endpoint has `stats()`): transport actually used (null when detached), whether detached, resume and detach counts, whether degraded against a legacy server */
function linkDiag(endpoint) {
  let st = null;
  try { st = typeof endpoint?.stats === 'function' ? endpoint.stats() : null; } catch { st = null; }
  if (!st) return null;
  return { transport: st.transport ?? null, detached: st.detached === true, detaches: st.detaches ?? 0, resumes: st.resumes ?? 0, legacy: st.legacy === true };
}

const sameActor =(a, b) => !!a && !!b && a.userId === b.userId && (a.deviceId ?? null) === (b.deviceId ?? null) && (a.role ?? null) === (b.role ?? null);

/**
 * @param {object} o
 * @param {string | null} o.stateDir Local record directory (`<root>/.pc-work/card-sync`); null = memory only (tests)
 * @param {object} o.files File operations (all synchronous or returning Promise are fine):
 *   - `read(rel) → string | null`: Content active on this machine right now (overlay layer takes precedence); returns null if none;
 *   - `changed(rel) → boolean`: Whether this file counts as a "user card or modified built-in card" (untracked local files use this to determine if modified locally);
 *   - `install(rel, source, { rev }) → { ok: boolean, error?: string }`: Install server version (review, write overlay layer, hot reload, re-test), where `rev` is this version's cardRev;
 *   - `backup(rel, content) → string`: Save local copy before overwriting; returns relative path of backup.
 * @param {(o: { url: string, protocols: () => Promise<string[]> | string[] }) => object} [o.connect]
 *   Create an endpoint (`createDocEndpoint` shape in `server/render-node/session-link.mjs`: send, onMessage, onOpen, onClose, close,
 *   optional onResume); default uses `createDocEndpoint` (session: resumes within retention period on transport disconnect; exponential backoff to create new session after session ends, fetching subprotocols on demand beforehand)
 * @param {(event: object) => void} [o.notify] Overwrite notices, installed, rejected, and other events (plugin forwards to page via HMR)
 * @param {(event: string, fields?: object) => void} [o.log]
 * @param {boolean} [o.readOnly]  Read-only (used by standalone render hosts, c66-host-cards): only installs server versions, never uploads, does not track pending uploads:
 *   host does not modify cards; differences between local and server copies can only come from other projects installed here, and cannot be written back into this project
 */
export function createCardSync({
  stateDir = null,
  files,
  connect = null,
  notify = () => {},
  log = () => {},
  session = `cards-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  requestTimeoutMs = CARD_SYNC_DEFAULTS.requestTimeoutMs,
  retryMs = CARD_SYNC_DEFAULTS.retryMs,
  noticesKeep = CARD_SYNC_DEFAULTS.noticesKeep,
  readOnly = false,
} = {}) {
  if (!files || typeof files.read !== 'function' || typeof files.install !== 'function' || typeof files.backup !== 'function') {
    throw new TypeError('createCardSync: files must have read, install, backup');
  }
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failures do not affect sync */ } };
  if (connect !== null && typeof connect !== 'function') throw new TypeError('createCardSync: connect must be a function');
  const connectTo = connect ?? (({ url, protocols }) => createDocEndpoint({ url, protocols, log: (event, fields) => say(`doc.${event}`, fields) }));
  const changedOf = typeof files.changed === 'function' ? files.changed : () => true;
  const notices = [];
  const emit = (event) => {
    const e = { at: Date.now(), ...event };
    notices.push(e);
    if (notices.length > noticesKeep) notices.splice(0, notices.length - noticesKeep);
    try { notify(e); } catch { /* Page failing to receive notices does not affect sync */ }
  };

  /** Current binding; null = unbound (not yet attached to any space) */
  let b = null;
  let reqSeq = 0;

  function makeBinding({ projectId = null, url, protocols, local = false, keys = [] }) {
    const spaceId = spaceIdOf({ local, projectId });
    const ledger = createLedger(stateDir, spaceId);
    const endpoint = connectTo({ url, protocols });
    const binding = {
      spaceId, projectId, url, local, endpoint, ledger,
      keys: new Set((keys ?? []).filter(isSyncablePath)),
      waiting: new Map(),
      /** rel → in-flight upload Promise */
      inflight: new Map(),
      /** Serial processing: list reconciliation, channel changes, and uploads share one queue; only one item is processed at a time */
      chain: Promise.resolve(),
      connected: false,
      opens: 0,
      /** Number of successful resumes after transport disconnect (session intact: no re-subscribe, no re-reconciliation) */
      resumes: 0,
      retryTimer: null,
      closed: false,
    };
    endpoint.onMessage((msg) => onMessage(binding, msg));
    endpoint.onOpen(() => {
      binding.connected = true;
      binding.opens += 1;
      say('cards.sync.open', { spaceId, projectId, opens: binding.opens });
      if (!local) binding.endpoint.send({ type: 'content.watch', kinds: [CARD_SOURCE], reqId: `cards#watch-${++reqSeq}` });
      enqueue(binding, () => reconcile(binding));
    });
    // Resume: same session, subscriptions intact; responses and changes during detach are backfilled and deduplicated in order by session layer; only counts here
    if (typeof endpoint.onResume === 'function') {
      endpoint.onResume(() => {
        binding.resumes += 1;
        say('cards.sync.resume', { spaceId, projectId, resumes: binding.resumes });
      });
    }
    endpoint.onClose((info) => {
      binding.connected = false;
      for (const [, w] of binding.waiting) {
        clearTimeout(w.timer);
        w.reject(Object.assign(new Error('Connection lost'), { code: 'disconnected' }));
      }
      binding.waiting.clear();
      say('cards.sync.close', { spaceId, code: info?.code ?? null });
    });
    return binding;
  }

  function enqueue(binding, fn) {
    const next = binding.chain.then(() => (binding.closed ? undefined : fn())).catch((err) => {
      say('cards.sync.error', { spaceId: binding.spaceId, message: String(err?.message ?? err) });
    });
    binding.chain = next;
    return next;
  }

  function request(binding, type, fields) {
    return new Promise((resolve, reject) => {
      if (!binding.connected) return reject(Object.assign(new Error('Not connected to the document service'), { code: 'disconnected' }));
      const reqId = `cards#${++reqSeq}`;
      const timer = setTimeout(() => {
        binding.waiting.delete(reqId);
        reject(Object.assign(new Error(`${type} timed out`), { code: 'timeout' }));
      }, requestTimeoutMs);
      timer.unref?.();
      binding.waiting.set(reqId, { resolve, reject, timer, type });
      let sent = false;
      try { sent = binding.endpoint.send({ type, ...fields, reqId }) !== false; } catch { sent = false; }
      if (!sent && binding.waiting.has(reqId)) {
        binding.waiting.delete(reqId);
        clearTimeout(timer);
        reject(Object.assign(new Error('Not sent'), { code: 'disconnected' }));
      }
    });
  }

  function onMessage(binding, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (typeof msg.reqId === 'string' && binding.waiting.has(msg.reqId)) {
      const w = binding.waiting.get(msg.reqId);
      binding.waiting.delete(msg.reqId);
      clearTimeout(w.timer);
      if (msg.type === 'error') w.reject(Object.assign(new Error(`${w.type}: ${msg.reason ?? 'error'}`), { code: msg.reason ?? 'error', detail: msg.detail }));
      else w.resolve(msg);
      return;
    }
    if (msg.type === 'content.changed' && msg.kind === CARD_SOURCE && !binding.local) {
      const change = { key: msg.key, hash: msg.hash, rev: msg.rev, actor: msg.actor ?? null, previousActor: msg.previousActor ?? null };
      if (!isSyncablePath(change.key) || !Number.isSafeInteger(change.rev)) return;
      // Upload in flight for the same key: wait for response before processing (response records our version number first, older changes are discarded)
      const pending = binding.inflight.get(change.key);
      const run = () => enqueue(binding, () => onChanged(binding, change));
      if (pending) pending.finally(run);
      else run();
    }
  }

  /* ---------------- Read: reconciliation and changes ---------------- */

  async function hashOfLocal(rel) {
    const cur = await files.read(rel);
    return { cur: cur ?? null, curHash: cur == null ? null : sourceHash(cur) };
  }

  async function reconcile(binding) {
    const seen = new Set();
    if (!binding.local) {
      const listing = await request(binding, 'content.list', { kind: CARD_SOURCE, prefix: 'src/' });
      const items = Array.isArray(listing.items) ? listing.items : [];
      if (listing.truncated) say('cards.sync.truncated', { spaceId: binding.spaceId, shown: items.length });
      for (const item of items) {
        if (!isSyncablePath(item?.key) || !Number.isSafeInteger(item.rev)) continue;
        seen.add(item.key);
        await handleRemote(binding, item, { actor: null, previousActor: null, fromList: true });
      }
    }
    // Pending upload, plus files used by project not yet on server: upload (read-only does not upload)
    if (readOnly) return;
    const want = new Set(binding.ledger.pending());
    if (!binding.local) for (const k of binding.keys) if (!seen.has(k)) want.add(k);
    for (const rel of [...want].sort()) {
      if (seen.has(rel) && !binding.ledger.isPending(rel)) continue;
      await upload(binding, rel, { reason: binding.ledger.isPending(rel) ? 'pending' : 'project' });
    }
  }

  async function onChanged(binding, change) {
    const rec = binding.ledger.get(change.key);
    const own = change.actor && change.actor.session === session;
    if (own) {
      // Our own write has returned. If it overwrote someone else (not this device itself), notify the overwriting party
      const prev = change.previousActor;
      if (prev && prev.session !== session && !sameActor(prev, change.actor)) {
        emit({ type: 'overwrote', key: change.key, rev: change.rev, previousActor: prev });
      }
      return;
    }
    if (rec && rec.rev >= change.rev) return;
    await handleRemote(binding, { key: change.key, hash: change.hash, rev: change.rev }, change);
  }

  async function handleRemote(binding, item, { actor, previousActor, fromList = false }) {
    const rel = item.key;
    const rec = binding.ledger.get(rel);
    const { cur, curHash } = await hashOfLocal(rel);
    if (rec && rec.rev >= item.rev) {
      // Server is not newer than local record: upload if modified locally afterwards (and not currently uploading)
      if (!readOnly && fromList && cur !== null && curHash !== rec.hash && !binding.ledger.isPending(rel)) {
        binding.ledger.mark(rel);
      }
      return;
    }
    if (curHash !== null && curHash === item.hash) {
      binding.ledger.set(rel, { rev: item.rev, hash: item.hash, mine: false });
      binding.ledger.unmark(rel);
      return;
    }
    const got = await request(binding, 'content.get', { kind: CARD_SOURCE, key: rel });
    if (got.missing === true || typeof got.body !== 'string') {
      say('cards.sync.skip', { key: rel, reason: got.missing ? 'missing' : 'not-string' });
      return;
    }
    const rev = Number.isSafeInteger(got.rev) ? got.rev : item.rev;
    const serverHash = sourceHash(got.body);
    if (curHash === serverHash) {
      binding.ledger.set(rel, { rev, hash: serverHash, mine: false });
      binding.ledger.unmark(rel);
      return;
    }
    // Whether local copy is "ours": unsynced modifications, or written by ourselves last time
    let localChanged = false;
    if (cur !== null) {
      if (rec) localChanged = curHash !== rec.hash || binding.ledger.isPending(rel);
      else localChanged = !!(await changedOf(rel));
    }
    const mineOverwritten = !!(cur !== null && rec?.mine && curHash === rec.hash);
    const overwritten = localChanged || mineOverwritten;
    // Changes while offline (or closed): detected during reconciliation upon reconnecting that local
    // was modified after last sync and server also updated → enter "conflict merge", do not silently
    // replace via last write wins.
    // Only applies to previously synced cards (`rec` exists): if local happens to have a same-named card
    // when opening project for first time, still treat as overwrite
    const conflict = !readOnly && fromList && !!rec && localChanged && cur !== null;
    let backup = null;
    if (overwritten) {
      try {
        backup = await files.backup(rel, cur);
      } catch (err) {
        // Do not overwrite if backup fails: rather be temporarily inconsistent than lose the local copy
        say('cards.sync.backup-failed', { key: rel, message: String(err?.message ?? err) });
        emit({ type: 'rejected', key: rel, rev, error: tr("Local backup failed, not overwritten: {0}", err?.message ?? err) });
        return;
      }
    }
    let res;
    try {
      res = await files.install(rel, got.body, { rev });
    } catch (err) {
      res = { ok: false, error: String(err?.message ?? err) };
    }
    if (!res?.ok) {
      // Failed to install (failed review, etc.): record this version to avoid retrying on every change; keep local content as-is
      binding.ledger.set(rel, { rev, hash: curHash, mine: false, rejected: true });
      say('cards.sync.rejected', { key: rel, rev, error: res?.error ?? null });
      emit({ type: 'rejected', key: rel, rev, error: res?.error ?? tr("Could not install"), actor });
      return;
    }
    binding.ledger.set(rel, { rev, hash: serverHash, mine: false });
    binding.ledger.unmark(rel);
    say('cards.sync.installed', { key: rel, rev, overwritten, backup, conflict });
    emit({ type: 'installed', key: rel, rev, actor, fresh: cur === null, ...(overwritten ? { backup } : {}) });
    if (conflict) emit({ type: 'conflict', key: rel, rev, actor, backup, mine: normalizeSource(cur), cloud: normalizeSource(got.body) });
    else if (overwritten) emit({ type: 'overwritten', key: rel, rev, actor, previousActor, backup });
  }

  /* ---------------- Write: upload ---------------- */

  function upload(binding, rel, { reason }) {
    const run = (async () => {
      const content = await files.read(rel);
      if (content == null) {
        binding.ledger.unmark(rel);
        return null;
      }
      const body = normalizeSource(content);
      try {
        const stored = await request(binding, 'content.put', { kind: CARD_SOURCE, key: rel, body, session });
        const rev = Number.isSafeInteger(stored.rev) ? stored.rev : null;
        const hash = sourceHash(body);
        const prev = binding.ledger.get(rel);
        // A newer version (someone else's) arrived while in flight: if that version was already processed, do not roll back
        if (!(prev && rev !== null && prev.rev > rev)) binding.ledger.set(rel, { rev, hash, mine: true });
        // Modified locally again during upload: remains in pending upload
        const after = await files.read(rel);
        if (after != null && sourceHash(after) === hash) binding.ledger.unmark(rel);
        say('cards.sync.put', { key: rel, rev, reason });
        return rev;
      } catch (err) {
        say('cards.sync.put-failed', { key: rel, reason, code: err?.code ?? null, message: String(err?.message ?? err) });
        if (err?.code === 'too-large' || err?.code === 'bad-message') {
          binding.ledger.unmark(rel);
          emit({ type: 'rejected', key: rel, error: tr("The document service does not accept this file ({0})", err.code) });
        } else if (err?.code !== 'disconnected' && !binding.retryTimer && !binding.closed) {
          binding.retryTimer = setTimeout(() => {
            binding.retryTimer = null;
            if (!binding.closed && binding.connected) enqueue(binding, () => flushPending(binding));
          }, retryMs);
          binding.retryTimer.unref?.();
        }
        return null;
      }
    })();
    binding.inflight.set(rel, run);
    run.finally(() => { if (binding.inflight.get(rel) === run) binding.inflight.delete(rel); });
    return run;
  }

  async function flushPending(binding) {
    for (const rel of binding.ledger.pending().sort()) await upload(binding, rel, { reason: 'pending' });
  }

  function saved(rel) {
    if (readOnly || !isSyncablePath(rel)) return false;
    const binding = b;
    if (!binding) return false;
    binding.ledger.mark(rel);
    if (!binding.local) binding.keys.add(rel);
    if (binding.connected) enqueue(binding, () => upload(binding, rel, { reason: 'saved' }));
    return true;
  }

  /* ---------------- External ---------------- */

  function unbindCurrent(reason) {
    const cur = b;
    if (!cur) return;
    b = null;
    cur.closed = true;
    clearTimeout(cur.retryTimer);
    for (const [, w] of cur.waiting) { clearTimeout(w.timer); w.reject(Object.assign(new Error('Unbound'), { code: 'disconnected' })); }
    cur.waiting.clear();
    try { cur.endpoint.close(); } catch { /* Already closed */ }
    say('cards.sync.unbind', { spaceId: cur.spaceId, reason });
  }

  return {
    session,

    /**
     * Attach to a space: local project (`local: true`, upload only) or shared project (both read and write).
     * Calling with the same binding again only updates `keys`.
     * `keys`: files to include for this project (user cards and modified built-in cards); those not yet on
     * the server will be uploaded.
     */
    bind({ projectId = null, url, protocols, local = false, keys = [] } = {}) {
      if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new TypeError('bind: url must be a ws(s):// address');
      if (!local && (typeof projectId !== 'string' || !projectId)) throw new TypeError('bind: a shared project needs projectId');
      if (b && b.url === url && b.local === local && (local || b.projectId === projectId)) {
        this.setKeys(keys);
        return { spaceId: b.spaceId, rebound: false };
      }
      unbindCurrent('rebind');
      b = makeBinding({ projectId, url, protocols, local, keys });
      say('cards.sync.bind', { spaceId: b.spaceId, projectId, local, keys: b.keys.size });
      return { spaceId: b.spaceId, rebound: true };
    },

    /** Files to include for the project changed (cards added to timeline): upload new files not yet on the server */
    setKeys(keys = []) {
      if (!b) return;
      const binding = b;
      const next = new Set((keys ?? []).filter(isSyncablePath));
      const added = [...next].filter((k) => !binding.keys.has(k));
      binding.keys = next;
      if (readOnly || !added.length || binding.local || !binding.connected) return;
      enqueue(binding, async () => {
        for (const rel of added.sort()) {
          if (binding.ledger.get(rel)) continue; // Previously synced (present on server) files are handled by reconciliation and changes
          await upload(binding, rel, { reason: 'project' });
        }
      });
    },

    unbind(reason = 'unbind') {
      unbindCurrent(reason);
    },

    /**
     * A card file was saved locally (edit_card, create_card, install): mark as pending upload and upload immediately.
     * Paths outside sync scope are ignored; when unbound, record only without uploading (catch-up upload when attached to the same space next time).
     */
    saved(rel) {
      return saved(rel);
    },

    /**
     * Clicked "Merge" for a card in "conflict merge": reinstall local source code onto this machine
     * (same review, file writing, hot reload flow), then treat as a local save and upload.
     * Returns `{ ok, error? }`. Do not upload if installation fails (failed review).
     */
    async takeMine(rel, source) {
      if (readOnly) return { ok: false, error: 'A read-only sync instance does not modify cards' };
      if (!isSyncablePath(rel) || typeof source !== 'string') return { ok: false, error: 'Not a syncable card file' };
      let res;
      try { res = await files.install(rel, normalizeSource(source), { rev: null }); }
      catch (err) { res = { ok: false, error: String(err?.message ?? err) }; }
      if (!res?.ok) return { ok: false, error: res?.error ?? tr("Could not install") };
      saved(rel);
      say('cards.sync.take-mine', { key: rel });
      return { ok: true };
    },

    /** Wait until ongoing work (reconciliation, upload, card installation) is finished; for testing and diagnostics */
    async idle() {
      for (;;) {
        const binding = b;
        if (!binding) return;
        const chain = binding.chain;
        await chain;
        await Promise.allSettled([...binding.inflight.values()]);
        if (binding === b && binding.chain === chain && binding.inflight.size === 0) return;
      }
    },

    status() {
      const binding = b;
      return {
        bound: !!binding,
        session,
        ...(binding ? {
          spaceId: binding.spaceId,
          projectId: binding.projectId,
          local: binding.local,
          url: binding.url,
          connected: binding.connected,
          opens: binding.opens,
          resumes: binding.resumes,
          link: linkDiag(binding.endpoint),
          keys: [...binding.keys].sort(),
          ...binding.ledger.snapshot(),
        } : {}),
        notices: notices.slice(),
      };
    },

    close() {
      unbindCurrent('close');
    },
  };
}

export default createCardSync;
