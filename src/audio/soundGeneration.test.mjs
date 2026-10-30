import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const { createNotificationRecipe, createTypingSoundRecipe } = await import("../kernel/soundEffects.ts");
const { createSoundGenerationManager, renderSoundEffectWav, soundEffectReuseDigest, SOUND_JOB_LIMITS } = await import("./soundGeneration.ts");

const recipe = () => createNotificationRecipe({ duration: .04, attack: .001, release: .005 }, { sampleRate: 8000 });
const uploaded = bytes => ({ hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } throw new Error("condition did not become true"); }
const request = (extra = {}) => ({ requestId: "one", targetKey: "clip", recipe: recipe(), isCurrent: () => true, commit: asset => ({ mediaId: asset.hash, clipId: "clip" }), ...extra });

test("WAV uses bounded PCM blocks, exact frames and safe nonzero PCM; reuse digest is not content hash", async () => {
  const r = createTypingSoundRecipe({ text: "中，👨‍👩‍👧‍👦 a", duration: 35 }, {}, { seed: 88, sampleRate: 8000 });
  let maxBlock = 0;
  const wav = await renderSoundEffectWav(r, { yield: () => Promise.resolve() });
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(40, true), r.frames * r.channels * 2);
  assert.equal(wav.length, 44 + r.frames * r.channels * 2);
  assert.ok(wav.subarray(44).some(v => v !== 0));
  const digest = await soundEffectReuseDigest(r);
  assert.match(digest, /^sound-effect-sha256:[a-f0-9]{64}$/);
  assert.notEqual(digest.slice(-64), uploaded(wav).hash);
  assert.deepEqual(wav, await renderSoundEffectWav(r, { yield: () => Promise.resolve() }));
  await renderSoundEffectWav(r, { yield: () => Promise.resolve(), render: (_r, range) => { maxBlock = Math.max(maxBlock, range.count); return new Float32Array(range.count * r.channels); } });
  assert.ok(maxBlock <= 4096);
});

test("successful generation uploads before a single commit; duplicate request joins", async () => {
  const calls = [];
  const manager = createSoundGenerationManager({ yield: () => Promise.resolve(), upload: async bytes => { calls.push("upload"); return uploaded(bytes); } });
  const spec = request({ commit: (_asset, frozen, reuseKey) => { calls.push("commit"); assert.equal(frozen.params.gain, .35); assert.match(reuseKey, /^sound-effect-sha256:/); return { mediaId: "media", clipId: "clip" }; } });
  const first = manager.start(spec);
  const second = manager.start(spec);
  assert.equal(first.id, second.id);
  spec.recipe.params.gain = .1;
  assert.equal((await manager.wait(first.id)).state, "succeeded");
  assert.deepEqual(calls, ["upload", "commit"]);
});

test("upload failure and render failure never commit", async () => {
  let commits = 0;
  const manager = createSoundGenerationManager({ yield: () => Promise.resolve(), upload: async () => { throw new Error("offline"); } });
  const first = manager.start(request({ commit: () => { commits++; return { mediaId: "bad" }; } }));
  const failed = await manager.wait(first.id);
  assert.equal(failed.state, "failed"); assert.match(failed.error, /offline/); assert.equal(commits, 0);
  const bad = createSoundGenerationManager({ render: () => new Float32Array([NaN]), upload: async bytes => uploaded(bytes) });
  assert.equal((await bad.wait(bad.start(request()).id)).state, "failed");
});

test("cancel during upload ignores late transport completion; retry same request can succeed", async () => {
  let release, commits = 0, calls = 0;
  const manager = createSoundGenerationManager({ yield: () => Promise.resolve(), upload: async bytes => {
    calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); return uploaded(bytes);
  } });
  const spec = request({ commit: () => { commits++; return { mediaId: "good" }; } });
  const first = manager.start(spec);
  await until(() => release);
  assert.equal(manager.cancel(first.id).state, "cancelled");
  assert.equal((await manager.wait(first.id)).state, "cancelled");
  const retry = manager.start(spec); release();
  assert.equal((await manager.wait(retry.id)).state, "succeeded");
  assert.equal(commits, 1); assert.equal(manager.get(first.id).state, "cancelled");
});

test("edited targets and superseded requests cannot publish stale bytes", async () => {
  let release, current = true, commits = 0;
  const manager = createSoundGenerationManager({ yield: () => Promise.resolve(), upload: async bytes => {
    if (!release) await new Promise(resolve => { release = resolve; }); return uploaded(bytes);
  } });
  const first = manager.start(request({ isCurrent: () => current, commit: () => { commits++; return { mediaId: "old" }; } }));
  await until(() => release); current = false; release();
  assert.equal((await manager.wait(first.id)).state, "stale"); assert.equal(commits, 0);
  const next = manager.start(request({ requestId: "new" }));
  const latest = manager.start(request({ requestId: "latest", recipe: createNotificationRecipe({ frequency: 440 }) }));
  assert.equal((await manager.wait(next.id)).state, "stale");
  assert.equal((await manager.wait(latest.id)).state, "succeeded");
});

test("queue and terminal history are bounded, cancel queued releases a slot", async () => {
  let release;
  const manager = createSoundGenerationManager({ yield: () => Promise.resolve(), upload: async bytes => { if (!release) await new Promise(resolve => { release = resolve; }); return uploaded(bytes); } });
  const jobs = Array.from({ length: SOUND_JOB_LIMITS.pendingJobs }, (_, i) => manager.start(request({ requestId: `r${i}`, targetKey: `t${i}` })));
  assert.throws(() => manager.start(request({ targetKey: "overflow" })), /队列已满/);
  manager.cancel(jobs.at(-1).id);
  const replacement = manager.start(request({ targetKey: "replacement" }));
  await until(() => release); release();
  await manager.wait(replacement.id);
  for (let i = 0; i < 12; i++) await manager.wait(manager.start(request({ requestId: `history${i}`, targetKey: `history${i}` })).id);
  assert.ok(manager.list().length <= SOUND_JOB_LIMITS.historyJobs);
});

test("finished request rechecks persisted result after undo or a later regeneration", async () => {
  let currentMedia = null, commits = 0;
  const manager = createSoundGenerationManager({ yield: () => Promise.resolve(), upload: async bytes => uploaded(bytes) });
  const make = (id, frequency) => request({ requestId: id, recipe: createNotificationRecipe({ frequency }),
    isResultCurrent: result => currentMedia === result.mediaId,
    commit: asset => { commits++; currentMedia = asset.hash; return { mediaId: asset.hash, clipId: "clip" }; },
  });
  const a = make("a", 440), b = make("b", 880);
  await manager.wait(manager.start(a).id); currentMedia = null;
  await manager.wait(manager.start(a).id); assert.equal(commits, 2, "undo/remove permits recreation");
  await manager.wait(manager.start(b).id); const bMedia = currentMedia;
  await manager.wait(manager.start(a).id);
  await manager.wait(manager.start(b).id);
  assert.equal(commits, 5); assert.equal(currentMedia, bMedia);
});

test("oversized persisted recipes reject before upload rather than triggering whole-project replacement", () => {
  const large = createTypingSoundRecipe({ text: "a".repeat(1000), duration: 10 });
  let uploads = 0;
  const manager = createSoundGenerationManager({ upload: async bytes => { uploads++; return uploaded(bytes); } });
  assert.throws(() => manager.start(request({ recipe: large })), /96 KiB.*拆/);
  assert.equal(manager.list().length, 0); assert.equal(uploads, 0);
});
