/**
 * 节点端点的会话诊断与会话日志的节流（`docs/archive/agent-reports/AGENT-host-diag.md`；契约 `docs/plan/http-transport-contract.md`
 * 第 8、9 节）。
 *
 * 队列节点（桌面预渲染进程里的本机节点、独立渲染主机）到文档服务的连接是 `createDocEndpoint` 的会话（`session-link.mjs`）。
 * 混沌测试（断网、服务端重启、代理丢包、传输中断后会话接续）要从诊断里判「接续了几次、丢了几次、是否重建会话」，
 * 所以：
 *   - `sessionCountersOf(endpoint)`：从 `stats()` 取会话计数，给 `/api/frames/queue` 每个节点的 `session` 字段；
 *   - `createLogThrottle()`：会话事件日志的节流，同一种事件一个窗口里只打头几条，其余计数，下一条打出时带上
 *     `suppressed`（断网期间每次退避都有一条 `session.connect-failed` / `session.retry`，不能刷屏）；
 *   - `SESSION_FORWARD_EVENTS`：进日志的会话事件。
 *
 * 只给计数、关闭码与关闭原因，不给会话号、地址里的查询串与任何凭证（`session-link.mjs` 的日志本来就不含这些）。
 */

/** 进预渲染进程日志（并由编辑器进程转出）的会话事件 */
export const SESSION_FORWARD_EVENTS = Object.freeze(new Set([
  'session.open',
  'session.close',
  'session.detach',
  'session.resume',
  'session.lost',
  'session.expired',
  'session.connect-failed',
  'session.resume-failed',
  'session.backpressure',
  'session.bad-seq',
  'session.bad-ack',
]));

const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * 端点的会话计数（`createDocEndpoint().stats()`；旧端点没有的项给 0 / null）。
 *   opens 建成的会话数（含重建）、resumes 接续、detaches 脱开、renews 重建（前一个会话结束后又建的）、
 *   lost 接续被拒（会话在服务端已没了）、expired 本端判出保留期满、connectFails 建新会话没成、closes 会话结束、
 *   dropped 丢弃的出站消息、lastClose `{ code, reason, at }`、lastDetach `{ code, at }`。
 * 没有 `stats()` 回 null。
 */
export function sessionCountersOf(endpoint) {
  const st = typeof endpoint?.stats === 'function' ? endpoint.stats() : null;
  if (!st) return null;
  const lastClose = st.lastClose && typeof st.lastClose === 'object'
    ? { code: num(st.lastClose.code), reason: String(st.lastClose.reason ?? '').slice(0, 120), at: num(st.lastClose.at) || null }
    : null;
  const lastDetach = st.lastDetach && typeof st.lastDetach === 'object'
    ? { code: num(st.lastDetach.code), at: num(st.lastDetach.at) || null }
    : null;
  return {
    opens: num(st.opens),
    resumes: num(st.resumes),
    detaches: num(st.detaches),
    renews: num(st.renews),
    lost: num(st.lost),
    expired: num(st.expired),
    connectFails: num(st.connectFails),
    closes: num(st.closes),
    dropped: num(st.dropped),
    detached: st.detached === true,
    lastClose,
    lastDetach,
  };
}

/**
 * 节点诊断里的会话部分：`transport`（脱开时 null）、`resumes`、`legacy`（HT-a 起就有，探针在读）加 `session`（上面的计数）。
 */
export function sessionDiagOf(endpoint) {
  const st = typeof endpoint?.stats === 'function' ? endpoint.stats() : null;
  if (!st) return {};
  return { transport: st.transport ?? null, resumes: num(st.resumes), legacy: st.legacy === true, session: sessionCountersOf(endpoint) };
}

/**
 * 日志节流：每个键在 `windowMs` 里最多放 `burst` 条。`take(key)` 回 `null`（这条不打）或 `{ suppressed }`
 * （打，`suppressed` 是这个键上一次打出之后被压下的条数）。窗口按键各自从第一条算起。
 */
export function createLogThrottle({ burst = 5, windowMs = 60_000, now = Date.now } = {}) {
  const keys = new Map();
  return {
    take(key) {
      const t = now();
      let k = keys.get(key);
      if (!k || t - k.start >= windowMs) {
        const suppressed = k ? k.suppressed : 0;
        k = { start: t, count: 0, suppressed: 0 };
        keys.set(key, k);
        k.count = 1;
        return { suppressed };
      }
      if (k.count < burst) {
        k.count++;
        const suppressed = k.suppressed;
        k.suppressed = 0;
        return { suppressed };
      }
      k.suppressed++;
      return null;
    },
    /** 各键此刻被压下、还没随下一条带出去的条数 */
    pending() {
      const out = {};
      for (const [key, k] of keys) if (k.suppressed > 0) out[key] = k.suppressed;
      return out;
    },
  };
}

/**
 * 给 `createDocEndpoint({ log })` 用的会话日志：只打 `SESSION_FORWARD_EVENTS` 里的事件，按事件节流，
 * 打到 `write(event, fields)`（带 `extra` 字段；被压下过的带 `suppressed`）。
 */
export function sessionLogger(write, { extra = {}, throttle = createLogThrottle(), events = SESSION_FORWARD_EVENTS } = {}) {
  return (event, fields = {}) => {
    if (!events.has(event)) return;
    const got = throttle.take(event);
    if (!got) return;
    write(event, { ...extra, ...fields, ...(got.suppressed > 0 ? { suppressed: got.suppressed } : {}) });
  };
}

