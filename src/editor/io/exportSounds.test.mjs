import '../../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { actions, getState } = await import('../../store/project.ts');
const { registerCards } = await import('../../kernel/registry.ts');
const { findClip } = await import('../../kernel/project.ts');
const { audioPlanOf } = await import('../../kernel/audioPlan.mjs');
const { configureCardAudio, assertProjectCardAudio } = await import('../../audio/cardAudio.ts');
const { createMemorySoundCostStore, soundCostStoreKey } = await import('../../audio/soundCost.ts');
const { listExportSoundNeeds, prepareExportSounds, ExportSoundError } = await import('./exportSounds.ts');
const { generateCardAudio } = await import('./cardAudioGeneration.ts');
const { startSoundGeneration, waitSoundGeneration, setSoundEffectRenderer } = await import('./soundGeneration.ts');
const { configureOnlineSoundJudge, soundTargetOf } = await import('./onlineSoundJudge.ts');

let sourceVersion = 'v1', evaluations = 0, failAudio = null;
const def = { id: 'av-export', name: 'Audio-visual export card', source: 'native', defaults: { value: .25 }, controls: [], frameMode: 'direct', kind: 'animation', inputs: {}, Component() {},
  audio(_sources, range, p) { evaluations++; if (failAudio === p.value) throw new Error('Synthesizer crashed'); return new Float32Array(range.count * 2).fill(p.value); } };
const silentDef = { id: 'plain-export', name: 'Silent card', source: 'native', defaults: {}, controls: [], frameMode: 'direct', kind: 'animation', Component() {} };
registerCards([def, silentDef]);
configureCardAudio({ getCard: id => id === def.id ? def : id === silentDef.id ? silentDef : undefined, sourceVersionOf: () => sourceVersion });

/** 素材服务的线上约定是唯一的假件:页面的上传客户端、store、生成流程都是真的 */
function service({ holdComplete } = {}) {
  const real = globalThis.fetch, stored = new Set(), calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const m = /^\/api\/asset\/media\/([a-f0-9]{64})\/(chunks|complete|\d+)$/.exec(String(url));
    assert.ok(m, `unexpected fetch ${url}`);
    calls.push(`${init.method ?? 'GET'} ${m[2]}`);
    if (m[2] === 'chunks') return Response.json({ complete: stored.has(m[1]), received: [] });
    if (m[2] === 'complete') { if (holdComplete) await holdComplete(); stored.add(m[1]); }
    return Response.json({ ok: true });
  };
  return { stored, calls, restore() { globalThis.fetch = real; } };
}
async function until(fn) { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 1)); } throw new Error('timeout'); }
const clips = () => getState().project.tracks.flatMap(t => t.clips);
const signal = () => new AbortController().signal;

/** 一个要先生成声音的项目:两张没生成过声音的有声卡、一段音效(生成过,之后按需把字节弄丢)、一张无声卡 */
async function project() {
  sourceVersion = 'v1'; failAudio = null;
  actions.newProject('Auto-generate sounds on export');
  const a = actions.addCardClip(def.id, 0, { duration: .2, params: { value: .25 } });
  const b = actions.addCardClip(def.id, 1, { duration: .2, params: { value: .5 } });
  const plain = actions.addCardClip(silentDef.id, 2, { duration: .5 });
  const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 3 }).id);
  assert.equal(job.state, 'succeeded');
  return { a, b, plain, effectId: job.result.clipId };
}

test('A1 A project with no sounds: the manifest is empty, the asset service is not queried, the project is not changed (export proceeds as usual)', async () => {
  const f = service();
  try {
    actions.newProject('silent'); actions.addCardClip(silentDef.id, 0, { duration: 1 });
    const before = getState().project;
    assert.deepEqual(await listExportSoundNeeds(signal()), []);
    const progress = [];
    assert.deepEqual(await prepareExportSounds({ signal: signal(), onProgress: (d, t) => progress.push([d, t]) }), { total: 0, generated: [] });
    assert.deepEqual(progress, [], 'No sounds to generate: no generation stage appears');
    assert.equal(f.calls.length, 0); assert.equal(getState().project, before);
  } finally { f.restore(); }
});

