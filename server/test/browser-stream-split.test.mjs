/**
 * 单卡轨道流多出浏览器那一份(`docs/plan/browser-stream-task.md` 第一、二处):切分与节点侧过滤。
 *
 *   BS-01～BS-09  切分:浏览器那一份的形状;只给单卡流;组流、画布卡、重度为「重」的卡、锁在别处的卡不出;
 *                 切分方自己的那一份一个字不变;锁、接手、用户卡与素材效果卡、`browserOnly`
 *   BS-10～BS-14  过滤:规则 2 只看任务自己写的 `requires.transcode`;切分方的流任务行为不变;规则 7 对浏览器流任务的形状闸
 *   BS-15         调用方:`queueStreamOf` 给切分的形状、清单计划只给浏览器出流(`local-node.mjs` 的 `listPlanOverrides`)
 *
 * 跑:node --test server/test/browser-stream-split.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPlan } from '../render-node/split.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { queueStreamOf, planListStreams, planStreams } from '../frame-stream.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { rk, clipsPlan } from './m7-kit.mjs';

const OWN = '1111111111111111';
const BR = '2222222222222222';
const THIRD = '3333333333333333';
const CARD_FP = '4444444444444444';

/** card plan 的一项。缺省是浏览器做得了的:共享档、独立、不是画布卡、内置卡 */
function control(clipId, extra = {}) {
  return {
    clipId, cardId: `card-${clipId}`, snapshotKey: rk(`ck-${clipId}`, OWN), contentKey: `ck-${clipId}`, tier: 'shared',
    start: 1.5, end: 5.5, count: 120, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } },
    compositing: 'independent', capabilities: { compositing: 'independent' }, ...extra,
  };
}
/** 切分方的 weightOf:照 `frame-pipeline.mjs` 的 queueWeightClass */
function weightOf(c) {
  const comp = c.compositing ?? c.capabilities?.compositing;
  if (c.tier === 'local' || c.capabilities?.canvasHeavy === true || comp === 'belowDependent' || comp === 'unknown') return { class: 'heavy', estMs: null };
  return { class: 'medium', estMs: null };
}
/** `planStreams` 算出的一条单卡流,照 `queueStreamOf` 交给切分的形状(帧 45～164;分段从它自己的第一帧 45 起数,0～7) */
function cardStream(clipId, extra = {}) {
  return {
    streamKey: rk(`sk-${clipId}`, OWN), contentKey: `sk-${clipId}`, topClipId: clipId, originFrame: 45, firstSegment: 0, lastSegment: 7,
    kind: 'card', plane: 'local', clipIds: [clipId], fps: 30, bound: { x: -32, y: -32, w: 464, h: 304 }, offset: { x: 760, y: 420 },
    firstFrame: 45, lastFrame: 164, total: 300, ...extra,
  };
}
/** 旧调用方只给流键与分段范围(没有形状,也没有这条流的第一帧:不出浏览器那一份) */
const legacyStream = clipId => ({ streamKey: rk(`sk-${clipId}`, OWN), contentKey: `sk-${clipId}`, topClipId: clipId, firstSegment: 3, lastSegment: 10 });

function split({ cardPlan, streams, browser = { nodeId: 'n-br', envFingerprint: BR }, ...rest }) {
  return splitPlan({
    planTask: clipsPlan({ clips: cardPlan.map(c => c.clipId) }), entryKey: 'entry-1', cardPlan, prerenderSet: null, streams,
    envFingerprint: OWN, codeVersion: 'cv-1', weightOf, ...(browser ? { browser } : {}), ...rest,
  }).filter(t => t.kind === 'stream');
}
const ofFp = (tasks, fp) => tasks.filter(t => t.requires.envFingerprint === fp);

