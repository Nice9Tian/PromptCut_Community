/**
 * 「用户正在编辑」本机版(计划 `docs/plan/agent-workflow-plan.md` A2;语义 `user-workflow.md`「保护」)。
 *
 * 两件事,都只是**提示**,不拦截任何调用:
 *
 * 1. **用户正在编辑**:编辑器页面(`src/editor/userEditing.ts`)把「正在编辑」的片段节流推给服务端
 *    (`POST /api/agent/editing`),这里按页面会话记下、带过期时刻;Agent 读或写到这些片段时,
 *    工具结果带 `userEditing`(哪些片段、在做什么),并在 `notice` 里写一句给模型看的话。
 *    口径(计划第 4 节第 1 条〔裁〕):拖动中、文字编辑中,以及选中后 30 秒内动过的;只选中不动不算。
 *    「30 秒内动过」由页面判,推上来时带剩余毫秒数;拖动 / 文字编辑由页面心跳续期,页面关了或卡住,
 *    过 `ttlMs` 自动清掉。
 *
 * 2. **覆盖了别人刚写的**:文档服务对一次提交回的 `overwrote`(10 分钟内覆盖了别的写入身份写的实体)
 *    放进工具结果:写入方是页面的标成「用户刚改过」,别的 Agent 标成「Agent <身份> 刚改过」。
 *
 * 3. **跨设备**(计划 A3 第二阶段):共享项目里别的成员的页面经文档服务的在场状态(`presence.*`,
 *    `../docservice/modules/presence.mjs`)发布自己正在编辑的片段,编辑器进程收到后记成**另一个来源**
 *    (`reportRemote`,带成员名与过期时刻),Agent 读写到时提示「用户 <成员>正在编辑」。本机页面自己也经文档服务发布一份,
 *    按页面会话号认出来、不重复算(`reportRemote` 跳过本机报过的会话)。
 */

export const USER_EDITING_DEFAULTS = Object.freeze({
  /** 拖动 / 文字编辑的条目多久没被页面续期就算过期(页面每 5 秒心跳一次,见 src/editor/userEditingCore.ts) */
  ttlMs: 15_000,
  /** 「刚动过」条目页面报的剩余时长的上限(页面口径是 30 秒;多报的按这个截) */
  recentMaxMs: 30_000,
  /** 一个页面会话最多记几个片段 */
  maxEntities: 64,
  /** 最多记几个页面会话(一个编辑器进程正常只有一个编辑页) */
  maxSessions: 16,
  /** 结果里最多列几个片段 */
  showMax: 8,
});

export const EDITING_KINDS = Object.freeze(['drag', 'text', 'recent']);
const KIND_TEXT = Object.freeze({ drag: '拖动中', text: '文字编辑中', recent: '刚动过' });
const KIND_RANK = Object.freeze({ drag: 0, text: 1, recent: 2 });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const CLIP_ID_RE = /^[^\s]{1,128}$/;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * 服务端记着的编辑状态。`report` 整份替换这个页面会话的条目;`current()` 合并所有会话、去掉过期的。
 * @param {{ now?: () => number, ttlMs?: number, recentMaxMs?: number, maxEntities?: number, maxSessions?: number }} [options]
 */
