/**
 * Real synthesized asset acceptance. No browser or audio-quality success is inferred from a WAV.
 *
 * node scripts/probes/sound-effects-probe.mjs --node-only
 * node --experimental-transform-types scripts/probes/sound-effects-probe.mjs --node-only --av
 * node scripts/probes/sound-effects-probe.mjs --origin http://127.0.0.1:5250 [--asset-port 5255]  (资产服务用 N 与 N+1)
 *   [--chrome /path/to/chrome] [--no-sandbox] [--out work/sound-effects] [--av]
 *
 * The portable Node lane calls the real CardDef.audio, synthesis job manager, asset storage,
 * store split action, .procp pack/unpack, audioPlan and FFmpeg mux. The browser lane additionally
 * calls actual editor generation, MediaLayers preview, renderMix and browserExport.
 * Outputs include project, recipes, WAVs, MP4, decoded PCM energy/onset measurements and JSON.
 * --node-only intentionally records browser/Windows/listening as untested, never passed.
 */
import '../../src/testing/registerTs.mjs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildAudioPlan, buildFfmpegArgs } from '../../server/bakery/mux-audio.mjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback;
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = path.resolve(arg('out', path.join(ROOT, 'work/sound-effects')));
const ORIGIN = arg('origin', 'http://127.0.0.1:5250');
const NODE_ONLY = argv.includes('--node-only');
const SR = 48000;
// Test-generated data only; never inherit a user's installed media/export directories.
for (const k of ['PROMPTCUT_DATA_DIR', 'PROMPTCUT_EXPORT_DIR', 'PROMPTCUT_MEDIA_DIR']) delete process.env[k];
await fs.mkdir(OUT, { recursive: true });
const report = { startedAt: new Date().toISOString(), environment: { platform: process.platform, node: process.version, arch: process.arch }, checks: [], errors: [], artifacts: {}, untested: ['Windows desktop', 'subjective listening and physical output-device latency', 'user laptop performance thresholds'] };
const check = (ok, name, evidence = {}) => { report.checks.push({ name, ok: !!ok, ...evidence }); if (!ok) report.errors.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`); };
const save = async (name, bytes) => { const file = path.join(OUT, name); await fs.writeFile(file, bytes); report.artifacts[name] = file; return file; };
const json = (value) => JSON.stringify(value, null, 2);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const run = (cmd, args) => execFileSync(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
function pcmMetrics(samples) {
  let peak = 0, energy = 0, bad = 0;
  for (const v of samples) { if (!Number.isFinite(v)) bad++; peak = Math.max(peak, Math.abs(v)); energy += v * v; }
  return { peak, rms: Math.sqrt(energy / Math.max(1, samples.length)), nonFinite: bad, frames: samples.length / 2 };
}
function compare(a, b) {
  let peak = 0, difference = 0, square = 0;
  for (let i = 0; i < a.length; i++) { peak = Math.max(peak, Math.abs(a[i])); const d = Math.abs(a[i] - b[i]); difference = Math.max(difference, d); square += d * d; }
  return { maxRel: difference / Math.max(1e-12, peak), maxAbs: difference, rmsDifference: Math.sqrt(square / a.length) };
}
function eventEnergy(samples, events, channels = 2) {
  return events.map(({ at, id }) => {
    const from = Math.max(0, Math.round(at * SR)), until = Math.min(samples.length / channels, from + Math.round(.035 * SR));
    let energy = 0, peak = 0, onset = null;
    for (let frame = from; frame < until; frame++) {
      const value = samples[frame * channels]; energy += value * value; peak = Math.max(peak, Math.abs(value));
      if (onset === null && Math.abs(value) >= 0.0001) onset = frame / SR;
    }
    return { id, targetSeconds: at, onsetSeconds: onset, onsetErrorMs: onset === null ? null : (onset - at) * 1000, rms: Math.sqrt(energy / Math.max(1, until - from)), peak };
  });
}
// Align decoded AAC to the known source WAV waveform, rather than calling the first nonzero
// sample after a target the onset (that would hide priming delays and early pre-echo).
function waveformAlignment(actual, expected, events, channels = 2) {
  const halfWindow = Math.round(SR / 30), count = Math.round(.025 * SR);
  return events.map(({ at, id }) => {
    const start = Math.round(at * SR); let best = { lagSamples: 0, correlation: -Infinity };
    let refEnergy = 0; for (let i = 0; i < count; i++) refEnergy += (expected[(start + i) * channels] || 0) ** 2;
    for (let lag = -halfWindow; lag <= halfWindow; lag++) {
      let dot = 0, energy = 0;
      for (let i = 0; i < count; i++) { const a = actual[(start + i + lag) * channels] || 0, b = expected[(start + i) * channels] || 0; dot += a * b; energy += a * a; }
      const correlation = dot / Math.sqrt(Math.max(1e-30, energy * refEnergy));
      if (correlation > best.correlation) best = { lagSamples: lag, correlation };
    }
    return { id, ...best, lagMs: best.lagSamples * 1000 / SR };
  });
}

async function decoded(file, name) {
  const raw = path.join(OUT, name);
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ar', String(SR), '-ac', '2', '-f', 'f32le', raw]);
  const bytes = await fs.readFile(raw); return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

let project, recipes, mediaFiles, expectedPcm;
const httpServers = [];
async function serveAssets(service, root, port) {
  const middleware = service.mediaMiddleware(root);
  const { assetServiceMiddleware } = await import('../../server/asset-service.ts');
  const asset = assetServiceMiddleware(root);
  const server = http.createServer((req, res) => { void asset(req, res, () => { void middleware(req, res, () => { res.statusCode = 404; res.end(); }); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  httpServers.push(server);
  return `http://127.0.0.1:${port}`;
}
try {
  const synth = await import('../../src/kernel/soundEffects.ts');
  const typing = await import('../../src/kernel/typingEvents.ts');
  const cards = await import('../../src/cards/native/sound-effects.ts');
  const flow = await import('../../src/audio/soundGeneration.ts');
  const service = await import('../../server/vite-plugin-media.ts');
  const { actions, getState } = await import('../../src/store/project.ts');
  const { createEmptyProject, audioClipsAt } = await import('../../src/kernel/project.ts');
  const { audioPlanOf } = await import('../../src/kernel/audioPlan.mjs');
  const pack = await import('../../src/editor/io/procp.ts');

  report.environment.ffmpeg = run('ffmpeg', ['-version']).split('\n')[0];
  report.resourceLimits = synth.SOUND_EFFECT_LIMITS;
  const typingOptions = { text: '你好，👩🏽‍💻！ A\n完。', duration: 130, delayMs: 170, punctuationPauseMs: 140, newlinePauseMs: 180, jitterMs: 15, seed: 73, pauses: [{ afterIndex: 1, durationMs: 110 }] };
  recipes = { keyboard: synth.createTypingSoundRecipe(typingOptions, {}, { seed: 73 }), notification: synth.createNotificationRecipe({ notes: [0, 7], interval: .19 }, { seed: 73 }) };
  const schedule = recipes.keyboard.typingSource;
  check(schedule.events.map(e => e.grapheme).join('') === typingOptions.text && schedule.events.filter(e => e.grapheme.includes('👩')).length === 1, 'CJK and emoji use complete graphemes', { graphemes: schedule.events.map(e => e.grapheme) });
  check(schedule.events.every(e => typing.typingTextAt(schedule, e.atMs).endsWith(e.grapheme)), 'visual text and sound share exact inclusive event boundaries');
  check(schedule.events.filter(e => ['space', 'newline'].includes(e.keyType)).every(e => !e.sound), 'spaces/newlines silent by default; punctuation remains scheduled');
  const faster = synth.createTypingSoundRecipe({ ...typingOptions, duration: 65 });
  check(faster.frames < recipes.keyboard.frames && synth.soundEffectReuseKey(faster) !== synth.soundEffectReuseKey(recipes.keyboard), 'typing speed change regenerates schedule and identity');

  for (const [name, card] of [['notification', cards.notificationSoundCard], ['keyboard', cards.keyboardSoundCard]]) {
    check(Object.keys(card.inputs).length === 0, `${name} actual CardDef has no input assets`);
    const range = { start: 137, count: 32001, sampleRate: SR };
    const params = { ...card.defaults };
    const a = await card.audio({}, range, params), b = await card.audio({}, range, params);
    check(a instanceof Float32Array && a.length === range.count * 2 && compare(a, b).maxRel === 0, `${name} actual CardDef.audio nonzero start exact replay`, { length: a.length, ...pcmMetrics(a) });
  }

  const renderPartition = (recipe, size, reverse = false) => {
    const out = new Float32Array(recipe.frames * recipe.channels);
    const ranges = [];
    for (let start = 0; start < recipe.frames; start += size) ranges.push({ start, count: Math.min(size, recipe.frames - start) });
    for (const r of reverse ? ranges.reverse() : ranges) out.set(synth.renderSoundEffectBlock(recipe, r), r.start * recipe.channels);
    return out;
  };
  for (const [name, recipe] of Object.entries(recipes)) {
    const baseline = renderPartition(recipe, 65536);
    const comparisons = [4096, 7919, 32767].map(size => ({ size, ...compare(baseline, renderPartition(recipe, size, true)) }));
    const offset = Math.min(17927, recipe.frames - 1), count = Math.min(31003, recipe.frames - offset);
    const randomAccess = compare(baseline.subarray(offset * 2, (offset + count) * 2), synth.renderSoundEffectBlock(recipe, { start: offset, count }));
    check(comparisons.every(c => c.maxRel <= 1e-6) && randomAccess.maxRel <= 1e-6, `${name} reordered chunks and nonzero sample range`, { comparisons, randomAccess });
    check(pcmMetrics(baseline).nonFinite === 0 && pcmMetrics(baseline).peak < 1, `${name} finite PCM with headroom`, pcmMetrics(baseline));
    const zero = synth.renderSoundEffectBlock(recipe, { start: -320, count: 320 });
    check(zero.every(v => v === 0), `${name} negative range zero pads`);
  }

  project = { ...createEmptyProject('Sound effects acceptance'), width: 640, height: 360, fps: 30, duration: 5, media: [], tracks: [{ id: 'track-keyboard', name: 'keyboard', clips: [] }, { id: 'track-notification', name: 'notification', clips: [] }] };
  actions.loadProject(project); project = getState().project;
  mediaFiles = new Map();
  let activeUploads = 0, peakUploads = 0;
  const storage = path.join(OUT, 'asset-service');
  const assetOrigin = await serveAssets(service, storage, Number(arg('asset-port', 5255)));
  const { createSnapUploader, sha256Hex } = await import('../../src/online/snapUploader.ts');
  const uploader = createSnapUploader({ base: () => `${assetOrigin}/api/asset`, ticket: async () => null });
  const manager = flow.createSoundGenerationManager({ upload: async (wav, signal) => {
    signal.throwIfAborted(); peakUploads = Math.max(peakUploads, ++activeUploads);
    try { const hash = await sha256Hex(wav); await uploader.put('media', hash, wav, 'wav'); signal.throwIfAborted(); mediaFiles.set(hash, await service.resolveHashFile(storage, hash)); return { hash, bytes: wav.length }; }
    finally { activeUploads--; }
  } });
  let peakActiveJobs = 0; manager.subscribe(() => { peakActiveJobs = Math.max(peakActiveJobs, manager.list().filter(j => ['rendering', 'uploading'].includes(j.state)).length); });
  const jobs = [];
  for (const [name, recipe] of Object.entries(recipes)) {
    const request = { requestId: `acceptance-${name}`, targetKey: name, recipe, isCurrent: () => true, commit: (asset, persistedRecipe, reuseKey) => {
      const start = name === 'keyboard' ? .3500208333333333 : 3.750020833333333;
      const spec = { projectId: project.id, cutId: project.activeCutId, start, duration: recipe.frames / SR, trackId: `track-${name}`,
        asset: { kind: 'audio', name: `${name}.wav`, url: `/@media/${asset.hash}`, hash: asset.hash, ext: 'wav', size: asset.bytes, duration: recipe.frames / SR, soundEffect: { recipe: persistedRecipe, reuseKey } },
        link: { recipe: persistedRecipe, reuseKey, requestId: `acceptance-${name}` } };
      const result = actions.commitSoundEffect(spec);
      check(actions.setClipVolume(result.clipId, .8).ok, `${name} actual clip-volume action accepts generated WAV`);
      const committed = getState().project;
      check(actions.commitSoundEffect(spec).clipId === result.clipId && getState().project === committed, `${name} actual atomic store commit is idempotent`);
      project = getState().project;
      return result;
    } };
    const job = manager.start(request); jobs.push(job);
    check(manager.start(request).id === job.id, `${name} duplicate request joins existing job`);
  }
  const results = await Promise.all(jobs.map(j => manager.wait(j.id)));
  check(results.every(j => j.state === 'succeeded') && peakUploads === 1 && peakActiveJobs === 1, 'real WAV persistence serialized; two ordinary audio clips committed', { results, peakConcurrentUploads: peakUploads, peakActiveJobs });
  report.assetUploader = uploader.stats();
  for (const media of project.media) {
    const bytes = await fs.readFile(await service.resolveHashFile(storage, media.hash));
    check(sha(bytes) === media.hash, `${media.name} persistent bytes match content hash`);
    await save(media.name, bytes);
  }
  const before = JSON.stringify(project);
  const cancelJob = manager.start({ requestId: 'cancel-budget', targetKey: 'cancel', recipe: synth.createNotificationRecipe({}, { frames: SR * 60 }), isCurrent: () => true, commit: () => { throw new Error('cancelled work committed'); } });
  await new Promise(r => setTimeout(r, 0));
  const cancelAt = performance.now(); manager.cancel(cancelJob.id); const cancelled = await manager.wait(cancelJob.id);
  report.cancelMs = performance.now() - cancelAt;
  check(cancelled.state === 'cancelled' && before === JSON.stringify(project), 'cancel leaves prior clips unchanged', { responseMs: report.cancelMs });

  project = { ...project, tracks: [...project.tracks, { id: 'track-visual', name: 'Shared typing schedule', clips: [{ id: 'clip-visual', cardId: 'mu-typing', start: .3500208333333333, end: 3.5, params: typingOptions }] }] };
  actions.loadProject(project);
  const original = project.tracks[0].clips[0];
  const splitAt = original.start + .8000208333333333;
  const right = actions.splitClip(original.id, splitAt);
  project = getState().project;
  check(right && Math.abs(right.mediaOffset - (splitAt - original.start)) * SR <= 1, 'real split action preserves nonzero sample offset', { splitAt, offset: right?.mediaOffset });
  const plan = audioPlanOf(project);
  check(plan.length === 3 && plan.every(e => Math.abs((e.start - project.tracks.flatMap(t => t.clips).find(c => c.id === e.clipId).start) * SR) <= 1), 'ordinary audio plan has exactly split clips and preserves one-sample timeline precision', { plan });
  const sound = audioClipsAt(project, original.start + .1);
  const muted = audioClipsAt({ ...project, tracks: project.tracks.map(t => ({ ...t, muted: true })) }, original.start + .1);
  check(sound.length === 1 && sound[0].volume === .8 && muted.length === 0, 'preview selection uses one source, clip gain and track mute');
  check(audioPlanOf({ ...project, tracks: project.tracks.map(t => ({ ...t, muted: true })) }).length === 0 && audioPlanOf({ ...project, tracks: project.tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c, audioMuted: true })) })) }).length === 0, 'export plan respects track mute and individual clip mute');
  check(project.tracks.flatMap(t => t.clips).filter(c => c.soundEffect).every(c => !c.nodeId && c.mediaId), 'persisted clips cannot also play generated graph audio');
  await save('project.json', json(project)); await save('recipes.json', json(recipes));

  // Real packaging and real service HTTP endpoints; only relative-URL resolution is adapted for Node.
  const oldFetch = globalThis.fetch;
  const unpackRoot = path.join(OUT, 'reopened-asset-service');
  const unpackOrigin = await serveAssets(service, unpackRoot, Number(arg('asset-port', 5255)) + 1);
  let transportOrigin = assetOrigin;
  globalThis.fetch = (input, init) => oldFetch(typeof input === 'string' && input.startsWith('/') ? new URL(input, transportOrigin) : input, init);
  try {
    const procText = json({ format: 'promptcut-project', version: 1, project });
    const packed = await pack.packProcpFrom(procText, project);
    await save('acceptance.procp', new Uint8Array(await packed.blob.arrayBuffer()));
    transportOrigin = unpackOrigin;
    const restored = await pack.unpackProcp(packed.blob);
    const reopenProject = JSON.parse(restored.procText).project;
    const valid = await Promise.all(reopenProject.media.map(async m => sha(await fs.readFile(await service.resolveHashFile(unpackRoot, m.hash))) === m.hash));
    check(!packed.missing.length && valid.every(Boolean) && restored.landed.length === 2, 'offline package restores real sound bytes through HTTP into second asset library', { stored: restored.stored, deduped: restored.deduped, landed: restored.landed });
  } finally { globalThis.fetch = oldFetch; }

  const longRecipe = synth.createTypingSoundRecipe({ text: 'a'.repeat(10000), duration: 5 }, { duration: .01 }, { frames: SR * 60 });
  const jobCountBeforeOversize = manager.list().length;
  let persistenceSizeError = null;
  try { manager.start({ requestId: 'oversized-persisted-recipe', targetKey: 'oversized', recipe: longRecipe, isCurrent: () => true, commit: () => { throw new Error('Oversized recipe must not commit'); } }); }
  catch (error) { persistenceSizeError = error.message; }
  check(!!persistenceSizeError && manager.list().length === jobCountBeforeOversize, 'persisted workflow rejects oversized recipe before allocating a generation job', { bytes: new TextEncoder().encode(JSON.stringify(longRecipe)).length, error: persistenceSizeError });
  const memoryBefore = process.memoryUsage(); const begin = performance.now(); let maxBlockMs = 0;
  const longWav = await flow.renderSoundEffectWav(longRecipe, { yield: async () => {}, render: (r, range) => { const t = performance.now(); const b = synth.renderSoundEffectBlock(r, range); maxBlockMs = Math.max(maxBlockMs, performance.now() - t); return b; } });
  report.resourceMeasurement = { scope: 'pure WAV generation only, not accepted persisted UI workflow', serializedRecipeBytes: new TextEncoder().encode(JSON.stringify(longRecipe)).length, seconds: 60, events: 10000, elapsedMs: performance.now() - begin, maximumBlockMs: maxBlockMs, wavBytes: longWav.length, memoryBefore, memoryAfter: process.memoryUsage(), peakResidentSetBytes: process.resourceUsage().maxRSS * 1024, caveat: 'Node process measurements; browser and laptop performance untested' };
  try {
    let overloadRejected = false;
    try { synth.createTypingSoundRecipe({ text: 'a'.repeat(10000), duration: 0 }, { duration: .066 }); } catch { overloadRejected = true; }
    check(overloadRejected, 'pathological 10000-coincident-event load rejected before allocation');
    const dense = synth.createTypingSoundRecipe({ text: 'a'.repeat(synth.SOUND_EFFECT_LIMITS.maxSimultaneousEvents), duration: 0 }, { duration: .5 });
    let denseBlockMs = 0, cancelCalledAt = 0;
    const denseManager = flow.createSoundGenerationManager({ upload: async () => { throw new Error('Dense cancelled task must not upload'); }, render: (recipe, range) => { const before = performance.now(); const out = synth.renderSoundEffectBlock(recipe, range); denseBlockMs = Math.max(denseBlockMs, performance.now() - before); return out; } });
    const denseStart = performance.now();
    const job = denseManager.start({ requestId: 'dense-cancel', targetKey: 'dense', recipe: dense, isCurrent: () => true, commit: () => { throw new Error('Dense cancelled task must not commit'); } });
    setTimeout(() => { cancelCalledAt = performance.now(); denseManager.cancel(job.id); }, 1);
    const result = await denseManager.wait(job.id);
    report.denseCancellation = { events: dense.events.length, voiceFrames: dense.events.length * dense.frames, state: result.state, maxSynchronousBlockMs: denseBlockMs, cancelTimerLatenessMs: cancelCalledAt - denseStart - 1, cancelResponseMs: performance.now() - cancelCalledAt, elapsedMs: performance.now() - denseStart };
    check(result.state === 'cancelled', 'maximum simultaneous voices inline cancellation (browser Worker separately untested)', report.denseCancellation);
  } catch (error) { report.denseCancellation = { error: String(error.message || error) }; check(false, 'accepted dense cancellation measurement failed', report.denseCancellation); }

  check(longWav.length === 44 + SR * 60 * 4, 'pure 60-second / 10000-event fixture generates without truncation; not a persisted-workflow claim', report.resourceMeasurement);
  let overDuration = false, overEvents = false;
  try { synth.createNotificationRecipe({}, { frames: SR * 60 + 1 }); } catch { overDuration = true; }
  try { synth.createTypingSoundRecipe({ text: 'a'.repeat(10001), duration: 0 }); } catch { overEvents = true; }
  check(overDuration && overEvents, 'over-budget duration/events rejected before allocation');

  const silentVideo = path.join(OUT, 'visual-fixture.mp4');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x152431:s=640x360:r=30:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentVideo]);
  const desktopPlan = buildAudioPlan(project, OUT, fsSync.existsSync, media => mediaFiles.get(media.hash));
  const mp4 = path.join(OUT, 'ffmpeg-acceptance.mp4');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...buildFfmpegArgs(silentVideo, desktopPlan, mp4, project.duration)]);
  report.artifacts['ffmpeg-acceptance.mp4'] = mp4;
  report.ffprobe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4]));
  const finalPcm = await decoded(mp4, 'ffmpeg-decoded.f32');
  const expectedEvents = Object.entries(recipes).flatMap(([name, recipe]) => recipe.events.map(e => ({ id: `${name}-${e.id}`, at: (name === 'keyboard' ? .3500208333333333 : 3.750020833333333) + e.frame / SR })));
  expectedPcm = new Float32Array(Math.ceil(project.duration * SR) * 2);
  for (const clip of desktopPlan) {
    const wav = await fs.readFile(clip.file), view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(view.getUint16(20, true), 1, 'fixture WAV is PCM16');
    const start = Math.round(clip.start * SR), offset = Math.round(clip.offset * SR), count = Math.round(clip.dur * SR);
    for (let i = 0; i < count; i++) for (let channel = 0; channel < 2; channel++) {
      const at = 44 + ((offset + i) * 2 + channel) * 2;
      if (at + 2 <= wav.length && (start + i) * 2 + channel < expectedPcm.length) expectedPcm[(start + i) * 2 + channel] += view.getInt16(at, true) / 32768 * clip.volume;
    }
  }
  report.finalAudio = { source: 'existing buildAudioPlan/buildFfmpegArgs pipeline; synthetic color video fixture, not rendered editor visuals', pcm: pcmMetrics(finalPcm), events: eventEnergy(finalPcm, expectedEvents), waveformAlignment: waveformAlignment(finalPcm, expectedPcm, expectedEvents) };
  check(report.ffprobe.streams.some(s => s.codec_type === 'audio') && report.finalAudio.pcm.nonFinite === 0 && report.finalAudio.pcm.peak <= 1 && report.finalAudio.events.every(e => e.rms > 0.00005) && report.finalAudio.waveformAlignment.every(e => e.correlation > .7 && Math.abs(e.lagSamples) < SR / project.fps), 'final FFmpeg MP4 decoded event energy and onsets, not merely audio-track presence', report.finalAudio);
  // A real ordinary WAV bed exercises overlap with generated sounds and export gain/mute.
  // It is a low-level test tone, not a claim about music or speech listening quality.
  const bedFile = path.join(OUT, 'ordinary-test-tone.wav');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=5', '-af', 'volume=0.1', '-ac', '2', '-c:a', 'pcm_s16le', bedFile]);
  const bedBytes = await fs.readFile(bedFile), bedHash = sha(bedBytes); await uploader.put('media', bedHash, bedBytes, 'wav'); mediaFiles.set(bedHash, await service.resolveHashFile(storage, bedHash));
  const mixedProject = { ...project, media: [...project.media, { id: 'ordinary-bed', kind: 'audio', name: 'ordinary-test-tone.wav', url: `/@media/${bedHash}`, hash: bedHash, duration: 5 }], tracks: [...project.tracks.map(t => t.id === 'track-notification' ? { ...t, clips: t.clips.map(c => ({ ...c, start: 1.3, end: 1.3 + c.end - c.start })) } : t), { id: 'track-bed', name: 'Ordinary test tone', clips: [{ id: 'clip-bed', mediaId: 'ordinary-bed', start: 0, end: 5, params: {}, audioVolume: .3 }] }] };
  const mixExport = async (p, name) => {
    const out = path.join(OUT, name), plan = buildAudioPlan(p, OUT, fsSync.existsSync, m => mediaFiles.get(m.hash));
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...buildFfmpegArgs(silentVideo, plan, out, p.duration)]); report.artifacts[name] = out;
    return decoded(out, name + '.f32');
  };
  const overlapping = await mixExport(mixedProject, 'overlap-acceptance.mp4');
  const mutedExport = await mixExport({ ...mixedProject, tracks: mixedProject.tracks.map(t => t.id === 'track-keyboard' ? { ...t, clips: t.clips.map(c => ({ ...c, audioMuted: true })) } : t) }, 'muted-acceptance.mp4');
  const firstEvent = [expectedEvents[0]], activeEnergy = eventEnergy(overlapping, firstEvent)[0], muteEnergy = eventEnergy(mutedExport, firstEvent)[0];
  check(pcmMetrics(overlapping).peak < 1 && pcmMetrics(overlapping).nonFinite === 0 && muteEnergy.rms < activeEnergy.rms * .2, 'final overlap MP4 mixes ordinary tone and SFX; per-clip mute suppresses keyboard', { pcm: pcmMetrics(overlapping), activeRms: activeEnergy.rms, mutedRms: muteEnergy.rms });
  const halfGain = await mixExport({ ...project, tracks: project.tracks.map(t => ({ ...t, clips: t.clips.map(c => c.mediaId ? { ...c, audioVolume: .4 } : c) })) }, 'half-gain-acceptance.mp4');
  const gainRatio = eventEnergy(halfGain, firstEvent)[0].rms / eventEnergy(finalPcm, firstEvent)[0].rms;
  check(gainRatio > .45 && gainRatio < .55, 'final MP4 audioVolume half-gain is audible in decoded PCM', { gainRatio });
  report.project = { clips: project.tracks.flatMap(t => t.clips).length, media: project.media.length, typingEventCount: schedule.events.length };
  if (argv.includes('--av')) await audiovisualLane({ actions, getState, createEmptyProject, cards, typingOptions, uploader, service, storage, silentVideo });
  else report.untested.push('Expanded audiovisual same-clip acceptance (run --av after integration)');
} catch (error) { report.errors.push(String(error.stack || error)); console.error(error); }