/** 切分方自己那一份流任务原来的样子(改动前 `split.mjs` 的字面量):逐字段照抄,守「一个字不变」 */
function ownTaskBefore({ clipId, from, to, fingerprint = OWN, cardSources = {} }) {
  const resultKey = rk(`sk-${clipId}`, fingerprint);
  return {
    id: `stream:${resultKey}:${from}-${to}`, kind: 'stream', resultKey, range: { unit: 'segment', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: clipsPlan({ clips: [clipId] }).id },
    input: { clipId, cardId: null, entryKey: null, contentKey: `sk-${clipId}` },
    weight: { class: 'medium', estMs: null, frames: (to - from + 1) * 15 },
    requires: { envFingerprint: fingerprint, codeVersion: 'cv-1', cardSources, transcode: true, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
    priority: 10,
  };
}

test('BS-01 浏览器做得了的单卡流:切分方一份、浏览器一份,都带 dual;浏览器那一份的形状逐字段对', () => {
  const tasks = split({ cardPlan: [control('a')], streams: [cardStream('a')] });
  assert.equal(tasks.length, 2, '分段 0～7 共 8 段一个任务 × 两份');
  const [own] = ofFp(tasks, OWN);
  const [br] = ofFp(tasks, BR);
  assert.ok(own && br);
  const resultKey = rk('sk-a', BR);
  assert.deepEqual(br, {
    id: `stream:${resultKey}:0-7`, kind: 'stream', resultKey, range: { unit: 'segment', from: 0, to: 7 },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: own.source.derivedFrom },
    input: {
      clipId: 'a', cardId: 'card-a', entryKey: null, contentKey: 'sk-a', canvasHeavy: false, dual: true, compositing: 'independent',
      bake: { start: 1.5, end: 5.5, count: 120, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } } },
      // `originFrame` / `lastFrame`:这条流自己的第一帧和最后一帧,页面按它们把分段号换成帧
      stream: { kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: { x: -32, y: -32, w: 464, h: 304 }, offset: { x: 760, y: 420 }, firstFrame: 45, count: 120, total: 300, originFrame: 45, lastFrame: 164 },
    },
    weight: { class: 'medium', estMs: null, frames: 120 },
    requires: { envFingerprint: BR, codeVersion: 'cv-1', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
    priority: 10,
  });
  assert.equal(own.input.dual, true, '切分方那一份也带 dual:队列建锁时据此把没抢到的那一份作废');
  assert.equal('takeover' in own, false);
  assert.equal('takeover' in br, false);
  assert.equal(own.input.contentKey, br.input.contentKey, '两份同一个内容键(同一把锁 stream:<内容键>)');
});

test('BS-02 切分方自己的那一份一个字不变:没有浏览器时与原来逐字相同;有浏览器时只多一个 input.dual', () => {
  const cardPlan = [control('a')];
  const cardSourceVersions = { 'user-x': 'user:abc' };
  for (const streams of [[cardStream('a')], [legacyStream('a')]]) {
    const none = split({ cardPlan, streams, browser: null, cardSourceVersions });
    const { firstSegment: from, lastSegment: to } = streams[0];
    assert.deepEqual(none, [ownTaskBefore({ clipId: 'a', from, to, cardSources: { 'user-x': 'user:abc' } })], '没有浏览器指纹:与原来逐字相同');
  }
  const withBrowser = ofFp(split({ cardPlan, streams: [cardStream('a')], cardSourceVersions }), OWN);
  const expected = ownTaskBefore({ clipId: 'a', from: 0, to: 7, cardSources: { 'user-x': 'user:abc' } });
  expected.input.dual = true;
  assert.deepEqual(withBrowser, [expected]);
  // 分段多于一个任务时,两份的段一一对应
  const long = split({ cardPlan, streams: [cardStream('a', { lastFrame: 45 + 20 * 15 - 1, lastSegment: 19, total: 400 })] });
  const seg = list => list.map(t => [t.range.from, t.range.to]);
  assert.deepEqual(seg(ofFp(long, OWN)), [[0, 7], [8, 15], [16, 19]]);
  assert.deepEqual(seg(ofFp(long, BR)), seg(ofFp(long, OWN)));
  assert.deepEqual(ofFp(long, BR).map(t => t.weight.frames), [120, 120, 60]);
  assert.deepEqual(ofFp(long, OWN).map(t => t.weight.frames), [120, 120, 60]);
  // 流的末段不满 15 帧时,任务的帧数按实际算(这条流到第 337 帧为止:末段只有 8 帧),两份相同
  const short = split({ cardPlan, streams: [cardStream('a', { lastFrame: 45 + 19 * 15 + 7, lastSegment: 19, total: 400 })] });
  assert.deepEqual(ofFp(short, OWN).map(t => t.weight.frames), [120, 120, 53]);
  assert.deepEqual(ofFp(short, BR).map(t => t.weight.frames), [120, 120, 53]);
});

