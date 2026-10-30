/**
 * M7「纯浏览器节点」队列与凭证一侧（契约 `docs/plan/m7-contract.md`，按第 13 节主会话裁定）。
 * 跑：node --experimental-test-module-mocks --test server/test/m7-queue.test.mjs
 *
 *   M7Q-D1  切分方对浏览器可做的卡按两种指纹各出一份（`splitPlan` 的 `browserFingerprints`）；
 *           浏览器指纹以文档服务上本项目在线、同一用户的 browser 节点为准（plan 的 `task.claimed` 带 `browserFingerprints`）；
 *           建锁时作废另一份（`input.dual` 为真、还 open 的异指纹任务）；作废过的任务可以重新发布
 *   M7Q-D2  锁闲置接手：回包带 `lockIdleMs` / `lockedByProfile`（另带 `lockUndone`）；续约刷新 `touchedAt`；
 *           切分方闲置超 30 s、锁定方还没做完才带 takeover 重发（`idleLockTakeover`）
 *   M7Q-D9  render 票据的 `owner: { kind: 'browser' }`：队列模块固定 profile；nodeId 绑到 userId
 *   M7Q-D10 页面报原始环境值，队列模块按 describeEnvironment 算指纹、node.welcome 回给页面
 *   M7Q-D14 非 Chromium 内核的浏览器拒当节点（`not-chromium`）
 *   M7Q-D12 层表 v 3：每层带候选；页面读 v 2 时当作一个候选
 *   M7Q-D11 `session.mjs` 与细任务编排（`task-runner.mjs`）不引 `node:` 内置模块、不引 `split.mjs` / 队列本体
 *
 * 结果键、指纹用 `node:crypto` 自己算，不借实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRenderQueue, clipsPlanTaskOf } from '../render-queue/index.mjs';
import * as queueConstants from '../render-queue/constants.mjs';
import { splitPlan, planTaskOf } from '../render-node/split.mjs';
import * as localNodeModule from '../render-node/local-node.mjs';
import * as fingerprintModule from '../render-node/fingerprint.mjs';
import { renderQueueModule } from '../docservice/modules/render-queue.mjs';
import { normalizeOwner } from '../auth/protocol.mjs';
import * as transfer from '../artifact-transfer.mjs';
import { CARD_LOCK_IDLE_MS } from '../card-lock.mjs';
import { createQueueHarness, makeTaskInput, T0 } from './fake-render-queue-env.mjs';

const { createLocalNode } = localNodeModule;
const { describeEnvironment } = fingerprintModule;

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);

const P = 'pppppppppppppppp';    // 切分方（pc / host）自己的指纹
const B = 'bbbbbbbbbbbbbbbb';    // 浏览器的指纹
const X = 'xxxxxxxxxxxxxxxx';    // 第三种环境
const CV = 'c0de5a';

/* ================================================================== 切分（D1） */

const SHARED_INDEPENDENT = { frameMode: 'stateful', compositing: 'independent' };

function control({ clipId, contentKey, tier = 'shared', capabilities = SHARED_INDEPENDENT, count = 70, cardId, start = 0 }) {
  return {
    key: `png-${clipId}`, snapshotKey: rk(contentKey, P), contentKey, tier, capabilities, clipId, cardId,
    nodeId: `n:${clipId}`, start, end: start + count / 30, count,
    sampling: { firstFrame: Math.ceil(start * 30 - 1e-9), fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
    compositing: capabilities.compositing, envFingerprint: P,
  };
}

const PLAN = planTaskOf({ projectId: 'proj-m7', projectRev: 4 });
const weightOf = (c) => ({ class: c.capabilities?.canvasHeavy === true || c.tier === 'local' || c.compositing !== 'independent' ? 'heavy' : 'medium', estMs: null });
const splitArgs = (over = {}) => ({
  planTask: PLAN, entryKey: 'entry-1', envFingerprint: P, codeVersion: CV, weightOf, ...over,
});

test('M7Q-D1-S1 不给 browserFingerprints（或给空表）：切分与原来完全相同，不加 dual / bake / compositing', () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a' });
  const before = splitPlan(splitArgs({ cardPlan: [a] }));
  const empty = splitPlan(splitArgs({ cardPlan: [a], browserFingerprints: [] }));
  assert.deepEqual(empty, before);
  assert.equal(before.length, 2, '70 帧切两段');
  for (const t of before) {
    assert.equal(t.requires.envFingerprint, P);
    assert.equal(t.resultKey, rk('ck-a', P));
    assert.equal('dual' in t.input, false);
    assert.equal('bake' in t.input, false);
    assert.equal('compositing' in t.input, false);
  }
});

test('M7Q-D1-S2 浏览器可做的卡：先出自己的一份、再出浏览器的一份；两份都带 input.dual，浏览器那份另带 bake 与 compositing，都不带 takeover', () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 70, start: 1 });
  const tasks = splitPlan(splitArgs({ cardPlan: [a], browserFingerprints: [B] }));
  assert.equal(tasks.length, 4, '两段 × 两种指纹');
  const own = tasks.filter((t) => t.requires.envFingerprint === P);
  const browser = tasks.filter((t) => t.requires.envFingerprint === B);
  assert.equal(own.length, 2);
  assert.equal(browser.length, 2);
  assert.ok(tasks.indexOf(own[0]) < tasks.indexOf(browser[0]), '自己的那份在前');
  for (const t of own) {
    assert.equal(t.resultKey, rk('ck-a', P));
    assert.equal(t.input.dual, true);
    assert.equal('takeover' in t, false);
  }
  for (const t of browser) {
    assert.equal(t.resultKey, rk('ck-a', B));
    assert.equal(t.id, `snapshot:${rk('ck-a', B)}:${t.range.from}-${t.range.to}`);
    assert.equal(t.input.dual, true);
    assert.equal(t.input.compositing, 'independent');
    assert.deepEqual(t.input.bake, { start: a.start, end: a.end, count: a.count, sampling: a.sampling });
    assert.equal(t.input.contentKey, 'ck-a');
    assert.equal(t.input.clipId, 'a');
    assert.equal(t.tier, 'shared');
    assert.equal(t.weight.class, 'medium');
    assert.deepEqual(t.requires.cardSources, {});
    assert.equal(t.requires.userCards, false);
    assert.equal(t.requires.graphCards, false);
    assert.equal('takeover' in t, false);
  }
  // 同一段两份的优先级一样（锚帧照旧）
  assert.deepEqual(own.map((t) => t.priority), browser.map((t) => t.priority));
});

test('M7Q-D1-S3 浏览器做不了的卡只出自己那一份：本地档、非独立卡、用户卡、素材效果卡、改过源码、重、只在发布方本机的素材', () => {
  const cases = [
    ['本地档', control({ clipId: 'l', contentKey: 'ck-l', tier: 'local', capabilities: { frameMode: 'stateful', compositing: 'belowDependent' } }), {}],
    ['非独立卡（sourceDependent）', control({ clipId: 's', contentKey: 'ck-s', capabilities: { frameMode: 'stateful', compositing: 'sourceDependent' } }), { weightOf: () => ({ class: 'medium', estMs: null }) }],
    ['用户卡', control({ clipId: 'u', contentKey: 'ck-u' }), { isUserCard: () => true }],
    ['素材效果卡', control({ clipId: 'g', contentKey: 'ck-g' }), { isGraphCard: () => true }],
    ['改过源码', control({ clipId: 'c', contentKey: 'ck-c', cardId: 'title' }), { cardSourceVersions: { title: 'user:abc' } }],
    ['重', control({ clipId: 'h', contentKey: 'ck-h', capabilities: { frameMode: 'stateful', compositing: 'independent', canvasHeavy: true } }), {}],
    ['只在发布方本机的素材', control({ clipId: 'm', contentKey: 'ck-m' }), { localMedia: 'pc-1', usesLocalMedia: () => true }],
  ];
  for (const [label, ctl, extra] of cases) {
    const tasks = splitPlan(splitArgs({ cardPlan: [ctl], browserFingerprints: [B], ...extra }));
    assert.ok(tasks.length > 0, label);
    assert.ok(tasks.every((t) => t.requires.envFingerprint === P), `${label}：只有自己的指纹`);
    assert.ok(tasks.every((t) => !('dual' in t.input) && !('bake' in t.input)), `${label}：不加 dual / bake`);
  }
});

