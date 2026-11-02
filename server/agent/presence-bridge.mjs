/**
 * Bridge between editor process and document service presence (plan
 * `docs/plan/agent-workflow-plan.md` A3 Phase 2).
 *
 * The document service side is `../docservice/modules/presence.mjs` (forwarded only in memory, with
 * expiration time, does not enter project history). Here:
 *   - **Receive**: `presence.update` / `presence.state` / `presence.message` received on
 *     subscription connection (the one in `doc-link.mjs` that doubles as subscription):
 *       - `kind: 'editing'`: clips currently edited by other members' pages → another source for
 *         A2 board (`reportRemote`), showing notice "User <member> is editing" when Agent reads
 *         or writes; copy published by local page itself is skipped by session number;
 *       - `kind: 'agent'`: scopes declared by Agents on other members' sides → bulletin board list
 *         (`applyRemoteAgent`); those sent by this process are skipped by `origin`;
 *       - `kind: 'agent-message'`: message sent to an Agent on this machine → enters its inbox
 *         (same delivery path as local `send_message`);
 *   - **Send**: local Agent declares a scope (bulletin board `onDeclare`) → `presence.set` via
 *     **this Agent's own connection** (its write identity);
 *     local Agent sends a message to an Agent on another member's side (bulletin board
 *     `forwardRemote`) → `presence.send`.
 *
 * **Compatibility**: legacy document service (without presence module) returns
 * `error { reason: 'unsupported' }` for these messages. When first seen, record "unsupported", and
 * never send thereafter; does not throw or disconnect, simply lacks cross-device notices. Request
 * timeouts or unready connections also only mean this single transmission was not sent.
 *
 * Only depends on bulletin board and board interfaces in this directory; connections are provided by
 * `doc-link.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { BOARD_DEFAULTS } from './agent-board.mjs';

export const PRESENCE_DEFAULTS = Object.freeze({
  /**
   * Expiration time for Agent scope: consistent with bulletin board "how long without activity before
   * it is no longer considered running"
   */
  agentTtlMs: BOARD_DEFAULTS.idleMs,
  /** Upper limit for waiting for a response to a single request */
  requestTimeoutMs: 5_000,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Write identity → member name: in shared projects, userId is "username@device", extract only
 * username; local space (local) returns null
 */
export function memberOf(actor) {
  const u = typeof actor?.userId === 'string' ? actor.userId : null;
  if (!u || u === 'local' || u === 'anonymous') return null;
  const at = u.indexOf('@');
  return at > 0 ? u.slice(0, at) : u;
}

/**
 * @param {object} o
 * @param {ReturnType<import('./doc-link.mjs').createAgentLink>} o.link
 * @param {() => ReturnType<import('./agent-board.mjs').createAgentBoard>} o.board
 * @param {ReturnType<import('./user-editing.mjs').createUserEditingBoard>} [o.editing]
 * @param {(agentKey: string) => number} o.conversationNumberOf chat ID → its chat number on this
 *   link (`conversationNumber` in `agent-side`)
 * @param {(key: string) => string | null} [o.labelOf] chat ID → vendor
 * @param {(key: string) => { role?: string | null } | null} [o.infoOf]
 * @param {string} [o.origin] identifier of this process (used to skip messages sent by self and
 *   received back)
 */