test('BS-03 只给单卡流:组流、缺形状字段的流、成员卡不在 card plan 里的流,只出切分方自己的一份(与原来逐字相同)', () => {
  const cardPlan = [control('a'), control('b')];
  const cases = {
    组流: cardStream('b', { kind: 'group', plane: 'stage', clipIds: ['a', 'b'] }),
    '单卡流但平面不是 local': cardStream('b', { plane: 'stage' }),
    旧调用方只给流键与分段范围: legacyStream('b'),
    '缺 bound': cardStream('b', { bound: null }),
    '宽不是偶数': cardStream('b', { bound: { x: 0, y: 0, w: 463, h: 304 } }),
    '缺 total': cardStream('b', { total: undefined }),
    '缺这条流的第一帧(改分段规则之前的计划)': cardStream('b', { originFrame: undefined }),
    '缺这条流的最后一帧': cardStream('b', { lastFrame: undefined }),
    成员卡不在计划里: cardStream('zz'),
  };
  for (const [name, stream] of Object.entries(cases)) {
    const tasks = split({ cardPlan, streams: [stream] });
    assert.deepEqual(tasks, [ownTaskBefore({ clipId: stream.topClipId, from: stream.firstSegment, to: stream.lastSegment })], name);
  }
});

test('BS-04 画布卡、重度为「重」的卡、本地档、标了超体积的卡、用到只在发布方本机的素材的卡:不出浏览器那一份', () => {
  const cases = {
    画布卡: control('a', { capabilities: { compositing: 'independent', canvasHeavy: true } }),
    '依赖下层(重)': control('a', { compositing: 'belowDependent', capabilities: { compositing: 'belowDependent' } }),
    '不认识的合成方式(重)': control('a', { compositing: 'unknown', capabilities: { compositing: 'unknown' } }),
    本地档: control('a', { tier: 'local' }),
    超体积: control('a', { snapshotOversize: true }),
    改过源码的内置卡: control('a'),
  };
  for (const [name, c] of Object.entries(cases)) {
    const extra = name === '改过源码的内置卡' ? { cardSourceVersions: { 'card-a': 'override:1' } } : {};
    const tasks = split({ cardPlan: [c], streams: [cardStream('a')], entryKey: 'entry-1', ...extra });
    assert.deepEqual(tasks.map(t => t.requires.envFingerprint), [OWN], name);
    assert.equal('dual' in tasks[0].input, false, `${name}:只有一份,不带 dual`);
  }
  // 只在发布方本机的素材(M6c X2)
  const local = split({ cardPlan: [control('a')], streams: [cardStream('a')], localMedia: 'node-pub', usesLocalMedia: () => true });
  assert.deepEqual(local.map(t => t.requires.envFingerprint), [OWN]);
  assert.equal(local[0].requires.localMedia, 'node-pub');
  // 没有浏览器指纹、浏览器指纹与切分方相同:不另出
  assert.equal(split({ cardPlan: [control('a')], streams: [cardStream('a')], browser: null }).length, 1);
  const same = split({ cardPlan: [control('a')], streams: [cardStream('a')], browser: { nodeId: 'n', envFingerprint: OWN } });
  assert.deepEqual(same, [ownTaskBefore({ clipId: 'a', from: 0, to: 7 })], '同指纹:只有切分方那一份,仍是要本机转码的形状');
});

