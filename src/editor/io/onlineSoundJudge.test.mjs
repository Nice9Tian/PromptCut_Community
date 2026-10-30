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
const builtin = { id: 'b-av', name: '内置有声卡', source: 'native', defaults: { value: .25 }, controls: [], frameMode: 'direct', kind: 'animation', inputs: {}, Component() {}, audio };
const userCard = { ...builtin, id: 'u-av', name: '用户有声卡', source: 'user' };
const audioOnly = { id: 'b-audio', name: '内置音频卡', source: 'native', defaults: { value: .5 }, controls: [], frameMode: 'direct', kind: 'audio', inputs: {}, audio };
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
  actions.newProject('在线声音');
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

test('B9 放开的范围:内置卡的声音代码在线能跑,用户卡不能;第二段的接口接上才放开用户卡', () => {
  assert.equal(onlineCardAudioRunnable(builtin), true);
  assert.equal(onlineCardAudioRunnable(audioOnly), true);
  assert.equal(onlineCardAudioRunnable(userCard), false);
  assert.equal(onlineCardAudioRunnable(undefined), false);
  assert.equal(onlineCardAudioRunnable({ source: 'native' }), false, '没有 audio() 的不算');
  setOnlineUserCardAudioGate(() => true);
  try { assert.equal(onlineCardAudioRunnable(userCard), true); } finally { setOnlineUserCardAudioGate(null); }
  assert.equal(onlineCardAudioRunnable(userCard), false);
  const b = clipOf('b-av'), u = clipOf('u-av');
  assert.equal(onlineCardAudioSynthesizable(b.project, cardAudioNodeOf(b.project, b.clip)), true);
  assert.equal(onlineCardAudioSynthesizable(u.project, cardAudioNodeOf(u.project, u.clip)), false);
  assert.equal(clipSoundRunnable(b.project, b.clip), true);
  assert.equal(clipSoundRunnable(u.project, u.clip), false);
  assert.equal(clipSoundRunnable(b.project, effectClip()), true, '独立音效只有配方,没有卡片代码');
});

test('B10 在线页面里内置卡的 audio() 真的被执行,用户卡的被拦下、一次都不执行', async () => {
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
    await assert.rejects(() => requestCardAudio({ project: u.project, nodeId: cardAudioNodeOf(u.project, u.clip), start: 0, count: 480, sampleRate: 48000 }), /在线浏览器模式暂不能执行/);
    await assert.rejects(() => renderEmbeddedCardWav(u.project, u.clip, new AbortController().signal), /在线浏览器模式暂不能执行/);
    assert.equal(evaluations, 0);
  } finally { delete globalThis.__pcOnlinePage; }
});

test('B11 桌面运行环境不判:一律合成,不测量、不写记录', async () => {
  const { store, restore } = setup({ online: false });
  try {
    const u = clipOf('u-av');
    assert.deepEqual(await decideClipSound(u.project, u.clip), { synth: true });
    assert.deepEqual(await decideRecipeSound(createNotificationRecipe()), { synth: true });
    assert.equal(evaluations, 0); assert.equal(store.size(), 0);
  } finally { restore(); }
});

test('B12 在线判轻:测一次(不出声)、记下、在浏览器里合成;再问复用记录', async () => {
  const { store, restore } = setup();
  try {
    const b = clipOf('b-av');
    const first = await decideClipSound(b.project, b.clip);
    assert.equal(first.synth, true); assert.equal(first.verdict.reused, false); assert.equal(first.verdict.record.kind, 'card');
    assert.equal(evaluations, 16, '测量调了 16 块 audio()');
    assert.equal(store.size(), 1);
    const again = await decideClipSound(b.project, b.clip);
    assert.equal(again.verdict.reused, true); assert.equal(evaluations, 16);
    actions.setClipParams(b.clip.id, { value: .6 });
    const changed = getState().project, clip = findClip(changed, b.clip.id).clip;
    assert.notEqual(soundTargetOf(changed, clip).soundKey, soundTargetOf(b.project, b.clip).soundKey, '参数进身份');
    assert.equal((await decideClipSound(changed, clip)).verdict.reused, false);
    const fx = effectClip();
    const effect = await decideClipSound(b.project, fx);
    assert.equal(effect.synth, true); assert.equal(effect.verdict.record.kind, 'effect');
    assert.match(effect.verdict.record.soundKey, /^effect:/);
    assert.equal((await decideRecipeSound(fx.soundEffect.recipe)).verdict.reused, true, '同一份配方,有没有片段都是同一条记录');
  } finally { restore(); }
});