if (NODE_ONLY) {
  report.untested.push('Linux Chromium actual preview, renderMix, browserExport and screenshots (node-only run)');
} else if (project) {
  try { await browserLane(); }
  catch (error) { report.errors.push(`Browser lane: ${error.stack || error}`); report.untested.push('Browser lane did not finish; inspect error and partial measurements'); console.error(error); }
}
for (const server of httpServers) await new Promise(resolve => server.close(resolve));
report.finishedAt = new Date().toISOString();
report.ok = report.errors.length === 0;
report.coverage = { mode: NODE_ONLY ? 'node-only' : 'node-and-browser', fullAcceptanceVerified: false, reason: 'Windows and subjective listening need independent verification; browser coverage is recorded per check and must not be inferred from Node success' };
await save('report.json', json(report));
console.log(json({ ok: report.ok, checks: report.checks.length, errors: report.errors, untested: report.untested, report: path.join(OUT, 'report.json') }));
process.exitCode = report.ok ? 0 : 1;

async function browserLane() {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ executablePath: arg('chrome', process.env.PUPPETEER_EXECUTABLE_PATH || undefined), headless: true, args: [...PROBE_CHROME_ARGS, '--autoplay-policy=no-user-gesture-required', '--mute-audio', ...(argv.includes('--no-sandbox') ? ['--no-sandbox'] : [])] });
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(`${ORIGIN}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    report.environment.chromium = await browser.version();
    const generated = await page.evaluate(async recipes => {
      const { actions, getState } = await import('/src/store/project.ts');
      const { startSoundGeneration, waitSoundGeneration } = await import('/src/editor/io/soundGeneration.ts');
      // 新项目的缺省时长很短,音效起点必须落在项目内(「音效起点在项目出点之外」),所以先装一个 5 秒的空项目。
      const { createEmptyProject } = await import('/src/kernel/project.ts');
      actions.loadProject({ ...createEmptyProject('Browser native sound generation acceptance'), width: 640, height: 360, fps: 30, duration: 5, media: [], tracks: [{ id: 'browser-visual', name: 'visual', clips: [] }] });
      // 总时长跟着内容走、声音尾巴不会拉长出点:先放一张 5 秒的画面卡当内容,音效才有地方落。
      actions.addCardClip('mu-typing', 0, { duration: 5 });
      const jobs = Object.entries(recipes).map(([name, recipe]) => startSoundGeneration({ recipe, start: name === 'keyboard' ? .35 : 3.75, name, requestId: `browser-${name}` }));
      const results = await Promise.all(jobs.map(job => waitSoundGeneration(job.id)));
      return { results, media: getState().project.media.map(m => ({ kind: m.kind, hash: m.hash, url: m.url, hasRecipe: !!m.soundEffect })), clips: getState().project.tracks.flatMap(t => t.clips).filter(c => !c.cardId).map(c => ({ mediaId: c.mediaId, nodeId: c.nodeId })) };
    }, recipes);
    check(generated.results.every(j => j.state === 'succeeded') && generated.media.length === 2 && generated.clips.length === 2 && generated.clips.every(c => c.mediaId && !c.nodeId), 'actual editor generation Worker, asset service and atomic ordinary-clip commit', generated);
    if (!generated.results.every(j => j.state === 'succeeded')) throw new Error('Browser native generation failed');

    // All browser sources enter the actual asset service, preserving persisted URLs across reopening.
    const uploaded = [];
    for (const media of project.media) {
      const bytes = Array.from(await fs.readFile(mediaFiles.get(media.hash)));
      uploaded.push(await page.evaluate(async ({ name, bytes }) => { const r = await fetch(`/api/media/upload/${name}`, { method: 'POST', body: new Uint8Array(bytes) }); if (!r.ok) throw new Error(`asset HTTP ${r.status}`); return r.json(); }, { name: media.name, bytes }));
    }
    check(uploaded.every((m, i) => m.hash === project.media[i].hash), 'browser asset-service upload matches persisted WAV hashes');
    await page.evaluate(async p => { const { actions } = await import('/src/store/project.ts'); actions.loadProject(p); actions.setVolume(1); actions.seek(.7); }, project);
    await page.waitForFunction(() => document.querySelectorAll('audio').length > 0);
    const preview = await page.evaluate(async () => {
      const { actions, getState } = await import('/src/store/project.ts'); const sleep = ms => new Promise(r => setTimeout(r, ms));
      const states = [];
      for (const t of [.7, 1.5, .7]) { actions.seek(t); await sleep(200); states.push({ t, audio: [...document.querySelectorAll('audio')].map(e => ({ src: e.currentSrc, time: e.currentTime, volume: e.volume, paused: e.paused, ready: e.readyState })) }); }
      actions.play(); await sleep(450); actions.pause(); await sleep(100); const paused = [...document.querySelectorAll('audio')].every(e => e.paused);
      actions.seek(.7); actions.setVolume(.25); await sleep(100); const gain = [...document.querySelectorAll('audio')].map(e => e.volume);
      actions.toggleMute(); await sleep(100); const muted = [...document.querySelectorAll('audio')].map(e => e.volume); actions.toggleMute(); actions.setVolume(1);
      actions.replay(); await sleep(180); const replayed = getState().playing; actions.pause();
      return { states, paused, playing: getState().playing, gain, muted, replayed };
    });
    report.preview = preview;
    check(preview.paused && preview.states.every(s => s.audio.length === 1 && !s.audio[0].src.startsWith('blob:')), 'actual preview seek/replay/pause uses one persisted source', preview);
    check(preview.gain.length === 1 && Math.abs(preview.gain[0] - .2) < .0001 && preview.muted.every(v => v === 0) && preview.replayed, 'actual preview gain, mute and replay', { gain: preview.gain, muted: preview.muted, replayed: preview.replayed });
    const screenshot = path.join(OUT, 'editor-preview.png'); await page.screenshot({ path: screenshot }); report.artifacts['editor-preview.png'] = screenshot;
    // Same ordinary desktop plan, FFmpeg trimming and production renderMix used by audio-mix.mjs.
    const desktopPlan = buildAudioPlan(project, OUT, fsSync.existsSync, media => mediaFiles.get(media.hash));
    const mixClips = [];
    for (let i = 0; i < desktopPlan.length; i++) {
      const clip = desktopPlan[i], sliced = path.join(OUT, `desktop-slice-${i}.wav`);
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(clip.offset), '-t', String(clip.dur), '-i', clip.file, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_f32le', sliced]);
      const bytes = Array.from(await fs.readFile(sliced));
      const media = await page.evaluate(async ({ bytes, i }) => { const r = await fetch(`/api/media/upload/desktop-slice-${i}.wav`, { method: 'POST', body: new Uint8Array(bytes) }); if (!r.ok) throw new Error(`slice HTTP ${r.status}`); return r.json(); }, { bytes, i });
      mixClips.push({ ...clip, url: media.url });
    }
    const mix = await page.evaluate(async plan => { const { renderMix, encodeWavFloat32, peakOf } = await import('/src/audio/renderMix.ts'); const result = await renderMix(plan); return { bytes: Array.from(new Uint8Array(encodeWavFloat32(result.buffer))), peak: peakOf(result.buffer), ms: result.ms, notes: result.notes }; }, { sampleRate: SR, duration: project.duration, clips: mixClips });
    await save('chromium-renderMix.wav', new Uint8Array(mix.bytes));
    report.chromiumMix = { ms: mix.ms, peak: mix.peak, notes: mix.notes };
    const mixedMp4 = path.join(OUT, 'chromium-desktop-acceptance.mp4');
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(OUT, 'visual-fixture.mp4'), '-i', path.join(OUT, 'chromium-renderMix.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(project.duration), mixedMp4]);
    report.artifacts['chromium-desktop-acceptance.mp4'] = mixedMp4;
    const mixPcm = await decoded(mixedMp4, 'chromium-desktop-decoded.f32');
    const mixEnergy = eventEnergy(mixPcm, report.finalAudio.events.map(e => ({ id: e.id, at: e.targetSeconds })));
    check(mixEnergy.every(e => e.rms > .00005 && e.onsetErrorMs <= 1000 / project.fps), 'desktop Chromium renderMix final MP4 decoded events', { ...report.chromiumMix, energy: mixEnergy });
    const browserResult = await page.evaluate(async p => {
      const { runBrowserExport } = await import('/src/export/browserExport.ts');
      const { MemorySink } = await import('/src/export/mp4Mux.ts'); const sink = new MemorySink(); const decisions = [];
      const result = await runBrowserExport({ project: p, sink, signal: new AbortController().signal, confirm(message) { decisions.push(message); return false; }, notify() {}, checkMediaOriginals: async () => [], originals: null });
      const out = sink.bytes();
      return { result, decisions, bytes: Array.from(out) };
    }, project);
    await save('browser-acceptance.mp4', new Uint8Array(browserResult.bytes));
    report.browserExport = browserResult.result;
    check(browserResult.result.audio, 'actual browserExport WAV-input MP4 includes audio', browserResult.result);
    const browserPcm = await decoded(path.join(OUT, 'browser-acceptance.mp4'), 'browser-decoded.f32');
    const expected = report.finalAudio.events.map(e => ({ id: e.id, at: e.targetSeconds }));
    const energy = eventEnergy(browserPcm, expected), alignment = waveformAlignment(browserPcm, expectedPcm, expected);
    check(energy.every(e => e.rms > 0.00005) && alignment.every(e => e.correlation > .7 && Math.abs(e.lagSamples) < SR / project.fps), 'browser final MP4 decoded event energy and frame-bounded waveform alignment', { energy, alignment });
    // Close the creating page and open a fresh browser context, then load only persisted project/WAV data.
    await page.close(); const context = await browser.createBrowserContext(); const fresh = await context.newPage(); await fresh.goto(`${ORIGIN}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
    const reopen = await fresh.evaluate(async p => { const { actions } = await import('/src/store/project.ts'); actions.loadProject(p); const ctx = new OfflineAudioContext(2, 1, 48000); return Promise.all(p.media.map(async m => ({ hash: m.hash, frames: (await ctx.decodeAudioData(await (await fetch(m.url)).arrayBuffer())).length }))); }, project);
    check(reopen.every((m, i) => m.frames === project.media[i].soundEffect.recipe.frames), 'fresh browser decodes persisted WAV without generation page', { reopen });
    await context.close();
  } finally { await browser.close(); }
}


