/**
 * TCP 层代理探针：在节点与文档服务之间插一层，模拟延迟、队头阻塞、半开和断线。不解析 WebSocket。
 * 依据：`docs/plan/render-queue-contract.md` G.8。
 *
 * 跑：
 *   node scripts/probes/render-queue-proxy.mjs --listen 127.0.0.1:8795 --target <host:port>
 *     [--delay-ms 200] [--stall-prob 0.05] [--stall-ms 200..1000] [--close-prob 0.001]
 *     [--stall-after-ms N] [--cut-after-ms N] [--cut-once] [--stdin-control]
 *
 * **这不是 IP 丢包。** TCP 交给应用的是有序字节流：真丢包会被 TCP 重传补上，应用看到的是延迟、抖动或最后超时；
 * 用户态代理若真丢掉收到的字节，会打乱 WebSocket 帧边界，测的就成了数据损坏而不是网络差（RFC 9293、RFC 6455）。
 * 所以本代理所有字节最终都原样按序转发，「受扰」只有两种：按概率把一块扣住一段时间（其后的块排队，队头阻塞），
 * 以及按概率直接关掉这条连接（断线）。报告与判据里说「10% 的块受扰」，不说「10% 丢包」。
 *
 * - --delay-ms：每个数据块晚这么久再转发（两个方向各自计）。
 * - --stall-prob p（旧名 --loss，同义）：每个数据块以概率 p 被扣住一段随机时长（--stall-ms，旧名 --loss-hold-ms，
 *   区间写成 200..1000 或单个数，缺省 200..1000）再发；其后的块排在它后面、保持顺序，模拟 TCP 重传带来的队头阻塞。
 * - --close-prob q：每个数据块以概率 q 让这条连接两头直接断开（模拟断线；断开前已放行的字节照发，没放行的丢弃 ——
 *   与真断线一样，丢的是整条连接，不是连接中间的字节）。打 `conn.cut { id, by: 'close-prob' }`。缺省 0。
 * - --stall-after-ms N：连接建立 N 毫秒后两个方向都停止转发（收到的字节只攒着），但不关连接，模拟半开。
 * - --cut-after-ms N：连接建立 N 毫秒后两头直接断开。
 * - --cut-once：整个代理进程只切一次。和 --cut-after-ms 连用时，第一条「到点时还开着」的连接被切，之后的连接
 *   （例如客户端接续会话时新开的那条）原样转发；到点前自己关掉的连接（如取挑战的短 HTTP 请求）不算那一次。
 *   不给时行为同旧：每条连接到点都切（HT-a 的 W-HT-a 探针 `ht-w-probe.mjs` 用它，接续那一次不会再被切）。
 *   --close-prob 不受它约束（按概率断线是另一回事）。
 * - --stdin-control：从标准输入按行读命令。标准输入关掉不影响转发。
 *   - `cut`：立刻切断此刻开着的全部连接（算一次切断，受 --cut-once 约束：已经切过就只回一行 conn.cut-skip）。
 *     给按需切断用：探针等主机「已认领、还在做」时才切，连接建立的时刻对不上认领的时刻，固定的 --cut-after-ms 定不准。
 *   - `stall`：按需半开（M8 的 E2、C1 第 3 种做法，`docs/plan/m8-plan.md` 第 2.1、2.6 节）：此刻开着的连接两个方向都停止转发
 *     （收到的字节只攒着，不关连接）；之后新来的连接照样接下、连上游，但同样只攒不转 —— 相当于这台机器到对端的路断了，
 *     客户端重连也接续不上。打 `control.stall { open, newlyStalled }`，每条被扣住的连接另打 `conn.stall { id, by: 'stdin' }`。
 *   - `resume`：撤销 `stall`：全部连接恢复转发，攒下的字节按原顺序补发（相当于断网恢复后 TCP 重传补上）；
 *     打 `control.resume { open, resumed, stalledMs }`，每条恢复的连接另打 `conn.resume { id, pendingUp, pendingDown }`。
 *     `--stall-after-ms` 按时刻扣住的连接也一并恢复。已经被对端关掉的连接不受影响。
 *   - `status`：打一行 `control.status { open, stalled, stallActive, cutSpent }`。
 *   - `quit`：关掉全部连接、打汇总行、退出 0（Windows 上父进程发不了真信号，探针要汇总行就写它）。
 *   不认识的命令打 `control.unknown`。
 *
 * 每条连接关闭时往标准输出打一行 JSON 统计（event: conn.close）；Ctrl+C 或 `quit` 结束时打一行汇总（event: summary，
 * 带 `meaning` 字段写明受扰的含义）。
 * 本机测试用 8790～8799 的端口，不要用 5190～5192。
 * 退出码：参数不对 2；监听失败 1；正常结束 0。
 */
