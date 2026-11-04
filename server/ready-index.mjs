import { mergeRanges } from './snapshot-store.mjs';

/**
 * C3 ready index: records "which local frames currently exist for this layer" **by layer**, and
 * pushes changes to the page.
 *
 * One layer = (clip clipId, tier kind). The `stream` table and `html` table for the same heavy card
 * coexist without overwriting each other: stream paste during playback, snapshot paste during scrub;
 * the two paths query independently.
 *
 * # Three synonyms for tier names
 *
 *   Directory `controls-html`  ↔ `'shared'` of `snapshotTier()` ↔ online `kind: 'html'`
 *   Directory `controls-local` ↔ `'local'` of `snapshotTier()`  ↔ online `kind: 'local'`
 *   Track stream (R8)                                           ↔ online `kind: 'stream'`
 *
 * The return value of `snapshotTier` is mapped to `kind` by callers using `kindOfTier`.
 * `kind: 'random' | 'stepped'` in K1 records is the probe method, same word for different things.
 *
 * # Three message types (fixed format, C3)
 *
 *   { type: 'reset', localRev }                       Project version changed, page clears tables
 *   { type: 'layer', clipId, kind, key, ranges, groupClipIds?, originFrame?, streamKind?, inputSig? }
 *                                                     Currently **all** ready local frames for this layer
 *                                                     Closed intervals, **always full, never delta**
 *                                                     The interval unit of the `stream` layer is segment
 *                                                     number, with an additional `originFrame`: the
 *                                                     first frame of this stream itself (project frame
 *                                                     number); the page uses it to convert frame
 *                                                     numbers to segment numbers
 *                                                     (`src/render/streamSegments.mjs`); `stream` layers
 *                                                     without it are not pasted by the page
 *   { type: 'done', localRev }                        All anchor frames ready (C2 gate)
 *
 * Full semantics is intentional: losing one message will not leave a permanent gap in the page
 * table, as the next message for the same layer will make it up; upon reconnecting, the server sends
 * `reset` first and then full `layer`, so polling endpoints is not needed (J3 / F5 share this path).
 *
 * # Why `layer` must wait for the project to arrive (F5)
 *
 * Disk scanning only yields "key → ranges": directory names are shared keys stripped of clipId,
 * whereas `layer` and the page's `readyIndex` are indexed by clipId. Therefore, after restart,
 * ranges are first staged on keys (`stageByKey`), and once the card plan is computed
 * (`control.clipId` ↔ `control.snapshotKey`), reverse lookup and full `layer` emissions take place.
 * Not a single `layer` is sent before the project arrives.
 *
 * # Sharding by session (Item 4)
 *
 * In the prerender process it is `createReadyHub`: one index per page session; the session's current
 * version is set solely by the page's preload, and sending layers passes gates by entry. See notes
 * on `createReadyHub` at the end of the file.
 */

/** `snapshotTier()` → online `kind`; returns null for tiers that do not produce snapshots */
export function kindOfTier(tier) {
  if (tier === 'shared') return 'html';
  if (tier === 'local') return 'local';
  return null;
}

export const READY_KINDS = ['html', 'local', 'stream'];

/**
 * Online `key` (C3 / J3): the shared tier is simply the shared key; the local tier **comes with a
 * slash**: `<entry.key>/<shared-key>`, because the same shared key has a separate local tier subtree
 * under each project. Directory layout (two-tier directory of `snapshot-store.mjs`) aligns with online
 * keys here, and nowhere else.
 */
export function wireSnapshotKey(tier, entryKey, snapshotKey) {
  if (!snapshotKey) return null;
  if (tier === 'shared') return snapshotKey;
  if (tier === 'local') return entryKey ? `${entryKey}/${snapshotKey}` : null;
  return null;
}

const layerId = (clipId, kind) => `${kind}:${clipId}`;
/** First frame included in `stream` layers (only included for non-negative integers); other tiers do not include this item */
const originOf = (kind, originFrame) => (kind === 'stream' && Number.isInteger(originFrame) && originFrame >= 0 ? { originFrame } : {});
/**
 * Two additional fields included for layers of below-dependent streams (`belowLayerMark` in
 * `server/frame-stream.mjs`): `streamKind: 'below'` (page pastes by stage coordinates) and
 * `inputSig` (input signature of the project version that produced this stream; page does not paste
 * if mismatched). Not included in other layers or tiers; outgoing messages remain completely unchanged.
 */
const belowOf = (kind, item) => (kind === 'stream' && item?.streamKind === 'below'
  ? { streamKind: 'below', ...(typeof item.inputSig === 'string' && item.inputSig ? { inputSig: item.inputSig } : {}) } : {});

