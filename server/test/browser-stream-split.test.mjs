/**
 * Single-card track streams produce an extra browser copy (`docs/plan/browser-stream-task.md`
 * parts 1 and 2): splitting and node-side filtering.
 *
 *   BS-01~BS-09  Splitting: shape of the browser copy; only for single-card streams; group streams,
 *                canvas cards, cards with heaviness "heavy", cards locked elsewhere not emitted;
 *                splitter's own copy unchanged word for word; locks, takeover, user cards and
 *                media effect cards, `browserOnly`
 *   BS-10~BS-14  Filtering: Rule 2 only checks `requires.transcode` written by task itself;
 *                splitter stream task behavior unchanged; Rule 7 shape gate for browser stream tasks
 *   BS-15        Callers: `queueStreamOf` provides shapes for splitting; manifest plan emits
 *                streams only for the browser (`listPlanOverrides` in `local-node.mjs`)
 *
 * Run: node --test server/test/browser-stream-split.test.mjs
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

/** One item of card plan. By default browser-capable: shared tier, standalone, not a canvas card, built-in card */
function control(clipId, extra = {}) {
  return {
    clipId, cardId: `card-${clipId}`, snapshotKey: rk(`ck-${clipId}`, OWN), contentKey: `ck-${clipId}`, tier: 'shared',
    start: 1.5, end: 5.5, count: 120, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } },
    compositing: 'independent', capabilities: { compositing: 'independent' }, ...extra,
  };
}
/** Splitter's weightOf: follows queueWeightClass in `frame-pipeline.mjs` */
function weightOf(c) {
  const comp = c.compositing ?? c.capabilities?.compositing;
  if (c.tier === 'local' || c.capabilities?.canvasHeavy === true || comp === 'belowDependent' || comp === 'unknown') return { class: 'heavy', estMs: null };
  return { class: 'medium', estMs: null };
}
/** Single-card stream calculated by `planStreams`, handed to splitting per `queueStreamOf` (frames 45~164; segments counted from its own first frame 45, 0~7) */
function cardStream(clipId, extra = {}) {
  return {
    streamKey: rk(`sk-${clipId}`, OWN), contentKey: `sk-${clipId}`, topClipId: clipId, originFrame: 45, firstSegment: 0, lastSegment: 7,
    kind: 'card', plane: 'local', clipIds: [clipId], fps: 30, bound: { x: -32, y: -32, w: 464, h: 304 }, offset: { x: 760, y: 420 },
    firstFrame: 45, lastFrame: 164, total: 300, ...extra,
  };
}
/** Legacy callers provide only stream key and segment range (no shape, nor first frame of this stream: browser copy not emitted) */
const legacyStream = clipId => ({ streamKey: rk(`sk-${clipId}`, OWN), contentKey: `sk-${clipId}`, topClipId: clipId, firstSegment: 3, lastSegment: 10 });

function split({ cardPlan, streams, browser = { nodeId: 'n-br', envFingerprint: BR }, ...rest }) {
  return splitPlan({
    planTask: clipsPlan({ clips: cardPlan.map(c => c.clipId) }), entryKey: 'entry-1', cardPlan, prerenderSet: null, streams,
    envFingerprint: OWN, codeVersion: 'cv-1', weightOf, ...(browser ? { browser } : {}), ...rest,
  }).filter(t => t.kind === 'stream');
}
const ofFp = (tasks, fp) => tasks.filter(t => t.requires.envFingerprint === fp);

/** Original form of splitter's own stream task (`split.mjs` literal before changes): copied field by field, keeping "word-for-word unchanged" */
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

