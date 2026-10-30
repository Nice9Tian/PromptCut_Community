/**
 * 共享项目的 HTTP 端点（契约 `docs/plan/auth-contract.md` 第 4 节）。
 *
 * | 端点 | 说明 |
 * |---|---|
 * | `POST shared/create` | 建项目，客户端交派生好的 `K`；201 / 400 / 403 / 409 / 429 |
 * | `GET shared/lookup?name=` | 按名字查项目 id；200 / 404 |
 * | `POST shared/challenge` | 取进入挑战；200 / 400 / 404 / 429 |
 * | `POST shared/invite/resolve` | 凭邀请码查项目（C10a）：200 / 404 `invite-invalid` / 429 |
 * | `POST shared/invite/redeem` | 凭邀请码兑换（C10a）：200 / 400 / 401 `banned` / 404 `invite-invalid` / 429 |
 * | `POST shared/verify` | 〔裁〕核对一份进入证明（`claude/join-error`）：200 / 400 / 401 / 429 |
 * | `POST shared/service-challenge` | 托管方服务取握手挑战（`docs/plan/hosted-render-contract.md` 第 1.2 节）：200 / 400 / 429；组装方没给登记表时 404 |
 *
 * `shared/verify`〔裁〕：体 `{ protocols: [...] }` 就是 WebSocket 握手要给的子协议列表，其中必须有证明
 * （`promptcut.auth.…`），交给与握手**同一个** `authenticate` 核对：过了回 200 `{ ok: true }`，不过回 401 `unauthorized`
 * （与握手一样不说原因）。证明里的 nonce 照样用掉、失败照样计入限速。用处：浏览器里 WebSocket 握手被 401 拒和根本没连上
 * 看起来一样（都是 1006），页面进不去时拿一份新证明来问一次，分清「用户名或密码不对」与「连不上服务器」。
 * 组装方不给 `authenticate` 时本端点回 404（与没有这个端点的旧服务一样）。
 *
 * 独立模式挂在文档服务自己的 http 服务器上（路径 `/shared/…`），挂载模式挂在 `<WS 路径>/shared/…`
 * （vite 里是 `/docservice/shared/…`）。本模块只认调用方给的前缀，其余路径一概不碰。
 *
 * 全部回 JSON、`Cache-Control: no-store`、`Access-Control-Allow-Origin: *`（不带凭证），答 `OPTIONS` 预检。
 * 请求体上限 64 KiB，超出回 413。错误统一为 `{ ok: false, error: '<原因>' }`。
 *
 * 谁能建〔裁〕：
 * - 托管端（`mode: 'hosted'`，独立模式）：任何来源都能建；同一来源每小时最多 10 个，整台服务最多 1000 个，超出 429；
 * - 局域网主机（`mode: 'lan'`，挂载模式）：只有本机回环来源能建，别的 403。
 *
 * 回环来源（`isLoopback`）：局域网主机只让回环建项目；回环的挑战、邀请码失败不计入限速。本机信任关掉时
 * （`PROMPTCUT_TRUST_LOOPBACK=0`，托管端在反向代理之后，`docs/plan/http-transport-contract.md` 第 10 节），
 * 组装方（`createSharedDocService`）传进来的 `isLoopback` 一律回 false，回环与别的来源一样受限。
 *
 * 名单外的用户名（以及 `as: 'creator'` 而不是创建者）回伪盐：`HMAC-SHA256(serverSecret, projectId + '\n' + username)`
 * 的前 16 字节，同一用户名每次都一样，形状与真盐相同。
 */
import { createHmac } from 'node:crypto';
import {
  AUTH_PREFIX, SERVICE_PREFIX, KEY_BYTES, SALT_BYTES, isProjectId, isProjectName, isUsername as isUsernameShape, isDeviceId, isB64Bytes, isKdf,
  isReservedUsername, isServiceName,
} from './protocol.mjs';
import { credentialFor } from './handshake.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';
import { isInviteCode, inviteDigest, inviteActive, redeemOn } from './invite.mjs';

export const SHARED_HTTP_DEFAULTS = Object.freeze({
  MAX_BODY: 64 * 1024,
  CREATE_PER_HOUR: 10,
  MAX_PROJECTS: 1000,
  HOUR_MS: 3_600_000,
});

