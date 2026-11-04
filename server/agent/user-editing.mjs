import { tr } from "../i18n.mjs";
/**
 * "User is editing" local version (plan `docs/plan/agent-workflow-plan.md` A2; semantics
 * `user-workflow.md` "Protection").
 *
 * Two things, both only **notices**, not blocking any calls:
 *
 * 1. **User is editing**: the editor page (`src/editor/userEditing.ts`) throttles and pushes
 *    "currently editing" clips to the server (`POST /api/agent/editing`), recorded here by page
 *    session with expiration timestamps; when an Agent reads or writes to these clips, tool results
 *    include `userEditing` (which clips, what is being done), and a message is written in `notice`
 *    for the model to see. Criteria (plan section 4 item 1 [ruling]): dragging, text editing,
 *    and touched within 30 seconds after selection; merely selected without motion does not count.
 *    "Touched within 30 seconds" is judged by the page and pushed with remaining milliseconds;
 *    dragging / text editing is renewed by page heartbeats, and automatically cleared after `ttlMs`
 *    if the page is closed or hangs.
 *
 * 2. **Overwrote what someone else just wrote**: `overwrote` returned by the document service for a
 *    commit (entities written by another write identity overwritten within 10 minutes) is included
 *    in tool results: if written by a page, labeled as "User just modified"; if by another Agent,
 *    labeled as "Agent <identity> just modified".
 *
 * 3. **Cross-device** (plan A3 stage 2): in a shared project, pages of other members publish clips
 *    they are editing via document service presence (`presence.*`, `../docservice/modules/presence.mjs`);
 *    after the editor process receives them, they are recorded as **another source** (`reportRemote`,
 *    with member name and expiration timestamp); when an Agent reads or writes to them, it displays
 *    the notice "User <member> is editing". The local page also publishes a copy via the document
 *    service, recognized by page session number so it is not double-counted (`reportRemote` skips
 *    sessions reported locally).
 */

export const USER_EDITING_DEFAULTS = Object.freeze({
  /** How long without page renewal before dragging / text editing entries expire (page heartbeats every 5 seconds, see src/editor/userEditingCore.ts) */
  ttlMs: 15_000,
  /** Upper limit on remaining duration reported by the page for "recently touched" entries (page criteria is 30 seconds; anything exceeding this is clamped) */
  recentMaxMs: 30_000,
  /** Maximum number of clips recorded per page session */
  maxEntities: 64,
  /** Maximum number of page sessions recorded (an editor process normally has only one edit page) */
  maxSessions: 16,
  /** Maximum number of clips listed in results */
  showMax: 8,
});

export const EDITING_KINDS = Object.freeze(['drag', 'text', 'recent']);
const KIND_TEXT = Object.freeze({ drag: 'dragging', text: 'editing text', recent: 'just modified' });
const KIND_RANK = Object.freeze({ drag: 0, text: 1, recent: 2 });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const CLIP_ID_RE = /^[^\s]{1,128}$/;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Editing state remembered by the server. `report` replaces the entries for this page session entirely;
 * `current()` merges all sessions and removes expired ones.
 * @param {{ now?: () => number, ttlMs?: number, recentMaxMs?: number, maxEntities?: number, maxSessions?: number }} [options]
 */
