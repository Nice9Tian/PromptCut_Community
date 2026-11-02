/**
 * 成本记录模块（`server/docservice/modules/costs.mjs`；语义 `mechanism/document-service.md`「成本记录」；
 * 契约 `docs/plan/c10-contract.md` 第 3 节）。用例 CC-01～CC-10。
 * 跑：node --test server/test/c10-cost-docservice.test.mjs
 *
 * 前半经真的共享项目组装（`auth-kit.mjs` 的托管端、真的证明握手）：写、覆盖、读全部、跨项目隔离、非成员被拒、坏形状被拒；
 * 后半直接驱动模块（假的核心上下文）：「最新」按测量时刻、日志回放、上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostFor, createProject, join, ask, PROTOCOL } from './auth-kit.mjs';
import { costsModule, COSTS_LIMITS } from '../docservice/modules/costs.mjs';
import { createFileStore, createMemoryStore } from '../docservice/store/index.mjs';
import { describeEnvironment } from '../render-node/fingerprint.mjs';

const R = (i) => `198.51.100.${i}`;
const T0 = 1_790_000_000_000;
const WIN_NV = { platform: 'Windows', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)' };
const MAC = { platform: 'macOS', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', vendor: 'Google Inc. (Apple)' };
const fpOf = (env) => describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;
const rec = (identityKey, stepMs, extra = {}) => ({ identityKey, stepMs, samples: 16, measuredAt: T0, mode: 'dev', ...extra });

async function twoProjects(t) {
  const env = await hostFor(t);
  const P = await createProject(env, { mode: 'free' });
  const Q = await createProject(env, { mode: 'free' });
  const p1 = await join(env, P, { username: 'pam', remote: R(1) });
  const p2 = await join(env, P, { username: 'pete', remote: R(2) });
  const q1 = await join(env, Q, { username: 'quinn', remote: R(3) });
  return { env, P, Q, p1, p2, q1 };
}

test('CC-01 read all after a member writes: the key is the card identity + a fingerprint the server computes from the original environment, and the response carries this machine\'s fingerprint', async (t) => {
  const { P, p1, p2 } = await twoProjects(t);
  const put = await ask(p1, { type: 'cost.put', projectId: P.projectId, environment: WIN_NV, records: [rec('cardA', 4.5), rec('cardB', 31.25, { mode: 'build', samples: 24 })] }, 'cost.stored');
  assert.equal(put.type, 'cost.stored', JSON.stringify(put));
  assert.equal(put.envFingerprint, fpOf(WIN_NV));
  assert.deepEqual([put.added, put.updated, put.ignored, put.count], [2, 0, 0, 2]);
  // 同项目的另一位成员读得到全部；带环境时顺带回它的指纹
  const list = await ask(p2, { type: 'cost.list', projectId: P.projectId, environment: MAC }, 'cost.listing');
  assert.equal(list.type, 'cost.listing', JSON.stringify(list));
  assert.equal(list.envFingerprint, fpOf(MAC));
  assert.equal(list.truncated, false);
  assert.deepEqual(list.records, [
    { identityKey: 'cardA', envFingerprint: fpOf(WIN_NV), stepMs: 4.5, samples: 16, measuredAt: T0, mode: 'dev' },
    { identityKey: 'cardB', envFingerprint: fpOf(WIN_NV), stepMs: 31.25, samples: 24, measuredAt: T0, mode: 'build' },
  ]);
});

test('CC-02 only the latest record is kept per key; other environments each take their own record; reading all returns both environments', async (t) => {
  const { P, p1, p2 } = await twoProjects(t);
  await ask(p1, { type: 'cost.put', projectId: P.projectId, environment: WIN_NV, records: [rec('cardA', 4.5)] }, 'cost.stored');
  const over = await ask(p1, { type: 'cost.put', projectId: P.projectId, environment: WIN_NV, records: [rec('cardA', 6, { measuredAt: T0 + 1000 })] }, 'cost.stored');
  assert.deepEqual([over.added, over.updated, over.count], [0, 1, 1]);
  // 别的机器（mac）测同一张卡：另一条
  const mac = await ask(p2, { type: 'cost.put', projectId: P.projectId, environment: MAC, records: [rec('cardA', 12)] }, 'cost.stored');
  assert.deepEqual([mac.added, mac.count], [1, 2]);
  // 更旧的一条补传过来：不替换
  const stale = await ask(p1, { type: 'cost.put', projectId: P.projectId, envFingerprint: fpOf(WIN_NV), records: [rec('cardA', 99, { measuredAt: T0 - 5 })] }, 'cost.stored');
  assert.deepEqual([stale.added, stale.updated, stale.ignored], [0, 0, 1]);
  const list = await ask(p1, { type: 'cost.list', projectId: P.projectId }, 'cost.listing');
  const byEnv = Object.fromEntries(list.records.map((r) => [r.envFingerprint, r.stepMs]));
  assert.deepEqual(byEnv, { [fpOf(WIN_NV)]: 6, [fpOf(MAC)]: 12 });
  assert.equal(list.envFingerprint, undefined, 'No fingerprint is returned when no environment is sent');
});

test('CC-03 cross-project isolation: same-named keys are independent; a member reading or writing another project gets forbidden', async (t) => {
  const { P, Q, p1, q1 } = await twoProjects(t);
  await ask(p1, { type: 'cost.put', projectId: P.projectId, environment: WIN_NV, records: [rec('same', 1)] }, 'cost.stored');
  await ask(q1, { type: 'cost.put', projectId: Q.projectId, environment: WIN_NV, records: [rec('same', 2)] }, 'cost.stored');
  const lp = await ask(p1, { type: 'cost.list', projectId: P.projectId }, 'cost.listing');
  const lq = await ask(q1, { type: 'cost.list', projectId: Q.projectId }, 'cost.listing');
  assert.deepEqual(lp.records.map((r) => r.stepMs), [1]);
  assert.deepEqual(lq.records.map((r) => r.stepMs), [2]);
  // Q 的成员拿 P 的项目号：读、写都拒
  const readOther = await ask(q1, { type: 'cost.list', projectId: P.projectId }, 'cost.listing');
  assert.equal(readOther.type, 'error');
  assert.equal(readOther.reason, 'forbidden');
  const writeOther = await ask(q1, { type: 'cost.put', projectId: P.projectId, environment: WIN_NV, records: [rec('same', 3)] }, 'cost.stored');
  assert.equal(writeOther.reason, 'forbidden');
  const again = await ask(p1, { type: 'cost.list', projectId: P.projectId }, 'cost.listing');
  assert.deepEqual(again.records.map((r) => r.stepMs), [1], 'P\'s records are untouched');
});

test('CC-04 a connection that is not a member: the local identity cannot read the shared project\'s records (the local space is a separate one)', async (t) => {
  const { env, P, p1 } = await twoProjects(t);
  await ask(p1, { type: 'cost.put', projectId: P.projectId, environment: WIN_NV, records: [rec('cardA', 1)] }, 'cost.stored');
  const local = await env.open([PROTOCOL]);
  const l = await ask(local, { type: 'cost.list', projectId: P.projectId }, 'cost.listing');
  assert.equal(l.type, 'cost.listing');
  assert.deepEqual(l.records, [], 'The same-named project in the local space is empty');
});

test('CC-05 a malformed record is rejected as a whole and nothing is stored', async (t) => {
  const { P, p1 } = await twoProjects(t);
  const cases = [
    { projectId: P.projectId, environment: WIN_NV, records: [] },
    { projectId: P.projectId, environment: WIN_NV, records: [rec('ok', 1), rec('bad', -1)] },
    { projectId: P.projectId, environment: WIN_NV, records: [rec('bad', 1, { samples: 0 })] },
    { projectId: P.projectId, environment: WIN_NV, records: [rec('bad', 1, { mode: 'prod' })] },
    { projectId: P.projectId, environment: WIN_NV, records: [rec('bad', 1, { measuredAt: 'now' })] },
    { projectId: P.projectId, environment: WIN_NV, records: [rec('bad key/with slash', 1)] },
    { projectId: P.projectId, records: [rec('ok', 1)] },
    { projectId: P.projectId, environment: WIN_NV, envFingerprint: fpOf(WIN_NV), records: [rec('ok', 1)] },
    { projectId: P.projectId, envFingerprint: 'XYZ', records: [rec('ok', 1)] },
    { projectId: P.projectId, environment: 'windows', records: [rec('ok', 1)] },
    { projectId: '', environment: WIN_NV, records: [rec('ok', 1)] },
    { projectId: P.projectId, environment: WIN_NV, records: 'nope' },
  ];
  for (const body of cases) {
    const r = await ask(p1, { type: 'cost.put', ...body }, 'cost.stored');
    assert.equal(r.type, 'error', JSON.stringify(body).slice(0, 160));
    assert.equal(r.reason, 'bad-message', JSON.stringify(r));
  }
  const unknown = await ask(p1, { type: 'cost.drop', projectId: P.projectId }, 'cost.stored');
  assert.equal(unknown.reason, 'unsupported');
  const l = await ask(p1, { type: 'cost.list', projectId: P.projectId }, 'cost.listing');
  assert.deepEqual(l.records, [], 'None of the malformed attempts stored a single record');
});

/* ---------------------------------------------------------------- 模块本体 */

