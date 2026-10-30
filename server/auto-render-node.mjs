/**
 * 桌面应用自动成为共享项目的渲染节点(语义 `docs/semantics/product/platforms.md`「渲染节点」:
 * 「加入共享项目的桌面应用自动成为这个项目的渲染节点,可以认领本项目任何成员发布的任务」)—— 预渲染进程一侧的状态机。
 *
 * 安装版的预渲染进程启动时不知道任何共享项目(壳与编辑器进程只给运行时路径一类的环境变量)。页面进入共享项目时,
 * 经编辑器进程把这个项目的共享配置交过来(`POST /api/frames/render-node`,编辑器进程一侧见 `render-node-relay.mjs`):
 *   `{ url, projectId, assetBase?, contentId?, ticket? }`
 *   - `url`:页面连的那个文档服务(`ws(s)://…`);云端项目是托管端,局域网成员是主机,本机当主机就是本机的 `/docservice`;
 *   - `projectId`:共享项目的 id(文档服务的空间);
 *   - `assetBase`:页面此刻用的素材服务基址(`…/api/asset`),没有就由预渲染进程按服务地址登记自己挑;
 *   - `contentId`:页面里项目文档的 `id`(层表键 `layers:<contentId>` 用的那个;补推已有的层时按它挑 entry);
 *   - `ticket`:页面在自己的连接上签的 render 角色连接票据(`auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'user' } }`)。
 * 本模块据此给调用方一条「链接」(`link`):`protocols()` 每次**建新会话**时交出一张连接票据 —— 手里的还新鲜就用手里的,
 * 否则经 `requestTicket(projectId)` 向页面要一张(编辑器进程经 HMR 转给页面,页面签好交回)。要不到(页面没了)时
 * `protocols()` 抛错,会话层照常退避重试;已建的会话不受影响(接续不调 `protocols()`),页面回来后下一次重试就续上。
 * 不经手项目口令与 `K`。票据只在内存里,不进日志。
 *
 * 调用方(`vite-plugin-frames.ts`)注入 `start(link)` 与 `stop(handle)`:建 / 撤推送队列与本机渲染节点。
 * 同一个项目(同 `url` + `projectId`)重复交接只换票据与素材基址,不重建;换了项目先撤旧的再建新的;`unbind` 撤掉。
 *
 * 开关(开发者用,缺省开):`PROMPTCUT_AUTO_RENDER_NODE=0` 关掉自动成为渲染节点与自动推送(给观察端,C6.6 T9)。
 * 环境变量已经把这个进程配成节点或推送方(`PROMPTCUT_SHARED_CONFIG`、`PROMPTCUT_QUEUE_NODE=1`、`PROMPTCUT_PUSH=1`、
 * `PROMPTCUT_NODE_PROFILE=host`)时不接动态交接,由环境变量那一套管(探针、独立渲染主机);`PROMPTCUT_PUSH=0` 一律不接。
 */
import { ticketExpiry } from './auth/client.mjs';

export const AUTO_RENDER_NODE_ENV = 'PROMPTCUT_AUTO_RENDER_NODE';
/** 手里的连接票据剩这么久以上才直接用(连接票据有效期 2 分钟,留出握手与时钟偏差的余量) */
export const TICKET_MIN_LEFT_MS = 30_000;
/** 没从票据里读到有效期时,按签发后这么久算过期 */
export const TICKET_ASSUMED_TTL_MS = 90_000;

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TICKET = 2048;

/**
 * 这个进程接不接动态交接。回 null = 接;否则回原因。
 * @param {Record<string, string | undefined>} env
 */
export function autoRenderNodeOffReason(env = process.env) {
  if (env[AUTO_RENDER_NODE_ENV] === '0') return 'disabled';
  if (env.PROMPTCUT_PUSH === '0') return 'push-disabled';
  if (env.PROMPTCUT_NODE_PROFILE === 'host') return 'host-profile';
  if (env.PROMPTCUT_SHARED_CONFIG || env.PROMPTCUT_QUEUE_NODE === '1' || env.PROMPTCUT_PUSH === '1') return 'env-configured';
  return null;
}

