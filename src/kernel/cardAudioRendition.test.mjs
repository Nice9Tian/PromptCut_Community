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
  assert.throws(() => audioPlanOf(r.project), /not generated yet/);
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
  clip.end = 4.1; assert.throws(() => resolveCardAudioRendition(project, clip, hooks), /does not cover/);
});
test('all parameters/events/source code/input changes invalidate; missing bytes metadata never falls back', () => {
  const { project, clip } = fixture();
  assert.throws(() => resolveCardAudioRendition(project, clip, { ...hooks, sourceVersionOf: () => 'v2' }), /out of date/);
  clip.params = { events: [0, .3] }; assert.throws(() => resolveCardAudioRendition(project, clip, hooks), /out of date/);
  clip.params = {}; project.media[0].url = ''; assert.throws(() => audioPlanOf(project), /media is missing/);
  project.media[0].url = `blob:invalid`; assert.throws(() => audioPlanOf(project), /media is missing/);
  delete clip.cardAudio; assert.throws(() => buildAudioPlan(project, '', () => true, () => '/wav'), /not generated yet/);
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

test('When an audio-visual card wrongly declares the audio-only type, apply rejects explicitly before writing to the project', () => {
  const p = { duration: 2, media: [], tracks: [{ id: 't', clips: [] }] };
  for (const visual of [{ Component() {} }, { card() {} }]) {
    const bad = { ...def, Component: undefined, ...visual, kind: 'audio' };
    assert.throws(() => applyCardDefinition(p, { cardId: 'av', trackId: 't', start: 0, end: 1 }, () => bad), /Audio-visual cards cannot use kind:audio/);
    assert.deepEqual(p.tracks[0].clips, []); assert.equal(p.cardNodes, undefined);
  }
});

test('Cards with audio expanded from a cut segment: verify identity against the original clip in the referenced cut (including input media found by clip id), with the offset plus the trimmed-off portion', () => {
  const vhash = 'b'.repeat(64);
  const src = { id: 'v', cardId: '', mediaId: 'vid', start: 0, end: 6, params: {} };
  const clip = { id: 'c', cardId: 'av', nodeId: 'n', embeddedAudio: true, params: {}, start: 2, end: 4 };
  const child = { tracks: [{ id: 't', clips: [src, clip] }], media: [{ id: 'wav', kind: 'audio', hash, url: `/@media/${hash}` }, { id: 'vid', kind: 'video', hash: vhash, url: `/@media/${vhash}` }],
    cardNodes: [{ id: 'n', cardId: 'av', inputs: { video: '@clip/v/source' } }] };
  clip.cardAudio = { version: 1, mediaId: 'wav', cardId: 'av', sourceKey: 'k', sourceOffset: 0, duration: 2, sampleRate: 48000, frames: 96000, channels: 2,
    identity: cardAudioIdentity(child, clip, hooks) };
  assert.equal(clip.cardAudio.identity.inputs.video.media, vhash);
  // A cut segment in Cut 1: start 10, cutOffset 3, length 5 → child cut 3~8s; card 2~4s trimmed to
  // 3~4s, landing at parent time 10~11s
  const root = { ...child, tracks: [{ id: 'r', clips: [{ id: 's', cardId: '', cutId: 'B', cutOffset: 3, start: 10, end: 15, params: {} }] }],
    cuts: [{ id: 'A', name: 'Cut 1' }, { id: 'B', name: 'Cut 2', tracks: child.tracks, duration: 6, transitions: [] }], activeCutId: 'A' };
  const plan = audioPlanOf(root).filter(e => e.mediaId === 'wav');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].start, 10); assert.equal(plan[0].dur, 1);
  assert.equal(plan[0].offset, 1, 'WAV starts at second 1 (the trimmed-off portion)');
  // Parameters changed in referenced cut: expanded ones are also invalidated, reporting the
  // original clip id
  const stale = structuredClone(root); stale.cuts[1].tracks[0].clips[1].params = { gain: .9 };
  assert.throws(() => audioPlanOf(stale), /Card audio for c: out of date/);
});

