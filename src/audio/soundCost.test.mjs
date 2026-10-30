import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { SOUND_COST_BLOCK_FRAMES, SOUND_MEASURE_MAX_MS, createMemorySoundCostStore, createSoundJudge, measureSoundBlocks, soundBudgetMs, soundCostStoreKey, soundDeviceString, soundIsHeavy } = await import("./soundCost.ts");
const { createNotificationRecipe, renderSoundEffectBlock } = await import("../kernel/soundEffects.ts");

/** 假时钟:每合成一块走 `cost(i)` 毫秒;让出主线程的时间不走表 */
function clock(cost) {
  let t = 0, i = 0;
  return { now: () => t, block: () => { t += cost(i++); }, calls: () => i };
}
const noYield = () => Promise.resolve();

test("B1 预算是一块时长的七成,判重式与画面同形(块耗时 × 成本倍率 > 预算)", () => {
  const budget = soundBudgetMs(SOUND_COST_BLOCK_FRAMES, 48000);
  assert.ok(Math.abs(budget - 4096 / 48000 * 1000 * 0.7) < 1e-9);
  assert.ok(Math.abs(budget - 59.7333) < 1e-3);
  const record = (blockMs) => ({ blockMs, blockFrames: 4096, sampleRate: 48000 });
  assert.equal(soundIsHeavy(record(budget - 0.01)), false);
  assert.equal(soundIsHeavy(record(budget)), false, "等于预算不算重(画面也是严格大于)");
  assert.equal(soundIsHeavy(record(budget + 0.01)), true);
  assert.equal(soundIsHeavy(record(budget / 2 + 0.01), { COST_SCALE: 2 }), true, "成本倍率乘在实测值上");
  assert.equal(soundIsHeavy(record(Number.NaN)), true, "量不出来按重");
});

test("B2 测量取第 90 百分位、至少 16 块;单次最大另记,不进判定", async () => {
  const c = clock((i) => (i === 3 ? 400 : 2));
  const m = await measureSoundBlocks({ frames: 4096 * 40, sampleRate: 48000, renderBlock: () => c.block(), now: c.now, yield: noYield, maxMs: 10_000 });
  assert.equal(m.samples, 16);
  assert.equal(m.blockMs, 2, "一次 400 ms 的偶发卡顿不把这段声音判重");
  assert.equal(m.blockMaxMs, 400);
  assert.equal(m.blockFrames, 4096);
  assert.equal(soundIsHeavy(m), false);
});

test("B3 不足一块的声音按实际帧数合成、绕回开头采够块数,耗时折算到一整块", async () => {
  const starts = [], c = clock(() => 1);
  const m = await measureSoundBlocks({ frames: 1024, sampleRate: 48000, renderBlock: (start, count) => { starts.push([start, count]); c.block(); }, now: c.now, yield: noYield });
  assert.equal(m.samples, 16);
  assert.ok(starts.every(([start, count]) => start === 0 && count === 1024));
  assert.equal(m.blockMs, 4, "1024 帧花 1 ms,折算到 4096 帧是 4 ms");
  const longer = [];
  await measureSoundBlocks({ frames: 4096 * 2 + 100, sampleRate: 48000, renderBlock: (start, count) => { longer.push([start, count]); }, now: () => 0, yield: noYield });
  assert.deepEqual(longer.slice(0, 4), [[0, 4096], [4096, 4096], [8192, 100], [0, 4096]]);
});

test("B4 一次测量累计到封顶就停;样本不足时取最大值(偏保守),慢的判重", async () => {
  const c = clock(() => 200);
  const m = await measureSoundBlocks({ frames: 4096 * 100, sampleRate: 48000, renderBlock: () => c.block(), now: c.now, yield: noYield });
  assert.equal(SOUND_MEASURE_MAX_MS, 500);
  assert.equal(m.samples, 3, "200 + 200 + 200 ≥ 500 就停");
  assert.equal(m.blockMs, 200);
  assert.equal(soundIsHeavy(m), true);
});

test("B5 测量不出声:不建 AudioContext、不建媒体元素、不建可播放地址,采样当场丢掉", async () => {
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
    assert.ok(energy > 0, "测的是真合成(块里有能量),只是不送去任何输出");
    assert.equal(m.samples, 16);
    assert.deepEqual(touched, []);
    assert.deepEqual(Object.keys(m).sort(), ["blockFrames", "blockMaxMs", "blockMs", "sampleRate", "samples"], "结果里只有耗时,没有采样");
  } finally {
    globalThis.AudioContext = before.AudioContext; globalThis.OfflineAudioContext = before.OfflineAudioContext; globalThis.Audio = before.Audio; URL.createObjectURL = before.create;
  }
});

test("B6 记录按「声音身份 + 设备串」存;都没变就复用不重测,设备或量法变了重测", async () => {
  const store = createMemorySoundCostStore();
  let device = soundDeviceString({ ua: "UA", cores: 8, mode: "build" });
  let renders = 0;
  const judge = createSoundJudge({ store, device: () => device, yield: noYield, wallClock: () => 1234 });
  const target = (soundKey) => ({ soundKey, kind: "effect", frames: 4096 * 4, sampleRate: 48000, renderBlock: () => { renders++; } });
  const first = await judge.judge(target("effect:a"));
  assert.equal(first.reused, false); assert.equal(first.heavy, false); assert.equal(renders, 16);
  assert.deepEqual(Object.keys(first.record).sort(), ["blockFrames", "blockMaxMs", "blockMs", "device", "kind", "measuredAt", "sampleRate", "samples", "soundKey"]);
  assert.equal(first.record.identityKey, undefined, "不带 identityKey:画面那一侧读成本表时不会把它当成画面的记录");
  assert.deepEqual(await store.getCost(soundCostStoreKey("effect:a", device)), first.record);
  const again = await judge.judge(target("effect:a"));
  assert.equal(again.reused, true); assert.equal(renders, 16, "身份与设备都没变:不重测");
  await judge.judge(target("effect:b"));
  assert.equal(renders, 32, "换了声音身份:另测");
  device = soundDeviceString({ ua: "UA", cores: 8, mode: "build", tuning: { STEP_PERCENTILE: 1 } });
  assert.match(device, /stepP=1 \| stepN=16$/);
  await judge.judge(target("effect:a"));
  assert.equal(renders, 48, "量法变了:旧记录不命中");
  assert.deepEqual(judge.stats(), { measured: 3, reused: 1, measuring: 0 });
  assert.equal(store.size(), 3);
});

test("B7 同一段声音同时被问到只测一次;存下的重记录复用后仍判重", async () => {
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

test("B8 取消测量抛 AbortError,不留记录", async () => {
  const store = createMemorySoundCostStore(), abort = new AbortController();
  const judge = createSoundJudge({ store, device: () => "dev", yield: noYield });
  let n = 0;
  await assert.rejects(judge.judge({ soundKey: "effect:c", kind: "effect", frames: 4096 * 20, sampleRate: 48000, renderBlock: () => { if (++n === 3) abort.abort(); } }, abort.signal), { name: "AbortError" });
  assert.equal(store.size(), 0);
});
