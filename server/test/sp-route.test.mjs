/**
 * SP client routing and default hosted address (Section 3 of
 * `docs/plan/shared-project-contract.md`; Section 7 acceptance check SP5 and SP6).
 * Run: node --test server/test/sp-route.test.mjs
 *
 * Both hosted side and LAN host use in-process M6a document service (`auth-kit.mjs` hostFor);
 * LAN discovery uses fake `discover`. For parameter shapes not hardcoded in the contract,
 * see assumptions D1, R1-R3 in the header of `sp-kit.mjs`.
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

/** Fake LAN discovery: ignores parameters, returns the given response packet */
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

// ================================================================== SP5: Four candidate combinations

test('SPC5-1 only the LAN has it: a single lan candidate, carrying projectId, name, mode, hostDeviceName, base', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const lanProj = { projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', name: uniqueName('lan-only'), mode: 'free' };
  const { r } = await findTimed(route, { name: lanProj.name, hostedUrl: hostedUrlOf(hosted), lan: { discover: fakeDiscover([announceFor(lanProj)]) } });
  assert.deepEqual(r.candidates.map(pick), [{ where: 'lan', ...lanProj }], JSON.stringify(r));
  const c = r.candidates[0];
  assert.equal(c.hostDeviceName, 'Studio-PC');
  assert.equal(typeof c.base, 'string');
  assert.match(c.base, /192\.168\.50\.20/, 'base points to the LAN host');
  assert.ok(Array.isArray(r.errors));
});

test('SPC5-2 only the hosted side has it: a single hosted candidate, base is the hosted address', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const proj = await createProject(hosted, { mode: 'restricted' });
  const { r } = await findTimed(route, { name: proj.name, hostedUrl: hostedUrlOf(hosted), lan: { discover: fakeDiscover([]) } });
  assert.deepEqual(r.candidates.map(pick), [{ where: 'hosted', projectId: proj.projectId, name: proj.name, mode: 'restricted' }], JSON.stringify(r));
  assert.equal(r.candidates[0].base.replace(/\/+$/, ''), hostedUrlOf(hosted));
});

test('SPC5-3 both sides have it: two candidates side by side, neither preferred', async (t) => {
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

test('SPC5-4 neither side has it: no candidates, no exception thrown (the caller shows "not found")', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const { r } = await findTimed(route, { name: uniqueName('nowhere'), hostedUrl: hostedUrlOf(hosted), lan: { discover: fakeDiscover([]) } });
  assert.deepEqual(r.candidates, []);
  assert.ok(Array.isArray(r.errors));
});

// ================================================================== SP5: Errors go into errors, do not throw

test('SPC5-5 the hosted side is unreachable: goes into errors { where: hosted }, no throw; LAN candidates are unaffected', async (t) => {
  const route = await loadRoute();
  const dead = await refusingPort();
  t.after(() => dead.close());
  const lanProj = { projectId: 'sp_cccccccccccccccccccccccccc', name: uniqueName('lan'), mode: 'free' };
  const { r } = await findTimed(route, { name: lanProj.name, hostedUrl: `http://127.0.0.1:${dead.port}`, lan: { discover: fakeDiscover([announceFor(lanProj)]) } });
  assert.deepEqual(r.candidates.map(pick), [{ where: 'lan', ...lanProj }]);
  const e = r.errors.find((x) => x.where === 'hosted');
  assert.ok(e, `errors contains hosted: ${JSON.stringify(r.errors)}`);
  assert.equal(typeof e.reason, 'string');
});

test('SPC5-6 LAN discovery is limited to 3 s: discover never replies, returns after about 3 s and goes into errors { where: lan }; hosted candidates are unaffected', { timeout: 15_000 }, async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const proj = await createProject(hosted, { mode: 'free' });
  const { r, ms } = await findTimed(route, { name: proj.name, hostedUrl: hostedUrlOf(hosted), lan: { discover: () => new Promise(() => {}) } });
  assert.ok(ms >= 2500 && ms <= 5000, `took ${ms} ms, should be about 3 s`);
  assert.deepEqual(r.candidates.map(pick), [{ where: 'hosted', projectId: proj.projectId, name: proj.name, mode: 'free' }]);
  assert.ok(r.errors.some((x) => x.where === 'lan'), `errors contains lan: ${JSON.stringify(r.errors)}`);
});

test('SPC5-7 discover throws: goes into errors { where: lan }, no throw', async (t) => {
  const route = await loadRoute();
  const hosted = await hostFor(t);
  const { r } = await findTimed(route, { name: uniqueName('x'), hostedUrl: hostedUrlOf(hosted), lan: { discover: async () => { throw new Error('EADDRINUSE'); } } });
  assert.deepEqual(r.candidates, []);
  assert.ok(r.errors.some((x) => x.where === 'lan'), JSON.stringify(r.errors));
});

test('SPC5-8 manual-entry fallback: the lan.manual address is queried directly with GET /docservice/shared/lookup?name=, yielding a lan candidate', async (t) => {
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

test('SPC5-9 manually entered address not found or unreachable: no throw; unreachable ones go into errors { where: lan }', async (t) => {
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

test('SPC5-10 createSharedProject({ where: hosted }): POSTs shared/create to the hosted address, the passphrase never leaves the client', async (t) => {
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
  assert.ok(!rec.includes(password) && !rec.includes(creatorPw), 'no plaintext passphrase in the server records');
  const joined = hosted.logs.map((l) => JSON.stringify(l)).join('\n');
  assert.ok(!joined.includes(password) && !joined.includes(creatorPw), 'no plaintext passphrase in the server logs');
});

// ================================================================== SP6: Default hosted address

test('SPC6-2 override order: value changed in the UI > PROMPTCUT_HOSTED_URL > default value', async () => {
  const { DEFAULT_HOSTED_URL, resolveHostedUrl } = await loadHostedDefault();
  assert.equal(resolveHostedUrl({ env: {} }), DEFAULT_HOSTED_URL, 'none set: default value');
  assert.equal(resolveHostedUrl({ env: { PROMPTCUT_HOSTED_URL: 'http://10.1.2.3:9000' } }), 'http://10.1.2.3:9000', 'environment variable set: use it');
  assert.equal(resolveHostedUrl({ ui: 'http://203.0.113.5:8787', env: { PROMPTCUT_HOSTED_URL: 'http://10.1.2.3:9000' } }), 'http://203.0.113.5:8787', 'changed in the UI: takes priority');
  assert.equal(resolveHostedUrl({ ui: 'http://203.0.113.5:8787', env: {} }), 'http://203.0.113.5:8787');
});

test('SPC5-11 route.mjs and hosted-default.mjs also work in the browser: no static import of node: built-in modules (LAN discovery is injected by the caller via lan.discover)', () => {
  for (const rel of ['server/auth/route.mjs', 'server/auth/hosted-default.mjs', 'server/auth/product.mjs']) {
    const file = path.join(ROOT, ...rel.split('/'));
    assert.ok(fs.existsSync(file), `${rel} exists`);
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /^\s*import\s[^;]*?from\s*['"]node:/m, `${rel} statically imports a node: module`);
    assert.doesNotMatch(src, /^\s*import\s[^;]*?from\s*['"](dgram|os|net|fs|child_process)['"]/m, `${rel} statically imports a Node built-in module`);
    assert.doesNotMatch(src, /\brequire\s*\(/, `${rel} uses require`);
  }
});
