import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { SOUND_COST_BLOCK_FRAMES, SOUND_MEASURE_MAX_MS, createMemorySoundCostStore, createSoundJudge, measureSoundBlocks, soundBudgetMs, soundCostStoreKey, soundDeviceString, soundIsHeavy } = await import("./soundCost.ts");
const { createNotificationRecipe, renderSoundEffectBlock } = await import("../kernel/soundEffects.ts");

/**
 * Fake clock: each synthesized chunk advances `cost(i)` ms; yielding the main thread does not
 * advance the clock
 */
function clock(cost) {
  let t = 0, i = 0;
  return { now: () => t, block: () => { t += cost(i++); }, calls: () => i };
}
const noYield = () => Promise.resolve();

test("B1 The budget is 70% of one block's duration; the heavy-classification formula has the same form as for visuals (block time × cost scale > budget)", () => {
  const budget = soundBudgetMs(SOUND_COST_BLOCK_FRAMES, 48000);
  assert.ok(Math.abs(budget - 4096 / 48000 * 1000 * 0.7) < 1e-9);
  assert.ok(Math.abs(budget - 59.7333) < 1e-3);
  const record = (blockMs) => ({ blockMs, blockFrames: 4096, sampleRate: 48000 });
  assert.equal(soundIsHeavy(record(budget - 0.01)), false);
  assert.equal(soundIsHeavy(record(budget)), false, "Equal to the budget does not count as heavy (visuals also use strictly greater)");
  assert.equal(soundIsHeavy(record(budget + 0.01)), true);
  assert.equal(soundIsHeavy(record(budget / 2 + 0.01), { COST_SCALE: 2 }), true, "The cost scale multiplies the measured value");
  assert.equal(soundIsHeavy(record(Number.NaN)), true, "Unmeasurable counts as heavy");
});

test("B2 Measurement takes the 90th percentile, at least 16 blocks; the single maximum is recorded separately and not used in the decision", async () => {
  const c = clock((i) => (i === 3 ? 400 : 2));
  const m = await measureSoundBlocks({ frames: 4096 * 40, sampleRate: 48000, renderBlock: () => c.block(), now: c.now, yield: noYield, maxMs: 10_000 });
  assert.equal(m.samples, 16);
  assert.equal(m.blockMs, 2, "A one-off 400 ms stall does not classify this sound as heavy");
  assert.equal(m.blockMaxMs, 400);
  assert.equal(m.blockFrames, 4096);
  assert.equal(soundIsHeavy(m), false);
});

test("B3 A sound shorter than one block is synthesized at its actual frame count, wraps back to the start to collect enough blocks, and its time is scaled to a full block", async () => {
  const starts = [], c = clock(() => 1);
  const m = await measureSoundBlocks({ frames: 1024, sampleRate: 48000, renderBlock: (start, count) => { starts.push([start, count]); c.block(); }, now: c.now, yield: noYield });
  assert.equal(m.samples, 16);
  assert.ok(starts.every(([start, count]) => start === 0 && count === 1024));
  assert.equal(m.blockMs, 4, "1024 frames take 1 ms, which scales to 4 ms for 4096 frames");
  const longer = [];
  await measureSoundBlocks({ frames: 4096 * 2 + 100, sampleRate: 48000, renderBlock: (start, count) => { longer.push([start, count]); }, now: () => 0, yield: noYield });
  assert.deepEqual(longer.slice(0, 4), [[0, 4096], [4096, 4096], [8192, 100], [0, 4096]]);
});

test("B4 A measurement stops once the accumulated time reaches the cap; with too few samples take the maximum (conservative), and slow ones are classified as heavy", async () => {
  const c = clock(() => 200);
  const m = await measureSoundBlocks({ frames: 4096 * 100, sampleRate: 48000, renderBlock: () => c.block(), now: c.now, yield: noYield });
  assert.equal(SOUND_MEASURE_MAX_MS, 500);
  assert.equal(m.samples, 3, "Stops at 200 + 200 + 200 ≥ 500");
  assert.equal(m.blockMs, 200);
  assert.equal(soundIsHeavy(m), true);
});