test('M7Q-D1-S4 浏览器指纹与自己相同：只出一份（不重复、不带 dual）；多个浏览器指纹去重', () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const same = splitPlan(splitArgs({ cardPlan: [a], browserFingerprints: [P] }));
  assert.equal(same.length, 1);
  assert.equal('dual' in same[0].input, false);
  const two = splitPlan(splitArgs({ cardPlan: [a], browserFingerprints: [B, B, P, '', null] }));
  assert.deepEqual(two.map((t) => t.requires.envFingerprint), [P, B]);
});

test('M7Q-D1-S5 已锁的卡照锁出一份：锁在浏览器指纹上只出浏览器那份（带 bake），锁在自己或第三种环境上照旧', () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const lockKey = 'snapshot:ck-a';
  const onB = splitPlan(splitArgs({ cardPlan: [a], browserFingerprints: [B], cardLocks: { [lockKey]: B } }));
  assert.deepEqual(onB.map((t) => t.requires.envFingerprint), [B]);
  assert.equal(onB[0].input.compositing, 'independent');
  assert.ok(onB[0].input.bake, '锁在浏览器指纹上：那份仍带 bake');
  assert.equal('dual' in onB[0].input, false, '只有一份，不带 dual');
  const onP = splitPlan(splitArgs({ cardPlan: [a], browserFingerprints: [B], cardLocks: { [lockKey]: P } }));
  assert.deepEqual(onP.map((t) => t.requires.envFingerprint), [P]);
  const onX = splitPlan(splitArgs({ cardPlan: [a], browserFingerprints: [B], cardLocks: { [lockKey]: X } }));
  assert.deepEqual(onX.map((t) => t.requires.envFingerprint), [X]);
  // 接手：锁在 B 上、接手 → 只出自己那一份，带 takeover
  const take = splitPlan(splitArgs({ cardPlan: [a], browserFingerprints: [B], cardLocks: { [lockKey]: B }, takeover: true }));
  assert.deepEqual(take.map((t) => [t.requires.envFingerprint, t.takeover]), [[P, true]]);
});

/* ================================================================== 队列（D1、D2、D9） */

function snap(ck, fp, from = 0, { to = from + 59, projectId = 'p1', dual = false, input, ...rest } = {}) {
  return makeTaskInput({
    projectId, kind: 'snapshot', resultKey: rk(ck, fp), range: [from, to],
    input: input ?? { clipId: `clip-${ck}`, contentKey: ck, ...(dual ? { dual: true } : {}) },
    requires: { envFingerprint: fp },
    ...rest,
  });
}

/** 发布方 p（u1）、切分节点 pc（指纹 P）、同用户的浏览器节点 bw（指纹 B，只 watch p1） */
function setup() {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub-p');
  h.node('pc', 'node-pc', { hello: { envFingerprint: P } });
  h.node('bw', 'node-bw', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: B } });
  h.bus.clear();
  return h;
}
const published = (out, conn) => out.one(conn, 'task.published').results;

test('M7Q-D1-Q1 plan 的 task.claimed 带本项目在线、同一用户、watch 着它的 browser 节点的指纹；没有就不带这一项', () => {
  const h = setup();
  // 别的用户的浏览器、没 watch 这个项目的浏览器、pc 节点都不算
  h.node('bw2', 'node-bw2', { profile: 'browser', userId: 'u2', watch: ['p1'], hello: { envFingerprint: X } });
  h.node('bw3', 'node-bw3', { profile: 'browser', watch: ['other'], hello: { envFingerprint: X } });
  h.node('bw4', 'node-bw4', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: B } });   // 同指纹去重
  const plan = clipsPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['a'], codeVersion: CV });
  h.publish('p', [plan]);
  const claimed = h.claim('pc', plan.id, 1).one('pc', 'task.claimed');
  assert.deepEqual(claimed.browserFingerprints, [B]);

  // 浏览器节点断开之后：不带
  const h2 = setup();
  h2.disconnect('bw');
  h2.publish('p', [plan]);
  const c2 = h2.claim('pc', plan.id, 1).one('pc', 'task.claimed');
  assert.equal('browserFingerprints' in c2, false);
});

test('M7Q-D1-Q2 两份都 open 时，切分方认领自己那份建锁：浏览器那份（dual）整张卡作废 superseded，attempts 不加；订阅者收 task.failed', () => {
  const h = setup();
  const own0 = snap('ck1', P, 0, { dual: true }), own1 = snap('ck1', P, 60, { dual: true });
  const br0 = snap('ck1', B, 0, { dual: true }), br1 = snap('ck1', B, 60, { dual: true });
  const other = snap('ck2', B, 0, { dual: true });   // 别的卡不受影响
  h.publish('p', [own0, own1, br0, br1, other]);
  const out = h.claim('pc', own0.id, 1);
  assert.ok(out.one('pc', 'task.claimed'));
  for (const t of [br0, br1]) {
    const v = h.task(t.id);
    assert.deepEqual([v.state, v.lastError, v.attempts], ['failed', 'superseded', 0], t.id);
  }
  assert.equal(h.task(own1.id).state, 'open', '自己那份的其余段照常');
  assert.equal(h.task(other.id).state, 'open', '别的卡不动');
  assert.deepEqual(out.of('p', 'task.failed').map((m) => [m.id, m.error]).sort(), [[br0.id, 'superseded'], [br1.id, 'superseded']].sort());
});

test('M7Q-D1-Q3 浏览器先认领：切分方那份（dual）作废；不带 dual 的异指纹任务行为不变', () => {
  const h = setup();
  const own0 = snap('ck1', P, 0, { dual: true });
  const br0 = snap('ck1', B, 0, { dual: true });
  const legacy = snap('ck1', X, 60);   // 不带 dual：留着（被锁挡住，行为同改动之前）
  h.publish('p', [own0, br0, legacy]);
  assert.ok(h.claim('bw', br0.id, 1).one('bw', 'task.claimed'));
  assert.deepEqual([h.task(own0.id).state, h.task(own0.id).lastError], ['failed', 'superseded']);
  assert.equal(h.task(legacy.id).state, 'open');
});

