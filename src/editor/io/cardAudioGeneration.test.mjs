import '../../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { actions, getState } = await import('../../store/project.ts');
const { registerCards } = await import('../../kernel/registry.ts');
const { configureCardAudio, renderEmbeddedCardWav, persistentCardAudio, generatedCardAudioClipsAt } = await import('../../audio/cardAudio.ts');
const { generateCardAudio, cancelCardAudioGeneration } = await import('./cardAudioGeneration.ts');
const { findClip, flattenOverlay } = await import('../../kernel/project.ts');
const { serializeProc, parseProc } = await import('./proc.ts');
const { audioPlanOf } = await import('../../kernel/audioPlan.mjs');
let sourceVersion = 'v1', evaluations = 0;
const def = { id: 'av-fixture', name: 'Audio-visual test', defaults: { value: .25 }, controls: [], frameMode: 'direct', kind: 'animation', inputs: {}, Component() {},
  audio(_sources, range, p) { evaluations++; return new Float32Array(range.count * 2).fill(p.value + range.start / 48000); } };
registerCards([def]);
configureCardAudio({ getCard: id => id === def.id ? def : undefined, sourceVersionOf: () => sourceVersion });
function fresh(duration = .2) { sourceVersion = 'v1'; actions.newProject('Audio-visual'); return actions.addCardClip(def.id, 0, { duration }); }
function service(hold) {
  const old = fetch, calls = [], complete = new Set();
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    const m = /^\/api\/asset\/media\/([a-f0-9]{64})\/(chunks|complete|\d+)$/.exec(String(url)); assert.ok(m, String(url));
    if (m[2] === 'chunks') return Response.json({ complete: complete.has(m[1]), received: [] });
    if (m[2] === 'complete' && hold) await hold();
    if (m[2] === 'complete') complete.add(m[1]);
    return Response.json({ ok: true });
  };
  return { calls, complete, restore() { globalThis.fetch = old; } };
}
async function until(f) { for (let i = 0; i < 500; i++) { if (f()) return; await new Promise(r => setTimeout(r, 1)); } throw Error('timeout'); }

test('Actually samples into a persistent WAV, the original clip keeps its picture, and a single undo step and reopening can reuse it', async () => {
  const f = service();
  try {
    const clip = fresh(); const before = getState().project;
    assert.equal(clip.embeddedAudio, true); assert.throws(() => audioPlanOf(before), /not generated yet/);
    const result = await generateCardAudio(clip.id);
    const project = getState().project, now = findClip(project, clip.id).clip;
    assert.equal(now.mediaId, undefined); assert.equal(now.cardId, def.id); assert.equal(project.tracks.flatMap(t => t.clips).length, 1);
    assert.equal(before.media.length, 0); assert.equal(project.media.length, 1);
    assert.match(now.cardAudio.sourceKey, /^[a-f0-9]{64}$/);
    assert.equal(audioPlanOf(project).length, 1); assert.equal(generatedCardAudioClipsAt(project, .1).length, 1);
    const saved = serializeProc(); actions.loadProject(parseProc(saved));
    assert.equal((await generateCardAudio(clip.id)).reused, true);
    assert.equal(persistentCardAudio(getState().project, findClip(getState().project, clip.id).clip).media.id, result.mediaId);
    actions.loadProject(before); await generateCardAudio(clip.id); actions.undo();
    assert.equal(getState().project.media.length, 0); assert.equal(findClip(getState().project, clip.id).clip.cardAudio, undefined);
  } finally { f.restore(); }
});
test('Left trim and split continue the same audio-visual source time, without adding the offset twice', async () => {
  const f = service();
  try {
    const clip = fresh(1); await generateCardAudio(clip.id);
    actions.moveClip(clip.id, { start: .2 });
    let p = getState().project, c = findClip(p, clip.id).clip;
    assert.equal(c.mediaOffset, .2); assert.equal(audioPlanOf(p)[0].offset, .2); assert.equal(flattenOverlay(p).clips[0].sourceOffset, .2);
    const right = actions.splitClip(clip.id, .5);
    p = getState().project;
    assert.equal(right.mediaOffset, .5); assert.equal(findClip(p, right.id).clip.cardAudio.mediaId, c.cardAudio.mediaId);
    assert.deepEqual(audioPlanOf(p).map(x => x.offset), [.2, .5]);
    assert.equal(flattenOverlay(p).clips.find(c => c.id === right.id).sourceOffset, .5);
  } finally { f.restore(); }
});

