/**
 * 文档服务握手的旧入口（M5a，`docs/plan/render-queue-contract.md` G.5），M6a 起只剩集群令牌的管理身份。
 *
 * 数据面的鉴权在 `../auth/handshake.mjs`（`docs/plan/auth-contract.md` 第 5 节）：证明、连接票据、本机声明、
 * 回环本机身份。集群令牌从数据面彻底退出，只守管理接口：带对令牌的连接是管理身份
 * `{ userId: 'admin', tenantId: null, scope: 'admin' }`，发数据面消息回 `forbidden`（组装层的放行判断）。
 *
 * `createClusterAuth` 保留给只有令牌、没有凭证存储的场合（测试、只开管理接口的进程）：
 * - 设了令牌：`promptcut.v1` 加 `promptcut.token.<令牌>` → 管理身份；别的一律拒；
 * - 没设令牌、`allowAnonymous`：一律匿名 `{ userId: 'anonymous', tenantId: null }`（旧客户端、本机开发）。
 * 令牌原文不进任何日志、错误信息、诊断输出：比对前两边各取 sha256，再定长比较。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { PROTOCOL, TOKEN_PREFIX } from '../auth/protocol.mjs';
import { offeredProtocols, checkTokenFormat, ADMIN_PRINCIPAL } from '../auth/handshake.mjs';

export { PROTOCOL, offeredProtocols, checkTokenFormat };

const ANONYMOUS = Object.freeze({ userId: 'anonymous', tenantId: null });

/** 回环地址：只绑这些地址时算本机 */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

const digest = (text) => createHash('sha256').update(text, 'utf8').digest();

/**
 * @param {object} options
 * @param {string} [options.token] 集群令牌；设了就是令牌模式
 * @param {boolean} [options.allowAnonymous] 没设令牌时是否放行匿名连接；不放行就全部拒绝
 * @param {(event: string, fields: object) => void} [options.log] 握手被拒时记 `auth.reject { remote, reason }`
 */
export function createClusterAuth({ token, allowAnonymous = false, log = () => {} } = {}) {
  const tokenMode = token !== undefined && token !== null;
  if (tokenMode && !checkTokenFormat(token)) throw new TypeError('createClusterAuth: 集群令牌格式不对（要 32～256 个 base64url 字符）');
  const expected = tokenMode ? digest(token) : null;

  function reject(req, reason) {
    log('auth.reject', { remote: req?.socket?.remoteAddress ?? null, reason });
    return null;
  }

  return {
    /** 返回 principal；null 表示拒绝（握手回 401） */
    authenticate(req) {
      if (!tokenMode) return allowAnonymous ? { ...ANONYMOUS } : reject(req, 'no-credential');
      const offered = offeredProtocols(req);
      if (!offered.includes(PROTOCOL)) return reject(req, 'bad-format');
      const given = offered.filter((p) => p.startsWith(TOKEN_PREFIX));
      if (given.length === 0) return reject(req, 'no-credential');
      // 给了多个令牌项不猜哪个是真的
      if (given.length !== 1) return reject(req, 'multiple');
      const ok = timingSafeEqual(digest(given[0].slice(TOKEN_PREFIX.length)), expected);
      return ok ? { ...ADMIN_PRINCIPAL } : reject(req, 'bad-proof');
    },

    /** 握手成功时要回显的子协议；客户端没给 `promptcut.v1` 就不回 */
    protocolFor(req) {
      return offeredProtocols(req).includes(PROTOCOL) ? PROTOCOL : null;
    },
  };
}
