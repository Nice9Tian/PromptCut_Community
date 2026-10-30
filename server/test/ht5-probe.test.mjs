/**
 * HT5：本机托管组合 + 同形 nginx 路由，`shared-project-probe` 的 member 在「自动」与「强制 ws」下全部通过
 * （契约 `docs/plan/http-transport-contract.md` 第 11 节 HT5；HT-a 只跑这两种，强制 http 归 HT-b）。
 * 跑：node --test server/test/ht5-probe.test.mjs
 *
 * - 托管组合：`server/hosted/main.mjs` 子进程，只绑 127.0.0.1、端口 0，`PROMPTCUT_TRUST_LOOPBACK=0` 加集群令牌（同阿里云）；
 * - 同形路由：测试里起一个小反向代理，`/hosted/*` → 文档服务 `/*`、`/media/*` → 素材服务 `/*`（HTTP 与 WebSocket 升级都转），
 *   素材服务公网地址登记成 `<代理>/media/api/asset`，与阿里云的 nginx 同形；
 * - 协调口在本进程里起（`probe-coord.mjs` 的 `startCoordServer`，端口 0）；creator、member 各起一个探针子进程。
 * 强制 ws：member 带 `PROMPTCUT_TRANSPORT=ws` 与 `--transport ws`（假设 H14），输出里不许出现 `session.fallback`。
 * 客户端、服务端会话层与本机信任开关都到位才跑。只照契约写，没看实现。
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

/** 同形路由：前缀 → 目标端口（前缀去掉后转发）；HTTP 与升级都转 */
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
  t.after(() => { try { child.kill(); } catch { /* 已退 */ } });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`main.mjs 没起来：${out.slice(-1500)}`)), 20_000);
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
        } catch { /* 半行 */ }
      }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`main.mjs 退出 ${code}：${out.slice(-1500)}`)); });
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
  assert.equal(res.status, 200, '同形路由 /hosted/healthz 通');
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
  test(`HT5-${label} 本机托管组合 + 同形 nginx 路由（信任开关 0）：shared-project-probe 的 member 在${label === 'auto' ? '自动' : '强制 ws'}下全部通过`, { skip: SKIP, timeout: 150_000 }, async (t) => {
    const hosted = await hostedWithRoute(t);
    const { creator, member } = await creatorAndMember(t, hosted, memberEnv, memberArgs);
    assert.equal(member.code, 0, `member 退出码 0：${member.out.slice(-3000)}`);
    assert.equal(member.result?.ok, true, `member ok：${JSON.stringify(member.result)?.slice(0, 2000)}`);
    assert.ok(member.result.taskDone >= 1, `member 完成了任务：${JSON.stringify(member.result)}`);
    assert.equal(member.result.media?.loopbackTrusted, false, '信任开关为 0：回环不带票据读素材被拒');
    assert.equal(creator.code, 0, `creator 退出码 0：${creator.out.slice(-3000)}`);
    assert.equal(creator.result?.ok, true);
    if (label === 'ws') assert.ok(!member.out.includes('session.fallback'), '强制 ws：没有降级');
  });
}