test('BS-05 锁在别处的卡不出浏览器那一份:照锁只出一份;锁在浏览器指纹上时那一份是浏览器的形状', () => {
  const base = { cardPlan: [control('a')], streams: [cardStream('a')] };
  const third = split({ ...base, cardLocks: { 'stream:sk-a': THIRD } });
  assert.deepEqual(third, [ownTaskBefore({ clipId: 'a', from: 0, to: 7, fingerprint: THIRD })], '锁在第三个环境:照它的指纹出切分方形状的一份');
  const br = split({ ...base, cardLocks: { 'stream:sk-a': BR } });
  assert.equal(br.length, 1);
  assert.equal(br[0].requires.envFingerprint, BR);
  assert.equal(br[0].requires.transcode, false);
  assert.ok(br[0].input.stream && br[0].input.bake, '锁在浏览器指纹上:浏览器的形状');
  assert.equal('dual' in br[0].input, false);
  // 接手:按自己的指纹出一份、带 takeover,不出浏览器那一份
  const taken = split({ ...base, cardLocks: { 'stream:sk-a': BR }, takeover: true });
  const expected = ownTaskBefore({ clipId: 'a', from: 0, to: 7 });
  expected.takeover = true;
  assert.deepEqual(taken, [expected]);
  // 快照的锁不影响流的锁(各是各的锁键)
  const snapLocked = split({ ...base, cardLocks: { 'snapshot:ck-a': THIRD } });
  assert.deepEqual(snapLocked.map(t => t.requires.envFingerprint), [OWN, BR]);
});

test('BS-06 用户卡与素材效果卡:浏览器那一份用页面的 cardEnvFingerprint,cardSources 只写这张卡的;页面没声明或身份对不上就不出', () => {
  const cardPlan = [control('a', { cardId: 'user-x' })];
  const cardSourceVersions = { 'user-x': 'user:abc', 'user-y': 'user:def' };
  const browserCards = { cardEnvFingerprint: CARD_FP, userCards: true, graphCards: false, cardSources: { 'user-x': 'user:abc' } };
  const args = { cardPlan, streams: [cardStream('a')], cardSourceVersions, isUserCard: () => true, browserCards, browserCardEnvFingerprints: [CARD_FP] };
  const tasks = split(args);
  assert.deepEqual(tasks.map(t => t.requires.envFingerprint), [OWN, CARD_FP]);
  const br = tasks[1];
  assert.equal(br.resultKey, rk('sk-a', CARD_FP));
  assert.deepEqual(br.requires.cardSources, { 'user-x': 'user:abc' }, '只写这张卡的代码身份');
  assert.equal(br.requires.userCards, true);
  assert.deepEqual(tasks[0].requires.cardSources, cardSourceVersions, '切分方那一份照旧写全部定制卡');
  assert.equal(tasks[0].requires.userCards, false, '切分方那一份照旧');
  // 文档服务没确认这个 cardEnvFingerprint、页面没声明能力、代码身份对不上:都不出
  assert.equal(split({ ...args, browserCardEnvFingerprints: [] }).length, 1);
  assert.equal(split({ ...args, browserCards: { ...browserCards, userCards: false } }).length, 1);
  assert.equal(split({ ...args, browserCards: { ...browserCards, cardSources: { 'user-x': 'user:other' } } }).length, 1);
  // 素材效果卡
  const graph = split({ ...args, isUserCard: () => false, isGraphCard: () => true, browserCards: { ...browserCards, userCards: false, graphCards: true } });
  assert.deepEqual(graph.map(t => t.requires.envFingerprint), [OWN, CARD_FP]);
  assert.equal(graph[1].requires.graphCards, true);
});

