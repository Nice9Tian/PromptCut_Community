/**
 * 多 Agent 的协调公告板(计划 `docs/plan/agent-workflow-plan.md` A3;语义 `user-workflow.md`「多 Agent」「保护」)。
 *
 * 以前在页面内存里(`src/ai/agentBus.ts`),只看得见经这个页面执行的工具调用;现在放在编辑器进程里,**按项目一份**
 * (`createAgentBoards`),`declare_scope` / `list_agents` / `send_message` / `check_messages` 在服务端答,所有 Agent
 * (AI 栏各页签、拉起的子 Agent、以后经 MCP 直连的桌面 APP 会话)看到同一份。
 *
 * 四样东西:
 *   1. **Agent 名单**:页面报上来的页签(`setTabs`:对话 ID、页签名、忙不忙)、调过工具的会话(`touch`)、
 *      共享项目里别的成员那边的 Agent(`applyRemote*`,经文档服务转来,第二阶段)。
 *   2. **范围声明**:`declare_scope` 记在名单上,页签名跟着改(经 SSE 推给页面)。
 *   3. **改动记录**:由文档服务的**提交流**喂(`noteCommit`,带写入身份:页面 = 用户、各 Agent、共享项目里别的成员),
 *      按提交前后的项目算碰了哪几条「剪辑->序列」(`src/kernel/agentScopes.mjs`)。没接文档服务时退回由工具入口记
 *      (`noteChange`,页面执行器算好范围随结果带回来)。
 *   4. **信箱**:`send_message` 投进收件方的信箱。收件页签空闲就由页面取走、作为一条用户消息发出;忙就攒着,
 *      跑完再送;自动连锁有层数上限 `MAX_AUTO_HOPS`。
 *
 * 另外,收件方**下一次工具结果**里带上(`pendingFor` / `annotate`,放法与 A2 的 `user-editing.mjs` 一致,`notice` 在最前):
 *   - 信箱里的消息(带出即算送达,不再自动投递);
 *   - 别人动了你声明的范围(每条只提示一次);
 *   - 你写的内容被覆盖了(文档服务发给你那条连接的 `project.overwritten`,`noteOverwritten`);
 * 写入方这一次的结果里带「你写进了 Agent <对话> 声明在改的范围」(`writerNotice`)。
 *
 * 只在内存里:编辑器进程重启就清空,页签和会话下一次动作时重新出现。
 */
import { diffScopes, overlappingScopes, splitScopes, scopeOverlaps } from './ssr-host.mjs';