import { createServer, connect } from 'node:net';

const USAGE = `用法：node scripts/probes/render-queue-proxy.mjs --listen 127.0.0.1:8795 --target <host:port>
  [--delay-ms 200] [--stall-prob 0.05] [--stall-ms 200..1000] [--close-prob 0.001]
  [--stall-after-ms N] [--cut-after-ms N] [--cut-once] [--stdin-control]
  --stall-prob / --stall-ms 旧名 --loss / --loss-hold-ms。不是 IP 丢包：字节从不丢，只按概率扣住一块（队头阻塞）或按概率断开连接。
  --stdin-control 的命令：cut、stall、resume、status。`;

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const VALUED = new Set(['--listen', '--target', '--delay-ms', '--loss', '--loss-hold-ms', '--stall-prob', '--stall-ms', '--close-prob', '--stall-after-ms', '--cut-after-ms']);
const FLAGS = new Set(['--cut-once', '--stdin-control']);
/** 新名 → 旧名（内部仍按旧名存；两个都给算参数不对） */
const ALIAS = { 'stall-prob': 'loss', 'stall-ms': 'loss-hold-ms' };
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS.has(a)) { args[a.slice(2)] = true; continue; }
  if (!VALUED.has(a)) usage(`不认识的参数：${a}`);
  const v = argv[++i];
  if (v === undefined) usage(`${a} 缺值`);
  const name = ALIAS[a.slice(2)] ?? a.slice(2);
  if (args[name] !== undefined) usage(`${a} 与它的旧名 / 新名重复给了`);
  args[name] = v;
}
if (!args.listen || !args.target) usage(argv.length ? '缺 --listen 或 --target' : undefined);

function hostPort(s, what) {
  const i = s.lastIndexOf(':');
  const host = i > 0 ? s.slice(0, i).replace(/^\[|\]$/g, '') : '127.0.0.1';
  const port = Number(i >= 0 ? s.slice(i + 1) : s);
  if (!Number.isInteger(port) || port < 0 || port > 65535) usage(`${what} 的端口不对：${s}`);
  return { host, port };
}
const num = (name, dflt, { min = 0, max = Infinity } = {}) => {
  if (args[name] === undefined) return dflt;
  const n = Number(args[name]);
  if (!Number.isFinite(n) || n < min || n > max) usage(`--${name} 要是 ${min}～${max} 之间的数`);
  return n;
};

const listen = hostPort(args.listen, '--listen');
const target = hostPort(args.target, '--target');
const delayMs = num('delay-ms', 0);
const loss = num('loss', 0, { max: 1 });
let holdMin = 200;
let holdMax = 1000;
if (args['loss-hold-ms'] !== undefined) {
  const m = /^(\d+)(?:\.\.(\d+))?$/.exec(args['loss-hold-ms']);
  if (!m) usage('--stall-ms（--loss-hold-ms）写成 200..1000 或单个数');
  holdMin = Number(m[1]);
  holdMax = m[2] === undefined ? holdMin : Number(m[2]);
  if (holdMax < holdMin) usage('--stall-ms（--loss-hold-ms）的上界小于下界');
}
const closeProb = num('close-prob', 0, { max: 1 });
/** 写进 listen / summary 行，免得有人把 loss 读成 IP 丢包率 */
const DISTURB_MEANING = '每块按概率 stallProb 扣住 stallMs 再按序转发、按概率 closeProb 断开整条连接；字节从不丢，不是 IP 丢包率';
const stallAfterMs = args['stall-after-ms'] === undefined ? null : num('stall-after-ms', 0);
const cutAfterMs = args['cut-after-ms'] === undefined ? null : num('cut-after-ms', 0);
const cutOnce = args['cut-once'] === true;
const stdinControl = args['stdin-control'] === true;
/** --cut-once：已经切过一次（之后到点的连接不再切） */
let cutSpent = false;

