/**
 * Test only. Control case for Block N (`docs/plan/online-card-exec-contract.md` section 7)
 * "built-in card result keys and splitting do not change by a single character".
 *
 * A fixed set of inputs is fed to `splitPlan` and fingerprint functions to collect each output;
 * the test compares the digest of each output and the result key of each task one-by-one against
 * the literal values produced by the code **before changes** (base commit 3820592c).
 * There are no user cards, media effect cards, or `browserCards` inside: all are old shapes of
 * built-in cards, so they must be identical word-for-word before and after changes.
 */
import crypto from 'node:crypto';
import { splitPlan } from '../render-node/split.mjs';
import { describeEnvironment, envFingerprintOf, resultKeyOf } from '../render-node/fingerprint.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const OWN = describeEnvironment({ platform: 'win32', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)', chromeVersion: 'HeadlessChrome/138.0.7204.49' }).fingerprint;
const BR = describeEnvironment({ platform: 'Windows', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (Intel)', chromeVersion: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' }).fingerprint;
const THIRD = '3333333333333333';

const sk = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
function control(clipId, extra = {}) {
  return {
    clipId, cardId: `card-${clipId}`, snapshotKey: sk(`ck-${clipId}`, OWN), contentKey: `ck-${clipId}`, tier: 'shared',
    count: 130, sampling: { firstFrame: 0, step: 1 }, compositing: 'independent', capabilities: { compositing: 'independent' },
    ...extra,
  };
}
function weightOf(c) {
  const comp = c.compositing ?? c.capabilities?.compositing;
  if (c.tier === 'local' || c.capabilities?.canvasHeavy === true || comp === 'belowDependent' || comp === 'unknown') return { class: 'heavy', estMs: null };
  return { class: 'medium', estMs: null };
}
const planTask = { id: 'plan:p1@7#clips:abc', kind: 'plan', resultKey: 'p1@7#clips:abc', range: null, source: { projectId: 'p1', projectRev: 7 }, input: { clips: ['a', 'b', 'c', 'd', 'e'] }, requires: { codeVersion: 'cv-1' }, priority: 'normal' };

const cards = () => [
  control('a'),
  control('b', { capabilities: { compositing: 'independent', canvasHeavy: true } }),
  control('c', { tier: 'local', compositing: 'belowDependent', capabilities: { compositing: 'belowDependent' } }),
  control('d', { cardId: 'lottie-x' }),
  control('e', { snapshotOversize: true }),
];

/** Each item: `[label, splitPlan input]` */
export function batteryInputs() {
  const base = { planTask, entryKey: 'entry-1', cardPlan: cards(), prerenderSet: null, envFingerprint: OWN, codeVersion: 'cv-1', anchorFrames: [0, 70], weightOf };
  return [
    ['no browser', { ...base }],
    ['browser fingerprint (given by docservice)', { ...base, browserFingerprints: [BR] }],
    ['browser fingerprint equals its own', { ...base, browserFingerprints: [OWN] }],
    ['browser object form', { ...base, browser: { nodeId: 'n-br', envFingerprint: BR } }],
    ['locked to a third environment', { ...base, browserFingerprints: [BR], cardLocks: { 'snapshot:ck-a': THIRD } }],
    ['locked to a third environment, with takeover', { ...base, browserFingerprints: [BR], cardLocks: { 'snapshot:ck-a': THIRD }, takeover: true }],
    ['prerender retry lane', { ...base, browserFingerprints: [BR], lane: 'backfill' }],
    ['builtinCardWithModifiedSource', { ...base, browserFingerprints: [BR], cardSourceVersions: { 'card-a': 'ver-a' } }],
    ['includes local media', { ...base, browserFingerprints: [BR], localMedia: 'node-1', usesLocalMedia: (c) => c.clipId === 'a' }],
    ['has streams', { ...base, browserFingerprints: [BR], streams: [{ streamKey: sk('st', OWN), contentKey: 'st', topClipId: 'bg', firstSegment: 0, lastSegment: 11 }] }],
  ];
}

/** → `{ [label]: { digest, keys: [resultKey of each task…](deduplicated, order-preserving), count } }` */
export function runBattery() {
  const out = {};
  for (const [label, input] of batteryInputs()) {
    const tasks = splitPlan(input);
    const keys = [...new Set(tasks.map((t) => t.resultKey))];
    out[label] = { count: tasks.length, digest: sha256(JSON.stringify(tasks)), keys };
  }
  out['fingerprint function'] = {
    count: 3,
    digest: sha256(JSON.stringify([OWN, BR, envFingerprintOf({ os: 'linux', gpuClass: 'software', chromeMajor: 152 }), resultKeyOf('x', OWN)])),
    keys: [OWN, BR],
  };
  return out;
}
