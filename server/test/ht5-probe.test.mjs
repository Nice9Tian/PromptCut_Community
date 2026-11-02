/**
 * HT5: Local hosted bundle + isomorphic nginx routing; `shared-project-probe` member passes
 * completely under "auto" and "force ws" (contract `docs/plan/http-transport-contract.md`
 * section 11 HT5; HT-a runs only these two, forced http belongs to HT-b).
 * Run: node --test server/test/ht5-probe.test.mjs
 *
 * - Hosted bundle: `server/hosted/main.mjs` child process, binding only to 127.0.0.1, port 0, with
 *   `PROMPTCUT_TRUST_LOOPBACK=0` plus cluster token (same as Alibaba Cloud);
 * - Isomorphic routing: start a small reverse proxy in the test, `/hosted/*` → document service
 *   `/*`, `/media/*` → asset service `/*` (forwarding both HTTP and WebSocket upgrades),
 *   registering the asset service public address as `<proxy>/media/api/asset`, isomorphic to
 *   Alibaba Cloud's nginx;
 * - Coordination port is started in this process (`startCoordServer` in `probe-coord.mjs`, port 0);
 *   creator and member each start a probe child process.
 * Force ws: member with `PROMPTCUT_TRANSPORT=ws` and `--transport ws` (assumption H14);
 * `session.fallback` must not appear in the output. Runs only when client and server session layers
 * and the local trust switch are all in place. Written strictly to the contract without looking at
 * the implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SKIP_BOTH, SKIP_TRUST, ROOT } from './ht-kit.mjs';

const SKIP = SKIP_BOTH || SKIP_TRUST;
const MAIN = path.join(ROOT, 'cloud', 'server', 'hosted', 'main.mjs');
const PROBE = path.join(ROOT, 'scripts', 'probes', 'shared-project-probe.mjs');

/** Isomorphic routing: prefix → target port (forwarded after stripping prefix); forwards both HTTP and upgrades */
async function prefixProxy() {
  const routes = new Map();
  const route = (url) => {
    for (const [prefix, port] of routes) {
      if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) return { port, rest: url.slice(prefix.length) || '/' };
    }
    return null;
  };
  const server = http.createServer((req, res) => {
    const r = route(req.url ?? '/');
    if (!r) { res.writeHead(404); res.end(); return; }
    const up = http.request({ host: '127.0.0.1', port: r.port, method: req.method, path: r.rest.startsWith('/') ? r.rest : `/${r.rest}`, headers: { ...req.headers, host: `127.0.0.1:${r.port}` } }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const r = route(req.url ?? '/');
    if (!r) { socket.destroy(); return; }
    const up = net.connect(r.port, '127.0.0.1');
    up.on('error', () => socket.destroy());
    up.on('connect', () => {
      const lines = [`${req.method} ${r.rest.startsWith('/') ? r.rest : `/${r.rest}`} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? `127.0.0.1:${r.port}` : req.rawHeaders[i + 1]}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    socket.on('close', () => up.destroy());
    up.on('close', () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    routes,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function cleanEnv(extra = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('PROMPTCUT_')) delete base[k];
  return { ...base, ...extra };
}

function startMain(t, env) {
  const child = spawn(process.execPath, [MAIN], { env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { try { child.kill(); } catch { /* Already exited */ } });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`main.mjs did not start: ${out.slice(-1500)}`)), 20_000);
    child.stderr.on('data', (d) => { out += d; });
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.includes('"event":"listen"')) continue;
        try {
          const j = JSON.parse(line);
          clearTimeout(timer);
          resolve({ doc: j.docservice.port, asset: j.asset.port });
          return;
        } catch { /* Half line */ }
      }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`main.mjs exited ${code}: ${out.slice(-1500)}`)); });
  });
}

function runProbe(args, env) {
  const child = spawn(process.execPath, [PROBE, ...args], { env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => child.once('exit', (code) => {
    const last = out.trim().split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"ok"'));
    let result = null;
    try { result = last ? JSON.parse(last) : null; } catch { result = null; }
    resolve({ code, out, result });
  }));
}

async function hostedWithRoute(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ht5-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const proxy = await prefixProxy();
  t.after(() => proxy.close());
  const tok = crypto.randomBytes(32).toString('base64url');
  const ports = await startMain(t, {
    PROMPTCUT_DATA_DIR: data,
    PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1',
    PROMPTCUT_DOCSERVICE_PORT: '0',
    PROMPTCUT_ASSET_PORT: '0',
    PROMPTCUT_TRUST_LOOPBACK: '0',
    PROMPTCUT_CLUSTER_TOKEN: tok,
    PROMPTCUT_ASSET_PUBLIC_URL: `http://127.0.0.1:${proxy.port}/media/api/asset`,
    PROMPTCUT_DOCSERVICE_PUBLIC_URL: `ws://127.0.0.1:${proxy.port}/hosted/`,
  });
  proxy.routes.set('/hosted', ports.doc);
  proxy.routes.set('/media', ports.asset);
  const res = await fetch(`http://127.0.0.1:${proxy.port}/hosted/healthz`);
  assert.equal(res.status, 200, 'the same-shape route /hosted/healthz works');
  return { base: `http://127.0.0.1:${proxy.port}/hosted` };
}

async function creatorAndMember(t, hosted, memberEnv, memberArgs) {
  const { startCoordServer } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'probes', 'probe-coord.mjs')).href);
  const coord = await startCoordServer({ port: 0, host: '127.0.0.1' });
  t.after(() => coord.close());
  const common = ['--mode', 'internet', '--hosted', hosted.base, '--coord', coord.url, '--task-ms', '600', '--timeout-ms', '90000'];
  const [creator, member] = await Promise.all([
    runProbe([...common, '--role', 'creator', '--tasks', '6', '--creator-delay-ms', '1500', '--media-kb', '64'], {}),
    runProbe([...common, '--role', 'member', '--expect-tasks', '1', ...memberArgs], memberEnv),
  ]);
  return { creator, member };
}

for (const [label, memberEnv, memberArgs] of [
  ['auto', {}, []],
  ['ws', { PROMPTCUT_TRANSPORT: 'ws' }, ['--transport', 'ws']],
]) {
  test(`HT5-${label} local hosted setup + same-shape nginx routes (trust switch 0): the member of shared-project-probe passes everything in ${label === 'auto' ? 'auto' : 'forced ws'} mode`, { skip: SKIP, timeout: 150_000 }, async (t) => {
    const hosted = await hostedWithRoute(t);
    const { creator, member } = await creatorAndMember(t, hosted, memberEnv, memberArgs);
    assert.equal(member.code, 0, `member exit code 0: ${member.out.slice(-3000)}`);
    assert.equal(member.result?.ok, true, `member ok: ${JSON.stringify(member.result)?.slice(0, 2000)}`);
    assert.ok(member.result.taskDone >= 1, `member completed a task: ${JSON.stringify(member.result)}`);
    assert.equal(member.result.media?.loopbackTrusted, false, 'trust switch is 0: reading an asset over loopback without a ticket is rejected');
    assert.equal(creator.code, 0, `creator exit code 0: ${creator.out.slice(-3000)}`);
    assert.equal(creator.result?.ok, true);
    if (label === 'ws') assert.ok(!member.out.includes('session.fallback'), 'forced ws: no downgrade');
  });
}
