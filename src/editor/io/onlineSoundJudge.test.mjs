import '../../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { actions, getState } = await import('../../store/project.ts');
const { registerCards } = await import('../../kernel/registry.ts');
const { findClip } = await import('../../kernel/project.ts');
const { configureCardAudio, onlineCardAudioSynthesizable, cardAudioNodeOf, requestCardAudio, renderEmbeddedCardWav } = await import('../../audio/cardAudio.ts');
const { createMemorySoundCostStore, soundCostStoreKey } = await import('../../audio/soundCost.ts');
const { createNotificationRecipe } = await import('../../kernel/soundEffects.ts');
const { setOnlineUserCardAudioGate, onlineCardAudioRunnable } = await import('../../online/soundPolicy.ts');
const { configureOnlineSoundJudge, decideClipSound, decideRecipeSound, soundTargetOf, recipeSoundTarget, clipSoundRunnable, requestSoundBackfill, setSoundBackfillHandler, onlineSoundJudgeDebug, ONLINE_SOUND_HEAVY } = await import('./onlineSoundJudge.ts');
const { generateCardAudio } = await import('./cardAudioGeneration.ts');
const { startSoundGeneration, waitSoundGeneration } = await import('./soundGeneration.ts');

let evaluations = 0;
const audio = (_sources, range, p) => { evaluations++; return new Float32Array(range.count * 2).fill(p.value); };
const builtin = { id: 'b-av', name: 'Built-in AV card', source: 'native', defaults: { value: .25 }, controls: [], frameMode: 'direct', kind: 'animation', inputs: {}, Component() {}, audio };
const userCard = { ...builtin, id: 'u-av', name: 'User AV card', source: 'user' };
const audioOnly = { id: 'b-audio', name: 'Built-in audio card', source: 'native', defaults: { value: .5 }, controls: [], frameMode: 'direct', kind: 'audio', inputs: {}, audio };
registerCards([builtin, userCard, audioOnly]);
const defs = new Map([builtin, userCard, audioOnly].map(d => [d.id, d]));
configureCardAudio({ getCard: id => defs.get(id), sourceVersionOf: () => 'v1' });

const heavyRecord = (soundKey, kind) => ({ soundKey, kind, device: 'test-device', blockMs: 200, blockMaxMs: 220, blockFrames: 4096, sampleRate: 48000, samples: 16, measuredAt: 1 });
function setup({ online = true } = {}) {
  const store = createMemorySoundCostStore();
  const restore = configureOnlineSoundJudge({ online: () => online, store: () => store, device: () => 'test-device' });
  evaluations = 0;
  return { store, restore };
}
function clipOf(cardId, duration = .5) {
  actions.newProject('Online sound');
  const clip = actions.addCardClip(cardId, 0, { duration });
  return { project: getState().project, clip: findClip(getState().project, clip.id).clip };
}
function effectClip() {
  const recipe = createNotificationRecipe({ frequency: 660, duration: .2 });
  return { id: 'fx', cardId: '', mediaId: 'm1', params: {}, start: 0, end: recipe.frames / recipe.sampleRate, soundEffect: { recipe, reuseKey: 'sound-effect-sha256:x', requestId: 'r1' } };
}
function assetService() {
  const real = globalThis.fetch, stored = new Set();
  globalThis.fetch = async (url) => {
    const m = /\/media\/([a-f0-9]{64})\/(chunks|complete|\d+)$/.exec(String(url));
    assert.ok(m, String(url));
    if (m[2] === 'chunks') return Response.json({ complete: stored.has(m[1]), received: [] });
    if (m[2] === 'complete') stored.add(m[1]);
    return Response.json({ ok: true });
  };
  return { stored, restore() { globalThis.fetch = real; } };
}

test('B9 Scope of what is enabled: a built-in card\'s sound code can run online, a user card cannot; user cards are enabled only once the second stage\'s interface is connected', () => {
  assert.equal(onlineCardAudioRunnable(builtin), true);
  assert.equal(onlineCardAudioRunnable(audioOnly), true);
  assert.equal(onlineCardAudioRunnable(userCard), false);
  assert.equal(onlineCardAudioRunnable(undefined), false);
  assert.equal(onlineCardAudioRunnable({ source: 'native' }), false, 'Without audio() does not count');
  setOnlineUserCardAudioGate(() => true);
  try { assert.equal(onlineCardAudioRunnable(userCard), true); } finally { setOnlineUserCardAudioGate(null); }
  assert.equal(onlineCardAudioRunnable(userCard), false);
  const b = clipOf('b-av'), u = clipOf('u-av');
  assert.equal(onlineCardAudioSynthesizable(b.project, cardAudioNodeOf(b.project, b.clip)), true);
  assert.equal(onlineCardAudioSynthesizable(u.project, cardAudioNodeOf(u.project, u.clip)), false);
  assert.equal(clipSoundRunnable(b.project, b.clip), true);
  assert.equal(clipSoundRunnable(u.project, u.clip), false);
  assert.equal(clipSoundRunnable(b.project, effectClip()), true, 'A standalone sound effect has only a recipe and no card code');
});