const ALLOW_HEADERS = 'Content-Type';
const ALLOW_METHODS = 'GET, POST, OPTIONS';

function send(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

const fail = (res, status, error) => send(res, status, { ok: false, error });

class TooLarge extends Error {}

/** 读请求体（上限 maxBody）；超出抛 TooLarge */
function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBody) {
      reject(new TooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBody) {
        done = true;
        reject(new TooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 成员能用的用户名：形状对，且不是留给服务身份的 `service:` 开头（`hosted-render-contract.md` 第 1.4 节） */
const isUsername = (v) => isUsernameShape(v) && !isReservedUsername(v);
const isCred = (v) => isObj(v) && isB64Bytes(v.salt, SALT_BYTES) && isB64Bytes(v.key, KEY_BYTES);

/** 校验 `shared/create` 的请求体；合格回规整后的对象，否则 null */
export function parseCreate(body) {
  if (!isObj(body)) return null;
  const { name, mode, kdf, creator, project, list } = body;
  if (!isProjectName(name) || (mode !== 'free' && mode !== 'restricted') || !isKdf(kdf)) return null;
  if (!isCred(creator) || !isUsername(creator.username)) return null;
  const out = { name, mode, kdf: { alg: kdf.alg, iter: kdf.iter }, creator: { username: creator.username, salt: creator.salt, key: creator.key } };
  if (mode === 'free') {
    if (!isCred(project) || list !== undefined) return null;
    out.project = { salt: project.salt, key: project.key };
  } else {
    if (project !== undefined) return null;
    const entries = list ?? [];
    if (!Array.isArray(entries) || entries.length > 1000) return null;
    const seen = new Set([creator.username]);
    out.list = [];
    for (const e of entries) {
      if (!isCred(e) || !isUsername(e.username) || seen.has(e.username)) return null;
      seen.add(e.username);
      out.list.push({ username: e.username, salt: e.salt, key: e.key });
    }
  }
  return out;
}

/** 校验名单（`set-list` 也用）：`[{ username, salt, key }]`，不重名、不含创建者 */
export function parseList(list, creatorName) {
  if (!Array.isArray(list) || list.length > 1000) return null;
  const seen = new Set([creatorName]);
  const out = [];
  for (const e of list) {
    if (!isCred(e) || !isUsername(e.username) || seen.has(e.username)) return null;
    seen.add(e.username);
    out.push({ username: e.username, salt: e.salt, key: e.key });
  }
  return out;
}

export { isCred };

/** 伪盐：`HMAC-SHA256(serverSecret, projectId + '\n' + username)` 的前 16 字节 */
export function fakeSalt(serverSecret, projectId, username) {
  return createHmac('sha256', serverSecret).update(`${projectId}\n${username}`, 'utf8').digest().subarray(0, SALT_BYTES).toString('base64url');
}

/**
 * @param {object} options
 * @param {() => object | null} options.store 取凭证存储；取不到时全部端点回 503 `auth-store`
 * @param {ReturnType<import('./challenges.mjs').createChallenges>} options.challenges
 * @param {ReturnType<import('./rate-limit.mjs').createRateLimiter>} options.limiter
 * @param {'hosted' | 'lan'} options.mode
 * @param {(req) => boolean} options.isLoopback
 * @param {(req) => string | null} [options.remoteOf]
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.createPerHour]
 * @param {number} [options.maxProjects]
 * @param {number} [options.maxBody]
 * @param {(projectId: string) => void} [options.onCreate]
 * @param {(req) => object | null} [options.authenticate] 握手鉴权（`createHandshakeAuth().authenticate`）；给了才答 `shared/verify`
 * @param {() => object | null} [options.services] 取服务登记表；给了（托管端）才答 `shared/service-challenge`
 */
export function createSharedHttp({
  store,
  challenges,
  limiter,
  mode,
  isLoopback,
  remoteOf = (req) => req?.socket?.remoteAddress ?? null,
  now = Date.now,
  log = () => {},
  createPerHour = SHARED_HTTP_DEFAULTS.CREATE_PER_HOUR,
  maxProjects = SHARED_HTTP_DEFAULTS.MAX_PROJECTS,
  maxBody = SHARED_HTTP_DEFAULTS.MAX_BODY,
  onCreate = () => {},
  authenticate = null,
  services = null,
}) {
  const servicesOf = typeof services === 'function' ? services : () => services;
  if (mode !== 'hosted' && mode !== 'lan') throw new TypeError("createSharedHttp: mode 只能是 'hosted' 或 'lan'");
  const storeOf = typeof store === 'function' ? store : () => store;
  /** 来源 → 最近一小时建项目的时刻 */
  const creates = new Map();

  const loopbackOf = (req) => {
    try {
      return !!isLoopback(req);
    } catch {
      return false;
    }
  };

  async function jsonBody(req, res) {
    let text;
    try {
      text = await readBody(req, maxBody);
    } catch (err) {
      if (err instanceof TooLarge) {
        res.setHeader('Connection', 'close');
        fail(res, 413, 'too-large');
        req.resume();
        return undefined;
      }
      fail(res, 400, 'bad-request');
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      fail(res, 400, 'bad-request');
      return undefined;
    }
  }

  async function create(req, res, st) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (mode === 'lan' && !loopback) {
      req.resume();
      return fail(res, 403, 'forbidden');
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    const parsed = parseCreate(body);
    if (!parsed) return fail(res, 400, 'bad-request');
    if (mode === 'hosted') {
      const at = now();
      const recent = (creates.get(remote) ?? []).filter((t) => t > at - SHARED_HTTP_DEFAULTS.HOUR_MS);
      if (recent.length >= createPerHour || st.count() >= maxProjects) {
        creates.set(remote, recent);
        return fail(res, 429, 'rate-limited');
      }
      if (st.nameTaken(parsed.name)) return fail(res, 409, 'name-taken');
      recent.push(at);
      creates.set(remote, recent);
    } else if (st.nameTaken(parsed.name)) {
      return fail(res, 409, 'name-taken');
    }
    let rec;
    try {
      rec = st.create(parsed);
    } catch (err) {
      if (err?.code === 'name-taken') return fail(res, 409, 'name-taken');
      throw err;
    }
    log('shared.create', { remote, projectId: rec.projectId, mode: rec.mode });
    try { onCreate(rec.projectId); } catch { /* 通知失败不影响建项目 */ }
    send(res, 201, { ok: true, projectId: rec.projectId, name: rec.name, mode: rec.mode });
  }

  function lookup(req, res, st, url) {
    const name = url.searchParams.get('name');
    const rec = typeof name === 'string' && name !== '' ? st.byName(name) : null;
    if (!rec) return fail(res, 404, 'no-project');
    send(res, 200, { ok: true, projectId: rec.projectId, name: rec.name, mode: rec.mode });
  }

  async function challenge(req, res, st) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote);
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    if (!isObj(body)) return fail(res, 400, 'bad-request');
    const { projectId, username, deviceId, as } = body;
    // 保留用户名在这里不报格式错：照名单外的用户名回伪盐，之后的握手失败
    if (!isProjectId(projectId) || !isUsernameShape(username) || !isDeviceId(deviceId) || (as !== 'member' && as !== 'creator')) {
      return fail(res, 400, 'bad-request');
    }
    const rec = st.peek(projectId);
    const unavailable = roomUnavailableReason(rec);
    if (unavailable) return fail(res, unavailable === 'relocated' ? 409 : 503, unavailable);
    if (!rec) return fail(res, 404, 'no-project');
    const cred = isReservedUsername(username) ? null : credentialFor(rec, username, as);
    const salt = cred ? cred.salt : fakeSalt(st.serverSecret, projectId, username);
    const nonce = challenges.issue(['join', projectId, username, deviceId, as]);
    send(res, 200, { ok: true, nonce, salt, kdf: { ...rec.kdf }, mode: rec.mode });
  }

  /** `POST shared/verify { protocols }`〔裁〕：见文件头 */
  async function verify(req, res) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote, { withBody: true });
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    const list = isObj(body) ? body.protocols : undefined;
    if (!Array.isArray(list) || list.length === 0 || list.length > 8
      || !list.every((p) => typeof p === 'string' && p.length > 0 && !p.includes(','))
      || !list.some((p) => p.startsWith(AUTH_PREFIX) || p.startsWith(SERVICE_PREFIX))) {
      return fail(res, 400, 'bad-request');
    }
    // 与这次请求同一个来源、同一套请求头，只把子协议换成体里给的：限速、回环信任都与握手一致
    const probe = { method: req.method, url: req.url, socket: req.socket, headers: { ...req.headers, 'sec-websocket-protocol': list.join(', ') } };
    let principal = null;
    try {
      principal = authenticate(probe);
    } catch {
      principal = null;
    }
    if (principal && typeof principal.userId === 'string') return send(res, 200, { ok: true });
    if (!loopback && limiter.blocked(remote)) return tooMany(res, remote, { withBody: true });
    return fail(res, 401, 'unauthorized');
  }

  /**
   * `POST shared/service-challenge { service, deviceId }`：托管方服务握手用的一次性随机数，绑定 `('service', service, deviceId)`。
   * 服务名不在登记表里也照样回一个（不暴露有没有这个服务），之后的握手失败。
   */
  async function serviceChallenge(req, res) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote);
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    if (!isObj(body) || !isServiceName(body.service) || !isDeviceId(body.deviceId)) return fail(res, 400, 'bad-request');
    // 换钥、撤钥在这里生效：有人取挑战就看一眼登记表文件
    try { servicesOf()?.refresh?.({ force: true }); } catch { /* 读不了按原样 */ }
    const nonce = challenges.issue(['service', body.service, body.deviceId]);
    send(res, 200, { ok: true, nonce });
  }

  /**
   * 429 `rate-limited` 带 `Retry-After` 头（冷却还剩的秒数，并在 CORS 里放出这个头）；`withBody` 时回包另带 `retryAfter`。
   * C10a 主会话裁定（2026-09-27）：HTTP 端点被限速回 429 时带这两样，界面照契约第 14 节表 A 写「请 {秒数} 秒后再试」。
   * 邀请码两个端点两样都带；`shared/challenge` 只带头、回包体照 auth 契约原样（AU8 契约测试逐字比对它，改动留给契约修订后再做）。
   */
  function tooMany(res, remote, { withBody = false } = {}) {
    const sec = Math.max(1, Math.ceil(limiter.retryAfterMs?.(remote) / 1000 || 0));
    if (!res.headersSent) {
      res.setHeader('Retry-After', String(sec));
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    }
    if (withBody) return send(res, 429, { ok: false, error: 'rate-limited', retryAfter: sec });
    return fail(res, 429, 'rate-limited');
  }

  /**
   * 邀请码的两个端点（C10a 契约第 5 节）：`POST shared/invite/resolve { code }`、`POST shared/invite/redeem { code, username, deviceId }`。
   *
   * - 未知、已作废、已过期、次数用完一律 404 `invite-invalid`（一个口径，不让人试探邀请码处在什么状态）；
   * - 兑换时 `(username, deviceId)` 在禁入表里回 401 `banned`；
   * - 两种失败都计入第 9 节的口令错误限速（回环来源不计，与挑战一致）；冷却期内回 429（`Retry-After` 头与回包 `retryAfter`）；
   * - 形状不对的邀请码（不是 43 个 base64url 字符）同样回 404 `invite-invalid`、同样计数；
   * - 限定进入：用户名在名单里（或是创建者）才扣次数，不在名单的回包相同、不扣（主会话裁定）；
   * - `resolve` 不扣次数；`redeem` 先核对再扣一次，同一 `userId` 再兑换不重复扣（`invite.mjs` 的 `redeemOn`）；
   * - 自由进入的兑换回项目口令的 `K`（`kdf` 与 `project: { salt, key }`），客户端据此照常握手；限定进入不回 `K`；
   * - 不记录请求体：日志里只有来源、项目号与结果，没有邀请码、用户名。
   */
  async function invite(req, res, st, which) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote, { withBody: true });
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    if (!isObj(body)) return fail(res, 400, 'bad-request');
    if (which === 'redeem' && (!isUsername(body.username) || !isDeviceId(body.deviceId))) return fail(res, 400, 'bad-request');
    const at = now();
    const invalid = () => {
      if (!loopback) limiter.fail(remote);
      log('shared.invite.reject', { remote, route: which, reason: 'invite-invalid' });
      return fail(res, 404, 'invite-invalid');
    };
    // 形状不对的邀请码也按「无效」回，同样计数：猜码的人从回包里分不出是格式错还是没有这个码
    if (!isInviteCode(body.code)) return invalid();
    const rec = typeof st.peekByInviteCode === 'function' ? st.peekByInviteCode(body.code) : st.peekByInviteDigest(inviteDigest(st.serverSecret, body.code));
    if (!rec || !rec.invite) return invalid();
    const unavailable = roomUnavailableReason(rec);
    if (unavailable) return fail(res, unavailable === 'relocated' ? 409 : 503, unavailable);
    const base = { ok: true, projectId: rec.projectId, name: rec.name, mode: rec.mode };
    if (which === 'resolve') {
      if (!inviteActive(rec.invite, at)) return invalid();
      return send(res, 200, base);
    }
    const { username, deviceId } = body;
    const userId = `${username}@${deviceId}`;
    // 先在副本上试一次：无效就不写盘；同一 userId 兑换过（again）也不写
    const trial = redeemOn(structuredClone(rec.invite), userId, at);
    if (trial === 'invalid') return invalid();
    if ((rec.bans ?? []).some((b) => b.username === username && b.deviceId === deviceId)) {
      if (!loopback) limiter.fail(remote);
      log('shared.invite.reject', { remote, route: which, projectId: rec.projectId, reason: 'banned' });
      return fail(res, 401, 'banned');
    }
    // 限定进入：用户名在名单里（或是创建者）才扣次数；不在名单的回包一模一样、不扣（主会话裁定 2026-09-27：
    // 兑换时不核对口令，否则拿到链接的人换个设备名就能耗光次数；回包相同，不泄露名单）
    const listed = rec.mode !== 'restricted' || rec.creator.username === username || (rec.list ?? []).some((e) => e.username === username);
    const counted = trial === 'ok' && listed;
    if (counted) st.update(rec.projectId, (d) => { redeemOn(d.invite, userId, at); });
    log('shared.invite.redeem', { remote, projectId: rec.projectId, counted });
    if (rec.mode === 'free' && rec.project) {
      return send(res, 200, { ...base, kdf: { ...rec.kdf }, project: { salt: rec.project.salt, key: rec.project.key } });
    }
    return send(res, 200, base);
  }

  /**
   * 处理一个请求。`prefix` 是共享端点所在的前缀（独立模式 `''`，挂载模式 `/docservice`）。
   * 路径不是 `<prefix>/shared/…` 的回 false、什么都不动；是的回 true（已经或将要回包）。
   */
  function handle(req, res, prefix = '') {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    const base = `${prefix}/shared/`;
    if (!url.pathname.startsWith(base)) return false;
    const route = url.pathname.slice(base.length);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return true;
    }
    const st = storeOf();
    const run = async () => {
      if (!st) {
        req.resume();
        return fail(res, 503, 'auth-store');
      }
      if (route === 'create') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return create(req, res, st);
      }
      if (route === 'lookup') {
        if (method !== 'GET') return fail(res, 405, 'method');
        return lookup(req, res, st, url);
      }
      if (route === 'challenge') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return challenge(req, res, st);
      }
      if (route === 'verify' && typeof authenticate === 'function') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return verify(req, res);
      }
      if (route === 'service-challenge' && servicesOf()) {
        if (method !== 'POST') return fail(res, 405, 'method');
        return serviceChallenge(req, res);
      }
      if (route === 'invite/resolve' || route === 'invite/redeem') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return invite(req, res, st, route.slice('invite/'.length));
      }
      req.resume();
      return fail(res, 404, 'not-found');
    };
    run().catch((err) => {
      log('shared.http-error', { route, message: String(err?.message ?? err) });
      fail(res, 500, 'internal');
    });
    return true;
  }

  return { handle };
}
