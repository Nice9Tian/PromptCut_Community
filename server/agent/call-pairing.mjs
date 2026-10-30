/**
 * codex、agy 两路的工具调用配对:让经 MCP 进来的调用拿到和聊天记录里那一条相同的 `callId`。
 *
 * Claude Code 在 MCP `tools/call` 的 `_meta["claudecode/toolUseId"]` 里直接带模型那一侧的 id,
 * 它的输出流里也是这个 id,两边天然对得上。codex、agy 不带(实测见 `docs/archive/agent-reports/AGENT-runner-callid.md`):
 *   - codex 的 `_meta` 有 `threadId`(= 输出流 `thread.started` 的 thread_id)和它自己的 `callId`("exec-<uuid>"),
 *     但输出流里工具条目的 id 是 `item_0`、`item_1` 这种,和 `_meta.callId` 对不上;
 *   - agy 的 `_meta` 有 `antigravity.google/conversation_id`(= 输出流的 conversation_id)和
 *     `progressToken: "<uuid>:<步号>"`,步号就是输出流 step_update 的 step_index(续跑同一对话时步号接着涨)。
 *
 * 所以由 runner 在输出流里看到工具调用开始时「报到」(`announce`:范围、工具名、参数、它发给页面的 callId),
 * MCP 那边进来的调用按(范围、工具名、参数)来「认领」(`claim`)。范围是 codex 的 thread、agy 的对话,
 * 比 Agent 页更窄:同一页里前后几轮也不会串。
 *
 * 规则(宁可不配,不许配错 —— 配不上就退回原来的行为:事件不带 callId,只能在 Agent 操作记录里撤):
 *   - 带了提示(`hint`,agy 按步号算出的 callId)的只认这一条:报到里有它、工具名和参数也一致才配;
 *   - 不带提示的(codex)在同一范围里找工具名和参数都一致、还没被认领的报到:恰好一条才配;两条以上(同名同参并行)不配;
 *   - 还没有报到(MCP 那边先到):等一会儿;等的时候同一把钥匙又来了第二个认领者,也算分不清,都不配;
 *   - runner 看到这次调用结束就「结清」(`settle`)这条报到:没被认领的也删掉,免得它挡住后面同名同参的调用;
 *   - 一次 runner 运行结束(`close`)把它报过的全部删掉。
 */

/** 参数的规范写法:键排序后的 JSON。两边都是从同一份 JSON 解析出来的,只差键的顺序 */
export function argsKey(args) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  try { return JSON.stringify(norm(args ?? {})); } catch { return null; }
}

/**
 * @param {object} [o]
 * @param {number} [o.waitMs] 范围已知(runner 正在跑)时,认领最多等多久报到
 * @param {number} [o.unknownWaitMs] 范围未知(不是这台服务端起的 CLI,或者 runner 还没读到第一行)时等多久
 */
