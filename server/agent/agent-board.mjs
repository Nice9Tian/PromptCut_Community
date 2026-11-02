/**
 * Coordination bulletin board for multi-agent (plan `docs/plan/agent-workflow-plan.md` A3; semantics
 * `user-workflow.md` "Multi-Agent", "Protection").
 *
 * Previously in page memory (`src/ai/agentBus.ts`), only seeing tool calls executed through that
 * page; now placed in the editor process, **one per project** (`createAgentBoards`), with
 * `declare_scope` / `list_agents` / `send_message` / `check_messages` answered on the server side,
 * so all Agents (AI panel tabs, spawned subagents, and future desktop app sessions directly connected
 * via MCP) see the same copy.
 *
 * Four things:
 *   1. **Agent list**: tabs reported by pages (`setTabs`: chat ID, tab name, busy status), sessions
 *      that have called tools (`touch`), and Agents from other members in shared projects
 *      (`applyRemote*`, forwarded via document service, Phase 2).
 *   2. **Scope declarations**: `declare_scope` recorded on the list, updating tab names accordingly
 *      (pushed to the page via SSE).
 *   3. **Change log**: fed by the document service's **commit stream** (`noteCommit`, with write
 *      identity: page = user, each Agent, other members in shared projects), calculating which
 *      "cut -> track" items were touched before and after the commit (`src/kernel/agentScopes.mjs`).
 *      When not connected to the document service, falls back to recording at tool entry points
 *      (`noteChange`, page executor computes scope and returns it with results).
 *   4. **Mailbox**: `send_message` drops into the recipient's mailbox. If the recipient tab is idle,
 *      the page picks it up and sends it as a user message; if busy, it accumulates and is sent
 *      after execution completes; automatic hops are capped at `MAX_AUTO_HOPS`.
 *
 * Additionally, the recipient's **next tool result** includes (`pendingFor` / `annotate`, placed
 * consistently with A2's `user-editing.mjs`, with `notice` first):
 *   - Messages in the mailbox (carried out counts as delivered, no longer auto-delivered);
 *   - Others modified your declared scope (notified only once per item);
 *   - Content you wrote was overwritten (`project.overwritten` sent by the document service on your
 *     connection, `noteOverwritten`);
 * The writer's current result includes "You wrote into the scope declared for editing by Agent <chat>"
 * (`writerNotice`).
 *
 * In-memory only: cleared when the editor process restarts, reappearing on the next action of tabs
 * and sessions.
 */
import { diffScopes, overlappingScopes, splitScopes, scopeOverlaps } from './ssr-host.mjs';
import { tr } from '../i18n.mjs';