test('M7Q-D1-Q4 作废过的任务可以重新发布：锁回到它的指纹上（或带 takeover）就重建，锁还在别处就回 card-locked', () => {
  const h = setup();
  const own0 = snap('ck1', P, 0, { dual: true });
  const br0 = snap('ck1', B, 0, { dual: true });
  h.publish('p', [own0, br0]);
  h.claim('bw', br0.id, 1);
  assert.equal(h.task(own0.id).lastError, 'superseded');
  const r1 = published(h.publish('p', [snap('ck1', P, 0)]), 'p')[0];
  assert.equal(r1.error, 'card-locked', '锁在 B 上、没带 takeover：拒建');
  assert.equal(r1.lockedBy, B);
  const r2 = published(h.publish('p', [{ ...snap('ck1', P, 0), takeover: true }]), 'p')[0];
  assert.deepEqual([r2.created, r2.state], [true, 'open'], '带 takeover：作废的记录当不存在，重建');
  assert.equal(h.describe().locks.find((l) => l.lockKey === 'snapshot:ck1').envFingerprint, P);
});

test('M7Q-D2-L1 发布被锁拒建：回包带 lockIdleMs、lockedByProfile 与 lockUndone', () => {
  const h = setup();
  const br0 = snap('ck1', B, 0), br1 = snap('ck1', B, 60);
  h.publish('p', [br0, br1]);
  h.claim('bw', br0.id, 1);
  h.clock.advance(45_000);
  const r = published(h.publish('p', [snap('ck1', P, 0)]), 'p')[0];
  assert.equal(r.error, 'card-locked');
  assert.equal(r.lockedBy, B);
  assert.equal(r.lockIdleMs, 45_000);
  assert.equal(r.lockedByProfile, 'browser');
  assert.equal(r.lockUndone, 2, '锁定方这张卡还有两段没做完');
});

test('M7Q-D2-L2 认领被锁拒绝（card-locked）：回包带 lockIdleMs 与 lockedByProfile', () => {
  const h = setup();
  const own0 = snap('ck1', P, 0), br0 = snap('ck1', B, 0);
  h.publish('p', [own0, br0]);
  h.claim('bw', br0.id, 1);
  h.clock.advance(12_000);
  // 前置过滤把 own0 对 pc 藏了起来，但 pc 仍可能拿着旧视图来认领
  const rej = h.claim('pc', own0.id, 1).one('pc', 'task.claim-rejected');
  assert.equal(rej.reason, 'card-locked');
  assert.equal(rej.lockedBy, B);
  assert.equal(rej.lockIdleMs, 12_000);
  assert.equal(rej.lockedByProfile, 'browser');
});

test('M7Q-D2-L3 续约（task.progress）也刷新锁的 touchedAt', () => {
  const h = setup();
  const br0 = snap('ck1', B, 0);
  h.publish('p', [br0]);
  const c = h.claim('bw', br0.id, 1).one('bw', 'task.claimed');
  h.clock.advance(20_000);
  h.progress('bw', br0.id, c.token, 5);
  assert.equal(h.describe().locks.find((l) => l.lockKey === 'snapshot:ck1').touchedAt, T0 + 20_000);
  h.clock.advance(7_000);
  h.progress('bw', br0.id, c.token, 5);   // done 没变也刷新
  assert.equal(h.describe().locks.find((l) => l.lockKey === 'snapshot:ck1').touchedAt, T0 + 27_000);
});

test('M7Q-D2-L4 做完了的锁 lockUndone 为 0', () => {
  const h = setup();
  const br0 = snap('ck1', B, 0);
  h.publish('p', [br0]);
  const c = h.claim('bw', br0.id, 1).one('bw', 'task.claimed');
  h.complete('bw', br0.id, c.token, {});
  h.clock.advance(60_000);
  const r = published(h.publish('p', [snap('ck1', P, 0)]), 'p')[0];
  assert.deepEqual([r.error, r.lockUndone], ['card-locked', 0]);
});

test('M7Q-D9-Q5 同一个 nodeId 不能被别的 userId 报到（回 forbidden，原节点不受影响）', () => {
  const h = setup();
  const out = h.node('evil', 'node-bw', { profile: 'pc', userId: 'u2', watch: null, hello: { envFingerprint: B } });
  const err = out.one('evil', 'error');
  assert.equal(err.reason, 'forbidden');
  assert.equal(out.of('evil', 'node.welcome').length, 0);
  assert.equal(h.nodeInfo('node-bw').profile, 'browser');
  assert.equal(h.nodeInfo('node-bw').connected, true);
  // 同一个 userId 换连接照旧取代
  const again = h.node('bw-new', 'node-bw', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: B } });
  assert.ok(again.one('bw-new', 'node.welcome'));
});

test('M7Q-D10-Q6 node.welcome 回这个节点的指纹', () => {
  const h = createQueueHarness(createRenderQueue);
  const out = h.node('a', 'node-a', { hello: { envFingerprint: P } });
  assert.equal(out.one('a', 'node.welcome').envFingerprint, P);
  const none = h.node('b', 'node-b');
  assert.equal(none.one('b', 'node.welcome').envFingerprint, null);
});

/* ================================================================== 队列模块（D9、D10、D14） */

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const UA_EDGE = `${UA_CHROME} Edg/138.0.3351.65`;
const UA_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const UA_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const UA_IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1';
const GL = { renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)' };
const envOf = (userAgent, platform = 'Win32') => ({ platform, userAgent, ...GL });
const fpOfEnv = (env) => describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;

function moduleRig() {
  const sent = [];
  const send = (connId, message) => sent.push({ connId, message });
  let now = T0;
  const q = createRenderQueue({ now: () => now, send });
  const mod = renderQueueModule(q);
  const ctx = {
    send, now: () => now, log: () => {}, publish: () => 0, subscribe: () => {}, unsubscribe: () => {},
  };
  const rig = {
    q, mod, sent,
    connect(connId, principal) { mod.connect(ctx, connId, principal); },
    handle(connId, msg) { const from = sent.length; mod.handle(ctx, connId, msg); return sent.slice(from).filter((e) => e.connId === connId).map((e) => e.message); },
  };
  return rig;
}
const member = (userId, owner = { kind: 'user' }) => ({ userId, tenantId: 'proj-1', scope: 'member', role: 'render', owner, username: userId.split('@')[0], deviceId: userId.split('@')[1] });
const browserOwner = (userId) => member(userId, { kind: 'browser' });

test('M7Q-D9-M1 owner: browser 的连接只能以 browser 报到；以 pc / host 报到回 forbidden，不登记节点', () => {
  const rig = moduleRig();
  rig.connect('c1', browserOwner('alice@d1'));
  for (const profile of ['pc', 'host']) {
    const out = rig.handle('c1', { type: 'node.hello', nodeId: 'bn-1', profile, environment: envOf(UA_CHROME), reqId: profile });
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].type, out[0].reason, out[0].reqId], ['error', 'forbidden', profile]);
  }
  assert.deepEqual(rig.mod.describeConn('c1').roles, []);
  assert.equal(rig.q.describe().nodes.length, 0);
  const ok = rig.handle('c1', { type: 'node.hello', nodeId: 'bn-1', profile: 'browser', environment: envOf(UA_CHROME) });
  assert.equal(ok[0].type, 'node.welcome');
});

test('M7Q-D10-M2 页面报原始环境值：队列模块按 describeEnvironment 算指纹，node.welcome 回给页面；自报的 envFingerprint 不作数', () => {
  const rig = moduleRig();
  rig.connect('c1', browserOwner('alice@d1'));
  const env = envOf(UA_EDGE);
  const out = rig.handle('c1', { type: 'node.hello', nodeId: 'bn-1', profile: 'browser', envFingerprint: 'forged-fp', environment: env });
  const welcome = out.find((m) => m.type === 'node.welcome');
  assert.ok(welcome, JSON.stringify(out));
  assert.equal(welcome.envFingerprint, fpOfEnv(env));
  assert.equal(rig.mod.describeConn('c1').node.envFingerprint, fpOfEnv(env));
  assert.equal(rig.mod.describeConn('c1').node.profile, 'browser');
});

