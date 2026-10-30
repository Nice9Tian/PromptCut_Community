/**
 * M6a 共享项目：HTTP 端点（契约 `docs/plan/auth-contract.md` 第 3、4 节，用例 AU1）。
 * 跑：node --test server/test/auth-create.test.mjs
 *
 * 只照契约写，不看实现。起服务的接口是测试方的假设，集中在 `auth-kit.mjs` 文件头。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hostFor, createProject, credential, challenge, uniqueName, KDF, newDevice, joinStatus } from './auth-kit.mjs';

const PUBLIC = '203.0.113.7';
const LAN = '192.168.1.50';

function createBody({ name = uniqueName(), mode = 'free', kdf = KDF } = {}) {
  const body = { name, mode, kdf, creator: credential('creator-pw', 'alice') };
  if (mode === 'free') body.project = credential('project-pw');
  else body.list = [credential('bob-pw', 'bob')];
  return body;
}

test('AU1 shared/create 两种模式都建成：201 { ok, projectId: sp_<26 位小写 base32>, name, mode }，lookup 查得到', async (t) => {
  const env = await hostFor(t);
  for (const mode of ['free', 'restricted']) {
    const body = createBody({ mode });
    const r = await env.http('shared/create', { method: 'POST', body, remote: PUBLIC });
    assert.equal(r.status, 201, `${mode}：${r.text}`);
    assert.equal(r.json.ok, true);
    assert.match(r.json.projectId, /^sp_[a-z2-7]{26}$/, `projectId 形状：${r.json.projectId}`);
    assert.equal(r.json.name, body.name);
    assert.equal(r.json.mode, mode);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');

    const l = await env.http(`shared/lookup?name=${encodeURIComponent(body.name)}`);
    assert.equal(l.status, 200, l.text);
    assert.deepEqual({ ok: l.json.ok, projectId: l.json.projectId, name: l.json.name, mode: l.json.mode }, { ok: true, projectId: r.json.projectId, name: body.name, mode });

    // 第 3 节：每个共享项目一个记录文件
    assert.ok(fs.existsSync(path.join(env.dataDir, 'auth', 'projects', `${r.json.projectId}.json`)), '凭证记录落在 <数据目录>/auth/projects/<projectId>.json');
  }
  assert.ok(fs.existsSync(path.join(env.dataDir, 'auth', 'server.json')), '首次启动生成 auth/server.json');
  const miss = await env.http(`shared/lookup?name=${encodeURIComponent(uniqueName('nope'))}`);
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.json, { ok: false, error: 'no-project' });
});

test('AU1 同名第二次回 409 name-taken：大小写不同、NFC 不同形都算同名', async (t) => {
  const env = await hostFor(t);
  const base = uniqueName('Café');
  const nfc = base.normalize('NFC');
  const nfd = base.normalize('NFD');
  assert.notEqual(nfc, nfd, '测试前提：NFC 与 NFD 两种写法字节不同');
  const first = await env.http('shared/create', { method: 'POST', body: createBody({ name: nfc }) });
  assert.equal(first.status, 201, first.text);
  for (const name of [nfc, nfc.toUpperCase(), nfc.toLowerCase(), nfd, nfd.toUpperCase()]) {
    const r = await env.http('shared/create', { method: 'POST', body: createBody({ name, mode: 'restricted' }) });
    assert.equal(r.status, 409, `「${name}」应 409：${r.text}`);
    assert.deepEqual(r.json, { ok: false, error: 'name-taken' });
  }
  // lookup 同样按规范化比较
  const l = await env.http(`shared/lookup?name=${encodeURIComponent(nfd.toUpperCase())}`);
  assert.equal(l.status, 200, l.text);
  assert.equal(l.json.projectId, first.json.projectId);
});

test('AU1 字段缺失或不合法回 400 bad-request（主会话裁定：缺 list = 空名单）', async (t) => {
  const env = await hostFor(t);
  const good = createBody();
  const cases = {
    '没有 name': (b) => { delete b.name; },
    'name 为空': (b) => { b.name = ''; },
    'name 超过 64 个字符': (b) => { b.name = 'x'.repeat(65); },
    'name 含 /': (b) => { b.name = 'a/b'; },
    'name 含控制字符': (b) => { b.name = 'a\u0001b'; },
    '没有 mode': (b) => { delete b.mode; },
    'mode 不认识': (b) => { b.mode = 'open'; },
    '没有 kdf': (b) => { delete b.kdf; },
    'kdf.iter 低于 10 万': (b) => { b.kdf = { ...KDF, iter: 99_999 }; },
    'kdf.iter 高于 500 万': (b) => { b.kdf = { ...KDF, iter: 5_000_001 }; },
    '没有 creator': (b) => { delete b.creator; },
    'creator 没有 username': (b) => { delete b.creator.username; },
    'creator 没有 salt': (b) => { delete b.creator.salt; },
    'creator 没有 key': (b) => { delete b.creator.key; },
    'creator.key 不是 32 字节': (b) => { b.creator.key = Buffer.alloc(16).toString('base64url'); },
    '自由进入却没有 project': (b) => { delete b.project; },
  };
  for (const [what, mutate] of Object.entries(cases)) {
    const body = structuredClone(good);
    body.name = uniqueName();
    mutate(body);
    const r = await env.http('shared/create', { method: 'POST', body });
    assert.equal(r.status, 400, `${what}：${r.status} ${r.text}`);
    assert.deepEqual(r.json, { ok: false, error: 'bad-request' }, what);
  }
  const noList = createBody({ mode: 'restricted' });
  delete noList.list;
  const r = await env.http('shared/create', { method: 'POST', body: noList });
  // 主会话裁定（2026-09-26，契约第 14 节）：限定进入缺 list 等同空名单，只有创建者一人，合法
  assert.equal(r.status, 201, `限定进入缺 list = 空名单：${r.text}`);
  const emptyList = { projectId: r.json.projectId, mode: 'restricted', creator: { username: 'alice', password: 'creator-pw' }, list: [] };
  assert.equal(await joinStatus(env, emptyList, { username: 'bob', password: 'bob-pw', remote: '203.0.113.90' }), 401, '空名单：名单外用户名握手 401');
  assert.equal(await joinStatus(env, emptyList, { username: 'alice', as: 'creator', remote: '203.0.113.91' }), 101, '空名单：创建者能进');
  const notJson = await env.http('shared/create', { method: 'POST', raw: '{not json', headers: { 'content-type': 'application/json' } });
  assert.equal(notJson.status, 400, '请求体不是 JSON');
});

test('AU1 请求体超过 64 KiB 回 413；OPTIONS 预检答 CORS', async (t) => {
  const env = await hostFor(t);
  const big = createBody();
  big.pad = 'x'.repeat(64 * 1024 + 10);
  const r = await env.http('shared/create', { method: 'POST', body: big });
  assert.equal(r.status, 413, r.text);
  assert.equal(r.json?.ok, false);

  const pre = await env.http('shared/create', { method: 'OPTIONS', headers: { Origin: 'http://example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.ok(pre.status === 204 || pre.status === 200, `预检：${pre.status}`);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-credentials'), null, '不带凭证');
});

test('AU1 局域网主机（挂载模式）：非回环来源建项目回 403 forbidden，回环来源能建', async (t) => {
  const env = await hostFor(t, { attached: true });
  for (const remote of [LAN, PUBLIC, '10.0.0.8']) {
    const r = await env.http('shared/create', { method: 'POST', body: createBody(), remote });
    assert.equal(r.status, 403, `${remote}：${r.text}`);
    assert.deepEqual(r.json, { ok: false, error: 'forbidden' });
  }
  const ok = await env.http('shared/create', { method: 'POST', body: createBody() });
  assert.equal(ok.status, 201, ok.text);
  // 挂载模式的端点在 /docservice/shared/…
  assert.ok(env.httpBase.endsWith('/docservice/'));
  // 非回环来源可以 lookup、取挑战
  const l = await env.http(`shared/lookup?name=${encodeURIComponent(ok.json.name)}`, { remote: LAN });
  assert.equal(l.status, 200, l.text);
});

test('AU1 托管端：同一来源每小时最多建 10 个，第 11 个回 429 rate-limited；别的来源不受影响；过一小时恢复', async (t) => {
  const env = await hostFor(t);
  for (let i = 0; i < 10; i++) {
    const r = await env.http('shared/create', { method: 'POST', body: createBody(), remote: PUBLIC });
    assert.equal(r.status, 201, `第 ${i + 1} 个：${r.text}`);
  }
  const eleventh = await env.http('shared/create', { method: 'POST', body: createBody(), remote: PUBLIC });
  assert.equal(eleventh.status, 429, eleventh.text);
  assert.deepEqual(eleventh.json, { ok: false, error: 'rate-limited' });
  const other = await env.http('shared/create', { method: 'POST', body: createBody(), remote: '198.51.100.9' });
  assert.equal(other.status, 201, `别的来源：${other.text}`);
  env.clock.advance(60 * 60_000 + 1000);
  const later = await env.http('shared/create', { method: 'POST', body: createBody(), remote: PUBLIC });
  assert.equal(later.status, 201, `一小时后：${later.text}`);
});

test('AU1 shared/challenge：形状 { ok, nonce(32 字节), salt, kdf, mode }；项目不存在 404；字段不对 400', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  const r = await challenge(env, { projectId: proj.projectId, username: 'zed', deviceId: dev.deviceId, as: 'member', remote: PUBLIC });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(Buffer.from(r.json.nonce, 'base64url').length, 32, 'nonce 是 32 字节');
  assert.match(r.json.nonce, /^[A-Za-z0-9_-]+$/, 'nonce 是 base64url、不带 =');
  assert.equal(Buffer.from(r.json.salt, 'base64url').length, 16, 'salt 是 16 字节');
  assert.deepEqual(r.json.kdf, KDF);
  assert.equal(r.json.mode, 'free');
  const r2 = await challenge(env, { projectId: proj.projectId, username: 'zed', deviceId: dev.deviceId, as: 'member', remote: PUBLIC });
  assert.notEqual(r2.json.nonce, r.json.nonce, '每次新 nonce');

  const missing = await challenge(env, { projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'zed', deviceId: dev.deviceId });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { ok: false, error: 'no-project' });

  for (const [what, body] of [
    ['as 不认识', { projectId: proj.projectId, username: 'zed', deviceId: dev.deviceId, as: 'admin' }],
    ['deviceId 太短', { projectId: proj.projectId, username: 'zed', deviceId: 'short', as: 'member' }],
    ['deviceId 含非法字符', { projectId: proj.projectId, username: 'zed', deviceId: 'bad device id!!!!', as: 'member' }],
    ['没有 username', { projectId: proj.projectId, deviceId: dev.deviceId, as: 'member' }],
  ]) {
    const b = await env.http('shared/challenge', { method: 'POST', body });
    assert.equal(b.status, 400, `${what}：${b.text}`);
    assert.deepEqual(b.json, { ok: false, error: 'bad-request' }, what);
  }
});