const out = (event, fields) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
const totals = { conns: 0, bytesUp: 0, bytesDown: 0, chunks: 0, held: 0, stalledConns: 0, cutConns: 0, cutSkipped: 0, randomCloses: 0, stallCommands: 0, resumeCommands: 0 };
/** `stall` 命令生效中（新连接也一进来就扣住）：生效的时刻；没生效为 null */
let stalledSince = null;
const live = new Set();
let seq = 0;

/**
 * 单向转发：每块算一个放行时刻 = max(上一块的放行时刻, 现在 + 延迟 + 扣住时长)，按时刻依次写出，
 * 所以顺序永远不变，被扣住的块会把后面的块一起挡住（队头阻塞）。停转后只攒不写。
 */
function pipeWithFaults(from, to, conn, dir) {
  const queue = [];
  let lastRelease = 0;
  let timer = null;
  const flush = () => {
    timer = null;
    if (conn.stalled || to.destroyed) return;
    const now = Date.now();
    while (queue.length && queue[0].at <= now) {
      const { chunk } = queue.shift();
      to.write(chunk);
    }
    if (queue.length) timer = setTimeout(flush, Math.max(0, queue[0].at - now));
  };
  from.on('data', (chunk) => {
    conn[dir === 'up' ? 'bytesUp' : 'bytesDown'] += chunk.length;
    conn.chunks += 1;
    if (closeProb > 0 && Math.random() < closeProb) {
      // 按概率断线：整条连接两头关掉（不是丢这一块）
      conn.cut = true;
      totals.cutConns += 1;
      totals.randomCloses += 1;
      out('conn.cut', { id: conn.id, by: 'close-prob' });
      conn.close('close-prob');
      return;
    }
    let hold = 0;
    if (loss > 0 && Math.random() < loss) {
      hold = holdMin + Math.random() * (holdMax - holdMin);
      conn.held += 1;
    }
    const at = Math.max(lastRelease, Date.now() + delayMs + hold);
    lastRelease = at;
    queue.push({ chunk, at });
    if (!conn.stalled && timer === null) timer = setTimeout(flush, Math.max(0, at - Date.now()));
  });
  return {
    pending: () => queue.length,
    stop: () => { clearTimeout(timer); timer = null; },
    /** 撤销停转：攒下的块按放行时刻补发（已过时刻的立刻发） */
    resume: () => {
      if (timer === null && queue.length && !to.destroyed) timer = setTimeout(flush, Math.max(0, queue[0].at - Date.now()));
    },
  };
}

const server = createServer((client) => {
  const id = ++seq;
  const startedAt = Date.now();
  const conn = { id, bytesUp: 0, bytesDown: 0, chunks: 0, held: 0, stalled: stalledSince !== null, cut: false, close: null, stall: null, resume: null };
  totals.conns += 1;
  const upstream = connect(target.port, target.host);
  const timers = [];
  let closed = false;
  live.add(conn);
  client.on('error', () => {});
  upstream.on('error', () => {});
  const up = pipeWithFaults(client, upstream, conn, 'up');
  const down = pipeWithFaults(upstream, client, conn, 'down');
  out('conn.open', { id, from: `${client.remoteAddress}:${client.remotePort}`, ...(conn.stalled ? { stalled: true } : {}) });
  if (conn.stalled) totals.stalledConns += 1;
  conn.stall = (by) => {
    if (conn.stalled) return false;
    conn.stalled = true;
    totals.stalledConns += 1;
    up.stop();
    down.stop();
    out('conn.stall', { id, by });
    return true;
  };
  conn.resume = () => {
    if (!conn.stalled) return false;
    conn.stalled = false;
    out('conn.resume', { id, pendingUp: up.pending(), pendingDown: down.pending() });
    up.resume();
    down.resume();
    return true;
  };

  const close = (why) => {
    if (closed) return;
    closed = true;
    live.delete(conn);
    for (const t of timers) clearTimeout(t);
    up.stop();
    down.stop();
    client.destroy();
    upstream.destroy();
    totals.bytesUp += conn.bytesUp;
    totals.bytesDown += conn.bytesDown;
    totals.chunks += conn.chunks;
    totals.held += conn.held;
    out('conn.close', {
      id, why, durationMs: Date.now() - startedAt, bytesUp: conn.bytesUp, bytesDown: conn.bytesDown,
      chunks: conn.chunks, held: conn.held, stalled: conn.stalled, cut: conn.cut,
      unsentUp: up.pending(), unsentDown: down.pending(),
    });
  };
  conn.close = close;
  client.on('close', () => close('client-closed'));
  upstream.on('close', () => close('upstream-closed'));

  if (stallAfterMs !== null) {
    timers.push(setTimeout(() => { conn.stall('timer'); }, stallAfterMs));
  }
  if (cutAfterMs !== null) {
    timers.push(setTimeout(() => {
      if (cutOnce && cutSpent) { totals.cutSkipped += 1; out('conn.cut-skip', { id, reason: 'cut-once' }); return; }
      cutSpent = true;
      conn.cut = true;
      totals.cutConns += 1;
      out('conn.cut', { id, by: 'timer' });
      close('cut');
    }, cutAfterMs));
  }
});