test('M7Q-D10-M3 owner: browser 的连接不报环境：回 bad-message，不登记', () => {
  const rig = moduleRig();
  rig.connect('c1', browserOwner('alice@d1'));
  const out = rig.handle('c1', { type: 'node.hello', nodeId: 'bn-1', profile: 'browser', envFingerprint: B });
  assert.deepEqual([out[0].type, out[0].reason], ['error', 'bad-message']);
  assert.equal(rig.q.describe().nodes.length, 0);
});

test('M7Q-D14-M4 非 Chromium 内核的浏览器拒当节点：回 error { reason: not-chromium }', () => {
  for (const ua of [UA_FIREFOX, UA_SAFARI, UA_IOS_CHROME, '']) {
    const rig = moduleRig();
    rig.connect('c1', browserOwner('alice@d1'));
    const out = rig.handle('c1', { type: 'node.hello', nodeId: 'bn-1', profile: 'browser', environment: envOf(ua, 'MacIntel'), reqId: 7 });
    assert.deepEqual([out[0].type, out[0].reason, out[0].reqId], ['error', 'not-chromium', 7], ua);
    assert.equal(rig.q.describe().nodes.length, 0, ua);
  }
  assert.equal(fingerprintModule.isChromiumUserAgent(UA_CHROME), true);
  assert.equal(fingerprintModule.isChromiumUserAgent(UA_EDGE), true);
  assert.equal(fingerprintModule.isChromiumUserAgent(UA_FIREFOX), false);
  assert.equal(fingerprintModule.isChromiumUserAgent(UA_SAFARI), false);
});

test('M7Q-D9-M5 nodeId 绑到 userId：别的用户拿同一个 nodeId 报到回 forbidden；同一用户换连接照常', () => {
  const rig = moduleRig();
  rig.connect('c1', browserOwner('alice@d1'));
  rig.handle('c1', { type: 'node.hello', nodeId: 'bn-1', profile: 'browser', environment: envOf(UA_CHROME) });
  rig.connect('c2', member('bob@d2'));
  const out = rig.handle('c2', { type: 'node.hello', nodeId: 'bn-1', profile: 'pc', envFingerprint: P });
  assert.deepEqual([out[0].type, out[0].reason], ['error', 'forbidden']);
  assert.deepEqual(rig.mod.describeConn('c2').roles, [], '被拒的连接不记节点角色');
  rig.connect('c3', browserOwner('alice@d1'));
  const again = rig.handle('c3', { type: 'node.hello', nodeId: 'bn-1', profile: 'browser', environment: envOf(UA_CHROME) });
  assert.equal(again[0].type, 'node.welcome');
});

test('M7Q-D9-M6 不是 browser 归属的连接照旧：pc 自报指纹原样收下；带了 environment 又没自报时按它算', () => {
  const rig = moduleRig();
  rig.connect('c1', member('carol@d3'));
  const out = rig.handle('c1', { type: 'node.hello', nodeId: 'pc-1', profile: 'pc', envFingerprint: P });
  assert.equal(out[0].type, 'node.welcome');
  assert.equal(out[0].envFingerprint, P);
  rig.connect('c2', member('dave@d4'));
  const env = envOf(UA_CHROME);
  const out2 = rig.handle('c2', { type: 'node.hello', nodeId: 'pc-2', profile: 'pc', environment: env });
  assert.equal(out2[0].envFingerprint, fpOfEnv(env));
});

test('M7Q-D9-A1 归属多一种 { kind: browser }（auth-contract 第 5、8 节）', () => {
  assert.deepEqual(normalizeOwner({ kind: 'browser' }), { kind: 'browser' });
  assert.equal(normalizeOwner({ kind: 'browser', c: 1 }), null);
  assert.deepEqual(normalizeOwner({ kind: 'user' }), { kind: 'user' });
});

/* ================================================================== 切分方（local-node）：D1 接线、D2 接手、D12 写层表 */

/** 手动驱动的端点：发出的消息记下来，task.publish 由 `respond(tasks)` 决定回包 */
function scriptedEndpoint(respond) {
  let handler = () => {};
  const sent = [];
  return {
    sent,
    deliver: (m) => handler(m),
    send(message) {
      sent.push(message);
      if (message.type === 'task.publish') {
        const results = respond(message.tasks);
        queueMicrotask(() => handler({ type: 'task.published', reqId: message.reqId, results }));
      }
    },
    onMessage(h) { handler = h; },
  };
}

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function splitterRig({ respond, cardPlan, takeoverLocked, afterSplit }) {
  const endpoint = scriptedEndpoint(respond);
  const executor = {
    plan: async () => ({ entryKey: 'entry-1', cardPlan, weightOf, anchorFrames: [] }),
    render: async () => null,
    ...(afterSplit ? { afterSplit } : {}),
  };
  const sink = { has: async () => false, put: async () => ({ complete: true }) };
  const local = createLocalNode({
    nodeId: 'pc-1', node: { profile: 'pc', envFingerprint: P, codeVersions: [CV] }, endpoint, now: () => T0,
    codeVersion: CV, executor, sink, ...(takeoverLocked !== undefined ? { takeoverLocked } : {}),
  });
  local.start();
  return { endpoint, local, publishes: () => endpoint.sent.filter((m) => m.type === 'task.publish').map((m) => m.tasks) };
}
const listPlan = clipsPlanTaskOf({ projectId: 'proj-m7', projectRev: 4, clips: ['a'], codeVersion: CV });
const planView = { ...listPlan, source: { ...listPlan.source, userId: 'u1' }, state: 'claimed', version: 2, attempts: 0 };
const ok = (tasks) => tasks.map((t) => ({ id: t.id, state: 'open', version: 1, created: true }));

test('M7Q-D1-N1 切分方把 plan 认领回包里的 browserFingerprints 交给切分：浏览器可做的卡出两份', async () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const rig = splitterRig({ respond: ok, cardPlan: [a] });
  rig.endpoint.deliver({ type: 'task.claimed', id: listPlan.id, token: 2, version: 2, leaseUntil: T0 + 30_000, task: planView, browserFingerprints: [B] });
  await flush();
  const rounds = rig.publishes();
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0].map((t) => t.requires.envFingerprint), [P, B]);
  assert.ok(rig.endpoint.sent.some((m) => m.type === 'task.complete' && m.id === listPlan.id));
});

