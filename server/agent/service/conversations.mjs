/**
 * State of cloud chats (contract `docs/plan/cloud-agent-contract.md` sections 2.4, 7): stored on
 * nodes, independent of initiator connections.
 *
 * One directory per chat `tenants/<projectId>/owners/<owner key>/conversations/<chat id>/`, managing
 * two files here:
 *   meta.json      title, status, lastSeq, runId of latest round, start/end timestamps,
 *                  end reason, initiating device name (temp file plus rename)
 *   events.jsonl   event log: appends one line per event with incrementing `seq` (starting from 1
 *                  per chat, continuous across rounds)
 * (`history.json` is written by the driver, `pending-render.json` by `render-request.mjs`.)
 *
 * **Store events before sending**: `emit` first appends the event to file, then sends to
 * currently connected streams. Even if no stream is connected, events are recorded as usual.
 * **Replay and real-time without gaps or duplicates**: `subscribe` (synchronously) within the same
 * tick first replays events with `seq` greater than `after`, then registers callback in the
 * real-time list; `emit` is also synchronous, so no events can slip between the two.
 *
 * Deltas of `text` and `thinking` are compacted into a full block at the end of a round to avoid
 * bloating the log with character-by-character deltas: a compacted line is
 * `{ …, delta: <full block>, fromSeq, seq: <seq of last>, cuts: [char count of each delta] }`.
 * When replaying, unpack back into original individual deltas by `cuts`, so the viewer receives
 * events identical event-for-event to the real-time stream, with `seq` remaining continuous:
 * compaction is only a storage format and does not change the interface.
 *
 * This file does not import `src/`.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CONVERSATION_STORE_DEFAULTS = Object.freeze({
  /** Stop recording thinking and diagnostic once event log reaches this size */
  degradeBytes: 8 * 1024 * 1024,
  /** If it grows to this size, no more messages can be sent in this chat */
  capBytes: 12 * 1024 * 1024,
  /** Maximum number of chats per owner per project; when full, no new ones allowed and history
   * is not auto-deleted (user decision, 2026-10-08); to create new ones, owner must delete old */
  maxPerOwner: 50,
  /** Maximum number of unviewed, idle chats kept in memory (others are re-read from disk when
   * needed) */
  maxLoadedIdle: 32,
  /** Maximum entries kept per chat when there is no data directory (in memory only) */
  maxEventsInMemory: 5000,
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEGRADED_TYPES = new Set(['thinking', 'diagnostic']);
const MERGE_TYPES = new Set(['text', 'thinking']);

export const INTERRUPTED_MESSAGE = 'The Cloud Agent service was interrupted and this turn did not finish. Changes already applied are kept in the project.';

