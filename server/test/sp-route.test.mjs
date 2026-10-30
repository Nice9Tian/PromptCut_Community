/**
 * SP 客户端路由与缺省托管地址（契约 `docs/plan/shared-project-contract.md` 第 3 节；验收第 7 节 SP5、SP6）。
 * 跑：node --test server/test/sp-route.test.mjs
 *
 * 托管端与局域网主机都用进程内的 M6a 文档服务（`auth-kit.mjs` 的 hostFor），局域网发现用假的 `discover`。
 * 契约没写死的参数形状见 `sp-kit.mjs` 文件头的假设 D1、R1～R3。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostFor, createProject, uniqueName } from './auth-kit.mjs';
import { refusingPort } from './fake-ws-kit.mjs';
import { loadRoute, loadHostedDefault, ROOT } from './sp-kit.mjs';

const hostedUrlOf = (env) => `http://127.0.0.1:${env.port}`;

/** 假的局域网发现：不看参数，回给定的应答包 */
const fakeDiscover = (announces) => async () => announces;

function announceFor(proj, { ip = '192.168.50.20', port = 5173, hostDeviceName = 'Studio-PC' } = {}) {
  return {
    magic: 'promptcut-lan', v: 1, type: 'announce', nonce: 'n-1',
    projectId: proj.projectId, name: proj.name, mode: proj.mode, hostDeviceName,
    docservice: `ws://${ip}:${port}/docservice`, asset: `http://${ip}:${port}/api/asset`, ttlMs: 45000,
  };
}

const pick = (c) => ({ where: c.where, projectId: c.projectId, name: c.name, mode: c.mode });

async function findTimed(route, args) {
  const t0 = Date.now();
  const r = await route.findSharedProject(args);
  return { r, ms: Date.now() - t0 };
}

// ================================================================== SP5：四种候选组合

test('SPC5-1 只有局域网有：候选只有一条 lan，带 projectId、name、mode、hostDeviceName、base', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const lanProj = { projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', name: uniqueName('lan-only'), mode: 'free' };
  const { r } = await findTimed(route, { name: lanProj.name, hostedUrl: hostedUrlOf(hosted), lan: { discover: fakeDiscover([announceFor(lanProj)]) } });
  assert.deepEqual(r.candidates.map(pick), [{ where: 'lan', ...lanProj }], JSON.stringify(r));
  const c = r.candidates[0];
  assert.equal(c.hostDeviceName, 'Studio-PC');
  assert.equal(typeof c.base, 'string');
  assert.match(c.base, /192\.168\.50\.20/, 'base 指向局域网主机');
  assert.ok(Array.isArray(r.errors));
});

test('SPC5-2 只有托管有：候选只有一条 hosted，base 是托管地址', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const proj = await createProject(hosted, { mode: 'restricted' });
  const { r } = await findTimed(route, { name: proj.name, hostedUrl: hostedUrlOf(hosted), lan: { discover: fakeDiscover([]) } });
  assert.deepEqual(r.candidates.map(pick), [{ where: 'hosted', projectId: proj.projectId, name: proj.name, mode: 'restricted' }], JSON.stringify(r));
  assert.equal(r.candidates[0].base.replace(/\/+$/, ''), hostedUrlOf(hosted));
});

test('SPC5-3 两边都有：两条并列，谁也不挑', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const proj = await createProject(hosted, { mode: 'free' });
  const lanProj = { projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb', name: proj.name, mode: 'restricted' };
  const { r } = await findTimed(route, { name: proj.name, hostedUrl: hostedUrlOf(hosted), lan: { discover: fakeDiscover([announceFor(lanProj)]) } });
  assert.equal(r.candidates.length, 2, JSON.stringify(r));
  const got = r.candidates.map(pick).sort((a, b) => a.where.localeCompare(b.where));
  assert.deepEqual(got, [
    { where: 'hosted', projectId: proj.projectId, name: proj.name, mode: 'free' },
    { where: 'lan', ...lanProj },
  ]);
});

test('SPC5-4 两边都没有：候选为空、不抛异常（由调用方提示「找不到」）', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const { r } = await findTimed(route, { name: uniqueName('nowhere'), hostedUrl: hostedUrlOf(hosted), lan: { discover: fakeDiscover([]) } });
  assert.deepEqual(r.candidates, []);
  assert.ok(Array.isArray(r.errors));
});

// ================================================================== SP5：出错进 errors、不抛

test('SPC5-5 托管端连不上：进 errors { where: hosted }，不抛；局域网候选照常', async (t) => {
  const route = await loadRoute();
  const dead = await refusingPort();
  t.after(() => dead.close());
  const lanProj = { projectId: 'sp_cccccccccccccccccccccccccc', name: uniqueName('lan'), mode: 'free' };
  const { r } = await findTimed(route, { name: lanProj.name, hostedUrl: `http://127.0.0.1:${dead.port}`, lan: { discover: fakeDiscover([announceFor(lanProj)]) } });
  assert.deepEqual(r.candidates.map(pick), [{ where: 'lan', ...lanProj }]);
  const e = r.errors.find((x) => x.where === 'hosted');
  assert.ok(e, `errors 里有 hosted：${JSON.stringify(r.errors)}`);
  assert.equal(typeof e.reason, 'string');
});