test('BS-01 single-card stream the browser can handle: one copy from the splitter and one from the browser, both carry dual; the shape of the browser copy matches field by field', () => {
  const tasks = split({ cardPlan: [control('a')], streams: [cardStream('a')] });
  assert.equal(tasks.length, 2, 'Segments 0-7, 8 segments in total, one task × two copies');
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
      // `originFrame` / `lastFrame`: first and last frames of this stream; page uses them to convert segment numbers to frames
      stream: { kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: { x: -32, y: -32, w: 464, h: 304 }, offset: { x: 760, y: 420 }, firstFrame: 45, count: 120, total: 300, originFrame: 45, lastFrame: 164 },
    },
    weight: { class: 'medium', estMs: null, frames: 120 },
    requires: { envFingerprint: BR, codeVersion: 'cv-1', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
    priority: 10,
  });
  assert.equal(own.input.dual, true, 'The splitter\'s copy carries dual too: when the queue builds the lock, it uses this to void the copy that was not claimed');
  assert.equal('takeover' in own, false);
  assert.equal('takeover' in br, false);
  assert.equal(own.input.contentKey, br.input.contentKey, 'Both copies share the same content key (same lock stream:<content key>)');
});

test('BS-02 the splitter\'s own copy is unchanged to the last character: identical to before when there is no browser; with a browser it only gains input.dual', () => {
  const cardPlan = [control('a')];
  const cardSourceVersions = { 'user-x': 'user:abc' };
  for (const streams of [[cardStream('a')], [legacyStream('a')]]) {
    const none = split({ cardPlan, streams, browser: null, cardSourceVersions });
    const { firstSegment: from, lastSegment: to } = streams[0];
    assert.deepEqual(none, [ownTaskBefore({ clipId: 'a', from, to, cardSources: { 'user-x': 'user:abc' } })], 'No browser fingerprint: identical to before, character for character');
  }
  const withBrowser = ofFp(split({ cardPlan, streams: [cardStream('a')], cardSourceVersions }), OWN);
  const expected = ownTaskBefore({ clipId: 'a', from: 0, to: 7, cardSources: { 'user-x': 'user:abc' } });
  expected.input.dual = true;
  assert.deepEqual(withBrowser, [expected]);
  // When segments span more than one task, segments in both copies correspond one-to-one
  const long = split({ cardPlan, streams: [cardStream('a', { lastFrame: 45 + 20 * 15 - 1, lastSegment: 19, total: 400 })] });
  const seg = list => list.map(t => [t.range.from, t.range.to]);
  assert.deepEqual(seg(ofFp(long, OWN)), [[0, 7], [8, 15], [16, 19]]);
  assert.deepEqual(seg(ofFp(long, BR)), seg(ofFp(long, OWN)));
  assert.deepEqual(ofFp(long, BR).map(t => t.weight.frames), [120, 120, 60]);
  assert.deepEqual(ofFp(long, OWN).map(t => t.weight.frames), [120, 120, 60]);
  // When stream's last segment is under 15 frames, task frame count uses actual frames
  // (stream ends at frame 337: last segment has only 8 frames); both copies are identical
  const short = split({ cardPlan, streams: [cardStream('a', { lastFrame: 45 + 19 * 15 + 7, lastSegment: 19, total: 400 })] });
  assert.deepEqual(ofFp(short, OWN).map(t => t.weight.frames), [120, 120, 53]);
  assert.deepEqual(ofFp(short, BR).map(t => t.weight.frames), [120, 120, 53]);
});

test('BS-03 only single-card streams: group streams, streams missing shape fields, and streams whose member card is not in the card plan yield only the splitter\'s own copy (identical to before, character for character)', () => {
  const cardPlan = [control('a'), control('b')];
  const cases = {
    groupStream: cardStream('b', { kind: 'group', plane: 'stage', clipIds: ['a', 'b'] }),
    'single-card stream but the plane is not local': cardStream('b', { plane: 'stage' }),
    legacyCallerGivesOnlyStreamKeyAndSegmentRange: legacyStream('b'),
    'missing bound': cardStream('b', { bound: null }),
    'width is not even': cardStream('b', { bound: { x: 0, y: 0, w: 463, h: 304 } }),
    'missing total': cardStream('b', { total: undefined }),
    'missing the first frame of this stream (a plan from before the segmentation rule changed)': cardStream('b', { originFrame: undefined }),
    'missing the last frame of this stream': cardStream('b', { lastFrame: undefined }),
    memberCardNotInPlan: cardStream('zz'),
  };
  for (const [name, stream] of Object.entries(cases)) {
    const tasks = split({ cardPlan, streams: [stream] });
    assert.deepEqual(tasks, [ownTaskBefore({ clipId: stream.topClipId, from: stream.firstSegment, to: stream.lastSegment })], name);
  }
});

