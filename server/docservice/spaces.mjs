/**
 * 按空间起实例的模块外壳（契约 `docs/plan/auth-contract.md` 第 6 节「空间」）。
 *
 * 数据面模块（渲染任务队列、项目、内容库）按连接 principal 的 `tenantId` 各起一份实例，互不相通：
 * - 连接进来时按 `tenantId` 找（没有就建）这个空间的实例，之后它的消息、断开都只交给这一份；
 *   `tenantId` 为 null（旧的匿名身份）算 `local`；
 * - 管理身份（`scope: 'admin'`）不进任何空间：发数据面消息回 `forbidden`；托管方服务的控制身份（`scope: 'service'`、
 *   没有 `tenantId`，`docs/plan/hosted-render-contract.md` 第 1.3 节）同样不进任何空间——不然它会落进 `local`；
 * - 频道名在模块给的名字上再加空间前缀：`<前缀>:<其余>` → `<前缀>:@<空间>/<其余>`。`local` 空间沿用原来的
 *   频道名（M5 的行为），只有「其余」以 `@` 开头时才加 `@local/`，免得和别的空间撞上；
 * - `local` 空间的实例在挂上时就建好（核心要在挂载时问字段名），别的空间用到时才建；
 * - `dropSpace(tenantId)`：删项目时丢掉这个空间的实例（它的连接此前已由调用方关掉）。
 *
 * 对核心（`router.mjs`）来说外壳就是一个普通模块：名字、类型、频道前缀都是实例的。
 * `outbound`（组装层旧接口 `send` 的发送选项）与 `claimsOf` 按连接转给它所在空间的实例。
 */

export const LOCAL_SPACE = 'local';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** 连接进哪个空间；管理身份、托管方服务的控制身份回 null */
export function spaceOf(principal) {
  if (principal?.scope === 'admin') return null;
  if (typeof principal?.tenantId === 'string' && principal.tenantId !== '') return principal.tenantId;
  return principal?.scope === 'service' ? null : LOCAL_SPACE;
}

/** 空间内的频道名 → 核心里的频道名 */
export function spaceChannel(space, channel) {
  const i = channel.indexOf(':');
  if (i <= 0) return channel; // 不合法的名字原样交给核心，由核心抛错
  const prefix = channel.slice(0, i);
  const rest = channel.slice(i + 1);
  if (space === LOCAL_SPACE && !rest.startsWith('@')) return channel;
  return `${prefix}:@${space}/${rest}`;
}

/**
 * @param {object} options
 * @param {(space: string) => object} options.create 为一个空间造一份模块实例（G.3 模块）
 * @param {(healths: Array<[string, object]>) => object} [options.health] 合并各空间的 health；缺省用 `local` 的
 */
export function spacedModule({ create, health: mergeHealth } = {}) {
  if (typeof create !== 'function') throw new TypeError('spacedModule: create 必须是函数');
  /** 空间 → { mod, ctx }，ctx 是按空间改写过频道名的上下文 */
  const spaces = new Map();
  /** connId → 空间（管理身份记 null） */
  const conns = new Map();
  let outerCtx = null;

  const local = create(LOCAL_SPACE);
  if (!isObj(local) || typeof local.name !== 'string') throw new TypeError('spacedModule: create 必须回模块对象');

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

  /** 记下核心给的上下文，并确保 local 的实例已建（核心挂载时只问字段名，不给 ctx） */
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
        const out = { type: 'error', reason: 'forbidden', detail: '这条连接不在任何空间里' };
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

    /** 组装层旧接口 `send` 的发送选项：转给连接所在空间的实例 */
    outbound(connId, message) {
      const space = conns.get(connId);
      const entry = space ? instance(space, false) : null;
      const fn = entry?.mod.outbound;
      return typeof fn === 'function' ? fn.call(entry.mod, connId, message) : {};
    },

    /** 这条连接此刻持有的认领数（成员列表的「渲染中」标签用） */
    claimsOf(connId) {
      const space = conns.get(connId);
      const entry = space ? instance(space, false) : null;
      const fn = entry?.mod.claimsOf;
      return typeof fn === 'function' ? fn.call(entry.mod, connId) : 0;
    },

    /** 立即放回这条连接手里的认领（关掉托管方渲染节点的开关时用）；实例不支持回 0 */
    releaseClaims(connId, reason) {
      const space = conns.get(connId);
      const entry = space ? instance(space, false) : null;
      const fn = entry?.mod.releaseClaims;
      return typeof fn === 'function' ? fn.call(entry.mod, connId, reason) : 0;
    },

    /** 丢掉一个空间的实例：剩下的连接先按断开处理，再调实例的 `dispose` */
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

    /** 现有的空间（诊断与测试用） */
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
