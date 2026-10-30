/**
 * M8 探针的进程起停（计划 `docs/plan/m8-plan.md` 第 4 节第 1 项）：本机临时托管组合、协调口、桌面编辑器队列节点、
 * 独立渲染主机、TCP 代理。做法取自 `ht-w-probe.mjs`、`c66-t9-probe.mjs`；只结束自己起的进程（进程树）。
 *
 *   startHostedCombo({ dir, docPort = 0, assetPort = 0 })        本机托管组合（只绑 127.0.0.1，信任关，现场生成集群令牌，不打印）
 *   startCoord({ port = 0, host, mailToken })                     协调口（进程内，`probe-coord.mjs` 的 startCoordServer）
 *   startQueueEditor({ port, dir, sharedConfig, fakeFingerprint, lanHost, extraEnv })  编辑器 vite，队列模式
 *   startRenderHost({ port, dir, config, maxConcurrent, fakeFingerprint })             `cloud/scripts/render-host.mjs`（IPC）
 *   startProxy({ listen, target, stallProb, stallMs, closeProb, delayMs, cutOnce })     `render-queue-proxy.mjs --stdin-control`
 *   killTree / exited / portFree / until / collectLines / childEnv / runRole
 *
 * 每个 start* 回的句柄都有 `stop()`（幂等）与 `lines`（收下的输出，最多 8000 行）；起不来抛错（带最后几行输出）。
 * 端口用前先经 `lib.mjs` 的 `checkPorts` 核对（不碰 5190～5192、5203～5205），再逐个 `portFree`。
 * 测试指纹（`PROMPTCUT_TEST_ENV_FINGERPRINT`，16 位小写十六进制）只在 C10 集成分支及其后的代码里生效；
 * 在更早的检出上设了也没用，`fingerprintApplied()` 回假（探针据此判「开关没生效」而不是误判认领结果）。
 */
import '../../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawn, spawnSync, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { checkPorts, FINGERPRINT_RE, lastJsonLine } from './lib.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'probes', 'render-queue-proxy.mjs');
export const RENDER_HOST_SCRIPT = path.join(ROOT, 'cloud', 'scripts', 'render-host.mjs');
export const HOSTED_MAIN = path.join(ROOT, 'cloud', 'server', 'hosted', 'main.mjs');

/* ================================================================== 小工具 */

/** 轮询到 fn 回真值；超时回 null（fn 抛错当作没到） */
export async function until(fn, timeoutMs, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await delay(everyMs);
  }
}

export function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** 结束一个自己起的子进程及其子孙（Windows 用 taskkill /T） */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

/** 等子进程退出；回退出码，超时回 null */
export const exited = (child, ms = 20_000) => new Promise((resolve) => {
  if (!child || child.exitCode !== null) return resolve(child?.exitCode ?? null);
  const t = setTimeout(() => resolve(null), ms);
  child.once('exit', (code) => { clearTimeout(t); resolve(code); });
});

export const portFree = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, host, () => s.close(() => resolve(true)));
});

/** 核对端口合规并且空着（编辑器 / 主机三连号） */
export async function claimPorts(ports, { band = null, triple = true } = {}) {
  const all = checkPorts(ports, { band, triple });
  for (const p of all) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  return all;
}

/** 收子进程的输出：按行存（最多 limit 行），另可逐行回调 */
export function collectLines(child, { limit = 8000, onLine } = {}) {
  const lines = [];
  let partial = '';
  const keep = (c) => {
    const parts = (partial + c.toString()).split(/\r?\n/);
    partial = parts.pop() ?? '';
    for (const line of parts) {
      if (!line) continue;
      lines.push(line);
      if (lines.length > limit) lines.shift();
      try { onLine?.(line); } catch { /* 回调出错不影响收集 */ }
    }
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return lines;
}

async function getJson(url, timeoutMs = 10_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

/** 会从父进程带进来、会让子进程连错地方或带上凭证的环境变量 */
export const SCRUB_ENV = Object.freeze([
  'PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_SHARED_CONFIG',
  'PROMPTCUT_HOST_MAX_CONCURRENT', 'PROMPTCUT_TEST_CODE_VERSION', 'PROMPTCUT_PUSH', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL',
  'PROMPTCUT_LAN_HOST', 'PROMPTCUT_TRANSPORT', 'PROMPTCUT_TEST_ENV_FINGERPRINT', 'PROMPTCUT_HOSTED_URL',
]);

/**
 * 子进程环境：去掉 SCRUB_ENV，数据、导出、临时目录都指到 dir 下（不写公共的 port.json、不碰用户数据目录）。
 * @param {string} dir
 * @param {Record<string, string>} [extra]
 */
export function childEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const key of SCRUB_ENV) delete env[key];
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data')]) fs.mkdirSync(d, { recursive: true });
  return { ...env, PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...extra };
}

