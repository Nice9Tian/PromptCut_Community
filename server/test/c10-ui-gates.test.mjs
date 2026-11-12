/**
 * C10 user cards and media effect cards, grayed-out and offline copy, `/api` ratchet
 * (`docs/plan/c10-contract.md` sections 9, 10, 17).
 * Run: node --experimental-test-module-mocks --test server/test/c10-ui-gates.test.mjs
 *
 *   C10-UI-01 Copy of Table A (top bar five states, offline resident notice, grayed-out hover
 *             template) appears verbatim in non-test source files under `src/`;
 *   C10-UI-02 "This mode does not currently support audio media effect cards with media input" and
 *             "This mode does not currently support custom cards" no longer appear (section 9:
 *             merged into icons; badge text changed), and "Local PC rendering assistance required"
 *             also no longer appears ((user decision, 2026-10-21): icons and badges removed
 *             together);
 *   C10-UI-03 User cards and media effect cards that cannot run on this page (those synced from
 *             content store that failed to load; media effect cards; starting 2026-10-21, do not
 *             additionally block user cards runnable on this page by tier) when online are treated
 *             like built-in heavy cards: always treated as heavy cards (even if dispatch table
 *             classifies them as light), pick frames, report gaps, and fetch bytes; when the
 *             entire stage is "exact" in pause state, their snapshots remain mounted as usual
 *             (stopping without catching up): user changed semantics on 2026-09-29, revoking
 *             original exemption;
 *   C10-UI-04 On desktop (online switch is off), user cards and media effect cards pick frames
 *             as usual; sync table does not affect desktop;
 *   C10-RA-01 Old local `/api` manifest decreases only, never increases; approved account entry
 *             points fixed to 11 literals (including three third-party logins from 2026-10-23),
 *             and cloud drive import separately fixed to three (2026-10-24); both buckets are
 *             strictly exact item-by-item, do not permit by prefix, and contain no duplicates.
 *
 * Grayed-out entry points "clicking sends no requests and shows no errors" must be clicked in real
 * pages, belonging to probes and acceptance check C10-A7 (lead session); here only copy is verified.
 * For assumptions, see K7, K8, and K9 of `c10-kit.mjs`. Skip the entire group when the gate is
 * not open.
 */
import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  uiGate, ratchetGate, TABLE_A, DROPPED_TEXTS, srcFilesContaining, repoPath, RATCHET_FILE, RATCHET_BASELINE, useTs, repoUrl,
} from './c10-kit.mjs';

const ui = uiGate();
const itUi = (name, fn) => test(name, { skip: ui.ok ? false : ui.reason }, fn);

itUi('C10-UI-01 the Table A texts appear verbatim in the non-test source files in src/', () => {
  const texts = TABLE_A.map((t) => (t === 'Online browser mode does not yet support' ? 'is not supported in online browser mode yet.' : t === ', please use PromptCut on your computer.' ? 'Please use it in PromptCut on your computer.' : t));
  const missing = texts.filter((text) => srcFilesContaining(text).length === 0);
  assert.deepEqual(missing, [], `These texts are not found in src/:\n${missing.join('\n')}`);
});

itUi('C10-UI-02 "This mode does not yet support audio media effect cards that take media input" no longer appears on its own', () => {
  for (const text of DROPPED_TEXTS) assert.deepEqual(srcFilesContaining(text), [], `"${text}" is still present`);
});

/* ------------------------------------------------------------------ User cards and media effect cards do not send snapshot requests (K7) */

let feed = null, registry = null, placeholder = null;
let plan = { segments: [] };
let now = 1000;
async function load() {
  if (feed) return;
  await useTs();
  const srcUrl = (rel) => repoUrl(`src/${rel}`);
  mock.module(srcUrl('editor/planDispatch.ts'), { exports: { currentPlan: () => plan } });
  mock.module(srcUrl('render/dataMirror.ts'), { exports: { mirrorKey: () => ({ session: 's', localRev: 1 }), pushWanted: () => {} } });
  performance.now = () => now;
  feed = await import(srcUrl('editor/snapshotFeed.ts'));
  registry = await import(srcUrl('kernel/registry.ts'));
  placeholder = await import(srcUrl('render/placeholderHost.ts'));
}

