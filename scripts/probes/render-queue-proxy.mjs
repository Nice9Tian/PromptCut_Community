/**
 * TCP-layer proxy probe: inserts a layer between the node and document service to simulate delay,
 * head-of-line blocking, half-open connections, and disconnection. Does not parse WebSocket.
 * Basis: `docs/plan/render-queue-contract.md` G.8.
 *
 * Run:
 *   node scripts/probes/render-queue-proxy.mjs --listen 127.0.0.1:8795 --target <host:port>
 *     [--delay-ms 200] [--stall-prob 0.05] [--stall-ms 200..1000] [--close-prob 0.001]
 *     [--stall-after-ms N] [--cut-after-ms N] [--cut-once] [--stdin-control]
 *
 * **This is not IP packet loss.** TCP delivers an ordered byte stream to the application: real
 * packet loss is recovered by TCP retransmission, and what the application sees is delay, jitter,
 * or eventually a timeout; if a user-space proxy truly dropped received bytes, it would scramble
 * WebSocket frame boundaries, testing data corruption rather than poor network conditions
 * (RFC 9293, RFC 6455). Therefore, this proxy ultimately forwards all bytes in order as-is;
 * there are only two kinds of "disruption": holding a chunk for a period of time with some
 * probability (subsequent chunks queue behind it, head-of-line blocking), and directly closing
 * this connection with some probability (disconnection). Reports and criteria say "10% of chunks
 * disrupted", not "10% packet loss".
 *
 * - --delay-ms: Forward each data chunk this much later (calculated independently for each
 *   direction).
 * - --stall-prob p (formerly --loss, synonymous): Each data chunk is held with probability p for a
 *   random duration (--stall-ms, formerly --loss-hold-ms, written as an interval 200..1000 or a
 *   single number, default 200..1000) before sending; subsequent chunks queue behind it,
 *   maintaining order to simulate head-of-line blocking caused by TCP retransmission.
 * - --close-prob q: With probability q for each data chunk, directly disconnect both ends of this
 *   connection (simulating disconnection; bytes already released before disconnecting are sent as
 *   usual, unreleased bytes are discarded: just like a real disconnection, what is dropped is the
 *   entire connection, not bytes in the middle of a connection). Logs
 *   `conn.cut { id, by: 'close-prob' }`. Default 0.
 * - --stall-after-ms N: Stop forwarding in both directions N ms after connection establishment
 *   (accumulating received bytes only) without closing the connection, simulating half-open.
 * - --cut-after-ms N: Directly disconnect both ends N ms after connection establishment.
 * - --cut-once: The entire proxy process cuts only once. When used with --cut-after-ms, the first
 *   connection "still open when the timer expires" is cut, and subsequent connections (such as
 *   the new one opened when the client resumes the session) are forwarded as-is; connections
 *   closed by themselves before the timer expires (such as short HTTP requests fetching
 *   challenges) do not count as that cut. When omitted, behavior matches legacy: cut every
 *   connection when its timer expires (used by the HT-a W-HT-a probe `ht-w-probe.mjs`; the
 *   resumed connection will not be cut again). --close-prob is not constrained by it
 *   (probabilistic disconnection is a separate matter).
 * - --stdin-control: Read commands line by line from standard input. Closing standard input does
 *   not affect forwarding.
 *   - `cut`: Immediately cut all currently open connections (counts as one cut, constrained by
 *     --cut-once: if already cut, only emit a single conn.cut-skip line).
 *     Used for on-demand cuts: the probe waits until the host is "claimed, still in progress"
 *     before cutting; connection establishment timing does not match claim timing, so a fixed
 *     --cut-after-ms cannot be timed accurately.
 *   - `stall`: On-demand half-open (the third approach of M8 E2 and C1, `docs/plan/m8-plan.md`
 *     Sections 2.1 and 2.6): stop forwarding in both directions on currently open connections
 *     (accumulating received bytes only, without closing connections); subsequent new incoming
 *     connections are accepted and connected upstream as usual, but likewise only accumulate
 *     without forwarding: equivalent to the path from this machine to the peer being broken, so
 *     client reconnects cannot resume either. Logs `control.stall { open, newlyStalled }`; each
 *     held connection additionally logs `conn.stall { id, by: 'stdin' }`.
 *   - `resume`: Undo `stall`: all connections resume forwarding, and accumulated bytes are resent
 *     in their original order (equivalent to TCP retransmission catching up after network
 *     recovery); logs `control.resume { open, resumed, stalledMs }`; each resumed connection
 *     additionally logs `conn.resume { id, pendingUp, pendingDown }`. Connections held by
 *     timing via `--stall-after-ms` are also resumed together. Connections already closed by the
 *     peer are unaffected.
 *   - `status`: Logs a line `control.status { open, stalled, stallActive, cutSpent }`.
 *   - `quit`: Close all connections, log the summary line, and exit with 0 (on Windows, the parent
 *     process cannot send real signals; write this when the probe needs a summary line).
 *   Unrecognized commands log `control.unknown`.
 *
 * When each connection closes, log a JSON statistics line to standard output (event: conn.close);
 * upon termination via Ctrl+C or `quit`, log a summary line (event: summary, with a `meaning`
 * field explaining the meaning of disruption).
 * For local testing, use ports 8790-8799; do not use 5190-5192.
 * Exit codes: invalid arguments 2; listen failure 1; normal termination 0.
 */
