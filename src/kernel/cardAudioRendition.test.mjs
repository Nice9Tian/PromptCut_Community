import test from 'node:test';
import assert from 'node:assert/strict';
import { isAudiovisualCard, clipHasEmbeddedAudio, clipHasAudio, clipHasCardAudio, clipGoesSilentBySpeed, cardAudioIdentity, resolveCardAudioRendition } from './cardAudioRendition.mjs';
import { projectCardGraph } from './cardGraph.mjs';
import { applyCardDefinition, cloneCardClipInstance } from './cardAuthoring.mjs';
import { audioPlanOf } from './audioPlan.mjs';
import { buildAudioPlan } from '../../server/bakery/mux-audio.mjs';
const def = { id: 'av', defaults: { gain: .5, events: [0, .2] }, Component() {}, audio() {}, kind: 'animation', inputs: {} };
const hooks = { getCard: id => id === 'av' ? def : undefined, sourceVersionOf: () => 'source-v1' };
const hash = 'a'.repeat(64);
function fixture() {
  const clip = { id: 'c', cardId: 'av', embeddedAudio: true, params: {}, start: 2, end: 4 };
  const project = { tracks: [{ id: 't', clips: [clip] }], media: [{ id: 'wav', kind: 'audio', hash, url: `/@media/${hash}` }] };
  clip.cardAudio = { version: 1, mediaId: 'wav', cardId: 'av', sourceKey: 'key', sourceOffset: 0, duration: 2, sampleRate: 48000,
    frames: 96000, channels: 2, identity: cardAudioIdentity(project, clip, hooks) };
  return { project, clip };
}
test('Component+audio and card+audio are AV; audio-only and ordinary media stay distinct', () => {
  assert.equal(isAudiovisualCard(def), true);
  assert.equal(isAudiovisualCard({ card() {}, audio() {} }), true);
  assert.equal(isAudiovisualCard({ audio() {}, kind: 'audio' }), false);
  assert.equal(clipHasEmbeddedAudio({ cardNodes: [] }, { cardId: 'av' }, hooks.getCard), true);
  assert.equal(clipHasEmbeddedAudio({}, { embeddedAudio: true }), true);
  assert.equal(clipHasAudio({ media: [{ id: 'm', kind: 'video' }] }, { mediaId: 'm' }), true);
  assert.equal(clipHasEmbeddedAudio({ cardNodes: [{ id: 'n', adapter: 'card', kind: 'audio' }] }, { nodeId: 'n' }), false);
});
test('fresh AV apply creates one visual clip and a server-readable marker; empty inputs stay empty', () => {
  const p = { duration: 2, media: [], tracks: [{ id: 't', clips: [] }] };
  const r = applyCardDefinition(p, { cardId: 'av', trackId: 't', start: 0, end: 2, nodeId: 'n' }, hooks.getCard);
  const clip = r.project.tracks[0].clips[0];
  assert.equal(clip.cardId, 'av'); assert.equal(clip.embeddedAudio, true); assert.equal(r.project.tracks[0].clips.length, 1);
  assert.deepEqual(r.project.cardNodes[0].inputs, {});
  assert.throws(() => audioPlanOf(r.project), /尚未生成/);
  assert.equal(projectCardGraph(r.project, hooks.getCard).nodes.find(n => n.id === 'n').embeddedAudio, true);
});
test('persistent AV reopens, emits one audio source, and respects independent mute', () => {
  const { project, clip } = fixture();
  const reopened = JSON.parse(JSON.stringify(project));
  assert.equal(resolveCardAudioRendition(reopened, reopened.tracks[0].clips[0]).media.id, 'wav');
  assert.deepEqual(audioPlanOf(project).map(x => [x.clipId, x.mediaId, x.offset]), [['c', 'wav', 0]]);
  assert.equal(buildAudioPlan(project, '', () => true, () => '/wav').length, 1);
  clip.audioMuted = true; assert.deepEqual(audioPlanOf(project), []);
  assert.equal(clip.cardId, 'av'); clip.audioMuted = false;
  project.tracks[0].muted = true; assert.deepEqual(audioPlanOf(project), []);
});
test('WAV range subtracts origin once and stays usable after split, trim and clone', () => {
  const { project, clip } = fixture();
  clip.start = 3; clip.mediaOffset = 1;
  assert.equal(resolveCardAudioRendition(project, clip, hooks).offset, 1);
  clip.cardAudio.sourceOffset = .5; clip.cardAudio.frames = 72000;
  assert.equal(resolveCardAudioRendition(project, clip, hooks).offset, .5);
  clip.end = 4.1; assert.throws(() => resolveCardAudioRendition(project, clip, hooks), /未覆盖/);
});
test('all parameters/events/source code/input changes invalidate; missing bytes metadata never falls back', () => {
  const { project, clip } = fixture();
  assert.throws(() => resolveCardAudioRendition(project, clip, { ...hooks, sourceVersionOf: () => 'v2' }), /已过期/);
  clip.params = { events: [0, .3] }; assert.throws(() => resolveCardAudioRendition(project, clip, hooks), /已过期/);
  clip.params = {}; project.media[0].url = ''; assert.throws(() => audioPlanOf(project), /素材缺失/);
  project.media[0].url = `blob:invalid`; assert.throws(() => audioPlanOf(project), /素材缺失/);
  delete clip.cardAudio; assert.throws(() => buildAudioPlan(project, '', () => true, () => '/wav'), /尚未生成/);
});
test('explicit own-media offsets survive graph normalization and split identity', () => {
  const { project, clip } = fixture();
  project.media.push({ id: 'v', kind: 'video', hash: 'b'.repeat(64), url: '/v' });
  clip.mediaId = 'v'; clip.nodeId = 'n'; clip.mediaOffset = 2;
  project.cardNodes = [{ id: 'n', adapter: 'card', cardId: 'av', embeddedAudio: true, inputs: { source: { nodeId: '@clip/c/source', offset: 1 } } }];
  const identity = cardAudioIdentity(project, clip, hooks);
  const graph = projectCardGraph(project, hooks.getCard), n = graph.nodes.find(n => n.id === 'n');
  assert.equal(n.timeOffset, 2); assert.equal(n.inputs.source.offset, -1);
  const cloned = cloneCardClipInstance(project, 'c', 'right', 'n', .5);
  const right = { ...clip, id: 'right', nodeId: cloned.nodeId, start: 2.5, mediaOffset: 2.5 };
  cloned.project.tracks = [{ id: 't', clips: [clip, right] }];
  assert.deepEqual(cardAudioIdentity(cloned.project, right, hooks), identity);
  const after = projectCardGraph(cloned.project, hooks.getCard).nodes.find(n => n.id === right.nodeId);
  assert.equal(after.timeOffset, 2.5); assert.equal(after.inputs.source.offset, -1.5);
  project.cardNodes[0].inputs.source.offset = 1.5;
  assert.notDeepEqual(cardAudioIdentity(project, clip, hooks), identity);
});

