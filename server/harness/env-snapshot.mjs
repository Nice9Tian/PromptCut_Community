import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 排查用的「机器现在是什么状态」。
 *
 * # 为什么诊断报告里必须有这一段
 *
 * 之前那份对话诊断只有对话本身。用户报「Agent 看得见别的项目的素材」时,报告里
 * 看得到模型说了什么、调了哪些工具,却看不到**它凭什么这么说** —— 素材库当时是空的吗?
 * 项目存在哪?后端那个会话文件柜里躺着几段历史?这些都没有,于是「是产品的 bug」和
 * 「是这台机器的环境问题」两种可能一条都排除不掉,只能靠猜。
 *
 * 这里补的就是那些「当时的现场」。
 */

/** 单个会话历史文件解析的体积上限:超过就只报大小,不打开 */
const PARSE_LIMIT = 8 * 1024 * 1024;
/** 最多细看几个文件(按新到旧) —— 剩下的只计数 */
const PARSE_COUNT = 20;

/** 会话历史默认存放处,和 runners/api.mjs 里那份必须一致 */
export function sessionStoreDir(tmp = os.tmpdir()) {
  return path.join(tmp, 'promptcut', 'harness-sessions');
}

/**
 * 后端的会话文件柜里有什么。
 *
 * 报的是「有几段、多大、多新、各几条消息」,**不含任何对话内容** ——
 * 判断「界面空着而后端接着旧历史」只需要条数,不需要读那些话。
 */
export function inspectSessionStore(dir = sessionStoreDir(), io = fs) {
  const out = { dir, exists: false, files: 0, totalBytes: 0, recent: [], note: '' };
  let names;
  try {
    names = io.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    out.note = '目录不存在或读不了 —— 说明这台机器上还没有任何 API 直连的会话落过盘';
    return out;
  }
  out.exists = true;
  out.files = names.length;

  const stated = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = io.statSync(full);
      out.totalBytes += st.size;
      stated.push({ name, full, bytes: st.size, modifiedAt: new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs });
    } catch { /* 正被写 / 已被删,跳过 */ }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const f of stated.slice(0, PARSE_COUNT)) {
    const row = { sessionId: f.name.replace(/\.json$/, ''), bytes: f.bytes, modifiedAt: f.modifiedAt, messages: null, roles: null };
    if (f.bytes <= PARSE_LIMIT) {
      try {
        const arr = JSON.parse(io.readFileSync(f.full, 'utf8'));
        if (Array.isArray(arr)) {
          row.messages = arr.length;
          const tally = {};
          for (const m of arr) { const r = String(m?.role || '?'); tally[r] = (tally[r] || 0) + 1; }
          row.roles = tally;
        }
      } catch { row.messages = '(读不出来)'; }
    } else {
      row.messages = '(文件过大,没有打开)';
    }
    out.recent.push(row);
  }
  if (stated.length > PARSE_COUNT) out.note = `只细看了最新的 ${PARSE_COUNT} 个,共 ${stated.length} 个`;
  return out;
}

/** 本地服务这个 Node 进程现在什么样 */
export function nodeStatus(proc = process, o = os) {
  const mem = proc.memoryUsage ? proc.memoryUsage() : {};
  const mb = (n) => (typeof n === 'number' ? Math.round(n / 1048576) : null);
  return {
    version: proc.version,
    v8: proc.versions?.v8,
    pid: proc.pid,
    // 服务是不是刚重启过 —— 「重启就好了」类问题第一眼要看的就是它
    uptimeSeconds: Math.round(proc.uptime ? proc.uptime() : 0),
    startedAt: proc.uptime ? new Date(Date.now() - proc.uptime() * 1000).toISOString() : null,
    execPath: proc.execPath,
    cwd: typeof proc.cwd === 'function' ? proc.cwd() : null,
    memoryMB: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external) },
    tmpdir: o.tmpdir(),
    // 内存快用光时表现得像「模型变笨了」,得看得见
    osMemoryMB: { total: mb(o.totalmem()), free: mb(o.freemem()) },
    cpus: o.cpus ? o.cpus().length : null,
    osRelease: o.release ? o.release() : null,
    // 打包版和源码跑的行为不一样(路径、runtime 位置),先分清是哪一种
    packaged: !!proc.env?.PROMPTCUT_RUNTIME_ROOT || proc.env?.NODE_ENV === 'production',
  };
}