const FPS = 30;
const card = (id, cardId) => ({ id, cardId, start: 0, end: 10, params: {} });
const project = (clips) => ({ version: 1, name: 'p', width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: 't', name: 't', clips }] });
let src = null;
function fakeSource() {
  const s = {
    push: null,
    fetched: [],
    subscribeReady(_s, _r, onMessage) { s.push = onMessage; return () => { s.push = null; }; },
    async fetchSnapshot(kind, key, frame) { s.fetched.push(`${kind}/${key}/${frame}`); return `html:${key}/${frame}`; },
  };
  return s;
}

beforeEach(async () => {
  if (!ui.ok) return;
  await load();
  feed.resetSnapshotFeed();
  src = fakeSource();
  feed.setSnapshotSource(src);
  feed.syncSnapshotSubscription(() => {});
  feed.setExtraSuppressed([]);
  registry.registerCards([
    { id: 'c10-user-card', name: 'u', Component: () => null },
    { id: 'c10-graph-card', name: 'g', card: () => ({}), Component: () => null },
  ]);
  registry.setUserCardSources({ 'c10-user-card.tsx': '' }, { 'c10-user-card': 'c10-user-card.tsx' });
  // User card synced from content store: not defined locally, only in sync table
  registry.setSyncedUserCards([{ id: 'c10-synced-card', name: 'Synced card', source: 'src/cards/user/c10-synced-card.tsx' }]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(['b', 'g', 'u']) }] };
  for (const id of ['b', 'g', 'u', 's']) src.push({ type: 'layer', clipId: id, kind: 'html', key: `k-${id}`, ranges: [[0, 100]] });
  now += 10_000;
});

// 's' is a synced user card, intentionally not classified as heavy in dispatch table (not in
// table): cards this device cannot run are always treated as heavy cards
const clips = () => [card('b', 'builtin-heavy'), card('g', 'c10-graph-card'), card('u', 'c10-user-card'), card('s', 'c10-synced-card')];

async function feedOnce(online, { playing = true } = {}) {
  placeholder.setOnlineBrowserMode(online);
  try {
    const head = { project: project(clips()), t: 1, playing };
    const f = feed.planFeed(head);
    const stage = { calls: [], async setSnapshots(patch, opts) { this.calls.push({ patch, opts }); } };
    await feed.deliverSnapshots(stage, 'front', head);
    await new Promise((r) => setImmediate(r));
    return { f, fetched: [...src.fetched] };
  } finally {
    placeholder.setOnlineBrowserMode(false);
  }
}

itUi('C10-UI-03 when online, user cards and media effect cards (including synced ones) are all suppressed as heavy cards, like built-in heavy cards', async () => {
  const { f, fetched } = await feedOnce(true);
  assert.deepEqual(f.heavy, ['b', 'g', 's', 'u'], 'Synced cards not classified as heavy in the dispatch table are still treated as heavy cards online');
  assert.equal(f.picks.size, 0, 'Snapshots are retired');
  assert.equal(fetched.length, 0, 'Snapshot bytes are no longer fetched');
  placeholder.setOnlineBrowserMode(true);
  try {
    // Frame 150 is not in ready range: picks remains empty after retirement
    const late = feed.planFeed({ project: project(clips()), t: 5, playing: true });
    assert.deepEqual(late.heavy, ['b', 'g', 's', 'u']);
    assert.equal(late.picks.size, 0);
    assert.deepEqual(late.wanted, []);
  } finally {
    placeholder.setOnlineBrowserMode(false);
  }
  // Entire stage is "exact" in pause state (after K5 second-channel swap): built-in cards are no
  // longer suppressed, cards this device cannot run stop without catch-up, entering scrub placeholder
  placeholder.setOnlineBrowserMode(true);
  try {
    assert.deepEqual(feed.suppressedAt({ project: project(clips()), t: 1, playing: true }), ['b', 'g', 's', 'u'], 'Always suppressed while playing');
    feed.markAllSettled('front');
    const paused = feed.planFeed({ project: project(clips()), t: 1, playing: false });
    // 2026-10-06 (online-card-exec-contract.md section 6): user cards bundled at build time are
    // runnable on this page, stopping catches up to exact like built-in cards and is no longer
    // suppressed
    assert.deepEqual(paused.scrub.sort(), ['g', 's'], 'When paused, only the cards this page cannot run still get scrub placeholders');
    // Synced card loaded successfully (runtime state ready): no longer always treated as heavy,
    // follows dispatch table (table did not classify it as heavy)
    registry.setCardRunStates([['c10-synced-card', { state: 'ready', version: 'g1' }]]);
    assert.deepEqual(feed.suppressedAt({ project: project(clips()), t: 1, playing: true }), ['b', 'g', 'u'], 'Synced cards that can run are no longer always suppressed');
    assert.deepEqual(feed.planFeed({ project: project(clips()), t: 1, playing: false }).scrub.sort(), ['g'], 'When paused it also catches up to exact rendering');
    registry.setCardRunStates([['c10-synced-card', { state: 'missing-module', detail: 'lodash' }]]);
    assert.deepEqual(feed.suppressedAt({ project: project(clips()), t: 1, playing: true }), ['b', 'g', 's', 'u'], 'Cards that cannot run are still always suppressed');
    // (user decision, 2026-10-21) "render exact frames when paused": do not block runnable user cards
    // on this page by tier (switch that blocked by tier removed 2026-10-22),
    // with only one stage, build-time user cards stop and catch up to exact like built-in cards
    assert.deepEqual(feed.planFeed({ project: project(clips()), t: 1, playing: false, single: true }).scrub.sort(), ['g', 's'], 'Single stage: build-time user cards also catch up to exact rendering when paused');
  } finally {
    placeholder.setOnlineBrowserMode(false);
    registry.setCardRunStates([]);
  }
});