export function createUserEditingBoard(options = {}) {
  const o = { ...USER_EDITING_DEFAULTS, ...options };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** session → Map(clipId → { clipId, kind, since, expiresAt }) */
  const sessions = new Map();
  /** Other members of shared projects (via document service): remote session → { who, entries: Map(clipId → …) } */
  const remote = new Map();
  /** Session IDs reported by the local page: copies returned via the document service are not recounted (`reportRemote` skips them) */
  const localSeen = new Set();

  function prune(t = now()) {
    for (const [session, list] of sessions) {
      for (const [id, e] of list) if (e.expiresAt <= t) list.delete(id);
      if (!list.size) sessions.delete(session);
    }
    for (const [key, r] of remote) {
      for (const [id, e] of r.entries) if (e.expiresAt <= t) r.entries.delete(id);
      if (!r.entries.size) remote.delete(key);
    }
  }

  return {
    /**
     * A complete state reported by the page. `entities`: `[{ clipId, kind: 'drag' | 'text' | 'recent', remainingMs? }]`.
     * Malformed entries are skipped; returns the number of entries recorded this time.
     */
    report(session, entities) {
      if (typeof session !== 'string' || !SESSION_RE.test(session)) throw new Error('session is invalid');
      if (!Array.isArray(entities)) throw new Error('entities must be an array');
      const t = now();
      const prev = sessions.get(session);
      const next = new Map();
      for (const raw of entities) {
        if (next.size >= o.maxEntities) break;
        if (!isPlainObject(raw) || typeof raw.clipId !== 'string' || !CLIP_ID_RE.test(raw.clipId)) continue;
        if (!EDITING_KINDS.includes(raw.kind)) continue;
        let life = o.ttlMs;
        if (raw.kind === 'recent') {
          const left = Number(raw.remainingMs);
          if (!Number.isFinite(left) || left <= 0) continue;
          life = Math.min(left, o.recentMaxMs);
        }
        const old = next.get(raw.clipId);
        if (old && KIND_RANK[old.kind] <= KIND_RANK[raw.kind]) continue;
        const same = prev?.get(raw.clipId);
        next.set(raw.clipId, { clipId: raw.clipId, kind: raw.kind, since: same && same.kind === raw.kind ? same.since : t, expiresAt: t + life });
      }
      sessions.delete(session);
      if (next.size) sessions.set(session, next);
      while (sessions.size > o.maxSessions) sessions.delete(sessions.keys().next().value);
      localSeen.add(session);
      if (localSeen.size > 256) localSeen.delete(localSeen.values().next().value);
      remote.delete(session);
      return next.size;
    },

    /**
     * A report from pages of other members in a shared project via the document service (replaces this
     * remote session entirely). `session` is that page's session ID (skipped if reported locally);
     * `who` is the member name; `expiresAt` is the expiration timestamp from the document service.
     * Returns the number of entries recorded (returns 0 if skipped).
     */
    reportRemote(session, entities, { who = null, expiresAt } = {}) {
      if (typeof session !== 'string' || !SESSION_RE.test(session)) return 0;
      if (localSeen.has(session)) return 0;
      const t = now();
      const until = Number.isFinite(expiresAt) ? Math.min(expiresAt, t + o.ttlMs) : t + o.ttlMs;
      const prev = remote.get(session)?.entries;
      const next = new Map();
      for (const raw of Array.isArray(entities) ? entities : []) {
        if (next.size >= o.maxEntities) break;
        if (!isPlainObject(raw) || typeof raw.clipId !== 'string' || !CLIP_ID_RE.test(raw.clipId) || !EDITING_KINDS.includes(raw.kind)) continue;
        let end = until;
        if (raw.kind === 'recent') {
          const left = Number(raw.remainingMs);
          if (!Number.isFinite(left) || left <= 0) continue;
          end = Math.min(until, t + Math.min(left, o.recentMaxMs));
        }
        const old = next.get(raw.clipId);
        if (old && KIND_RANK[old.kind] <= KIND_RANK[raw.kind]) continue;
        const same = prev?.get(raw.clipId);
        next.set(raw.clipId, { clipId: raw.clipId, kind: raw.kind, since: same && same.kind === raw.kind ? same.since : t, expiresAt: end });
      }
      remote.delete(session);
      if (next.size) remote.set(session, { who: typeof who === 'string' && who ? who.slice(0, 64) : null, entries: next });
      while (remote.size > o.maxSessions) remote.delete(remote.keys().next().value);
      return next.size;
    },

    clearRemote(session) {
      remote.delete(session);
    },

    /** The page has left (or in tests): clears this session */
    clear(session) {
      sessions.delete(session);
    },

    /**
     * Clips "currently editing" at this moment: one entry per clip (if reported by multiple sessions,
     * takes the strongest kind; when equally strong, local takes priority), sorted by clip id.
     * Clips currently edited by other members in a shared project include `who` (member name).
     */
    current() {
      const t = now();
      prune(t);
      const merged = new Map();
      for (const list of sessions.values()) {
        for (const e of list.values()) {
          const old = merged.get(e.clipId);
          if (!old || KIND_RANK[e.kind] < KIND_RANK[old.kind]) merged.set(e.clipId, e);
        }
      }
      for (const r of remote.values()) {
        for (const e of r.entries.values()) {
          const old = merged.get(e.clipId);
          if (!old || KIND_RANK[e.kind] < KIND_RANK[old.kind]) merged.set(e.clipId, r.who ? { ...e, who: r.who } : e);
        }
      }
      return [...merged.values()]
        .sort((a, b) => (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0))
        .map((e) => ({ clipId: e.clipId, kind: e.kind, forMs: Math.max(0, t - e.since), ...(e.who ? { who: e.who } : {}) }));
    },

    describe() {
      return { sessions: sessions.size, remote: remote.size, entities: this.current() };
    },
  };
}

