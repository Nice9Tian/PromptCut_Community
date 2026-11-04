/**
 * Agent session registry (plan `docs/plan/agent-workflow-plan.md` A1, used by A2-A4):
 * chat ID → who this session is.
 *
 *   - `type`: `api` (AI panel direct API) / `cli` (AI panel via CLI tool, callback via MCP) /
 *     `desktop` (desktop app session, directly connected via MCP, plan A4: one identity per session
 *     in `server/mcp-server.mjs`, registered via `/api/mcp/call`);
 *   - `vendor`: vendor (claude, codex, agy; direct API uses vendor in settings; desktop app sessions
 *     are claude-code, codex, etc., identified from MCP `clientInfo`); `label`: human-readable vendor
 *     name (only present for desktop app sessions, e.g. "Claude Code"); `client`: self-reported client
 *     name and version;
 *   - `role`: role (lead chat in AI panel is `main`; subagents spawned via A3 `spawn_agent` carry
 *     preset role id);
 *   - `parent`: chat ID that spawned it (A3 subagent; lead chat is `null`). Subagents cannot spawn
 *     further (depth 1);
 *   - `override`: creativity level individually configured for this chat, `null` = follow project.
 *
 * Subagent level (A3 [ruling]): when spawned, takes parent chat's currently effective level as its
 * override; subsequent checks take the lower of its level and parent chat's currently effective
 * level, never exceeding parent chat: user raising it in a child tab only goes up to parent chat tier.
 *
 * Level rules (`user-workflow.md` "Creativity level"): AI panel chats take their own overrides,
 * falling back to project; desktop app sessions always follow project. **Unregistered chat IDs are
 * treated as desktop app sessions**: AI panel chats register before each message (`/api/ai/chat`),
 * desktop app sessions register before each tool call (`/api/mcp/call`), and calls missing from
 * registry can only come from elsewhere (manually mounted MCP clients that did not report identity
 * per contract).
 *
 * Registry resides in memory only and is cleared on process restart: AI panel re-registers on its
 * next message, so nothing needs persistence.
 */
import { effectiveCreativity, normalizeCreativity, creativityRank } from './ssr-host.mjs';
import { tr } from '../i18n.mjs';

// Creativity level names are re-exported here: server/agent/service/ does not directly import
// src/ (contract cloud-agent-contract.md section 2.1 "Loading seam"); retrieved via ssr-host.mjs
export { CREATIVITY_HINT, CREATIVITY_LABEL, normalizeCreativity, projectCreativity } from './ssr-host.mjs';

export const SESSION_TYPES = Object.freeze(['api', 'cli', 'desktop']);

/** Registry limit: evict least recently active when exceeded (an editor process normally has only a few chats) */
const MAX_SESSIONS = 256;

/**
 * @param {{ now?: () => number }} [options]
 */
export function createAgentSessions({ now = () => Date.now() } = {}) {
  /** key ('' = call without chat ID) → record */
  const sessions = new Map();

  const keyOf = (id) => (typeof id === 'string' ? id : '');

  function desktopEntry(key) {
    return { id: key, type: 'desktop', vendor: null, label: null, client: null, role: null, parent: null, override: null, registeredAt: null, lastSeen: null };
  }

  return {
    /**
     * Registers or updates a chat. Called once per message from AI panel: driver and level may both be
     * changed by user between two messages; called once per tool call for desktop app sessions
     * (`role` passes null, vendor and client name come from its MCP process).
     */
    register(id, { type, vendor = null, label = null, client = null, role = 'main', creativity = null, parent = undefined } = {}) {
      const key = keyOf(id);
      const t = SESSION_TYPES.includes(type) ? type : 'desktop';
      const old = sessions.get(key);
      // Subagent role and parent chat are set when spawned; subsequent AI panel registrations
      // per message (role fixed to main) do not modify them
      const parentKey = parent !== undefined ? (typeof parent === 'string' && parent ? parent : null) : (old?.parent ?? null);
      const roleOut = old?.parent && parent === undefined ? old.role : (typeof role === 'string' && role ? role.slice(0, 64) : null);
      const entry = {
        id: key,
        type: t,
        vendor: typeof vendor === 'string' && vendor ? vendor.slice(0, 64) : null,
        label: typeof label === 'string' && label ? label.slice(0, 64) : null,
        client: client && typeof client === 'object' && typeof client.name === 'string'
          ? { name: client.name.slice(0, 64), version: typeof client.version === 'string' ? client.version.slice(0, 32) : '' }
          : null,
        role: roleOut,
        parent: parentKey,
        // Desktop app sessions follow project, do not accept overrides
        override: t === 'desktop' ? null : normalizeCreativity(creativity),
        registeredAt: sessions.get(key)?.registeredAt ?? now(),
        lastSeen: now(),
      };
      sessions.delete(key);
      sessions.set(key, entry);
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      return { ...entry };
    },

    /** Record for this chat; returns desktop app session record if not registered (not written to table) */
    get(id) {
      const key = keyOf(id);
      const hit = sessions.get(key);
      return hit ? { ...hit } : desktopEntry(key);
    },

    /** Effective level and source for this chat. `projectLevel` is current project default level */
    creativityOf(id, projectLevel, depth = 0) {
      const entry = this.get(id);
      let level = effectiveCreativity(entry.override, projectLevel);
      let source = entry.override
        ? tr("Set for this chat only")
        : entry.type === 'desktop' ? tr("Desktop app sessions follow the project's default level") : tr("Follows the project's default level");
      // Subagent cannot exceed chat that spawned it (A3 [ruling]); depth is only 1, extra check prevents cycles
      if (entry.parent && depth < 4) {
        const up = this.creativityOf(entry.parent, projectLevel, depth + 1);
        if (creativityRank(up.level) < creativityRank(level)) {
          level = up.level;
          source = tr("A sub-Agent is not higher than the chat {0} that launched it", entry.parent);
        }
      }
      return { level, source, entry };
    },

    /** Deregister when spawn fails (page did not open tab) */
    unregister(id) {
      sessions.delete(keyOf(id));
    },

    /** Subagents spawned by a chat (parent in registry matches this chat) */
    childrenOf(id) {
      const key = keyOf(id);
      return [...sessions.values()].filter((e) => e.parent === key).map((e) => ({ ...e }));
    },

    /** Records a call (used by A2 "who is active"; unregistered calls are not written to table) */
    touch(id) {
      const hit = sessions.get(keyOf(id));
      if (hit) hit.lastSeen = now();
    },

    list() {
      return [...sessions.values()].map((e) => ({ ...e }));
    },
  };
}