server.on('error', (err) => {
  out('listen.error', { message: err.message });
  process.exit(1);
});
server.listen(listen.port, listen.host, () => {
  const a = server.address();
  out('listen', {
    host: a.address, port: a.port, target: `${target.host}:${target.port}`, delayMs,
    stallProb: loss, stallMs: [holdMin, holdMax], closeProb, meaning: DISTURB_MEANING,
    loss, lossHoldMs: [holdMin, holdMax], // 旧字段名，读旧日志的脚本还在用
    stallAfterMs, cutAfterMs, cutOnce, stdinControl,
  });
});

function summary() {
  out('summary', { ...totals, open: live.size, stallProb: loss, closeProb, meaning: DISTURB_MEANING });
}

if (stdinControl) {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const lines = (pending + chunk).split('\n').map((line) => line.replace(/\r$/, ''));
    pending = lines.pop() ?? '';
    for (const raw of lines) {
      const cmd = raw.trim();
      if (!cmd) continue;
      if (cmd === 'stall') {
        if (stalledSince === null) stalledSince = Date.now();
        let n = 0;
        for (const conn of live) if (conn.stall('stdin')) n += 1;
        totals.stallCommands += 1;
        out('control.stall', { open: live.size, newlyStalled: n });
        continue;
      }
      if (cmd === 'resume') {
        const stalledMs = stalledSince === null ? null : Date.now() - stalledSince;
        stalledSince = null;
        let n = 0;
        for (const conn of live) if (conn.resume()) n += 1;
        totals.resumeCommands += 1;
        out('control.resume', { open: live.size, resumed: n, stalledMs });
        continue;
      }
      if (cmd === 'status') {
        out('control.status', { open: live.size, stalled: [...live].filter((c) => c.stalled).length, stallActive: stalledSince !== null, cutSpent });
        continue;
      }
      if (cmd === 'quit') {
        // Windows 上父进程发不了真信号：探针要汇总行就写 quit
        for (const conn of [...live]) conn.close('quit');
        summary();
        server.close();
        process.exitCode = 0;
        setTimeout(() => process.exit(0), 200).unref();
        continue;
      }
      if (cmd !== 'cut') { out('control.unknown', { cmd: cmd.slice(0, 40) }); continue; }
      if (cutOnce && cutSpent) { totals.cutSkipped += 1; out('conn.cut-skip', { reason: 'cut-once', open: live.size }); continue; }
      const victims = [...live];
      if (victims.length === 0) { out('conn.cut-skip', { reason: 'no-connection', open: 0 }); continue; }
      cutSpent = true;
      for (const conn of victims) {
        conn.cut = true;
        totals.cutConns += 1;
        out('conn.cut', { id: conn.id, by: 'stdin' });
        conn.close('cut');
      }
    }
  });
  process.stdin.on('error', () => {});
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    summary();
    server.close();
    process.exit(0);
  });
}
