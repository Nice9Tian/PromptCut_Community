/**
 * M6a 共享项目：独立模式的失败即关、日志不泄密（契约 `docs/plan/auth-contract.md` 第 5、10 节，用例 AU12、AU13）。
 * 跑：node --test server/test/auth-main.test.mjs
 *
 * AU12 起 `server/docservice/main.mjs` 子进程（环境变量同现有 main.mjs：PROMPTCUT_DOCSERVICE_HOST / _PORT / _DATA、
 * PROMPTCUT_CLUSTER_TOKEN），端口 0，从 stdout 的 `listen` 行取端口。
 * AU13 在进程内跑一遍完整流程（起服务的接口是测试方的假设，见 `auth-kit.mjs` 文件头），收全部日志行与错误回包检查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  hostFor, createProject, challenge, proofFor, join, joinStatus, newDevice, adminOp, ticketOf, credential, uploadLocal,
  bearer, parseTicket, flipSignature, authItem, ask, waitFor, b64u, PROTOCOL, KDF,
} from './auth-kit.mjs';
import { rawHandshake, randomToken } from './fake-ws-kit.mjs';

const MAIN = fileURLToPath(new URL('../docservice/main.mjs', import.meta.url));

function runMain(env) {
  const base = { ...process.env };
  for (const k of ['PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_DOCSERVICE_HOST', 'PROMPTCUT_DOCSERVICE_PORT', 'PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_DOCSERVICE_DATA', 'PROMPTCUT_SHARED_CONFIG']) delete base[k];
  const child = spawn(process.execPath, [MAIN], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, output: () => out, exited };
}

async function exitWithin(run, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  const r = await Promise.race([run.exited, timeout]);
  clearTimeout(timer);
  if (r.timedOut) { run.child.kill(); await run.exited; }
  return r;
}

async function listenPort(run, ms = 8000) {
  return waitFor(() => {
    for (const line of run.output().split('\n')) {
      try {
        const j = JSON.parse(line);
        if (j.event === 'listen' && Number.isInteger(j.port)) return j.port;
      } catch { /* 不是 JSON 行 */ }
    }
    return null;
  }, ms, `main.mjs 打出 listen 行（已有输出：${run.output().slice(0, 400)}）`);
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-auth-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const killer = (t, run) => t.after(async () => { if (run.child.exitCode === null) { run.child.kill(); await run.exited; } });

// ------------------------------------------------------------------ AU12

test('AU12 独立模式绑非回环而凭证存储不可用（数据目录是个文件）→ 退出码 1、config.error { reason: auth-store }', { timeout: 20_000 }, async (t) => {
  const dir = tmp(t);
  const notADir = path.join(dir, 'data-is-a-file');
  fs.writeFileSync(notADir, 'x');
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '0.0.0.0', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_DOCSERVICE_DATA: notADir, PROMPTCUT_CLUSTER_TOKEN: randomToken() });
  killer(t, run);
  const r = await exitWithin(run, 8000);
  assert.ok(!r.timedOut, `没有退出（应当失败即关）；输出：${run.output()}`);
  assert.equal(r.code, 1, run.output());
  const lines = run.output().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.ok(lines.some((l) => l.event === 'config.error' && l.reason === 'auth-store'), `输出含 config.error { reason: auth-store }：${run.output()}`);
});

test('AU12 独立模式绑非回环、没设集群令牌、凭证存储可用 → 照常启动（令牌不再是启动条件）', { timeout: 20_000 }, async (t) => {
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '0.0.0.0', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_DOCSERVICE_DATA: tmp(t) });
  killer(t, run);
  const port = await listenPort(run);
  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(h.ok, true);
  assert.doesNotMatch(run.output(), /token-required/);
  // 管理接口（带令牌的握手）全部 401
  const r = await rawHandshake(port, { protocols: [PROTOCOL, `promptcut.token.${randomToken()}`] });
  r.sock.destroy();
  assert.equal(r.status, 401);
  // shared/* 端点可用
  const l = await fetch(`http://127.0.0.1:${port}/shared/lookup?name=nothing-here`);
  assert.equal(l.status, 404);
  assert.deepEqual(await l.json(), { ok: false, error: 'no-project' });
});

test('AU12 独立模式：设了而格式不对的集群令牌仍是 bad-token-format 退出码 1', { timeout: 20_000 }, async (t) => {
  const bad = 'short-token!';
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_DOCSERVICE_DATA: tmp(t), PROMPTCUT_CLUSTER_TOKEN: bad });
  killer(t, run);
  const r = await exitWithin(run, 8000);
  assert.ok(!r.timedOut, run.output());
  assert.equal(r.code, 1);
  assert.match(run.output(), /bad-token-format/);
  assert.ok(!run.output().includes(bad));
});

