/**
 * 卡片源码同步在账号云端项目里怎么连进文档服务(`server/card-sync.mjs` 的规则不变,只换端点)。
 *
 * 账号项目的文档服务只认账号办法的连接票据(`cloud/docservice/account-hosted.mjs`:子协议 `promptcut.account.<票据>`,
 * 旧的 `auth.ticket` 在这种连接上一律被拒)。票据由页面凭自己的登录向 `/hosted/shared/account/session` 取,
 * 角色仍是 page、权限就是这位成员此刻的权限;编辑器进程自己不持有登录,也不自报任何身份。
 *
 * 与旧共享项目的两处不同,都在这个端点里:
 *
 * 1. **接续不带票据**。文档服务规定接续项旁边不能有鉴权项(`server/docservice/session.mjs` 的 `parseSessionItem`,带了握手回 400),
 *    接续时由服务端按会话里记下的身份重新核对登录与成员资格(`resumeGate`)。所以只在建新会话时出示票据。
 *
 * 2. **连接有寿命,到期前换一条**。账号连接上的每条消息都要过闸,闸拿建连时那张票据背后的访问令牌去问账号服务;
 *    访问令牌到期(实测 120 秒,票据的 `expiresAt` 就是那个时刻)之后,这条连接还开着,但每条消息都回
 *    `credential-revoked`(再晚是 `authorization-expired`),续令牌也救不回这条连接。
 *    所以:建成会话后按票据的 `expiresAt` 定时,提前 `renewMarginMs` 结束这个会话、凭新票据建下一个;
 *    万一没赶上(时钟不准、定时被拖住),收到这两个原因的 `error` 也立刻换。换的那一下对同步规则来说就是一次
 *    断线重连:在途的请求按断线失败、留在待上传里,新会话建成后重新订阅、重新对账,期间别人的版本由对账补上。
 *    权限真被收回时(退出登录、被踢、项目没了)新票据取不到,会话层退避重试,页面那一侧发现是终局原因会解绑。
 */
import { createDocEndpoint } from './render-node/session-link.mjs';
import { PRODUCT } from './auth/product.mjs';

export const ACCOUNT_PROTOCOL_PREFIX = 'promptcut.account.';
const TICKET = /^[A-Za-z0-9_-]{43}$/;
/** 闸回这两个原因:这条连接背后的访问令牌到期了(或登录被收回),这条连接再也用不了 */
const DEAD_REASONS = new Set(['credential-revoked', 'authorization-expired']);

export const ACCOUNT_CARD_LINK_DEFAULTS = Object.freeze({
  /**
   * 票据到期前多久换下一个会话。要比页面续访问令牌的提前量小(`src/account/client.ts` 的 `ensureLogin`:剩不到 10 秒就续),
   * 这样来要票据时页面一定先续了令牌,新票据是一张满寿命的;比它大的话会拿到一张只剩十来秒的票据,接着连换几次。
   */
  renewMarginMs: 8_000,
  /** 一个会话至少用多久才换(票据只剩几秒时也不至于刚建成就换;没赶上的由 `error` 兜住) */
  minSessionMs: 3_000,
  /** 没有给出到期时刻的票据按多久算(账号访问令牌的寿命是 120 秒,取一半) */
  fallbackLifeMs: 60_000,
});

/** 页面交回的票据:`{ ticket, expiresAt? }` 或只有票据串 */
function normalizeTicket(value) {
  const ticket = typeof value === 'string' ? value : value?.ticket;
  if (typeof ticket !== 'string' || !TICKET.test(ticket)) throw new Error('账号连接票据不合法');
  const expiresAt = typeof value === 'object' && Number.isSafeInteger(value?.expiresAt) ? value.expiresAt : null;
  return { ticket, expiresAt };
}

/**
 * `createCardSync({ connect })` 里账号项目用的端点。形状与 `createDocEndpoint` 相同(send、onMessage、onOpen、onResume、onClose、close、stats)。
 *
 * @param {object} o
 * @param {string} o.url 文档服务的 ws(s):// 地址
 * @param {() => Promise<string | { ticket: string, expiresAt?: number }>} o.getTicket 现取一张账号办法的连接票据;取不到就抛
 * @param {(event: string, fields?: object) => void} [o.log]
 * @param {(o: object) => object} [o.createEndpoint] 缺省 `createDocEndpoint`(测试换成替身)
 * @param {Function} [o.WebSocket] 只给测试换实现(带根证书的)
 */
