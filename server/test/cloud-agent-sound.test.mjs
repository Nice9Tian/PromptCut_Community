/**
 * Sound effect synthesis for Cloud Agent (`server/agent/service/hosted-sound.mjs`; contract
 * `docs/plan/cloud-agent-contract.md` section 9.4a).
 * Run: node scripts/test-suite.mjs server/test/cloud-agent-sound.test.mjs
 *
 *   CA-SND-01  Notification and keyboard sounds: WAV synthesized in cloud is **sample-identical**
 *              to the synthesis from the same recipe at desktop app entry point
 *              (`renderSoundEffectWavInWorker`), with content hash matching pinned value;
 *              project gains assets (with recipe and content hash) and clips (with recipe,
 *              requestId, drop target); when sourceClipId is provided for keyboard sound,
 *              reuses typing card text and rhythm, landing at the same start point
 *   CA-SND-02  Idempotency, cancellation, expiration, read-only, limit: retrying same requestId
 *              does not re-synthesize or create extra clips; changing recipe for same requestId
 *              is rejected; read-only members rejected before synthesis (no synthesis, no upload);
 *              after cancellation, no upload or commit; if clip is modified during synthesis,
 *              old results are not applied; rejects when queue full; returns failure reason
 *   CA-SND-03  Job table per instance: another instance (other project or other member) cannot
 *              see or cancel jobs here; job id is not sequential
 *   CA-SND-04  Process-level synthesis quota: two instances synthesizing simultaneously do not
 *              overlap; cancellation while queued does not take quota
 *
 * No egress; asset service and document service are stubs (the real chain is verified by
 * `scripts/probes/cloud-agent-sound-probe.mjs` against the hosted suite).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createVite } from 'vite';
import { createSlot, createSoundTools, newSoundState } from '../agent/service/hosted-sound.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { ROOT } from './cloud-agent-kit.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
class ToolError extends Error {}

const typingClip = { id: 'typing', cardId: 'mu-typing', start: 2, end: 6, params: { text: '你好,PromptCut!\nok', duration: 90, delayMs: 100, seed: 7 }, label: 'Typing' };
const baseProject = (id = 'p-snd') => ({
  version: 1, id, name: 'Sound effect', width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight', media: [],
  tracks: [{ id: 't1', name: 'Track 1', clips: [structuredClone(typingClip)] }], transitions: [],
});

async function setup(t) {
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => vite.close());
  const host = await loadSsrHost((id) => vite.ssrLoadModule(id));
  const desktop = await vite.ssrLoadModule('/src/audio/soundGenerationWorkerClient.ts');
  const slot = createSlot();
  /** Stub for an instance: project replica, asset service, document service commit */
  function instance(projectId, { readOnly = false, putDelayMs = 0, renderHook = null } = {}) {
    const st = { project: baseProject(projectId), puts: [], commits: 0, usage: [], state: newSoundState(), beforeCommit: null };
    const h = renderHook ? { ...host, sound: { ...host.sound, renderWav: (recipe, o) => renderHook(recipe, o, host.sound.renderWav) } } : host;
    st.tools = createSoundTools({
      state: st.state, slot, host: async () => h,
      snapshot: async () => ({ project: st.project }),
      mutate: async (_track, apply) => {
        st.beforeCommit?.();
        host.resetStore();
        host.setProject(st.project);
        try { await apply(host); st.project = host.getProject(); st.commits += 1; } finally { host.clearProject(); }
      },
      ensureCanWrite: async () => { if (readOnly) throw new ToolError('You only have read-only permission in this project, so the Cloud Agent cannot write media to the project for you.'); },
      put: async (wav) => {
        if (putDelayMs) await new Promise((r) => setTimeout(r, putDelayMs));
        const copy = Buffer.from(wav);
        st.puts.push(copy);
        return { hash: sha256(copy), size: copy.length };
      },
      record: (row) => st.usage.push(row),
      ToolError,
    });
    return st;
  }
  return { host, desktop, instance };
}