test('AU12 独立模式子进程：建项目、握手、凭证落在 <数据目录>/auth/，日志里没有口令与 K', { timeout: 30_000 }, async (t) => {
  const data = tmp(t);
  const token = randomToken();
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_DOCSERVICE_DATA: data, PROMPTCUT_CLUSTER_TOKEN: token });
  killer(t, run);
  const port = await listenPort(run);
  const env = {
    async http(rel, { method = 'GET', body } = {}) {
      const r = await fetch(`http://127.0.0.1:${port}/${rel}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: r.status, json, text, headers: r.headers };
    },
    async handshake(protocols) {
      const r = await rawHandshake(port, { protocols });
      r.sock.destroy();
      return { status: r.status, protocol: r.headers['sec-websocket-protocol'] };
    },
  };
  const proj = await createProject(env, { mode: 'free', password: 'sub-proc-pw-123', creator: { username: 'alice', password: 'sub-creator-pw-456' } });
  const p = await proofFor(env, proj, { username: 'zoe' });
  // 回环来源带证明：按证明进（至多一项鉴权，证明算一项）
  assert.equal((await env.handshake(p.protocols)).status, 101);
  assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${token}`])).status, 101, '设了令牌：管理接口可用');
  assert.ok(fs.existsSync(path.join(data, 'auth', 'projects', `${proj.projectId}.json`)));
  const out = run.output();
  for (const secret of ['sub-proc-pw-123', 'sub-creator-pw-456', p.key, p.fields.m, token]) {
    assert.ok(!out.includes(secret), `子进程输出里出现了秘密：${secret.slice(0, 6)}…`);
  }
});

// ------------------------------------------------------------------ AU13

const ALLOWED_REASONS = new Set(['no-credential', 'bad-proof', 'nonce', 'banned', 'not-listed', 'no-project', 'rate-limited', 'bad-format', 'multiple']);