test('A2 The manifest recognizes three cases, not generated, stale and missing, with clip names; muted clips and tracks do not count', async () => {
  const f = service();
  try {
    const { a, b, effectId } = await project();
    await generateCardAudio(b.id);
    actions.setClipParams(b.id, { value: .75 });
    f.stored.clear();
    const needs = await listExportSoundNeeds(signal());
    const by = Object.fromEntries(needs.map(n => [n.clipId, n]));
    assert.equal(needs.length, 3);
    assert.equal(by[a.id].kind, 'card'); assert.equal(by[a.id].reason, 'ungenerated'); assert.match(by[a.id].detail, /not yet generated/);
    assert.equal(by[b.id].reason, 'stale'); assert.match(by[b.id].detail, /stale/);
    assert.equal(by[effectId].kind, 'effect'); assert.equal(by[effectId].reason, 'missing'); assert.match(by[effectId].detail, /The asset service has no file/);
    assert.ok(needs.every(n => typeof n.label === 'string' && n.label.length > 0));
    actions.setClipMuted(a.id, true);
    assert.equal((await listExportSoundNeeds(signal())).some(n => n.clipId === a.id), false, 'A muted clip makes no sound, so no generation is needed');
  } finally { f.restore(); }
});

test('A3 The media record is still in the project but the asset service has no bytes: this also counts as missing (the same hash is queried only once)', async () => {
  const f = service();
  try {
    const { a, b, effectId } = await project();
    await generateCardAudio(a.id); await generateCardAudio(b.id);
    assert.deepEqual(await listExportSoundNeeds(signal()), [], 'All generated: no need to generate again');
    const hash = getState().project.media.find(m => m.id === findClip(getState().project, a.id).clip.cardAudio.mediaId).hash;
    f.stored.delete(hash);
    const needs = await listExportSoundNeeds(signal());
    assert.deepEqual(needs.map(n => [n.clipId, n.kind, n.reason]), [[a.id, 'card', 'missing']]);
    assert.ok(effectId);
  } finally { f.restore(); }
});

test('A4 At export start, generate all sounds in the manifest: afterwards the mix plan no longer reports missing, and progress completes by segment count', async () => {
  const f = service();
  try {
    const { a, b, effectId } = await project();
    await generateCardAudio(b.id); actions.setClipParams(b.id, { value: .75 });
    f.stored.clear();
    assert.throws(() => assertProjectCardAudio(getState().project), /not generated yet|stale/, 'Before the change: exporting such a project fails outright');
    const progress = [];
    const result = await prepareExportSounds({ signal: signal(), onProgress: (done, total) => progress.push([done, total]) });
    assert.equal(result.total, 3); assert.deepEqual(result.generated.sort(), [a.id, b.id, effectId].sort());
    assert.deepEqual(progress[0], [0, 3]); assert.deepEqual(progress.at(-1), [3, 3]);
    assert.ok(progress.every(([done, total], i) => total === 3 && (i === 0 || done >= progress[i - 1][0])), 'Progress is monotonic');
    assert.ok(progress.some(([done]) => done > 0 && done < 1), 'Progress is also reported within a single segment');
    const p = getState().project;
    assertProjectCardAudio(p);
    const plan = audioPlanOf(p);
    assert.equal(plan.length, 3, 'All three sounds enter the mix plan');
    for (const entry of plan) { const m = p.media.find(x => x.id === entry.mediaId); assert.ok(f.stored.has(m.hash), `The bytes of ${m.name} are in the asset service`); }
    assert.equal(findClip(p, b.id).clip.cardAudio.identity.params.value, .75, 'The stale one is regenerated with the current parameters');
    assert.deepEqual(await listExportSoundNeeds(signal()), []);
  } finally { f.restore(); }
});

test('A5 A standalone sound effect missing its bytes restores the same sound from its original recipe: the project is untouched, and no new clip or media is created', async () => {
  const f = service();
  try {
    actions.newProject('Restore sound effect');
    const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 0 }).id);
    const before = getState().project, hash = before.media[0].hash;
    f.stored.clear();
    const result = await prepareExportSounds({ signal: signal() });
    assert.deepEqual(result.generated, [job.result.clipId]);
    assert.equal(getState().project, before, 'Same sound: only the bytes are restored to the asset service');
    assert.ok(f.stored.has(hash));
  } finally { f.restore(); }
});