/** 规整页面交来的共享配置;不合格抛错(错误信息里不带票据) */
export function normalizeBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('共享配置要是对象');
  let url;
  try { url = new URL(String(input.url ?? '')); } catch { throw new Error('url 不是合法地址'); }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('url 要是 ws:// 或 wss://');
  if (typeof input.projectId !== 'string' || !PROJECT_ID_RE.test(input.projectId)) throw new Error('projectId 不合法');
  let assetBase = null;
  if (input.assetBase !== undefined && input.assetBase !== null && input.assetBase !== '') {
    let a;
    try { a = new URL(String(input.assetBase)); } catch { throw new Error('assetBase 不是合法地址'); }
    if (a.protocol !== 'http:' && a.protocol !== 'https:') throw new Error('assetBase 要是 http:// 或 https://');
    assetBase = String(input.assetBase).replace(/\/+$/, '');
  }
  const contentId = typeof input.contentId === 'string' && input.contentId && input.contentId.length <= 256 ? input.contentId : null;
  return { url: String(input.url), projectId: input.projectId, assetBase, contentId };
}

/** 票据字符串合不合格(只看形状,不验签) */
export const ticketOk = (t) => typeof t === 'string' && t.length > 0 && t.length <= MAX_TICKET && !/\s/.test(t);

/**
 * @param {object} deps
 * @param {(link: object) => Promise<any>} deps.start  建推送队列与本机节点,回 handle(交给 `stop`)
 * @param {(handle: any, reason: string) => Promise<void>} deps.stop  撤掉
 * @param {(projectId: string) => Promise<string>} deps.requestTicket  向页面要一张 render 连接票据;要不到就抛
 * @param {() => number} [deps.now]
 * @param {(event: string, fields?: object) => void} [deps.log]
 */