async function audiovisualLane({ actions, getState, createEmptyProject, cards, typingOptions, uploader, service, storage, silentVideo }) {
  const { registerCards, getCard } = await import('../../src/kernel/registry.ts');
  const { configureCardAudio, renderEmbeddedCardWav, cardAudioNodeOf } = await import('../../src/audio/cardAudio.ts');
  const { cardAudioIdentity, resolveCardAudioRendition } = await import('../../src/kernel/cardAudioRendition.mjs');
  const { commitCardAudio } = await import('../../src/store/actions/cardAudio.ts');
  const { audioPlanOf } = await import('../../src/kernel/audioPlan.mjs');
  // Test-owned AV card: real native keyboard audio function plus a visual Component contract.
  // Node does not render its Component, so this lane cannot claim visual pixels or the UI badge.
  const fixture = { ...cards.keyboardSoundCard, id: 'qa-audiovisual-card', kind: 'animation', Component: () => null };
  registerCards([fixture]);
  const hooks = { getCard, sourceVersionOf: () => 'qa-native-keyboard-av-v1' };
  configureCardAudio(hooks);
  actions.loadProject({ ...createEmptyProject('Same-clip audiovisual acceptance'), width: 640, height: 360, fps: 30, duration: 5, media: [], tracks: [{ id: 'av-track', name: 'AV', clips: [] }] });
  const clip = actions.addCardClip(fixture.id, .3500208333333333, { duration: recipes.keyboard.frames / SR, params: { ...fixture.defaults, ...typingOptions } });
  check(!!clip && !!cardAudioNodeOf(getState().project, clip), 'actual AV add-card resolves one graph-linked visual clip');
  const before = getState(), frozen = structuredClone(before.project);
  const frozenClip = frozen.tracks.flatMap(t => t.clips).find(c => c.id === clip.id);
  const identity = cardAudioIdentity(frozen, frozenClip, hooks);
  const rendered = await renderEmbeddedCardWav(frozen, frozenClip, new AbortController().signal);
  const hash = sha(rendered.wav); await uploader.put('media', hash, rendered.wav, 'wav');
  const file = await service.resolveHashFile(storage, hash); mediaFiles.set(hash, file); await save('audiovisual-card.wav', rendered.wav);
  const committed = commitCardAudio({ projectId: before.project.id, cutId: before.project.activeCutId, loadToken: before.projectLoadToken, clipId: clip.id, expectedClip: JSON.stringify(frozenClip),
    media: { kind: 'audio', name: 'audiovisual-card.wav', url: `/@media/${hash}`, hash, ext: 'wav', size: rendered.wav.length, duration: rendered.frames / SR },
    rendition: { version: 1, cardId: fixture.id, sourceKey: sha(Buffer.from(JSON.stringify(identity))), sourceOffset: 0, duration: rendered.frames / SR, sampleRate: SR, frames: rendered.frames, channels: rendered.channels, identity } });
  let avProject = getState().project;
  const avClip = avProject.tracks.flatMap(t => t.clips).find(c => c.id === clip.id);
  check(committed.clipId === clip.id && avProject.tracks.flatMap(t => t.clips).length === 1 && avClip.cardAudio?.mediaId === committed.mediaId && !avClip.mediaId, 'persisted card sound stays attached to original single visual clip');
  const avPlan = buildAudioPlan(avProject, OUT, fsSync.existsSync, m => mediaFiles.get(m.hash));
  check(avPlan.length === 1 && !avPlan[0].cardAudio, 'AV export selects one persisted WAV, no generated double-play');
  const avMp4 = path.join(OUT, 'audiovisual-audio-acceptance.mp4');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...buildFfmpegArgs(silentVideo, avPlan, avMp4, 5)]); report.artifacts['audiovisual-audio-acceptance.mp4'] = avMp4;
  const actual = await decoded(avMp4, 'audiovisual-decoded.f32');
  const targets = recipes.keyboard.events.map(e => ({ id: `av-${e.id}`, at: clip.start + e.frame / SR }));
  const energy = eventEnergy(actual, targets), alignment = waveformAlignment(actual, expectedPcm, targets);
  check(energy.every(e => e.rms > .00005) && pcmMetrics(actual).peak <= 1 && alignment.every(e => e.correlation > .7 && Math.abs(e.lagSamples) < SR / 30), 'AV persisted rendition final MP4 contains every keyboard event with aligned waveform', { energy, alignment, pcm: pcmMetrics(actual) });
  const projectBeforeDetach = getState().project, snapshot = JSON.stringify(projectBeforeDetach);
  const detached = actions.separateAudio(clip.id);
  check(detached?.ok === false && typeof detached.error === 'string' && getState().project === projectBeforeDetach && JSON.stringify(getState().project) === snapshot, 'embedded motion-card audio detach fails explicitly and atomically', { detached });
  const muted = actions.setClipMuted(clip.id, true);
  check(muted?.ok && audioPlanOf(getState().project).length === 0 && getState().project.tracks.flatMap(t => t.clips).some(c => c.id === clip.id && c.cardId === fixture.id), 'independent AV clip mute removes sound and keeps visual clip');
  actions.setClipMuted(clip.id, false);
  const gainChanged = actions.setClipVolume(clip.id, .4);
  check(gainChanged?.ok && audioPlanOf(getState().project)[0].volume === .4, 'AV clip volume action reaches persisted audio plan');
  actions.setClipVolume(clip.id, 1);
  const right = actions.splitClip(clip.id, clip.start + .8000208333333333);
  avProject = getState().project;
  const resolved = resolveCardAudioRendition(avProject, right, hooks);
  check(Math.abs(resolved.offset - .8000208333333333) * SR <= 1 && audioPlanOf(avProject).length === 2, 'AV split applies media/node source offset exactly once', { offset: resolved.offset });
  const stale = structuredClone(avProject); stale.tracks[0].clips[0].params = { ...stale.tracks[0].clips[0].params, text: 'Changed' };
  let staleError = null; try { audioPlanOf(stale); } catch (error) { staleError = error.message; }
  check(!!staleError, 'AV parameter changes reject stale persisted sound at export', { error: staleError });
  const missing = structuredClone(avProject); missing.media = [];
  let missingError = null; try { audioPlanOf(missing); } catch (error) { missingError = error.message; }
  check(!!missingError, 'missing AV sound rejects export explicitly', { error: missingError });
  await save('audiovisual-project.json', json(avProject));
  report.untested.push('AV rendered pixels and conspicuous timeline mute badge require browser screenshot');
}
