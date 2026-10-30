#!/usr/bin/env node
/**
 * 最小的 HTTP 出站代理（M8 执行计划裁定 D5：「只能出网的节点」的本机替身）。只用 Node 内置模块。
 *
 * 独立渲染主机以 `NODE_USE_ENV_PROXY=1` 加 `HTTP_PROXY` / `HTTPS_PROXY` 指向它运行时，主机的出站连接都经它走：
 *   - `CONNECT host:port`（隧道）：全局 `fetch`、全局 `WebSocket`（Node 自带的 undici）不论目标是 http 还是 https 都这样走；
 *     `http.request` / `https.request` 走 https 目标时也是这样；
 *   - 绝对地址形式的请求（`GET http://host:port/…`，「转发」）：Node 的 `http.request` 走 **明文 http** 目标时这样走；
 *     带 `Upgrade` 的也照转（「转发升级」）。
 * 真实的云端出网代理只放行 443 的 CONNECT；本替身的目标是明文端口，所以两种都接，照实记下是哪一种。
 *
 * 每条连接记一条：`{ id, kind: 'connect' | 'forward' | 'forward-upgrade', target: 'host:port', up, down, ms, status, error }`，
 * `up` 是客户端发往目标的字节、`down` 是目标回给客户端的字节（隧道按原始字节计；转发按请求体 / 响应体计，不含头）。
 * 不记路径、查询串与请求头（里面可能有票据与会话号）。
 *
 * 作为模块：
 *   const px = await startConnectProxy({ host: '127.0.0.1', port: 0, allow: ['127.0.0.2:*'], log })
 *   px.url / px.port / px.records() / px.summary() / await px.close()
 * 作为命令：
 *   node scripts/probes/m8/connect-proxy.mjs [--listen 127.0.0.1:5798] [--allow <host:port|host:*>,…] [--log <文件>]
 *   - stdout 一行一条 JSON：`listen`、每条连接结束时 `conn.close`、被拒的 `conn.denied`；
 *   - 标准输入写 `status` 打一行 `summary`，写 `quit`（或 SIGINT / SIGTERM；给了 `--quit-on-stdin-end` 时标准输入关闭也算）打 `summary` 后退出；
 *   - `GET http://<代理>/__status`（原始形式、只答回环来源）回 `summary` 的 JSON，给探针跨进程取记录用。
 *   `--allow` 不给就全放行（只记录）；给了就只放行列出的目标，别的回 403 并记 `denied`。
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** `host:port` 规整（IPv6 去方括号再加回，端口缺省按协议） */
export function targetOf(host, port) {
  const h = String(host).replace(/^\[|\]$/g, '');
  return h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
}

/** 解析 CONNECT 的 `host:port`（支持 `[v6]:port`）；不合格回 null */
export function parseAuthority(s) {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(String(s)) ?? /^([^:\s/]+):(\d{1,5})$/.exec(String(s));
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}

/** 放行规则：`host:port` 或 `host:*`；列表为空 / null = 全放行 */
export function allowed(allow, host, port) {
  if (!allow || allow.length === 0) return true;
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return allow.some((rule) => {
    const i = rule.lastIndexOf(':');
    const rh = rule.slice(0, i).replace(/^\[|\]$/g, '').toLowerCase();
    const rp = rule.slice(i + 1);
    return rh === h && (rp === '*' || Number(rp) === Number(port));
  });
}

/** 由记录算汇总：每个目标的连接数、字节、种类 */
export function summarize(records, extra = {}) {
  const byTarget = {};
  for (const r of records) {
    const t = (byTarget[r.target] ??= { conns: 0, open: 0, up: 0, down: 0, kinds: {}, denied: 0, errors: 0 });
    if (r.kind === 'denied') { t.denied++; continue; }
    t.conns++;
    if (r.ms === null) t.open++;
    t.up += r.up;
    t.down += r.down;
    t.kinds[r.kind] = (t.kinds[r.kind] ?? 0) + 1;
    if (r.error) t.errors++;
  }
  const conns = records.filter((r) => r.kind !== 'denied');
  return {
    event: 'summary', conns: conns.length, open: conns.filter((r) => r.ms === null).length,
    denied: records.filter((r) => r.kind === 'denied').length,
    kinds: conns.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {}),
    up: conns.reduce((s, r) => s + r.up, 0), down: conns.reduce((s, r) => s + r.down, 0),
    byTarget, ...extra,
  };
}

/**
 * 起代理。
 * @param {{ host?: string, port?: number, allow?: string[] | null, log?: (line: object) => void, keep?: number }} [o]
 */
