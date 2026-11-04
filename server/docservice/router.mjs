/**
 * General core of the document service: connection registration, parsing JSON envelopes, routing
 * messages to mounted modules by message type, module mounting and conflict checks, channel
 * distribution, and outbound backpressure for each connection.
 *
 * Contracts: see G.2, G.3 of M5a contract and H.1, H.2, H.4 of C6.1 under `docs/plan/` (file
 * names contain gatekeeper terms, not written in full here). The document service is a general
 * text / JSON distribution center (`docs/semantics/product/document-service.md` "Responsibilities"),
 * so this file is unaware of any specific business logic: it does not reference business modules,
 * nor branch on business message names. Business logic lives entirely in modules mounted by the
 * assembly layer. Channel prefixes and merge keys are strings provided by modules; the core only
 * compares them and is unaware of any concrete values.
 *
 * Transport is handled by the assembly layer: this file manipulates connections only via `write` /
 * `buffered` / `close` provided at construction, and the assembly layer calls `drained` when the
 * underlying layer drains.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** Default values for outbound backpressure (H.2): when underlying backlog reaches high watermark, switches to entering the core's own outbox; when the outbox plus backlog exceeds upper limit, closes with 1013 */
export const CORE_DEFAULTS = Object.freeze({
  HIGH_WATER_BYTES: 64 * 1024,
  MAX_PENDING_BYTES: 1024 * 1024,
});

/** WebSocket close code used for backpressure closure (Try Again Later) */
const CLOSE_TRY_AGAIN = 1013;

/** Fields provided by the core itself in `describeConn`; modules cannot duplicate these names (G.3 "Field conflicts", H.4) */
const CORE_CONN_FIELDS = Object.freeze(['connId', 'remote', 'principal', 'connectedAt', 'pendingBytes', 'subscriptions']);
/**
 * Core fields for `/healthz` (G.4, H.4); module `health()` cannot duplicate names. `conns` is also
 * reserved for the core: the assembly layer's `describe()` flattens health fields and `conns` onto
 * the same level.
 */
const CORE_HEALTH_FIELDS = Object.freeze([
  'ok', 'service', 'uptimeMs', 'connections', 'protocol', 'modules', 'conns',
  'channels', 'subscriptions', 'pendingBytesMax', 'coalesced', 'backpressureCloses',
]);

/** Connection id used during mount to query `describeConn` field names: will not collide with real connections */
const PROBE_CONN_ID = '\u0000probe';

/** Channel prefix (H.1): channel name is `<prefix>:<rest>`, with non-empty rest */
const CHANNEL_PREFIX = /^[a-z][a-z0-9-]{0,31}$/;

/** Prefix of channel name; returns null if invalid */
function prefixOf(channel) {
  if (typeof channel !== 'string') return null;
  const i = channel.indexOf(':');
  if (i <= 0 || i === channel.length - 1) return null;
  const prefix = channel.slice(0, i);
  return CHANNEL_PREFIX.test(prefix) ? prefix : null;
}

/** Whether two type declarations claim the same message (G.3 "Type conflicts") */
function typesClash(a, b) {
  const pa = a.endsWith('.');
  const pb = b.endsWith('.');
  if (!pa && !pb) return a === b;
  if (pa && pb) return a.startsWith(b) || b.startsWith(a);
  return pa ? b.startsWith(a) : a.startsWith(b);
}

function fieldNames(fn, arg) {
  const out = fn(arg);
  if (!isObj(out)) throw new TypeError('describeConn / health must return an object');
  return Object.keys(out);
}

/** Merges fields provided by the module into `into`; does not allow overwriting existing fields (core fields, previously mounted modules) */
function mergeFields(into, fields) {
  if (!isObj(fields)) return;
  for (const [k, v] of Object.entries(fields)) {
    if (!Object.hasOwn(into, k)) into[k] = v;
  }
}

/** Merge key in send options: only recognizes strings; everything else is treated as having no key */
const keyOf = (opts) => (isObj(opts) && typeof opts.coalesceKey === 'string' ? opts.coalesceKey : undefined);
/** Connection to skip during broadcast (`opts.except`, connection id): only recognizes strings; everything else is treated as absent */
const exceptOf = (opts) => (isObj(opts) && typeof opts.except === 'string' ? opts.except : undefined);