function fakeCtx(t0 = T0) {
  const sent = [];
  return { sent, now: () => t0, send: (connId, m) => sent.push({ connId, ...m }), publish: () => 0, subscribe() {}, unsubscribe() {} };
}

test('CC-06 direct module test: admin identity gets forbidden; a shared space accepts only the project named by the space', () => {
  const ctx = fakeCtx();
  const m = costsModule({ space: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa' });
  m.connect(ctx, 1, { userId: 'u', tenantId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', scope: 'member' });
  m.connect(ctx, 2, { userId: 'admin', tenantId: null, scope: 'admin' });
  m.handle(ctx, 1, { type: 'cost.list', projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb', reqId: 'a' });
  m.handle(ctx, 2, { type: 'cost.list', projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', reqId: 'b' });
  m.handle(ctx, 1, { type: 'cost.list', projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', reqId: 'c' });
  assert.deepEqual(ctx.sent.map((s) => [s.reqId, s.type, s.reason ?? null]), [['a', 'error', 'forbidden'], ['b', 'error', 'forbidden'], ['c', 'cost.listing', null]]);
});

test('CC-07 log replay: after a restart the same key still holds the record with the latest measurement time; colons in file names are encoded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-costs-'));
  try {
    const ctx = fakeCtx();
    const a = costsModule({ store: createFileStore({ dir, log: () => {} }) });
    a.connect(ctx, 1, { userId: 'local', tenantId: 'local', scope: 'local' });
    a.handle(ctx, 1, { type: 'cost.put', projectId: 'demo:1', envFingerprint: '0123456789abcdef', records: [rec('k1', 5, { measuredAt: T0 + 10 }), rec('k2', 7)] });
    a.handle(ctx, 1, { type: 'cost.put', projectId: 'demo:1', envFingerprint: '0123456789abcdef', records: [rec('k1', 50, { measuredAt: T0 })] });
    assert.equal(ctx.sent.at(-1).ignored, 1);
    const b = costsModule({ store: createFileStore({ dir, log: () => {} }) });
    b.connect(ctx, 2, { userId: 'local', tenantId: 'local', scope: 'local' });
    b.handle(ctx, 2, { type: 'cost.list', projectId: 'demo:1' });
    const listing = ctx.sent.at(-1);
    assert.deepEqual(listing.records.map((r) => [r.identityKey, r.stepMs]), [['k1', 5], ['k2', 7]]);
    const files = fs.readdirSync(path.join(dir, 'costs'));
    assert.ok(files.includes('demo%3A1.ndjson'), files.join(','));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CC-08 limits: writing too much at once, or a full project record set, returns too-large; reading all beyond the limit is truncated and marked truncated', () => {
  const ctx = fakeCtx();
  const m = costsModule({ store: createMemoryStore(), limits: { MAX_PUT: 3, MAX_RECORDS: 4, MAX_LIST: 2 } });
  m.connect(ctx, 1, { userId: 'local', tenantId: 'local', scope: 'local' });
  const fp = '0123456789abcdef';
  m.handle(ctx, 1, { type: 'cost.put', projectId: 'p', envFingerprint: fp, records: [rec('a', 1), rec('b', 1), rec('c', 1), rec('d', 1)] });
  assert.equal(ctx.sent.at(-1).reason, 'too-large');
  m.handle(ctx, 1, { type: 'cost.put', projectId: 'p', envFingerprint: fp, records: [rec('a', 1), rec('b', 1, { measuredAt: T0 + 2 }), rec('c', 1, { measuredAt: T0 + 3 })] });
  m.handle(ctx, 1, { type: 'cost.put', projectId: 'p', envFingerprint: fp, records: [rec('d', 1, { measuredAt: T0 + 4 })] });
  assert.equal(ctx.sent.at(-1).count, 4);
  m.handle(ctx, 1, { type: 'cost.put', projectId: 'p', envFingerprint: fp, records: [rec('e', 1)] });
  assert.equal(ctx.sent.at(-1).reason, 'too-large', 'When full, no new keys may be added');
  m.handle(ctx, 1, { type: 'cost.put', projectId: 'p', envFingerprint: fp, records: [rec('a', 2, { measuredAt: T0 + 9 })] });
  assert.equal(ctx.sent.at(-1).updated, 1, 'When full, existing keys can still be replaced');
  m.handle(ctx, 1, { type: 'cost.list', projectId: 'p' });
  const l = ctx.sent.at(-1);
  assert.equal(l.truncated, true);
  assert.deepEqual(l.records.map((r) => r.identityKey), ['a', 'd'], 'Keeps the two records with the latest measurement time');
  assert.equal(COSTS_LIMITS.MAX_PUT, 500);
});

test('CC-09 the module is attached through assembly: costs is in the module table of /healthz', async (t) => {
  const { env } = await twoProjects(t);
  const names = JSON.stringify(env.service.describe());
  assert.ok(names.includes('costs'), names.slice(0, 400));
});