export function startConnectProxy({ host = '127.0.0.1', port = 0, allow = null, log = () => {}, keep = 20_000 } = {}) {
  const records = [];
  let seq = 0;
  const started = Date.now();
  const open = new Set();
  const newRec = (kind, target) => {
    const r = { id: ++seq, kind, target, at: Date.now(), up: 0, down: 0, ms: null, status: null, error: null };
    records.push(r);
    while (records.length > keep) records.shift();
    return r;
  };
  const finish = (r, error) => {
    if (r.ms !== null) return;
    r.ms = Date.now() - r.at;
    if (error && !r.error) r.error = String(error.code ?? error.message ?? error).slice(0, 80);
    log({ event: 'conn.close', ...r });
  };
  const deny = (target, reason) => {
    const r = newRec('denied', target);
    r.ms = 0;
    r.error = reason;
    log({ event: 'conn.denied', target, reason });
  };

  const server = http.createServer((req, res) => {
    // 原始形式：代理自己的状态页（只答回环来源）
    if (req.url?.startsWith('/')) {
      if (req.url === '/__status' && LOOPBACK.has(req.socket.remoteAddress ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...summarize(records, { ms: Date.now() - started }), records }));
      } else { res.writeHead(404); res.end(); }
      return;
    }
    // 绝对地址形式：转发
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    if (u.protocol !== 'http:') { res.writeHead(400); res.end(); return; }
    const tport = Number(u.port || 80);
    const target = targetOf(u.hostname, tport);
    if (!allowed(allow, u.hostname, tport)) { deny(target, 'not-allowed'); res.writeHead(403); res.end(); return; }
    const r = newRec('forward', target);
    open.add(req.socket);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const up = http.request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: tport, method: req.method, path: `${u.pathname}${u.search}`, headers }, (ur) => {
      r.status = ur.statusCode ?? null;
      const out = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(ur.statusCode ?? 502, out);
      ur.on('data', (d) => { r.down += d.length; });
      ur.pipe(res);
      ur.on('end', () => finish(r));
      ur.on('error', (e) => finish(r, e));
    });
    req.on('data', (d) => { r.up += d.length; });
    up.on('error', (e) => { finish(r, e); if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); });
    res.on('close', () => { if (r.ms === null) { up.destroy(); finish(r, res.writableFinished ? null : new Error('client-closed')); } });
    req.pipe(up);
  });

  /** 两条 socket 对接、记字节，任一端结束就都结束 */
  const splice = (r, client, upstream, first = null) => {
    open.add(client);
    open.add(upstream);
    if (first?.length) { r.up += first.length; upstream.write(first); }
    client.on('data', (d) => { r.up += d.length; });
    upstream.on('data', (d) => { r.down += d.length; });
    client.pipe(upstream);
    upstream.pipe(client);
    const end = (e) => { client.destroy(); upstream.destroy(); open.delete(client); open.delete(upstream); finish(r, e); };
    client.on('error', end); upstream.on('error', end);
    client.on('close', () => end()); upstream.on('close', () => end());
  };

  server.on('connect', (req, client, head) => {
    const a = parseAuthority(req.url);
    if (!a) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const target = targetOf(a.host, a.port);
    if (!allowed(allow, a.host, a.port)) { deny(target, 'not-allowed'); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const r = newRec('connect', target);
    const upstream = net.connect(a.port, a.host);
    upstream.once('connect', () => {
      r.status = 200;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      splice(r, client, upstream, head);
    });
    upstream.once('error', (e) => {
      if (r.status === null) { r.status = 502; finish(r, e); client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); }
    });
    client.on('error', () => upstream.destroy());
  });

  server.on('upgrade', (req, client, head) => {
    let u;
    try { u = new URL(req.url); } catch { client.destroy(); return; }
    const tport = Number(u.port || 80);
    const target = targetOf(u.hostname, tport);
    if (!allowed(allow, u.hostname, tport)) { deny(target, 'not-allowed'); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const r = newRec('forward-upgrade', target);
    const upstream = net.connect(tport, u.hostname.replace(/^\[|\]$/g, ''));
    upstream.once('connect', () => {
      r.status = 101;
      const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (/^proxy-/i.test(req.rawHeaders[i])) continue;
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      const reqHead = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(reqHead);
      splice(r, client, upstream, head);
    });
    upstream.once('error', (e) => { if (r.status === null) { r.status = 502; finish(r, e); client.destroy(); } });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${p}`;
      log({ event: 'listen', url, host, port: p, allow: allow ?? 'all' });
      resolve({
        url, port: p, host, server,
        records: () => records.map((r) => ({ ...r })),
        summary: () => summarize(records, { ms: Date.now() - started }),
        close: () => new Promise((done) => {
          for (const s of open) s.destroy();
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

/* ================================================================== 命令 */

async function main(argv) {
  const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const listen = String(arg('--listen', '127.0.0.1:0'));
  const i = listen.lastIndexOf(':');
  const host = listen.slice(0, i).replace(/^\[|\]$/g, '') || '127.0.0.1';
  const port = Number(listen.slice(i + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) { process.stderr.write('--listen 形如 127.0.0.1:5798\n'); process.exit(2); }
  const allowRaw = arg('--allow', null);
  const allow = allowRaw ? allowRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const logFile = arg('--log', null);
  const out = (line) => {
    const text = `${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`;
    process.stdout.write(text);
    if (logFile) { try { fs.appendFileSync(logFile, text); } catch { /* 写不了只丢日志 */ } }
  };
  const px = await startConnectProxy({ host, port, allow, log: out });
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    out(px.summary());
    await px.close();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  if (process.platform === 'win32') process.on('SIGBREAK', quit);
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString();
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? '';
    for (const cmd of parts.map((s) => s.trim())) {
      if (cmd === 'status') out(px.summary());
      else if (cmd === 'quit') void quit();
    }
  });
  process.stdin.on('end', () => { if (!process.stdin.isTTY && argv.includes('--quit-on-stdin-end')) void quit(); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
}
