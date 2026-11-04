/**
 * Module shell instantiating per space (contract `docs/plan/auth-contract.md` section 6 "Spaces").
 *
 * Data plane modules (render queue, project, content store) spin up separate instances per connection
 * principal's `tenantId`, isolated from each other:
 * - On incoming connection, find (or create) the instance for this space by `tenantId`; subsequent
 *   messages and disconnections are handled solely by this instance; a null `tenantId` (legacy
 *   anonymous identity) counts as `local`;
 * - Admin identity (`scope: 'admin'`) enters no space: data plane messages return `forbidden`; host
 *   service control identity (`scope: 'service'`, without `tenantId`, `docs/plan/hosted-render-contract.md`
 *   section 1.3) likewise enters no space: otherwise it would fall into `local`;
 * - Channel names prepend a space prefix to the module-provided name: `<prefix>:<rest>` →
 *   `<prefix>:@<space>/<rest>`. The `local` space retains legacy channel names (M5 behavior), adding
 *   `@local/` only when the "rest" part starts with `@`, avoiding collisions with other spaces;
 * - The `local` space instance is built upon mounting (the core queries field names at mount time),
 *   while other spaces are built only on demand;
 * - `dropSpace(tenantId)`: drops this space's instance when deleting a project (its connections
 *   have already been closed by the caller).
 *
 * To the core (`router.mjs`), the shell is just a regular module: name, type, and channel prefix all
 * come from the instance.
 * `outbound` (send options for assembly layer legacy `send` interface) and `claimsOf` forward to the
 * instance of the connection's space.
 */

export const LOCAL_SPACE = 'local';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** Which space the connection joins; admin identity and host service control identity return null */
export function spaceOf(principal) {
  if (principal?.scope === 'admin') return null;
  if (typeof principal?.tenantId === 'string' && principal.tenantId !== '') return principal.tenantId;
  return principal?.scope === 'service' ? null : LOCAL_SPACE;
}

/** Channel name in space → channel name in core */
export function spaceChannel(space, channel) {
  const i = channel.indexOf(':');
  if (i <= 0) return channel; // Pass invalid names to core as is, letting core throw errors
  const prefix = channel.slice(0, i);
  const rest = channel.slice(i + 1);
  if (space === LOCAL_SPACE && !rest.startsWith('@')) return channel;
  return `${prefix}:@${space}/${rest}`;
}

/**
 * @param {object} options
 * @param {(space: string) => object} options.create Create a module instance for a space (G.3 module)
 * @param {(healths: Array<[string, object]>) => object} [options.health] Merge health across spaces; defaults to `local`
 */