const clipsOf = (p) => p.tracks.flatMap((tr) => tr.clips);

test('CA-SND-01 WAV synthesized in the cloud is sample-for-sample identical to the desktop app\'s with the same recipe; media, recipe and clip are registered atomically', { timeout: 120_000 }, async (t) => {
  const { host, desktop, instance } = await setup(t);
  const a = instance('p-snd');

  // Notification sound: placed at 1 second
  const chime = await a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'chime-1', name: '叮', params: { frequency: 660, notes: [0, 4, 7] }, seed: 3 });
  assert.equal(chime.ok, true, JSON.stringify(chime));
  assert.equal(chime.state, 'succeeded');
  assert.match(chime.jobId, /^sound-[a-f0-9]{12}$/);
  const media1 = a.project.media.find((m) => m.id === chime.result.mediaId);
  const clip1 = clipsOf(a.project).find((c) => c.id === chime.result.clipId);
  assert.ok(media1 && clip1);
  assert.equal(media1.kind, 'audio');
  assert.equal(media1.name, '叮.wav');
  assert.equal(media1.ext, 'wav');
  assert.equal(media1.hash, sha256(a.puts[0]), 'The content hash in the media entry is the hash of the exact bytes written to the asset service');
  assert.equal(media1.url, `/@media/${media1.hash}`);
  assert.equal(media1.size, a.puts[0].length);
  assert.equal(clip1.start, 1);
  assert.equal(clip1.mediaId, media1.id);
  assert.equal(clip1.soundEffect.requestId, 'chime-1');
  assert.deepEqual(clip1.soundEffect.recipe, media1.soundEffect.recipe);
  assert.match(clip1.soundEffect.reuseKey, /^sound-effect-sha256:[a-f0-9]{64}$/);
  assert.equal(media1.duration, media1.soundEffect.recipe.frames / media1.soundEffect.recipe.sampleRate);

  // Same recipe as the desktop app entry point: sample-identical (desktop app runs the same function
  // in a Worker; here is the same path in an environment without Worker)
  const desk1 = Buffer.from(await desktop.renderSoundEffectWavInWorker(structuredClone(media1.soundEffect.recipe)));
  assert.equal(desk1.length, a.puts[0].length);
  assert.ok(desk1.equals(a.puts[0]), 'Notification sound: cloud and desktop app are byte-for-byte identical');
  // The recipe itself is also identical to the one computed from the same parameters in desktop app
  const planned = host.sound.plan(baseProject('p-snd'), { preset: 'notification', start: 1, requestId: 'x', params: { frequency: 660, notes: [0, 4, 7] }, seed: 3 });
  assert.deepEqual(planned.recipe, media1.soundEffect.recipe);
  assert.equal(a.puts[0].toString('latin1', 0, 4), 'RIFF');
  assert.equal(a.puts[0].readUInt16LE(20), 1, 'PCM');
  assert.equal(a.puts[0].readUInt16LE(34), 16, '16-bit');
  let nonzero = 0;
  for (let i = 44; i < a.puts[0].length; i += 2) if (a.puts[0].readInt16LE(i) !== 0) nonzero += 1;
  assert.ok(nonzero > 1000, 'Not silence');

  // Keyboard sound: reuses typing card text and rhythm, landing at its start point
  const keys = await a.tools.sound_generate({ preset: 'keyboard', sourceClipId: 'typing', requestId: 'keys-1' });
  assert.equal(keys.ok, true, JSON.stringify(keys));
  const media2 = a.project.media.find((m) => m.id === keys.result.mediaId);
  const clip2 = clipsOf(a.project).find((c) => c.id === keys.result.clipId);
  assert.equal(clip2.start, typingClip.start, 'Lands at the start of the typing card');
  assert.ok(clip2.end <= typingClip.end + 1e-9);
  assert.equal(clip2.soundEffect.sourceClipId, 'typing');
  assert.equal(media2.soundEffect.recipe.preset, 'keyboard');
  assert.ok(media2.soundEffect.recipe.events.length >= 10, 'One event per character');
  const desk2 = Buffer.from(await desktop.renderSoundEffectWavInWorker(structuredClone(media2.soundEffect.recipe)));
  assert.ok(desk2.equals(a.puts[1]), 'Keyboard sound: cloud and desktop app are byte-for-byte identical');

  // Pinned content hash: turns red first if Node or synthesis kernel changes and no longer matches
  // old stored assets
  const pinned = { chime: sha256(a.puts[0]), keys: sha256(a.puts[1]) };
  console.log('CA-SND-01', JSON.stringify({ ...pinned, chimeBytes: a.puts[0].length, keysBytes: a.puts[1].length }));
  assert.deepEqual(pinned, PINNED);

  // Only enters media library (start not passed): has asset, no clip
  const lib = await a.tools.sound_generate({ preset: 'notification', requestId: 'lib-1' });
  assert.equal(lib.ok, true);
  assert.equal(lib.result.clipId, undefined);
  assert.ok(a.project.media.some((m) => m.id === lib.result.mediaId));

  // Usage: one row per synthesis, in bytes
  assert.deepEqual(a.usage.map((u) => [u.service, u.vendor, u.model, u.unit, u.ok]), [
    ['sound', 'builtin', 'notification', 'bytes', true], ['sound', 'builtin', 'keyboard', 'bytes', true], ['sound', 'builtin', 'notification', 'bytes', true],
  ]);
  assert.equal(a.usage[0].units, a.puts[0].length);
});