test('BS-07 browserOnly(在线页面的清单计划):只出浏览器那一份、不带 dual;浏览器做不了就一份都不出', () => {
  const only = cardStream('a', { browserOnly: true });
  const tasks = split({ cardPlan: [control('a')], streams: [only] });
  assert.deepEqual(tasks.map(t => t.requires.envFingerprint), [BR]);
  assert.equal('dual' in tasks[0].input, false);
  assert.equal(tasks[0].requires.transcode, false);
  assert.equal(split({ cardPlan: [control('a')], streams: [only], browser: null }).length, 0, '没有浏览器节点');
  assert.equal(split({ cardPlan: [control('a', { capabilities: { compositing: 'independent', canvasHeavy: true } })], streams: [only] }).length, 0, '画布卡');
  assert.equal(split({ cardPlan: [control('a'), control('b')], streams: [cardStream('b', { kind: 'group', plane: 'stage', clipIds: ['a', 'b'], browserOnly: true })] }).length, 0, '组流');
  assert.equal(split({ cardPlan: [control('a')], streams: [only], cardLocks: { 'stream:sk-a': THIRD } }).length, 0, '锁在别的环境上:那边在产,这里不出');
  const locked = split({ cardPlan: [control('a')], streams: [only], cardLocks: { 'stream:sk-a': BR } });
  assert.deepEqual(locked.map(t => t.requires.envFingerprint), [BR], '锁在浏览器指纹上:照锁出那一份');
});

test('BS-08 快照任务不受影响:带不带流、流带不带形状,快照那一半逐字相同', () => {
  const cardPlan = [control('a'), control('b', { capabilities: { compositing: 'independent', canvasHeavy: true } })];
  const run = streams => splitPlan({ planTask: clipsPlan({ clips: ['a', 'b'] }), entryKey: 'entry-1', cardPlan, prerenderSet: null, streams,
    envFingerprint: OWN, codeVersion: 'cv-1', weightOf, anchorFrames: [50], browser: { nodeId: 'n', envFingerprint: BR } }).filter(t => t.kind === 'snapshot');
  const none = run([]);
  assert.ok(none.length > 0);
  assert.deepEqual(run([cardStream('a')]), none);
  assert.deepEqual(run([legacyStream('a'), cardStream('b', { browserOnly: true })]), none);
});

test('BS-09 浏览器那一份的 input.stream 是拷贝:改它不影响调用方给的流', () => {
  const stream = cardStream('a');
  const [, br] = split({ cardPlan: [control('a')], streams: [stream] });
  br.input.stream.bound.w = 2;
  br.input.stream.clipIds.push('x');
  assert.deepEqual(stream.bound, { x: -32, y: -32, w: 464, h: 304 });
  assert.deepEqual(stream.clipIds, ['a']);
});

/* ------------------------------------------------------------------ 过滤 */

const nodeOf = (profile, capabilities, extra = {}) => ({ profile, nodeId: `n-${profile}`, userId: 'u@d', envFingerprint: OWN, codeVersions: ['cv-1'], capabilities, cardSourceVersions: {}, ...extra });
const withUser = t => ({ ...t, source: { ...t.source, userId: 'u@d' } });
function bothCopies() {
  const tasks = split({ cardPlan: [control('a')], streams: [cardStream('a')] }).map(withUser);
  return { own: ofFp(tasks, OWN)[0], br: ofFp(tasks, BR)[0] };
}

test('BS-10 规则 2:切分方自己的流任务(写了 transcode: true)行为不变', () => {
  const { own } = bothCopies();
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(own, nodeOf('host', { transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: true })), { ok: true }, '没报 streams 的旧形状按 transcode 算');
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: true, streams: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: false, streams: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: false, streams: true })), { ok: false, rule: 2, reason: 'transcode' }, '能压流但不能转码:切分方那一份要转码');
  assert.deepEqual(checkClaimable(own, nodeOf('browser', { transcode: false, streams: true })), { ok: false, rule: 2, reason: 'transcode' }, '浏览器不接切分方那一份');
});