export function spacedModule({ create, health: mergeHealth } = {}) {
  if (typeof create !== 'function') throw new TypeError('spacedModule: create must be a function');
  /** Space → { mod, ctx }; ctx is the context with channel names rewritten per space */
  const spaces = new Map();
  /** connId → space (admin identity is recorded as null) */
  const conns = new Map();
  let outerCtx = null;

  const local = create(LOCAL_SPACE);
  if (!isObj(local) || typeof local.name !== 'string') throw new TypeError('spacedModule: create must return a module object');

  function wrapCtx(space, ctx) {
    return Object.freeze({
      ...ctx,
      subscribe: (connId, channel) => ctx.subscribe(connId, spaceChannel(space, channel)),
      unsubscribe: (connId, channel) => ctx.unsubscribe(connId, spaceChannel(space, channel)),
      publish: (channel, message, opts) => ctx.publish(spaceChannel(space, channel), message, opts),
    });
  }

  function instance(space, create_ = true) {
    let entry = spaces.get(space);
    if (entry || !create_) return entry ?? null;
    entry = { mod: space === LOCAL_SPACE ? local : create(space), ctx: wrapCtx(space, outerCtx) };
    spaces.set(space, entry);
    return entry;
  }

  /** Save core context and ensure local instance is created (core only queries fields at mount, without ctx) */
  function bind(ctx) {
    if (!outerCtx) outerCtx = ctx;
    if (!spaces.has(LOCAL_SPACE)) instance(LOCAL_SPACE);
  }

  function call(entry, hook, ...args) {
    const fn = entry.mod[hook];
    if (typeof fn === 'function') return fn.call(entry.mod, entry.ctx, ...args);
    return undefined;
  }

  const wrapper = {
    name: local.name,
    types: [...local.types],
    ...(local.channels ? { channels: [...local.channels] } : {}),
    ...(Number.isFinite(local.tickMs) ? { tickMs: local.tickMs } : {}),

    connect(ctx, connId, principal) {
      bind(ctx);
      const space = spaceOf(principal);
      conns.set(connId, space);
      if (space === null) return;
      call(instance(space), 'connect', connId, principal);
    },

    disconnect(ctx, connId) {
      bind(ctx);
      const space = conns.get(connId);
      conns.delete(connId);
      if (space === null || space === undefined) return;
      const entry = instance(space, false);
      if (entry) call(entry, 'disconnect', connId);
    },

    handle(ctx, connId, msg) {
      bind(ctx);
      const space = conns.get(connId);
      if (space === null || space === undefined) {
        const out = { type: 'error', reason: 'forbidden', detail: 'This connection is not in any space' };
        if (isReqId(msg.reqId)) out.reqId = msg.reqId;
        ctx.send(connId, out);
        return undefined;
      }
      return call(instance(space), 'handle', connId, msg);
    },

    describeConn(connId) {
      const space = conns.get(connId);
      const entry = (space && instance(space, false)) || { mod: local };
      return typeof entry.mod.describeConn === 'function' ? entry.mod.describeConn(connId) : {};
    },

    health() {
      if (typeof local.health !== 'function') return {};
      if (typeof mergeHealth === 'function') {
        const list = [[LOCAL_SPACE, local.health()]];
        for (const [space, entry] of spaces) if (space !== LOCAL_SPACE && typeof entry.mod.health === 'function') list.push([space, entry.mod.health()]);
        return mergeHealth(list);
      }
      return local.health();
    },

    describe() {
      const base = typeof local.describe === 'function' ? local.describe() : null;
      const others = [...spaces.keys()].filter((s) => s !== LOCAL_SPACE).sort();
      if (others.length === 0 || !isObj(base)) return base;
      return {
        ...base,
        spaces: Object.fromEntries(others.map((s) => {
          const m = spaces.get(s).mod;
          return [s, typeof m.describe === 'function' ? m.describe() : null];
        })),
      };
    },

    /** Assembly layer legacy `send` interface send options: forwarded to the instance for the connection's space */
    outbound(connId, message) {
      const space = conns.get(connId);
      const entry = space ? instance(space, false) : null;
      const fn = entry?.mod.outbound;
      return typeof fn === 'function' ? fn.call(entry.mod, connId, message) : {};
    },

    /** Number of claims currently held by this connection (used for "Rendering" badge in member list) */
    claimsOf(connId) {
      const space = conns.get(connId);
      const entry = space ? instance(space, false) : null;
      const fn = entry?.mod.claimsOf;
      return typeof fn === 'function' ? fn.call(entry.mod, connId) : 0;
    },

    /** Immediately release claims for this connection (when disabling host render node); returns 0 if unsupported */
    releaseClaims(connId, reason) {
      const space = conns.get(connId);
      const entry = space ? instance(space, false) : null;
      const fn = entry?.mod.releaseClaims;
      return typeof fn === 'function' ? fn.call(entry.mod, connId, reason) : 0;
    },

    /** Drop a space instance: remaining connections are treated as disconnected first, then call instance `dispose` */
    dropSpace(space) {
      if (space === LOCAL_SPACE) return false;
      const entry = spaces.get(space);
      if (!entry) return false;
      for (const [connId, s] of conns) {
        if (s !== space) continue;
        call(entry, 'disconnect', connId);
        conns.set(connId, undefined);
      }
      call(entry, 'dispose');
      spaces.delete(space);
      return true;
    },

    /** Existing spaces (used for diagnostics and tests) */
    spaces: () => [...spaces.keys()],
  };

  if (typeof local.tick === 'function') {
    wrapper.tick = (ctx) => {
      bind(ctx);
      for (const entry of [...spaces.values()]) call(entry, 'tick');
    };
  }
  return wrapper;
}