test('BS-04 canvas cards, cards whose heaviness is "heavy", local tier, cards marked oversize, and cards that use assets existing only on the publisher\'s machine: no browser copy', () => {
  const cases = {
    canvasCard: control('a', { capabilities: { compositing: 'independent', canvasHeavy: true } }),
    'depends on the layer below (heavy)': control('a', { compositing: 'belowDependent', capabilities: { compositing: 'belowDependent' } }),
    'unknown compositing mode (heavy)': control('a', { compositing: 'unknown', capabilities: { compositing: 'unknown' } }),
    localTier: control('a', { tier: 'local' }),
    oversize: control('a', { snapshotOversize: true }),
    builtinCardWithModifiedSource: control('a'),
  };
  for (const [name, c] of Object.entries(cases)) {
    const extra = name === 'builtinCardWithModifiedSource' ? { cardSourceVersions: { 'card-a': 'override:1' } } : {};
    const tasks = split({ cardPlan: [c], streams: [cardStream('a')], entryKey: 'entry-1', ...extra });
    assert.deepEqual(tasks.map(t => t.requires.envFingerprint), [OWN], name);
    assert.equal('dual' in tasks[0].input, false, `${name}: only one copy, no dual`);
  }
  // Assets only on the publisher's local machine (M6c X2)
  const local = split({ cardPlan: [control('a')], streams: [cardStream('a')], localMedia: 'node-pub', usesLocalMedia: () => true });
  assert.deepEqual(local.map(t => t.requires.envFingerprint), [OWN]);
  assert.equal(local[0].requires.localMedia, 'node-pub');
  // No browser fingerprint, or browser fingerprint matches splitter: no separate copy emitted
  assert.equal(split({ cardPlan: [control('a')], streams: [cardStream('a')], browser: null }).length, 1);
  const same = split({ cardPlan: [control('a')], streams: [cardStream('a')], browser: { nodeId: 'n', envFingerprint: OWN } });
  assert.deepEqual(same, [ownTaskBefore({ clipId: 'a', from: 0, to: 7 })], 'Same fingerprint: only the splitter\'s copy, still the shape that needs local transcoding');
});

test('BS-05 a card locked elsewhere gets no browser copy: it follows the lock and yields one copy; when locked on the browser fingerprint, that copy has the browser\'s shape', () => {
  const base = { cardPlan: [control('a')], streams: [cardStream('a')] };
  const third = split({ ...base, cardLocks: { 'stream:sk-a': THIRD } });
  assert.deepEqual(third, [ownTaskBefore({ clipId: 'a', from: 0, to: 7, fingerprint: THIRD })], 'Locked on a third environment: yields one copy in the splitter\'s shape, following its fingerprint');
  const br = split({ ...base, cardLocks: { 'stream:sk-a': BR } });
  assert.equal(br.length, 1);
  assert.equal(br[0].requires.envFingerprint, BR);
  assert.equal(br[0].requires.transcode, false);
  assert.ok(br[0].input.stream && br[0].input.bake, 'Locked on the browser fingerprint: the browser\'s shape');
  assert.equal('dual' in br[0].input, false);
  // Takeover: emits one copy with its own fingerprint and takeover; does not emit browser copy
  const taken = split({ ...base, cardLocks: { 'stream:sk-a': BR }, takeover: true });
  const expected = ownTaskBefore({ clipId: 'a', from: 0, to: 7 });
  expected.takeover = true;
  assert.deepEqual(taken, [expected]);
  // Snapshot locks do not affect stream locks (each has its own lock key)
  const snapLocked = split({ ...base, cardLocks: { 'snapshot:ck-a': THIRD } });
  assert.deepEqual(snapLocked.map(t => t.requires.envFingerprint), [OWN, BR]);
});