test('声画卡错误声明audio-only类型时apply在写项目之前明确拒绝', () => {
  const p = { duration: 2, media: [], tracks: [{ id: 't', clips: [] }] };
  for (const visual of [{ Component() {} }, { card() {} }]) {
    const bad = { ...def, Component: undefined, ...visual, kind: 'audio' };
    assert.throws(() => applyCardDefinition(p, { cardId: 'av', trackId: 't', start: 0, end: 1 }, () => bad), /声画卡不能使用 kind:audio/);
    assert.deepEqual(p.tracks[0].clips, []); assert.equal(p.cardNodes, undefined);
  }
});

test('剪辑段展开出来的有声卡:按被引用剪辑里的原片段核身份(含按片段 id 找的输入素材),偏移加上裁掉的那一截', () => {
  const vhash = 'b'.repeat(64);
  const src = { id: 'v', cardId: '', mediaId: 'vid', start: 0, end: 6, params: {} };
  const clip = { id: 'c', cardId: 'av', nodeId: 'n', embeddedAudio: true, params: {}, start: 2, end: 4 };
  const child = { tracks: [{ id: 't', clips: [src, clip] }], media: [{ id: 'wav', kind: 'audio', hash, url: `/@media/${hash}` }, { id: 'vid', kind: 'video', hash: vhash, url: `/@media/${vhash}` }],
    cardNodes: [{ id: 'n', cardId: 'av', inputs: { video: '@clip/v/source' } }] };
  clip.cardAudio = { version: 1, mediaId: 'wav', cardId: 'av', sourceKey: 'k', sourceOffset: 0, duration: 2, sampleRate: 48000, frames: 96000, channels: 2,
    identity: cardAudioIdentity(child, clip, hooks) };
  assert.equal(clip.cardAudio.identity.inputs.video.media, vhash);
  // 剪辑1 里一个剪辑段:起点 10、cutOffset 3、长 5 → 子剪辑 3~8 秒;卡片 2~4 秒被裁成 3~4 秒,落在父时间 10~11 秒
  const root = { ...child, tracks: [{ id: 'r', clips: [{ id: 's', cardId: '', cutId: 'B', cutOffset: 3, start: 10, end: 15, params: {} }] }],
    cuts: [{ id: 'A', name: '剪辑1' }, { id: 'B', name: '剪辑2', tracks: child.tracks, duration: 6, transitions: [] }], activeCutId: 'A' };
  const plan = audioPlanOf(root).filter(e => e.mediaId === 'wav');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].start, 10); assert.equal(plan[0].dur, 1);
  assert.equal(plan[0].offset, 1, 'WAV 从第 1 秒起(裁掉的那一截)');
  // 被引用剪辑里改了参数:展开出来的同样判过期,报的是原片段 id
  const stale = structuredClone(root); stale.cuts[1].tracks[0].clips[1].params = { gain: .9 };
  assert.throws(() => audioPlanOf(stale), /^Error: c 的卡片声音已过期|c 的卡片声音已过期/);
});

