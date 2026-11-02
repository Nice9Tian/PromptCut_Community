/**
 * Before-and-after comparison of keys output by `CardFrameCache.plan`: for identical input (card
 * graph flattened from a project, source versions, environment), run `plan` once each on baseline
 * commit and current workspace, and compare each key clip by clip (report
 * `docs/archive/agent-reports/AGENT-rr-emphasis-key.md`).
 *
 * Two classes of clips in the project:
 *   plain-*  Output node has no upstream (regular cards, cards with frame and opacity, canvas cards,
 *            below-dependent cards, remotion-style cards, media effect cards, media clips): six keys
 *            (two cache keys with appearance, content key and result key of shared snapshot, member
 *            key of single-card stream, cost key) and other fields must be verbatim identical;
 *   others   Output node has upstream (cards with emphasis or filter, media clips with emphasis,
 *            media effect cards taking media): only the three keys (content key and result key of
 *            shared snapshot, and member key of single-card stream) may change, while cache keys
 *            with appearance and cost key remain unchanged.
 *
 * `card-table-digest-compare.mjs` compares results of directly calling `cardSnapshotIdentity` for
 * each built-in card; this probe compares the `plan` layer (where keys are assembled).
 *
 * Usage (at repository or workspace root):
 *   node scripts/probes/card-plan-key-compare.mjs [--base main]
 *
 *   --base  Baseline commit, defaults to main. Extract its src/ and server/ under
 *           out/card-table-digest/<commit>/ via `git archive` (shares the same directory with
 *           `card-table-digest-compare.mjs`, out/ is not stored), touching no workspace or branch.
 *
 * Exit code: 0 = match; 1 = clips do not match; 2 = failed to run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';

const HERE = path.resolve(fileURLToPath(import.meta.url), '../../..');
const args = process.argv.slice(2);
const BASE_REF = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'main';
const git = (...a) => execFileSync('git', a, { cwd: HERE, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

/**
 * Extract src/ and server/ from baseline commit under out/; dependencies resolve upward to
 * repository node_modules (same as `card-table-digest-compare.mjs`).
 */
function checkoutBase(ref) {
  const sha = git('rev-parse', ref);
  const dir = path.join(HERE, 'out', 'card-table-digest', sha.slice(0, 12));
  if (fs.existsSync(path.join(dir, '.done'))) return { sha, dir };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['archive', '--format=tar', '-o', path.join(dir, 'base.tar'), sha, 'src', 'server'], { cwd: HERE, windowsHide: true });
  // Relative path + cwd: GNU tar shipped with Git Bash treats `C:` as a remote hostname
  execFileSync('tar', ['-xf', 'base.tar'], { cwd: dir, windowsHide: true });
  fs.rmSync(path.join(dir, 'base.tar'));
  fs.writeFileSync(path.join(dir, '.done'), sha);
  return { sha, dir };
}

let base;
try { base = checkoutBase(BASE_REF); } catch (error) { console.error(error); process.exit(2); }
const BASE = base.dir;
const load = root => import(pathToFileURL(path.join(root, 'server/card-cache.mjs')).href);
const DEFS = { 'punch-pill': { id: 'punch-pill', defaults: { text: '' } }, 'focus-card': { id: 'focus-card', defaults: {} }, 'particles': { id: 'particles', defaults: {} }, 'odometer': { id: 'odometer', defaults: {} },
  'fx-tint': { id: 'fx-tint', kind: 'filter', defaults: {}, card() {} }, 'av-pulse': { id: 'av-pulse', frameMode: 'direct', defaults: {} } };
const E = { kind: 'outline', color: '#ffd400', size: 8 };
const c = (id, extra) => ({ id, start: 1, end: 3, params: {}, ...extra });
const clips = [
  c('plain-pill', { cardId: 'punch-pill', params: { text: 'a' } }), c('plain-pill-framed', { cardId: 'punch-pill', start: 0.505, end: 2.2, frame: { x: 3, y: 4, w: 640, h: 360 }, opacity: 0.5 }),
  c('plain-focus', { cardId: 'focus-card' }), c('plain-particles', { cardId: 'particles' }), c('plain-odometer', { cardId: 'odometer' }), c('plain-direct', { cardId: 'av-pulse' }),
  c('plain-graphcard', { cardId: 'fx-tint' }), c('plain-media', { mediaId: 'm-a', mediaOffset: 1 }),
  c('emph-pill', { cardId: 'punch-pill', params: { text: 'a' }, emphasis: E }), c('filter-pill', { cardId: 'punch-pill', filter: { id: 'f', params: {} } }),
  c('emph-media', { mediaId: 'm-a', emphasis: E }), c('fx-on-media', { mediaId: 'm-a', nodeId: 'n1' }),
];
const project = { id: 'p', width: 1920, height: 1080, fps: 30, duration: 4, themeId: 'dark', style: { accent: '#f00' },
  media: [{ id: 'm-a', kind: 'video', path: 'a.mp4', duration: 9 }], filters: [{ id: 'f', ops: [] }], audioFx: [],
  cardNodes: [{ id: 'n1', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: {}, inputs: { source: '@clip/fx-on-media/source' } }],
  tracks: clips.map((clip, i) => ({ id: `t${i}`, clips: [clip] })) };
const value = { graph: projectCardGraph(project, id => DEFS[id]), sourceVersions: Object.fromEntries(Object.keys(DEFS).map(id => [id, `builtin:${id}-v1`])), environment: { width: 1920, height: 1080, fps: 30, theme: 'dark', fontFingerprint: 'ff' } };
const run = async root => { const { CardFrameCache } = await load(root); return new CardFrameCache({ root: 'unused', project, envFingerprint: '0123456789abcdef' }).plan(structuredClone(value)); };
const before = await run(BASE), after = await run(HERE);
console.log(`Baseline ${BASE_REF} = ${base.sha.slice(0, 12)}; current HEAD = ${git('rev-parse', 'HEAD').slice(0, 12)}${git('status', '--porcelain', '--', 'src', 'server') ? '(uncommitted changes in src/ or server/, computed from the working tree)' : ''}`);
const KEYS = ['key', 'cacheContentKey', 'contentKey', 'snapshotKey', 'streamMemberKey', 'costKey'];
let bad = 0;
for (const a of after) {
  const b = before.find(x => x.clipId === a.clipId);
  const changed = KEYS.filter(k => a[k] !== b[k]);
  const rest = JSON.stringify({ ...a, ...Object.fromEntries(KEYS.map(k => [k, 0])) }) === JSON.stringify({ ...b, ...Object.fromEntries(KEYS.map(k => [k, 0])) });
  const wrapped = !a.clipId.startsWith('plain-');
  const ok = rest && (wrapped ? changed.join() === 'contentKey,snapshotKey,streamMemberKey' : changed.length === 0);
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✖'} ${a.clipId.padEnd(18)} output node ${a.nodeId.padEnd(28)} tier ${a.tier.padEnd(6)} changed keys: ${changed.join(', ') || 'none'}${rest ? '' : ' (other fields changed too!)'}`);
}
console.log(before.length === after.length && !bad ? `✔ ${after.length} clips: for clips with no upstream, the 6 keys are verbatim identical; for clips with upstream, only contentKey / snapshotKey / streamMemberKey change` : `✖ ${bad} mismatches`);
process.exit(bad ? 1 : 0);