/*
 * Criteria for timeline badges (after user unlocked two things on 2026-10-23, semantics
 * `product/project-model.md` "Sound"):
 * Speed-changed clips produce no original audio, but attached audio-visual cards produce sound as
 * usual, and speed-changed clips can also serve as input to audio media effect cards,
 * so "speed change" no longer equals "no sound": only when original audio is absent and no card
 * audio is attached to it is it considered muted.
 * These rules guard against "marking a segment that is producing sound as having no sound".
 */
const videoProject = (cardNodes = []) => ({ cardNodes, media: [{ id: 'v', kind: 'video' }] });
const fast = { id: 'c', mediaId: 'v', speed: 2 };

test('A speed-changed clip with an integrated audio-visual card attached: sounds as usual, not marked "no original audio"', () => {
  const p = videoProject();
  const clip = { ...fast, cardId: 'av' };
  assert.equal(clipHasCardAudio(p, clip, hooks.getCard), true, 'An integrated audio-visual card counts as card audio');
  assert.equal(clipGoesSilentBySpeed(p, clip, hooks.getCard), false);
  // Also counts if card audio has already been generated (cardAudio in hand)
  assert.equal(clipGoesSilentBySpeed(p, { ...fast, cardAudio: { version: 1 } }), false);
  // Also counts if card itself declared embedded audio (on node or on clip)
  assert.equal(clipGoesSilentBySpeed(videoProject([{ id: 'n', embeddedAudio: true }]), { ...fast, nodeId: 'n' }), false);
});

test('A speed-changed clip with an audio media effect card attached: the card is producing sound, not marked "no original audio"', () => {
  // Nodes registered as adapter:card + kind:audio are audio media effect cards
  const p = videoProject([{ id: 'n', adapter: 'card', kind: 'audio' }]);
  const clip = { ...fast, nodeId: 'n' };
  assert.equal(clipHasCardAudio(p, clip), true);
  assert.equal(clipGoesSilentBySpeed(p, clip), false);
  // Also counts when only card definition is recognized (def.audio is a function): a pure audio card
  // is not an audio-visual card, but it produces sound
  const audioOnly = { id: 'sfx', audio() {}, kind: 'audio' };
  assert.equal(isAudiovisualCard(audioOnly), false, 'Precondition: it is not an integrated audio-visual card');
  assert.equal(clipGoesSilentBySpeed(videoProject(), { ...fast, cardId: 'sfx' }, id => id === 'sfx' ? audioOnly : undefined), false);
});

test('A speed-changed clip with no card attached: truly makes no sound at all, so it is marked', () => {
  const p = videoProject();
  assert.equal(clipHasCardAudio(p, fast), false);
  assert.equal(clipGoesSilentBySpeed(p, fast), true);
  // Attaching a card that produces no sound (no audio()) remains muted
  assert.equal(clipGoesSilentBySpeed(p, { ...fast, cardId: 'plain' }, () => ({ id: 'plain', Component() {} })), true);
});

test('Clips without speed change behave as before: never marked, whether or not a card is attached', () => {
  const p = videoProject();
  for (const speed of [undefined, 1]) {
    assert.equal(clipGoesSilentBySpeed(p, { id: 'c', mediaId: 'v', speed }), false, `speed=${speed}`);
    assert.equal(clipGoesSilentBySpeed(p, { id: 'c', mediaId: 'v', speed, cardId: 'av' }, hooks.getCard), false);
  }
  // Speed-changed **audio** media clips were never under this rule (speedMutesSource only handles
  // media with video)
  assert.equal(clipGoesSilentBySpeed({ cardNodes: [], media: [{ id: 'a', kind: 'audio' }] }, { id: 'c', mediaId: 'a', speed: 2 }), false);
  // Clips without media (pure card clips) are not marked either
  assert.equal(clipGoesSilentBySpeed(p, { id: 'c', speed: 2 }), false);
});