export function createCallPairing({ waitMs = 2000, unknownWaitMs = 300 } = {}) {
  /** callId → { scope, key, claimed } */
  const entries = new Map();
  /** 正在跑的范围 → 打开的次数 */
  const scopes = new Map();
  /** 等报到的认领者:{ scope, key, hint, resolve, timer } */
  const waiters = new Set();

  const keyOf = (tool, args) => {
    const a = argsKey(args);
    return a === null ? null : `${tool}\u0000${a}`;
  };

  function finish(w, callId) {
    clearTimeout(w.timer);
    waiters.delete(w);
    w.resolve(callId);
  }

  /** 同一把钥匙上还没被认领的报到 */
  function openEntries(scope, key) {
    const out = [];
    for (const [callId, e] of entries) if (e.scope === scope && e.key === key && !e.claimed) out.push(callId);
    return out;
  }

  /** 按规则找一条能配的报到;还没有回 null,配不了(分不清、或提示对上的那条工具名参数不符)回 false */
  function pick(scope, key, hint) {
    if (hint) {
      // 带提示的只认提示那一条:提示的格式要是哪天变了,宁可配不上,也不退回按参数猜
      const e = entries.get(hint);
      if (!e) return null;
      return e.scope === scope && e.key === key && !e.claimed ? hint : false;
    }
    const open = openEntries(scope, key);
    if (open.length === 1) return open[0];
    if (open.length > 1) return false;
    return null;
  }

  function take(callId) {
    const e = entries.get(callId);
    if (e) e.claimed = true;
    return callId;
  }

  return {
    /** runner 开跑、读到 thread / 对话 id 时打开范围;回一个关的函数 */
    open(scope) {
      if (!scope) return () => {};
      scopes.set(scope, (scopes.get(scope) || 0) + 1);
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        const n = (scopes.get(scope) || 1) - 1;
        if (n > 0) scopes.set(scope, n); else scopes.delete(scope);
      };
    },

    /** runner:输出流里一次 PromptCut 工具调用开始了。callId 是它发给页面的那个 */
    announce(scope, tool, args, callId) {
      const key = keyOf(tool, args);
      if (!scope || !key || !callId || entries.has(callId)) return;
      entries.set(callId, { scope, key, claimed: false });
      const same = [...waiters].filter((w) => w.scope === scope && w.key === key);
      // 带着这个提示在等的认领者:就是它
      const exact = same.find((w) => w.hint === callId);
      if (exact) return finish(exact, take(callId));
      // 不带提示的认领者:恰好一个才配;两个以上在等同一把钥匙,分不清谁是谁,都不配
      const loose = same.filter((w) => !w.hint);
      if (loose.length === 1) return finish(loose[0], take(callId));
      for (const w of loose) finish(w, undefined);
    },

    /** runner:这次调用结束了(成功或失败) */
    settle(callId) {
      entries.delete(callId);
    },

    /** runner 这次运行结束:把它报过、还留着的都删掉 */
    forget(callIds) {
      for (const id of callIds) entries.delete(id);
    },

    /**
     * MCP 那边进来一次调用,认领它的 callId。配不上回 undefined。
     * @returns {Promise<string | undefined>}
     */
    claim(scope, tool, args, hint) {
      const key = keyOf(tool, args);
      if (!scope || !key) return Promise.resolve(undefined);
      const hit = pick(scope, key, hint);
      if (hit) return Promise.resolve(take(hit));
      if (hit === false) return Promise.resolve(undefined);
      // 还没报到:等。已经有人在等同一把钥匙(同名同参并行),这两个都分不清
      const rival = hint ? null : [...waiters].find((w) => w.scope === scope && w.key === key && !w.hint);
      if (rival) {
        finish(rival, undefined);
        return Promise.resolve(undefined);
      }
      const ms = scopes.has(scope) ? waitMs : unknownWaitMs;
      return new Promise((resolve) => {
        const w = { scope, key, hint, resolve, timer: null };
        w.timer = setTimeout(() => finish(w, undefined), ms);
        w.timer.unref?.();
        waiters.add(w);
      });
    },

    /** 诊断与测试用 */
    stats() {
      return { entries: entries.size, waiters: waiters.size, scopes: scopes.size };
    },
  };
}

/**
 * 一次 runner 运行用的小把手:记下自己报过的 callId,运行结束一把删掉。
 * `pairing` 没给(测试、没接编辑器的调用方)时各方法都是空操作。
 */
export function pairingSession(pairing) {
  const mine = new Set();
  const closers = new Map();
  return {
    open(scope) {
      if (!pairing || !scope || closers.has(scope)) return;
      closers.set(scope, pairing.open(scope));
    },
    announce(scope, tool, args, callId) {
      if (!pairing) return;
      mine.add(callId);
      pairing.announce(scope, tool, args, callId);
    },
    settle(callId) {
      if (!pairing) return;
      mine.delete(callId);
      pairing.settle(callId);
    },
    close() {
      if (!pairing) return;
      pairing.forget(mine);
      mine.clear();
      for (const c of closers.values()) c();
      closers.clear();
    },
  };
}
