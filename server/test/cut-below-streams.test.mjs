/**
 * Stream production for cards in cut segments ([ruling] R01, R02;
 * `docs/plan/user-decisions-2026-10-22.md` Section 2 Item 4). Test case names start with `CB-`.
 * Run: npm test -- server/test/cut-below-streams.test.mjs
 *
 * R01 (below-dependent cards like frosted glass in cut segments produce streams together with lower
 * layers) had a version in 0.7.20, relying on attaching `clip-path` to nested scenes to make it the
 * sampling boundary for frosted glass;
 * On 2026-10-23 the user overturned this secondary [ruling] (verbatim: "I overturn that ruling;
 * remove the clip-path line, treat R01 as unfeasible and rework it."),
 * so below-dependent, unreviewed cards in cut segments return to having no streams: no stream
 * output, no suppression, live render in nested scenes as before (frosted glass in nested scenes
 * samples layers outside the segment through cut segments; streams carrying only lower layers in
 * the segment do not match live render). Report `docs/reports/AGENT-claude-revert-r01.md`.
 *
 *   CB-golden  Streams (entire stream table for projects without cut segments; entire stream table
 *              for projects with cut segments) are verbatim identical to kickoff commit b362e254;
 *              input signatures for below-dependent streams are also identical
 *   CB-r01     Below-dependent, unregistered cards in cut segments do not output streams; nested
 *              scenes do not attach clip-path
 * R02 Online browser also produces streams for heavy cards in cut segments (retained):
 *   CB-split   Splitter provides stream tasks for planar standalone cards in cut segments to the
 *              browser; 3D bounding box and below-dependent cards are still not provided
 *   CB-page    Stream production plan on this page also counts standalone cards in cut segments,
 *              with keys identical field-by-field to the portion provided by splitter to browser
 *   CB-bake    Isolated project for browser portion carries cut segment chain
 *              (`isolatedBakeProject` in `bakeTask.ts`)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { planStreams, planListStreams, queueStreamOf, STREAM_CODE_VERSION } from '../frame-stream.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { captureCode } from '../frame-code.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { clipsPlanTaskOf } from '../render-queue/index.mjs';
import { resultKeyOf as serverResultKeyOf } from '../render-node/fingerprint.mjs';
import { streamInputSig } from '../../src/render/streamInputSig.mjs';
import { planPageStreams, pageStreamTasks } from '../../src/online/pageStreamPlan.ts';
import { cutProject, topProject, entryOf, pageValueOf, FP, CV } from './cut-below-fixtures.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const h = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
/**
 * Portion compared against golden sample: each stream item as is, except only stream-related items
 * are kept in `members` (controls in card plan): controls additionally contain keys factored in by
 * code fingerprints for generate snapshots (`contentKey`, `snapshotKey`, `snapshotCode` in
 * `server/frame-code.mjs`); 0.7.20 modified `createSnapshot.ts` (added a parameter off by default),
 * and they changed accordingly, but do not enter any stream key (single-card stream uses
 * `streamMemberKey`, group stream and below-dependent stream use `cacheContentKey`).
 */
const view = s => ({ ...s, members: s.members.map(m => ({ clipId: m.clipId, streamMemberKey: m.streamMemberKey, cacheContentKey: m.cacheContentKey, sampling: m.sampling, count: m.count })) });
const plan = p => planStreams(entryOf(p), { envFingerprint: FP, codeVersion: CV, below: true });

/* ================================================================== R01 (overturned, reverted) */

test('CB-golden streams are identical, character for character, to the starting commit b362e254 (a project without cut segments, and the whole stream table of a project with cut segments; the signature of streams that depend on the layers below)', () => {
  // Golden sample: calculated on kickoff commit (tree extracted from `git archive b362e254`) using
  // the same scenario and same `view` (`server/test/cut-below-fixtures.mjs`)
  assert.equal(h(plan(topProject()).map(view)), 'd433e1b11d0af435', 'Project without cut segments: stream table identical character for character');
  assert.equal(h(plan(cutProject()).map(view)), '72c7b90197564be3', 'Project with cut segments: stream table identical character for character (cards inside a cut segment that depend on the layers below have no stream)');
  const specs = plan(cutProject());
  const want = { over: '5e49f36ef9d578ba', 'S~S2~cc': '4d1e02e642a66958', 'S~m': '421d9dcd43f4bf8d', 'S~up': '2523fb08171ba9ea', topg: 'af0aab0e91abff08' };
  for (const [id, hash] of Object.entries(want)) {
    const spec = specs.find(s => s.topClipId === id);
    assert.ok(spec, `The stream of ${id} is still there`);
    assert.equal(h(view(spec)), hash, `The stream of ${id} is identical character for character`);
  }
  assert.equal(streamInputSig(topProject(), { clipIds: ['glass'], kind: 'below' }), 's1-c03e47ff075c67d9');
  assert.equal(streamInputSig(cutProject(), { clipIds: ['topg'], kind: 'below' }), 's1-b008c155a4d05838');
  // The "below-dependent signatures" of the two cards in the cut segment also revert to the kickoff
  // commit algorithm (lower layers not filtered by nested scene)
  assert.equal(streamInputSig(cutProject(), { clipIds: ['S~g'], kind: 'below' }), 's1-eb0a1cc7f47115fc');
  assert.equal(streamInputSig(cutProject(), { clipIds: ['S~u'], kind: 'below' }), 's1-be41e3749588320b');
});