test('BS-11 规则 2:浏览器那一份(transcode: false)只凭 capabilities.streams 认领', () => {
  const { br } = bothCopies();
  const browser = caps => nodeOf('browser', caps, { envFingerprint: BR });
  assert.deepEqual(checkClaimable(br, browser({ transcode: false, streams: true, userCards: false, graphCards: false })), { ok: true });
  assert.deepEqual(checkClaimable(br, browser({ transcode: false, streams: false })), { ok: false, rule: 2, reason: 'streams' }, '宿主探不到编码器就不认领');
  assert.deepEqual(checkClaimable(br, browser({ transcode: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(br, nodeOf('browser', { transcode: false, streams: true })), { ok: false, rule: 1, reason: 'env-fingerprint' }, '指纹不是这一份的');
  assert.deepEqual(checkClaimable({ ...br, source: { ...br.source, userId: 'other@d' } }, browser({ streams: true })), { ok: false, rule: 0, reason: 'other-user' });
});

test('BS-12 规则 2 只看任务自己写的 requires.transcode:快照写了要转码照旧被挡;流任务没写这一项时不再一律要求转码', () => {
  const snap = { id: 'snapshot:k:0-29', kind: 'snapshot', tier: 'shared', resultKey: 'k', range: { from: 0, to: 29 }, source: { projectId: 'p', projectRev: 1, userId: 'u@d' },
    input: { clipId: 'c' }, weight: { class: 'medium' }, requires: { transcode: true } };
  assert.deepEqual(checkClaimable(snap, nodeOf('pc', { transcode: false })), { ok: false, rule: 2, reason: 'transcode' });
  assert.deepEqual(checkClaimable(snap, nodeOf('pc', { transcode: true })), { ok: true });
  const bare = { id: 'stream:k:0-7', kind: 'stream', resultKey: 'k', range: { unit: 'segment', from: 0, to: 7 }, source: { projectId: 'p', projectRev: 1, userId: 'u@d' },
    input: { clipId: 'c' }, weight: { class: 'medium' }, requires: {} };
  assert.deepEqual(checkClaimable(bare, nodeOf('pc', { transcode: false })), { ok: true }, '没写 transcode、没要求 streams 的流任务:规则 2 不挡');
  assert.deepEqual(checkClaimable({ ...bare, requires: { transcode: true } }, nodeOf('pc', { transcode: false })), { ok: false, rule: 2, reason: 'transcode' });
});

test('BS-13 规则 7:纯浏览器只收浏览器形状的单卡流', () => {
  const { br } = bothCopies();
  const browser = nodeOf('browser', { transcode: false, streams: true }, { envFingerprint: BR });
  const tweak = input => ({ ...br, input: { ...br.input, ...input } });
  assert.deepEqual(checkClaimable(tweak({ stream: undefined }), browser), { ok: false, rule: 7, reason: 'not-card-stream' });
  assert.deepEqual(checkClaimable(tweak({ stream: { ...br.input.stream, kind: 'group' } }), browser), { ok: false, rule: 7, reason: 'not-card-stream' });
  assert.deepEqual(checkClaimable(tweak({ stream: { ...br.input.stream, plane: 'stage' } }), browser), { ok: false, rule: 7, reason: 'not-card-stream' });
  assert.deepEqual(checkClaimable(tweak({ bake: undefined }), browser), { ok: false, rule: 7, reason: 'no-bake-input' });
  assert.deepEqual(checkClaimable(tweak({ compositing: 'belowDependent' }), browser), { ok: false, rule: 7, reason: 'not-independent' });
  assert.deepEqual(checkClaimable(tweak({ canvasHeavy: true }), browser), { ok: false, rule: 7, reason: 'canvas-heavy' });
  // 重度照规则 4:浏览器不收「重」
  assert.deepEqual(checkClaimable({ ...br, weight: { ...br.weight, class: 'heavy' } }, browser), { ok: false, rule: 4, reason: 'weight' });
  // 用户卡的流任务没有代码身份
  const card = { ...br, requires: { ...br.requires, userCards: true, cardSources: {} } };
  assert.deepEqual(checkClaimable(card, { ...browser, cardEnvFingerprint: BR, capabilities: { ...browser.capabilities, userCards: true } }), { ok: false, rule: 7, reason: 'card-source-missing' });
});

test('BS-14 别的节点对浏览器那一份:指纹不同被规则 1 挡;形状闸只管纯浏览器', () => {
  const { br } = bothCopies();
  assert.deepEqual(checkClaimable(br, nodeOf('pc', { transcode: true, streams: true })), { ok: false, rule: 1, reason: 'env-fingerprint' });
  assert.deepEqual(checkClaimable({ ...br, input: { ...br.input, stream: undefined } }, nodeOf('pc', { transcode: true, streams: true }, { envFingerprint: BR })), { ok: true });
});

/* ------------------------------------------------------------------ 调用方 */

/** 一个最小的 entry:一张独立卡(帧 45～164),`planStreams` 认得的形状 */
function entryOf() {
  const project = { id: 'p1', width: 1920, height: 1080, fps: 30, duration: 10, tracks: [
    { id: 't1', clips: [{ id: 'a', cardId: 'punch-pill', start: 1.5, end: 5.5, frame: { x: 960, y: 540, w: 400, h: 240, anchor: [0.5, 0.5] } }] },
    { id: 't2', clips: [{ id: 'b', cardId: 'punch-pill', start: 0, end: 2 }] },
  ] };
  const cardPlan = [
    { clipId: 'a', contentKey: 'c'.repeat(64), snapshotKey: 'd'.repeat(64), count: 120, sampling: { firstFrame: 45 }, capabilities: { compositing: 'independent' } },
    { clipId: 'b', contentKey: 'e'.repeat(64), snapshotKey: 'f'.repeat(64), count: 60, sampling: { firstFrame: 0 }, capabilities: { compositing: 'independent' } },
  ];
  return { project, cardPlan };
}

test('BS-15 queueStreamOf 把 planStreams 的形状原样交给切分;planListStreams 只算清单里的片段;切分据此出得了浏览器那一份', () => {
  const entry = entryOf();
  const all = planStreams(entry, { envFingerprint: OWN, codeVersion: 'cv' });
  assert.deepEqual(all.map(s => s.topClipId).sort(), ['a', 'b']);
  const listed = planListStreams(entry, new Set(['a']), { envFingerprint: OWN, codeVersion: 'cv' });
  assert.deepEqual(listed.map(s => s.topClipId), ['a']);
  assert.equal(listed[0].contentKey, all.find(s => s.topClipId === 'a').contentKey, '单卡流的内容键与按别的集合算出来的相同');
  assert.deepEqual(planListStreams(entry, ['a'], { envFingerprint: OWN, codeVersion: 'cv' }).map(s => s.streamKey), listed.map(s => s.streamKey), '清单给数组也行');
  const q = queueStreamOf(listed[0]);
  const spec = listed[0];
  assert.deepEqual(q, { streamKey: spec.streamKey, contentKey: spec.contentKey, topClipId: 'a', originFrame: 45, firstSegment: 0, lastSegment: 7,
    kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: spec.bound, offset: spec.offset, firstFrame: 45, lastFrame: 164, total: 300, mountFrame: spec.mountFrame });
  assert.deepEqual(q.bound, { x: -32, y: -32, w: 464, h: 304 }, '框 400×240 外扩 32');
  assert.notEqual(q.bound, spec.bound, 'bound 是拷贝');
  const control = { ...entry.cardPlan[0], cardId: 'punch-pill', tier: 'shared', start: 1.5, end: 5.5, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } } };
  const tasks = split({ cardPlan: [control], streams: [{ ...q, browserOnly: true }] });
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].input.stream, { kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: { x: -32, y: -32, w: 464, h: 304 }, offset: spec.offset, firstFrame: 45, count: 120, total: 300, originFrame: 45, lastFrame: 164 });
  assert.deepEqual([tasks[0].range.from, tasks[0].range.to], [0, 7]);
});