export function createPresenceBridge({ link, board, editing = null, conversationNumberOf, labelOf = () => null, infoOf = () => null, origin = `ed-${randomBytes(6).toString('base64url')}`, log = () => {}, limits: limitsIn = {} } = {}) {
  if (!link || typeof board !== 'function' || typeof conversationNumberOf !== 'function') throw new TypeError('createPresenceBridge: requires link, board, conversationNumberOf');
  const L = { ...PRESENCE_DEFAULTS, ...limitsIn };
  const projectId = link.projectId;
  /**
   * null = not known yet; true = recognized by document service; false = legacy document service, do
   * not send anymore
   */
  let supported = null;
  const stats = { sent: 0, failed: 0, received: 0, unsupported: 0 };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect operation */ } };

  function markReply(reply) {
    if (reply?.type === 'error') {
      if (reply.reason === 'unsupported') {
        if (supported !== false) say('agent.presence.unsupported', { projectId });
        supported = false;
        stats.unsupported += 1;
      } else {
        stats.failed += 1;
      }
      return false;
    }
    if (reply?.type === 'presence.ok' || reply?.type === 'presence.state') supported = true;
    return true;
  }

  /**
   * Send one via a specific chat's connection; returns response (returns null on failure, does not
   * throw)
   */
  async function request(agentKey, message) {
    if (supported === false) return null;
    let conn;
    try {
      conn = link.conversation(conversationNumberOf(agentKey));
    } catch {
      return null;
    }
    try {
      const reply = await conn.request({ ...message, projectId }, (m) => m.type === 'presence.ok' || m.type === 'presence.state' || m.type === 'error');
      stats.sent += 1;
      markReply(reply);
      return reply;
    } catch (err) {
      stats.failed += 1;
      say('agent.presence.send-failed', { type: message.type, message: String(err?.message ?? err) });
      return null;
    }
  }

  function ingestUpdate({ key, from, data, expiresAt }) {
    if (typeof key !== 'string') return;
    const member = memberOf(from);
    if (key === 'editing' || key.startsWith('editing:')) {
      if (!editing) return;
      const session = isObj(data) && typeof data.session === 'string' ? data.session : null;
      if (data === null) {
        // Revocation does not include data: recognized by session in publisher identity
        const s = typeof from?.session === 'string' ? from.session : null;
        if (s) editing.clearRemote(s);
        return;
      }
      if (!session || data.kind !== 'editing') return;
      editing.reportRemote(session, data.entities, { who: member ?? (typeof data.who === 'string' ? data.who : null), expiresAt });
      return;
    }
    if (key.startsWith('agent:')) {
      const id = key.slice('agent:'.length);
      if (data === null) { board().removeRemoteAgent(id); return; }
      if (!isObj(data) || data.kind !== 'agent' || data.origin === origin) return;
      board().applyRemoteAgent({ id, member: member ?? (typeof data.member === 'string' ? data.member : '?'), vendor: data.vendor ?? null, scope: data.scope ?? null, busy: !!data.busy, expiresAt });
    }
  }

  function ingestMessage({ from, data }) {
    if (!isObj(data) || data.kind !== 'agent-message' || data.origin === origin) return;
    if (typeof data.to !== 'string' || typeof data.text !== 'string') return;
    const b = board();
    const local = b.listRaw('').find((a) => a.id === data.to && !a.remote);
    if (!local) return;
    const member = memberOf(from);
    const who = `Agent ${data.from ?? '?'} (${[data.vendor, member ? `on member ${member}'s side` : null].filter(Boolean).join(', ') || 'on another member\'s side'})`;
    b.deliver({ from: typeof data.from === 'string' ? data.from : null, fromLabel: who, to: data.to, text: data.text, hops: data.hops });
  }

  const off = link.onMessage((msg) => {
    if (!isObj(msg) || (msg.projectId !== undefined && msg.projectId !== projectId)) return;
    switch (msg.type) {
      case 'presence.update':
        stats.received += 1;
        ingestUpdate(msg);
        return;
      case 'presence.message':
        stats.received += 1;
        ingestMessage(msg);
        return;
      case 'project.state':
        // Subscription connection (re)opened the project: fetch existing presence once (clips currently
        // edited by other members, scopes declared by others' Agents)
        void refresh();
        return;
      default:
    }
  });

  async function refresh() {
    const reply = await request('', { type: 'presence.list' });
    if (reply?.type !== 'presence.state' || !Array.isArray(reply.entries)) return;
    for (const e of reply.entries) ingestUpdate(e);
  }

  const bridge = {
    origin,

    /** Scope of a local Agent (or revoked: scope is null) published via its own connection */
    async publishAgent(agentKey) {
      if (typeof agentKey !== 'string' || !agentKey) return null;
      const b = board();
      const me = b.listRaw(agentKey).find((a) => a.you);
      const info = (() => { try { return infoOf(agentKey) ?? {}; } catch { return {}; } })();
      if (!me?.scope) return request(agentKey, { type: 'presence.clear', key: `agent:${agentKey}` });
      return request(agentKey, {
        type: 'presence.set',
        key: `agent:${agentKey}`,
        ttlMs: L.agentTtlMs,
        data: { v: 1, kind: 'agent', origin, id: agentKey, vendor: labelOf(agentKey) ?? null, role: info.role ?? null, scope: me.scope, busy: !!me.busy },
      });
    },

    /**
     * Local Agent sends to an Agent on another member's side: broadcast via sender's own connection
     * (the recipient's editor process recognizes it by `to`)
     */
    forward({ from, to, text, hops }) {
      if (supported === false) return false;
      void request(typeof from === 'string' ? from : '', {
        type: 'presence.send',
        data: { v: 1, kind: 'agent-message', origin, from: from ?? null, to, text, hops, vendor: from ? labelOf(from) ?? null : null },
      });
      return true;
    },

    /**
     * Immediately open subscription and fetch once (called when binding project, without waiting for
     * Agent's first tool call)
     */
    async start() {
      try {
        link.conversation(conversationNumberOf(''));
        await link.ready();
      } catch (err) {
        say('agent.presence.start-failed', { message: String(err?.message ?? err) });
        return;
      }
      await refresh();
    },

    supported() {
      return supported;
    },

    describe() {
      return { origin, supported, stats: { ...stats } };
    },

    close() {
      off();
    },
  };
  return bridge;
}
