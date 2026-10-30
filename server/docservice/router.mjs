/**
 * 文档服务的通用核心：连接登记、解析 JSON 信封、按消息类型把消息路由给已挂的模块、模块挂载与冲突检查、
 * 频道分发，以及每条连接的出站背压。
 *
 * 契约见 `docs/plan/` 下 M5a 契约的 G.2、G.3 与 C6.1 的 H.1、H.2、H.4（文件名含守门词，这里不写全）。
 * 文档服务是通用的文本 / JSON 分发中心（`docs/semantics/product/document-service.md`「职责」），
 * 所以本文件不认识任何具体业务：不引用业务模块，也不按业务消息名写分支。业务都在组装层挂上来的模块里。
 * 频道前缀、合并键都是模块给的字符串，核心只做比较，不认识任何具体取值。
 *
 * 传输由组装层负责：本文件只经构造时给的 `write` / `buffered` / `close` 操作连接，底层排空时组装层调 `drained`。
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** 出站背压的缺省值（H.2）：底层积压到高水位就改进核心自己的出站队列；队列加积压超过上限就以 1013 关闭 */
export const CORE_DEFAULTS = Object.freeze({
  HIGH_WATER_BYTES: 64 * 1024,
  MAX_PENDING_BYTES: 1024 * 1024,
});

/** 背压关闭用的 WebSocket 关闭码（Try Again Later） */
const CLOSE_TRY_AGAIN = 1013;

/** 核心自己在 `describeConn` 里给的字段，模块不能重名（G.3「字段冲突」，H.4） */
const CORE_CONN_FIELDS = Object.freeze(['connId', 'remote', 'principal', 'connectedAt', 'pendingBytes', 'subscriptions']);
/**
 * `/healthz` 的核心字段（G.4、H.4），模块的 `health()` 不能重名。`conns` 也留给核心：
 * 组装层的 `describe()` 把健康字段和 `conns` 平铺在同一层。
 */
const CORE_HEALTH_FIELDS = Object.freeze([
  'ok', 'service', 'uptimeMs', 'connections', 'protocol', 'modules', 'conns',
  'channels', 'subscriptions', 'pendingBytesMax', 'coalesced', 'backpressureCloses',
]);

/** 挂载时拿来问 `describeConn` 字段名的连接 id：不会和真连接撞上 */
const PROBE_CONN_ID = '\u0000probe';

/** 频道前缀（H.1）：频道名是 `<前缀>:<其余>`，其余部分非空 */
const CHANNEL_PREFIX = /^[a-z][a-z0-9-]{0,31}$/;

/** 频道名的前缀；不合法返回 null */
function prefixOf(channel) {
  if (typeof channel !== 'string') return null;
  const i = channel.indexOf(':');
  if (i <= 0 || i === channel.length - 1) return null;
  const prefix = channel.slice(0, i);
  return CHANNEL_PREFIX.test(prefix) ? prefix : null;
}

/** 两条类型声明是否会认领同一条消息（G.3「类型冲突」） */
function typesClash(a, b) {
  const pa = a.endsWith('.');
  const pb = b.endsWith('.');
  if (!pa && !pb) return a === b;
  if (pa && pb) return a.startsWith(b) || b.startsWith(a);
  return pa ? b.startsWith(a) : a.startsWith(b);
}

function fieldNames(fn, arg) {
  const out = fn(arg);
  if (!isObj(out)) throw new TypeError('describeConn / health 必须返回对象');
  return Object.keys(out);
}

/** 把模块给的字段合进 `into`；已有的字段（核心字段、先挂的模块）不让覆盖 */
function mergeFields(into, fields) {
  if (!isObj(fields)) return;
  for (const [k, v] of Object.entries(fields)) {
    if (!Object.hasOwn(into, k)) into[k] = v;
  }
}