/**
 * CA-SND-01 Pinned content hash (the same recipe synthesized in the desktop app browser matches
 * this too: S4 of `cloud-agent-sound-probe` compares against a real browser)
 */
const PINNED = { chime: '9af90898ad856b9a7a04f92d1e7dcdd01630af09b6b1e2d9bb1736de02321772', keys: '649e4ac2176e651b3dce41d41a2b57732ea96c58a0877154a698b4701db4d078' };

test('CA-SND-02 idempotency, cancel, stale, read-only, limit', { timeout: 120_000 }, async (t) => {
  const { instance, host } = await setup(t);

  await t.test('Retry with the same requestId: no re-synthesis, no extra clip; changing the recipe is rejected', async () => {
    const a = instance('p-idem');
    const first = await a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'r1' });
    const again = await a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'r1' });
    assert.equal(again.jobId, first.jobId);
    assert.deepEqual(again.result, first.result);
    assert.equal(a.puts.length, 1);
    assert.equal(clipsOf(a.project).filter((c) => c.soundEffect).length, 1);
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'r1', params: { frequency: 990 } }), /requestId was already used for a different recipe/);
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', start: 1 }), /requestId/);
    await assert.rejects(a.tools.sound_generate({ preset: 'keyboard', requestId: 'k0' }), /Keyboard sound requires/);
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', start: 99, requestId: 'far' }), /start must be within the project time range/);
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', requestId: 'big', params: { duration: 1e9 } }), ToolError);
  });

  await t.test('Read-only member: rejected before synthesis; no synthesis, no upload, project unchanged', async () => {
    let rendered = 0;
    const ro = instance('p-ro', { readOnly: true, renderHook: (r, o, real) => { rendered += 1; return real(r, o); } });
    const before = JSON.stringify(ro.project);
    await assert.rejects(ro.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'ro-1' }), /read-only/);
    assert.equal(rendered, 0);
    assert.equal(ro.puts.length, 0);
    assert.equal(JSON.stringify(ro.project), before);
    assert.deepEqual((await ro.tools.sound_status({})).jobs, []);
  });

  await t.test('Cancel: cancelled during synthesis, no upload, no commit; the old sound effect is untouched', async () => {
    let started;
    const waitStart = new Promise((r) => { started = r; });
    const a = instance('p-cancel', { renderHook: async (recipe, o, real) => { started(); await new Promise((r) => setTimeout(r, 150)); return real(recipe, o); } });
    const pending = a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'c1' });
    await waitStart;
    const { jobs } = await a.tools.sound_status({});
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, 'rendering');
    const cancelled = await a.tools.sound_cancel({ jobId: jobs[0].jobId });
    assert.equal(cancelled.state, 'cancelled');
    const out = await pending;
    assert.deepEqual([out.ok, out.state, out.error], [false, 'cancelled', 'Cancelled; the original sound effect is unchanged']);
    assert.equal(a.puts.length, 0);
    assert.equal(a.commits, 0);
    assert.equal(a.project.media.length, 0);
    // A canceled requestId can be retried
    const redo = await a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'c1' });
    assert.equal(redo.ok, true);
    await assert.rejects(a.tools.sound_cancel({ jobId: 'sound-nope' }), /Sound effect job not found/);
    await assert.rejects(a.tools.sound_status({ jobId: 'sound-nope' }), /Sound effect job not found/);
  });

  await t.test('Stale: the source clip was changed during synthesis, so the old result is not applied; the same applies when the target clip is changed during regeneration', async () => {
    const a = instance('p-stale');
    a.beforeCommit = () => {
      a.project = { ...a.project, tracks: a.project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === 'typing' ? { ...c, params: { ...c.params, text: 'changed' } } : c)) })) };
      a.beforeCommit = null;
    };
    const out = await a.tools.sound_generate({ preset: 'keyboard', sourceClipId: 'typing', requestId: 's1' });
    // For whether the status is stale, see the test case marked todo below: the server relies on
    // /changed|switched/ to identify expired old results, but errors in src are now in English.
    assert.equal(out.ok, false, JSON.stringify(out));
    assert.match(out.error, /original typing clip has changed/);
    assert.equal(a.project.media.length, 0, 'The asset was uploaded but not registered in the project');
    assert.equal(clipsOf(a.project).filter((c) => c.soundEffect).length, 0);

    const ok = await a.tools.sound_generate({ preset: 'notification', start: 8, requestId: 's2' });
    assert.equal(ok.ok, true);
    a.beforeCommit = () => {
      a.project = { ...a.project, tracks: a.project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === ok.result.clipId ? { ...c, audioVolume: 0.5 } : c)) })) };
      a.beforeCommit = null;
    };
    const regen = await a.tools.sound_generate({ clipId: ok.result.clipId, params: { frequency: 440 }, requestId: 's3' });
    assert.equal(regen.ok, false, JSON.stringify(regen));
    const kept = clipsOf(a.project).find((c) => c.id === ok.result.clipId);
    assert.equal(kept.mediaId, ok.result.mediaId, 'The old sound effect stays unchanged');
    // Regenerate when unmodified: the same clip swaps asset, position unchanged
    const regen2 = await a.tools.sound_generate({ clipId: ok.result.clipId, params: { frequency: 440 }, requestId: 's4' });
    assert.equal(regen2.ok, true, JSON.stringify(regen2));
    assert.equal(regen2.result.clipId, ok.result.clipId);
    const after = clipsOf(a.project).find((c) => c.id === ok.result.clipId);
    assert.notEqual(after.mediaId, ok.result.mediaId);
    assert.deepEqual([after.start, after.audioVolume, after.soundEffect.recipe.params.frequency], [8, 0.5, 440]);
  });

  // Suspected product issue: server/agent/service/hosted-sound.mjs line 123 uses /changed|switched/ to
  // check if the commit callback threw "old result expired", but src/store/actions/sound.ts:30
  // already throws English "The original typing clip has changed, ..."(tr); unrecognized, so status
  // ends up failed rather than stale.
  // Remove todo once fixed.
  await t.test('An expired state is stale (the old result is not applied)', async () => {
    const a = instance('p-stale-state');
    a.beforeCommit = () => {
      a.project = { ...a.project, tracks: a.project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === 'typing' ? { ...c, params: { ...c.params, text: 'changed' } } : c)) })) };
      a.beforeCommit = null;
    };
    const out = await a.tools.sound_generate({ preset: 'keyboard', sourceClipId: 'typing', requestId: 's1' });
    assert.deepEqual([out.ok, out.state], [false, 'stale'], JSON.stringify(out));
  });

  await t.test('Limit: a member can queue at most 4 in one project; an upload failure returns the reason', async () => {
    const gate = { open: null };
    const hold = new Promise((r) => { gate.open = r; });
    const a = instance('p-queue', { renderHook: async (recipe, o, real) => { await hold; return real(recipe, o); } });
    const running = [0, 1, 2, 3].map((i) => a.tools.sound_generate({ preset: 'notification', requestId: `q${i}`, params: { frequency: 400 + i } }));
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(a.tools.sound_generate({ preset: 'notification', requestId: 'q4', params: { frequency: 500 } }), /The sound effect queue is full/);
    gate.open();
    assert.deepEqual((await Promise.all(running)).map((r) => r.state), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);

    const b = instance('p-fail');
    const failing = createSoundTools({
      state: newSoundState(), slot: createSlot(), host: async () => host,
      snapshot: async () => ({ project: b.project }), mutate: async () => { throw new Error('Should not reach commit'); },
      ensureCanWrite: async () => {}, put: async () => { throw new Error('The asset service rejected this write (413)'); }, record: (row) => b.usage.push(row), ToolError,
    });
    const out = await failing.sound_generate({ preset: 'notification', start: 1, requestId: 'f1' });
    assert.deepEqual([out.ok, out.state], [false, 'failed']);
    assert.match(out.error, /413/);
    assert.equal(b.usage[0].ok, false);
  });
});

