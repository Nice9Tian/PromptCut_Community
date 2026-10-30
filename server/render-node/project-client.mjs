/**
 * 项目快照客户端（M5b，契约 `docs/plan/render-queue-contract.md` J.2；服务端协议见同文 J.1 与
 * `docs/plan/docservice-contract.md` 第 1 节）。
 *
 * 和节点共用同一条 M5a 的 `WsEndpoint`（`createWsEndpoint` 的返回值），在它上面发
 * `project.announce`、`project.snapshot.put`、`project.snapshot.get`，按 `reqId` 配回包。
 * 配对、超时、断线的语义照 C6.4 的 `content-client.mjs`（`manifest-contract.md` 第 2 节）：
 *   - 每个请求带本实例唯一的 `reqId`（`project#<实例号>-<序号>`）；别的 `reqId` 的消息一律不理；
 *   - 同一 `reqId` 回 `error` 就拒绝，错误带 `reason`（`code` 与它相同）与 `detail`；
 *   - 过了 `timeoutMs` 还没回包就拒绝，`code: 'timeout'`，迟到的回包丢弃。取回快照的回包是一串，
 *     每收到一条就重新计时，所以 `timeoutMs` 是「两条回包之间」的上限，不是整次取回的上限；
 *   - 发不出去（未连上）或连接断开时，在途请求立即以 `code: 'disconnected'` 失败，不重放。
 *
 * 上传按「JSON 转义后的 UTF-8 字节数 ≤ 512 KiB」切片：每片原文一定 ≤ 512 KiB（J.1 的上限），
 * 整条消息也一定在文档服务 1 MiB 的单条上限之内。逐片发、逐片等 `project.snapshot.stored`，
 * 最后一片的回包 `complete: true` 才算完成。切出来超过 64 片就不传，`code: 'too-large'`。
 *
 * 取回时按 `index` 拼接，核对分片连续、`count` 一致，再核对 `sha256(全文)` 等于 `end.digest`，最后 `JSON.parse`。
 * 对不上分别是 `bad-reply`、`digest-mismatch`、`bad-json`。
 *
 * 只依赖 Node 内置模块（守门测试 `render-node-deps` D1）；计时器可注入，测试不必真等。
 */
import { createHash, randomUUID } from 'node:crypto';

export const PROJECT_CLIENT_DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  /** 每片的上限，按 JSON 转义后的 UTF-8 字节数算（J.1：每片 ≤ 512 KiB） */
  partBytes: 512 * 1024,
  /** J.1：最多 64 片 */
  maxParts: 64,
});

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 */
function clientError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.reason = extra.reason ?? code;
  if (extra.detail !== undefined) error.detail = extra.detail;
  return error;
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 一个 UTF-16 码元在 JSON 字符串里转义后的 UTF-8 字节数；代理对整体算 4 */
function escapedWidth(text, i) {
  const c = text.charCodeAt(i);
  if (c === 0x22 || c === 0x5c) return [2, 1];
  if (c < 0x20) return [c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6, 1];
  if (c < 0x80) return [1, 1];
  if (c < 0x800) return [2, 1];
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = text.charCodeAt(i + 1);
    return d >= 0xdc00 && d <= 0xdfff ? [4, 2] : [6, 1];
  }
  if (c >= 0xdc00 && c <= 0xdfff) return [6, 1];
  return [3, 1];
}

/** 按「JSON 转义后的 UTF-8 字节数 ≤ limit」切文本，不拆代理对；空文本也回一片 */
function splitText(text, limit) {
  const parts = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length;) {
    const [w, step] = escapedWidth(text, i);
    if (bytes + w > limit && i > start) {
      parts.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += w;
    i += step;
  }
  if (start < text.length || parts.length === 0) parts.push(text.slice(start));
  return parts;
}