test('BS-06 user cards and media effect cards: the browser copy uses the page\'s cardEnvFingerprint, and cardSources lists only this card\'s entry; no copy is produced if the page did not declare it or the identity does not match', () => {
  const cardPlan = [control('a', { cardId: 'user-x' })];
  const cardSourceVersions = { 'user-x': 'user:abc', 'user-y': 'user:def' };
  const browserCards = { cardEnvFingerprint: CARD_FP, userCards: true, graphCards: false, cardSources: { 'user-x': 'user:abc' } };
  const args = { cardPlan, streams: [cardStream('a')], cardSourceVersions, isUserCard: () => true, browserCards, browserCardEnvFingerprints: [CARD_FP] };
  const tasks = split(args);
  assert.deepEqual(tasks.map(t => t.requires.envFingerprint), [OWN, CARD_FP]);
  const br = tasks[1];
  assert.equal(br.resultKey, rk('sk-a', CARD_FP));
  assert.deepEqual(br.requires.cardSources, { 'user-x': 'user:abc' }, 'Lists only this card\'s code identity');
  assert.equal(br.requires.userCards, true);
  assert.deepEqual(tasks[0].requires.cardSources, cardSourceVersions, 'The splitter\'s copy still lists all custom cards');
  assert.equal(tasks[0].requires.userCards, false, 'The splitter\'s copy stays as before');
  // Document service did not confirm this cardEnvFingerprint, page declared no capability, code identity mismatch: none emitted
  assert.equal(split({ ...args, browserCardEnvFingerprints: [] }).length, 1);
  assert.equal(split({ ...args, browserCards: { ...browserCards, userCards: false } }).length, 1);
  assert.equal(split({ ...args, browserCards: { ...browserCards, cardSources: { 'user-x': 'user:other' } } }).length, 1);
  // Media effect card
  const graph = split({ ...args, isUserCard: () => false, isGraphCard: () => true, browserCards: { ...browserCards, userCards: false, graphCards: true } });
  assert.deepEqual(graph.map(t => t.requires.envFingerprint), [OWN, CARD_FP]);
  assert.equal(graph[1].requires.graphCards, true);
});

test('BS-07 browserOnly (manifest plan of the online page): yields only the browser copy, without dual; yields no copy at all if the browser cannot do it', () => {
  const only = cardStream('a', { browserOnly: true });
  const tasks = split({ cardPlan: [control('a')], streams: [only] });
  assert.deepEqual(tasks.map(t => t.requires.envFingerprint), [BR]);
  assert.equal('dual' in tasks[0].input, false);
  assert.equal(tasks[0].requires.transcode, false);
  assert.equal(split({ cardPlan: [control('a')], streams: [only], browser: null }).length, 0, 'No browser node');
  assert.equal(split({ cardPlan: [control('a', { capabilities: { compositing: 'independent', canvasHeavy: true } })], streams: [only] }).length, 0, 'canvas card');
  assert.equal(split({ cardPlan: [control('a'), control('b')], streams: [cardStream('b', { kind: 'group', plane: 'stage', clipIds: ['a', 'b'], browserOnly: true })] }).length, 0, 'group stream');
  assert.equal(split({ cardPlan: [control('a')], streams: [only], cardLocks: { 'stream:sk-a': THIRD } }).length, 0, 'Locked on another environment: it is being produced there, none is produced here');
  const locked = split({ cardPlan: [control('a')], streams: [only], cardLocks: { 'stream:sk-a': BR } });
  assert.deepEqual(locked.map(t => t.requires.envFingerprint), [BR], 'Locked on the browser fingerprint: yields that copy following the lock');
});