test('B13 在线判重:不在浏览器里合成;本页跑不了的用户卡同样不合成,各有说明;不再有按档一律不合成的那一条', async () => {
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
    assert.ok(recipe.synth === true || recipe.reason === 'heavy', `只按轻重判:${JSON.stringify(recipe)}`);
  } finally { again.restore(); }
});

test('B14 在线「生成声音」与新加音效:判轻照常生成入库,判重拒绝并说明、项目不动', async () => {
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
    await assert.rejects(() => generateCardAudio(h.clip.id), /判重/);
    assert.equal(getState().project, before);
    actions.newProject('在线音效');
    const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 0 }).id);
    assert.equal(job.state, 'succeeded'); assert.equal(getState().project.media.length, 1);
    const recipe = createNotificationRecipe({ frequency: 990 });
    const seeded = await onlineSoundJudgeDebug().seed({ soundKey: recipeSoundTarget(recipe).soundKey, kind: 'effect', blockMs: 500 });
    assert.equal(seeded.device, 'test-device');
    const rejected = await waitSoundGeneration(startSoundGeneration({ recipe, start: 1 }).id);
    assert.equal(rejected.state, 'failed'); assert.match(rejected.error, /判重/); assert.equal(getState().project.media.length, 1);
  } finally { restore(); service.restore(); }
});

test('B15 交给渲染节点的接口:没有接收方回 false,接上后把片段和原因交过去', async () => {
  const b = clipOf('b-av');
  assert.equal(await requestSoundBackfill({ project: b.project, clip: b.clip, reason: 'heavy' }), false);
  const seen = [];
  setSoundBackfillHandler(async (request) => { seen.push([request.clip.id, request.reason]); return true; });
  try { assert.equal(await requestSoundBackfill({ project: b.project, clip: b.clip, reason: 'heavy' }), true); } finally { setSoundBackfillHandler(null); }
  assert.deepEqual(seen, [[b.clip.id, 'heavy']]);
});

test('B16 内置有声动效卡不是素材效果卡:在线页面照常渲染它的画面;写了 card() 的、只有 audio() 的、用户卡仍要本地 PC', async () => {
  const { needsLocalPc, unsupportedHere, setOnlineBrowserMode, onlineBrowserMode } = await import('../../render/placeholderHost.ts');
  const never = () => false, Component = () => null;
  assert.equal(needsLocalPc('av', { Component, audio() {} }, never), false, '有画面组件又带 audio():普通 DOM 卡加声音');
  assert.equal(needsLocalPc('audio-only', { audio() {} }, never), true, '只有 audio():音频素材效果卡');
  assert.equal(needsLocalPc('gpu', { card() {} }, never), true, '写了 card():视觉素材效果卡');
  assert.equal(needsLocalPc('gpu-av', { card() {}, audio() {}, Component }, never), true, '写了 card() 的不因为带了组件就放开');
  assert.equal(needsLocalPc('dom', { Component }, never), false);
  assert.equal(needsLocalPc('u', { Component, audio() {} }, (id) => id === 'u'), true, '用户卡不看形态');
  const before = onlineBrowserMode();
  try {
    setOnlineBrowserMode(true);
    assert.equal(unsupportedHere('av', { Component, audio() {} }, never), false);
    assert.equal(unsupportedHere('audio-only', { audio() {} }, never), true);
    setOnlineBrowserMode(false);
    assert.equal(unsupportedHere('audio-only', { audio() {} }, never), false, '桌面运行环境不受影响');
  } finally { setOnlineBrowserMode(before); }
});