test('B10 In the online page a built-in card\'s audio() is really executed, while a user card\'s is blocked and never executed', async () => {
  globalThis.__pcOnlinePage = true;
  try {
    const b = clipOf('b-av', .1), nodeId = cardAudioNodeOf(b.project, b.clip);
    evaluations = 0;
    const reply = await requestCardAudio({ project: b.project, nodeId, start: 0, count: 480, sampleRate: 48000 });
    assert.equal(reply.frames, 480); assert.equal(reply.channels, 2); assert.equal(reply.samples[0], .25); assert.equal(evaluations, 1);
    const wav = await renderEmbeddedCardWav(b.project, b.clip, new AbortController().signal);
    assert.equal(wav.frames, 4800);
    const u = clipOf('u-av', .1);
    evaluations = 0;
    await assert.rejects(() => requestCardAudio({ project: u.project, nodeId: cardAudioNodeOf(u.project, u.clip), start: 0, count: 480, sampleRate: 48000 }), /Online browser mode cannot yet run this card/);
    await assert.rejects(() => renderEmbeddedCardWav(u.project, u.clip, new AbortController().signal), /Online browser mode cannot yet run this card/);
    assert.equal(evaluations, 0);
  } finally { delete globalThis.__pcOnlinePage; }
});

test('B11 The desktop runtime does not classify: always synthesize, no measurement, no record written', async () => {
  const { store, restore } = setup({ online: false });
  try {
    const u = clipOf('u-av');
    assert.deepEqual(await decideClipSound(u.project, u.clip), { synth: true });
    assert.deepEqual(await decideRecipeSound(createNotificationRecipe()), { synth: true });
    assert.equal(evaluations, 0); assert.equal(store.size(), 0);
  } finally { restore(); }
});

test('B12 Online classified as light: measure once (silently), record it, synthesize in the browser; asking again reuses the record', async () => {
  const { store, restore } = setup();
  try {
    const b = clipOf('b-av');
    const first = await decideClipSound(b.project, b.clip);
    assert.equal(first.synth, true); assert.equal(first.verdict.reused, false); assert.equal(first.verdict.record.kind, 'card');
    assert.equal(evaluations, 16, 'The measurement called audio() for 16 chunks');
    assert.equal(store.size(), 1);
    const again = await decideClipSound(b.project, b.clip);
    assert.equal(again.verdict.reused, true); assert.equal(evaluations, 16);
    actions.setClipParams(b.clip.id, { value: .6 });
    const changed = getState().project, clip = findClip(changed, b.clip.id).clip;
    assert.notEqual(soundTargetOf(changed, clip).soundKey, soundTargetOf(b.project, b.clip).soundKey, 'Parameters are part of the identity');
    assert.equal((await decideClipSound(changed, clip)).verdict.reused, false);
    const fx = effectClip();
    const effect = await decideClipSound(b.project, fx);
    assert.equal(effect.synth, true); assert.equal(effect.verdict.record.kind, 'effect');
    assert.match(effect.verdict.record.soundKey, /^effect:/);
    assert.equal((await decideRecipeSound(fx.soundEffect.recipe)).verdict.reused, true, 'The same recipe is the same record whether or not there is a clip');
  } finally { restore(); }
});

test('B13 Online classified as heavy: not synthesized in the browser; a user card that cannot run on this page is likewise not synthesized, each with its own explanation; the rule of never synthesizing by tier is gone', async () => {
  const { store, restore } = setup();
  try {
    const b = clipOf('b-av');
    const key = soundTargetOf(b.project, b.clip).soundKey;
    await store.putCost(soundCostStoreKey(key, 'test-device'), heavyRecord(key, 'card'));
    const heavy = await decideClipSound(b.project, b.clip);
    assert.equal(heavy.synth, false); assert.equal(heavy.reason, 'heavy'); assert.equal(heavy.message, ONLINE_SOUND_HEAVY); assert.equal(evaluations, 0);
    const u = clipOf('u-av');
    const blocked = await decideClipSound(u.project, u.clip);
    assert.equal(blocked.synth, false); assert.equal(blocked.reason, 'not-runnable'); assert.equal(evaluations, 0);
  } finally { restore(); }
  // 原来按档一律不合成(2026-10-07 撤销):判定的结果只有「合成」「判重」「跑不了」三种
  const again = setup();
  try {
    const recipe = await decideRecipeSound(createNotificationRecipe());
    assert.ok(recipe.synth === true || recipe.reason === 'heavy', `Classified only by light or heavy: ${JSON.stringify(recipe)}`);
  } finally { again.restore(); }
});