test('CB-r01 unregistered cards inside a cut segment that depend on the layers below produce no stream ([ruling] R01 is overturned); the nested scene does not attach clip-path', () => {
  const specs = plan(cutProject());
  for (const id of ['S~g', 'S~u']) assert.ok(!specs.some(s => s.clipIds.includes(id)), `${id} has no stream`);
  assert.ok(!specs.some(s => 'within' in s), 'No stream carries within');
  // Top-level frosted glass still has below-dependent stream, with cards flattened from cut segment
  // in its lower layer
  assert.ok(specs.find(s => s.topClipId === 'topg').belowClipIds.includes('S~g'));
  const scene = fs.readFileSync(path.join(ROOT, 'src/render/CutSegmentScene.tsx'), 'utf8');
  assert.ok(!/clipPath|clip-path/.test(scene), 'The nested scene does not attach clip-path (frosted glass still samples the layers outside the segment through the cut segment)');
});

/* ================================================================== R02 */

const OWN = '1111111111111111';
const BROWSER = '2222222222222222';
const CODES = { capture: captureCode(ROOT) };
const CODE_VERSION = 'code-version-for-test';

/** Server chain: card plan → manifest plan streams → browser split portion (same as `page-stream-plan.test.mjs`) */
function serverSide(project, value, clips) {
  const wire = JSON.parse(JSON.stringify(value));
  const cache = new CardFrameCache({ root: path.join(os.tmpdir(), 'pc-cut-below-split'), project, envFingerprint: OWN });
  const cardIdOf = new Map(wire.graph.nodes.map(node => [node.id, node.cardId ?? null]));
  const cardPlan = cache.plan(wire).map(control => ({ ...control, cardId: cardIdOf.get(control.nodeId) ?? null }));
  const entry = { key: 'entry-cut', project, cardPlan };
  const specs = planListStreams(entry, clips, { codeVersion: `${STREAM_CODE_VERSION}:${CODES.capture}`, envFingerprint: OWN });
  const planTask = clipsPlanTaskOf({ projectId: project.id, projectRev: 7, clips, codeVersion: CODE_VERSION });
  const tasks = splitPlan({
    planTask, entryKey: entry.key, cardPlan, prerenderSet: new Set(clips),
    streams: specs.map(queueStreamOf).map(s => ({ ...s, browserOnly: true })),
    envFingerprint: OWN, codeVersion: CODE_VERSION, browserFingerprints: [BROWSER],
    weightOf: control => ({ class: ['belowDependent', 'unknown'].includes(control?.compositing ?? control?.capabilities?.compositing) ? 'heavy' : 'medium', estMs: null }),
  }).filter(t => t.kind === 'stream');
  return { specs, tasks, planTask };
}

/** Heavy cards in cut segment: standalone card (planar), standalone card with 3D bounding box, frosted glass */
function r02Project() {
  const p = cutProject();
  const B = p.cuts.find(c => c.id === 'B');
  B.tracks.push({ id: 'b-3d', clips: [{ id: 'd3', cardId: 'caption-track', start: 0, end: 8, params: { text: 'd3' }, frame: { x: 0, y: 0, w: 300, h: 200, rotateY: 30 } }] });
  return p;
}