test('BS-08 snapshot tasks are unaffected: with or without streams, with or without stream shapes, the snapshot half is identical character for character', () => {
  const cardPlan = [control('a'), control('b', { capabilities: { compositing: 'independent', canvasHeavy: true } })];
  const run = streams => splitPlan({ planTask: clipsPlan({ clips: ['a', 'b'] }), entryKey: 'entry-1', cardPlan, prerenderSet: null, streams,
    envFingerprint: OWN, codeVersion: 'cv-1', weightOf, anchorFrames: [50], browser: { nodeId: 'n', envFingerprint: BR } }).filter(t => t.kind === 'snapshot');
  const none = run([]);
  assert.ok(none.length > 0);
  assert.deepEqual(run([cardStream('a')]), none);
  assert.deepEqual(run([legacyStream('a'), cardStream('b', { browserOnly: true })]), none);
});

test('BS-09 input.stream of the browser copy is a copy: changing it does not affect the stream the caller gave', () => {
  const stream = cardStream('a');
  const [, br] = split({ cardPlan: [control('a')], streams: [stream] });
  br.input.stream.bound.w = 2;
  br.input.stream.clipIds.push('x');
  assert.deepEqual(stream.bound, { x: -32, y: -32, w: 464, h: 304 });
  assert.deepEqual(stream.clipIds, ['a']);
});

/* ------------------------------------------------------------------ Filtering */

const nodeOf = (profile, capabilities, extra = {}) => ({ profile, nodeId: `n-${profile}`, userId: 'u@d', envFingerprint: OWN, codeVersions: ['cv-1'], capabilities, cardSourceVersions: {}, ...extra });
const withUser = t => ({ ...t, source: { ...t.source, userId: 'u@d' } });
function bothCopies() {
  const tasks = split({ cardPlan: [control('a')], streams: [cardStream('a')] }).map(withUser);
  return { own: ofFp(tasks, OWN)[0], br: ofFp(tasks, BR)[0] };
}

test('BS-10 rule 2: the splitter\'s own stream task (with transcode: true) behaves the same', () => {
  const { own } = bothCopies();
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(own, nodeOf('host', { transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: true })), { ok: true }, 'The legacy shape that does not report streams is judged by transcode');
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: true, streams: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: false, streams: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(own, nodeOf('pc', { transcode: false, streams: true })), { ok: false, rule: 2, reason: 'transcode' }, 'Can encode streams but cannot transcode: the splitter\'s copy needs transcoding');
  assert.deepEqual(checkClaimable(own, nodeOf('browser', { transcode: false, streams: true })), { ok: false, rule: 2, reason: 'transcode' }, 'The browser does not take the splitter\'s copy');
});