test("B5 Measurement makes no sound: no AudioContext, no media element and no playable URL are created, and samples are discarded on the spot", async () => {
  const before = { AudioContext: globalThis.AudioContext, OfflineAudioContext: globalThis.OfflineAudioContext, Audio: globalThis.Audio, create: URL.createObjectURL };
  const touched = [];
  globalThis.AudioContext = class { constructor() { touched.push("AudioContext"); } };
  globalThis.OfflineAudioContext = class { constructor() { touched.push("OfflineAudioContext"); } };
  globalThis.Audio = class { constructor() { touched.push("Audio"); } };
  URL.createObjectURL = () => { touched.push("createObjectURL"); return "blob:x"; };
  try {
    const recipe = createNotificationRecipe({ frequency: 880, duration: 0.3 });
    let energy = 0;
    const m = await measureSoundBlocks({ frames: recipe.frames, sampleRate: recipe.sampleRate, yield: noYield,
      renderBlock: (start, count) => { const pcm = renderSoundEffectBlock(recipe, { start, count }); for (const v of pcm) energy += v * v; return pcm; } });
    assert.ok(energy > 0, "It measures real synthesis (the block has energy), it just isn't sent to any output");
    assert.equal(m.samples, 16);
    assert.deepEqual(touched, []);
    assert.deepEqual(Object.keys(m).sort(), ["blockFrames", "blockMaxMs", "blockMs", "sampleRate", "samples"], "The result has only timings, no samples");
  } finally {
    globalThis.AudioContext = before.AudioContext; globalThis.OfflineAudioContext = before.OfflineAudioContext; globalThis.Audio = before.Audio; URL.createObjectURL = before.create;
  }
});

test("B6 Records are stored by \"sound identity + device string\"; if neither changed, reuse without re-measuring, and re-measure if the device or measuring method changed", async () => {
  const store = createMemorySoundCostStore();
  let device = soundDeviceString({ ua: "UA", cores: 8, mode: "build" });
  let renders = 0;
  const judge = createSoundJudge({ store, device: () => device, yield: noYield, wallClock: () => 1234 });
  const target = (soundKey) => ({ soundKey, kind: "effect", frames: 4096 * 4, sampleRate: 48000, renderBlock: () => { renders++; } });
  const first = await judge.judge(target("effect:a"));
  assert.equal(first.reused, false); assert.equal(first.heavy, false); assert.equal(renders, 16);
  assert.deepEqual(Object.keys(first.record).sort(), ["blockFrames", "blockMaxMs", "blockMs", "device", "kind", "measuredAt", "sampleRate", "samples", "soundKey"]);
  assert.equal(first.record.identityKey, undefined, "Carries no identityKey: when the visuals side reads the cost table it will not treat this as a visuals record");
  assert.deepEqual(await store.getCost(soundCostStoreKey("effect:a", device)), first.record);
  const again = await judge.judge(target("effect:a"));
  assert.equal(again.reused, true); assert.equal(renders, 16, "Identity and device both unchanged: no re-measure");
  await judge.judge(target("effect:b"));
  assert.equal(renders, 32, "Sound identity changed: measured separately");
  device = soundDeviceString({ ua: "UA", cores: 8, mode: "build", tuning: { STEP_PERCENTILE: 1 } });
  assert.match(device, /stepP=1 \| stepN=16$/);
  await judge.judge(target("effect:a"));
  assert.equal(renders, 48, "Measuring method changed: the old record does not hit");
  assert.deepEqual(judge.stats(), { measured: 3, reused: 1, measuring: 0 });
  assert.equal(store.size(), 3);
});

test("B7 The same sound asked about at the same time is measured only once; a stored heavy record is still classified as heavy after reuse", async () => {
  const store = createMemorySoundCostStore(), device = "dev";
  let renders = 0;
  const judge = createSoundJudge({ store, device: () => device, yield: noYield });
  const target = { soundKey: "card:x", kind: "card", frames: 4096 * 20, sampleRate: 48000, renderBlock: async () => { renders++; } };
  const [a, b] = await Promise.all([judge.judge(target), judge.judge(target)]);
  assert.equal(renders, 16); assert.equal(a, b);
  await store.putCost(soundCostStoreKey("card:heavy", device), { soundKey: "card:heavy", kind: "card", device, blockMs: 80, blockMaxMs: 90, blockFrames: 4096, sampleRate: 48000, samples: 16, measuredAt: 1 });
  const heavy = await judge.judge({ ...target, soundKey: "card:heavy" });
  assert.equal(heavy.reused, true); assert.equal(heavy.heavy, true); assert.equal(renders, 16);
});

test("B8 Cancelling a measurement throws AbortError and leaves no record", async () => {
  const store = createMemorySoundCostStore(), abort = new AbortController();
  const judge = createSoundJudge({ store, device: () => "dev", yield: noYield });
  let n = 0;
  await assert.rejects(judge.judge({ soundKey: "effect:c", kind: "effect", frames: 4096 * 20, sampleRate: 48000, renderBlock: () => { if (++n === 3) abort.abort(); } }, abort.signal), { name: "AbortError" });
  assert.equal(store.size(), 0);
});