test('CA-SND-03 / CA-SND-04 the job table is split per instance; only one synthesis runs at a time in a process', { timeout: 120_000 }, async (t) => {
  const { instance } = await setup(t);
  let active = 0;
  let peak = 0;
  const hook = async (recipe, o, real) => {
    active += 1; peak = Math.max(peak, active);
    try { await new Promise((r) => setTimeout(r, 60)); return await real(recipe, o); } finally { active -= 1; }
  };
  const a = instance('p-a', { renderHook: hook });
  const b = instance('p-b', { renderHook: hook });
  const pa = a.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'a1' });
  const pb = b.tools.sound_generate({ preset: 'notification', start: 1, requestId: 'b1' });
  const pb2 = b.tools.sound_generate({ preset: 'notification', start: 3, requestId: 'b2', params: { frequency: 700 } });
  await new Promise((r) => setTimeout(r, 20));
  const ja = (await a.tools.sound_status({})).jobs;
  const jb = (await b.tools.sound_status({})).jobs;
  assert.equal(ja.length, 1);
  assert.equal(jb.length, 2);
  assert.ok(ja.every((j) => /^sound-[a-f0-9]{12}$/.test(j.jobId)), 'Job IDs carry a random number, not a sequence number');
  // Instance B cannot see, query, or cancel jobs of instance A
  assert.equal(jb.some((j) => j.jobId === ja[0].jobId), false);
  await assert.rejects(b.tools.sound_status({ jobId: ja[0].jobId }), /Sound effect job not found/);
  await assert.rejects(b.tools.sound_cancel({ jobId: ja[0].jobId }), /Sound effect job not found/);
  // Cancellation while queued: does not take quota, does not synthesize
  const queued = jb.find((j) => j.state === 'queued');
  assert.ok(queued, 'B\'s second one is queued');
  assert.equal((await b.tools.sound_cancel({ jobId: queued.jobId })).state, 'cancelled');
  const [ra, rb, rb2] = await Promise.all([pa, pb, pb2]);
  assert.deepEqual([ra.state, rb.state, rb2.state].sort(), ['cancelled', 'succeeded', 'succeeded']);
  assert.equal(peak, 1, 'The two instances\' syntheses do not overlap');
  assert.equal(a.project.id, 'p-a');
  assert.equal(a.project.media.length, 1);
  assert.equal(b.project.media.length, 1);
});