export const BOARD_DEFAULTS = Object.freeze({
  /** 自动投递最多连锁几层;超过就留在信箱里,等用户下一次和它说话时一并带上 */
  MAX_AUTO_HOPS: 3,
  /** 改动记录留多少条 */
  maxChanges: 500,
  /** 信箱最多攒多少条(全项目) */
  maxInbox: 200,
  /** 一个 Agent 多久没动静(没开页签、没调工具、没在跑)就不再算「在跑」,它声明的范围不再拿来比(〔裁〕30 分钟) */
  idleMs: 30 * 60_000,
  /** 结果里最多列几条 */
  showMax: 8,
  /** 一轮开始时附在提示词前面的动态最多几条 */
  notesMax: 40,
  /** 每个 Agent 记住已在工具结果里提示过的改动条数 */
  notifiedKeep: 500,
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

function fmtTime(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** 文档服务的写入身份 → 记录里的「谁」:{ kind: 'user' | 'agent' | 'render' | 'unknown', agent?, userId? } */
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
 * @param {(key: string) => string | null} [o.labelOf] 对话 ID → 厂商名(「Agent <对话>(<厂商>)」里用)
 * @param {(key: string) => { role?: string | null, roleName?: string | null, parent?: string | null } | null} [o.infoOf]
 *   对话 ID → 登记表里的角色、父对话(名单里显示)
 * @param {(msg: object) => boolean} [o.forwardRemote] 收件方是共享项目别的成员那边的 Agent 时,经文档服务转过去(第二阶段);回 false 表示转不出去
 */
export function createAgentBoard({ now = () => Date.now(), labelOf = () => null, infoOf = () => null, forwardRemote = null, limits: limitsIn = {} } = {}) {
  const L = { ...BOARD_DEFAULTS, ...limitsIn };
  /** key → 名单条目 */
  const agents = new Map();
  const changes = [];
  const inbox = [];
  let seq = 0;
  /** key → 上一次「拿走动态」时的序号 */
  const seen = new Map();
  /** key → 已在工具结果里提示过的改动序号 */
  const notified = new Map();
  /** key → 被覆盖的记录(下一次工具结果里带出) */
  const overwritten = new Map();
  const overwrittenSeen = new Set();
  /** key → 这一刻正在跑的工具名(提交流里认出是它写的,记录带上工具名) */
  const calls = new Map();
  /** 页面替某个 Agent 执行的写入:opId → 对话 */
  const pageOps = new Map();
  const listeners = new Set();

  function emit() {
    for (const fn of [...listeners]) {
      try { fn(); } catch { /* 订阅方出错不影响公告板 */ }
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

  /** 「Agent <对话>(<厂商>)」;共享项目别的成员那边的带上成员名 */
  function agentText(key) {
    if (key === '' || key === null || key === undefined) return '某个没带对话 ID 的 Agent';
    const a = agents.get(key);
    const vendor = a?.remote?.vendor ?? label(key);
    const member = a?.remote?.member ? `,成员 ${a.remote.member} 那边` : '';
    return `Agent ${key}${vendor || member ? `(${[vendor, member.slice(1)].filter(Boolean).join(',')})` : ''}`;
  }

  function byText(by) {
    if (!by) return '未知的写入方';
    if (by.kind === 'user') return by.userId ? `用户 ${by.userId}` : '用户';
    if (by.kind === 'agent') return agentText(by.agent);
    if (by.kind === 'render') return '渲染节点';
    return by.userId ? `用户 ${by.userId}` : '未知的写入方';
  }

  const isBusy = (key) => {
    const a = agents.get(key);
    return !!a && (a.runs > 0 || a.tabBusy);
  };

  /** 还算「在跑」:页签开着、在跑一轮、最近动过,或共享项目别的成员那边报过且没过期 */
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
    if (c.kind === 'declare') return `${fmtTime(c.at)} ${who} 声明了修改范围:${c.scopes.join(',')}`;
    const scopeOf = c.by?.kind === 'agent' ? agents.get(c.by.agent)?.scope : null;
    const whoScope = scopeOf ? `(声明范围「${scopeOf}」)` : '';
    return `${fmtTime(c.at)} ${who}${whoScope}${c.tool ? ` 用 ${c.tool}` : ''} 改了 ${c.scopes.join(',')}`;
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

    /** 当前序号(工具调用前记下,调用后看这期间多了哪些记录) */
    seq() {
      return seq;
    },

    /* ---------------- 名单 ---------------- */

    /** 页面报上来的页签(整份替换):[{ conversationId, title, busy }] */
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

    /** 这个页签还开着吗(拉起的子 Agent 算并发名额用) */
    tabOpen(key) {
      return !!agents.get(key)?.tab;
    },

    /** 页签关过(报过开、后来不在了) */
    tabClosed(key) {
      const a = agents.get(key);
      return !!a && !a.tab && a.closedAt != null;
    },

    /** 这个对话调了一次工具 */
    touch(key) {
      if (typeof key !== 'string' || !key) return;
      entry(key).lastActive = now();
    },

    /** 一轮开始(AI 栏发出一条消息):记下它是第几层自动投递(0 = 用户自己发的) */
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
     * 撤掉这个对话声明的范围;原来有才回 true。云端的一轮结束时用(`service/instance.mjs`):云端的对话没有页签可关,
     * 一轮结束(含失败、被停、被撤销)后范围还挂着的话,别的成员会一直看到「〈成员〉的云端 Agent 正在改:…」。
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

    /** 这个对话此刻在跑的工具(提交流的记录带上工具名) */
    beginCall(key, tool) {
      if (typeof key === 'string') calls.set(key, tool);
    },
    endCall(key) {
      calls.delete(key);
    },

    /* ---------------- 改动记录 ---------------- */

    /**
     * 文档服务的一次提交落到了副本上(`doc-link.mjs` 的 `onCommit`):按提交前后的项目算范围,记一笔。
     * @param {{ rev?: number, opId?: string | null, actor?: object, before: object, after: object }} c
     */
    noteCommit({ rev = null, opId = null, actor = null, before, after }) {
      const scopes = diffScopes(before, after);
      if (!scopes.length) return null;
      let by = byOfActor(actor);
      // 页面替某个 Agent 执行的工具写入(以页面身份提交):归到那个 Agent
      if (opId && pageOps.has(opId)) {
        by = { kind: 'agent', agent: pageOps.get(opId) };
        pageOps.delete(opId);
      }
      const tool = by.kind === 'agent' ? calls.get(by.agent) ?? null : null;
      pushChange({ by, tool, scopes, kind: 'change', opId, rev });
      return changes[changes.length - 1];
    },

    /** 没接文档服务时的退路:工具入口记(页面执行器算好的范围) */
    noteChange(key, tool, scopes) {
      const list = Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string' && s).slice(0, 32) : [];
      if (!list.length) return null;
      pushChange({ by: { kind: 'agent', agent: typeof key === 'string' ? key : null }, tool: tool ?? null, scopes: list, kind: 'change', opId: null, rev: null });
      return changes[changes.length - 1];
    },

    /** 页面替这个 Agent 执行的写入(页面回包带的 opIds):提交流里认到这些 opId 时记到它名下 */
    attributeOps(key, opIds) {
      for (const id of Array.isArray(opIds) ? opIds : []) {
        if (typeof id !== 'string') continue;
        const hit = [...changes].reverse().find((c) => c.opId === id);
        if (hit) hit.by = { kind: 'agent', agent: key };
        else pageOps.set(id, key);
      }
      while (pageOps.size > 256) pageOps.delete(pageOps.keys().next().value);
    },

    /** (sinceSeq, now] 之间 key 写的范围 */
    writtenBy(key, sinceSeq) {
      const out = [];
      for (const c of changes) {
        if (c.seq > sinceSeq && c.kind === 'change' && mine(c, key)) for (const s of c.scopes) if (!out.includes(s)) out.push(s);
      }
      return out;
    },

    /** 被覆盖的一方:文档服务发给它那条连接的 `project.overwritten`(去重) */
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

    /* ---------------- 工具 ---------------- */

    declareScope(key, args) {
      const scope = typeof args?.scope === 'string' ? args.scope.trim().slice(0, 120) : '';
      if (!scope) throw new Error('scope 必填,写成「剪辑X->序列X」,多个用逗号分开');
      if (!key) {
        return { ok: false, error: '这条调用没带 Agent 对话 ID(可能是走 agy 或外部命令行调的),范围没法记到页签上;别的 Agent 也看不到这次声明' };
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
        ...(clash.length ? { warning: `范围和 ${clash.map((c) => `${c.id}(${c.scope})`).join('、')} 有重叠,先用 send_message 商量好谁改哪部分` } : {}),
      };
    },

    listRaw(key) {
      return liveAgents().map((a) => {
        const info = (() => { try { return infoOf(a.id) ?? null; } catch { return null; } })();
        return {
          id: a.id,
          title: a.title ?? (a.remote ? `成员 ${a.remote.member} 的 Agent` : null),
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
      if (!text) throw new Error('text 必填');
      if (!to) throw new Error('to 必填:收件 Agent 的对话 ID,用 list_agents 查;写 all 就是发给所有其他 Agent;写 user 是对用户说话');
      // 对用户说话(2026-10-20 用户定):界面按工具调用里的 text 画进这一轮的气泡,公告板不投递(server/harness/tools/userMessage.mjs)
      if (to.toLowerCase() === 'user') return { ok: true, shown: true, note: '已显示在用户的对话气泡里' };
      const targets = to === 'all' ? liveAgents().filter((a) => a.id !== key).map((a) => a.id) : [to];
      if (targets.length === 0) return { ok: false, error: '没有别的 Agent 在跑' };
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
      if (delivered.length === 0) throw new Error(`没有这个 Agent:${unknown.join('、')}(用 list_agents 看有哪些)`);
      const busyTargets = delivered.filter((t) => !remote.includes(t) && isBusy(t));
      return {
        ok: true,
        delivered,
        ...(unknown.length ? { unknown } : {}),
        note: busyTargets.length
          ? `${busyTargets.join('、')} 正在跑,消息会带在它下一次工具调用的结果里,这一轮结束后没看到的再自动送到;空闲的那些已经作为一条消息发给它了`
          : hops + 1 >= L.MAX_AUTO_HOPS
            ? '已经连续互发好几轮了,这条会留在对方信箱里,等用户下一次和它说话时一并带上,不再自动触发它跑'
            : remote.length === delivered.length
              ? '对方在共享项目别的成员那边,消息已经经文档服务转过去'
              : '对方空闲,消息已作为一条用户消息发给它,它会开始处理',
      };
    },

    /** 投一条消息进信箱(本机的,或文档服务转来的) */
    deliver({ from = null, fromLabel = null, to, text, hops = 1 }) {
      if (typeof to !== 'string' || typeof text !== 'string' || !text) return;
      entry(to);
      inbox.push({ seq: ++seq, at: now(), from, ...(fromLabel ? { fromLabel } : {}), to, text: text.slice(0, 4000), hops: Math.max(1, Math.min(Number(hops) || 1, L.MAX_AUTO_HOPS)) });
      if (inbox.length > L.maxInbox) inbox.splice(0, inbox.length - L.maxInbox);
      emit();
    },

    /** 自己信箱里还没处理的消息(不取走)与自上次以来别人改了什么 */
    checkMessages(key) {
      if (!key) return { ok: false, error: '这条调用没带 Agent 对话 ID' };
      const list = inbox.filter((m) => m.to === key);
      const others = changes.filter((c) => !mine(c, key) && c.seq > (seen.get(key) ?? 0));
      return {
        you: key,
        messages: list.map(({ from, fromLabel, text, at }) => ({ from, ...(fromLabel ? { fromLabel } : {}), text, at: new Date(at).toISOString() })),
        changes: others.map(fmtChange),
      };
    },

    /* ---------------- 投递 / 注入 ---------------- */

    /** 取走投给这个 Agent 的消息;onlyAuto 只取层数没到顶的(页面空闲时自动投递用) */
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

    /** 一个 Agent 刚出现时先把序号对齐,免得把它出生前的历史当新闻 */
    markSeen(key) {
      if (typeof key === 'string' && !seen.has(key)) seen.set(key, seq);
    },

    /**
     * 这个 Agent 这一轮提示词前面要带的「其他 Agent 的动态」:别人改了什么、信箱里到顶没自动投递的消息。取走即视为已读。
     * 已经在工具结果里提示过的改动不再列。
     */
    consumeNotes(key) {
      if (typeof key !== 'string' || !key) return '';
      const since = seen.get(key) ?? 0;
      const told = notified.get(key);
      const others = changes.filter((c) => !mine(c, key) && c.seq > since && !told?.has(c.seq));
      const held = board.takeInbox(key, false);
      seen.set(key, seq);
      if (others.length === 0 && held.length === 0) return '';
      const lines = ['[其他 Agent 的动态 —— 系统自动附上,不是用户说的话]', `你的 Agent 对话 ID:${key}`];
      for (const c of others.slice(-L.notesMax)) lines.push(`- ${fmtChange(c)}`);
      for (const m of held) lines.push(`- ${fmtTime(m.at)} ${m.fromLabel ?? agentText(m.from)} 给你的消息:${m.text}`);
      lines.push('[/其他 Agent 的动态]');
      return lines.join('\n');
    },

    /**
     * 这个 Agent 下一次工具结果里要带的:信箱里的消息(带出即送达)、别人动了它声明的范围、它写的被覆盖了。取走即清。
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
     * 写入方:这次写到的范围落在别的在跑的 Agent 声明的范围里。
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

    /* ---------------- 页面要看的 ---------------- */

    /** 推给页面的一份(SSE `agent.board`):各对话的范围、未读、可自动投递的条数、忙不忙 */
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

    /* ---------------- 共享项目别的成员那边的 Agent(第二阶段,经文档服务) ---------------- */

    /** 别的成员那边的 Agent 报了范围(或续期);scope 为 null 表示撤掉 */
    applyRemoteAgent({ id, member, vendor = null, scope = null, busy = false, expiresAt }) {
      if (typeof id !== 'string' || !KEY_RE.test(id)) return;
      const local = agents.get(id);
      if (local && !local.remote && (local.tab || local.runs > 0)) return; // 本机的同名对话优先(不会发生,防御)
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

    /** 诊断与测试 */
    describe() {
      return { seq, agents: board.snapshot(), changes: changes.length, inbox: inbox.length };
    },
    _changes() {
      return changes;
    },
    /** 挂钩:本机的 Agent 声明了范围(第二阶段经文档服务广播) */
    onDeclare: null,
  };
  return board;
}

/* ------------------------------------------------------------------ 结果里的提示 */

/**
 * 公告板要告诉这个 Agent 的,放进它这一次的工具结果:`notice` 在最前(已有的 notice 接在后面),另加
 * `messages` / `scopeChanges` / `overwrittenBy` / `scopeClash` 字段。放法与 `user-editing.mjs` 的 `annotateResult` 一致。
 * @param {any} result
 * @param {{ messages?: object[], scopeChanges?: object[], overwrittenBy?: object[], scopeClash?: object[] }} extra
 */
export function annotateBoard(result, { messages = [], scopeChanges = [], overwrittenBy = [], scopeClash = [] } = {}, limits = BOARD_DEFAULTS) {
  const lines = [];
  const fields = {};
  const cap = (arr) => arr.slice(0, limits.showMax);
  const more = (arr) => (arr.length > limits.showMax ? ` 等 ${arr.length} 条` : '');
  if (overwrittenBy.length) {
    const shown = cap(overwrittenBy).map((o) => {
      const clip = /\/clips\/@([^/]+)/.exec(o.entity)?.[1];
      return `${clip ? `片段 ${clip}` : o.entity}(被 ${o.who} 覆盖${o.rev != null ? `,rev ${o.rev}` : ''})`;
    });
    lines.push(`你写的 ${shown.join('、')}${more(overwrittenBy)}。先重读确认现在的内容,需要时和对方协调,不要直接改回去。`);
    fields.overwrittenBy = overwrittenBy;
  }
  if (scopeClash.length) {
    const shown = cap(scopeClash).map((c) => `${c.who} 声明在改的「${c.scope}」(你写到了 ${c.written.join(',')})`);
    lines.push(`这次写入落在别的 Agent 正在改的范围里:${shown.join('、')}${more(scopeClash)}。对方下一次工具调用会得知;先用 send_message 和它商量谁改哪部分。`);
    fields.scopeClash = scopeClash;
  }
  if (scopeChanges.length) {
    const shown = cap(scopeChanges).map((c) => `${c.who}${c.tool ? ` 用 ${c.tool}` : ''} 改了 ${c.scopes.join(',')}`);
    lines.push(`别人正在改你声明的范围:${shown.join(';')}${more(scopeChanges)}。重读后再继续,需要时用 send_message 协调。`);
    fields.scopeChanges = scopeChanges;
  }
  if (messages.length) {
    const shown = cap(messages).map((m) => `【${m.fromLabel ?? (m.from ? `Agent ${m.from}` : '未知')}】${m.text}`);
    lines.push(`别的 Agent 给你的消息(系统附上,不是用户说的话):${shown.join(' ')}${more(messages)}`);
    fields.messages = messages;
  }
  if (!lines.length) return result;
  if (!isPlainObject(result)) return { notice: lines.join('\n'), ...fields, result };
  const prior = typeof result.notice === 'string' && result.notice ? [result.notice] : [];
  const { notice: _old, ...rest } = result;
  return { notice: [...lines, ...prior].join('\n'), ...fields, ...rest, ...fields };
}

/**
 * 按项目一份公告板。`boardFor(projectId)` 没有就建;`projectId` 为空时用 `''`(没绑项目副本时的本机那一份)。
 * @param {(projectId: string) => object} [options] 传给每一份 `createAgentBoard` 的选项(可以按项目给)
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