/* ------------------------------------------------------------------ Which clips this invocation touched */

/** Clips explicitly named in arguments */
export function clipIdsOfArgs(args) {
  if (!isPlainObject(args)) return [];
  const out = [];
  for (const k of ['clipId', 'otherClipId']) {
    if (typeof args[k] === 'string' && args[k]) out.push(args[k]);
  }
  return out;
}

/**
 * Clips written in a batch of paths (committed ops `path`, or entity names returned by the document
 * service): `/tracks/@<t>/clips/@<id>/…`; for new clips `insert`ed to `…/clips`, take their `value.id`.
 */
export function clipIdsOfOps(ops) {
  const out = new Set();
  for (const op of Array.isArray(ops) ? ops : []) {
    const p = typeof op === 'string' ? op : op?.path;
    if (typeof p !== 'string') continue;
    const segs = p.split('/').slice(1).map(unescapeSeg);
    let found = false;
    for (let i = 0; i + 1 < segs.length; i += 1) {
      if (segs[i] === 'clips' && typeof segs[i + 1] === 'string' && segs[i + 1].startsWith('@') && segs[i + 1].length > 1) {
        out.add(segs[i + 1].slice(1));
        found = true;
        break;
      }
    }
    if (!found && typeof op === 'object' && op?.op === 'insert' && segs[segs.length - 1] === 'clips' && typeof op.value?.id === 'string') {
      out.add(op.value.id);
    }
  }
  return [...out];
}