export function accountCardEndpoint({
  url,
  getTicket,
  log = () => {},
  createEndpoint = createDocEndpoint,
  WebSocket = undefined,
  now = Date.now,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  renewMarginMs = ACCOUNT_CARD_LINK_DEFAULTS.renewMarginMs,
  minSessionMs = ACCOUNT_CARD_LINK_DEFAULTS.minSessionMs,
  fallbackLifeMs = ACCOUNT_CARD_LINK_DEFAULTS.fallbackLifeMs,
} = {}) {
  if (typeof getTicket !== 'function') throw new TypeError('accountCardEndpoint: getTicket 要是函数');
  const handlers = { message: [], open: [], resume: [], close: [] };
  const emit = (kind, arg) => { for (const h of [...handlers[kind]]) { try { h(arg); } catch { /* 上层的处理出错不影响连接 */ } } };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响连接 */ } };
  let closed = false;
  /** 当前的会话端点 `{ ep, expiresAt, timer, renewing }`;换的时候整个换掉 */
  let cur = null;
  let renews = 0;

  function start() {
    const rec = { ep: null, expiresAt: null, timer: null, renewing: false };
    cur = rec;
    const protocols = async () => {
      const t = normalizeTicket(await getTicket());
      rec.expiresAt = t.expiresAt;
      return ['promptcut.v1', `${ACCOUNT_PROTOCOL_PREFIX}${t.ticket}`];
    };
    const ep = createEndpoint({ url, protocols, log, ...(WebSocket ? { WebSocket } : {}) });
    rec.ep = ep;
    ep.onOpen(() => {
      if (cur !== rec || closed) return;
      const life = rec.expiresAt === null ? fallbackLifeMs : rec.expiresAt - now() - renewMarginMs;
      const delay = Math.max(minSessionMs, life);
      if (rec.timer !== null) clearTimer(rec.timer);
      rec.timer = setTimer(() => { rec.timer = null; renew(rec, 'ticket-expiring'); }, delay);
      rec.timer?.unref?.();
      say('account.session', { renewInMs: Math.round(delay), renews });
      emit('open');
    });
    ep.onResume?.(() => { if (cur === rec && !closed) emit('resume'); });
    ep.onClose((info) => {
      if (cur !== rec) return;
      // 会话结束(被服务端关、保留期过了):端点自己会退避着建新会话,那时重新取票据、重新定时
      if (rec.timer !== null) { clearTimer(rec.timer); rec.timer = null; }
      emit('close', info);
    });
    ep.onMessage((msg) => {
      if (cur !== rec || closed) return;
      emit('message', msg);
      if (msg?.type === 'error' && DEAD_REASONS.has(msg.reason)) renew(rec, msg.reason);
    });
  }

  /** 结束这个会话、凭新票据建下一个 */
  function renew(rec, why) {
    if (closed || cur !== rec || rec.renewing) return;
    rec.renewing = true;
    renews += 1;
    say('account.renew', { why, renews });
    if (rec.timer !== null) { clearTimer(rec.timer); rec.timer = null; }
    // 先关(它还是当前端点,关闭照常报给上层:在途的请求按断线处理),再起新的
    try { rec.ep.close(); } catch { /* 已经关了 */ }
    if (closed || cur !== rec) return;
    start();
  }

  start();

  return {
    send: (message) => (closed || !cur ? false : cur.ep.send(message)),
    onMessage(h) { handlers.message.push(h); },
    onOpen(h) { handlers.open.push(h); },
    onResume(h) { handlers.resume.push(h); },
    onClose(h) { handlers.close.push(h); },
    close() {
      if (closed) return;
      closed = true;
      const rec = cur;
      if (rec?.timer != null) { clearTimer(rec.timer); rec.timer = null; }
      try { rec?.ep.close(); } catch { /* 已经关了 */ }
    },
    /** 只断当前传输(测试用) */
    dropTransport: () => cur?.ep.dropTransport?.() ?? false,
    stats() {
      let inner = null;
      try { inner = cur?.ep.stats?.() ?? null; } catch { inner = null; }
      return inner ? { ...inner, accountRenews: renews } : null;
    },
  };
}

/**
 * `createCardSync().bind({ protocols })` 里标明「这是账号项目」的那一项:`cardSyncConnect` 认它,改用 `accountCardEndpoint`。
 * 直接当子协议函数调用也能用(只出示票据,不管寿命),免得别的端点拿到它时出错。
 */
export function accountCardProtocols(getTicket) {
  if (typeof getTicket !== 'function') throw new TypeError('accountCardProtocols: getTicket 要是函数');
  const list = async () => ['promptcut.v1', `${ACCOUNT_PROTOCOL_PREFIX}${normalizeTicket(await getTicket()).ticket}`];
  return Object.assign(list, { accountTicket: getTicket });
}

/**
 * `createCardSync({ connect })`:账号项目(`accountCardProtocols` 给的子协议)用 `accountCardEndpoint`,
 * 其余与缺省的完全一样(`createDocEndpoint({ url, protocols, log })`,日志事件加 `doc.` 前缀)。
 */
export function cardSyncConnect(say = () => {}, { WebSocket = undefined } = {}) {
  const log = (event, fields) => say(`doc.${event}`, fields);
  return ({ url, protocols }) => (typeof protocols?.accountTicket === 'function'
    ? accountCardEndpoint({ url, getTicket: protocols.accountTicket, log, ...(WebSocket ? { WebSocket } : {}) })
    : createDocEndpoint({ url, protocols, log, ...(WebSocket ? { WebSocket } : {}) }));
}

/** 账号云端项目的文档服务地址:正式环境只有这一个,写在产品声明里(公开版没有);桌面外壳的账号桥也只认它(`desktop/src-tauri/src/lib.rs` 的 `account_cloud_binding`) */
export const ACCOUNT_CLOUD_ORIGIN = PRODUCT.accountCloudOrigin;

/**
 * 编辑器进程凭账号票据连出去的地址只能是账号云端的文档服务(`wss://<云端主机>/hosted/`)。
 * 票据是成员本人权限的凭证,绑定请求里的地址不能说连哪就连哪 —— 否则谁能调到绑定接口,谁就能让编辑器进程把票据送到他指定的服务器。
 * `PROMPTCUT_ACCOUNT_CLOUD_ORIGIN`(逗号分隔的 https 源)只给本机联调与探针换成测试用的账号服务,不设就只认正式环境。
 */
export function accountDocUrlAllowed(url, env = process.env) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'wss:' || u.username || u.password || u.search || u.hash || u.pathname !== '/hosted/') return false;
  const allowed = [ACCOUNT_CLOUD_ORIGIN, ...String(env?.PROMPTCUT_ACCOUNT_CLOUD_ORIGIN ?? '').split(',').map((s) => s.trim())].filter(Boolean);
  return allowed.some((origin) => { try { const o = new URL(origin); return o.protocol === 'https:' && o.host === u.host; } catch { return false; } });
}
