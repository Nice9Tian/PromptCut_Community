/**
 * Pre- and post-change key comparison for integrated audio-visual cards attached to speed-changed
 * media clips playing audio as usual (user decision, 2026-10-23: "Play sound."): verbatim identical at 1x.
 *
 *   node scripts/probes/av-card-speed-1x-compare.mjs [--base <commit>]   defaults to --base main
 *
 * The same sample project (three media clips with attached integrated audio-visual cards: one with trim
 * start, one whose node has its own timeOffset, and one with no mediaOffset specified; two integrated
 * audio-visual card clips; each clip with generated audio) is evaluated on the baseline commit and in
 * current workspace, across two scenarios: whole project has no speed change; same project has an
 * additional 2x normal video (preventing withMediaRates from taking shortcut of "returning as is when
 * there are no speed-changed clips"). Compared are: card graph (projectCardGraph + withMediaRates),
 * stage card table (flattenOverlay, including sourceOffset), source clock of 1x clips
 * (cardAudioSourceOffset), card audio identity, playback offset of generated audio, export mix manifest
 * (audioPlanOf), and mux-audio's buildAudioPlan.
 *
 * Baseline src/ and server/ are extracted with `git archive` into out/clip-speed-keys/<commit>/
 * (same directory as clip-speed-key-compare.mjs; out/ is not stored in repository).
 * Exit code: 0 = all verbatim identical; 1 = differences found.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.resolve(fileURLToPath(import.meta.url), '../../..');
const argv = process.argv.slice(2);
const BASE_REF = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'main';
const git = (...a) => execFileSync('git', a, { cwd: HERE, windowsHide: true, encoding: 'utf8' }).trim();
function checkoutBase(ref) {
  const sha = git('rev-parse', ref);
  const dir = path.join(HERE, 'out', 'clip-speed-keys', sha.slice(0, 12));
  if (fs.existsSync(path.join(dir, '.done'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['archive', '--format=tar', '-o', path.join(dir, 'base.tar'), sha, 'src', 'server'], { cwd: HERE, windowsHide: true });
  execFileSync('tar', ['-xf', 'base.tar'], { cwd: dir, windowsHide: true });
  fs.rmSync(path.join(dir, 'base.tar'));
  fs.writeFileSync(path.join(dir, '.done'), sha);
  return dir;
}
const cur = HERE, base = checkoutBase(BASE_REF);
console.log(`Baseline ${BASE_REF} → ${base}`);
await import(pathToFileURL(path.join(cur, 'src/testing/registerTs.mjs')).href);
const load = async (root) => {
  const u = (f) => pathToFileURL(path.join(root, f)).href;
  return {
    graph: await import(u('src/kernel/cardGraph.mjs')), time: await import(u('src/kernel/clipTime.mjs')),
    rend: await import(u('src/kernel/cardAudioRendition.mjs')), plan: await import(u('src/kernel/audioPlan.mjs')),
    proj: await import(u('src/kernel/project.ts')), mux: await import(u('server/bakery/mux-audio.mjs')),
  };
};
const A = await load(base), B = await load(cur);
const av = { id: 'av', defaults: { g: 1 }, kind: 'animation', Component() {}, audio() {} };
const getCard = (id) => (id === 'av' ? av : undefined);
const hooks = { getCard, sourceVersionOf: () => 'v1' };
const WAV = { id: 'wav', kind: 'audio', url: `/@media/${'c'.repeat(64)}`, hash: 'c'.repeat(64) };
const base0 = (extraSped) => ({
  id: 'p', width: 640, height: 360, fps: 30, duration: 20,
  media: [{ id: 'v', kind: 'video', url: '/@media/v.mp4', hash: 'a'.repeat(64) }, WAV],
  cardNodes: [
    { id: 'n1', adapter: 'card', cardId: 'av', kind: 'animation', embeddedAudio: true, params: {}, inputs: { source: { nodeId: '@clip/m1/source' } } },
    { id: 'n2', adapter: 'card', cardId: 'av', kind: 'animation', embeddedAudio: true, timeOffset: 1.25, params: {}, inputs: { source: { nodeId: '@clip/m2/source', offset: -1.25 } } },
    { id: 'n3', adapter: 'card', cardId: 'av', kind: 'animation', embeddedAudio: true, params: {}, inputs: { source: { nodeId: '@clip/m3/source' } } },
  ],
  tracks: [
    { id: 't1', clips: [
      { id: 'm1', cardId: 'av', mediaId: 'v', nodeId: 'n1', embeddedAudio: true, mediaOffset: 0.1 + 0.2, start: 0, end: 2, params: {} },
      { id: 'm2', cardId: 'av', mediaId: 'v', nodeId: 'n2', embeddedAudio: true, mediaOffset: 2.55, start: 2, end: 4, params: {} },
      { id: 'm3', cardId: 'av', mediaId: 'v', nodeId: 'n3', embeddedAudio: true, start: 4, end: 6, params: {} },
      { id: 'c1', cardId: 'av', embeddedAudio: true, mediaOffset: 0.7, start: 6, end: 8, params: {} },
      { id: 'c2', cardId: 'av', embeddedAudio: true, start: 8, end: 9, params: {} },
    ] },
    { id: 't2', clips: [{ id: 'plain', cardId: '', mediaId: 'v', mediaOffset: 3, start: 0, end: 4, params: {}, ...(extraSped ? { speed: 2 } : {}) }] },
  ],
});
const withRenditions = (M, p) => {
  const tracks = p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => !c.embeddedAudio ? c : ({ ...c, cardAudio: { version: 1, cardId: 'av', mediaId: 'wav', sampleRate: 48000,
    frames: 20 * 48000, channels: 2, sourceOffset: M.rend.cardAudioSourceOffset(p, c) - 0.5, identity: M.rend.cardAudioIdentity(p, c, hooks) } })) }));
  return { ...p, tracks };
};
const dump = (M, p0) => {
  const p = withRenditions(M, p0);
  const clips = p.tracks.flatMap((t) => t.clips);
  return {
    graph: JSON.stringify(M.time.withMediaRates(p, M.graph.projectCardGraph(p, getCard))),
    flat: JSON.stringify(M.proj.flattenOverlay(p).clips),
    sourceOffsets: JSON.stringify(clips.filter((c) => !c.speed).map((c) => M.rend.cardAudioSourceOffset(p, c))), // Only compare 1x clips (source clock of 2x clip is expected to change)
    identities: JSON.stringify(clips.filter((c) => c.embeddedAudio).map((c) => M.rend.cardAudioIdentity(p, c, hooks))),
    renditions: JSON.stringify(clips.filter((c) => c.embeddedAudio).map((c) => { const r = M.rend.resolveCardAudioRendition(p, c, hooks); return [r.offset, r.media.id]; })),
    audioPlan: JSON.stringify(M.plan.audioPlanOf(p)),
    muxPlan: JSON.stringify(M.mux.buildAudioPlan(p, 'out', () => true, (m) => `/x/${m.id}`)),
  };
};
let bad = 0, n = 0;
for (const sped of [false, true]) {
  const a = dump(A, base0(sped)), b = dump(B, base0(sped));
  for (const k of Object.keys(a)) {
    n++;
    const same = a[k] === b[k];
    if (!same) bad++;
    console.log(`${same ? '✔' : '✖'} ${sped ? 'Same project also has a 2x normal video clip' : 'Whole project has no speed change'}:${k} ${same ? 'identical' : 'different'}${same ? '' : `\\n   Baseline ${a[k].slice(0, 300)}\\n   Current ${b[k].slice(0, 300)}`}`);
  }
}
console.log(bad ? `✖ ${bad}/${n} items differ` : `✔ ${n}/${n} items identical`);
process.exit(bad ? 1 : 0);