test('BS-11 rule 2: the browser copy (transcode: false) is claimed solely on capabilities.streams', () => {
  const { br } = bothCopies();
  const browser = caps => nodeOf('browser', caps, { envFingerprint: BR });
  assert.deepEqual(checkClaimable(br, browser({ transcode: false, streams: true, userCards: false, graphCards: false })), { ok: true });
  assert.deepEqual(checkClaimable(br, browser({ transcode: false, streams: false })), { ok: false, rule: 2, reason: 'streams' }, 'Does not claim when the host cannot detect an encoder');
  assert.deepEqual(checkClaimable(br, browser({ transcode: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(br, nodeOf('browser', { transcode: false, streams: true })), { ok: false, rule: 1, reason: 'env-fingerprint' }, 'The fingerprint is not this copy\'s');
  assert.deepEqual(checkClaimable({ ...br, source: { ...br.source, userId: 'other@d' } }, browser({ streams: true })), { ok: false, rule: 0, reason: 'other-user' });
});

test('BS-12 rule 2 only looks at the requires.transcode written by the task itself: a snapshot that requires transcoding is still blocked; a stream task that does not write this field no longer always requires transcoding', () => {
  const snap = { id: 'snapshot:k:0-29', kind: 'snapshot', tier: 'shared', resultKey: 'k', range: { from: 0, to: 29 }, source: { projectId: 'p', projectRev: 1, userId: 'u@d' },
    input: { clipId: 'c' }, weight: { class: 'medium' }, requires: { transcode: true } };
  assert.deepEqual(checkClaimable(snap, nodeOf('pc', { transcode: false })), { ok: false, rule: 2, reason: 'transcode' });
  assert.deepEqual(checkClaimable(snap, nodeOf('pc', { transcode: true })), { ok: true });
  const bare = { id: 'stream:k:0-7', kind: 'stream', resultKey: 'k', range: { unit: 'segment', from: 0, to: 7 }, source: { projectId: 'p', projectRev: 1, userId: 'u@d' },
    input: { clipId: 'c' }, weight: { class: 'medium' }, requires: {} };
  assert.deepEqual(checkClaimable(bare, nodeOf('pc', { transcode: false })), { ok: true }, 'A stream task that sets neither transcode nor streams: rule 2 does not block it');
  assert.deepEqual(checkClaimable({ ...bare, requires: { transcode: true } }, nodeOf('pc', { transcode: false })), { ok: false, rule: 2, reason: 'transcode' });
});

test('BS-13 rule 7: a pure browser takes only single-card streams in the browser shape', () => {
  const { br } = bothCopies();
  const browser = nodeOf('browser', { transcode: false, streams: true }, { envFingerprint: BR });
  const tweak = input => ({ ...br, input: { ...br.input, ...input } });
  assert.deepEqual(checkClaimable(tweak({ stream: undefined }), browser), { ok: false, rule: 7, reason: 'not-card-stream' });
  assert.deepEqual(checkClaimable(tweak({ stream: { ...br.input.stream, kind: 'group' } }), browser), { ok: false, rule: 7, reason: 'not-card-stream' });
  assert.deepEqual(checkClaimable(tweak({ stream: { ...br.input.stream, plane: 'stage' } }), browser), { ok: false, rule: 7, reason: 'not-card-stream' });
  assert.deepEqual(checkClaimable(tweak({ bake: undefined }), browser), { ok: false, rule: 7, reason: 'no-bake-input' });
  assert.deepEqual(checkClaimable(tweak({ compositing: 'belowDependent' }), browser), { ok: false, rule: 7, reason: 'not-independent' });
  assert.deepEqual(checkClaimable(tweak({ canvasHeavy: true }), browser), { ok: false, rule: 7, reason: 'canvas-heavy' });
  // Heaviness per Rule 4: browser does not accept "heavy"
  assert.deepEqual(checkClaimable({ ...br, weight: { ...br.weight, class: 'heavy' } }, browser), { ok: false, rule: 4, reason: 'weight' });
  // Stream tasks for user cards have no code identity
  const card = { ...br, requires: { ...br.requires, userCards: true, cardSources: {} } };
  assert.deepEqual(checkClaimable(card, { ...browser, cardEnvFingerprint: BR, capabilities: { ...browser.capabilities, userCards: true } }), { ok: false, rule: 7, reason: 'card-source-missing' });
});

test('BS-14 other nodes versus the browser copy: a different fingerprint is blocked by rule 1; the shape gate only applies to a pure browser', () => {
  const { br } = bothCopies();
  assert.deepEqual(checkClaimable(br, nodeOf('pc', { transcode: true, streams: true })), { ok: false, rule: 1, reason: 'env-fingerprint' });
  assert.deepEqual(checkClaimable({ ...br, input: { ...br.input, stream: undefined } }, nodeOf('pc', { transcode: true, streams: true }, { envFingerprint: BR })), { ok: true });
});

/* ------------------------------------------------------------------ Callers */

/** A minimal entry: a standalone card (frames 45~164), in a shape recognized by `planStreams` */
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

test('BS-15 queueStreamOf passes the shape from planStreams to the split unchanged; planListStreams only computes the clips in the manifest; the split can produce the browser copy from this', () => {
  const entry = entryOf();
  const all = planStreams(entry, { envFingerprint: OWN, codeVersion: 'cv' });
  assert.deepEqual(all.map(s => s.topClipId).sort(), ['a', 'b']);
  const listed = planListStreams(entry, new Set(['a']), { envFingerprint: OWN, codeVersion: 'cv' });
  assert.deepEqual(listed.map(s => s.topClipId), ['a']);
  assert.equal(listed[0].contentKey, all.find(s => s.topClipId === 'a').contentKey, 'The content key of a single-card stream equals the one computed from a different set');
  assert.deepEqual(planListStreams(entry, ['a'], { envFingerprint: OWN, codeVersion: 'cv' }).map(s => s.streamKey), listed.map(s => s.streamKey), 'The manifest may also be an array');
  const q = queueStreamOf(listed[0]);
  const spec = listed[0];
  assert.deepEqual(q, { streamKey: spec.streamKey, contentKey: spec.contentKey, topClipId: 'a', originFrame: 45, firstSegment: 0, lastSegment: 7,
    kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: spec.bound, offset: spec.offset, firstFrame: 45, lastFrame: 164, total: 300, mountFrame: spec.mountFrame });
  assert.deepEqual(q.bound, { x: -32, y: -32, w: 464, h: 304 }, 'Box 400×240 expanded outward by 32');
  assert.notEqual(q.bound, spec.bound, 'bound is a copy');
  const control = { ...entry.cardPlan[0], cardId: 'punch-pill', tier: 'shared', start: 1.5, end: 5.5, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } } };
  const tasks = split({ cardPlan: [control], streams: [{ ...q, browserOnly: true }] });
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].input.stream, { kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: { x: -32, y: -32, w: 464, h: 304 }, offset: spec.offset, firstFrame: 45, count: 120, total: 300, originFrame: 45, lastFrame: 164 });
  assert.deepEqual([tasks[0].range.from, tasks[0].range.to], [0, 7]);
});