test('M7Q-D2-N2 idleLockTakeover：锁定方闲置超 30 s 且还没做完 → 带 takeover 按自己的指纹重发；否则照锁出键', async () => {
  assert.equal(typeof localNodeModule.idleLockTakeover, 'function', 'local-node 转出 idleLockTakeover');
  assert.equal(queueConstants.LOCK_IDLE_TAKEOVER_MS, CARD_LOCK_IDLE_MS, '与本机锁库同一个数');
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const scene = async (lockInfo) => {
    let round = 0;
    const respond = (tasks) => {
      round += 1;
      return tasks.map((t) => (round === 1 && t.requires.envFingerprint !== B
        ? { id: t.id, error: 'card-locked', lockedBy: B, ...lockInfo }
        : { id: t.id, state: 'open', version: 1, created: true }));
    };
    const rig = splitterRig({ respond, cardPlan: [a], takeoverLocked: localNodeModule.idleLockTakeover });
    rig.endpoint.deliver({ type: 'task.claimed', id: listPlan.id, token: 2, version: 2, leaseUntil: T0 + 30_000, task: planView });
    await flush();
    return rig.publishes();
  };
  const idle = await scene({ lockIdleMs: 45_000, lockedByProfile: 'browser', lockUndone: 1 });
  assert.equal(idle.length, 2);
  assert.deepEqual(idle[1].map((t) => [t.requires.envFingerprint, t.takeover === true]), [[P, true]], '接手');
  const busy = await scene({ lockIdleMs: 10_000, lockedByProfile: 'browser', lockUndone: 1 });
  assert.deepEqual(busy[1].map((t) => [t.requires.envFingerprint, t.takeover === true]), [[B, false]], '还在产：照锁出键');
  const edge = await scene({ lockIdleMs: 30_000, lockedByProfile: 'browser', lockUndone: 1 });
  assert.deepEqual(edge[1].map((t) => [t.requires.envFingerprint, t.takeover === true]), [[B, false]], '恰好 30 s 不算超');
  const done = await scene({ lockIdleMs: 45_000, lockedByProfile: 'browser', lockUndone: 0 });
  assert.deepEqual(done[1].map((t) => [t.requires.envFingerprint, t.takeover === true]), [[B, false]], '锁定方已做完：照锁投递，不重渲');
  const legacy = await scene({});
  assert.deepEqual(legacy[1].map((t) => [t.requires.envFingerprint, t.takeover === true]), [[B, false]], '旧队列不带这几项：不接手');
});

test('M7Q-D12-N3 切分完成后把最终发布成功的细任务交给 executor.afterSplit（写层表用），被拒建的不算', async () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const calls = [];
  let round = 0;
  const respond = (tasks) => {
    round += 1;
    return tasks.map((t) => (round === 1 && t.requires.envFingerprint === P
      ? { id: t.id, error: 'card-locked', lockedBy: B, lockIdleMs: 1_000, lockedByProfile: 'browser', lockUndone: 1 }
      : { id: t.id, state: 'open', version: 1, created: round === 1 }));
  };
  const rig = splitterRig({ respond, cardPlan: [a], afterSplit: async (planTask, info) => { calls.push({ planTask, info }); } });
  rig.endpoint.deliver({ type: 'task.claimed', id: listPlan.id, token: 2, version: 2, leaseUntil: T0 + 30_000, task: planView, browserFingerprints: [B] });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].planTask.id, listPlan.id);
  assert.deepEqual(calls[0].info.tasks.map((t) => [t.requires.envFingerprint, t.resultKey]), [[B, rk('ck-a', B)]]);
});

/* ================================================================== 层表 v 3（D12） */

function entryWith(controls) {
  return { key: 'entry-1', project: { id: 'doc-1', fps: 30, width: 1920, height: 1080 }, cardPlan: controls };
}

test('M7Q-D12-T1 层表 v 3：共享档每层带候选；第一个候选与层上的 resultKey / key / envFingerprint 一致（v 2 的读法仍对得上）', () => {
  assert.equal(transfer.LAYER_MAP_VERSION, 3);
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const map = transfer.layerMapOf(entryWith([a]), { fingerprint: P, now: 0, candidatesOf: () => [P, B] });
  assert.equal(map.v, 3);
  const layer = map.layers[0];
  assert.deepEqual(layer.candidates, [
    { envFingerprint: P, resultKey: rk('ck-a', P), key: rk('ck-a', P), dirKey: rk('ck-a', P) },
    { envFingerprint: B, resultKey: rk('ck-a', B), key: rk('ck-a', B), dirKey: rk('ck-a', B) },
  ]);
  assert.deepEqual([layer.envFingerprint, layer.resultKey, layer.key, layer.dirKey, layer.contentKey], [P, rk('ck-a', P), rk('ck-a', P), rk('ck-a', P), 'ck-a']);
});

test('M7Q-D12-T2 切分方照锁只出了浏览器那份：层上的主候选是浏览器的键；自己的指纹排在后面', () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const map = transfer.layerMapOf(entryWith([a]), { fingerprint: P, now: 0, candidatesOf: () => [B] });
  const layer = map.layers[0];
  assert.deepEqual(layer.candidates.map((c) => c.envFingerprint), [B, P]);
  assert.deepEqual([layer.envFingerprint, layer.resultKey, layer.key], [B, rk('ck-a', B), rk('ck-a', B)]);
});

test('M7Q-D12-T3 没有切分记录：只有自己一个候选；本地档只有自己一个候选', () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const l = control({ clipId: 'l', contentKey: 'ck-l', tier: 'local', capabilities: { frameMode: 'stateful', compositing: 'belowDependent' }, count: 30 });
  const map = transfer.layerMapOf(entryWith([a, l]), { fingerprint: P, now: 0, candidatesOf: () => [B] });
  const local = map.layers.find((x) => x.clipId === 'l');
  assert.deepEqual(local.candidates.map((c) => c.envFingerprint), [P]);
  const plain = transfer.layerMapOf(entryWith([a]), { fingerprint: P, now: 0 });
  assert.deepEqual(plain.layers[0].candidates.map((c) => c.envFingerprint), [P]);
});

test('M7Q-D12-T4 splitCandidatesOf：按内容键收集最终出键的指纹（发布顺序），只收共享档快照', () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 70 });
  const l = control({ clipId: 'l', contentKey: 'ck-l', tier: 'local', capabilities: { frameMode: 'stateful', compositing: 'belowDependent' }, count: 30 });
  const tasks = splitPlan(splitArgs({ cardPlan: [a, l], browserFingerprints: [B] }));
  const got = transfer.splitCandidatesOf(tasks);
  assert.ok(got instanceof Map);
  assert.deepEqual([...got.entries()], [['ck-a', [P, B]]]);
});

/* ================================================================== D11：页面要用的节点模块不牵进 node: 内置模块 */

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = [
  /\bimport\s+(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
function graphOf(entry) {
  const seen = new Set();
  const builtins = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of SPEC) for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith('node:')) builtins.push(`${path.basename(file)} → ${spec}`);
      else if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec));
    }
  }
  return { files: [...seen].map((f) => path.relative(serverDir, f).replace(/\\/g, '/')), builtins };
}

test('M7Q-D11-G1 session.mjs 的依赖树里没有 node: 内置模块，不经 render-queue/index.mjs', () => {
  const g = graphOf(path.join(serverDir, 'render-node', 'session.mjs'));
  assert.deepEqual(g.builtins, []);
  assert.ok(!g.files.includes('render-queue/index.mjs'), g.files.join(', '));
  assert.ok(!g.files.includes('render-queue/queue.mjs'), g.files.join(', '));
});

test('M7Q-D11-G2 细任务编排 task-runner.mjs：同构（没有 node: 内置模块），不引 split.mjs、队列本体、fingerprint.mjs', async () => {
  const file = path.join(serverDir, 'render-node', 'task-runner.mjs');
  assert.ok(fs.existsSync(file), 'server/render-node/task-runner.mjs 存在');
  const g = graphOf(file);
  assert.deepEqual(g.builtins, []);
  for (const bad of ['render-node/split.mjs', 'render-queue/index.mjs', 'render-queue/queue.mjs', 'render-node/fingerprint.mjs']) {
    assert.ok(!g.files.includes(bad), `${bad} 不在依赖树里：${g.files.join(', ')}`);
  }
  const mod = await import('../render-node/task-runner.mjs');
  assert.equal(typeof mod.createTaskRunner, 'function');
});