/** 测试指纹的环境变量；格式不对抛错（免得静默不生效） */
export function fingerprintEnv(fp) {
  if (fp === null || fp === undefined) return {};
  if (!FINGERPRINT_RE.test(fp)) throw new TypeError(`测试指纹要 16 位小写十六进制：${fp}`);
  return { PROMPTCUT_TEST_ENV_FINGERPRINT: fp };
}

/* ================================================================== 本机托管组合 */

/**
 * 起本机临时托管组合（`server/hosted/main.mjs`）：只绑 127.0.0.1，`PROMPTCUT_TRUST_LOOPBACK=0`（回环按远端对待），
 * 集群令牌现场生成、只进子进程环境、不打印。端口给 0 由系统分配（从 listen 行读实际端口）。
 * @returns {Promise<{ child, lines, docPort, assetPort, hosted: string, ws: string, asset: string, stop: () => Promise<void> }>}
 */
export async function startHostedCombo({ dir, docPort = 0, assetPort = 0, timeoutMs = 30_000 } = {}) {
  const data = path.join(dir, 'hosted-data');
  fs.mkdirSync(data, { recursive: true });
  if (docPort || assetPort) await claimPorts([docPort, assetPort].filter(Boolean), { triple: false });
  const env = { ...process.env };
  for (const key of SCRUB_ENV) delete env[key];
  Object.assign(env, {
    PROMPTCUT_DATA_DIR: data, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: String(docPort), PROMPTCUT_ASSET_PORT: String(assetPort),
    PROMPTCUT_TRUST_LOOPBACK: '0', PROMPTCUT_CLUSTER_TOKEN: randomBytes(32).toString('base64url'),
  });
  const child = spawn(process.execPath, [HOSTED_MAIN], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let listen = null;
  const lines = collectLines(child, { onLine: (l) => { if (l.includes('"event":"listen"')) { try { listen = JSON.parse(l); } catch { /* 半行 */ } } } });
  const ok = await until(() => listen || child.exitCode !== null, timeoutMs, 100);
  if (!ok || !listen) { killTree(child); throw new Error(`托管组合没起来：${lines.slice(-4).join(' | ').slice(0, 600)}`); }
  const dp = listen.docservice.port;
  const ap = listen.asset.port;
  let stopped = false;
  return {
    child, lines, docPort: dp, assetPort: ap,
    hosted: `http://127.0.0.1:${dp}`, ws: `ws://127.0.0.1:${dp}`, asset: `http://127.0.0.1:${ap}/api/asset`,
    async healthz() { return (await getJson(`http://127.0.0.1:${dp}/healthz`)).body; },
    async stop() { if (stopped) return; stopped = true; killTree(child); await exited(child, 10_000); },
  };
}

/* ================================================================== 协调口 */

/**
 * 进程内起协调口（`probe-coord.mjs` 的 startCoordServer）。`mailToken` 给了就开信箱，KV 也要令牌；
 * 调用方把它放进 `process.env.PROBE_MAIL_TOKEN`，子进程随环境继承（不上命令行、不打印）。
 */
export async function startCoord({ port = 0, host = '127.0.0.1', mailToken = null } = {}) {
  if (port) await claimPorts([port], { triple: false });
  const { startCoordServer } = await import('../probe-coord.mjs');
  const c = await startCoordServer({ port, host, ...(mailToken ? { mail: { token: mailToken } } : {}) });
  return { url: c.url, port: c.port, kv: c.kv, stop: () => c.close() };
}

/* ================================================================== 桌面编辑器队列节点 */

/**
 * 起一个编辑器 vite（本检出根），队列模式（`PROMPTCUT_QUEUE_NODE=1`）；预渲染进程是这台机器的桌面队列节点（profile pc）。
 * `sharedConfig` 是共享项目配置文件的路径（以创建者或成员、`role: 'render'` 连项目）；配置在第一次打 `/api/frames/*` 时才读，
 * 可以先起后写。`lanHost` 为真时 `PROMPTCUT_LAN_HOST=1`（绑 0.0.0.0，当放本机的项目的局域网主机）。
 * @returns 句柄：`url`、`prerender()`（预渲染进程地址，等到就绪）、`diagnostics()`、`queue()`、`waitActive(ms)`、`fingerprintApplied()`、`stop()`
 */
export async function startQueueEditor({ port, dir, sharedConfig = null, fakeFingerprint = null, lanHost = false, band = null, extraEnv = {} }) {
  await claimPorts([port], { band });
  const env = childEnv(dir, {
    PROMPTCUT_QUEUE_NODE: '1', ...(sharedConfig ? { PROMPTCUT_SHARED_CONFIG: sharedConfig } : {}),
    ...(lanHost ? { PROMPTCUT_LAN_HOST: '1' } : {}), ...fingerprintEnv(fakeFingerprint), ...extraEnv,
  });
  const args = [viteBin(), '--port', String(port), '--strictPort', ...(lanHost ? [] : ['--host', '127.0.0.1'])];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const lines = collectLines(child);
  const url = `http://127.0.0.1:${port}`;
  let prerenderUrl = null;
  let stopped = false;
  const h = {
    child, lines, url, port,
    async prerender(timeoutMs = 240_000) {
      if (prerenderUrl) return prerenderUrl;
      prerenderUrl = await until(async () => {
        const info = await getJson(`${url}/api/prerender/info`, 3000);
        return info.body?.ready && info.body.url ? info.body.url : null;
      }, timeoutMs, 500);
      if (!prerenderUrl) throw new Error(`编辑器 ${port} 的预渲染进程没就绪：${lines.slice(-4).join(' | ').slice(0, 600)}`);
      return prerenderUrl;
    },
    async diagnostics() { return (await getJson(`${await h.prerender()}/api/frames/diagnostics`, 30_000)).body ?? {}; },
    async queue() { return (await h.diagnostics()).queue ?? null; },
    /** 等本机节点报到（预渲染进程第一次打 /api/frames/* 才建管线、开 Chrome、起节点，机器忙时要几分钟） */
    async waitActive(timeoutMs = 420_000) {
      let last = null;
      const q = await until(async () => { last = await h.queue(); return last?.active === true ? last : null; }, timeoutMs, 1000);
      if (!q) throw new Error(`编辑器 ${port} 的队列节点没报到：${JSON.stringify({ active: last?.active ?? null, connected: last?.connected ?? null }).slice(0, 200)}`);
      return q;
    },
    /** 测试指纹生效了没有（C10 集成之前的检出不认这个开关） */
    async fingerprintApplied() { return !fakeFingerprint || (await h.queue())?.envFingerprint === fakeFingerprint; },
    async stop() {
      if (stopped) return;
      stopped = true;
      killTree(child);
      await exited(child, 20_000);
      try { fs.writeFileSync(path.join(dir, `editor-${port}.log`), lines.join('\n')); } catch { /* 写不了不影响结论 */ }
    },
  };
  return h;
}

/* ================================================================== 独立渲染主机 */

/**
 * 起一个独立渲染主机（`cloud/scripts/render-host.mjs`，IPC），等它的 ready 消息。
 * @param {{ port: number, dir: string, config: string, maxConcurrent?: number, fakeFingerprint?: string | null, readyTimeoutMs?: number, band?: [number, number] | null }} o
 * @returns 句柄：`ready`（ready 消息）、`queue()`（`GET /api/frames/queue`）、`node()`（第一个节点的诊断）、
 *   `shutdown(ms)`（IPC shutdown：放回认领、正常退出，回退出码）、`stop()`（先 shutdown，不行再杀进程树）、`exitLine`
 */
export async function startRenderHost({ port, dir, config, maxConcurrent = 2, fakeFingerprint = null, readyTimeoutMs = 300_000, band = null, verbose = false }) {
  await claimPorts([port], { band });
  const env = { ...process.env };
  for (const key of SCRUB_ENV) delete env[key];
  Object.assign(env, fingerprintEnv(fakeFingerprint));
  const dataDir = path.join(dir, 'render-host-data');
  const child = fork(RENDER_HOST_SCRIPT, ['--config', config, '--port', String(port), '--data', dataDir, '--max-concurrent', String(maxConcurrent), ...(verbose ? ['--verbose'] : [])],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let exitLine = null;
  const lines = collectLines(child, { onLine: (line) => {
    if (line.startsWith('[render-host] exit ')) { try { exitLine = JSON.parse(line.slice('[render-host] exit '.length)); } catch { /* 半行 */ } }
  } });
  const ready = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), readyTimeoutMs);
    child.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(t); resolve(m); } });
    child.once('exit', () => { clearTimeout(t); resolve(null); });
  });
  if (!ready) { killTree(child); await exited(child, 10_000); throw new Error(`渲染主机 ${port} 没起来：${lines.slice(-6).join(' | ').slice(0, 800)}`); }
  const editor = `http://127.0.0.1:${port}`;
  let stopped = false;
  const h = {
    child, lines, port, editor, ready,
    get exitLine() { return exitLine; },
    async queue() { return (await getJson(`${editor}/api/frames/queue`, 10_000)).body; },
    async node() { return (await h.queue())?.nodes?.[0] ?? null; },
    async fingerprintApplied() { return !fakeFingerprint || (await h.queue())?.envFingerprint === fakeFingerprint; },
    async shutdown(ms = 60_000) {
      if (child.exitCode !== null) return child.exitCode;
      try { child.send({ type: 'shutdown' }); } catch { /* IPC 已断 */ }
      return exited(child, ms);
    },
    async stop({ keepData = false } = {}) {
      if (stopped) return exitLine;
      stopped = true;
      const code = await h.shutdown(60_000);
      if (code === null) { killTree(child); await exited(child, 10_000); }
      try { fs.writeFileSync(path.join(dir, `render-host-${port}.log`), lines.join('\n')); } catch { /* 同上 */ }
      if (!keepData) { try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄没放 */ } }
      return exitLine;
    },
  };
  return h;
}