/** Only runs to publish: fake endpoint pushes claimed plan after node.hello into node, receives its published fine-grained tasks */
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
  assert.ok(claim, 'The node claimed the plan');
  handler({ type: 'task.claimed', id: planTask.id, token: 1, task: view, browserFingerprints: [BR], epoch: 1 });
  for (let i = 0; i < 20 && !sent.some(m => m.type === 'task.publish'); i++) await new Promise(resolve => setImmediate(resolve));
  const publish = sent.find(m => m.type === 'task.publish');
  node.stop();
  return publish?.tasks ?? null;
}

test('BS-16 local-node: the manifest plan of the online page produces streams only for the browser (browserStreamsFor); prerender retry plans, the legacy executor and ordinary desktop plans stay as before', async () => {
  const cardPlan = [control('a')];
  const base = { entryKey: 'entry-1', cardPlan, weightOf, streams: [cardStream('a')] };
  const asked = [];
  const browserStreamsFor = clips => { asked.push([...clips]); return [cardStream('a')]; };
  // Manifest plan + executor provided browserStreamsFor: two snapshot copies as usual; stream has only the browser copy
  const clips = clipsPlan({ clips: ['a'] });
  const listed = await publishedBy({ planTask: clips, plan: { ...base, browserStreamsFor } });
  assert.ok(listed, 'Fine-grained tasks were published');
  assert.deepEqual(asked, [['a']], 'Asks for streams by the clips in the manifest');
  const streams = listed.filter(t => t.kind === 'stream');
  assert.deepEqual(streams.map(t => t.requires.envFingerprint), [BR]);
  assert.equal(streams[0].requires.transcode, false);
  assert.equal('dual' in streams[0].input, false);
  assert.ok(listed.some(t => t.kind === 'snapshot' && t.requires.envFingerprint === OWN) && listed.some(t => t.kind === 'snapshot' && t.requires.envFingerprint === BR));
  // Legacy executor (no browserStreamsFor): manifest plan still does not split streams, even if context carries streams
  const old = await publishedBy({ planTask: clips, plan: base });
  assert.equal(old.filter(t => t.kind === 'stream').length, 0);
  // Prerender retry plan: still does not split streams as usual
  const backfill = { ...clips, id: clips.id.replace('#clips:', '#backfill:'), resultKey: clips.resultKey.replace('#clips:', '#backfill:'), priority: 'backfill' };
  const filled = await publishedBy({ planTask: backfill, plan: { ...base, browserStreamsFor } });
  assert.equal(filled.filter(t => t.kind === 'stream').length, 0);
  assert.ok(filled.every(t => t.priority === 'backfill'));
});