test('M7Q-D11-G3 local-node 用 task-runner 编排细任务（桌面继续用它）', () => {
  const text = fs.readFileSync(path.join(serverDir, 'render-node', 'local-node.mjs'), 'utf8');
  assert.match(text, /from '\.\/task-runner\.mjs'/);
});

/* ================================================================== 进程内：真队列 + 真切分方（pc 的 local-node） */

/** 同步直连：队列的 send 按 connId 交给注册的收件函数 */
function inproc() {
  let t = T0;
  const routes = new Map();
  const log = [];
  const q = createRenderQueue({ now: () => t, send: (connId, message) => { const m = JSON.parse(JSON.stringify(message)); log.push({ connId, m }); routes.get(connId)?.(m); } });
  const endpointOf = (connId, principal) => {
    q.connect(connId, principal);
    return { send: (m) => q.handle(connId, JSON.parse(JSON.stringify(m))), onMessage: (h) => routes.set(connId, h) };
  };
  return { q, log, now: () => t, advance(ms) { t += ms; q.tick(); }, endpointOf, of: (connId, type) => log.filter((e) => e.connId === connId && e.m.type === type).map((e) => e.m) };
}

function pcSplitter(env, { cardPlan, afterSplit, cardLocks } = {}) {
  const endpoint = env.endpointOf('pc', { userId: 'rig@pc', tenantId: 't1' });
  const executor = {
    // cardLocks:执行器(本机锁库)已知的锁,切分照它出键(契约 F.2)
    plan: async () => ({ entryKey: 'entry-1', cardPlan, weightOf, anchorFrames: [], ...(cardLocks ? { cardLocks } : {}) }),
    render: async () => null,
    ...(afterSplit ? { afterSplit } : {}),
  };
  // 细任务不让 pc 做（isIdle 只在视图里有 plan 时为真），浏览器那份与锁的走向由测试掌握
  const local = createLocalNode({
    nodeId: 'pc-1', node: { profile: 'pc', envFingerprint: P, codeVersions: [CV] }, endpoint, now: env.now, codeVersion: CV,
    executor, sink: { has: async () => false, put: async () => ({ complete: true }) },
    isIdle: () => local.session.known().some((t) => t.kind === 'plan'), takeoverLocked: localNodeModule.idleLockTakeover,
  });
  local.start();
  return local;
}

function pageAndBrowser(env) {
  const page = env.endpointOf('page', { userId: 'zoe@devA', tenantId: 't1' });
  page.send({ type: 'publisher.hello', publisherId: 'pub-page' });
  const br = env.endpointOf('br', { userId: 'zoe@devA', tenantId: 't1' });
  br.send({ type: 'node.hello', nodeId: 'n-br', profile: 'browser', envFingerprint: B });
  br.send({ type: 'queue.watch', projects: ['p1'] });
  return { page, br };
}

test('M7Q-A10 进程内：浏览器认领一段后走掉；锁闲置超 30 s 后下一次切分，pc 带 takeover 接手整张卡，浏览器那份作废', async () => {
  const env = inproc();
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 120 });
  const pc = pcSplitter(env, { cardPlan: [a] });
  const { page, br } = pageAndBrowser(env);

  const plan1 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 1, clips: ['a'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan1] });
  pc.tick();
  await flush();
  const claimed = env.of('pc', 'task.claimed').find((m) => m.id === plan1.id);
  assert.deepEqual(claimed?.browserFingerprints, [B], '认领回包带同用户在线浏览器的指纹');
  const d1 = env.q.describe();
  const brTasks = d1.tasks.filter((t) => t.id.startsWith(`snapshot:${rk('ck-a', B)}`));
  const pcTasks = d1.tasks.filter((t) => t.id.startsWith(`snapshot:${rk('ck-a', P)}`));
  assert.equal(brTasks.length, 2, JSON.stringify(d1.tasks.map((t) => t.id)));
  assert.equal(pcTasks.length, 2);

  // 浏览器先认领第一段：锁到 B，切分方那份作废
  br.send({ type: 'task.claim', id: brTasks[0].id, expectVersion: 1 });
  assert.ok(env.of('br', 'task.claimed').some((m) => m.id === brTasks[0].id));
  for (const t of pcTasks) assert.equal(env.q.describe().tasks.find((x) => x.id === t.id).lastError, 'superseded');

  // 浏览器走掉：宽限期过后它那段回到 open；锁还在 B 上
  env.q.disconnect('br');
  env.advance(11_000);
  env.advance(5_000);
  assert.equal(env.q.describe().tasks.find((x) => x.id === brTasks[0].id).state, 'open');
  // 离浏览器最后一次产出过了 30 s 以上，页面发布下一版计划
  env.advance(20_000);
  const plan2 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['a'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan2] });
  pc.tick();
  await flush();
  const claimed2 = env.of('pc', 'task.claimed').find((m) => m.id === plan2.id);
  assert.ok(claimed2, '第二版计划由 pc 认领');
  assert.equal('browserFingerprints' in claimed2, false, '浏览器已不在线：只出自己那一份');
  const d2 = env.q.describe();
  assert.equal(d2.locks.find((l) => l.lockKey === 'snapshot:ck-a').envFingerprint, P, '锁转给了切分方');
  for (const t of brTasks) assert.equal(d2.tasks.find((x) => x.id === t.id).lastError, 'superseded', `${t.id} 作废`);
  for (const t of pcTasks) assert.equal(d2.tasks.find((x) => x.id === t.id).state, 'open', `${t.id} 重建`);
  const results = env.log.filter((e) => e.connId === 'pc' && e.m.type === 'task.published').map((e) => e.m.results);
  assert.ok(results.some((rs) => rs.some((r) => r.error === 'card-locked' && r.lockIdleMs > 30_000 && r.lockUndone > 0)), JSON.stringify(results));
  pc.stop();
  await pc.settled();
});

test('M7Q-A10b 进程内：锁在浏览器上但它还在产出（闲置不到 30 s）：切分方照锁出键，不接手', async () => {
  const env = inproc();
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 120 });
  const pc = pcSplitter(env, { cardPlan: [a] });
  const { page, br } = pageAndBrowser(env);
  const plan1 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 1, clips: ['a'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan1] });
  pc.tick();
  await flush();
  const brId = env.q.describe().tasks.find((t) => t.id.startsWith(`snapshot:${rk('ck-a', B)}`)).id;
  br.send({ type: 'task.claim', id: brId, expectVersion: 1 });
  const token = env.of('br', 'task.claimed').find((m) => m.id === brId).token;
  for (let i = 0; i < 5; i++) { env.advance(9_000); br.send({ type: 'task.progress', id: brId, token, done: i + 1 }); }
  const plan2 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['a'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan2] });
  pc.tick();
  await flush();
  const d = env.q.describe();
  assert.ok(env.of('pc', 'task.claimed').some((m) => m.id === plan2.id), '第二版计划由 pc 认领、切分过');
  assert.equal(d.locks.find((l) => l.lockKey === 'snapshot:ck-a').envFingerprint, B, '锁仍在浏览器上');
  assert.equal(d.tasks.find((x) => x.id === brId).state, 'claimed', '浏览器手里那段不受影响');
  pc.stop();
  await pc.settled();
});