/**
 * `staged`: unclaimed "key → ranges". By default each index has its own copy; when sharding by session
 * (`createReadyHub`), all sessions share the hub's copy: ranges attached by disk scanning and track
 * streams are content-addressed and independent of any session. */
export function createReadyIndex({ staged: shared = null } = {}) {
  const staged = shared ?? new Map();
  /** layerId -> { clipId, kind, key, ranges, groupClipIds?, originFrame?, streamKind?, inputSig? } */
  const layers = new Map();
  const subscribers = new Set();
  let localRev = 0;
  let done = false;

  function emit(message) {
    for (const send of subscribers) { try { send(message); } catch { /* One subscriber disconnecting does not affect others */ } }
  }

  /** Project version changed: clear tables, notify page to clear tables. `layer` regrows from this moment. */
  function reset(rev = localRev) {
    localRev = Number(rev) || 0;
    layers.clear();
    done = false;
    emit({ type: 'reset', localRev });
  }

  /**
   * Merges this batch of new frames into a layer and sends a **full** `layer`.
   * `frames` can be frame numbers, closed intervals, or a mix of both (criteria of `mergeRanges`).
   */
  function addFrames({ clipId, kind, key, frames, groupClipIds = undefined, originFrame = undefined, streamKind = undefined, inputSig = undefined }) {
    if (!clipId || !READY_KINDS.includes(kind) || !key) return null;
    const id = layerId(clipId, kind);
    const before = layers.get(id);
    // If the key changes (card parameters changed), record from scratch: ranges of the old key have no relation to the new key
    const base = before && before.key === key ? before.ranges : [];
    const ranges = mergeRanges([...base, ...(frames ?? [])]);
    const layer = { clipId, kind, key, ranges, ...(groupClipIds ? { groupClipIds } : {}), ...originOf(kind, originFrame), ...belowOf(kind, { streamKind, inputSig }) };
    layers.set(id, layer);
    emit({ type: 'layer', ...layer });
    return layer;
  }

  /** Directly provides an interval table for the whole layer (the F5 rebuild path); sends a full `layer`, just like `addFrames`. */
  function setLayer({ clipId, kind, key, ranges, groupClipIds = undefined, originFrame = undefined, streamKind = undefined, inputSig = undefined }) {
    if (!clipId || !READY_KINDS.includes(kind) || !key) return null;
    const layer = { clipId, kind, key, ranges: mergeRanges(ranges), ...(groupClipIds ? { groupClipIds } : {}), ...originOf(kind, originFrame), ...belowOf(kind, { streamKind, inputSig }) };
    layers.set(layerId(clipId, kind), layer);
    emit({ type: 'layer', ...layer });
    return layer;
  }

  /** All anchor frames are ready (the C2 gate). Repeated calls send only once. */
  function markDone() {
    if (done) return;
    done = true;
    emit({ type: 'done', localRev });
  }

  /** "Key → interval" from disk scan: staged first, waiting for card plan to be in place before claiming (F5) */
  function stageByKey({ kind, key, ranges }) {
    if (!READY_KINDS.includes(kind) || !key) return;
    const id = `${kind}:${key}`;
    const before = staged.get(id);
    staged.set(id, { kind, key, ranges: mergeRanges([...(before?.ranges ?? []), ...(ranges ?? [])]) });
  }

  /**
   * Card plan in place: use `control.clipId` ↔ `control.snapshotKey` to claim staged intervals into
   * layers. `layers` = [{ clipId, kind, key, originFrame? }], `key` is already the **wire key**
   * (local tier is `<entry.key>/<shared key>`, C3), assembled by the caller using
   * `wireSnapshotKey`; `originFrame` for the `stream` layer is provided by the caller according to
   * this version's stream plan (the staged "key → interval" does not have it: it is the position of
   * this stream in this version of the project, not something in the stream store). Returns the
   * number of claimed layers.
   *
   * Claiming is a **full resend**: first `reset` (page clears the table), then send one `layer` for
   * each layer. This is consistent with C3 semantics, so no new endpoint is needed.
   */
  function claim(layers_, rev = localRev) {
    const claimed = [];
    for (const item of layers_ ?? []) {
      if (!READY_KINDS.includes(item?.kind) || !item.clipId || !item.key) continue;
      const hit = staged.get(`${item.kind}:${item.key}`);
      if (!hit?.ranges?.length) continue;
      claimed.push({ clipId: item.clipId, kind: item.kind, key: item.key, ranges: hit.ranges, ...originOf(item.kind, item.originFrame), ...belowOf(item.kind, item) });
    }
    if (!claimed.length) return 0;
    localRev = Number(rev) || 0;
    layers.clear();
    done = false;
    emit({ type: 'reset', localRev });
    for (const layer of claimed) {
      layers.set(layerId(layer.clipId, layer.kind), layer);
      emit({ type: 'layer', ...layer });
    }
    return claimed.length;
  }

  /**
   * Claiming after per-session sharding (`createReadyHub().claim`): **does not reset**, merges staged
   * intervals into existing layers (takes the union for the same key on the same layer; if keys
   * differ, staged takes precedence), sending a full `layer` only for layers that actually changed.
   * Clearing the table when a session switches versions is handled separately by `reset` (hub's
   * `adopt`); claiming is only responsible for "filling in". Returns the number of changed layers.
   */
  function absorb(layers_) {
    let changed = 0;
    for (const item of layers_ ?? []) {
      if (!READY_KINDS.includes(item?.kind) || !item.clipId || !item.key) continue;
      const hit = staged.get(`${item.kind}:${item.key}`);
      if (!hit?.ranges?.length) continue;
      const id = layerId(item.clipId, item.kind);
      const before = layers.get(id);
      const ranges = mergeRanges([...(before?.key === item.key ? before.ranges : []), ...hit.ranges]);
      const origin = originOf(item.kind, item.originFrame ?? (before?.key === item.key ? before.originFrame : undefined));
      // Two items for below-dependent streams: if the claim table includes them, use its values
      // (provided by this version's plan); if omitted and the key has not changed, keep the original layer's
      const below = belowOf(item.kind, item.streamKind ? item : (before?.key === item.key ? before : null));
      if (before?.key === item.key && JSON.stringify(before.ranges) === JSON.stringify(ranges) && before.originFrame === origin.originFrame
        && before.streamKind === below.streamKind && before.inputSig === below.inputSig) continue;
      const layer = { clipId: item.clipId, kind: item.kind, key: item.key, ranges,
        ...(before?.key === item.key && before.groupClipIds ? { groupClipIds: before.groupClipIds } : {}), ...origin, ...below };
      layers.set(id, layer);
      emit({ type: 'layer', ...layer });
      changed++;
    }
    return changed;
  }

  /** Initial feed when connecting to SSE: `reset` + one full `layer` per layer (+ one more if already done) */
  function backlog() {
    const out = [{ type: 'reset', localRev }];
    for (const layer of layers.values()) out.push({ type: 'layer', ...layer });
    if (done) out.push({ type: 'done', localRev });
    return out;
  }

  function subscribe(send) {
    subscribers.add(send);
    for (const message of backlog()) { try { send(message); } catch { /* Disconnected right after connecting */ } }
    return () => subscribers.delete(send);
  }

  return {
    reset, addFrames, setLayer, markDone, stageByKey, claim, absorb, backlog, subscribe,
    get localRev() { return localRev; },
    set localRev(value) { localRev = Number(value) || 0; },
    get done() { return done; },
    /** For testing / probes */
    list: () => [...layers.values()].map(layer => ({ ...layer })),
    stagedKeys: () => [...staged.values()].map(item => ({ ...item })),
    subscriberCount: () => subscribers.size,
    // The shared `staged` belongs to the hub; one session cannot clear what other sessions need to claim
    clear: () => { layers.clear(); if (!shared) staged.clear(); done = false; },
  };
}