/** 预渲染进程输出里的会话事件行:`[queue-node] docservice.session.<事件> {…}` 或 `[artifact-push] docservice.session.<事件> {…}` */
export const SESSION_LINE_RE = /^\[(?:queue-node|artifact-push)\] docservice\.(session\.[a-z-]+)\b/;

/**
 * 预渲染进程输出里的逐任务收尾行(`docs/archive/agent-reports/AGENT-stall-phases.md`):`[queue-node] node.task-<lost|failed|superseded|discarded|completed|dedup> {…}`
 * 与产物库没收全的 `[queue-node] sink.incomplete {…}`(`vite-plugin-frames.ts` 的 `taskEventLog`、`artifact-transfer.mjs` 的 `put`),
 * 以及产物库去重那一步的 `sink.has-miss`(为什么没走去重)/ `sink.has-pushed` / `sink.has-push-failed`、内容库清单读写出错的
 * `manifest.get-failed` / `manifest.put-failed`(`artifact-transfer.mjs` 的 `has`、`writeManifest`;`docs/archive/agent-reports/AGENT-xnode-dedup.md`)。
 * 另有队列细任务渲一段的分段耗时 `executor.render-timing`(`prerender-executor.mjs`;`docs/archive/agent-reports/AGENT-uc-latency.md`)。
 * 这些行只带任务 id、原因、阶段与毫秒数,不带会话号与凭证。
 */
export const TASK_LINE_RE = /^\[queue-node\] (node\.task-(?:lost|failed|superseded|discarded|completed|dedup)|sink\.(?:incomplete|has-miss|has-pushed|has-push-failed)|manifest\.(?:get|put)-failed|executor\.render-timing)\b/;

/**
 * 自动渲染节点的起停行(`docs/archive/agent-reports/AGENT-desktop-auto-node.md`):`[queue-node] render-node.<事件> {…}`(交接、起停、补推、等页面)、节点没起来的原因 `[queue-node] queue.skip {…}`
 * 与推送队列的建队 / 跳过 / 选定素材服务 `[artifact-push] push.(started|skip|asset-base) {…}`。安装版的用户只交得出编辑器进程的日志,
 * 「这台桌面有没有成为渲染节点、推到了哪台素材服务」要在那里看得到。行里只有文档服务 / 素材服务的地址与项目 id,不带票据。
 */
export const AUTO_NODE_LINE_RE = /^\[(?:queue-node\] (render-node\.[a-z-]+|queue\.skip)|artifact-push\] (push\.(?:started|skip|asset-base|asset-ready|scope|out-of-scope|rescope)))\b/;

/**
 * 按行转发子进程输出里的会话事件行(编辑器进程收预渲染进程的 stdout / stderr 用)。块可能在行中间断开,
 * 不完整的尾巴留到下一块;单行超过 `maxLine` 字符截断。源头(预渲染进程)已按事件节流,这里再兜一层:
 * 每种事件每个窗口最多 `burst` 行,压下的条数随下一行带出(行尾 ` (suppressed N)`)。
 * 逐任务收尾行(`TASK_LINE_RE`)另走 `taskThrottle`(每种每分钟 60 行):一轮几十个任务,不该被会话事件的额度压掉。
 * 回 `(chunk) => void`。
 */
export function createSessionLineForwarder(write, {
  throttle = createLogThrottle({ burst: 10, windowMs: 60_000 }), maxLine = 2000, re = SESSION_LINE_RE,
  taskRe = TASK_LINE_RE, taskThrottle = createLogThrottle({ burst: 60, windowMs: 60_000 }), autoRe = AUTO_NODE_LINE_RE,
} = {}) {
  let tail = '';
  return (chunk) => {
    const text = tail + String(chunk);
    const lines = text.split(/\r?\n/);
    tail = lines.pop() ?? '';
    if (tail.length > maxLine * 4) tail = '';
    for (const raw of lines) {
      const m = re.exec(raw);
      const t = m ? null : (taskRe ? taskRe.exec(raw) : null);
      const a = m || t || !autoRe ? null : autoRe.exec(raw);
      if (!m && !t && !a) continue;
      const got = m ? throttle.take(m[1]) : t ? taskThrottle.take(t[1]) : taskThrottle.take(a[1] ?? a[2]);
      if (!got) continue;
      const line = raw.length > maxLine ? `${raw.slice(0, maxLine)}…` : raw;
      write(got.suppressed > 0 ? `${line} (suppressed ${got.suppressed})` : line);
    }
  };
}

/**
 * 独立渲染主机(`cloud/scripts/render-host.mjs`)的会话状态行:从 `/api/frames/queue` 的结果取每个节点的会话部分。
 * 回 `{ key, status }`:`status` 是 `[render-host] session {…}` 这一行的内容(`nodes: [{ projectId, nodeId, connected,
 * transport, session }]`),`key` 只由计数与最后关闭码组成 —— 计数变了才换,主机据此只在有变化时打一行。
 */
export function sessionStatusOf(summary) {
  const nodes = Array.isArray(summary?.nodes) ? summary.nodes : [];
  const status = {
    nodes: nodes.map((n) => ({
      projectId: n?.projectId ?? null,
      nodeId: n?.nodeId ?? null,
      connected: n?.connected === true,
      transport: n?.transport ?? null,
      session: n?.session ?? null,
    })),
  };
  const key = JSON.stringify(status.nodes.map((n) => {
    const s = n.session;
    return s ? [n.projectId, s.opens, s.resumes, s.detaches, s.renews, s.lost, s.expired, s.connectFails, s.closes, s.dropped, s.detached, s.lastClose?.code ?? null]
      : [n.projectId, null];
  }));
  return { key, status };
}