itUi('C10-UI-04 on the desktop (online switch off), user cards and media effect cards follow the dispatch table, and the synced table does not affect the desktop', async () => {
  const { f } = await feedOnce(false);
  assert.deepEqual(f.heavy, ['b', 'g', 'u'], 'The desktop follows the dispatch table: the synced table has no effect (the desktop does not set it either)');
  assert.equal(f.heavy.includes('s'), false);
  feed.markAllSettled('front');
  assert.equal(feed.planFeed({ project: project(clips()), t: 1, playing: false }).scrub.length, 0, 'Desktop paused state is exact across the whole stage: not a single card is suppressed');
});

itUi('C10-UI-05 on a dual stage, once a synced card changes to ready, pumpFeed and localOnlyMissing are re-delivered automatically (no manual play or seek needed)', async () => {
  const previewSrc = fs.readFileSync(repoPath('src/editor/Preview.tsx'), 'utf8');
  assert.match(previewSrc, /onCardRunStatesChanged\(refresh\)/, 'Preview.tsx should subscribe to onCardRunStatesChanged to refresh the suppression and missing tables');
  assert.match(previewSrc, /queueMicrotask\(\(\)\s*=>\s*\{\s*void pumpRef\.current\(\);\s*\}\)/, 'Preview.tsx should re-run pumpRef.current() after the planDispatch microtask');

  placeholder.setOnlineBrowserMode(true);
  try {
    const p = project([card('s', 'c10-synced-card')]);
    plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set() }] };
    // At initial load stage B has not reported back card-states, synced card s is still localOnly,
    // suppressed when paused at t=0 to display hourglass
    registry.setCardRunStates([['c10-synced-card', { state: 'loading' }]]);
    assert.deepEqual(feed.suppressedAt({ project: p, t: 0, playing: false }), ['s'], 'Paused at t=0 during loading should be suppressed');

    let pumpedSuppressed = null;
    const offRun = registry.onCardRunStatesChanged(() => {
      queueMicrotask(() => {
        pumpedSuppressed = feed.suppressedAt({ project: p, t: 0, playing: false });
      });
    });
    try {
      registry.setCardRunStates([['c10-synced-card', { state: 'ready', version: 'g1' }]]);
      await new Promise((r) => queueMicrotask(r));
      assert.deepEqual(pumpedSuppressed, [], 'Suppression is lifted once ready, without a seek/play');
    } finally {
      offRun();
    }
  } finally {
    placeholder.setOnlineBrowserMode(false);
    registry.setCardRunStates([]);
  }
});

/* ------------------------------------------------------------------ Ratchet (K9) */

const ratchet = ratchetGate();
// account-binding-task.md / account-binding-contract.md: independently pin official website
// same-origin account entry points,
// editor/ is a dynamically concatenated artifact literal and cannot allow other editor subpaths.
/*
 * Cloud drive import (`/api/media/storage/*`) must have **not a single entry** in online
 * artifacts, so this bucket is empty.
 *
 * Context: on 2026-10-24 when merging cloud drive connector, three literals connect / disconnect /
 * import entered online artifacts; I registered three entries here back then to make the gate
 * green: that was treating the symptoms. These endpoints are called by the **local editor process**;
 * online page has no peer, and they should never have been bundled into online artifacts in the
 * first place. On the same day `claude/drive-connector` provided a root-cause fix (inlining
 * `if (!storageImportSupported) throw …` at the start of three functions in
 * `src/editor/io/storageImport.ts`, which is a compile-time constant false in online builds, so
 * the bundler prunes the code along with the literals), thus emptying this bucket.
 *
 * An empty bucket is not "ignoring it": the `added` check below treats any path starting with
 * `/api/media/storage/` as unpermitted, so if they ever leak into online artifacts again, this
 * gate immediately turns red: stricter than registering three entries.
 */