test('A6 The sound effect\'s media record was deleted: the record is restored and the clip points to it, without entering the undo stack or changing the selection', async () => {
  const f = service();
  try {
    actions.newProject('Restore media record');
    const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 0 }).id);
    const clipId = job.result.clipId, hash = getState().project.media[0].hash;
    actions.loadProject({ ...structuredClone(getState().project), media: [] });
    actions.select([]);
    const selection = getState().selection;
    assert.throws(() => audioPlanOf(getState().project), /missing/);
    await prepareExportSounds({ signal: signal() });
    const p = getState().project, clip = findClip(p, clipId).clip;
    assert.equal(p.media.length, 1); assert.equal(p.media[0].hash, hash); assert.equal(clip.mediaId, p.media[0].id);
    assert.equal(clips().length, 1);
    assert.deepEqual(getState().selection, selection);
    assert.equal(audioPlanOf(p).length, 1);
    actions.undo();
    assert.equal(getState().project.media.length, 1, 'Restoring a media record is not a user action step');
  } finally { f.restore(); }
});

test('A7 Cancel during generation: export and generation both stop, the segment in progress is not committed and leaves no partial result; the segment finished earlier is complete', async () => {
  let release;
  const f = service({ holdComplete: () => new Promise(r => { release = r; }) });
  try {
    sourceVersion = 'v1'; failAudio = null;
    actions.newProject('Cancel');
    const a = actions.addCardClip(def.id, 0, { duration: .2, params: { value: .25 } });
    const b = actions.addCardClip(def.id, 1, { duration: .2, params: { value: .5 } });
    const abort = new AbortController(), progress = [];
    const run = prepareExportSounds({ signal: abort.signal, onProgress: (d, t) => progress.push([d, t]) });
    const settled = run.then(() => ({ ok: true }), (error) => ({ error }));
    await until(() => release); release(); release = undefined;      // 第一段入库、提交
    await until(() => release);                                       // 第二段卡在入库
    const evaluated = evaluations;
    abort.abort(); release();
    const { error } = await settled;
    assert.equal(error.cancelled, true); assert.match(error.message, /Export canceled/);
    const p = getState().project;
    assert.ok(findClip(p, a.id).clip.cardAudio, 'The segment finished before the cancel is a complete sound');
    assert.equal(findClip(p, b.id).clip.cardAudio, undefined, 'The segment in progress was not committed');
    assert.equal(p.media.length, 1, 'No half-finished media record');
    for (const m of p.media) assert.ok(f.stored.has(m.hash));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(evaluations, evaluated, 'No more synthesis after cancel');
    assert.equal(getState().project, p, 'A late store response does not change the project');
    assert.ok(progress.every(([done]) => done < 2), 'Progress did not reach the completion of the second segment');
  } finally { f.restore(); }
});

test('A8 Cancel before starting: do nothing', async () => {
  const f = service();
  try {
    actions.newProject('Cancel first'); actions.addCardClip(def.id, 0, { duration: .2 });
    const before = getState().project, abort = new AbortController();
    abort.abort();
    await assert.rejects(() => prepareExportSounds({ signal: abort.signal }), (e) => e.cancelled === true);
    assert.equal(getState().project, before); assert.equal(f.stored.size, 0);
  } finally { f.restore(); }
});

test('A9 A segment cannot be generated: export fails and names the clip; segments after it are not processed, those finished before it are kept', async () => {
  const f = service();
  try {
    sourceVersion = 'v1';
    actions.newProject('failed');
    const a = actions.addCardClip(def.id, 0, { duration: .2, params: { value: .25 } });
    const bad = actions.addCardClip(def.id, 1, { duration: .2, params: { value: .5 } });
    const c = actions.addCardClip(def.id, 2, { duration: .2, params: { value: .6 } });
    failAudio = .5;
    const error = await prepareExportSounds({ signal: signal() }).then(() => null, (e) => e);
    assert.ok(error instanceof ExportSoundError);
    assert.equal(error.code, 'export-sound-failed'); assert.equal(error.clipId, bad.id); assert.equal(error.cancelled, undefined);
    assert.match(error.message, new RegExp(`Cannot generate sound for clip ".+" \\(${bad.id}\\)`)); assert.match(error.message, /Synthesizer crashed/);
    const p = getState().project;
    assert.ok(findClip(p, a.id).clip.cardAudio); assert.equal(findClip(p, bad.id).clip.cardAudio, undefined); assert.equal(findClip(p, c.id).clip.cardAudio, undefined);
    assert.equal(p.media.length, 1);
  } finally { failAudio = null; f.restore(); }
});