const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/**
 * @param {object} options
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {(connId: string, text: string) => void} options.write Writes a serialized message to the
 *   connection (regardless of underlying backlog)
 * @param {(connId: string) => number} [options.buffered] Number of unsent bytes in the underlying
 *   layer; defaults to 0 (no backpressure)
 * @param {(connId: string, code: number, reason: string) => void} [options.close] Proactively
 *   closes the connection
 * @param {number} [options.highWaterBytes] Defaults to `CORE_DEFAULTS.HIGH_WATER_BYTES`
 * @param {number} [options.maxPendingBytes] Defaults to `CORE_DEFAULTS.MAX_PENDING_BYTES`
 * @param {(principal: object, type: string, msg: object) => string | null} [options.gate]
 *   Admission check before dispatch: returning a reason string skips the module and directly
 *   returns `error { reason }`; returning null dispatches normally.
 *   The core is unaware of any identity or business logic; all criteria reside in the assembly
 *   layer (e.g. admin identities can only send messages for admin endpoints, `auth-contract.md`
 *   section 5)
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
  if (typeof write !== 'function') throw new TypeError('createRouter: write must be a function');
  if (typeof buffered !== 'function') throw new TypeError('createRouter: buffered must be a function');
  if (typeof close !== 'function') throw new TypeError('createRouter: close must be a function');
  const highWater = positive(highWaterBytes, CORE_DEFAULTS.HIGH_WATER_BYTES);
  const maxPending = positive(maxPendingBytes, CORE_DEFAULTS.MAX_PENDING_BYTES);

  /**
   * connId → connection record:
   * - Identity: `connId`, `principal`, `remote`, `connectedAt`;
   * - Outbox (H.2): `outbox` stores `{ text, bytes, key, dead }` in arrival order, with
   *   items before `head` already written out;
   *   coalesced items are only marked `dead` and skipped during drain. `live` is the count of items
   *   not yet written out and not coalesced, `bytes` is their byte count,
   *   `byKey` is coalesce key → that item in the outbox;
   * - `shut`: closed due to backpressure; subsequent sends are all dropped;
   * - `subs`: subscribed channels (H.1).
   */
  const conns = new Map();
  /** In mount order: { mod, ctx, connFields, healthFields, channels: Set<prefix>, live } */
  const mounted = [];
  /** Channel → connection ids subscribed to it; channels with no subscribers are not kept in the table */
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

  /** Backlog for this connection: bytes in the outbox + unsent bytes in underlying layer */
  const pendingOf = (conn) => conn.bytes + bufferedOf(conn.connId);

  // ---------- Outbound: direct write, buffering, coalesce, drain, backpressure (H.2) ----------

  /** Clears the outbox */
  function resetOutbox(conn) {
    conn.outbox = [];
    conn.head = 0;
    conn.live = 0;
    conn.bytes = 0;
    conn.byKey.clear();
  }

  /** Exceeded limit: clear, close with 1013, count. Subsequent sends are dropped, waiting for assembly layer to report disconnect */
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
   * Hands a serialized message to this connection: writes directly if the outbox is empty and underlying
   * layer has not reached high-water mark, otherwise buffers it (deletes older with same key first).
   * Returns whether it was accepted (written out or buffered); returns false if already closed or
   * if buffering it triggered a backpressure close.
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

  /** Underlying layer drained: write in arrival order until the outbox is empty or underlying reaches high-water mark again */
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

  // ---------- Channels (H.1) ----------

  function unsubscribeAll(conn) {
    for (const ch of conn.subs) {
      const set = channels.get(ch);
      if (!set) continue;
      set.delete(conn.connId);
      if (set.size === 0) channels.delete(ch);
    }
    conn.subs.clear();
  }

  /** When unmounting a module, all subscriptions under its prefix are cleared */
  function dropChannelsOf(prefixes) {
    if (prefixes.size === 0) return;
    for (const [ch, set] of [...channels]) {
      if (!prefixes.has(prefixOf(ch))) continue;
      for (const id of set) conns.get(id)?.subs.delete(ch);
      channels.delete(ch);
    }
  }

  /** Channel operations for a mounted module: channel name must be valid and prefix must be one it declared, otherwise throws */
  function channelOps(entry) {
    const own = (channel) => {
      const prefix = prefixOf(channel);
      if (prefix === null) throw new Error(`Invalid channel name: ${String(channel)}`);
      if (!entry.channels.has(prefix)) throw new Error(`Module ${entry.mod.name} did not declare channel prefix ${prefix}`);
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

  // ---------- Modules ----------

  /** Invokes module lifecycle hooks; thrown errors are only logged without affecting core or other modules */
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
    if (!isObj(mod)) throw new TypeError('Module must be an object');
    if (typeof mod.name !== 'string' || mod.name === '') throw new TypeError('Module name must be a non-empty string');
    if (!Array.isArray(mod.types) || mod.types.some((t) => typeof t !== 'string' || t === '')) {
      throw new TypeError(`types of module ${mod.name} must be a non-empty string array`);
    }
    if (typeof mod.handle !== 'function') throw new TypeError(`handle of module ${mod.name} must be a function`);
    for (const hook of ['connect', 'disconnect', 'tick', 'describeConn', 'health', 'describe']) {
      if (mod[hook] !== undefined && typeof mod[hook] !== 'function') throw new TypeError(`${hook} of module ${mod.name} must be a function`);
    }
    if (mod.channels !== undefined) {
      if (!Array.isArray(mod.channels) || mod.channels.some((p) => typeof p !== 'string' || !CHANNEL_PREFIX.test(p))) {
        throw new TypeError(`channels of module ${mod.name} must be an array of channel prefixes ([a-z][a-z0-9-]{0,31}, no colon)`);
      }
      if (new Set(mod.channels).size !== mod.channels.length) throw new Error(`channels of module ${mod.name} has duplicate prefixes`);
    }
  }

  function mount(mod) {
    validate(mod);
    if (mounted.some((e) => e.mod.name === mod.name)) throw new Error(`Module name ${mod.name} is already mounted`);
    for (const e of mounted) {
      for (const a of mod.types) {
        for (const b of e.mod.types) {
          if (typesClash(a, b)) throw new Error(`Type ${a} of module ${mod.name} conflicts with ${b} of mounted module ${e.mod.name}`);
        }
      }
    }
    const prefixes = new Set(mod.channels ?? []);
    for (const p of prefixes) {
      const other = mounted.find((e) => e.channels.has(p));
      if (other) throw new Error(`Channel prefix ${p} of module ${mod.name} is already declared by module ${other.mod.name}`);
    }
    const connFields = mod.describeConn ? fieldNames((id) => mod.describeConn(id), PROBE_CONN_ID) : [];
    const healthFields = mod.health ? fieldNames(() => mod.health()) : [];
    for (const f of connFields) {
      if (CORE_CONN_FIELDS.includes(f)) throw new Error(`Module ${mod.name}: connection field ${f} duplicates a core field`);
      const other = mounted.find((e) => e.connFields.includes(f));
      if (other) throw new Error(`Module ${mod.name}: connection field ${f} duplicates one in module ${other.mod.name}`);
    }
    for (const f of healthFields) {
      if (CORE_HEALTH_FIELDS.includes(f)) throw new Error(`Module ${mod.name}: health field ${f} duplicates a core field`);
      const other = mounted.find((e) => e.healthFields.includes(f));
      if (other) throw new Error(`Module ${mod.name}: health field ${f} duplicates one in module ${other.mod.name}`);
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
      // Backlog for this connection: bytes in the core's outbox + unsent bytes in underlying layer;
      // returns 0 if connection does not exist.
      // Modules throttle based on this when sending long bursts of messages, preventing backlog
      // from exceeding maxPendingBytes and being disconnected with 1013 (H.2)
      pendingBytes: (connId) => {
        const conn = conns.get(connId);
        return conn ? pendingOf(conn) : 0;
      },
      maxPendingBytes: maxPending,
      // Proactively closes a connection (e.g. creator kicks member or deletes project with 4003 / 4004 close,
      // `auth-contract.md` section 7); returns false if connection does not exist
      close: (connId, code, reason) => {
        if (!conns.has(connId)) return false;
        try {
          close(connId, code, reason);
        } catch (err) {
          log('conn.error', { connId, message: String(err?.message ?? err) });
        }
        return true;
      },
      // Remote address of this connection (provided when registered by assembly layer);
      // returns null if connection does not exist
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
      return replyError(connId, 'bad-message', 'Not valid JSON');
    }
    const reqId = isObj(msg) && isReqId(msg.reqId) ? msg.reqId : undefined;
    if (!isObj(msg) || typeof msg.type !== 'string') return replyError(connId, 'bad-message', 'Message must be an object with a string type field', reqId);
    const entry = ownerOf(msg.type);
    if (!entry) return replyError(connId, 'unsupported', 'No module handles this kind of message', reqId);
    const fail = (err) => {
      log('module.error', { module: entry.mod.name, type: msg.type, message: String(err?.message ?? err) });
      replyError(connId, 'internal', 'Error while handling this message', reqId);
    };
    const handle = (reason) => {
      if (conns.get(connId) !== conn) return;
      if (typeof reason === 'string') return replyError(connId, reason, 'This connection cannot send this kind of message', reqId);
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
      if (conns.has(connId)) throw new Error(`Connection ${connId} is already registered`);
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

    /** Entry point for sending outside modules; see H.2 for `opts.coalesceKey` */
    send,

    /** Called by assembly layer when underlying layer emits 'drain' */
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

    /** Diagnostics: channel → subscriber count (only lists channels with subscribers, sorted by name) */
    channels() {
      return Object.fromEntries([...channels.keys()].sort().map((ch) => [ch, channels.get(ch).size]));
    },

    modules() {
      return mounted.map((e) => e.mod.name);
    },
  };
}