export function createAutoRenderNode({ start, stop, requestTicket, now = Date.now, log = () => {} }) {
  if (typeof start !== 'function' || typeof stop !== 'function' || typeof requestTicket !== 'function') throw new TypeError('createAutoRenderNode 要 start、stop、requestTicket');
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志出错不影响交接 */ } };

  /** 当前这一代:{ gen, binding, link, handle, starting, ticket: { value, exp } | null, inflight, state, lastError, … } */
  let current = null;
  let gen = 0;
  /** 撤的链:bind / unbind 串起来,撤完旧的才建新的 */
  let chain = Promise.resolve();
  const counters = { binds: 0, same: 0, starts: 0, stops: 0, ticketRequests: 0, ticketFailures: 0, pageTickets: 0 };

  const freshTicket = (rec) => rec.ticket && rec.ticket.exp - now() > TICKET_MIN_LEFT_MS ? rec.ticket.value : null;
  const keepTicket = (rec, value) => {
    const exp = ticketExpiry(value) ?? now() + TICKET_ASSUMED_TTL_MS;
    rec.ticket = { value, exp };
  };

  /** 这一代的 `protocols()`:每次建新会话时调(两条连接可能同时要,合并成一次请求) */
  const protocolsOf = (rec) => async () => {
    if (rec.gen !== gen) throw new Error('这份共享配置已经撤掉');
    let t = freshTicket(rec);
    if (!t) {
      rec.inflight ??= (async () => {
        counters.ticketRequests++;
        try {
          const got = await requestTicket(rec.binding.projectId);
          if (!ticketOk(got)) throw new Error('页面交回的票据不合格');
          if (rec.gen === gen) keepTicket(rec, got);
          rec.waitingPage = false;
          return got;
        } catch (error) {
          counters.ticketFailures++;
          rec.waitingPage = true;
          rec.lastError = String(error?.message ?? error).slice(0, 200);
          if (rec.ticketFailures++ === 0 || rec.ticketFailures % 20 === 0) say('render-node.waiting-page', { projectId: rec.binding.projectId, failures: rec.ticketFailures, message: rec.lastError });
          throw error;
        } finally {
          rec.inflight = null;
        }
      })();
      t = await rec.inflight;
    }
    if (rec.gen !== gen) throw new Error('这份共享配置已经撤掉');
    rec.ticketFailures = 0;
    return ['promptcut.v1', `promptcut.ticket.${t}`];
  };

  const linkOf = (rec) => ({
    mode: 'page',
    url: rec.binding.url,
    shared: true,
    projectId: rec.binding.projectId,
    /** 现取:页面晚交来的项目文档 id(同一个项目只换 id,见 `bind`)也看得到;推送与发布的范围按它判(`push-scope.mjs`) */
    get contentId() { return rec.binding.contentId; },
    assetBase: () => rec.binding.assetBase,
    protocols: protocolsOf(rec),
    /** 这一代还在不在(撤掉之后,还在起步的 start 据此收手) */
    alive: () => rec.gen === gen && !rec.stopping,
  });

  async function teardown(rec, reason) {
    if (!rec) return;
    rec.stopping = true;
    let handle = rec.handle;
    if (!handle && rec.starting) {
      try { handle = await rec.starting; } catch { handle = null; }
    }
    rec.handle = null;
    if (handle) {
      counters.stops++;
      try { await stop(handle, reason); } catch (error) { say('render-node.stop-failed', { message: String(error?.message ?? error) }); }
    }
    say('render-node.stopped', { projectId: rec.binding.projectId, reason });
  }

  function bind(input, { ticket } = {}) {
    const binding = normalizeBinding(input);
    counters.binds++;
    const rec0 = current;
    if (rec0 && rec0.binding.url === binding.url && rec0.binding.projectId === binding.projectId && !rec0.stopping) {
      // 同一个项目:只换票据、素材基址与项目文档 id,不重建
      counters.same++;
      if (ticketOk(ticket)) { keepTicket(rec0, ticket); counters.pageTickets++; rec0.waitingPage = false; }
      const assetChanged = binding.assetBase !== rec0.binding.assetBase;
      rec0.binding = { ...rec0.binding, assetBase: binding.assetBase ?? rec0.binding.assetBase, contentId: binding.contentId ?? rec0.binding.contentId };
      if (assetChanged && binding.assetBase) say('render-node.asset-base', { projectId: binding.projectId, assetBase: binding.assetBase });
      return { ok: true, action: 'same', projectId: binding.projectId };
    }
    const prev = current;
    if (prev) prev.stopReason = 'rebind';
    const rec = { gen: ++gen, binding, handle: null, starting: null, ticket: null, inflight: null, waitingPage: false, ticketFailures: 0, lastError: null, stopping: false, at: now() };
    if (ticketOk(ticket)) { keepTicket(rec, ticket); counters.pageTickets++; }
    current = rec;
    const link = linkOf(rec);
    chain = chain.catch(() => {}).then(async () => {
      if (prev) await teardown(prev, 'rebind');
      if (rec.gen !== gen) return;
      counters.starts++;
      say('render-node.bind', { projectId: binding.projectId, url: binding.url, assetBase: binding.assetBase, contentId: binding.contentId, replaced: prev?.binding.projectId ?? null });
      rec.starting = Promise.resolve().then(() => start(link));
      try {
        rec.handle = await rec.starting;
      } catch (error) {
        rec.lastError = String(error?.message ?? error).slice(0, 200);
        say('render-node.start-failed', { projectId: binding.projectId, message: rec.lastError });
      } finally {
        rec.starting = null;
      }
      // 起步期间被撤了:收尾(teardown 等的是 starting,这里兜住起步完才发现被撤的情形)
      if (rec.gen !== gen && rec.handle) {
        const h = rec.handle;
        rec.handle = null;
        counters.stops++;
        try { await stop(h, rec.stopReason ?? 'superseded'); } catch { /* 已撤 */ }
      }
    });
    return { ok: true, action: prev ? 'rebind' : 'started', projectId: binding.projectId };
  }

  /** 撤掉;给了 `projectId` 时只在当前绑的正是它时才撤(别的页面离开别的项目不影响这里) */
  function unbind({ projectId = null, reason = 'unbind' } = {}) {
    const rec = current;
    if (!rec) return Promise.resolve({ ok: true, action: 'none' });
    if (projectId !== null && projectId !== rec.binding.projectId) return Promise.resolve({ ok: true, action: 'other-project', projectId: rec.binding.projectId });
    current = null;
    gen++;
    rec.stopReason = reason;
    const done = chain.catch(() => {}).then(() => teardown(rec, reason));
    chain = done;
    return done.then(() => ({ ok: true, action: 'stopped', projectId: rec.binding.projectId }));
  }

  function status() {
    const rec = current;
    return {
      bound: !!rec,
      ...(rec ? {
        projectId: rec.binding.projectId, url: rec.binding.url, assetBase: rec.binding.assetBase, contentId: rec.binding.contentId,
        started: !!rec.handle, starting: !!rec.starting, waitingPage: rec.waitingPage, lastError: rec.lastError,
        ticketLeftMs: rec.ticket ? Math.max(0, rec.ticket.exp - now()) : 0, since: rec.at,
      } : {}),
      counters: { ...counters },
    };
  }

  /** 等排着的建 / 撤做完(测试与退出时用) */
  const settled = () => chain.catch(() => {});

  return { bind, unbind, status, settled };
}