test('Before reuse, check the asset service: if the bytes are lost, regenerate and upload them instead of reporting success based only on the old reference', async () => {
  const f = service();
  try {
    const clip = fresh();
    await generateCardAudio(clip.id);
    const count = evaluations, calls = f.calls.length;
    assert.equal((await generateCardAudio(clip.id)).reused, true);
    assert.equal(evaluations, count);
    assert.equal(f.calls.length, calls + 1, 'Reuse requires one chunks.complete request');
    f.complete.clear();
    const restored = await generateCardAudio(clip.id);
    assert.equal(restored.reused, false);
    assert.ok(evaluations > count);
    assert.equal(f.complete.size, 1, 'The regenerated WAV is stored via the service');
    assert.equal(getState().project.tracks.flatMap(t => t.clips).length, 1, 'The repair does not create a second visual clip');
  } finally { f.restore(); }
});
test('Source and parameter updates make results stale; a late upload after cancel/reopen does not change the project', async () => {
  let release;
  const f = service(() => new Promise(r => { release = r; }));
  try {
    const clip = fresh(); const snapshot = getState().project;
    const job = generateCardAudio(clip.id); const rejection = assert.rejects(job, /aborted|has changed/);
    await until(() => release); assert.equal(cancelCardAudioGeneration(clip.id), true); release(); await rejection;
    assert.equal(getState().project.media.length, 0);
    // Even if the previous pass was cancelled, the server might still finish receiving all bytes.
    // Clear this test service's hashes to trigger an in-flight upload again.
    f.complete.clear();
    release = undefined;
    const another = generateCardAudio(clip.id); const stale = assert.rejects(another, /has changed/);
    await until(() => release); actions.loadProject(structuredClone(snapshot)); release(); await stale;
    assert.equal(getState().project.media.length, 0);
  } finally { f.restore(); }
  const immediate = service();
  try {
    const clip = fresh(); await generateCardAudio(clip.id);
    sourceVersion = 'v2'; assert.throws(() => persistentCardAudio(getState().project, findClip(getState().project, clip.id).clip), /out of date/);
    sourceVersion = 'v1'; actions.setClipParams(clip.id, { value: .4 });
    assert.throws(() => audioPlanOf(getState().project), /out of date/);
  } finally { immediate.restore(); }
});
test('Online only reuses the WAV and never runs the user\'s audio; a missing persistent sound fails explicitly', async () => {
  const f = service();
  try {
    // User card: the online page does not execute its audio code (built-in cards can synthesize
    // online starting 2026-10-06, see onlineSoundJudge.test.mjs)
    const userDef = { ...def, id: 'av-user-fixture', source: 'user' };
    registerCards([userDef]);
    configureCardAudio({ getCard: id => id === def.id ? def : id === userDef.id ? userDef : undefined, sourceVersionOf: () => sourceVersion });
    sourceVersion = 'v1'; actions.newProject('Audio-visual'); const clip = actions.addCardClip(userDef.id, 0, { duration: .2 }); await generateCardAudio(clip.id);
    globalThis.__pcOnlinePage = true;
    const p = getState().project, c = findClip(p, clip.id).clip, count = evaluations;
    assert.equal(persistentCardAudio(p, c).media.kind, 'audio'); assert.equal(generatedCardAudioClipsAt(p, .1).length, 1);
    await assert.rejects(() => renderEmbeddedCardWav(p, c, new AbortController().signal), /Online browser mode cannot yet run this card/);
    assert.equal(evaluations, count);
    assert.throws(() => persistentCardAudio(p, { ...c, cardAudio: undefined }), /not generated yet/);
  } finally { delete globalThis.__pcOnlinePage; f.restore(); configureCardAudio({ getCard: id => id === def.id ? def : undefined, sourceVersionOf: () => sourceVersion }); }
});
test('Switching cards clears the old audio capability, and a failed validation leaves no cancelled task behind', async () => {
  const clip = fresh(); actions.setClipParams(clip.id, { invalid: () => 1 });
  await assert.rejects(() => generateCardAudio(clip.id)); assert.equal(cancelCardAudioGeneration(clip.id), false);
  registerCards([{ ...def, id: 'silent-fixture', audio: undefined }]);
  actions.setClipCard(clip.id, 'silent-fixture');
  const current = findClip(getState().project, clip.id).clip;
  assert.equal(current.embeddedAudio, undefined); assert.equal(current.cardAudio, undefined);
});