test('B14 Online "Generate sound" and adding a new sound effect: those classified as light are generated and stored as usual, those classified as heavy are rejected with an explanation and the project is untouched', async () => {
  const service = assetService();
  const { store, restore } = setup();
  try {
    const b = clipOf('b-av', .1);
    const done = await generateCardAudio(b.clip.id);
    assert.equal(done.ok, true); assert.equal(getState().project.media.length, 1); assert.equal(service.stored.size, 1);
    const h = clipOf('b-av', .2);
    const key = soundTargetOf(h.project, h.clip).soundKey;
    await store.putCost(soundCostStoreKey(key, 'test-device'), heavyRecord(key, 'card'));
    const before = getState().project;
    await assert.rejects(() => generateCardAudio(h.clip.id), /too slow to synthesize on this device/);
    assert.equal(getState().project, before);
    actions.newProject('Online sound effect');
    const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 0 }).id);
    assert.equal(job.state, 'succeeded'); assert.equal(getState().project.media.length, 1);
    const recipe = createNotificationRecipe({ frequency: 990 });
    const seeded = await onlineSoundJudgeDebug().seed({ soundKey: recipeSoundTarget(recipe).soundKey, kind: 'effect', blockMs: 500 });
    assert.equal(seeded.device, 'test-device');
    const rejected = await waitSoundGeneration(startSoundGeneration({ recipe, start: 1 }).id);
    assert.equal(rejected.state, 'failed'); assert.match(rejected.error, /too slow to synthesize on this device/); assert.equal(getState().project.media.length, 1);
  } finally { restore(); service.restore(); }
});

test('B15 The interface that hands off to a render node: returns false when there is no receiver; once connected, it passes over the clip and the reason', async () => {
  const b = clipOf('b-av');
  assert.equal(await requestSoundBackfill({ project: b.project, clip: b.clip, reason: 'heavy' }), false);
  const seen = [];
  setSoundBackfillHandler(async (request) => { seen.push([request.clip.id, request.reason]); return true; });
  try { assert.equal(await requestSoundBackfill({ project: b.project, clip: b.clip, reason: 'heavy' }), true); } finally { setSoundBackfillHandler(null); }
  assert.deepEqual(seen, [[b.clip.id, 'heavy']]);
});

test('B16 A built-in audio motion card is not a media effect card: the online page still renders its picture; cards that define card(), cards with only audio(), and user cards still need a local PC', async () => {
  const { needsLocalPc, unsupportedHere, setOnlineBrowserMode, onlineBrowserMode } = await import('../../render/placeholderHost.ts');
  const never = () => false, Component = () => null;
  assert.equal(needsLocalPc('av', { Component, audio() {} }, never), false, 'Has a visual component plus audio(): an ordinary DOM card with sound');
  assert.equal(needsLocalPc('audio-only', { audio() {} }, never), true, 'Only audio(): an audio media effect card');
  assert.equal(needsLocalPc('gpu', { card() {} }, never), true, 'Defines card(): a visual media effect card');
  assert.equal(needsLocalPc('gpu-av', { card() {}, audio() {}, Component }, never), true, 'A card that defines card() is not enabled just because it has a component');
  assert.equal(needsLocalPc('dom', { Component }, never), false);
  assert.equal(needsLocalPc('u', { Component, audio() {} }, (id) => id === 'u'), true, 'User cards are judged regardless of shape');
  const before = onlineBrowserMode();
  try {
    setOnlineBrowserMode(true);
    assert.equal(unsupportedHere('av', { Component, audio() {} }, never), false);
    assert.equal(unsupportedHere('audio-only', { audio() {} }, never), true);
    setOnlineBrowserMode(false);
    assert.equal(unsupportedHere('audio-only', { audio() {} }, never), false, 'The desktop runtime is unaffected');
  } finally { setOnlineBrowserMode(before); }
});