/** 只跑到发布:假端点把 node.hello 之后的 plan 认领塞给节点,收它发布的细任务 */
async function publishedBy({ planTask, plan }) {
  const sent = [];
  let handler = () => {};
  const endpoint = { send: m => { sent.push(m); }, onMessage: h => { handler = h; } };
  const node = createLocalNode({
    nodeId: 'n-split', node: { profile: 'pc', envFingerprint: OWN, codeVersions: ['cv-1'], capabilities: { transcode: true, streams: true } },
    endpoint, now: () => 1000, codeVersion: 'cv-1', projects: ['p1'],
    executor: { plan: async () => plan, render: async () => null },
    sink: { has: async () => false, put: async () => ({ complete: false }) },
  });
  node.start();
  handler({ type: 'node.welcome', nodeId: 'n-split', epoch: 1 });
  const view = { ...planTask, state: 'open', version: 1, source: { ...planTask.source, userId: 'u@d' } };
  handler({ type: 'queue.snapshot', epoch: 1, tasks: [view] });
  node.tick();
  const claim = sent.find(m => m.type === 'task.claim');
  assert.ok(claim, '节点认领了 plan');
  handler({ type: 'task.claimed', id: planTask.id, token: 1, task: view, browserFingerprints: [BR], epoch: 1 });
  for (let i = 0; i < 20 && !sent.some(m => m.type === 'task.publish'); i++) await new Promise(resolve => setImmediate(resolve));
  const publish = sent.find(m => m.type === 'task.publish');
  node.stop();
  return publish?.tasks ?? null;
}