test('A new request for the same clip replaces the old one, and a late completion commits the current version at most once', async () => {
  const releases = [], f = service(() => new Promise(r => releases.push(r)));
  try {
    const clip = fresh();
    const first = generateCardAudio(clip.id); const aborted = assert.rejects(first, /aborted|has changed/);
    await until(() => releases.length === 1);
    actions.setClipParams(clip.id, { value: .75 });
    const second = generateCardAudio(clip.id, { force: true });
    releases[0](); await aborted;
    await until(() => releases.length === 2); releases[1](); await second;
    const p = getState().project;
    assert.equal(p.media.length, 1); assert.equal(findClip(p, clip.id).clip.cardAudio.identity.params.value, .75);
  } finally { f.restore(); }
});
test('Card generation is serial with at most four items; a queued item that is cancelled is neither uploaded nor stored', async () => {
  const releases = [], f = service(() => new Promise(r => releases.push(r)));
  try {
    fresh(); const clips = getState().project.tracks.flatMap(t => t.clips);
    for (let i = 1; i < 5; i++) clips.push(actions.addCardClip(def.id, i, { duration: .2 }));
    const first = generateCardAudio(clips[0].id); await until(() => releases.length === 1);
    const queued = clips.slice(1, 4).map(c => generateCardAudio(c.id));
    const rejected = queued.map(p => assert.rejects(p, /aborted/));
    await assert.rejects(() => generateCardAudio(clips[4].id), /At most 4 card audio jobs/);
    assert.equal(releases.length, 1); assert.equal(getState().project.media.length, 0);
    clips.slice(1, 4).forEach(c => assert.equal(cancelCardAudioGeneration(c.id), true));
    await Promise.all(rejected); releases[0](); await first;
    assert.equal(getState().project.media.length, 1); assert.equal(releases.length, 1);
  } finally { f.restore(); }
});
test('Oversized parameters are rejected before generating and uploading, protecting the atomic commit of the shared document', async () => {
  const f = service();
  try {
    const clip = fresh(); actions.setClipParams(clip.id, { manyEvents: 'x'.repeat(100 * 1024) });
    await assert.rejects(() => generateCardAudio(clip.id), /parameter record is too large/);
    assert.equal(f.calls.length, 0); assert.equal(getState().project.media.length, 0);
    assert.equal(cancelCardAudioGeneration(clip.id), false);
  } finally { f.restore(); }
});

test('An audio-visual card wrongly declared as the audio-only kind is rejected before adding, switching cards and adding to a new track', () => {
  const clip = fresh(); const p = getState().project;
  registerCards([{ ...def, id: 'invalid-av', kind: 'audio' }]);
  assert.throws(() => actions.addCardClip('invalid-av', 1), /Audio-visual cards cannot use kind:audio/);
  assert.throws(() => actions.addClipOnNewTrack({ cardId: 'invalid-av', start: 1 }), /Audio-visual cards cannot use kind:audio/);
  assert.throws(() => actions.setClipCard(clip.id, 'invalid-av'), /Audio-visual cards cannot use kind:audio/);
  assert.equal(getState().project, p);
});

test('A source change in the standalone user audio media effect card upstream of an online AV must also make the persistent WAV stale', async () => {
  const { cardAudioIdentity } = await import('../../kernel/cardAudioRendition.mjs');
  const { setSyncedUserCards } = await import('../../kernel/registry.ts');
  const root = { ...def, id: 'root-av' }, up = { id: 'upstream-audio', defaults: { value: 1 }, kind: 'audio', audio() {} };
  const c = { id: 'root', cardId: root.id, embeddedAudio: true, nodeId: 'n', start: 0, end: 1, params: {} };
  const p = { media: [{ id: 'wav', kind: 'audio', hash: 'a'.repeat(64), url: '/@media/wav' }], tracks: [{ id: 't', clips: [c] }],
    cardNodes: [{ id: 'n', adapter: 'card', cardId: root.id, inputs: { source: { nodeId: 'up' } } }, { id: 'up', adapter: 'card', cardId: up.id, kind: 'audio', inputs: {}, params: {} }] };
  c.cardAudio = { version: 1, mediaId: 'wav', cardId: root.id, sourceKey: 'key', sourceOffset: 0, duration: 1, sampleRate: 48000, frames: 48000, channels: 2,
    identity: cardAudioIdentity(p, c, { getCard: id => id === root.id ? root : up, sourceVersionOf: () => 'v1' }) };
  configureCardAudio({ getCard: () => undefined, sourceVersionOf: () => undefined });
  globalThis.__pcOnlinePage = true;
  try {
    setSyncedUserCards([{ id: root.id, name: 'root', embeddedAudio: true, audioSourceVersion: 'v1' }, { id: up.id, name: 'upstream', audioSourceVersion: 'v1' }]);
    assert.equal(persistentCardAudio(p, c).media.id, 'wav');
    setSyncedUserCards([{ id: root.id, name: 'root', embeddedAudio: true, audioSourceVersion: 'v1' }, { id: up.id, name: 'upstream', audioSourceVersion: 'v2' }]);
    assert.throws(() => persistentCardAudio(p, c), /out of date/);
  } finally {
    delete globalThis.__pcOnlinePage; setSyncedUserCards([]);
    configureCardAudio({ getCard: id => id === def.id ? def : undefined, sourceVersionOf: () => sourceVersion });
  }
});