export function createUserEditingBoard(options = {}) {
  const o = { ...USER_EDITING_DEFAULTS, ...options };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** session → Map(clipId → { clipId, kind, since, expiresAt }) */
  const sessions = new Map();
  /** 共享项目别的成员(经文档服务):远端会话 → { who, entries: Map(clipId → …) } */
  const remote = new Map();
  /** 本机页面报过的会话号:它们经文档服务回来的那一份不再算(`reportRemote` 跳过) */
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
     * 页面报上来的一份完整状态。`entities`:`[{ clipId, kind: 'drag' | 'text' | 'recent', remainingMs? }]`。
     * 格式不对的条目跳过;回这次记下的条数。
     */
    report(session, entities) {
      if (typeof session !== 'string' || !SESSION_RE.test(session)) throw new Error('session 不合法');
      if (!Array.isArray(entities)) throw new Error('entities 要是数组');
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
     * 共享项目别的成员的页面经文档服务报上来的一份(整份替换这个远端会话)。
     * `session` 是那个页面的会话号(本机报过的跳过);`who` 是成员名;`expiresAt` 是文档服务给的过期时刻。
     * 回记下的条数(跳过的回 0)。
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

    /** 页面走了(或测试):清掉这个会话 */
    clear(session) {
      sessions.delete(session);
    },

    /**
     * 此刻「正在编辑」的片段:每个片段一条(几个会话都报了的,取最强的那种;一样强时本机的优先),按片段 id 排。
     * 共享项目别的成员正在编辑的带 `who`(成员名)。
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

/* ------------------------------------------------------------------ 这次调用碰到了哪些片段 */

/** 参数里直接点名的片段 */
export function clipIdsOfArgs(args) {
  if (!isPlainObject(args)) return [];
  const out = [];
  for (const k of ['clipId', 'otherClipId']) {
    if (typeof args[k] === 'string' && args[k]) out.push(args[k]);
  }
  return out;
}

/**
 * 一批路径(提交的 ops 的 `path`,或文档服务回的实体名)里写到的片段:`/tracks/@<t>/clips/@<id>/…`;
 * `insert` 到 `…/clips` 的新片段取它的 `value.id`。
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

/** 读整个项目的工具(没点名片段):用户正在编辑的都算碰到 */
export function readsWholeProject(tool, args) {
  if (tool === 'get_project') return true;
  if (tool === 'get_layout' && !(isPlainObject(args) && typeof args.clipId === 'string' && args.clipId)) return true;
  return false;
}

/* ------------------------------------------------------------------ 结果里的提示 */

/**
 * 这次调用碰到的、用户正在编辑的片段。
 * @param {{ tool: string, args?: object, written?: string[], editing: Array<{ clipId: string, kind: string, forMs?: number }> }} o
 */
export function userEditingFor({ tool, args, written = [], editing = [] }) {
  if (!Array.isArray(editing) || !editing.length) return [];
  const view = (e) => ({ clipId: e.clipId, kind: e.kind, ...(e.who ? { who: e.who } : {}) });
  if (readsWholeProject(tool, args)) return editing.map(view);
  const touched = new Set([...clipIdsOfArgs(args), ...(Array.isArray(written) ? written : [])]);
  return editing.filter((e) => touched.has(e.clipId)).map(view);
}

/** 给模型看的那句话 */
export function userEditingNotice(list, limits = USER_EDITING_DEFAULTS) {
  if (!Array.isArray(list) || !list.length) return '';
  const capped = list.slice(0, limits.showMax);
  const more = list.length > capped.length ? ` 等 ${list.length} 个` : '';
  // 本机用户一句;共享项目里别的成员各一句「用户 <成员>正在编辑……」(A3 第二阶段)
  const groups = new Map();
  for (const e of capped) {
    const who = typeof e.who === 'string' && e.who ? e.who : '';
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(`片段 ${e.clipId}(${KIND_TEXT[e.kind] ?? e.kind})`);
  }
  const parts = [...groups].map(([who, items]) => `${who ? `用户 ${who} ` : '用户'}正在编辑${items.join('、')}`);
  return `${parts.join(';')}${more}。这是提示不是禁止:用户可能正是在这里给你下指令;要改之前先确认不会覆盖用户手上的修改,拿不准就停下问用户。`;
}

/**
 * 写入身份 → 「谁刚改过」。页面 = 用户(共享项目里别的成员带上他的名字);Agent 带身份(对话 id,`agentLabel` 给得出厂商时一并带上)。
 * @param {object} actor 文档服务的写入身份 `{ role, userId?, conversation?, session? }`
 * @param {(key: string) => string | null} [agentLabel] 对话 id → 给人看的名字(可选)
 */
export function writerOf(actor, agentLabel) {
  if (!isPlainObject(actor)) return { by: 'unknown', who: '未知的写入方' };
  if (actor.role === 'page') {
    const other = actor.userId && actor.userId !== 'local' ? actor.userId : null;
    return other ? { by: 'user', who: `用户 ${other}`, userId: other } : { by: 'user', who: '用户' };
  }
  if (actor.role === 'agent') {
    const key = typeof actor.session === 'string' && actor.session.startsWith('agent:') ? actor.session.slice('agent:'.length) : null;
    const id = key || (actor.conversation != null ? `对话 ${actor.conversation}` : '?');
    let label = null;
    try { label = key && typeof agentLabel === 'function' ? agentLabel(key) : null; } catch { label = null; }
    return { by: 'agent', who: `Agent ${id}${label ? `(${label})` : ''}`, agent: key ?? null };
  }
  if (actor.role === 'render') return { by: 'render', who: '渲染节点' };
  return { by: 'unknown', who: actor.userId ? `用户 ${actor.userId}` : '未知的写入方' };
}

/**
 * 文档服务回的 `overwrote` → 结果里的条目。每条:实体、片段 id(是片段的话)、谁、在哪一版、多久以前。
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
      label: `${w.who}刚改过`,
      ...(Number.isSafeInteger(x.rev) ? { rev: x.rev } : {}),
      ...(Number.isFinite(x.at) ? { agoMs: Math.max(0, now - x.at) } : {}),
    };
  });
}

/** 覆盖提示给模型看的那句话 */
export function overwroteNotice(view, limits = USER_EDITING_DEFAULTS) {
  if (!Array.isArray(view) || !view.length) return '';
  const shown = view.slice(0, limits.showMax).map((v) => {
    const what = v.clipId ? `片段 ${v.clipId}` : v.entity;
    const ago = Number.isFinite(v.agoMs) ? `,${Math.max(1, Math.round(v.agoMs / 1000))} 秒前` : '';
    return `${what}(${v.label}${v.rev != null ? `,rev ${v.rev}` : ''}${ago})`;
  });
  const more = view.length > shown.length ? ` 等 ${view.length} 处` : '';
  const hasUser = view.some((v) => v.by === 'user');
  const hasAgent = view.some((v) => v.by === 'agent');
  const tail = hasUser
    ? '用户刚改过的地方被你这次写入盖掉了:确认这是用户要的,不是的话撤回或改回用户的版本,并告诉用户。'
    : hasAgent ? '别的 Agent 刚改过的地方被你这次写入盖掉了:确认你们没有在抢同一处,需要时和它协调。' : '确认这次覆盖是有意的。';
  return `这次写入覆盖了别人刚写的内容:${shown.join('、')}${more}。${tail}`;
}

/**
 * 把提示放进工具结果。对象结果:加 `userEditing` / `overwrote` 两个字段,`notice` 放在最前面(模型先看到);
 * 结果里原本有 `notice` 的接在后面。数组、标量:包成 `{ notice, …, result }`。没什么可提示的原样返回。
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
  // 已经带过提示的(执行器先放了 overwrote,入口再补 userEditing):先前的那句接在后面,字段保留
  const prior = typeof result.notice === 'string' && result.notice ? [result.notice] : [];
  const { notice: _old, ...rest } = result;
  return { notice: [...lines, ...prior].join('\n'), ...fields, ...rest, ...fields };
}

/** 工具抛错时(比如写入被拒 stale):把「用户正在编辑」那句接在报错后面 */
export function annotateError(err, userEditing) {
  if (!Array.isArray(userEditing) || !userEditing.length || !err || typeof err !== 'object') return err;
  const line = userEditingNotice(userEditing);
  try {
    err.message = `${err.message}\n${line}`;
    err.userEditing = userEditing;
  } catch { /* 冻结的错误对象就算了 */ }
  return err;
}
