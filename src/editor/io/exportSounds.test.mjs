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
const def = { id: 'av-export', name: '声画导出卡', source: 'native', defaults: { value: .25 }, controls: [], frameMode: 'direct', kind: 'animation', inputs: {}, Component() {},
  audio(_sources, range, p) { evaluations++; if (failAudio === p.value) throw new Error('合成器炸了'); return new Float32Array(range.count * 2).fill(p.value); } };
const silentDef = { id: 'plain-export', name: '无声卡', source: 'native', defaults: {}, controls: [], frameMode: 'direct', kind: 'animation', Component() {} };
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
  actions.newProject('导出时自动生成声音');
  const a = actions.addCardClip(def.id, 0, { duration: .2, params: { value: .25 } });
  const b = actions.addCardClip(def.id, 1, { duration: .2, params: { value: .5 } });
  const plain = actions.addCardClip(silentDef.id, 2, { duration: .5 });
  const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 3 }).id);
  assert.equal(job.state, 'succeeded');
  return { a, b, plain, effectId: job.result.clipId };
}

test('A1 不含声音的项目:清单为空,不问素材服务、不改项目(导出照原样往下走)', async () => {
  const f = service();
  try {
    actions.newProject('无声'); actions.addCardClip(silentDef.id, 0, { duration: 1 });
    const before = getState().project;
    assert.deepEqual(await listExportSoundNeeds(signal()), []);
    const progress = [];
    assert.deepEqual(await prepareExportSounds({ signal: signal(), onProgress: (d, t) => progress.push([d, t]) }), { total: 0, generated: [] });
    assert.deepEqual(progress, [], '没有要生成的声音:不出现生成阶段');
    assert.equal(f.calls.length, 0); assert.equal(getState().project, before);
  } finally { f.restore(); }
});

test('A2 清单认得出未生成、过期、缺失三种,带片段名;静音的片段和序列不算', async () => {
  const f = service();
  try {
    const { a, b, effectId } = await project();
    await generateCardAudio(b.id);
    actions.setClipParams(b.id, { value: .75 });
    f.stored.clear();
    const needs = await listExportSoundNeeds(signal());
    const by = Object.fromEntries(needs.map(n => [n.clipId, n]));
    assert.equal(needs.length, 3);
    assert.equal(by[a.id].kind, 'card'); assert.equal(by[a.id].reason, 'ungenerated'); assert.match(by[a.id].detail, /尚未生成/);
    assert.equal(by[b.id].reason, 'stale'); assert.match(by[b.id].detail, /已过期/);
    assert.equal(by[effectId].kind, 'effect'); assert.equal(by[effectId].reason, 'missing'); assert.match(by[effectId].detail, /素材服务里没有/);
    assert.ok(needs.every(n => typeof n.label === 'string' && n.label.length > 0));
    actions.setClipMuted(a.id, true);
    assert.equal((await listExportSoundNeeds(signal())).some(n => n.clipId === a.id), false, '静音的片段不出声,不用生成');
  } finally { f.restore(); }
});

test('A3 项目里素材记录还在、素材服务里没有字节,也算缺失(只问一次同一个哈希)', async () => {
  const f = service();
  try {
    const { a, b, effectId } = await project();
    await generateCardAudio(a.id); await generateCardAudio(b.id);
    assert.deepEqual(await listExportSoundNeeds(signal()), [], '都生成好了:不用再生成');
    const hash = getState().project.media.find(m => m.id === findClip(getState().project, a.id).clip.cardAudio.mediaId).hash;
    f.stored.delete(hash);
    const needs = await listExportSoundNeeds(signal());
    assert.deepEqual(needs.map(n => [n.clipId, n.kind, n.reason]), [[a.id, 'card', 'missing']]);
    assert.ok(effectId);
  } finally { f.restore(); }
});