test('BS-16 local-node:在线页面的清单计划只给浏览器出流(browserStreamsFor);预渲染重试计划、旧执行器、桌面的普通计划照旧', async () => {
  const cardPlan = [control('a')];
  const base = { entryKey: 'entry-1', cardPlan, weightOf, streams: [cardStream('a')] };
  const asked = [];
  const browserStreamsFor = clips => { asked.push([...clips]); return [cardStream('a')]; };
  // 清单计划 + 执行器给了 browserStreamsFor:快照两份照旧;流只有浏览器那一份
  const clips = clipsPlan({ clips: ['a'] });
  const listed = await publishedBy({ planTask: clips, plan: { ...base, browserStreamsFor } });
  assert.ok(listed, '发布了细任务');
  assert.deepEqual(asked, [['a']], '按清单里的片段去要流');
  const streams = listed.filter(t => t.kind === 'stream');
  assert.deepEqual(streams.map(t => t.requires.envFingerprint), [BR]);
  assert.equal(streams[0].requires.transcode, false);
  assert.equal('dual' in streams[0].input, false);
  assert.ok(listed.some(t => t.kind === 'snapshot' && t.requires.envFingerprint === OWN) && listed.some(t => t.kind === 'snapshot' && t.requires.envFingerprint === BR));
  // 旧执行器(不给 browserStreamsFor):清单计划照旧不切流,哪怕上下文里带着 streams
  const old = await publishedBy({ planTask: clips, plan: base });
  assert.equal(old.filter(t => t.kind === 'stream').length, 0);
  // 预渲染重试计划:照旧不切流
  const backfill = { ...clips, id: clips.id.replace('#clips:', '#backfill:'), resultKey: clips.resultKey.replace('#clips:', '#backfill:'), priority: 'backfill' };
  const filled = await publishedBy({ planTask: backfill, plan: { ...base, browserStreamsFor } });
  assert.equal(filled.filter(t => t.kind === 'stream').length, 0);
  assert.ok(filled.every(t => t.priority === 'backfill'));
});
