/**
 * Before/after key comparison for clip speed (`TrackClip.speed`): calculates identities and frame
 * fetch criteria across the board for the same sample project in baseline commit and current workspace.
 *
 *   1. Projects without speed (video clips, video clips with trimmed starts, media effect cards
 *      attached to video, crossfades, video inside cut segments, audio clips, cards):
 *      **verbatim identical** on both sides: frame service frame identity and track prefix,
 *      mirrored project hash, layer table input signature (including virtual clips flattened from
 *      cut segments), six keys of `CardFrameCache.plan` (two cache keys, shared snapshot content
 *      key and result key, single-card stream member key, cost key) and remaining fields, export
 *      mix manifest, asset time for viewing video, ffmpeg parameters for export compatibility bypass.
 *   2. In the same project, change two video clips to 2× and 0.5×: in the current workspace,
 *      everything that should change (including frame identities of these two clips, signatures and
 *      keys for them and attached media effect cards, mix manifest, frame fetch times) has changed,
 *      while other clips remain unchanged; baseline commit does not recognize speed, so input
 *      signatures and card keys **remain unchanged**: this is the exact case where "missing speed
 *      hits an old snapshot, displaying incorrect video without reporting an error".
 *
 * Usage (in repository or workspace root):
 *   node scripts/probes/clip-speed-key-compare.mjs [--base <commit>]   defaults to --base main
 *
 * Baseline src/ and server/ are unpacked to out/clip-speed-keys/<commit>/ via `git archive` (out/
 * is not stored in the repository), resolving dependencies upward to repo node_modules.
 * Exit codes: 0 = match; 1 = mismatch; 2 = cannot run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(fileURLToPath(import.meta.url), '../../..');
const args = process.argv.slice(2);
const BASE_REF = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'main';
const git = (...a) => execFileSync('git', a, { cwd: HERE, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

function checkoutBase(ref) {
  const sha = git('rev-parse', ref);
  const dir = path.join(HERE, 'out', 'clip-speed-keys', sha.slice(0, 12));
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

const DEFS = { 'fx-tint': { id: 'fx-tint', kind: 'filter', defaults: {}, card() {} }, 'punch-pill': { id: 'punch-pill', defaults: { text: '' } } };
const frame = { x: 0, y: 0, w: 1280, h: 720, anchor: [0, 0], scale: 1, rotate: 0 };
function fixture() {
  return {
    id: 'p', width: 1280, height: 720, fps: 30, duration: 20, themeId: 'dark', style: { accent: '#f00' },
    media: [
      { id: 'v1', kind: 'video', name: 'a.mp4', url: '/@media/v1.mp4', hash: 'h-v1', duration: 40 },
      { id: 'v2', kind: 'video', name: 'b.mp4', url: '/@media/v2.mp4', hash: 'h-v2', duration: 40 },
      { id: 'a1', kind: 'audio', name: 'c.mp3', url: '/@media/a1.mp3', hash: 'h-a1', duration: 60 },
    ],
    filters: [], audioFx: [],
    cardNodes: [{ id: 'n1', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: {}, inputs: { source: '@clip/v-fx/source' } }],
    transitions: [{ id: 'tr1', kind: 'crossfade', aId: 'v-a', bId: 'v-b', dur: 1 }],
    tracks: [
      { id: 't1', name: 'Track 1', clips: [{ id: 'c1', cardId: 'punch-pill', start: 0, end: 2, params: { text: 'a' } }] },
      { id: 't2', name: 'Track 2', clips: [
        { id: 'v-a', cardId: '', mediaId: 'v1', mediaOffset: 1.5, start: 0, end: 4.5, fadeOut: 1, params: {}, frame },
        { id: 'v-b', cardId: '', mediaId: 'v2', mediaOffset: 0.1, start: 3.5, end: 8, fadeIn: 1, params: {}, frame },
        { id: 'v-fx', cardId: '', mediaId: 'v1', mediaOffset: 0.2, start: 8, end: 12, params: {}, nodeId: 'n1', frame },
      ] },
      { id: 't3', name: 'Track 3', clips: [{ id: 'seg', cardId: '', cutId: 'B', cutOffset: 1, start: 12, end: 16, params: {} }] },
      { id: 't4', name: 'Track 4', clips: [{ id: 'a-1', cardId: '', mediaId: 'a1', mediaOffset: 3, start: 0, end: 10, params: {} }] },
    ],
    cuts: [{ id: 'A', name: 'Cut A' }, { id: 'B', name: 'Cut B', duration: 8, transitions: [], tracks: [{ id: 'tb', name: 'Track 1', clips: [
      { id: 'b1', cardId: '', mediaId: 'v2', mediaOffset: 2.3, start: 0, end: 8, params: {}, frame },
    ] }] }],
    activeCutId: 'A',
  };
}
const withClips = (p, patches) => ({
  ...p,
  tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (patches[c.id] ? { ...c, ...patches[c.id] } : c)) })),
  cuts: p.cuts.map((cut) => (cut.tracks ? { ...cut, tracks: cut.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (patches[c.id] ? { ...c, ...patches[c.id] } : c)) })) } : cut)),
});

async function measure(root, project) {
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
  const { frameIdentity, trackPrefixes } = await imp('server/frame-identity.mjs');
  const { clipInputSig } = await imp('src/render/layerInputSig.mjs');
  const { projectHash } = await imp('src/render/changedClips.mjs');
  const { projectCardGraph } = await imp('src/kernel/cardGraph.mjs');
  const { flatPlanProject } = await imp('src/kernel/cutFlatten.mjs');
  const { audioPlanOf } = await imp('src/kernel/audioPlan.mjs');
  const { mediaLayersAt } = await imp('server/vision-compose.mjs');
  const { buildComposeArgs, composeLayers } = await imp('server/export-compose.mjs');
  const { CardFrameCache } = await imp('server/card-cache.mjs');
  const flat = flatPlanProject(project);
  const ids = flat.tracks.flatMap((t) => t.clips.map((c) => c.id));
  // Key-generating places in the current workspace pipe into withMediaRates after projectCardGraph
  // (baseline does not have this function, left as-is)
  const clipTime = fs.existsSync(path.join(root, 'src/kernel/clipTime.mjs')) ? await imp('src/kernel/clipTime.mjs') : {};
  const graph = (clipTime.withMediaRates ?? ((_p, g) => g))(flat, projectCardGraph(flat, (id) => DEFS[id]));
  const plan = new CardFrameCache({ root: 'unused', project: flat, envFingerprint: '0123456789abcdef' }).plan({
    graph, sourceVersions: Object.fromEntries(Object.keys(DEFS).map((id) => [id, `builtin:${id}-v1`])), environment: { width: 1280, height: 720, fps: 30, theme: 'dark', fontFingerprint: 'ff' },
  });
  const layers = composeLayers(project).map((l) => ({ ...l, src: `/m/${l.media.id}.mp4` }));
  const compose = buildComposeArgs({ width: 1280, height: 720, fps: 30, startFrame: 0, endFrame: 599, cardsPattern: 'f/%06d.png', out: 'o.mp4', layers });
  const out = {
    'frameIdentity': frameIdentity(project, 'code'),
    'trackPrefixes': trackPrefixes(project, 'code').map((x) => x.key).join(','),
    'projectHash': projectHash(project),
    'audioPlan': JSON.stringify(audioPlanOf(project)),
    'vision@1': JSON.stringify(mediaLayersAt(project, 1).map((l) => [l.clip.id, l.mediaTime])),
    'vision@4': JSON.stringify(mediaLayersAt(project, 4).map((l) => [l.clip.id, l.mediaTime])),
    'vision@9': JSON.stringify(mediaLayersAt(project, 9).map((l) => [l.clip.id, l.mediaTime])),
    'compose.args': JSON.stringify(compose.args),
    'compose.graph': compose.graph,
  };
  for (const id of ids) out[`sig ${id}`] = clipInputSig(flat, id);
  for (const row of plan) for (const k of ['key', 'cacheContentKey', 'contentKey', 'snapshotKey', 'streamMemberKey', 'costKey']) out[`plan ${row.clipId}.${k}`] = row[k];
  for (const row of plan) out[`plan ${row.clipId}.rest`] = JSON.stringify({ ...row, key: 0, cacheContentKey: 0, contentKey: 0, snapshotKey: 0, streamMemberKey: 0, costKey: 0 });
  return out;
}

let base;
try { base = checkoutBase(BASE_REF); } catch (error) { console.error(error); process.exit(2); }
const plain = fixture();
const sped = withClips(plain, { 'v-fx': { speed: 2 }, b1: { speed: 0.5 } });
const [bPlain, cPlain, bSped, cSped] = [await measure(base.dir, plain), await measure(HERE, plain), await measure(base.dir, sped), await measure(HERE, sped)];
console.log(`Baseline ${BASE_REF} = ${base.sha.slice(0, 12)}; current HEAD = ${git('rev-parse', 'HEAD').slice(0, 12)}${git('status', '--porcelain', '--', 'src', 'server') ? '(uncommitted changes in src/ or server/, computed from the working tree)' : ''}`);

let bad = 0;
console.log('\n== 1. Without speed: baseline and current are verbatim identical ==');
const keys = Object.keys(cPlain);
const same = keys.filter((k) => bPlain[k] === cPlain[k]);
const diff = keys.filter((k) => bPlain[k] !== cPlain[k]);
if (Object.keys(bPlain).length !== keys.length) { bad++; console.log(`✖ The entry counts differ: baseline ${Object.keys(bPlain).length}, current ${keys.length}`); }
for (const k of diff) { bad++; console.log(`✖ ${k}\n    baseline ${String(bPlain[k]).slice(0, 160)}\n    current  ${String(cPlain[k]).slice(0, 160)}`); }
console.log(`${diff.length ? '✖' : '✔'} ${same.length}/${keys.length} entries verbatim identical`);

console.log('\n== 2. v-fx set to 2×, b1 in the cut segment set to 0.5× ==');
// Must change in the current workspace
const mustChange = ['frameIdentity', 'projectHash', 'audioPlan', 'vision@9', 'compose.args', 'compose.graph', 'sig v-fx', 'sig seg~b1', 'plan v-fx.contentKey', 'plan v-fx.snapshotKey', 'plan v-fx.streamMemberKey', 'plan seg~b1.contentKey'];
// Untouched clips must remain unchanged
const mustStay = ['sig c1', 'sig v-a', 'sig v-b', 'sig a-1', 'vision@1', 'vision@4', ...keys.filter((k) => /^plan (c1|v-a|v-b|a-1)\./.test(k))];
for (const k of mustChange) {
  const ok = cSped[k] !== undefined && cSped[k] !== cPlain[k];
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✖'} Current: ${k} changed${ok ? '' : '(not changed!)'}`);
}
for (const k of mustStay) {
  const ok = cSped[k] === cPlain[k];
  if (!ok) bad++;
  if (!ok) console.log(`✖ Current: ${k} should not have changed but did`);
}
console.log(`✔ Current: ${mustStay.length} entries of untouched clips unchanged`);
const blind = ['sig v-fx', 'sig seg~b1', 'plan v-fx.contentKey', 'plan v-fx.streamMemberKey', 'vision@9', 'compose.graph'].filter((k) => bSped[k] === bPlain[k]);
console.log(`Baseline (before the change) does not recognize speed. ${blind.length} entries changed speed but stayed the same: ${blind.join(', ')}`);
console.log(`\nCurrent: frame-fetch time of the speed-changed clip vision@9 = ${cSped['vision@9']} (at normal speed: ${cPlain['vision@9']})`);
console.log(`Current: the mix manifest has ${JSON.parse(cSped.audioPlan).map((e) => e.clipId).join(', ')} (at normal speed: ${JSON.parse(cPlain.audioPlan).map((e) => e.clipId).join(', ')})`);
console.log(bad ? `\n✖ ${bad} mismatches` : '\n✔ All match');
process.exit(bad ? 1 : 0);