/*
 * 时间轴角标的判据（2026-10-23 用户放开两件事之后，语义 `product/project-model.md`「声音」）：
 * 变速段不出原声，但声画一体卡挂上去照常出声、变速段也能当音频素材效果卡的输入，
 * 所以「变速」不再等于「没声音」—— 只有原声不出且没有卡片声音挂在它上面才算哑的。
 * 这几条守的就是「别把正在出声的段标成没声音」。
 */
const videoProject = (cardNodes = []) => ({ cardNodes, media: [{ id: 'v', kind: 'video' }] });
const fast = { id: 'c', mediaId: 'v', speed: 2 };

test('变速段挂着声画一体卡：照常出声，不标「无原声」', () => {
  const p = videoProject();
  const clip = { ...fast, cardId: 'av' };
  assert.equal(clipHasCardAudio(p, clip, hooks.getCard), true, '声画一体卡算卡片声音');
  assert.equal(clipGoesSilentBySpeed(p, clip, hooks.getCard), false);
  // 卡的声音已经生成好了（cardAudio 在手）同样算
  assert.equal(clipGoesSilentBySpeed(p, { ...fast, cardAudio: { version: 1 } }), false);
  // 卡自己声明了内嵌声音（节点上或片段上）也算
  assert.equal(clipGoesSilentBySpeed(videoProject([{ id: 'n', embeddedAudio: true }]), { ...fast, nodeId: 'n' }), false);
});

test('变速段挂着音频素材效果卡：卡在出声，不标「无原声」', () => {
  // 节点登记成 adapter:card + kind:audio 的就是音频素材效果卡
  const p = videoProject([{ id: 'n', adapter: 'card', kind: 'audio' }]);
  const clip = { ...fast, nodeId: 'n' };
  assert.equal(clipHasCardAudio(p, clip), true);
  assert.equal(clipGoesSilentBySpeed(p, clip), false);
  // 只认得卡片定义（def.audio 是函数）时同样算：纯音频卡不是声画卡，但它出声
  const audioOnly = { id: 'sfx', audio() {}, kind: 'audio' };
  assert.equal(isAudiovisualCard(audioOnly), false, '前提：它不是声画一体卡');
  assert.equal(clipGoesSilentBySpeed(videoProject(), { ...fast, cardId: 'sfx' }, id => id === 'sfx' ? audioOnly : undefined), false);
});

test('变速段什么卡都没挂：真的一点声音都不出，标', () => {
  const p = videoProject();
  assert.equal(clipHasCardAudio(p, fast), false);
  assert.equal(clipGoesSilentBySpeed(p, fast), true);
  // 挂了一张不出声的卡（没有 audio()）照样是哑的
  assert.equal(clipGoesSilentBySpeed(p, { ...fast, cardId: 'plain' }, () => ({ id: 'plain', Component() {} })), true);
});

test('不变速的段行为不变：从来不标，挂不挂卡都一样', () => {
  const p = videoProject();
  for (const speed of [undefined, 1]) {
    assert.equal(clipGoesSilentBySpeed(p, { id: 'c', mediaId: 'v', speed }), false, `speed=${speed}`);
    assert.equal(clipGoesSilentBySpeed(p, { id: 'c', mediaId: 'v', speed, cardId: 'av' }, hooks.getCard), false);
  }
  // 变速的**声音**素材段本来就不在这条规矩里（speedMutesSource 只管有画面的素材）
  assert.equal(clipGoesSilentBySpeed({ cardNodes: [], media: [{ id: 'a', kind: 'audio' }] }, { id: 'c', mediaId: 'a', speed: 2 }), false);
  // 没有素材的段（纯卡片段）也不标
  assert.equal(clipGoesSilentBySpeed(p, { id: 'c', speed: 2 }), false);
});