test('M7Q-D12-E1 执行器 afterSplit：记切分候选；带片段清单的 plan 在切分完成后写一次层表（主机用 publishLayerMap 选项）', async () => {
  const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const entry = entryWith([a]);
  const recorded = [];
  const written = [];
  const pipeline = {
    planForQueue: async () => ({ entry, context: { cardPlan: [a] } }),
    recordSplitCandidates: (m) => recorded.push(m),
    queueHandles: () => true,
  };
  const exec = createPrerenderExecutor({ pipeline, projects: { get: async () => ({ tracks: [], duration: 1 }) }, publishLayerMap: (e) => written.push(e.key) });
  await exec.plan(listPlan);
  assert.deepEqual(written, [], '切分之前不写层表');
  const tasks = splitPlan(splitArgs({ cardPlan: [a], browserFingerprints: [B] }));
  await exec.afterSplit(listPlan, { tasks });
  assert.deepEqual([...recorded[0].entries()], [['ck-a', [P, B]]]);
  assert.deepEqual(written, ['entry-1'], '切分完成后写一次');
  // 不带片段清单的 plan：只记候选，不写层表
  await exec.afterSplit(planTaskOf({ projectId: 'proj-m7', projectRev: 4 }), { tasks });
  assert.equal(recorded.length, 2);
  assert.deepEqual(written, ['entry-1']);
});

/* ================================================================== M7-A10 真页面上查出的缺陷:切分方已知锁、照锁出键时从不接手 */

test('M7Q-A10c 队列：切分节点照别的指纹的锁发布（合并进锁定方的任务）时，回包也带 lockIdleMs / lockedByProfile / lockUndone，不带 lockedBy', () => {
  const h = setup();
  const br0 = snap('ck1', B, 0), br1 = snap('ck1', B, 60);
  h.publish('p', [br0, br1]);
  h.claim('bw', br0.id, 1);
  h.clock.advance(40_000);
  // pc（指纹 P）以自己的发布身份照锁发 B 那份
  h.handle('pc', { type: 'publisher.hello', publisherId: 'pub-pc' });
  const r = published(h.publish('pc', [br0, br1]), 'pc');
  for (const x of r) {
    assert.equal(x.error, undefined, JSON.stringify(x));
    assert.equal('lockedBy' in x, false, '锁就在这份的指纹上，不带 lockedBy');
    assert.deepEqual([x.lockIdleMs, x.lockedByProfile, x.lockUndone], [40_000, 'browser', 2], JSON.stringify(x));
  }
  // 发布方不是节点、或节点指纹与锁相同：形状不变
  const plain = published(h.publish('p', [br0]), 'p')[0];
  assert.equal('lockIdleMs' in plain, false, JSON.stringify(plain));
});

test('M7Q-A10d 切分方从执行器已知锁在浏览器指纹上、照锁出键：回包说锁定方闲置超 30 s 且没做完 → 按自己的指纹带 takeover 重发；闲置不到 30 s 不重发', async () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  const scene = async (info) => {
    const respond = (tasks) => tasks.map((t) => (t.requires.envFingerprint === B
      ? { id: t.id, state: 'open', version: 1, created: false, ...info }
      : { id: t.id, state: 'open', version: 1, created: true }));
    const endpoint = scriptedEndpoint(respond);
    const executor = { plan: async () => ({ entryKey: 'entry-1', cardPlan: [a], weightOf, anchorFrames: [], cardLocks: { 'snapshot:ck-a': B } }), render: async () => null };
    const local = createLocalNode({
      nodeId: 'pc-1', node: { profile: 'pc', envFingerprint: P, codeVersions: [CV] }, endpoint, now: () => T0, codeVersion: CV,
      executor, sink: { has: async () => false, put: async () => ({ complete: true }) }, takeoverLocked: localNodeModule.idleLockTakeover,
    });
    local.start();
    endpoint.deliver({ type: 'task.claimed', id: listPlan.id, token: 2, version: 2, leaseUntil: T0 + 30_000, task: planView, browserFingerprints: [B] });
    await flush();
    const rounds = endpoint.sent.filter((m) => m.type === 'task.publish').map((m) => m.tasks);
    const done = endpoint.sent.find((m) => m.type === 'task.complete' && m.id === listPlan.id);
    return { rounds, done };
  };
  const idle = await scene({ lockIdleMs: 45_000, lockedByProfile: 'browser', lockUndone: 1 });
  assert.equal(idle.rounds.length, 2, JSON.stringify(idle.rounds.map((r) => r.map((t) => t.requires.envFingerprint))));
  assert.deepEqual(idle.rounds[0].map((t) => t.requires.envFingerprint), [B], '第一轮照锁出键');
  assert.deepEqual(idle.rounds[1].map((t) => [t.requires.envFingerprint, t.takeover === true]), [[P, true]], '第二轮接手');
  assert.deepEqual(idle.done.result.derived, [idle.rounds[1][0].id], 'derived 只列接手后那份');
  const busy = await scene({ lockIdleMs: 10_000, lockedByProfile: 'browser', lockUndone: 1 });
  assert.equal(busy.rounds.length, 1, '还在产出：不重发');
  const done = await scene({ lockIdleMs: 45_000, lockedByProfile: 'browser', lockUndone: 0 });
  assert.equal(done.rounds.length, 1, '锁定方已做完：照锁投递');
});

test('M7Q-A10e 进程内（真页面上的场景）：b1 持有一段时走掉，锁闲置超 30 s；同指纹的另一用户 b2 在线并发布计划，切分方从本机锁库已知锁在 B 上 —— 仍由 pc 接手整张卡', async () => {
  const env = inproc();
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 120 });
  const pc = pcSplitter(env, { cardPlan: [a] });
  const { page, br } = pageAndBrowser(env);
  const plan1 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 1, clips: ['a'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan1] });
  pc.tick();
  await flush();
  const brTasks = env.q.describe().tasks.filter((t) => t.id.startsWith(`snapshot:${rk('ck-a', B)}`));
  br.send({ type: 'task.claim', id: brTasks[0].id, expectVersion: 1 });
  const token = env.of('br', 'task.claimed').find((m) => m.id === brTasks[0].id).token;
  br.send({ type: 'task.progress', id: brTasks[0].id, token, done: 3 });
  env.q.disconnect('br');
  pc.stop();
  env.q.disconnect('pc');
  env.advance(11_000); env.advance(5_000); env.advance(20_000);
  assert.equal(env.q.describe().tasks.find((x) => x.id === brTasks[0].id).state, 'open');

  // pc 重启：本机锁库已知这张卡锁在 B 上（照锁出键）
  const pc2 = pcSplitter(env, { cardPlan: [a], cardLocks: { 'snapshot:ck-a': B } });
  // 另一个用户的页面 b2，同指纹 B，在线、watch 本项目，发布计划
  const page2 = env.endpointOf('page2', { userId: 'yan@devB', tenantId: 't1' });
  page2.send({ type: 'publisher.hello', publisherId: 'pub-page2' });
  const b2 = env.endpointOf('b2', { userId: 'yan@devB', tenantId: 't1' });
  b2.send({ type: 'node.hello', nodeId: 'n-b2', profile: 'browser', envFingerprint: B });
  b2.send({ type: 'queue.watch', projects: ['p1'] });
  const plan2 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['a'], codeVersion: CV });
  page2.send({ type: 'task.publish', tasks: [plan2] });
  pc2.tick();
  await flush();
  assert.ok(env.of('pc', 'task.claimed').some((m) => m.id === plan2.id), 'pc 认领了第二版计划');
  const d = env.q.describe();
  assert.equal(d.locks.find((l) => l.lockKey === 'snapshot:ck-a').envFingerprint, P, `锁应转给 pc：${JSON.stringify(d.locks)}`);
  for (const t of brTasks) assert.equal(d.tasks.find((x) => x.id === t.id).lastError, 'superseded', `${t.id} 作废`);
  const pcIds = d.tasks.filter((t) => t.id.startsWith(`snapshot:${rk('ck-a', P)}`) && t.state === 'open');
  assert.equal(pcIds.length, 2, 'pc 那份两段重建、open');
  pc2.stop();
  await pc2.settled();
});