test('A4 导出开始时把清单里的声音都生成好:之后混音计划不再报缺,进度按段数走完', async () => {
  const f = service();
  try {
    const { a, b, effectId } = await project();
    await generateCardAudio(b.id); actions.setClipParams(b.id, { value: .75 });
    f.stored.clear();
    assert.throws(() => assertProjectCardAudio(getState().project), /尚未生成|已过期/, '改动前:这样的项目导出直接失败');
    const progress = [];
    const result = await prepareExportSounds({ signal: signal(), onProgress: (done, total) => progress.push([done, total]) });
    assert.equal(result.total, 3); assert.deepEqual(result.generated.sort(), [a.id, b.id, effectId].sort());
    assert.deepEqual(progress[0], [0, 3]); assert.deepEqual(progress.at(-1), [3, 3]);
    assert.ok(progress.every(([done, total], i) => total === 3 && (i === 0 || done >= progress[i - 1][0])), '进度单调');
    assert.ok(progress.some(([done]) => done > 0 && done < 1), '一段之内也报进度');
    const p = getState().project;
    assertProjectCardAudio(p);
    const plan = audioPlanOf(p);
    assert.equal(plan.length, 3, '三段声音都进混音计划');
    for (const entry of plan) { const m = p.media.find(x => x.id === entry.mediaId); assert.ok(f.stored.has(m.hash), `${m.name} 的字节在素材服务里`); }
    assert.equal(findClip(p, b.id).clip.cardAudio.identity.params.value, .75, '过期的那段按当前参数重新生成');
    assert.deepEqual(await listExportSoundNeeds(signal()), []);
  } finally { f.restore(); }
});

test('A5 缺字节的独立音效按原配方补回同一份声音:项目不动、不新建片段和素材', async () => {
  const f = service();
  try {
    actions.newProject('补音效');
    const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 0 }).id);
    const before = getState().project, hash = before.media[0].hash;
    f.stored.clear();
    const result = await prepareExportSounds({ signal: signal() });
    assert.deepEqual(result.generated, [job.result.clipId]);
    assert.equal(getState().project, before, '同一份声音:只把字节补回素材服务');
    assert.ok(f.stored.has(hash));
  } finally { f.restore(); }
});

test('A6 音效的素材记录被删了:补回记录、片段指过去,不进撤销栈、不改选区', async () => {
  const f = service();
  try {
    actions.newProject('补素材记录');
    const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 0 }).id);
    const clipId = job.result.clipId, hash = getState().project.media[0].hash;
    actions.loadProject({ ...structuredClone(getState().project), media: [] });
    actions.select([]);
    const selection = getState().selection;
    assert.throws(() => audioPlanOf(getState().project), /缺失/);
    await prepareExportSounds({ signal: signal() });
    const p = getState().project, clip = findClip(p, clipId).clip;
    assert.equal(p.media.length, 1); assert.equal(p.media[0].hash, hash); assert.equal(clip.mediaId, p.media[0].id);
    assert.equal(clips().length, 1);
    assert.deepEqual(getState().selection, selection);
    assert.equal(audioPlanOf(p).length, 1);
    actions.undo();
    assert.equal(getState().project.media.length, 1, '补回素材记录不是一步用户操作');
  } finally { f.restore(); }
});

test('A7 生成中取消:导出与生成都停,正在做的那一段不提交、不留半截;之前做完的那段是完整的', async () => {
  let release;
  const f = service({ holdComplete: () => new Promise(r => { release = r; }) });
  try {
    sourceVersion = 'v1'; failAudio = null;
    actions.newProject('取消');
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
    assert.equal(error.cancelled, true); assert.match(error.message, /已取消/);
    const p = getState().project;
    assert.ok(findClip(p, a.id).clip.cardAudio, '取消之前做完的那一段是完整的声音');
    assert.equal(findClip(p, b.id).clip.cardAudio, undefined, '正在做的那一段没提交');
    assert.equal(p.media.length, 1, '没有半截的素材记录');
    for (const m of p.media) assert.ok(f.stored.has(m.hash));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(evaluations, evaluated, '取消后不再合成');
    assert.equal(getState().project, p, '迟到的入库回包不改项目');
    assert.ok(progress.every(([done]) => done < 2), '进度没有走到第二段完成');
  } finally { f.restore(); }
});

