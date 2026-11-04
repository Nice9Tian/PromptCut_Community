#!/usr/bin/env node
/**
 * Minimal HTTP outbound proxy (M8 execution plan ruling D5: local stand-in for "egress-only node").
 * Uses Node built-in modules only.
 *
 * When a standalone render host runs with `NODE_USE_ENV_PROXY=1` plus `HTTP_PROXY` / `HTTPS_PROXY`
 * pointing to it, all outbound host connections go through it:
 *   - `CONNECT host:port` (tunnel): global `fetch`, global `WebSocket` (Node's built-in undici) go
 *     this way regardless of whether target is http or https; `http.request` / `https.request` also
 *     go this way for https targets;
 *   - Requests in absolute URI form (`GET http://host:port/…`, "forward"): Node's `http.request` goes
 *     this way for **plaintext http** targets; those with `Upgrade` are also forwarded ("forward-upgrade").
 * Real cloud egress proxies only allow CONNECT on 443; this stand-in targets plaintext ports, so it
 * accepts both, recording faithfully which type it was.
 *
 * One record per connection: `{ id, kind: 'connect' | 'forward' | 'forward-upgrade', target: 'host:port', up, down, ms, status, error }`,
 * where `up` is bytes sent from client to target, and `down` is bytes returned from target to
 * client (tunnel counts raw bytes; forward counts request/response body, excluding headers).
 * Does not record path, query string, or request headers (which may contain tickets and session ids).
 *
 * As a module:
 *   const px = await startConnectProxy({ host: '127.0.0.1', port: 0, allow: ['127.0.0.2:*'], log })
 *   px.url / px.port / px.records() / px.summary() / await px.close()
 * As a command:
 *   node scripts/probes/m8/connect-proxy.mjs [--listen 127.0.0.1:5798] [--allow <host:port|host:*>,…] [--log <file>]
 *   - stdout outputs one JSON per line: `listen`, `conn.close` when each connection ends, `conn.denied` for rejected connections;
 *   - Write `status` to stdin to print one `summary` line; write `quit` (or SIGINT / SIGTERM; closing stdin also counts when `--quit-on-stdin-end` is provided) to print `summary` and exit;
 *   - `GET http://<proxy>/__status` (raw form, answers loopback origin only) returns `summary` JSON for probe to retrieve records across processes.
 *   If `--allow` is omitted, all are allowed (record only); if provided, only listed targets are allowed, returning 403 and recording `denied` for others.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Normalize `host:port` (strip square brackets from IPv6 and add back; port defaults by protocol) */
export function targetOf(host, port) {
  const h = String(host).replace(/^\[|\]$/g, '');
  return h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
}

/** Parse CONNECT `host:port` (supports `[v6]:port`); returns null if invalid */
export function parseAuthority(s) {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(String(s)) ?? /^([^:\s/]+):(\d{1,5})$/.exec(String(s));
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}

/** Allow rules: `host:port` or `host:*`; empty list / null = allow all */
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

/** Compute summary from records: connection count, bytes, and kinds for each target */
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
 * Start the proxy.
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
    // Raw form: proxy's own status page (answers loopback origin only)
    if (req.url?.startsWith('/')) {
      if (req.url === '/__status' && LOOPBACK.has(req.socket.remoteAddress ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...summarize(records, { ms: Date.now() - started }), records }));
      } else { res.writeHead(404); res.end(); }
      return;
    }
    // Absolute URI form: forward
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

  /** Bridge two sockets, count bytes; ends whenever either end terminates */
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

/* ================================================================== Command */

async function main(argv) {
  const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const listen = String(arg('--listen', '127.0.0.1:0'));
  const i = listen.lastIndexOf(':');
  const host = listen.slice(0, i).replace(/^\[|\]$/g, '') || '127.0.0.1';
  const port = Number(listen.slice(i + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) { process.stderr.write('--listen looks like 127.0.0.1:5798\n'); process.exit(2); }
  const allowRaw = arg('--allow', null);
  const allow = allowRaw ? allowRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const logFile = arg('--log', null);
  const out = (line) => {
    const text = `${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`;
    process.stdout.write(text);
    if (logFile) { try { fs.appendFileSync(logFile, text); } catch { /* If unable to write, just drop the log */ } }
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