function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Whether two events are identical except for delta and sequence number (can merge into one) */
function sameShape(a, b) {
  const ka = Object.keys(a).filter((k) => k !== 'delta' && k !== 'seq' && k !== 'fromSeq' && k !== 'cuts');
  const kb = Object.keys(b).filter((k) => k !== 'delta' && k !== 'seq' && k !== 'fromSeq' && k !== 'cuts');
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** Unpack a line from the log back into individual events in the real-time stream */
export function* expandEntry(entry) {
  if (!Array.isArray(entry.cuts)) { yield entry; return; }
  const { cuts, fromSeq, delta, seq: _last, ...rest } = entry;
  let off = 0;
  for (let i = 0; i < cuts.length; i += 1) {
    yield { ...rest, delta: delta.slice(off, off + cuts[i]), seq: fromSeq + i };
    off += cuts[i];
  }
}

/** Merge adjacent text / thinking deltas into full blocks (already merged ones can be merged
 * further); returns a new array */
export function mergeDeltas(entries) {
  const out = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev && MERGE_TYPES.has(e.type) && prev.type === e.type && typeof e.delta === 'string' && typeof prev.delta === 'string' && sameShape(prev, e)) {
      const prevFrom = prev.fromSeq ?? prev.seq;
      const eFrom = e.fromSeq ?? e.seq;
      if (eFrom === prev.seq + 1) {
        out[out.length - 1] = {
          ...prev,
          delta: prev.delta + e.delta,
          fromSeq: prevFrom,
          seq: e.seq,
          cuts: [...(prev.cuts ?? [prev.delta.length]), ...(e.cuts ?? [e.delta.length])],
        };
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

/**
 * @param {object} o
 * @param {string | null} o.dataDir Data directory; in memory only when null (lost once process
 *   exits, intended only for tests that do not persist to disk)
 */
export function createConversationStore({ dataDir = null, now = () => Date.now(), limits: limitsIn = {}, log = () => {} } = {}) {
  const limits = { ...CONVERSATION_STORE_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect chat */ } };
  /** "project\nowner key\nchat id" → chat */
  const loaded = new Map();

  const keyOf = (projectId, ownerKey, id) => `${projectId}\n${ownerKey}\n${id}`;
  /** Project id and owner key are used as directory names: accept only those that will not escape
   * `tenants/` */
  const seg = (name) => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(name) || /^\.+$/.test(name)) throw new Error('Identifier that cannot be used as a directory name');
    return name;
  };
  const ownerDir = (projectId, ownerKey) => path.join(dataDir, 'tenants', seg(projectId), 'owners', seg(ownerKey), 'conversations');
  const dirOf = (projectId, ownerKey, id) => path.join(ownerDir(projectId, ownerKey), id);

  function readMeta(dir) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      return m && typeof m === 'object' && typeof m.id === 'string' ? m : null;
    } catch {
      return null;
    }
  }

  /** Read event log. Discard incomplete partial line at the end (left when process was killed)
   * and truncate file to the last full line */
  function readEvents(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { return { entries: [], bytes: 0 }; }
    const end = buf.lastIndexOf(0x0a) + 1;
    if (end < buf.length) {
      try { fs.truncateSync(file, end); } catch { /* Read as usual even if truncation fails */ }
    }
    const entries = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && Number.isSafeInteger(e.seq)) entries.push(e);
      } catch { /* Skip bad lines */ }
    }
    return { entries, bytes: end };
  }

  function saveMeta(conv) {
    conv.meta.lastSeq = conv.seq;
    conv.meta.updatedAt = now();
    if (!dataDir) return;
    try {
      fs.mkdirSync(conv.dir, { recursive: true, mode: 0o700 });
      writeJson(path.join(conv.dir, 'meta.json'), conv.meta);
    } catch (err) {
      say('agent.conversation.meta-failed', { message: String(err?.message ?? err).slice(0, 120) });
    }
  }

  function closeFd(conv) {
    if (conv.fd === null) return;
    try { fs.closeSync(conv.fd); } catch { /* Already closed */ }
    conv.fd = null;
  }

  function trimLoaded() {
    const idle = [...loaded.values()].filter((c) => !c.run && c.listeners.size === 0 && !c.pinned);
    if (idle.length <= limits.maxLoadedIdle) return;
    idle.sort((a, b) => a.touched - b.touched);
    for (const c of idle.slice(0, idle.length - limits.maxLoadedIdle)) {
      if (!dataDir) continue; // In-memory data is gone once lost, so do not discard
      closeFd(c);
      loaded.delete(c.key);
    }
  }

  /** Limit reached: do not delete any chats; the caller creating one receives an error with
   * `code: 'conversation-limit'` (service layer translates to 409) */
  function assertRoomForNew(projectId, ownerKey) {
    if (listMetas(projectId, ownerKey).length < limits.maxPerOwner) return;
    throw Object.assign(new Error('conversation-limit'), { code: 'conversation-limit' });
  }

  function listMetas(projectId, ownerKey) {
    const byId = new Map();
    if (dataDir) {
      let names = [];
      try { names = fs.readdirSync(ownerDir(projectId, ownerKey)); } catch { /* No chats yet */ }
      for (const name of names) {
        if (!ID_RE.test(name)) continue;
        const m = readMeta(dirOf(projectId, ownerKey, name));
        if (m && m.id === name) byId.set(name, m);
      }
    }
    for (const c of loaded.values()) {
      if (c.projectId === projectId && c.ownerKey === ownerKey) byId.set(c.id, { ...c.meta, lastSeq: c.seq });
    }
    return [...byId.values()];
  }

  /**
   * Fetch a chat; create if missing and `create` is true. Chat id passes character set check first
   * (it is the last segment of the disk path).
   * @returns {object | null}
   */
  function get(projectId, ownerKey, id, { create = false, startedOn = null } = {}) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const key = keyOf(projectId, ownerKey, id);
    let conv = loaded.get(key);
    if (conv) { conv.touched = now(); return conv; }
    const dir = dataDir ? dirOf(projectId, ownerKey, id) : null;
    let meta = dir ? readMeta(dir) : null;
    if (!meta && !create) return null;
    let entries = [];
    let bytes = 0;
    const fresh = !meta;
    if (meta) {
      ({ entries, bytes } = readEvents(path.join(dir, 'events.jsonl')));
    } else {
      assertRoomForNew(projectId, ownerKey);
      meta = { v: 1, id, title: '', state: 'idle', reason: null, message: null, lastSeq: 0, runId: null, startedAt: null, endedAt: null, startedOn, createdAt: now(), updatedAt: now() };
    }
    conv = {
      key, id, projectId, ownerKey, dir, meta,
      /** Lines in the log (compacted ones include fromSeq / cuts) */
      entries,
      seq: entries.length ? entries[entries.length - 1].seq : 0,
      bytes,
      fd: null,
      /** Real-time list: { cb, userId } */
      listeners: new Set(),
      /** Active round (managed by service): { runId, userId, stop(kind, detail) } */
      run: null,
      pinned: false,
      touched: now(),
    };
    loaded.set(key, conv);
    if (fresh) saveMeta(conv);
    trimLoaded();
    return conv;
  }

  /** Record event first, then send to currently connected streams. Events discarded after log
   * downgrade return null (neither recorded nor sent) */
  function emit(conv, event) {
    if (conv.bytes >= limits.degradeBytes && DEGRADED_TYPES.has(event.type)) return null;
    const ev = { ...event, seq: conv.seq + 1 };
    if (dataDir) {
      const line = `${JSON.stringify(ev)}\n`;
      try {
        if (conv.fd === null) {
          fs.mkdirSync(conv.dir, { recursive: true, mode: 0o700 });
          conv.fd = fs.openSync(path.join(conv.dir, 'events.jsonl'), 'a', 0o600);
        }
        fs.writeSync(conv.fd, line);
        conv.bytes += Buffer.byteLength(line);
      } catch (err) {
        say('agent.conversation.append-failed', { message: String(err?.message ?? err).slice(0, 120) });
      }
    } else if (conv.entries.length >= limits.maxEventsInMemory) {
      conv.entries.splice(0, conv.entries.length - limits.maxEventsInMemory + 1);
    }
    conv.seq = ev.seq;
    conv.entries.push(ev);
    conv.touched = now();
    for (const l of [...conv.listeners]) {
      try { l.cb(ev); } catch { /* A broken stream does not affect others */ }
    }
    return ev;
  }

  /**
   * View a chat: first replay events with `seq` greater than `after`, then switch to real-time
   * (switched within the same tick). Returns unsubscribe function.
   * @param {{ userId?: string, pageId?: string | null }} [who] Who is viewing (used to determine
   *   "initiator online"); `pageId` is the self-reported page id of that page
   *   (reverse channel only recognizes the one that initiated this round, contract section 28)
   */
  function subscribe(conv, after, cb, who = {}) {
    const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
    for (const entry of conv.entries) {
      if (entry.seq <= from) continue;
      for (const ev of expandEntry(entry)) if (ev.seq > from) cb(ev);
    }
    const l = { cb, userId: who.userId ?? null, pageId: who.pageId ?? null };
    conv.listeners.add(l);
    conv.touched = now();
    const off = () => { conv.listeners.delete(l); };
    // The entry for this stream in the real-time list (service identifies "requests sent to which
    // stream" based on it)
    off.listener = l;
    return off;
  }

  /** Update status and persist to `meta.json` */
  function setState(conv, patch) {
    Object.assign(conv.meta, patch);
    saveMeta(conv);
  }

  /** After a round ends: merge deltas into full blocks and rewrite the event log */
  function compact(conv) {
    const merged = mergeDeltas(conv.entries);
    if (merged.length === conv.entries.length) { closeFd(conv); return; }
    conv.entries = merged;
    if (!dataDir) return;
    closeFd(conv);
    try {
      const file = path.join(conv.dir, 'events.jsonl');
      const text = merged.map((e) => `${JSON.stringify(e)}\n`).join('');
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      conv.bytes = Buffer.byteLength(text);
    } catch (err) {
      say('agent.conversation.compact-failed', { message: String(err?.message ?? err).slice(0, 120) });
    }
  }

  /** Delete a chat: delete event log, status, model history, and prerender retry manifest
   * together */
  function remove(conv) {
    closeFd(conv);
    for (const l of [...conv.listeners]) conv.listeners.delete(l);
    loaded.delete(conv.key);
    if (conv.dir) {
      try { fs.rmSync(conv.dir, { recursive: true, force: true }); } catch (err) { say('agent.conversation.remove-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
    }
  }

  /** Traverse all chat directories on disk */
  function* walk() {
    if (!dataDir) return;
    const tenants = path.join(dataDir, 'tenants');
    let projects = [];
    try { projects = fs.readdirSync(tenants); } catch { return; }
    for (const projectId of projects) {
      let owners = [];
      try { owners = fs.readdirSync(path.join(tenants, projectId, 'owners')); } catch { continue; }
      for (const ownerKey of owners) {
        let ids = [];
        try { ids = fs.readdirSync(ownerDir(projectId, ownerKey)); } catch { continue; }
        for (const id of ids) if (ID_RE.test(id)) yield { projectId, ownerKey, id, dir: dirOf(projectId, ownerKey, id) };
      }
    }
  }

  return {
    limits,
    get,
    emit,
    subscribe,
    setState,
    compact,
    remove,
    walk,

    dirOf: (projectId, ownerKey, id) => (dataDir ? dirOf(projectId, ownerKey, id) : null),

    /** Chats for this owner in this project, most recently active first */
    list(projectId, ownerKey) {
      return listMetas(projectId, ownerKey).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },

    /** Whether messages can still be sent in this chat (log limit reached) */
    full(conv) {
      return conv.bytes >= limits.capBytes;
    },

    /**
     * Called on process startup (contract section 7.5): for chats whose on-disk status is still
     * running where the previous process exited before finalizing: mark as interrupted, append an
     * explanation and `end` to the end of the event log. Does not automatically resume. Returns the
     * number of marked chats.
     */
    recover() {
      let n = 0;
      for (const at of walk()) {
        const meta = readMeta(at.dir);
        if (!meta || meta.state !== 'running') continue;
        const conv = get(at.projectId, at.ownerKey, at.id);
        if (!conv) continue;
        const runId = conv.meta.runId ?? null;
        emit(conv, { type: 'error', code: 'interrupted', runId, message: INTERRUPTED_MESSAGE });
        emit(conv, { type: 'end', runId, state: 'interrupted' });
        setState(conv, { state: 'interrupted', reason: 'interrupted', message: INTERRUPTED_MESSAGE, endedAt: now() });
        compact(conv);
        n += 1;
      }
      if (n) say('agent.conversation.recovered', { interrupted: n });
      return n;
    },

    /** Project deletion: all chat records and model history under this project are deleted (usage
     * records are the host's accounting, not here) */
    removeProject(projectId) {
      for (const c of [...loaded.values()]) {
        if (c.projectId !== projectId) continue;
        closeFd(c);
        loaded.delete(c.key);
      }
      if (!dataDir) return;
      try { fs.rmSync(path.join(dataDir, 'tenants', seg(projectId)), { recursive: true, force: true }); } catch (err) { say('agent.conversation.remove-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
    },

    /** Chats currently loaded into memory (for diagnostics and finalization) */
    loaded: () => [...loaded.values()],

    close() {
      for (const c of loaded.values()) closeFd(c);
      loaded.clear();
    },
  };
}