test('A8 还没开始就取消:什么都不做', async () => {
  const f = service();
  try {
    actions.newProject('先取消'); actions.addCardClip(def.id, 0, { duration: .2 });
    const before = getState().project, abort = new AbortController();
    abort.abort();
    await assert.rejects(() => prepareExportSounds({ signal: abort.signal }), (e) => e.cancelled === true);
    assert.equal(getState().project, before); assert.equal(f.stored.size, 0);
  } finally { f.restore(); }
});

test('A9 某一段生成不出来:导出失败并指出是哪个片段;它之后的不再做,它之前做完的留着', async () => {
  const f = service();
  try {
    sourceVersion = 'v1';
    actions.newProject('失败');
    const a = actions.addCardClip(def.id, 0, { duration: .2, params: { value: .25 } });
    const bad = actions.addCardClip(def.id, 1, { duration: .2, params: { value: .5 } });
    const c = actions.addCardClip(def.id, 2, { duration: .2, params: { value: .6 } });
    failAudio = .5;
    const error = await prepareExportSounds({ signal: signal() }).then(() => null, (e) => e);
    assert.ok(error instanceof ExportSoundError);
    assert.equal(error.code, 'export-sound-failed'); assert.equal(error.clipId, bad.id); assert.equal(error.cancelled, undefined);
    assert.match(error.message, new RegExp(`片段「.+」\\(${bad.id}\\)的声音生成不出来`)); assert.match(error.message, /合成器炸了/);
    const p = getState().project;
    assert.ok(findClip(p, a.id).clip.cardAudio); assert.equal(findClip(p, bad.id).clip.cardAudio, undefined); assert.equal(findClip(p, c.id).clip.cardAudio, undefined);
    assert.equal(p.media.length, 1);
  } finally { failAudio = null; f.restore(); }
});

test('A10 音效合成失败同样指出片段;锁住的序列上的有声卡生成不了也说明原因', async () => {
  const f = service();
  try {
    actions.newProject('音效失败');
    const job = await waitSoundGeneration(startSoundGeneration({ preset: 'notification', start: 0 }).id);
    f.stored.clear();
    setSoundEffectRenderer(async () => { throw new Error('合成进程启动失败'); });
    const error = await prepareExportSounds({ signal: signal() }).then(() => null, (e) => e);
    assert.ok(error instanceof ExportSoundError); assert.equal(error.clipId, job.result.clipId); assert.match(error.message, /合成进程启动失败/);
    setSoundEffectRenderer(null);
    actions.newProject('锁住');
    const clip = actions.addCardClip(def.id, 0, { duration: .2 });
    actions.updateTrack(getState().project.tracks.find(t => t.clips.some(c => c.id === clip.id)).id, { locked: true });
    const locked = await prepareExportSounds({ signal: signal() }).then(() => null, (e) => e);
    assert.ok(locked instanceof ExportSoundError); assert.equal(locked.clipId, clip.id); assert.match(locked.message, /解锁/);
  } finally { setSoundEffectRenderer(null); f.restore(); }
});