test('A10 A sound effect synthesis failure also names the clip; an AV card on a locked track that cannot be generated also explains why', async () => {
  const f = service();
  try {
    actions.newProject('Sound effect failure');
    const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 0 }).id);
    f.stored.clear();
    setSoundEffectRenderer(async () => { throw new Error('Synthesis process failed to start'); });
    const error = await prepareExportSounds({ signal: signal() }).then(() => null, (e) => e);
    assert.ok(error instanceof ExportSoundError); assert.equal(error.clipId, job.result.clipId); assert.match(error.message, /Synthesis process failed to start/);
    setSoundEffectRenderer(null);
    actions.newProject('Locked');
    const clip = actions.addCardClip(def.id, 0, { duration: .2 });
    actions.updateTrack(getState().project.tracks.find(t => t.clips.some(c => c.id === clip.id)).id, { locked: true });
    const locked = await prepareExportSounds({ signal: signal() }).then(() => null, (e) => e);
    assert.ok(locked instanceof ExportSoundError); assert.equal(locked.clipId, clip.id); assert.match(locked.message, /Unlock the track/);
  } finally { setSoundEffectRenderer(null); f.restore(); }
});

test('A11 Online page: sounds classified as light are generated in the browser; those classified as heavy with no output are not synthesized, and export fails naming the clip', async () => {
  const f = service();
  const store = createMemorySoundCostStore();
  const restore = configureOnlineSoundJudge({ online: () => true, store: () => store, device: () => 'test-device' });
  try {
    sourceVersion = 'v1'; failAudio = null;
    actions.newProject('Online export');
    const light = actions.addCardClip(def.id, 0, { duration: .2, params: { value: .25 } });
    await prepareExportSounds({ signal: signal() });
    assert.ok(findClip(getState().project, light.id).clip.cardAudio, 'Classified as light: the online page generates it itself');
    const heavy = actions.addCardClip(def.id, 1, { duration: .2, params: { value: .5 } });
    const p = getState().project, key = soundTargetOf(p, findClip(p, heavy.id).clip).soundKey;
    await store.putCost(soundCostStoreKey(key, 'test-device'), { soundKey: key, kind: 'card', device: 'test-device', blockMs: 300, blockMaxMs: 300, blockFrames: 4096, sampleRate: 48000, samples: 16, measuredAt: 1 });
    const before = evaluations, handed = [];
    const error = await prepareExportSounds({ signal: signal(), deps: { backfill: async (request) => { handed.push([request.clip.id, request.reason]); return false; } } }).then(() => null, (e) => e);
    assert.ok(error instanceof ExportSoundError); assert.equal(error.clipId, heavy.id); assert.match(error.message, /too slow to synthesize on this device/);
    assert.equal(evaluations, before, 'Classified as heavy: not a single chunk is synthesized in the browser');
    assert.deepEqual(handed, [[heavy.id, 'heavy']], 'No output: the interface that hands off to a render node was called');
    assert.equal(findClip(getState().project, heavy.id).clip.cardAudio, undefined);
  } finally { restore(); f.restore(); }
});

/*
 * A12(在线某一档一律不合成)删了:声音不按身份、不按档区分(2026-10-07 用户定,`product/platforms.md`「卡片声音的平台边界」),
 * 在线页面只按 A11 的轻重判定合成或交给渲染节点。
 */

/*
 * 剪辑段(`product/rendering.md`「导出时自动生成声音」递归进剪辑段):被引用剪辑里的有声卡,导出前在它自己那条剪辑里生成,
 * 结果写回那条停放的剪辑;混音按剪辑段的音量、淡入淡出、静音处理。
 */