test('SPC5-6 局域网发现限时 3 s：discover 一直不回，3 s 左右返回，进 errors { where: lan }；托管候选照常', { timeout: 15_000 }, async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const proj = await createProject(hosted, { mode: 'free' });
  const { r, ms } = await findTimed(route, { name: proj.name, hostedUrl: hostedUrlOf(hosted), lan: { discover: () => new Promise(() => {}) } });
  assert.ok(ms >= 2500 && ms <= 5000, `用时 ${ms} ms，应在 3 s 左右`);
  assert.deepEqual(r.candidates.map(pick), [{ where: 'hosted', projectId: proj.projectId, name: proj.name, mode: 'free' }]);
  assert.ok(r.errors.some((x) => x.where === 'lan'), `errors 里有 lan：${JSON.stringify(r.errors)}`);
});

test('SPC5-7 discover 抛错：进 errors { where: lan }，不抛', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const { r } = await findTimed(route, { name: uniqueName('x'), hostedUrl: hostedUrlOf(hosted), lan: { discover: async () => { throw new Error('EADDRINUSE'); } } });
  assert.deepEqual(r.candidates, []);
  assert.ok(r.errors.some((x) => x.where === 'lan'), JSON.stringify(r.errors));
});

test('SPC5-8 手填兜底：lan.manual 的地址直接 GET /docservice/shared/lookup?name=，得到 lan 候选', async (t) => {
  const route = await loadRoute();
  const lanHost = await hostFor(t, { attached: true });
  const proj = await createProject(lanHost, { mode: 'free' });
  const dead = await refusingPort();
  t.after(() => dead.close());
  const { r } = await findTimed(route, {
    name: proj.name,
    hostedUrl: `http://127.0.0.1:${dead.port}`,
    lan: { manual: [`http://127.0.0.1:${lanHost.port}`] },
  });
  assert.deepEqual(r.candidates.map(pick), [{ where: 'lan', projectId: proj.projectId, name: proj.name, mode: 'free' }], JSON.stringify(r));
  assert.match(r.candidates[0].base, new RegExp(`127\\.0\\.0\\.1:${lanHost.port}`));
});

test('SPC5-9 手填地址查不到或连不上：不抛；连不上的进 errors { where: lan }', async (t) => {
  const route = await loadRoute();
  const lanHost = await hostFor(t, { attached: true });
  const dead = await refusingPort();
  t.after(() => dead.close());
  const { r } = await findTimed(route, {
    name: uniqueName('none'),
    hostedUrl: `http://127.0.0.1:${dead.port}`,
    lan: { manual: [`http://127.0.0.1:${lanHost.port}`, `http://127.0.0.1:${dead.port}`] },
  });
  assert.deepEqual(r.candidates, []);
  assert.ok(r.errors.some((x) => x.where === 'lan'), JSON.stringify(r.errors));
  assert.ok(r.errors.some((x) => x.where === 'hosted'), JSON.stringify(r.errors));
});

test('SPC5-10 createSharedProject({ where: hosted })：向托管地址 POST shared/create，口令不出客户端', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const name = uniqueName('created');
  const password = 'route-created-pw-7788';
  const creatorPw = 'route-creator-pw-9900';
  const out = await route.createSharedProject({
    where: 'hosted', hostedUrl: hostedUrlOf(hosted), name, mode: 'free',
    creator: { username: 'alice', password: creatorPw }, password,
  });
  assert.match(out.projectId, /^sp_[a-z2-7]{26}$/);
  const lk = await hosted.http(`shared/lookup?name=${encodeURIComponent(name)}`);
  assert.equal(lk.json.projectId, out.projectId);
  const rec = fs.readFileSync(path.join(hosted.dataDir, 'auth', 'projects', `${out.projectId}.json`), 'utf8');
  assert.ok(!rec.includes(password) && !rec.includes(creatorPw), '服务端记录里没有口令原文');
  const joined = hosted.logs.map((l) => JSON.stringify(l)).join('\n');
  assert.ok(!joined.includes(password) && !joined.includes(creatorPw), '服务端日志里没有口令原文');
});

// ================================================================== SP6：缺省托管地址

test('SPC6-2 覆盖顺序：界面上改过的值 > PROMPTCUT_HOSTED_URL > 缺省值', async () => {
  const { DEFAULT_HOSTED_URL, resolveHostedUrl } = await loadHostedDefault();
  assert.equal(resolveHostedUrl({ env: {} }), DEFAULT_HOSTED_URL, '都没设：缺省值');
  assert.equal(resolveHostedUrl({ env: { PROMPTCUT_HOSTED_URL: 'http://10.1.2.3:9000' } }), 'http://10.1.2.3:9000', '设了环境变量：用它');
  assert.equal(resolveHostedUrl({ ui: 'http://203.0.113.5:8787', env: { PROMPTCUT_HOSTED_URL: 'http://10.1.2.3:9000' } }), 'http://203.0.113.5:8787', '界面上改过：优先');
  assert.equal(resolveHostedUrl({ ui: 'http://203.0.113.5:8787', env: {} }), 'http://203.0.113.5:8787');
});

test('SPC5-11 route.mjs 与 hosted-default.mjs 浏览器也能用：没有静态引 node: 内置模块（局域网发现由调用方经 lan.discover 注入）', () => {
  for (const rel of ['server/auth/route.mjs', 'server/auth/hosted-default.mjs', 'server/auth/product.mjs']) {
    const file = path.join(ROOT, ...rel.split('/'));
    assert.ok(fs.existsSync(file), `${rel} 存在`);
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /^\s*import\s[^;]*?from\s*['"]node:/m, `${rel} 静态引了 node: 模块`);
    assert.doesNotMatch(src, /^\s*import\s[^;]*?from\s*['"](dgram|os|net|fs|child_process)['"]/m, `${rel} 静态引了 Node 内置模块`);
    assert.doesNotMatch(src, /\brequire\s*\(/, `${rel} 用了 require`);
  }
});