/** 发送选项里的合并键：只认字符串，别的一律当没有键 */
const keyOf = (opts) => (isObj(opts) && typeof opts.coalesceKey === 'string' ? opts.coalesceKey : undefined);
/** 广播时跳过的那条连接（`opts.except`，连接 id）：只认字符串，别的一律当没有 */
const exceptOf = (opts) => (isObj(opts) && typeof opts.except === 'string' ? opts.except : undefined);

const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/**
 * @param {object} options
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {(connId: string, text: string) => void} options.write 把一条已序列化的消息写进连接（不管底层是否积压）
 * @param {(connId: string) => number} [options.buffered] 底层尚未发出的字节数；缺省 0（不做背压）
 * @param {(connId: string, code: number, reason: string) => void} [options.close] 主动关闭连接
 * @param {number} [options.highWaterBytes] 缺省 `CORE_DEFAULTS.HIGH_WATER_BYTES`
 * @param {number} [options.maxPendingBytes] 缺省 `CORE_DEFAULTS.MAX_PENDING_BYTES`
 * @param {(principal: object, type: string, msg: object) => string | null} [options.gate]
 *   派发前的放行判断：回一个原因字符串就不交给模块，直接回 `error { reason }`；回 null 照常派发。
 *   核心不认识任何身份或业务，判据全在组装层（例：管理身份只能发管理接口的消息，`auth-contract.md` 第 5 节）
 */
