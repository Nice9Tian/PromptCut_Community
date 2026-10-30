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
const def = { id: 'av-fixture', name: '声画测试', defaults: { value: .25 }, controls: [], frameMode: 'direct', kind: 'animation', inputs: {}, Component() {},
  audio(_sources, range, p) { evaluations++; return new Float32Array(range.count * 2).fill(p.value + range.start / 48000); } };
registerCards([def]);
configureCardAudio({ getCard: id => id === def.id ? def : undefined, sourceVersionOf: () => sourceVersion });
function fresh(duration = .2) { sourceVersion = 'v1'; actions.newProject('声画'); return actions.addCardClip(def.id, 0, { duration }); }
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

test('实际采样到持久WAV，原片段画面保留，一步撤销和重开可复用', async () => {
  const f = service();
  try {
    const clip = fresh(); const before = getState().project;
    assert.equal(clip.embeddedAudio, true); assert.throws(() => audioPlanOf(before), /尚未生成/);
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
test('左裁切与切分延续同一音画源时间，不双加偏移', async () => {
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

test('复用前核对素材服务：字节丢失会重新生成上传，而非只凭旧引用报成功', async () => {
  const f = service();
  try {
    const clip = fresh();
    await generateCardAudio(clip.id);
    const count = evaluations, calls = f.calls.length;
    assert.equal((await generateCardAudio(clip.id)).reused, true);
    assert.equal(evaluations, count);
    assert.equal(f.calls.length, calls + 1, '复用要请求一次 chunks.complete');
    f.complete.clear();
    const restored = await generateCardAudio(clip.id);
    assert.equal(restored.reused, false);
    assert.ok(evaluations > count);
    assert.equal(f.complete.size, 1, '重新生成的 WAV 经服务入库');
    assert.equal(getState().project.tracks.flatMap(t => t.clips).length, 1, '修复不创建第二个视觉片段');
  } finally { f.restore(); }
});
test('源码和参数更新过期，取消/重开时晚到上传不改项目', async () => {
  let release;
  const f = service(() => new Promise(r => { release = r; }));
  try {
    const clip = fresh(); const snapshot = getState().project;
    const job = generateCardAudio(clip.id); const rejection = assert.rejects(job, /aborted|已变化/);
    await until(() => release); assert.equal(cancelCardAudioGeneration(clip.id), true); release(); await rejection;
    assert.equal(getState().project.media.length, 0);
    // 上一趟即使被取消，服务端仍可能收完字节。清理此测试服务的哈希以再次制造在途上传。
    f.complete.clear();
    release = undefined;
    const another = generateCardAudio(clip.id); const stale = assert.rejects(another, /已变化/);
    await until(() => release); actions.loadProject(structuredClone(snapshot)); release(); await stale;
    assert.equal(getState().project.media.length, 0);
  } finally { f.restore(); }
  const immediate = service();
  try {
    const clip = fresh(); await generateCardAudio(clip.id);
    sourceVersion = 'v2'; assert.throws(() => persistentCardAudio(getState().project, findClip(getState().project, clip.id).clip), /已过期/);
    sourceVersion = 'v1'; actions.setClipParams(clip.id, { value: .4 });
    assert.throws(() => audioPlanOf(getState().project), /已过期/);
  } finally { immediate.restore(); }
});
test('在线只复用WAV，从不执行用户audio；缺失持久声音明确失败', async () => {
  const f = service();
  try {
    // 用户卡:在线页面不执行它的声音代码(内置卡 2026-10-06 起可以在线合成,见 onlineSoundJudge.test.mjs)
    const userDef = { ...def, id: 'av-user-fixture', source: 'user' };
    registerCards([userDef]);
    configureCardAudio({ getCard: id => id === def.id ? def : id === userDef.id ? userDef : undefined, sourceVersionOf: () => sourceVersion });
    sourceVersion = 'v1'; actions.newProject('声画'); const clip = actions.addCardClip(userDef.id, 0, { duration: .2 }); await generateCardAudio(clip.id);
    globalThis.__pcOnlinePage = true;
    const p = getState().project, c = findClip(p, clip.id).clip, count = evaluations;
    assert.equal(persistentCardAudio(p, c).media.kind, 'audio'); assert.equal(generatedCardAudioClipsAt(p, .1).length, 1);
    await assert.rejects(() => renderEmbeddedCardWav(p, c, new AbortController().signal), /在线/);
    assert.equal(evaluations, count);
    assert.throws(() => persistentCardAudio(p, { ...c, cardAudio: undefined }), /尚未生成/);
  } finally { delete globalThis.__pcOnlinePage; f.restore(); configureCardAudio({ getCard: id => id === def.id ? def : undefined, sourceVersionOf: () => sourceVersion }); }
});
test('换卡清掉旧音频能力，失败验证不会遗留取消任务', async () => {
  const clip = fresh(); actions.setClipParams(clip.id, { invalid: () => 1 });
  await assert.rejects(() => generateCardAudio(clip.id)); assert.equal(cancelCardAudioGeneration(clip.id), false);
  registerCards([{ ...def, id: 'silent-fixture', audio: undefined }]);
  actions.setClipCard(clip.id, 'silent-fixture');
  const current = findClip(getState().project, clip.id).clip;
  assert.equal(current.embeddedAudio, undefined); assert.equal(current.cardAudio, undefined);
});

test('同一片段的新请求替代旧请求，迟到完成最多提交当前版本一次', async () => {
  const releases = [], f = service(() => new Promise(r => releases.push(r)));
  try {
    const clip = fresh();
    const first = generateCardAudio(clip.id); const aborted = assert.rejects(first, /aborted|已变化/);
    await until(() => releases.length === 1);
    actions.setClipParams(clip.id, { value: .75 });
    const second = generateCardAudio(clip.id, { force: true });
    releases[0](); await aborted;
    await until(() => releases.length === 2); releases[1](); await second;
    const p = getState().project;
    assert.equal(p.media.length, 1); assert.equal(findClip(p, clip.id).clip.cardAudio.identity.params.value, .75);
  } finally { f.restore(); }
});
test('卡片生成串行且最多四项，排队取消不上传不落库', async () => {
  const releases = [], f = service(() => new Promise(r => releases.push(r)));
  try {
    fresh(); const clips = getState().project.tracks.flatMap(t => t.clips);
    for (let i = 1; i < 5; i++) clips.push(actions.addCardClip(def.id, i, { duration: .2 }));
    const first = generateCardAudio(clips[0].id); await until(() => releases.length === 1);
    const queued = clips.slice(1, 4).map(c => generateCardAudio(c.id));
    const rejected = queued.map(p => assert.rejects(p, /aborted/));
    await assert.rejects(() => generateCardAudio(clips[4].id), /最多同时排队/);
    assert.equal(releases.length, 1); assert.equal(getState().project.media.length, 0);
    clips.slice(1, 4).forEach(c => assert.equal(cancelCardAudioGeneration(c.id), true));
    await Promise.all(rejected); releases[0](); await first;
    assert.equal(getState().project.media.length, 1); assert.equal(releases.length, 1);
  } finally { f.restore(); }
});
test('超大参数在生成上传前拒绝，保护共享文档的原子提交', async () => {
  const f = service();
  try {
    const clip = fresh(); actions.setClipParams(clip.id, { manyEvents: 'x'.repeat(100 * 1024) });
    await assert.rejects(() => generateCardAudio(clip.id), /记录过大/);
    assert.equal(f.calls.length, 0); assert.equal(getState().project.media.length, 0);
    assert.equal(cancelCardAudioGeneration(clip.id), false);
  } finally { f.restore(); }
});

test('声画卡的audio-only类型误声明在添加、换卡、新轨添加前均拒绝', () => {
  const clip = fresh(); const p = getState().project;
  registerCards([{ ...def, id: 'invalid-av', kind: 'audio' }]);
  assert.throws(() => actions.addCardClip('invalid-av', 1), /声画卡不能使用 kind:audio/);
  assert.throws(() => actions.addClipOnNewTrack({ cardId: 'invalid-av', start: 1 }), /声画卡不能使用 kind:audio/);
  assert.throws(() => actions.setClipCard(clip.id, 'invalid-av'), /声画卡不能使用 kind:audio/);
  assert.equal(getState().project, p);
});

test('在线AV的上游独立用户音频素材效果卡源码变化，也必须使持久WAV过期', async () => {
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
    assert.throws(() => persistentCardAudio(p, c), /已过期/);
  } finally {
    delete globalThis.__pcOnlinePage; setSyncedUserCards([]);
    configureCardAudio({ getCard: id => id === def.id ? def : undefined, sourceVersionOf: () => sourceVersion });
  }
});