test('CB-split the splitter produces, for the browser, its share of the flat solo cards inside cut segments; cards with a 3D outer frame or that depend on the layers below are not included', () => {
  const p = r02Project();
  const clips = ['S~up', 'S~m', 'S~S2~cc', 'S~d3', 'S~g'];
  const { specs, tasks } = serverSide(p, pageValueOf(p), clips);
  assert.ok(specs.some(s => s.topClipId === 'S~d3' && s.solo === 'flat'), 'The card with the 3D outer frame is still the splitter\'s own solo flat single-card stream');
  const forBrowser = new Set(tasks.filter(t => t.requires.envFingerprint === BROWSER).map(t => t.input.clipId));
  for (const id of ['S~up', 'S~m', 'S~S2~cc']) assert.ok(forBrowser.has(id), `${id} has the browser's share: ${[...forBrowser].join(' ')}`);
  assert.ok(!forBrowser.has('S~d3'), 'Cards with a 3D outer frame are not given to the browser');
  assert.ok(!forBrowser.has('S~g'), 'Cards that depend on the layers below are not given to the browser (same as the top level)');
  const m = tasks.find(t => t.input.clipId === 'S~m');
  assert.equal(m.input.stream.kind, 'card');
  assert.equal(m.input.stream.plane, 'local');
  assert.equal(m.input.bake.sampling.firstFrame, 60, 'First frame of the visible window [2, 6) seconds');
});

test('CB-page the plan that produces streams on this page also counts the flat solo cards inside cut segments, and its keys are field-for-field identical to the splitter\'s share for the browser', async () => {
  const p = r02Project();
  const value = pageValueOf(p);
  const clips = ['S~up', 'S~m', 'S~S2~cc', 'S~d3', 'S~g'];
  const server = serverSide(p, value, clips);
  const page = await planPageStreams({ project: p, value, clips, codes: CODES, envFingerprint: BROWSER });
  const ids = page.specs.map(s => s.topClipId).sort();
  assert.deepEqual(ids, ['S~S2~cc', 'S~m', 'S~up'], `The page produces these three: ${JSON.stringify(page.skipped)}`);
  assert.equal(page.skipped['S~d3'], 'frame-3d');
  assert.equal(page.skipped['S~g'], 'not-independent');
  for (const got of page.specs) {
    const want = server.specs.find(s => s.topClipId === got.topClipId);
    assert.ok(want, got.topClipId);
    assert.equal(got.contentKey, want.contentKey, `${got.topClipId} content key is the same as the splitter's`);
    assert.equal(got.streamKey, serverResultKeyOf(want.contentKey, BROWSER));
    for (const field of ['kind', 'plane', 'firstFrame', 'lastFrame', 'firstSegment', 'lastSegment', 'originFrame']) assert.deepEqual(got[field], want[field], `${got.topClipId}.${field}`);
    assert.deepEqual(got.bound, want.bound);
    assert.deepEqual(got.offset, want.offset);
  }
  // Stream tasks are identical to the portion output by splitter for browser
  const norm = v => JSON.parse(JSON.stringify(v));
  const mine = page.specs.flatMap(spec => pageStreamTasks(spec, { projectId: p.id, projectRev: 7, codeVersion: CODE_VERSION, derivedFrom: server.planTask.id }));
  for (const t of mine) {
    const theirs = server.tasks.find(x => x.id === t.id);
    assert.ok(theirs, `The splitter also produced ${t.id}`);
    assert.deepEqual(norm(t.input), norm(theirs.input), `input of ${t.id}`);
    assert.deepEqual(norm(t.range), norm(theirs.range));
  }
});

test('CB-bake the isolated project for the browser\'s share carries the cut segment chain; top-level cards stay as before', async () => {
  const { isolatedBakeProject } = await import('../../src/online/bakeTask.ts');
  const p = cutProject();
  const input = { clipId: 'S~m', start: 2, end: 6, count: 120, sampling: { firstFrame: 60, phase: { numerator: '0', denominator: '1' } } };
  const iso = isolatedBakeProject(p, input);
  assert.deepEqual(iso.tracks.filter(t => !t.hidden).flatMap(t => t.clips).map(c => c.id), ['S'], 'Only the cut segment is kept at the top level');
  const B = iso.cuts.find(c => c.id === 'B');
  assert.deepEqual(B.tracks.filter(t => !t.hidden).flatMap(t => t.clips).map(c => c.id), ['m'], 'Only the target card is kept in the cut');
  assert.equal(iso.tracks.find(t => !t.hidden).clips[0].start, 1, 'Time is not shifted');
  // Top-level card is still the portion translated to -phase
  const top = isolatedBakeProject(p, { clipId: 'over', start: 0, end: 8, count: 240, sampling: { firstFrame: 0, phase: { numerator: '0', denominator: '1' } } });
  assert.deepEqual(top.tracks.filter(t => !t.hidden).flatMap(t => t.clips).map(c => [c.id, c.start + 0]), [['over', 0]], 'The target is shifted to -phase (phase is 0 here)');
});