/** The shared session used by callers without a session (scripts, probes, pages carrying the full `project` during migration) */
export const DEFAULT_READY_SESSION = '';
/** Sessions with no subscribers that have not sent a preload for this long are reclaimed */
export const READY_SESSION_IDLE_MS = 10 * 60 * 1000;
/** Cap on simultaneously tracked sessions; when exceeded, reclaim idle ones with no subscribers first */
export const READY_SESSION_MAX = 64;
/** Maximum keys staged in shared `staged` (each key holds a small interval table) */
export const READY_STAGED_MAX = 20000;
/** Maximum session id length (validation shared between `/ready` and `/preload`) */
export const READY_SESSION_ID_MAX = 200;

/** Session parameter from the page: omitted / empty = default session; too long or non-string = null (caller returns 400) */
export function readySessionOf(value) {
  if (value === undefined || value === null) return DEFAULT_READY_SESSION;
  if (typeof value !== 'string' || value.length > READY_SESSION_ID_MAX) return null;
  return value;
}

/**
 * Ready index sharded by session (Item 4, `docs/reports/REPORT-item4-session-isolation.md`).
 *
 * One `createReadyIndex` per page session (`session` in the mirror); `/api/frames/ready?session=`
 * subscribes only to its own instance. A session's "current version" (`entryKey`) is **only set by
 * page-initiated `preload`** (`adopt`); other renders (Agent queries, exports, interactive frames)
 * do not claim or reset any session's index.
 *
 * All publishes must include the entry they belong to (`publish(entryKey, layer)`): written only to
 * sessions whose current version is this entry, discarding the rest: late-arriving batches from old
 * versions and versions rendered by other sessions / background tasks cannot enter.
 *
 * "Key → interval" staged from disk scans (F5) and track streams are content-addressed; all sessions
 * share a single `staged`.
 */