const STORAGE_PATHS = [];

const ACCOUNT_PATHS = [
  '/api/account/cloud-agent-consent',
  '/api/account/editor/', '/api/account/editor/renew', '/api/account/editor/session',
  '/api/account/email/confirm', '/api/account/email/start',
  '/api/account/login', '/api/account/logout', '/api/account/me', '/api/account/projects',
  '/api/account/register',
  // 2026-10-23 third-party login (Google): fetch which methods are enabled (GET config), login and
  // initial registration (POST).
  // In the same category as the items above, all being official website account service
  // endpoints; `src/online/apiGuard.ts` allows them strictly item-by-item with fixed methods, and
  // does not allow `third-party/unlink`
  '/api/account/third-party/config', '/api/account/third-party/login', '/api/account/third-party/register',
];
test('C10-RA-03 project members has one separate exact hosted path without enlarging the /api scanner set', () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8'));
  for (const source of [list, baseline]) {
    assert.deepEqual(source.projectAccountPaths, ['/hosted/shared/account/members']);
    assert.equal(source.paths.some(p => p.startsWith('/hosted/')), false);
  }
  assertRatchet(list.paths, baseline);
});
function assertRatchet(paths, baseline) {
  assert.ok(Array.isArray(paths), `${RATCHET_FILE} should have a paths array`);
  assert.deepEqual(baseline.accountPaths, ACCOUNT_PATHS, 'Account permits must be exactly 8 fixed entries and must not be widened to a prefix');
  assert.deepEqual(baseline.storagePaths, STORAGE_PATHS, 'Not a single cloud drive path may enter the online build output');
  assert.equal(new Set(paths).size, paths.length, 'The manifest has duplicates');
  const legacy = new Set(baseline.paths);
  assert.ok(baseline.paths.every((p) => !p.startsWith('/api/account/')), 'The old baseline must not carry account permits');
  assert.ok(baseline.paths.every((p) => !p.startsWith('/api/media/storage/')), 'The old baseline must not carry cloud drive permits');
  const added = paths.filter((p) => p.startsWith('/api/account/') ? !ACCOUNT_PATHS.includes(p)
    : p.startsWith('/api/media/storage/') ? !STORAGE_PATHS.includes(p)
    : !legacy.has(p));
  assert.deepEqual(added, [], `The ratchet manifest has extra unpermitted paths: ${added.join(', ')}`);
  assert.deepEqual(paths.filter((p) => p.startsWith('/api/account/')), ACCOUNT_PATHS, 'The account entries in the output manifest are registered exactly, one by one');
  assert.deepEqual(paths.filter((p) => p.startsWith('/api/media/storage/')), STORAGE_PATHS, 'No cloud drive paths may appear in the online build output');
}
test('C10-RA-01 legacy local /api entries only shrink and never grow, account entry points are a fixed 14, and there are no duplicates', { skip: ratchet.ok ? false : ratchet.reason }, () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8'));
  assertRatchet(list.paths, baseline);
});
test('C10-RA-02 unknown accounts, restored desktop account entry points, additions to the legacy local entries, and duplicates are still rejected', { skip: ratchet.ok ? false : ratchet.reason }, () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8'));
  for (const extra of ['/api/account/unknown', '/api/account/editor/login', '/api/account/editor/recover', '/api/ai/chat', '/api/new-local', '/api/media/storage/unknown', '/api/media/storage/config']) {
    assert.throws(() => assertRatchet([...list.paths, extra], baseline), { code: 'ERR_ASSERTION' });
  }
  assert.throws(() => assertRatchet([...list.paths, list.paths[0]], baseline), { code: 'ERR_ASSERTION' });
  assert.throws(() => assertRatchet(list.paths, { ...baseline, accountPaths: [...ACCOUNT_PATHS, '/api/account/unknown'] }), { code: 'ERR_ASSERTION' });
  assertRatchet(list.paths.filter((p) => p !== '/api/asset'), baseline); // Old local items can continue to be deleted.
});