/**
 * @typedef {object} ProjectClient
 * @property {(projectId: string, digest: string, session?: string) => Promise<{ projectRev: number, changed: boolean }>} announce
 * @property {(projectId: string, projectRev: number, digest: string, text: string) => Promise<void>} putSnapshot
 * @property {(projectId: string, projectRev: number) => Promise<object | null>} get  没有这份快照回 null
 * @property {() => number} pending  在途请求数（诊断用）
 */

/**
 * @param {import('./ws-transport.mjs').WsEndpoint} endpoint
 * @param {object} [options]
 * @param {number} [options.timeoutMs]  等一条回包的上限，缺省 30 s
 * @param {(fn: () => void, ms: number) => any} [options.setTimeout]
 * @param {(handle: any) => void} [options.clearTimeout]
 * @returns {ProjectClient}
 */
export function createProjectClient(endpoint, {
  timeoutMs = PROJECT_CLIENT_DEFAULTS.timeoutMs,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
} = {}) {
  if (!endpoint || typeof endpoint.send !== 'function' || typeof endpoint.onMessage !== 'function') {
    throw new TypeError('createProjectClient：endpoint 必须有 send 与 onMessage');
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new TypeError('createProjectClient：timeoutMs 必须是正数');
  }

  const instance = randomUUID().slice(0, 8);
  let seq = 0;
  /**
   * reqId → { type, onReply(message) → 'done' | 'more', reject, timer }：
   * `onReply` 返回 'more' 表示还要等下一条（取回快照的分片），计时重新开始。
   */
  const inflight = new Map();

  function settle(reqId) {
    const entry = inflight.get(reqId);
    if (!entry) return null;
    inflight.delete(reqId);
    clearTimer(entry.timer);
    return entry;
  }

  function arm(reqId, entry) {
    const timer = setTimer(() => {
      const e = settle(reqId);
      if (e) e.reject(clientError('timeout', `项目 ${e.type}：${timeoutMs} ms 内没有回包`));
    }, timeoutMs);
    timer?.unref?.();
    entry.timer = timer;
  }

  endpoint.onMessage((message) => {
    const reqId = message?.reqId;
    if (typeof reqId !== 'string' || !inflight.has(reqId)) return;
    const entry = inflight.get(reqId);
    if (message.type === 'error') {
      settle(reqId);
      const reason = typeof message.reason === 'string' ? message.reason : 'error';
      entry.reject(clientError(reason, `项目 ${entry.type} 失败：${reason}`, { reason, detail: message.detail }));
      return;
    }
    let verdict;
    try {
      verdict = entry.onReply(message);
    } catch (err) {
      settle(reqId);
      entry.reject(err);
      return;
    }
    if (verdict === 'more') {
      clearTimer(entry.timer);
      arm(reqId, entry);
      return;
    }
    settle(reqId);
  });

  if (typeof endpoint.onClose === 'function') {
    endpoint.onClose(() => {
      for (const reqId of [...inflight.keys()]) {
        const entry = settle(reqId);
        entry.reject(clientError('disconnected', `项目 ${entry.type}：连接已断开`));
      }
    });
  }

  /**
   * 发一个请求。`onReply(message, resolve)` 处理每条同 `reqId` 的非 error 回包：抛错即拒绝；
   * 返回 'more' 继续等；其余视为完成（此前应已调过 resolve）。
   */
  function request(type, fields, onReply) {
    return new Promise((resolve, reject) => {
      const reqId = `project#${instance}-${++seq}`;
      const message = { type, ...fields, reqId };
      try {
        JSON.stringify(message);
      } catch {
        reject(clientError('bad-message', `项目 ${type}：消息无法序列化`));
        return;
      }
      const entry = { type, reject, timer: null, onReply: (m) => onReply(m, resolve) };
      arm(reqId, entry);
      inflight.set(reqId, entry);
      let sent = false;
      try {
        sent = endpoint.send(message) !== false;
      } catch {
        sent = false;
      }
      // 端点可能在 send 里同步收到回包（测试替身），这时已经 settle 过了
      if (!sent && inflight.has(reqId)) {
        settle(reqId);
        reject(clientError('disconnected', `项目 ${type}：连接未就绪，没有发出`));
      }
    });
  }

  const unexpected = (type, message) => clientError('bad-reply', `项目 ${type} 回了意外的 ${String(message?.type)}`);

  return {
    announce(projectId, digest, session) {
      const fields = { projectId, digest };
      if (session !== undefined && session !== null) fields.session = session;
      return request('project.announce', fields, (m, resolve) => {
        if (m.type !== 'project.announced') throw unexpected('project.announce', m);
        // 项目有真身时（C6.5）文档服务不再发号：`authoritative: true`，`digest` 是真身的摘要，`matches` 是报上去的摘要与它相同
        const out = { projectRev: m.projectRev, changed: m.changed === true };
        if (m.authoritative === true) Object.assign(out, { authoritative: true, digest: m.digest, matches: m.matches === true });
        resolve(out);
      });
    },

    async putSnapshot(projectId, projectRev, digest, text) {
      if (typeof text !== 'string') throw new TypeError('putSnapshot：text 必须是字符串');
      const parts = splitText(text, PROJECT_CLIENT_DEFAULTS.partBytes);
      const count = parts.length;
      if (count > PROJECT_CLIENT_DEFAULTS.maxParts) {
        throw clientError('too-large', `项目快照切出 ${count} 片，超过 ${PROJECT_CLIENT_DEFAULTS.maxParts} 片的上限`);
      }
      let last = null;
      for (let index = 0; index < count; index += 1) {
        last = await request('project.snapshot.put', { projectId, projectRev, digest, index, count, data: parts[index] }, (m, resolve) => {
          if (m.type !== 'project.snapshot.stored') throw unexpected('project.snapshot.put', m);
          resolve(m);
        });
      }
      if (last?.complete !== true) {
        throw clientError('incomplete', `项目快照上传完 ${count} 片，服务端只收到 ${String(last?.received)} 片`);
      }
    },

    /**
     * 取这一版的项目快照,连同「没有时当前是哪一版」(契约 J.15):
     *   有        → `{ project, projectRev }`
     *   没有      → `{ project: null, currentRev }`;`currentRev` 是文档服务回的当前版本(项目有真身、要的又不是当前版本时才有),
     *               否则为 null。
     */
    locate(projectId, projectRev) {
      const parts = [];
      let count = null;
      return request('project.snapshot.get', { projectId, projectRev }, (m, resolve) => {
        if (m.type === 'project.snapshot.part') {
          if (m.missing === true) {
            resolve({ project: null, currentRev: Number.isSafeInteger(m.currentRev) ? m.currentRev : null });
            return 'done';
          }
          if (typeof m.data !== 'string' || !Number.isSafeInteger(m.count) || m.count < 1) {
            throw clientError('bad-reply', '项目快照分片的字段不对');
          }
          if (count === null) count = m.count;
          if (m.count !== count || m.index !== parts.length || parts.length >= count) {
            throw clientError('bad-reply', `项目快照分片乱了：期望第 ${parts.length} 片（共 ${count} 片），收到第 ${String(m.index)} 片（共 ${m.count} 片）`);
          }
          parts.push(m.data);
          return 'more';
        }
        if (m.type === 'project.snapshot.end') {
          if (count === null || parts.length !== count) {
            throw clientError('bad-reply', `项目快照没收齐就结束了：收到 ${parts.length} 片，应有 ${String(count)} 片`);
          }
          const text = parts.join('');
          if (typeof m.digest !== 'string' || sha256(text) !== m.digest) {
            throw clientError('digest-mismatch', '项目快照拼起来的内容与摘要不符');
          }
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            throw clientError('bad-json', '项目快照不是合法的 JSON');
          }
          resolve({ project: json, projectRev });
          return 'done';
        }
        throw unexpected('project.snapshot.get', m);
      });
    },

    /** 取这一版的项目快照；没有回 null（J.2） */
    get(projectId, projectRev) {
      return this.locate(projectId, projectRev).then((found) => found.project);
    },

    pending() {
      return inflight.size;
    },
  };
}