function unescapeSeg(s) {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Tools reading the entire project (without naming clips): all clips being edited by users count as touched */
export function readsWholeProject(tool, args) {
  if (tool === 'get_project') return true;
  if (tool === 'get_layout' && !(isPlainObject(args) && typeof args.clipId === 'string' && args.clipId)) return true;
  return false;
}

/* ------------------------------------------------------------------ Notices in results */

/**
 * Clips touched by this invocation that are being edited by users.
 * @param {{ tool: string, args?: object, written?: string[], editing: Array<{ clipId: string, kind: string, forMs?: number }> }} o
 */
export function userEditingFor({ tool, args, written = [], editing = [] }) {
  if (!Array.isArray(editing) || !editing.length) return [];
  const view = (e) => ({ clipId: e.clipId, kind: e.kind, ...(e.who ? { who: e.who } : {}) });
  if (readsWholeProject(tool, args)) return editing.map(view);
  const touched = new Set([...clipIdsOfArgs(args), ...(Array.isArray(written) ? written : [])]);
  return editing.filter((e) => touched.has(e.clipId)).map(view);
}

/** The message shown to the model */
export function userEditingNotice(list, limits = USER_EDITING_DEFAULTS) {
  if (!Array.isArray(list) || !list.length) return '';
  const capped = list.slice(0, limits.showMax);
  const more = list.length > capped.length ? ` and ${list.length} more` : '';
  // One line for the local user; one line for each other member in a shared project: "User <member> is editing..." (A3 stage 2)
  const groups = new Map();
  for (const e of capped) {
    const who = typeof e.who === 'string' && e.who ? e.who : '';
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(`clip ${e.clipId} (${KIND_TEXT[e.kind] ?? e.kind})`);
  }
  const parts = [...groups].map(([who, items]) => `${who ? `User ${who}` : 'User'} is editing ${items.join(', ')}`);
  return `${parts.join('; ')}${more}. This is a hint, not a prohibition: the user may be giving you instructions right here; before changing anything, make sure you will not overwrite the user's edits, and if unsure, stop and ask the user.`;
}

/**
 * Write identity → "who just modified". Page = user (other members in a shared project include
 * their names); Agent carries identity (chat id, along with provider when `agentLabel` provides it).
 * @param {object} actor Document service write identity `{ role, userId?, conversation?, session? }`
 * @param {(key: string) => string | null} [agentLabel] Chat id → human-readable name (optional)
 */
export function writerOf(actor, agentLabel) {
  if (!isPlainObject(actor)) return { by: 'unknown', who: 'Unknown writer' };
  if (actor.role === 'page') {
    const other = actor.userId && actor.userId !== 'local' ? actor.userId : null;
    return other ? { by: 'user', who: `User ${other}`, userId: other } : { by: 'user', who: 'User' };
  }
  if (actor.role === 'agent') {
    const key = typeof actor.session === 'string' && actor.session.startsWith('agent:') ? actor.session.slice('agent:'.length) : null;
    const id = key || (actor.conversation != null ? `chat ${actor.conversation}` : '?');
    let label = null;
    try { label = key && typeof agentLabel === 'function' ? agentLabel(key) : null; } catch { label = null; }
    return { by: 'agent', who: `Agent ${id}${label ? `(${label})` : ''}`, agent: key ?? null };
  }
  if (actor.role === 'render') return { by: 'render', who: 'Render node' };
  return { by: 'unknown', who: actor.userId ? `User ${actor.userId}` : 'Unknown writer' };
}

/**
 * `overwrote` returned by document service → entries in result. Each entry: entity, clip id (if
 * it is a clip), who, at which revision, how long ago.
 * @param {Array<{ entity: string, by: object, rev: number, at: number }>} overwrote
 * @param {{ now?: number, agentLabel?: (key: string) => string | null }} [o]
 */
export function overwroteView(overwrote, { now = Date.now(), agentLabel } = {}) {
  if (!Array.isArray(overwrote)) return [];
  return overwrote.filter((x) => isPlainObject(x) && typeof x.entity === 'string').map((x) => {
    const w = writerOf(x.by, agentLabel);
    const clipId = clipIdsOfOps([x.entity])[0] ?? null;
    return {
      entity: x.entity,
      ...(clipId ? { clipId } : {}),
      by: w.by,
      who: w.who,
      label: tr("{0} just edited", w.who),
      ...(Number.isSafeInteger(x.rev) ? { rev: x.rev } : {}),
      ...(Number.isFinite(x.at) ? { agoMs: Math.max(0, now - x.at) } : {}),
    };
  });
}

/** The message shown to the model for overwrite notice */
export function overwroteNotice(view, limits = USER_EDITING_DEFAULTS) {
  if (!Array.isArray(view) || !view.length) return '';
  const shown = view.slice(0, limits.showMax).map((v) => {
    const what = v.clipId ? `clip ${v.clipId}` : v.entity;
    const ago = Number.isFinite(v.agoMs) ? `, ${Math.max(1, Math.round(v.agoMs / 1000))} s ago` : '';
    return `${what} (${v.label}${v.rev != null ? `, rev ${v.rev}` : ''}${ago})`;
  });
  const more = view.length > shown.length ? ` and ${view.length} more` : '';
  const hasUser = view.some((v) => v.by === 'user');
  const hasAgent = view.some((v) => v.by === 'agent');
  const tail = hasUser
    ? 'Something the user just edited was overwritten by this write: confirm this is what the user wants; if not, undo it or restore the user\'s version, and tell the user.'
    : hasAgent ? 'Something another Agent just edited was overwritten by this write: make sure you are not fighting over the same spot, and coordinate with it if needed.' : 'Confirm this overwrite is intentional.';
  return `This write overwrote content someone else just wrote: ${shown.join(', ')}${more}. ${tail}`;
}

/**
 * Puts notices into tool results. Object results: adds two fields, `userEditing` and `overwrote`;
 * `notice` is placed first (seen by the model first); if the result already had a `notice`, it is
 * appended. Arrays, scalars: wrapped as `{ notice, …, result }`. Returns as-is if nothing to notice.
 * @param {any} result
 * @param {{ userEditing?: Array<object>, overwrote?: Array<object> }} extra
 */
export function annotateResult(result, { userEditing = [], overwrote = [] } = {}) {
  const hasEditing = Array.isArray(userEditing) && userEditing.length > 0;
  const hasOver = Array.isArray(overwrote) && overwrote.length > 0;
  if (!hasEditing && !hasOver) return result;
  const lines = [hasOver ? overwroteNotice(overwrote) : '', hasEditing ? userEditingNotice(userEditing) : ''].filter(Boolean);
  const fields = { ...(hasEditing ? { userEditing } : {}), ...(hasOver ? { overwrote } : {}) };
  if (!isPlainObject(result)) return { notice: lines.join('\n'), ...fields, result };
  // Already carrying a notice (executor placed overwrote first, entry point adds userEditing): previous sentence appended, fields preserved
  const prior = typeof result.notice === 'string' && result.notice ? [result.notice] : [];
  const { notice: _old, ...rest } = result;
  return { notice: [...lines, ...prior].join('\n'), ...fields, ...rest, ...fields };
}

/** When a tool throws an error (e.g. write rejected as stale): appends the "User is editing" message after the error */
export function annotateError(err, userEditing) {
  if (!Array.isArray(userEditing) || !userEditing.length || !err || typeof err !== 'object') return err;
  const line = userEditingNotice(userEditing);
  try {
    err.message = `${err.message}\n${line}`;
    err.userEditing = userEditing;
  } catch { /* Skip frozen error objects */ }
  return err;
}