test('AU13 一次完整流程的全部日志行与所有错误回包里，不出现口令、K、证明 m、票据原文；auth.reject 只记 { remote, reason }', async (t) => {
  const env = await hostFor(t, { assets: true });
  const secrets = new Set();
  const note = (...xs) => { for (const x of xs) if (typeof x === 'string' && x.length >= 8) secrets.add(x); };
  const errors = [];

  const blob = await uploadLocal(env);
  const freePw = `free-${b64u(randomBytes(6))}`;
  const creatorPw = `crea-${b64u(randomBytes(6))}`;
  const bobPw = `bob-${b64u(randomBytes(6))}`;
  note(freePw, creatorPw, bobPw);
  const free = await createProject(env, { mode: 'free', password: freePw, creator: { username: 'alice', password: creatorPw } });
  const restricted = await createProject(env, { mode: 'restricted', creator: { username: 'alice', password: creatorPw }, list: [{ username: 'bob', password: bobPw }] });

  // 成功的握手（成员、创建者、限定进入）
  const dev = newDevice();
  const ok1 = await proofFor(env, free, { username: 'zoe', device: dev, remote: '192.168.5.1' });
  note(ok1.key, ok1.fields.m, ok1.protocols[1]);
  const zoe = await env.open(ok1.protocols, '192.168.5.1');
  const cr = await proofFor(env, free, { username: 'alice', as: 'creator', remote: '192.168.5.2' });
  note(cr.key, cr.fields.m, cr.protocols[1]);
  const creator = await env.open(cr.protocols, '192.168.5.2');
  const bp = await proofFor(env, restricted, { username: 'bob', remote: '192.168.5.3' });
  note(bp.key, bp.fields.m);
  await env.open(bp.protocols, '192.168.5.3');

  // 失败的握手：口令错、nonce 复用、名单外、多项、无凭证、格式错、项目不存在（本机声明）
  const wrong = await proofFor(env, free, { username: 'zoe', password: 'totally-wrong-pw', remote: '192.168.5.4' });
  note('totally-wrong-pw', wrong.key, wrong.fields.m, wrong.protocols[1]);
  assert.equal((await env.handshake(wrong.protocols, '192.168.5.4')).status, 401);
  assert.equal((await env.handshake(ok1.protocols, '192.168.5.5')).status, 401, 'nonce 复用');
  const out = await proofFor(env, restricted, { username: 'mallory', password: 'mallory-guess', remote: '192.168.5.6' });
  note('mallory-guess', out.key, out.fields.m);
  assert.equal((await env.handshake(out.protocols, '192.168.5.6')).status, 401);
  const two = await proofFor(env, free, { username: 'zoe', remote: '192.168.5.7' });
  note(two.fields.m);
  assert.equal((await env.handshake([...two.protocols, two.protocols[1]], '192.168.5.7')).status, 401);
  assert.equal((await env.handshake([PROTOCOL], '192.168.5.8')).status, 401, '无凭证');
  assert.equal((await env.handshake([PROTOCOL, 'promptcut.auth.@@@'], '192.168.5.9')).status, 401, '格式错');
  assert.equal((await env.handshake([PROTOCOL, 'promptcut.tenant.sp_aaaaaaaaaaaaaaaaaaaaaaaaaa'])).status, 401, '项目不存在');

  // 票据与素材
  const at = await ticketOf(zoe, { kind: 'asset', access: 'r' });
  const ct = await ticketOf(zoe, { kind: 'conn', role: 'render' });
  note(at.ticket, ct.ticket, parseTicket(at.ticket).payload, parseTicket(at.ticket).sig, parseTicket(ct.ticket).sig);
  const readBad = await env.asset(`media/${blob.hash}?t=${encodeURIComponent(flipSignature(at.ticket))}`, { remote: '192.168.5.1' });
  errors.push(readBad.buf.toString());
  const readOk = await env.asset(`media/${blob.hash}?t=${encodeURIComponent(at.ticket)}`, { remote: '192.168.5.1' });
  assert.equal(readOk.status, 200);
  const writeRo = await env.asset(`media/${blob.hash}/0`, { method: 'PUT', remote: '192.168.5.1', headers: { ...bearer(at.ticket), 'X-Media-Size': '1' }, body: Buffer.from('x') });
  errors.push(writeRo.buf.toString());
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${flipSignature(ct.ticket)}`], '192.168.5.10')).status, 401);

  // 创建者操作：证明错、成功的 set-password 与 kick，被踢者再进入
  const badAdmin = await adminOp(creator, free, 'unban', { username: 'x', deviceId: newDevice().deviceId }, { badProof: true });
  errors.push(JSON.stringify(badAdmin));
  const newPw = `new-${b64u(randomBytes(6))}`;
  const project = credential(newPw);
  note(newPw, project.key);
  const sp = await adminOp(creator, free, 'set-password', { project });
  assert.equal(sp.type, 'shared.admin.ok', JSON.stringify(sp));
  free.password = newPw;
  const kicked = await adminOp(creator, free, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(kicked.type, 'shared.admin.ok', JSON.stringify(kicked));
  const again = await proofFor(env, free, { username: 'zoe', device: dev, remote: '192.168.5.11' });
  note(again.key, again.fields.m);
  assert.equal((await env.handshake(again.protocols, '192.168.5.11')).status, 401, '禁入');

  // HTTP 错误回包
  for (const r of [
    await env.http('shared/create', { method: 'POST', body: { name: free.name, mode: 'free', kdf: KDF, creator: credential(creatorPw, 'alice'), project: credential(freePw) } }),
    await env.http('shared/create', { method: 'POST', body: { name: 'x', mode: 'free', kdf: KDF, creator: { username: 'a', salt: 'zz', key: ok1.key } } }),
    await challenge(env, { projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'zoe', deviceId: dev.deviceId }),
  ]) errors.push(r.text);
  // WS 错误回包：收过的全部 error 消息
  for (const c of [zoe, creator]) for (const m of c.all) if (m?.type === 'error') errors.push(JSON.stringify(m));

  const logText = env.logs.map((l) => JSON.stringify(l)).join('\n');
  const errText = errors.join('\n');
  for (const s of secrets) {
    assert.ok(!logText.includes(s), `日志里出现了秘密（${s.slice(0, 6)}…）`);
    assert.ok(!errText.includes(s), `错误回包里出现了秘密（${s.slice(0, 6)}…）`);
  }

  const rejects = env.logs.filter((l) => l.event === 'auth.reject');
  assert.ok(rejects.length >= 8, `每次握手被拒记一条 auth.reject：${JSON.stringify(rejects)}`);
  for (const r of rejects) {
    assert.ok('remote' in r, `auth.reject 带 remote：${JSON.stringify(r)}`);
    assert.ok(ALLOWED_REASONS.has(r.reason), `reason 在约定集合里：${JSON.stringify(r)}`);
  }
  const reasons = new Set(rejects.map((r) => r.reason));
  for (const want of ['bad-proof', 'nonce', 'multiple', 'no-credential', 'bad-format', 'no-project', 'banned']) {
    assert.ok(reasons.has(want), `应出现 reason ${want}；实际：${[...reasons].join(', ')}`);
  }
  void join; void joinStatus; void ask; void authItem;
});