test('M7Q-D1-Q5 切分方那份先按单份建过、后一版按双份发来：合并时补上 dual；浏览器那份先认领，它照样被作废', () => {
  const h = setup();
  const own0 = snap('ck1', P, 0);                     // 页面报到之前那一版：单份
  h.publish('p', [own0]);
  const r = published(h.publish('p', [snap('ck1', P, 0, { dual: true }), snap('ck1', B, 0, { dual: true })]), 'p');
  assert.deepEqual(r.map((x) => [x.created, x.error]), [[false, undefined], [true, undefined]]);
  assert.equal(h.bus.of('pc', 'task.opened').filter((m) => m.task.id === own0.id).at(-1)?.task.input.dual, true, '补上 dual 后重发 task.opened');
  h.claim('bw', snap('ck1', B, 0).id, 1);
  assert.deepEqual([h.task(own0.id).state, h.task(own0.id).lastError], ['failed', 'superseded']);
});

test('M7Q-D1-Q6 锁已在别的指纹上时合并进来的 dual 一份：当场作废（回包状态 failed），不留死任务', () => {
  const h = setup();
  const own0 = snap('ck1', P, 0);
  const br0 = snap('ck1', B, 0, { dual: true });
  h.publish('p', [own0, br0]);
  h.claim('bw', br0.id, 1);                          // 锁到 B；own0 不带 dual，没被作废
  assert.equal(h.task(own0.id).state, 'open');
  const r = published(h.publish('p', [snap('ck1', P, 0, { dual: true })]), 'p')[0];
  assert.deepEqual([r.state, r.lockedBy], ['failed', B], JSON.stringify(r));
  assert.equal(h.task(own0.id).lastError, 'superseded');
});

test('M7Q-A10f 切分方自己那份已存在、合并回包带 lockedBy 与闲置描述：闲置超 30 s 且没做完 → 带 takeover 重发', async () => {
  const a = control({ clipId: 'a', contentKey: 'ck-a', count: 30 });
  let round = 0;
  const respond = (tasks) => { round += 1; return tasks.map((t) => (round === 1
    ? { id: t.id, state: 'open', version: 1, created: false, lockedBy: B, lockIdleMs: 50_000, lockedByProfile: 'browser', lockUndone: 1 }
    : { id: t.id, state: 'open', version: 1, created: true })); };
  const rig = splitterRig({ respond, cardPlan: [a], takeoverLocked: localNodeModule.idleLockTakeover });
  rig.endpoint.deliver({ type: 'task.claimed', id: listPlan.id, token: 2, version: 2, leaseUntil: T0 + 30_000, task: planView });
  await flush();
  const rounds = rig.publishes();
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds[1].map((t) => [t.requires.envFingerprint, t.takeover === true]), [[P, true]]);
});

test('M7Q-D12-P1 管线的切分候选落盘：重启（新的 FramePipeline、同一库根）后照样按它列候选', async () => {
  const os = await import('node:os');
  const { FramePipeline } = await import('../frame-pipeline.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7q-split-cand-'));
  try {
    const p1 = Object.create(FramePipeline.prototype);
    p1.root = root;
    assert.equal(p1.splitCandidatesFor('ck-a'), null);
    p1.recordSplitCandidates(new Map([['ck-a', [P, B]]]));
    assert.deepEqual(p1.splitCandidatesFor('ck-a'), [P, B]);
    const p2 = Object.create(FramePipeline.prototype);
    p2.root = root;
    assert.deepEqual(p2.splitCandidatesFor('ck-a'), [P, B], '重启后读得回来');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ================================================================== 锚帧段先认领（笔记本 M7-A4 查出，主会话〔裁〕改契约 B.3） */

test('M7Q-PICK-1 锚帧段（50）与普通段（10）同时可认领：pickCandidate 一定先给锚帧段，同档里照旧随机', async () => {
  const { pickCandidate } = await import('../render-node/pick.mjs');
  const t = (id, priority, publishedAt) => ({ id, priority, source: { projectId: 'p1', publishedAt } });
  // 普通段发布得更早，前 4 名里混着两档
  const tasks = [t('h1:60', 10, 1), t('h2:120', 10, 2), t('h1:0', 50, 3), t('h2:0', 50, 4), t('h3:60', 10, 5)];
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const got = pickCandidate(tasks, { k: 4, random: () => r });
    assert.equal(got.priority, 50, `random=${r} 挑到了 ${got.id}`);
  }
  assert.deepEqual(new Set([0, 0.99].map((r) => pickCandidate(tasks, { k: 4, random: () => r }).id)), new Set(['h1:0', 'h2:0']), '同档内仍随机');
  // 锚帧段都认领完：普通段照旧前 k 个里随机
  const rest = tasks.filter((x) => x.priority === 10);
  assert.equal(pickCandidate(rest, { k: 4, random: () => 0.99 }).id, 'h3:60');
});

test('M7Q-PICK-2 同一档里计划先于细任务（AGENT-m7-race）：积压的锚帧段、普通段都排在后来发布的清单计划之后；预渲染重试计划仍在全部 normal 之后', async () => {
  const { pickCandidate, rankCandidates } = await import('../render-node/pick.mjs');
  const t = (id, priority, publishedAt, kind = 'snapshot') => ({ id, kind, priority, source: { projectId: 'p1', publishedAt } });
  // pc 手里积压着接手来的重卡段（50、10），之后页面为新加的卡发布清单计划（'normal'，名次 0），还有一份预渲染重试计划
  const backlog = [t('z1:0', 50, 1), t('h1:60', 10, 2), t('h2:120', 10, 3), t('h3:180', 10, 4), t('z1:60', 10, 5)];
  const plan = t('plan:p@5#clips:w', 'normal', 9, 'plan');
  const backfillPlan = t('plan:p@5#backfill:w', 'backfill', 8, 'plan');
  const backfillFine = t('lite:0', 'backfill', 0);
  const all = [...backlog, backfillFine, backfillPlan, plan];
  for (const r of [0, 0.3, 0.6, 0.99]) assert.equal(pickCandidate(all, { k: 4, random: () => r }).id, plan.id, `random=${r}`);
  assert.deepEqual(rankCandidates(all).map((x) => x.id), [plan.id, 'z1:0', 'h1:60', 'h2:120', 'h3:180', 'z1:60', backfillPlan.id, 'lite:0']);
  // 计划认领走了：细任务照旧锚帧段先
  assert.equal(pickCandidate([...backlog, backfillPlan], { k: 4, random: () => 0.99 }).id, 'z1:0');
  // 两份 normal 计划：照发布先后；只在计划里挑，不混进细任务
  const plan4 = t('plan:p@4#clips:x', 'normal', 7, 'plan');
  assert.deepEqual(new Set([0, 0.99].map((r) => pickCandidate([...backlog, plan, plan4], { k: 4, random: () => r }).id)), new Set([plan4.id, plan.id]));
  // normal 都没了才轮到预渲染重试：预渲染重试计划先于预渲染重试细任务
  assert.equal(pickCandidate([backfillFine, backfillPlan], { k: 4, random: () => 0.99 }).id, backfillPlan.id);
});
