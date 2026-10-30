import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { renderSoundEffectWavInWorker } = await import("./soundGenerationWorkerClient.ts");
const { createNotificationRecipe } = await import("../kernel/soundEffects.ts");

test("browser worker cancellation terminates in-flight CPU work and late reply cannot succeed", async () => {
  const original = globalThis.Worker;
  let worker;
  globalThis.Worker = class {
    constructor(url, options) { worker = this; this.url = String(url); assert.equal(options.type, "module"); }
    postMessage(recipe) { this.recipe = recipe; }
    terminate() { this.terminated = true; }
  };
  try {
    const abort = new AbortController();
    const result = renderSoundEffectWavInWorker(createNotificationRecipe(), { signal: abort.signal });
    assert.match(worker.url, /soundGenerationWorker\.ts$/); assert.ok(worker.recipe);
    abort.abort();
    await assert.rejects(result, { name: "AbortError" }); assert.equal(worker.terminated, true);
    worker.onmessage({ data: { wav: new ArrayBuffer(44) } });
    await assert.rejects(result, { name: "AbortError" });
  } finally { globalThis.Worker = original; }
});

test("browser worker transfers WAV and terminates after success or error", async () => {
  const original = globalThis.Worker;
  let worker;
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage() {}
    terminate() { this.terminated = true; }
  };
  try {
    let progress = 0;
    const result = renderSoundEffectWavInWorker(createNotificationRecipe(), { progress: x => { progress = x; } });
    worker.onmessage({ data: { progress: .5 } }); assert.equal(progress, .5);
    worker.onmessage({ data: { wav: new ArrayBuffer(44) } });
    assert.equal((await result).length, 44); assert.equal(worker.terminated, true);
    const failed = renderSoundEffectWavInWorker(createNotificationRecipe());
    worker.onerror({ message: "worker blocked" });
    await assert.rejects(failed, /worker blocked/); assert.equal(worker.terminated, true);
  } finally { globalThis.Worker = original; }
});
