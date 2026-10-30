/** Isolated pre-change capability audit. No real projects or credentials are read. */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { wsClient } from '../../server/test/fake-ws-kit.mjs';
import { DEFAULT_HOSTED_URL } from '../../server/auth/hosted-default.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-capabilities-'));
const results = [];
const password = randomBytes(24).toString('base64url');
const creatorPassword = randomBytes(24).toString('base64url');
const token = randomBytes(32).toString('base64url');
let child;
async function start() {
  child = spawn(process.execPath, ['cloud/server/hosted/main.mjs'], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, PROMPTCUT_DATA_DIR: dir, PROMPTCUT_EXPORT_DIR: path.join(dir, 'export'),
      PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0',
      PROMPTCUT_TRUST_LOOPBACK: '0', PROMPTCUT_CLUSTER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(() => reject(new Error('test service start timeout')), 15000);
    child.stdout.on('data', d => {
      buf += d;
      for (;;) {
        const i = buf.indexOf('\n'); if (i < 0) break;
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const j = JSON.parse(line); if (j.event === 'listen') { clearTimeout(timeout); resolve({ ...j, pid: child.pid }); } } catch { /* private diagnostics */ }
      }
    });
    child.stderr.resume();
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`test service exited ${code}`)); });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise(r => child.once('exit', r)); child.kill(); await gone;
}
async function connect(base, room, as, username, pw) {
  const protocols = await buildAuthProtocols({ base, projectId: room, as, username, password: pw,
    deviceId: `probe-${as}-device-000001`, deviceName: 'isolated-probe', role: 'page' });
  const c = wsClient(base.replace('http:', 'ws:'), protocols); await c.opened;
  return c;
}
let seq = 0;
async function rpc(c, m) {
  const reqId = `probe-${++seq}`; c.send({ ...m, reqId });
  const r = await c.next(x => x.reqId === reqId, 5000);
  // Never include protocol replies in assertion errors: ticket replies contain secrets.
  assert.notEqual(r.type, 'error', 'protocol rejected request'); return r;
}
try {
  const first = await start();
  let base = `http://127.0.0.1:${first.docservice.port}`;
  const room = await createSharedProject({ base, name: `reopen-probe-${Date.now()}`, mode: 'free',
    creator: { username: 'host', password: creatorPassword }, password });
  const c = await connect(base, room.projectId, 'creator', 'host', creatorPassword);
  await rpc(c, { type: 'project.open', projectId: room.projectId });
  const written = await rpc(c, { type: 'project.op', projectId: room.projectId, opId: 'probe-initial',
    ops: [{ op: 'set', path: '', value: { id: 'probe-content', name: 'persisted', tracks: [], media: [] } }] });
  assert.equal(written.rev, 1);
  c.close(); await stop();
  const second = await start(); base = `http://127.0.0.1:${second.docservice.port}`;
  const host = await connect(base, room.projectId, 'creator', 'host', creatorPassword);
  const state = await rpc(host, { type: 'project.open', projectId: room.projectId });
  assert.equal(state.rev, 1); assert.equal(state.project.name, 'persisted');
  const member = await connect(base, room.projectId, 'member', 'member', password);
  await rpc(member, { type: 'project.open', projectId: room.projectId });
  const edited = await rpc(member, { type: 'project.op', projectId: room.projectId, opId: 'probe-member',
    ops: [{ op: 'set', path: '/name', value: 'member-edited' }] }); assert.equal(edited.rev, 2);
  assert.equal((await rpc(host, { type: 'project.open', projectId: room.projectId })).project.name, 'member-edited');
  results.push({ capability: 'project/version/account restart + member edit', status: 'available', roomId: room.projectId,
    actualProcessRestart: true, differentPid: first.pid !== second.pid, version: edited.rev, role: 'creator/member' });
  host.close(); member.close();
  for (const endpoint of ['hosting/register', 'hosting/challenge', 'hosting/resolve', 'hosting/relay']) {
    const r = await fetch(`${base}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
    results.push({ capability: endpoint, status: r.status === 404 ? 'needs implementation' : 'inspect', http: r.status });
  }
  for (const endpoint of ['healthz', 'hosting/healthz']) {
    try {
      const r = await fetch(`${DEFAULT_HOSTED_URL}/${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      results.push({ capability: `deployed ${endpoint}`, status: r.status === 404 ? 'absent' : 'reachable', http: r.status });
    } catch { results.push({ capability: `deployed ${endpoint}`, status: 'unreachable' }); }
  }
  if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes('isolated-roundtrip'); $c=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); $d=[Security.Cryptography.ProtectedData]::Unprotect($c,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); if([Text.Encoding]::UTF8.GetString($d) -ne 'isolated-roundtrip'){exit 1}";
    const p = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    results.push({ capability: 'Windows DPAPI current user', status: p.status === 0 ? 'available' : 'failed', exitCode: p.status });
  }
} finally { await stop(); }
console.log(JSON.stringify({ baseline: results, isolatedData: true, secretsPrinted: false }, null, 2));
// Keep isolated state for inspection; it contains only randomly generated test credentials.