async function nestedProject({ muted = false } = {}) {
  sourceVersion = 'v1'; failAudio = null;
  actions.newProject('Audio cards inside a cut segment');
  const child = actions.addCut('Cut 2', { switchTo: true });
  const inner = actions.addCardClip(def.id, 0.5, { duration: .4, params: { value: .25 } });
  const outside = actions.addCardClip(def.id, 5, { duration: .4, params: { value: .5 } }); // 落在剪辑段窗口外
  const root = getState().project.cuts[0].id;
  actions.switchCut(root);
  const seg = actions.addCutSegment(child.id, 1, { duration: 2 });
  actions.setClipVolume(seg.id, .5);
  if (muted) actions.setClipMuted(seg.id, true);
  const seg2 = actions.addCutSegment(child.id, 4, { duration: 1 }); // 同一条剪辑引用两次:里面的片段只列一次
  if (muted) actions.setClipMuted(seg2.id, true);
  return { child, inner, outside, seg, seg2, root };
}
const parked = (cutId, clipId) => getState().project.cuts.find(c => c.id === cutId).tracks.flatMap(t => t.clips).find(c => c.id === clipId);

test('C1 Cut segment: the manifest walks into the referenced cut, items outside the window are not listed and repeated references are not listed twice; generation writes back to the parked cut; the mix sounds at the segment volume', async () => {
  const f = service();
  try {
    const { child, inner, outside, seg } = await nestedProject();
    assert.throws(() => assertProjectCardAudio(getState().project), new RegExp(`Card audio of ${inner.id} is not generated yet`), 'Before the change: export fails outright and names the original clip');
    const needs = await listExportSoundNeeds(signal());
    assert.deepEqual(needs.map(n => [n.clipId, n.cutId, n.kind, n.reason]), [[inner.id, child.id, 'card', 'ungenerated']]);
    assert.match(needs[0].label, /in cut "剪辑2"/);
    assert.ok(!needs.some(n => n.clipId === outside.id), 'A clip outside the cut segment\'s window makes no sound, so no generation is needed');
    const activeBefore = getState().project.tracks;
    const result = await prepareExportSounds({ signal: signal() });
    assert.deepEqual(result.generated, [inner.id]);
    const p = getState().project;
    assert.ok(parked(child.id, inner.id).cardAudio, 'The sound is recorded on the original clip inside the referenced cut');
    assert.equal(parked(child.id, outside.id).cardAudio, undefined);
    assert.equal(p.tracks, activeBefore, 'The tracks of the active cut are untouched');
    assertProjectCardAudio(p);
    const plan = audioPlanOf(p);
    assert.equal(plan.length, 2, 'Each of the two cut segments contributes one copy (the same WAV): at 1.5 s and 4.5 s');
    assert.deepEqual(plan.map(e => e.start).sort(), [1.5, 4.5]);
    assert.equal(new Set(plan.map(e => e.mediaId)).size, 1);
    const first = plan.find(e => e.clipId.startsWith(`${seg.id}/`));
    assert.ok(first, 'The copy from the first cut segment entered the mix');
    assert.equal(first.start, 1.5); assert.equal(first.volume, .5, 'The volume is multiplied by the cut segment\'s volume');
    assert.ok(f.stored.has(p.media.find(m => m.id === first.mediaId).hash));
    assert.deepEqual(await listExportSoundNeeds(signal()), []);
  } finally { f.restore(); }
});

test('C2 Cut segment muted: the AV cards inside make no sound and need no generation; after unmuting they must be generated', async () => {
  const f = service();
  try {
    const { inner, seg } = await nestedProject({ muted: true });
    const needs = await listExportSoundNeeds(signal());
    assert.ok(!needs.some(n => n.clipId === inner.id), 'Both cut segments muted: nothing inside them is listed');
    actions.setClipMuted(seg.id, false);
    assert.deepEqual((await listExportSoundNeeds(signal())).map(n => n.clipId), [inner.id]);
  } finally { f.restore(); }
});

test('C3 A clip in the referenced cut was already generated and then had its parameters changed: judged stale, and regenerated with the new parameters before export', async () => {
  const f = service();
  try {
    const { child, inner, root } = await nestedProject();
    await prepareExportSounds({ signal: signal() });
    actions.switchCut(child.id);
    actions.setClipParams(inner.id, { value: .75 });
    actions.switchCut(root);
    const needs = await listExportSoundNeeds(signal());
    assert.deepEqual(needs.map(n => [n.clipId, n.reason]), [[inner.id, 'stale']]);
    await prepareExportSounds({ signal: signal() });
    assert.equal(parked(child.id, inner.id).cardAudio.identity.params.value, .75);
    assertProjectCardAudio(getState().project);
  } finally { f.restore(); }
});