/* ================================================================== 代理 */

/**
 * 起 `render-queue-proxy.mjs --stdin-control`。命令：`cut()`、`stall()`、`resume()`、`status()`；`stop()` 写 quit 收汇总行。
 * 受扰参数（`stallProb`、`stallMs`、`closeProb`）的含义见代理文件头：字节从不丢，不是 IP 丢包率。
 * @param {{ listen: string, target: string, stallProb?: number, stallMs?: string, closeProb?: number, delayMs?: number, cutOnce?: boolean, stallAfterMs?: number, cutAfterMs?: number }} o
 *   `listen` 形如 `127.0.0.1:5733`（端口 0 由系统给号，从 listen 行读）
 */
export async function startProxy({ listen, target, stallProb = 0, stallMs = null, closeProb = 0, delayMs = 0, cutOnce = false, stallAfterMs = null, cutAfterMs = null, dir = null }) {
  const port = Number(String(listen).split(':').pop());
  if (port) await claimPorts([port], { triple: false });
  const args = [PROXY_SCRIPT, '--listen', listen, '--target', target, '--stdin-control'];
  if (stallProb) args.push('--stall-prob', String(stallProb));
  if (stallMs) args.push('--stall-ms', String(stallMs));
  if (closeProb) args.push('--close-prob', String(closeProb));
  if (delayMs) args.push('--delay-ms', String(delayMs));
  if (cutOnce) args.push('--cut-once');
  if (stallAfterMs !== null) args.push('--stall-after-ms', String(stallAfterMs));
  if (cutAfterMs !== null) args.push('--cut-after-ms', String(cutAfterMs));
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const events = [];
  const lines = collectLines(child, { onLine: (l) => { try { events.push(JSON.parse(l)); } catch { /* 不是 JSON */ } } });
  const listening = await until(() => events.find((e) => e.event === 'listen') ?? (child.exitCode !== null ? 'exit' : null), 10_000, 50);
  if (!listening || listening === 'exit') { killTree(child); throw new Error(`代理没起来：${lines.slice(-3).join(' | ')}`); }
  const send = (cmd) => { try { child.stdin.write(`${cmd}\n`); return true; } catch { return false; } };
  const waitEvent = (name, since = 0, ms = 10_000) => until(() => events.slice(since).find((e) => e.event === name) ?? null, ms, 50);
  let stopped = false;
  const h = {
    child, lines, events, port: listening.port, url: `ws://127.0.0.1:${listening.port}`, listen: listening,
    /** 命令发出后等它的回执行 */
    async command(cmd, ack) { const from = events.length; send(cmd); return ack ? waitEvent(ack, from) : null; },
    cut: () => h.command('cut', null),
    stall: () => h.command('stall', 'control.stall'),
    resume: () => h.command('resume', 'control.resume'),
    status: () => h.command('status', 'control.status'),
    count: (name, pred = () => true) => events.filter((e) => e.event === name && pred(e)).length,
    async stop() {
      if (stopped) return events.findLast?.((e) => e.event === 'summary') ?? null;
      stopped = true;
      const from = events.length;
      send('quit');
      const summary = await waitEvent('summary', from, 5000);
      try { child.stdin.end(); } catch { /* 已关 */ }
      if (child.exitCode === null) { await exited(child, 3000); killTree(child); }
      if (dir) { try { fs.writeFileSync(path.join(dir, `proxy-${listening.port}.log`), lines.join('\n')); } catch { /* 同上 */ } }
      return summary;
    },
  };
  return h;
}

/* ================================================================== 角色子进程 */

/**
 * `--role all` 用：以子进程跑本脚本的一个角色，收它 stdout 的最后一行 JSON；stderr 原样转到本进程的 stderr。
 * @returns {Promise<{ role: string, code: number | null, line: object | null }>}
 */
export function runRole(script, role, args, { env = process.env, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, '--role', role, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d.toString(); });
    c.stderr.on('data', (d) => process.stderr.write(d));
    const t = timeoutMs ? setTimeout(() => killTree(c), timeoutMs) : null;
    c.once('exit', (code) => {
      if (t) clearTimeout(t);
      resolve({ role, code, line: lastJsonLine(stdout) });
    });
  });
}