export const BOARD_DEFAULTS = Object.freeze({
  /** Maximum auto-delivery chain depth; beyond this, messages stay in the mailbox until the user speaks to it next time */
  MAX_AUTO_HOPS: 3,
  /** How many change records to keep */
  maxChanges: 500,
  /** Maximum messages accumulated in the mailbox (project-wide) */
  maxInbox: 200,
  /** How long an Agent has no activity (no open tab, no tools called, not running) before it is no longer considered "running", and its declared scope is no longer compared ([ruling] 30 minutes) */
  idleMs: 30 * 60_000,
  /** Maximum number of items listed in results */
  showMax: 8,
  /** Maximum number of updates prepended to the prompt at the start of a round */
  notesMax: 40,
  /** Each Agent remembers the count of changes already notified in tool results */
  notifiedKeep: 500,
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

function fmtTime(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Document service write identity → "who" in the record: { kind: 'user' | 'agent' | 'render' | 'unknown', agent?, userId? } */
export function byOfActor(actor) {
  if (!isPlainObject(actor)) return { kind: 'unknown' };
  if (actor.role === 'page') {
    const other = actor.userId && actor.userId !== 'local' ? String(actor.userId) : null;
    return other ? { kind: 'user', userId: other } : { kind: 'user' };
  }
  if (actor.role === 'agent') {
    const s = typeof actor.session === 'string' && actor.session.startsWith('agent:') ? actor.session.slice('agent:'.length) : null;
    const agent = s === 'default' ? '' : s;
    return { kind: 'agent', agent: agent ?? null, ...(actor.userId && actor.userId !== 'local' ? { userId: String(actor.userId) } : {}) };
  }
  if (actor.role === 'render') return { kind: 'render' };
  return { kind: 'unknown', ...(actor.userId ? { userId: String(actor.userId) } : {}) };
}

/**
 * @param {object} [o]
 * @param {() => number} [o.now]
 * @param {(key: string) => string | null} [o.labelOf] Chat ID → provider name (used in
 *   "Agent <chat>(<provider>)")
 * @param {(key: string) => { role?: string | null, roleName?: string | null, parent?: string | null } | null} [o.infoOf]
 *   Chat ID → role and parent chat in the registry (displayed in the list)
 * @param {(msg: object) => boolean} [o.forwardRemote] When recipient is an Agent belonging to another
 *   member in a shared project, forward via document service (Phase 2); returns false if forwarding fails
 */
export function createAgentBoard({ now = () => Date.now(), labelOf = () => null, infoOf = () => null, forwardRemote = null, limits: limitsIn = {} } = {}) {
  const L = { ...BOARD_DEFAULTS, ...limitsIn };
  /** key → list entry */
  const agents = new Map();
  const changes = [];
  const inbox = [];
  let seq = 0;
  /** key → sequence number from the last "take activity" */
  const seen = new Map();
  /** key → change sequence number already reported in tool results */
  const notified = new Map();
  /** key → overwritten records (included in the next tool result) */
  const overwritten = new Map();
  const overwrittenSeen = new Set();
  /** key → tool name currently running (recognized in commit stream as written by it, record includes tool name) */
  const calls = new Map();
  /** Writes executed by the page on behalf of an Agent: opId → chat */
  const pageOps = new Map();
  const listeners = new Set();

  function emit() {
    for (const fn of [...listeners]) {
      try { fn(); } catch { /* Subscriber errors do not affect the bulletin board */ }
    }
  }

  function entry(key) {
    let a = agents.get(key);
    if (!a) {
      a = { id: key, title: null, tab: false, tabBusy: false, runs: 0, hops: 0, scope: null, scopeAt: null, lastActive: now(), remote: null };
      agents.set(key, a);
    }
    return a;
  }

  const label = (key) => {
    let v = null;
    try { v = labelOf(key); } catch { v = null; }
    return v;
  };

  /** "Agent <chat>(<vendor>)"; for other members in a shared project, include the member name */
  function agentText(key) {
    if (key === '' || key === null || key === undefined) return 'An Agent without a chat ID';
    const a = agents.get(key);
    const vendor = a?.remote?.vendor ?? label(key);
    const member = a?.remote?.member ? `on member ${a.remote.member}'s side` : '';
    return `Agent ${key}${vendor || member ? ` (${[vendor, member].filter(Boolean).join(', ')})` : ''}`;
  }

  function byText(by) {
    if (!by) return 'Unknown writer';
    if (by.kind === 'user') return by.userId ? `User ${by.userId}` : 'User';
    if (by.kind === 'agent') return agentText(by.agent);
    if (by.kind === 'render') return 'Render node';
    return by.userId ? `User ${by.userId}` : 'Unknown writer';
  }

  const isBusy = (key) => {
    const a = agents.get(key);
    return !!a && (a.runs > 0 || a.tabBusy);
  };

  /** Considered "running": tab open, round running, recently active, or reported by others in shared project and unexpired */
  function isLive(a, t = now()) {
    if (!a) return false;
    if (a.remote) return a.remote.expiresAt > t;
    return a.tab || a.runs > 0 || t - a.lastActive < L.idleMs;
  }

  function liveAgents() {
    const t = now();
    return [...agents.values()].filter((a) => isLive(a, t));
  }

  function unreadOf(key) {
    return inbox.filter((m) => m.to === key).length;
  }

  function pushChange(c) {
    changes.push({ seq: ++seq, at: now(), ...c });
    if (changes.length > L.maxChanges) changes.splice(0, changes.length - L.maxChanges);
    emit();
  }

  function fmtChange(c) {
    const who = byText(c.by);
    if (c.kind === 'declare') return `${fmtTime(c.at)} ${who} declared edit scope: ${c.scopes.join(',')}`;
    const scopeOf = c.by?.kind === 'agent' ? agents.get(c.by.agent)?.scope : null;
    const whoScope = scopeOf ? `(declared scope "${scopeOf}")` : '';
    return `${fmtTime(c.at)} ${who}${whoScope}${c.tool ? ` using ${c.tool}` : ''} changed ${c.scopes.join(',')}`;
  }

  function markNotified(key, s) {
    let set = notified.get(key);
    if (!set) notified.set(key, (set = new Set()));
    set.add(s);
    if (set.size > L.notifiedKeep) set.delete(set.values().next().value);
  }

  const mine = (c, key) => c.by?.kind === 'agent' && c.by.agent === key;

  const board = {
    limits: L,
    MAX_AUTO_HOPS: L.MAX_AUTO_HOPS,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Current sequence number (recorded before tool call; check after call for records added in the interim) */
    seq() {
      return seq;
    },

    /* ---------------- List ---------------- */

    /** Tabs reported by the page (full replacement): [{ conversationId, title, busy }] */
    setTabs(list) {
      const present = new Set();
      for (const raw of Array.isArray(list) ? list : []) {
        if (!isPlainObject(raw) || typeof raw.conversationId !== 'string' || !KEY_RE.test(raw.conversationId)) continue;
        const a = entry(raw.conversationId);
        a.tab = true;
        a.tabBusy = raw.busy === true;
        a.title = typeof raw.title === 'string' ? raw.title.slice(0, 80) : a.title;
        a.lastActive = now();
        present.add(raw.conversationId);
      }
      for (const a of agents.values()) {
        if (a.tab && !present.has(a.id)) { a.tab = false; a.tabBusy = false; a.closedAt = now(); }
      }
      emit();
    },

    /** Is this tab still open (used for concurrency quota counting of spawned subagents) */
    tabOpen(key) {
      return !!agents.get(key)?.tab;
    },

    /** Tab was closed (reported open, later no longer present) */
    tabClosed(key) {
      const a = agents.get(key);
      return !!a && !a.tab && a.closedAt != null;
    },

    /** This chat called a tool once */
    touch(key) {
      if (typeof key !== 'string' || !key) return;
      entry(key).lastActive = now();
    },

    /** Round starts (AI panel sends a message): record its auto-delivery level (0 = sent by user) */
    beginRun(key, hops = 0) {
      if (typeof key !== 'string' || !key) return;
      const a = entry(key);
      a.runs += 1;
      a.hops = Number.isSafeInteger(hops) && hops > 0 ? Math.min(hops, L.MAX_AUTO_HOPS) : 0;
      a.lastActive = now();
      if (!seen.has(key)) seen.set(key, seq);
      emit();
    },

    endRun(key) {
      const a = agents.get(key);
      if (!a) return;
      a.runs = Math.max(0, a.runs - 1);
      if (a.runs === 0) a.hops = 0;
      a.lastActive = now();
      emit();
    },

    isBusy,

    /**
     * Revoke the scope declared by this chat; returns true only if it previously existed. Used when
     * a cloud round ends (`service/instance.mjs`): cloud chats have no tabs to close; if the scope
     * remains attached after a round ends (including failure, stopped, or revoked), other members
     * will continuously see "<member>'s Cloud Agent is editing: …".
     */
    clearScope(key) {
      const a = agents.get(key);
      if (!a || !a.scope) return false;
      a.scope = null;
      a.scopeAt = null;
      a.lastActive = now();
      emit();
      return true;
    },

    /** Tool currently running for this chat (commit stream records include the tool name) */
    beginCall(key, tool) {
      if (typeof key === 'string') calls.set(key, tool);
    },
    endCall(key) {
      calls.delete(key);
    },

    /* ---------------- Change records ---------------- */

    /**
     * A commit from the document service landed on the replica (`onCommit` in `doc-link.mjs`):
     * calculate the scope based on the project before and after the commit, and record an entry.
     * @param {{ rev?: number, opId?: string | null, actor?: object, before: object, after: object }} c
     */
    noteCommit({ rev = null, opId = null, actor = null, before, after }) {
      const scopes = diffScopes(before, after);
      if (!scopes.length) return null;
      let by = byOfActor(actor);
      // Tool write executed by the page on behalf of an Agent (committed with page identity): attribute to that Agent
      if (opId && pageOps.has(opId)) {
        by = { kind: 'agent', agent: pageOps.get(opId) };
        pageOps.delete(opId);
      }
      const tool = by.kind === 'agent' ? calls.get(by.agent) ?? null : null;
      pushChange({ by, tool, scopes, kind: 'change', opId, rev });
      return changes[changes.length - 1];
    },

    /** Fallback when not connected to document service: record at tool entry (scope computed by page executor) */
    noteChange(key, tool, scopes) {
      const list = Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string' && s).slice(0, 32) : [];
      if (!list.length) return null;
      pushChange({ by: { kind: 'agent', agent: typeof key === 'string' ? key : null }, tool: tool ?? null, scopes: list, kind: 'change', opId: null, rev: null });
      return changes[changes.length - 1];
    },

    /** Writes by page for this Agent (opIds in page response): attribute to it when recognized in commit stream */
    attributeOps(key, opIds) {
      for (const id of Array.isArray(opIds) ? opIds : []) {
        if (typeof id !== 'string') continue;
        const hit = [...changes].reverse().find((c) => c.opId === id);
        if (hit) hit.by = { kind: 'agent', agent: key };
        else pageOps.set(id, key);
      }
      while (pageOps.size > 256) pageOps.delete(pageOps.keys().next().value);
    },

    /** Scope written by key between (sinceSeq, now] */
    writtenBy(key, sinceSeq) {
      const out = [];
      for (const c of changes) {
        if (c.seq > sinceSeq && c.kind === 'change' && mine(c, key)) for (const s of c.scopes) if (!out.includes(s)) out.push(s);
      }
      return out;
    },

    /** The overwritten party: `project.overwritten` sent by document service to its connection (deduplicated) */
    noteOverwritten(victim, { entity, by, rev, at } = {}) {
      if (typeof victim !== 'string' || typeof entity !== 'string') return;
      const k = `${victim}|${rev}|${entity}`;
      if (overwrittenSeen.has(k)) return;
      overwrittenSeen.add(k);
      if (overwrittenSeen.size > 2000) overwrittenSeen.delete(overwrittenSeen.values().next().value);
      let list = overwritten.get(victim);
      if (!list) overwritten.set(victim, (list = []));
      list.push({ entity, by: byOfActor(by), rev: Number.isSafeInteger(rev) ? rev : null, at: Number.isFinite(at) ? at : now() });
      if (list.length > 64) list.splice(0, list.length - 64);
    },

    /* ---------------- Tools ---------------- */

    declareScope(key, args) {
      const scope = typeof args?.scope === 'string' ? args.scope.trim().slice(0, 120) : '';
      if (!scope) throw new Error('scope is required, write it as "cut X->track X", separate multiple with commas');
      if (!key) {
        return { ok: false, error: 'This call carries no Agent chat ID (it may have come through agy or an external command line), so the scope cannot be recorded on the tab; other Agents will not see this declaration either' };
      }
      const a = entry(key);
      a.scope = scope;
      a.scopeAt = now();
      a.lastActive = now();
      const note = typeof args?.note === 'string' ? args.note.trim().slice(0, 300) : '';
      pushChange({ by: { kind: 'agent', agent: key }, tool: 'declare_scope', scopes: [scope + (note ? `(${note})` : '')], kind: 'declare', opId: null, rev: null });
      board.onDeclare?.(key, scope, note);
      const others = board.listRaw(key).filter((x) => !x.you);
      const clash = others.filter((x) => x.scope && scopeOverlaps(x.scope, scope));
      return {
        ok: true,
        you: key,
        tab: a.title,
        otherAgents: others,
        ...(clash.length ? { warning: `The scope overlaps with ${clash.map((c) => `${c.id}(${c.scope})`).join(', ')}; use send_message first to agree on who edits which part` } : {}),
      };
    },

    listRaw(key) {
      return liveAgents().map((a) => {
        const info = (() => { try { return infoOf(a.id) ?? null; } catch { return null; } })();
        return {
          id: a.id,
          title: a.title ?? (a.remote ? tr("Member {0}'s Agent", a.remote.member) : null),
          scope: a.scope,
          busy: a.remote ? !!a.remote.busy : isBusy(a.id),
          you: a.id === key,
          unread: unreadOf(a.id),
          ...(label(a.id) || a.remote?.vendor ? { vendor: a.remote?.vendor ?? label(a.id) } : {}),
          ...(info?.role && info.role !== 'main' ? { role: info.role, ...(info.roleName ? { roleName: info.roleName } : {}) } : {}),
          ...(info?.parent ? { parent: info.parent } : {}),
          ...(a.remote ? { member: a.remote.member, remote: true } : {}),
        };
      });
    },

    listAgents(key) {
      return { you: key || null, agents: board.listRaw(key) };
    },

    sendMessage(key, args) {
      const text = typeof args?.text === 'string' ? args.text.trim().slice(0, 4000) : '';
      const to = typeof args?.to === 'string' ? args.to.trim() : '';
      if (!text) throw new Error('text is required');
      if (!to) throw new Error('to is required: the chat ID of the recipient Agent, look it up with list_agents; use all to send to every other Agent; use user to speak to the user');
      // Speak to the user (user decision, 2026-10-20): the UI renders text from the tool call into this round's
      // bubble; the bulletin board does not deliver it (server/harness/tools/userMessage.mjs)
      if (to.toLowerCase() === 'user') return { ok: true, shown: true, note: 'Shown in the user\'s chat bubble' };
      const targets = to === 'all' ? liveAgents().filter((a) => a.id !== key).map((a) => a.id) : [to];
      if (targets.length === 0) return { ok: false, error: 'No other Agent is running' };
      const hops = (key && agents.get(key)?.hops) || 0;
      const delivered = [];
      const unknown = [];
      const remote = [];
      for (const t of targets) {
        const a = agents.get(t);
        if (!a || !isLive(a)) { unknown.push(t); continue; }
        if (a.remote) {
          const ok = typeof forwardRemote === 'function' && forwardRemote({ from: key || null, to: t, text, hops: hops + 1 }) !== false;
          if (ok) { delivered.push(t); remote.push(t); } else unknown.push(t);
          continue;
        }
        board.deliver({ from: key || null, to: t, text, hops: hops + 1 });
        delivered.push(t);
      }
      emit();
      if (delivered.length === 0) throw new Error(`No such Agent: ${unknown.join(', ')} (use list_agents to see which exist)`);
      const busyTargets = delivered.filter((t) => !remote.includes(t) && isBusy(t));
      return {
        ok: true,
        delivered,
        ...(unknown.length ? { unknown } : {}),
        note: busyTargets.length
          ? `${busyTargets.join(', ')} is running; the message will be included in the result of its next tool call, and anything it has not seen after this turn ends will be delivered automatically; the idle ones have already been sent it as a message`
          : hops + 1 >= L.MAX_AUTO_HOPS
            ? 'The Agents have already messaged each other for several rounds in a row; this message will stay in the recipient\'s mailbox and be delivered together the next time the user talks to it, and will no longer trigger it to run automatically'
            : remote.length === delivered.length
              ? 'The recipient is with another member of the shared project; the message has been forwarded through the document service'
              : 'The recipient is idle; the message was sent to it as a user message and it will start processing',
      };
    },

    /** Deliver a message into the mailbox (local, or forwarded from the document service) */
    deliver({ from = null, fromLabel = null, to, text, hops = 1 }) {
      if (typeof to !== 'string' || typeof text !== 'string' || !text) return;
      entry(to);
      inbox.push({ seq: ++seq, at: now(), from, ...(fromLabel ? { fromLabel } : {}), to, text: text.slice(0, 4000), hops: Math.max(1, Math.min(Number(hops) || 1, L.MAX_AUTO_HOPS)) });
      if (inbox.length > L.maxInbox) inbox.splice(0, inbox.length - L.maxInbox);
      emit();
    },

    /** Unprocessed messages in its own mailbox (not consumed) and what others changed since last time */
    checkMessages(key) {
      if (!key) return { ok: false, error: 'This call carries no Agent chat ID' };
      const list = inbox.filter((m) => m.to === key);
      const others = changes.filter((c) => !mine(c, key) && c.seq > (seen.get(key) ?? 0));
      return {
        you: key,
        messages: list.map(({ from, fromLabel, text, at }) => ({ from, ...(fromLabel ? { fromLabel } : {}), text, at: new Date(at).toISOString() })),
        changes: others.map(fmtChange),
      };
    },

    /* ---------------- Delivery / Injection ---------------- */

    /** Fetch messages delivered to this Agent; onlyAuto only fetches those within depth limit (for idle page auto-delivery) */
    takeInbox(key, onlyAuto) {
      const picked = [];
      for (let i = inbox.length - 1; i >= 0; i -= 1) {
        const m = inbox[i];
        if (m.to !== key) continue;
        if (onlyAuto && m.hops >= L.MAX_AUTO_HOPS) continue;
        picked.unshift(m);
        inbox.splice(i, 1);
      }
      if (picked.length) emit();
      return picked.map((m) => ({ ...m }));
    },

    hasAutoDeliverable(key) {
      return inbox.some((m) => m.to === key && m.hops < L.MAX_AUTO_HOPS);
    },

    /** When an Agent first appears, align sequence numbers first to avoid treating pre-creation history as news */
    markSeen(key) {
      if (typeof key === 'string' && !seen.has(key)) seen.set(key, seq);
    },

    /**
     * "Other agents' activity" to prepend to this Agent's prompt for this round: what others
     * changed, and messages in the mailbox that reached the limit and were not auto-delivered.
     * Considered read once fetched. Changes already reported in tool results are not listed again.
     */
    consumeNotes(key) {
      if (typeof key !== 'string' || !key) return '';
      const since = seen.get(key) ?? 0;
      const told = notified.get(key);
      const others = changes.filter((c) => !mine(c, key) && c.seq > since && !told?.has(c.seq));
      const held = board.takeInbox(key, false);
      seen.set(key, seq);
      if (others.length === 0 && held.length === 0) return '';
      const lines = ['[Activity from other Agents: attached automatically by the system, not something the user said]', `Your Agent chat ID: ${key}`];
      for (const c of others.slice(-L.notesMax)) lines.push(`- ${fmtChange(c)}`);
      for (const m of held) lines.push(`- Message to you from ${m.fromLabel ?? agentText(m.from)} ${fmtTime(m.at)}: ${m.text}`);
      lines.push('[/Activity from other Agents]');
      return lines.join('\n');
    },

    /**
     * Items to include in this Agent's next tool result: messages in mailbox (delivered once included),
     * modifications by others to its declared scope, and overwrites of its writes. Cleared once fetched.
     * @returns {{ messages: object[], scopeChanges: object[], overwrittenBy: object[] }}
     */
    pendingFor(key) {
      const out = { messages: [], scopeChanges: [], overwrittenBy: [] };
      if (typeof key !== 'string') return out;
      if (key) {
        out.messages = board.takeInbox(key, false).map((m) => ({ from: m.from, ...(m.fromLabel ? { fromLabel: m.fromLabel } : {}), text: m.text, at: new Date(m.at).toISOString() }));
        const a = agents.get(key);
        if (a?.scope) {
          const told = notified.get(key);
          for (const c of changes) {
            if (c.kind !== 'change' || mine(c, key) || told?.has(c.seq) || (a.scopeAt != null && c.at < a.scopeAt)) continue;
            const hit = overlappingScopes(c.scopes, a.scope);
            if (!hit.length) continue;
            markNotified(key, c.seq);
            out.scopeChanges.push({ who: byText(c.by), by: c.by, scopes: hit, ...(c.tool ? { tool: c.tool } : {}), at: new Date(c.at).toISOString() });
          }
        }
      }
      const ow = overwritten.get(key);
      if (ow?.length) {
        overwritten.delete(key);
        out.overwrittenBy = ow.map((o) => ({ entity: o.entity, who: byText(o.by), by: o.by.kind, ...(o.rev != null ? { rev: o.rev } : {}), agoMs: Math.max(0, now() - o.at) }));
      }
      return out;
    },

    /**
     * Writer: the scope written this time overlaps with the declared scope of another running Agent.
     * @returns {Array<{ agent: string, who: string, scope: string, written: string[] }>}
     */
    writerNotice(key, sinceSeq) {
      const written = board.writtenBy(key, sinceSeq);
      if (!written.length) return [];
      const out = [];
      for (const a of liveAgents()) {
        if (a.id === key || !a.scope) continue;
        const hit = overlappingScopes(written, a.scope);
        if (hit.length) out.push({ agent: a.id, who: agentText(a.id), scope: a.scope, written: hit });
      }
      return out;
    },

    /* ---------------- For the page ---------------- */

    /** Pushed to the page (SSE `agent.board`): scope, unread count, auto-deliverable count, busy state per chat */
    snapshot() {
      return [...agents.values()].map((a) => ({
        id: a.id,
        scope: a.scope,
        unread: unreadOf(a.id),
        deliverable: inbox.filter((m) => m.to === a.id && m.hops < L.MAX_AUTO_HOPS).length,
        busy: a.remote ? !!a.remote.busy : isBusy(a.id),
        ...(a.remote ? { remote: true, member: a.remote.member, live: isLive(a) } : {}),
      }));
    },

    /* ---------------- Agents from other members in a shared project (Phase 2, via document service) ---------------- */

    /** An Agent from another member reported a scope (or renewed); scope as null means revoke */
    applyRemoteAgent({ id, member, vendor = null, scope = null, busy = false, expiresAt }) {
      if (typeof id !== 'string' || !KEY_RE.test(id)) return;
      const local = agents.get(id);
      if (local && !local.remote && (local.tab || local.runs > 0)) return; // Prefer local chat with the same name (should not happen, defensive)
      const a = entry(id);
      a.remote = { member: typeof member === 'string' && member ? member.slice(0, 64) : '?', vendor: typeof vendor === 'string' ? vendor.slice(0, 64) : null, busy: !!busy, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + L.idleMs };
      if (scope !== a.scope) {
        a.scope = typeof scope === 'string' && scope ? scope.slice(0, 120) : null;
        a.scopeAt = now();
        if (a.scope) pushChange({ by: { kind: 'agent', agent: id }, tool: 'declare_scope', scopes: [a.scope], kind: 'declare', opId: null, rev: null });
      }
      a.lastActive = now();
      emit();
    },

    removeRemoteAgent(id) {
      const a = agents.get(id);
      if (a?.remote) { agents.delete(id); emit(); }
    },

    /** Diagnostics and testing */
    describe() {
      return { seq, agents: board.snapshot(), changes: changes.length, inbox: inbox.length };
    },
    _changes() {
      return changes;
    },
    /** Hook: local Agent declared a scope (broadcast via document service in Phase 2) */
    onDeclare: null,
  };
  return board;
}

/* ------------------------------------------------------------------ Notices in results */

/**
 * Put what the bulletin board needs to tell this Agent into its current tool result: `notice` comes
 * first (existing notices appended after it), plus `messages` / `scopeChanges` / `overwrittenBy` /
 * `scopeClash` fields. Placement is consistent with `annotateResult` in `user-editing.mjs`.
 * @param {any} result
 * @param {{ messages?: object[], scopeChanges?: object[], overwrittenBy?: object[], scopeClash?: object[] }} extra
 */
export function annotateBoard(result, { messages = [], scopeChanges = [], overwrittenBy = [], scopeClash = [] } = {}, limits = BOARD_DEFAULTS) {
  const lines = [];
  const fields = {};
  const cap = (arr) => arr.slice(0, limits.showMax);
  const more = (arr) => (arr.length > limits.showMax ? ` and ${arr.length} more` : '');
  if (overwrittenBy.length) {
    const shown = cap(overwrittenBy).map((o) => {
      const clip = /\/clips\/@([^/]+)/.exec(o.entity)?.[1];
      return `${clip ? `clip ${clip}` : o.entity} (overwritten by ${o.who}${o.rev != null ? `, rev ${o.rev}` : ''})`;
    });
    lines.push(`You wrote ${shown.join(', ')}${more(overwrittenBy)}. Re-read to confirm the current content, coordinate with them if needed, and do not simply revert it.`);
    fields.overwrittenBy = overwrittenBy;
  }
  if (scopeClash.length) {
    const shown = cap(scopeClash).map((c) => `"${c.scope}" that ${c.who} declared it is editing (you wrote to ${c.written.join(',')})`);
    lines.push(`This write falls within a scope another Agent is editing: ${shown.join(', ')}${more(scopeClash)}. It will learn of this on its next tool call; first use send_message to agree with it on who edits which part.`);
    fields.scopeClash = scopeClash;
  }
  if (scopeChanges.length) {
    const shown = cap(scopeChanges).map((c) => `${c.who}${c.tool ? ` using ${c.tool}` : ''} changed ${c.scopes.join(',')}`);
    lines.push(`Someone else is editing a scope you declared: ${shown.join(';')}${more(scopeChanges)}. Re-read before continuing, and coordinate with send_message if needed.`);
    fields.scopeChanges = scopeChanges;
  }
  if (messages.length) {
    const shown = cap(messages).map((m) => `[${m.fromLabel ?? (m.from ? `Agent ${m.from}` : 'unknown')}] ${m.text}`);
    lines.push(`Message from another Agent (attached by the system, not something the user said): ${shown.join(' ')}${more(messages)}`);
    fields.messages = messages;
  }
  if (!lines.length) return result;
  if (!isPlainObject(result)) return { notice: lines.join('\n'), ...fields, result };
  const prior = typeof result.notice === 'string' && result.notice ? [result.notice] : [];
  const { notice: _old, ...rest } = result;
  return { notice: [...lines, ...prior].join('\n'), ...fields, ...rest, ...fields };
}

/**
 * One bulletin board per project. `boardFor(projectId)` creates one if absent; when `projectId`
 * is empty, use `''` (the local one when no project replica is bound).
 * @param {(projectId: string) => object} [options] Options passed to each `createAgentBoard`
 *   (can be provided per project)
 */
export function createAgentBoards(optionsFor = () => ({})) {
  const boards = new Map();
  return {
    boardFor(projectId = '') {
      const key = typeof projectId === 'string' ? projectId : '';
      let b = boards.get(key);
      if (!b) boards.set(key, (b = createAgentBoard(optionsFor(key))));
      return b;
    },
    has(projectId) {
      return boards.has(projectId);
    },
    list() {
      return [...boards.keys()];
    },
  };
}

export { splitScopes };