import { createServer, connect } from 'node:net';

const USAGE = `Usage: node scripts/probes/render-queue-proxy.mjs --listen 127.0.0.1:8795 --target <host:port>
  [--delay-ms 200] [--stall-prob 0.05] [--stall-ms 200..1000] [--close-prob 0.001]
  [--stall-after-ms N] [--cut-after-ms N] [--cut-once] [--stdin-control]
  --stall-prob / --stall-ms (old names: --loss / --loss-hold-ms). This is not IP packet loss: bytes are never dropped; with a given probability a chunk is held back (head-of-line blocking) or the connection is closed.
  Commands for --stdin-control: cut, stall, resume, status.`;

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const VALUED = new Set(['--listen', '--target', '--delay-ms', '--loss', '--loss-hold-ms', '--stall-prob', '--stall-ms', '--close-prob', '--stall-after-ms', '--cut-after-ms']);
const FLAGS = new Set(['--cut-once', '--stdin-control']);
/** New name → legacy name (stored internally under legacy name; providing both counts as invalid arguments) */
const ALIAS = { 'stall-prob': 'loss', 'stall-ms': 'loss-hold-ms' };
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS.has(a)) { args[a.slice(2)] = true; continue; }
  if (!VALUED.has(a)) usage(`Unknown argument: ${a}`);
  const v = argv[++i];
  if (v === undefined) usage(`${a} is missing a value`);
  const name = ALIAS[a.slice(2)] ?? a.slice(2);
  if (args[name] !== undefined) usage(`${a} was given together with its old / new name`);
  args[name] = v;
}
if (!args.listen || !args.target) usage(argv.length ? 'Missing --listen or --target' : undefined);

function hostPort(s, what) {
  const i = s.lastIndexOf(':');
  const host = i > 0 ? s.slice(0, i).replace(/^\[|\]$/g, '') : '127.0.0.1';
  const port = Number(i >= 0 ? s.slice(i + 1) : s);
  if (!Number.isInteger(port) || port < 0 || port > 65535) usage(`Invalid port for ${what}: ${s}`);
  return { host, port };
}
const num = (name, dflt, { min = 0, max = Infinity } = {}) => {
  if (args[name] === undefined) return dflt;
  const n = Number(args[name]);
  if (!Number.isFinite(n) || n < min || n > max) usage(`--${name} must be a number between ${min} and ${max}`);
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
  if (!m) usage('--stall-ms (--loss-hold-ms) must be written as 200..1000 or a single number');
  holdMin = Number(m[1]);
  holdMax = m[2] === undefined ? holdMin : Number(m[2]);
  if (holdMax < holdMin) usage('The upper bound of --stall-ms (--loss-hold-ms) is below the lower bound');
}
const closeProb = num('close-prob', 0, { max: 1 });
/** Written into listen / summary lines to prevent interpreting loss as IP packet loss rate */
const DISTURB_MEANING = 'Each chunk is held back for stallMs with probability stallProb and then forwarded in order, and the whole connection is closed with probability closeProb; bytes are never dropped, so this is not an IP packet loss rate';
const stallAfterMs = args['stall-after-ms'] === undefined ? null : num('stall-after-ms', 0);
const cutAfterMs = args['cut-after-ms'] === undefined ? null : num('cut-after-ms', 0);
const cutOnce = args['cut-once'] === true;
const stdinControl = args['stdin-control'] === true;
/** --cut-once: Already cut once (connections reaching the time afterwards are no longer cut) */
let cutSpent = false;

const out = (event, fields) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
const totals = { conns: 0, bytesUp: 0, bytesDown: 0, chunks: 0, held: 0, stalledConns: 0, cutConns: 0, cutSkipped: 0, randomCloses: 0, stallCommands: 0, resumeCommands: 0 };
/** `stall` command active (new connections held on arrival): activation timestamp; null if not active */
let stalledSince = null;
const live = new Set();
let seq = 0;

/**
 * Unidirectional forwarding: each chunk calculates a release time = max(previous chunk's release
 * time, now + delay + hold duration) and writes out sequentially by time, so order never changes;
 * held chunks block subsequent chunks (head-of-line blocking). After stall, only accumulates
 * without writing.
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
      // Probabilistic disconnect: close both ends of the entire connection (not dropping this chunk)
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
    /** Undo stall: accumulated chunks are sent according to release times (expired times sent immediately) */
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
    loss, lossHoldMs: [holdMin, holdMax], // Legacy field name, still used by scripts reading older logs
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
        // On Windows, parent process cannot send real signals: probe writes quit when it needs summary line
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