test('A11 在线页面:判轻的在浏览器里生成;判重、又没有产物的不合成,导出失败并指出片段', async () => {
  const f = service();
  const store = createMemorySoundCostStore();
  const restore = configureOnlineSoundJudge({ online: () => true, store: () => store, device: () => 'test-device' });
  try {
    sourceVersion = 'v1'; failAudio = null;
    actions.newProject('在线导出');
    const light = actions.addCardClip(def.id, 0, { duration: .2, params: { value: .25 } });
    await prepareExportSounds({ signal: signal() });
    assert.ok(findClip(getState().project, light.id).clip.cardAudio, '判轻:在线页面自己生成');
    const heavy = actions.addCardClip(def.id, 1, { duration: .2, params: { value: .5 } });
    const p = getState().project, key = soundTargetOf(p, findClip(p, heavy.id).clip).soundKey;
    await store.putCost(soundCostStoreKey(key, 'test-device'), { soundKey: key, kind: 'card', device: 'test-device', blockMs: 300, blockMaxMs: 300, blockFrames: 4096, sampleRate: 48000, samples: 16, measuredAt: 1 });
    const before = evaluations, handed = [];
    const error = await prepareExportSounds({ signal: signal(), deps: { backfill: async (request) => { handed.push([request.clip.id, request.reason]); return false; } } }).then(() => null, (e) => e);
    assert.ok(error instanceof ExportSoundError); assert.equal(error.clipId, heavy.id); assert.match(error.message, /判重/);
    assert.equal(evaluations, before, '判重:一块都不在浏览器里合成');
    assert.deepEqual(handed, [[heavy.id, 'heavy']], '没有产物:交给渲染节点的接口被调到');
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
  actions.newProject('剪辑段里的有声卡');
  const child = actions.addCut('剪辑2', { switchTo: true });
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

test('C1 剪辑段:清单走进被引用剪辑,窗口外和重复引用的不重复列;生成写回停放的剪辑;混音按段音量出声', async () => {
  const f = service();
  try {
    const { child, inner, outside, seg } = await nestedProject();
    assert.throws(() => assertProjectCardAudio(getState().project), new RegExp(`${inner.id} 的卡片声音尚未生成`), '改动前:导出直接失败并点名原片段');
    const needs = await listExportSoundNeeds(signal());
    assert.deepEqual(needs.map(n => [n.clipId, n.cutId, n.kind, n.reason]), [[inner.id, child.id, 'card', 'ungenerated']]);
    assert.match(needs[0].label, /剪辑「剪辑2」里的/);
    assert.ok(!needs.some(n => n.clipId === outside.id), '落在剪辑段窗口外的不出声,不用生成');
    const activeBefore = getState().project.tracks;
    const result = await prepareExportSounds({ signal: signal() });
    assert.deepEqual(result.generated, [inner.id]);
    const p = getState().project;
    assert.ok(parked(child.id, inner.id).cardAudio, '声音记在被引用剪辑里的原片段上');
    assert.equal(parked(child.id, outside.id).cardAudio, undefined);
    assert.equal(p.tracks, activeBefore, '激活剪辑的序列不动');
    assertProjectCardAudio(p);
    const plan = audioPlanOf(p);
    assert.equal(plan.length, 2, '两个剪辑段各出一份(同一份 WAV):1.5 秒与 4.5 秒');
    assert.deepEqual(plan.map(e => e.start).sort(), [1.5, 4.5]);
    assert.equal(new Set(plan.map(e => e.mediaId)).size, 1);
    const first = plan.find(e => e.clipId.startsWith(`${seg.id}/`));
    assert.ok(first, '第一个剪辑段的那份进了混音');
    assert.equal(first.start, 1.5); assert.equal(first.volume, .5, '音量乘上剪辑段的音量');
    assert.ok(f.stored.has(p.media.find(m => m.id === first.mediaId).hash));
    assert.deepEqual(await listExportSoundNeeds(signal()), []);
  } finally { f.restore(); }
});

test('C2 剪辑段静音:里面的有声卡不出声,不用生成;取消静音后要生成', async () => {
  const f = service();
  try {
    const { inner, seg } = await nestedProject({ muted: true });
    const needs = await listExportSoundNeeds(signal());
    assert.ok(!needs.some(n => n.clipId === inner.id), '两个剪辑段都静音:里面的不列');
    actions.setClipMuted(seg.id, false);
    assert.deepEqual((await listExportSoundNeeds(signal())).map(n => n.clipId), [inner.id]);
  } finally { f.restore(); }
});

test('C3 被引用剪辑里的片段已经生成过、又改了参数:判过期,导出前按新参数重生成', async () => {
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