export function createRouter({
  now = Date.now,
  log = () => {},
  write,
  buffered = () => 0,
  close = () => {},
  highWaterBytes,
  maxPendingBytes,
  gate = null,
}) {
  if (typeof write !== 'function') throw new TypeError('createRouter: write 必须是函数');
  if (typeof buffered !== 'function') throw new TypeError('createRouter: buffered 必须是函数');
  if (typeof close !== 'function') throw new TypeError('createRouter: close 必须是函数');
  const highWater = positive(highWaterBytes, CORE_DEFAULTS.HIGH_WATER_BYTES);
  const maxPending = positive(maxPendingBytes, CORE_DEFAULTS.MAX_PENDING_BYTES);

  /**
   * connId → 连接记录：
   * - 身份：`connId`、`principal`、`remote`、`connectedAt`；
   * - 出站队列（H.2）：`outbox` 按进队顺序存 `{ text, bytes, key, dead }`，`head` 之前的已写出；
   *   被合并掉的项只标 `dead`，排空时跳过。`live` 是还没写出、没被合并的条数，`bytes` 是它们的字节数，
   *   `byKey` 是合并键 → 队里那一项；
   * - `shut`：已因背压关闭，之后的发送一律丢弃；
   * - `subs`：订阅的频道（H.1）。
   */
  const conns = new Map();
  /** 按挂载顺序：{ mod, ctx, connFields, healthFields, channels: Set<前缀>, live } */
  const mounted = [];
  /** 频道 → 订阅它的连接 id；没有订阅者的频道不留在表里 */
  const channels = new Map();
  let coalesced = 0;
  let backpressureCloses = 0;

  function bufferedOf(connId) {
    let n = 0;
    try {
      n = Number(buffered(connId));
    } catch {
      n = 0;
    }
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** 这条连接的积压：出站队列里的字节数 + 底层尚未发出的字节数 */
  const pendingOf = (conn) => conn.bytes + bufferedOf(conn.connId);

  // ---------- 出站：直接写、进队、合并、排空、背压（H.2） ----------

  /** 清空出站队列 */
  function resetOutbox(conn) {
    conn.outbox = [];
    conn.head = 0;
    conn.live = 0;
    conn.bytes = 0;
    conn.byKey.clear();
  }

  /** 超过上限：清空、以 1013 关闭、计数。之后的发送一律丢弃，等组装层报断开 */
  function shed(conn, pendingBytes) {
    resetOutbox(conn);
    conn.shut = true;
    log('conn.backpressure', { connId: conn.connId, pendingBytes });
    backpressureCloses += 1;
    try {
      close(conn.connId, CLOSE_TRY_AGAIN, 'backpressure');
    } catch (err) {
      log('conn.error', { connId: conn.connId, message: String(err?.message ?? err) });
    }
  }

  /**
   * 把一条已序列化的消息交给这条连接：队列空且底层没到高水位就直接写，否则进队（同键先删旧的）。
   * 返回是否被接受（写出或进队）；已关闭、或这一次进队触发了背压关闭，返回 false。
   */
  function deliver(conn, text, key) {
    if (conn.shut) return false;
    if (conn.live === 0 && bufferedOf(conn.connId) < highWater) {
      write(conn.connId, text);
      return true;
    }
    if (key !== undefined) {
      const old = conn.byKey.get(key);
      if (old) {
        old.dead = true;
        conn.live -= 1;
        conn.bytes -= old.bytes;
        coalesced += 1;
      }
    }
    const entry = { text, bytes: Buffer.byteLength(text, 'utf8'), key, dead: false };
    conn.outbox.push(entry);
    conn.live += 1;
    conn.bytes += entry.bytes;
    if (key !== undefined) conn.byKey.set(key, entry);
    const pending = conn.bytes + bufferedOf(conn.connId);
    if (pending > maxPending) {
      shed(conn, pending);
      return false;
    }
    return true;
  }

  /** 底层排空了：按进队顺序写，直到队空，或底层又到高水位 */
  function drained(connId) {
    const conn = conns.get(connId);
    if (!conn || conn.shut) return;
    while (conn.live > 0 && conn.head < conn.outbox.length) {
      const entry = conn.outbox[conn.head];
      if (entry.dead) {
        conn.head += 1;
        continue;
      }
      if (bufferedOf(connId) >= highWater) break;
      conn.head += 1;
      conn.live -= 1;
      conn.bytes -= entry.bytes;
      if (entry.key !== undefined && conn.byKey.get(entry.key) === entry) conn.byKey.delete(entry.key);
      write(connId, entry.text);
      if (conn.shut || conns.get(connId) !== conn) return;
    }
    if (conn.live === 0) {
      conn.outbox = [];
      conn.head = 0;
    } else if (conn.head > 1024 && conn.head * 2 > conn.outbox.length) {
      conn.outbox = conn.outbox.slice(conn.head);
      conn.head = 0;
    }
  }

  function send(connId, message, opts) {
    const conn = conns.get(connId);
    if (!conn) return false;
    return deliver(conn, JSON.stringify(message), keyOf(opts));
  }

  function replyError(connId, reason, detail, reqId) {
    const msg = { type: 'error', reason, detail };
    if (reqId !== undefined) msg.reqId = reqId;
    send(connId, msg);
  }

  // ---------- 频道（H.1） ----------

  function unsubscribeAll(conn) {
    for (const ch of conn.subs) {
      const set = channels.get(ch);
      if (!set) continue;
      set.delete(conn.connId);
      if (set.size === 0) channels.delete(ch);
    }
    conn.subs.clear();
  }

  /** 卸载模块时，它前缀下的订阅全部清掉 */
  function dropChannelsOf(prefixes) {
    if (prefixes.size === 0) return;
    for (const [ch, set] of [...channels]) {
      if (!prefixes.has(prefixOf(ch))) continue;
      for (const id of set) conns.get(id)?.subs.delete(ch);
      channels.delete(ch);
    }
  }

  /** 给某个已挂模块做的频道操作：频道名要合法、前缀要是它声明的，否则抛错 */
  function channelOps(entry) {
    const own = (channel) => {
      const prefix = prefixOf(channel);
      if (prefix === null) throw new Error(`频道名不合法：${String(channel)}`);
      if (!entry.channels.has(prefix)) throw new Error(`模块 ${entry.mod.name} 没有声明频道前缀 ${prefix}`);
    };
    return {
      subscribe(connId, channel) {
        own(channel);
        const conn = conns.get(connId);
        if (!entry.live || !conn || conn.subs.has(channel)) return false;
        conn.subs.add(channel);
        let set = channels.get(channel);
        if (!set) channels.set(channel, (set = new Set()));
        set.add(connId);
        return true;
      },
      unsubscribe(connId, channel) {
        own(channel);
        const conn = conns.get(connId);
        if (!conn || !conn.subs.has(channel)) return false;
        conn.subs.delete(channel);
        const set = channels.get(channel);
        if (set) {
          set.delete(connId);
          if (set.size === 0) channels.delete(channel);
        }
        return true;
      },
      publish(channel, message, opts) {
        own(channel);
        const set = channels.get(channel);
        if (!entry.live || !set || set.size === 0) return 0;
        const text = JSON.stringify(message);
        const key = keyOf(opts);
        const skip = exceptOf(opts);
        let n = 0;
        for (const id of [...set]) {
          if (id === skip) continue;
          const conn = conns.get(id);
          if (conn && deliver(conn, text, key)) n += 1;
        }
        return n;
      },
    };
  }

  // ---------- 模块 ----------

  /** 调模块的生命周期钩子；抛错只记日志，不影响核心和别的模块 */
  function callHook(entry, hook, ...args) {
    const fn = entry.mod[hook];
    if (typeof fn !== 'function') return;
    try {
      fn.call(entry.mod, entry.ctx, ...args);
    } catch (err) {
      log('module.error', { module: entry.mod.name, hook, message: String(err?.message ?? err) });
    }
  }

  function ownerOf(type) {
    for (const entry of mounted) {
      for (const t of entry.mod.types) {
        if (t.endsWith('.') ? type.startsWith(t) : type === t) return entry;
      }
    }
    return null;
  }

  function validate(mod) {
    if (!isObj(mod)) throw new TypeError('模块必须是对象');
    if (typeof mod.name !== 'string' || mod.name === '') throw new TypeError('模块的 name 必须是非空字符串');
    if (!Array.isArray(mod.types) || mod.types.some((t) => typeof t !== 'string' || t === '')) {
      throw new TypeError(`模块 ${mod.name} 的 types 必须是非空字符串数组`);
    }
    if (typeof mod.handle !== 'function') throw new TypeError(`模块 ${mod.name} 的 handle 必须是函数`);
    for (const hook of ['connect', 'disconnect', 'tick', 'describeConn', 'health', 'describe']) {
      if (mod[hook] !== undefined && typeof mod[hook] !== 'function') throw new TypeError(`模块 ${mod.name} 的 ${hook} 必须是函数`);
    }
    if (mod.channels !== undefined) {
      if (!Array.isArray(mod.channels) || mod.channels.some((p) => typeof p !== 'string' || !CHANNEL_PREFIX.test(p))) {
        throw new TypeError(`模块 ${mod.name} 的 channels 必须是频道前缀数组（[a-z][a-z0-9-]{0,31}，不带冒号）`);
      }
      if (new Set(mod.channels).size !== mod.channels.length) throw new Error(`模块 ${mod.name} 的 channels 有重复前缀`);
    }
  }

  function mount(mod) {
    validate(mod);
    if (mounted.some((e) => e.mod.name === mod.name)) throw new Error(`模块名 ${mod.name} 已经挂上了`);
    for (const e of mounted) {
      for (const a of mod.types) {
        for (const b of e.mod.types) {
          if (typesClash(a, b)) throw new Error(`模块 ${mod.name} 的类型 ${a} 与已挂模块 ${e.mod.name} 的 ${b} 冲突`);
        }
      }
    }
    const prefixes = new Set(mod.channels ?? []);
    for (const p of prefixes) {
      const other = mounted.find((e) => e.channels.has(p));
      if (other) throw new Error(`模块 ${mod.name} 的频道前缀 ${p} 已被模块 ${other.mod.name} 声明`);
    }
    const connFields = mod.describeConn ? fieldNames((id) => mod.describeConn(id), PROBE_CONN_ID) : [];
    const healthFields = mod.health ? fieldNames(() => mod.health()) : [];
    for (const f of connFields) {
      if (CORE_CONN_FIELDS.includes(f)) throw new Error(`模块 ${mod.name} 的连接字段 ${f} 与核心字段重名`);
      const other = mounted.find((e) => e.connFields.includes(f));
      if (other) throw new Error(`模块 ${mod.name} 的连接字段 ${f} 与模块 ${other.mod.name} 重名`);
    }
    for (const f of healthFields) {
      if (CORE_HEALTH_FIELDS.includes(f)) throw new Error(`模块 ${mod.name} 的健康字段 ${f} 与核心字段重名`);
      const other = mounted.find((e) => e.healthFields.includes(f));
      if (other) throw new Error(`模块 ${mod.name} 的健康字段 ${f} 与模块 ${other.mod.name} 重名`);
    }

    const entry = { mod, ctx: null, connFields, healthFields, channels: prefixes, live: true };
    const ops = channelOps(entry);
    entry.ctx = Object.freeze({
      send: (connId, message, opts) => send(connId, message, opts),
      now: () => now(),
      log: (event, fields) => log(event, fields),
      subscribe: ops.subscribe,
      unsubscribe: ops.unsubscribe,
      publish: ops.publish,
      // 这条连接的积压：核心出站队列里的字节数 + 底层尚未发出的字节数；连接不存在回 0。
      // 模块发一长串消息时据此节流，别让积压超过 maxPendingBytes 被 1013 断开（H.2）
      pendingBytes: (connId) => {
        const conn = conns.get(connId);
        return conn ? pendingOf(conn) : 0;
      },
      maxPendingBytes: maxPending,
      // 主动关闭一条连接（例：创建者踢人、删项目时以 4003 / 4004 关闭，`auth-contract.md` 第 7 节）；连接不存在回 false
      close: (connId, code, reason) => {
        if (!conns.has(connId)) return false;
        try {
          close(connId, code, reason);
        } catch (err) {
          log('conn.error', { connId, message: String(err?.message ?? err) });
        }
        return true;
      },
      // 这条连接的来源地址（组装层登记时给的）；连接不存在回 null
      remote: (connId) => conns.get(connId)?.remote ?? null,
    });
    mounted.push(entry);
    for (const c of conns.values()) callHook(entry, 'connect', c.connId, c.principal);

    let done = false;
    return function unmount() {
      if (done) return;
      done = true;
      const i = mounted.indexOf(entry);
      if (i < 0) return;
      for (const c of conns.values()) callHook(entry, 'disconnect', c.connId);
      mounted.splice(mounted.indexOf(entry), 1);
      entry.live = false;
      dropChannelsOf(entry.channels);
    };
  }

  const dispatchTails = new Map();
  function runDispatch(connId, text) {
    const conn = conns.get(connId);
    if (!conn) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return replyError(connId, 'bad-message', '不是合法的 JSON');
    }
    const reqId = isObj(msg) && isReqId(msg.reqId) ? msg.reqId : undefined;
    if (!isObj(msg) || typeof msg.type !== 'string') return replyError(connId, 'bad-message', '消息必须是带字符串 type 字段的对象', reqId);
    const entry = ownerOf(msg.type);
    if (!entry) return replyError(connId, 'unsupported', '没有模块处理这种消息', reqId);
    const fail = (err) => {
      log('module.error', { module: entry.mod.name, type: msg.type, message: String(err?.message ?? err) });
      replyError(connId, 'internal', '处理这条消息时出错', reqId);
    };
    const handle = (reason) => {
      if (conns.get(connId) !== conn) return;
      if (typeof reason === 'string') return replyError(connId, reason, '这条连接不能发这种消息', reqId);
      try {
        const result = entry.mod.handle(entry.ctx, connId, msg);
        if (result && typeof result.then === 'function') return result.catch(fail);
      } catch (err) { fail(err); }
    };
    if (!gate) return handle(null);
    try {
      const reason = gate(conn.principal, msg.type, msg);
      return reason && typeof reason.then === 'function' ? reason.then(handle, () => handle('forbidden')) : handle(reason);
    } catch { return handle('forbidden'); }
  }

  function dispatch(connId, text) {
    const previous = dispatchTails.get(connId);
    const result = previous ? previous.then(() => runDispatch(connId, text)) : runDispatch(connId, text);
    if (result && typeof result.then === 'function') {
      const tail = result.catch(() => {}).finally(() => { if (dispatchTails.get(connId) === tail) dispatchTails.delete(connId); });
      dispatchTails.set(connId, tail);
    }
    return result;
  }


  return {
    connect(connId, principal, info = {}) {
      if (conns.has(connId)) throw new Error(`连接 ${connId} 已经登记过`);
      const conn = {
        connId,
        principal: { ...principal },
        remote: info.remote ?? null,
        connectedAt: info.connectedAt ?? now(),
        outbox: [],
        head: 0,
        live: 0,
        bytes: 0,
        byKey: new Map(),
        shut: false,
        subs: new Set(),
      };
      conns.set(connId, conn);
      for (const entry of [...mounted]) callHook(entry, 'connect', connId, conn.principal);
    },

    disconnect(connId) {
      const conn = conns.get(connId);
      if (!conn) return;
      for (const entry of [...mounted]) callHook(entry, 'disconnect', connId);
      unsubscribeAll(conn);
      resetOutbox(conn);
      conns.delete(connId);
    },

    dispatch,
    mount,

    tick(name) {
      for (const entry of [...mounted]) {
        if (name === undefined || entry.mod.name === name) callHook(entry, 'tick');
      }
    },

    /** 模块之外的发送入口；`opts.coalesceKey` 见 H.2 */
    send,

    /** 组装层在底层 'drain' 时调 */
    drained,

    describeConn(connId) {
      const c = conns.get(connId);
      if (!c) return null;
      const out = {
        connId: c.connId,
        remote: c.remote,
        principal: { ...c.principal },
        connectedAt: c.connectedAt,
        pendingBytes: pendingOf(c),
        subscriptions: [...c.subs].sort(),
      };
      for (const entry of mounted) {
        if (!entry.mod.describeConn) continue;
        try {
          mergeFields(out, entry.mod.describeConn(connId));
        } catch (err) {
          log('module.error', { module: entry.mod.name, hook: 'describeConn', message: String(err?.message ?? err) });
        }
      }
      return out;
    },

    health() {
      let subscriptions = 0;
      for (const set of channels.values()) subscriptions += set.size;
      let pendingBytesMax = 0;
      for (const c of conns.values()) pendingBytesMax = Math.max(pendingBytesMax, pendingOf(c));
      const out = {
        connections: conns.size,
        modules: mounted.map((e) => e.mod.name),
        channels: channels.size,
        subscriptions,
        pendingBytesMax,
        coalesced,
        backpressureCloses,
      };
      for (const entry of mounted) {
        if (!entry.mod.health) continue;
        try {
          mergeFields(out, entry.mod.health());
        } catch (err) {
          log('module.error', { module: entry.mod.name, hook: 'health', message: String(err?.message ?? err) });
        }
      }
      return out;
    },

    /** 诊断：频道 → 订阅数（只列有订阅者的频道，按名排序） */
    channels() {
      return Object.fromEntries([...channels.keys()].sort().map((ch) => [ch, channels.get(ch).size]));
    },

    modules() {
      return mounted.map((e) => e.mod.name);
    },
  };
}
