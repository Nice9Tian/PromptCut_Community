/**
 * Agent 会话登记表(计划 `docs/plan/agent-workflow-plan.md` A1,供 A2～A4 用):对话 ID → 这个会话是谁。
 *
 *   - `type`:`api`(AI 栏 API 直连)/ `cli`(AI 栏走命令行工具,经 MCP 回调)/ `desktop`(桌面 APP 的会话,
 *     经 MCP 直连来的,计划 A4:`server/mcp-server.mjs` 每个会话一个身份,`/api/mcp/call` 登记);
 *   - `vendor`:厂商(claude、codex、agy,API 直连填设置里的厂商;桌面 APP 的会话是 claude-code、codex 等,从 MCP 的
 *     `clientInfo` 认);`label`:给人看的厂商名(桌面 APP 的会话才有,如「Claude Code」);`client`:它自报的客户端名与版本;
 *   - `role`:角色(AI 栏的主对话 `main`;A3 `spawn_agent` 拉起的子 Agent 带预设角色的 id);
 *   - `parent`:拉起它的对话 ID(A3 子 Agent;主对话是 `null`)。子 Agent 不能再拉起(深度 1);
 *   - `override`:这个对话单独设的创造力等级,`null` = 跟项目。
 *
 * 子 Agent 的等级(A3〔裁〕):拉起时取父对话此刻生效的等级作为它的覆盖值;之后每次判都再和父对话此刻生效的等级取低的,
 * 不能高于父对话 —— 用户在子页签里调高也只到父对话那一档。
 *
 * 等级规则(`user-workflow.md`「创造力等级」):AI 栏的对话取自己的覆盖值,没有就跟项目;
 * 桌面 APP 的会话一律跟项目。**没登记过的对话 ID 当桌面 APP 会话**:AI 栏的对话每次发消息都会先登记
 * (`/api/ai/chat`),桌面 APP 的会话每次调用也先登记(`/api/mcp/call`),登记表里没有的调用只可能来自别处
 * (手工挂上、没按约定报身份的 MCP 客户端)。
 *
 * 登记表只在内存里,进程重启就清空 —— AI 栏下一次发消息会重新登记,没有要持久化的东西。
 */
import { effectiveCreativity, normalizeCreativity, creativityRank } from './ssr-host.mjs';

// 创造力等级的几个名字从这里转出:server/agent/service/ 不直接引用 src/(契约 cloud-agent-contract.md 第 2.1 节「载入缝」),经 ssr-host.mjs 取
export { CREATIVITY_HINT, CREATIVITY_LABEL, normalizeCreativity, projectCreativity } from './ssr-host.mjs';

export const SESSION_TYPES = Object.freeze(['api', 'cli', 'desktop']);

/** 登记表的上限:超了按最久没动的先丢(一个编辑器进程正常只有几个对话) */
const MAX_SESSIONS = 256;

/**
 * @param {{ now?: () => number }} [options]
 */
export function createAgentSessions({ now = () => Date.now() } = {}) {
  /** key('' = 没带对话 ID)→ 记录 */
  const sessions = new Map();

  const keyOf = (id) => (typeof id === 'string' ? id : '');

  function desktopEntry(key) {
    return { id: key, type: 'desktop', vendor: null, label: null, client: null, role: null, parent: null, override: null, registeredAt: null, lastSeen: null };
  }

  return {
    /**
     * 登记或更新一个对话。AI 栏每次发消息调一次:驱动、等级都可能在两条消息之间被用户换掉;
     * 桌面 APP 的会话每次工具调用调一次(`role` 传 null,厂商与客户端名来自它的 MCP 进程)。
     */
    register(id, { type, vendor = null, label = null, client = null, role = 'main', creativity = null, parent = undefined } = {}) {
      const key = keyOf(id);
      const t = SESSION_TYPES.includes(type) ? type : 'desktop';
      const old = sessions.get(key);
      // 子 Agent 的角色与父对话在拉起时定下,之后 AI 栏每条消息的登记(role 固定是 main)不改它们
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
        // 桌面 APP 的会话跟随项目,不收覆盖值
        override: t === 'desktop' ? null : normalizeCreativity(creativity),
        registeredAt: sessions.get(key)?.registeredAt ?? now(),
        lastSeen: now(),
      };
      sessions.delete(key);
      sessions.set(key, entry);
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      return { ...entry };
    },

    /** 这个对话的记录;没登记过回一条桌面 APP 会话的记录(不写进表) */
    get(id) {
      const key = keyOf(id);
      const hit = sessions.get(key);
      return hit ? { ...hit } : desktopEntry(key);
    },

    /** 这个对话生效的等级与来源。`projectLevel` 是项目当前的默认等级 */
    creativityOf(id, projectLevel, depth = 0) {
      const entry = this.get(id);
      let level = effectiveCreativity(entry.override, projectLevel);
      let source = entry.override
        ? '这个对话单独设的'
        : entry.type === 'desktop' ? '桌面 APP 会话跟随项目的默认等级' : '跟随项目的默认等级';
      // 子 Agent 不高于拉起它的对话(A3〔裁〕);深度只有 1,多判一层防环
      if (entry.parent && depth < 4) {
        const up = this.creativityOf(entry.parent, projectLevel, depth + 1);
        if (creativityRank(up.level) < creativityRank(level)) {
          level = up.level;
          source = `子 Agent 不高于拉起它的对话 ${entry.parent}`;
        }
      }
      return { level, source, entry };
    },

    /** 拉起失败(页面没开出页签)时撤掉登记 */
    unregister(id) {
      sessions.delete(keyOf(id));
    },

    /** 某个对话拉起的子 Agent(登记表里 parent 是它的) */
    childrenOf(id) {
      const key = keyOf(id);
      return [...sessions.values()].filter((e) => e.parent === key).map((e) => ({ ...e }));
    },

    /** 记一次调用(给 A2 起的「谁在动」用;没登记过的不写进表) */
    touch(id) {
      const hit = sessions.get(keyOf(id));
      if (hit) hit.lastSeen = now();
    },

    list() {
      return [...sessions.values()].map((e) => ({ ...e }));
    },
  };
}