export function createReadyHub({ now = () => Date.now(), idleMs = READY_SESSION_IDLE_MS, maxSessions = READY_SESSION_MAX, maxStaged = READY_STAGED_MAX } = {}) {
  const staged = new Map();
  /** id -> { id, index, entryKey, localRev, seenAt, ticket } */
  const sessions = new Map();
  let tickets = 0;

  const norm = id => (typeof id === 'string' ? id : id == null ? DEFAULT_READY_SESSION : String(id));

  function session(id) {
    id = norm(id);
    let record = sessions.get(id);
    if (!record) {
      record = { id, index: createReadyIndex({ staged }), entryKey: undefined, localRev: undefined, seenAt: now(), ticket: 0,
        pendingReset: false, pendingRev: undefined };
      sessions.set(id, record);
      prune(id);
    }
    return record;
  }

  /**
   * Reclamation: delete sessions with no subscribers and no activity within `idleMs`; if still over
   * the limit, delete in order of least recently active (likewise only deleting those with no
   * subscribers). `keep` is the session currently in use and will not be deleted.
   */
  function prune(keep) {
    const t = now();
    for (const [id, record] of sessions) {
      if (id === keep || record.index.subscriberCount() > 0) continue;
      if (t - record.seenAt > idleMs) sessions.delete(id);
    }
    if (sessions.size <= maxSessions) return;
    const idle = [...sessions.values()].filter(r => r.id !== keep && r.index.subscriberCount() === 0).sort((a, b) => a.seenAt - b.seenAt);
    for (const record of idle) {
      if (sessions.size <= maxSessions) break;
      sessions.delete(record.id);
    }
  }

  /**
   * Page preload just arrived: acquire a ticket first. `adopt` only recognizes the latest ticket:
   * when two preloads complete interleaved during `await entry()`, the later-sent version wins, not
   * the one that finished computing later.
   */
  function request(id) {
    const record = session(id);
    record.seenAt = now();
    record.ticket = ++tickets;
    return record.ticket;
  }

  /**
   * Has this ticket / this localRev been superseded by a newer preload (if superseded, neither claim
   * nor schedule further background jobs)? If the session was reclaimed after taking a ticket and
   * then recreated (`ticket === 0`), it is not considered superseded: there was no newer request.
   */
  function stale(id, ticket, localRev) {
    const record = sessions.get(norm(id));
    if (!record) return false;
    if (ticket !== undefined && record.ticket !== 0 && ticket !== record.ticket) return true;
    const rev = Number(localRev);
    return localRev != null && Number.isFinite(rev) && Number.isFinite(record.localRev) && rev < record.localRev;
  }

  /**
   * Sets the session's current version (**called only by page preload**). If the version changed,
   * resets this session's index (page clears the table); if the version did not change, records only
   * the new `localRev` without clearing the table. Returns `true` = version changed.
   *
   * Expired tickets (`ticket` is not the latest one for this session) or older `localRev` values are
   * rejected unconditionally.
   */
  function adopt(id, entryKey, localRev, ticket, { defer = false } = {}) {
    const record = session(id);
    record.seenAt = now();
    if (stale(id, ticket, localRev)) return false;
    const rev = localRev == null ? NaN : Number(localRev);
    if (Number.isFinite(rev)) record.localRev = rev;
    if (record.entryKey === entryKey) {
      if (Number.isFinite(rev) && !record.pendingReset) record.index.localRev = rev;
      if (Number.isFinite(rev) && record.pendingReset) record.pendingRev = rev;
      return false;
    }
    // The gate switches to the new version immediately: from this moment on, old version publishes cannot enter
    record.entryKey = entryKey;
    const target = Number.isFinite(rev) ? rev : record.index.localRev;
    if (defer) {
      // The new version's plan is not computed yet; clearing the table now would leave the page idling for
      // a few seconds (heavy cards falling back all the way to placeholders). Keep the table for now
      // ("reuse old prerender output"), resetting only when this version writes to this session for the
      // first time (claim / send layer / done); the reset and refilled layers are an immediate sequence
      // of messages
      record.pendingReset = true;
      record.pendingRev = target;
    } else {
      record.pendingReset = false;
      record.index.reset(target);
    }
    return true;
  }

  /** The pending reset is applied before this version writes to the session for the first time */
  function flush(record) {
    if (!record.pendingReset) return;
    record.pendingReset = false;
    record.index.reset(record.pendingRev ?? record.index.localRev);
  }

  function sessionsOn(entryKey) {
    if (!entryKey) return [];
    return [...sessions.values()].filter(record => record.entryKey === entryKey);
  }

  /**
   * Send one layer: write only into sessions whose current version is `entryKey`. Returns how many
   * sessions it was written to (0 = discarded).
   *
   * Regardless of whether any session accepted it, intervals are staged into `staged`: keys are
   * content-addressed (local tier keys carry entry.key), so staging will not leak to other versions:
   * only clips with the same key in the card plan can claim them. This way, when a session switches
   * back to a version (undo, page refresh into a new session), `adopt` + claim can immediately
   * backfill all existing layers for that version on the spot without waiting for background reruns.
   */
  function publish(entryKey, layer) {
    stageByKey(layer);
    let n = 0;
    for (const record of sessionsOn(entryKey)) { flush(record); if (record.index.setLayer(layer)) n++; }
    return n;
  }

  /** Clear tables for all sessions whose current version is `entryKey` (used when layers are removed in this version without changing version); localRev unchanged */
  function resetOn(entryKey) {
    for (const record of sessionsOn(entryKey)) {
      if (record.pendingReset) { flush(record); continue; }
      record.index.reset(record.index.localRev);
    }
  }

  function markDone(entryKey) {
    for (const record of sessionsOn(entryKey)) { flush(record); record.index.markDone(); }
  }

  /**
   * Card plan in place: claim staged intervals into sessions whose current version is `entryKey`.
   * Sessions already on this version are not reset (see `absorb`); sessions that just switched over
   * with a pending reset are reset first and then backfilled: the page sees an immediately consecutive
   * sequence.
   */
  function claim(entryKey, layers) {
    let n = 0;
    for (const record of sessionsOn(entryKey)) { flush(record); n += record.index.absorb(layers); }
    return n;
  }

  /** Staged keys sorted by recency; when exceeding `maxStaged`, drop the least recently used (Map insertion order is LRU order) */
  function stageByKey({ kind, key, ranges }) {
    if (!READY_KINDS.includes(kind) || !key) return;
    const id = `${kind}:${key}`;
    const before = staged.get(id);
    staged.delete(id);
    staged.set(id, { kind, key, ranges: mergeRanges([...(before?.ranges ?? []), ...(ranges ?? [])]) });
    while (staged.size > maxStaged) staged.delete(staged.keys().next().value);
  }

  /**
   * Remove staged keys (after frame store eviction deletes its directory, `frame-library-storage.mjs`):
   * `key` removes one; `prefix` removes all in this family whose keys start with it (local tier keys
   * are `<entry.key>/<shared key>`). Layers already sent into sessions are untouched: only unopened
   * versions will be deleted.
   */
  function unstage({ kind, key, prefix } = {}) {
    if (!READY_KINDS.includes(kind)) return 0;
    let n = 0;
    if (key) { if (staged.delete(`${kind}:${key}`)) n++; }
    else if (prefix) for (const [id, item] of staged) if (item.kind === kind && item.key.startsWith(prefix)) { staged.delete(id); n++; }
    return n;
  }

  /** Subscription for `/api/frames/ready?session=`. After unsubscribing, this session is reclaimed according to `idleMs`. */
  function subscribe(id, send) {
    const record = session(id);
    record.seenAt = now();
    const off = record.index.subscribe(send);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      record.seenAt = now();
      prune();
    };
  }

  return {
    session: id => session(id),
    peek: id => sessions.get(norm(id)),
    current: id => sessions.get(norm(id))?.entryKey,
    request, stale, adopt, publish, resetOn, markDone, claim, stageByKey, unstage, subscribe, prune, sessionsOn,
    drop: id => sessions.delete(norm(id)),
    sessionCount: () => sessions.size,
    stagedKeys: () => [...staged.values()].map(item => ({ ...item })),
    /** Diagnostic read endpoint */
    describe: () => [...sessions.values()].map(r => ({ session: r.id, entryKey: r.entryKey ?? null, localRev: r.localRev ?? null, pendingReset: r.pendingReset,
      subscribers: r.index.subscriberCount(), layers: r.index.list().length, done: r.index.done, seenAt: r.seenAt })),
  };
}
