/**
 * When enabling "Move to the cloud", page hands existing assets in project to upload queue
 * (C10a integration rework, `enqueueExistingMedia` in `assetTiers.ts`).
 * Run: node --test src/editor/media/enqueueExisting.test.mjs
 */
import "../../testing/registerTs.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

const T = await import("./assetTiers.ts");
const h = (c) => c.repeat(64);
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
beforeEach(() => T.resetAssetTiersForTest());

test("EQE-1 request body: one entry per asset, two tiers for video and one tier for images and audio; assets without a hash do not count; the original size of the same asset is listed only once", () => {
  const { items } = T.existingMediaItems([
    { name: "v.mp4", hash: h("a"), tiers: { original: h("a"), small: h("b") } },
    { name: "i.png", hash: h("c") },
    { name: "s.m4a", hash: h("d"), tiers: { original: h("d") } },
    { name: "old.mp4", hash: "" },
    { name: "dup.mp4", hash: h("a"), tiers: { original: h("a"), small: h("b") } },
  ]);
  assert.deepEqual(items, [
    { name: "v.mp4", original: h("a"), small: h("b") },
    { name: "i.png", original: h("c") },
    { name: "s.m4a", original: h("d") },
  ]);
});

test("EQE-2 enqueue only after the editor process has obtained an upload target carrying an rw ticket", async () => {
  const bodies = [];
  const link = { request: async () => ({ type: "auth.ticket.ok", ticket: "rw-1", exp: Date.now() + 15 * 60_000 }) };
  const pending = T.enqueueExistingMedia([{ name: "v", hash: h("a"), tiers: { original: h("a"), small: h("b") } }], {
    post: async (b) => { bodies.push(b); return { queued: [h("a")], missing: [] }; },
    timeoutMs: 5_000,
  });
  await flush();
  assert.equal(bodies.length, 0, "Upload target not set yet: do not send");
  const targets = [];
  const stop = T.startUploadTarget(link, "http://h/api/asset", { post: async (b) => { targets.push(b); }, setTimer: () => 0, clearTimer: () => {} });
  const r = await pending;
  assert.deepEqual(targets, [{ base: "http://h/api/asset", ticket: "rw-1" }]);
  assert.deepEqual(bodies, [{ items: [{ name: "v", original: h("a"), small: h("b") }] }]);
  assert.deepEqual(r, { queued: [h("a")], missing: [], skipped: [] });
  stop();
});

test("EQE-3 if the upload target never arrives (cannot get an rw ticket), do not enqueue and return null; with no assets, return empty directly", async () => {
  const bodies = [];
  const link = { request: async () => ({ type: "error", reason: "forbidden" }) };
  const stop = T.startUploadTarget(link, "http://h/api/asset", { post: async () => {}, setTimer: () => 0, clearTimer: () => {} });
  const r = await T.enqueueExistingMedia([{ hash: h("a") }], { post: async (b) => { bodies.push(b); return null; }, timeoutMs: 50 });
  assert.equal(r, null);
  assert.equal(bodies.length, 0);
  assert.deepEqual(await T.enqueueExistingMedia([], { post: async () => null, timeoutMs: 50 }), { queued: [], missing: [], skipped: [] });
  assert.equal(await T.enqueueExistingMedia([{ hash: h("a") }], { post: null }), null, "No enqueue entry point (online build): do nothing");
  stop();
});

test("EQE-4 gatekeeper: assets without a hash must not be skipped silently: they appear in skipped (those still importing are marked pending), and the enqueue result carries them too", async () => {
  const media = [
    { id: "v", name: "v.mp4", hash: h("a") },
    { id: "old", name: "voice-old.mp3", hash: "" },
    { id: "bad", name: "bad.mp3", hash: "xyz" },
    { id: "up", name: "uploading.mp3", pending: true },
  ];
  const { items, skipped } = T.existingMediaItems(media);
  assert.deepEqual(items, [{ name: "v.mp4", original: h("a") }]);
  assert.deepEqual(skipped, [
    { id: "old", name: "voice-old.mp3" },
    { id: "bad", name: "bad.mp3" },
    { id: "up", name: "uploading.mp3", pending: true },
  ]);
  // Only items without hashes: returns empty queue + skipped directly without waiting for upload
  // target
  const onlyOld = await T.enqueueExistingMedia([media[1]], { post: async () => { throw new Error("Should not be sent"); }, timeoutMs: 50 });
  assert.deepEqual(onlyOld, { queued: [], missing: [], skipped: [{ id: "old", name: "voice-old.mp3" }] });
  // There are enqueueable items: after sending, the result still includes skipped
  const link = { request: async () => ({ type: "auth.ticket.ok", ticket: "rw-1", exp: Date.now() + 15 * 60_000 }) };
  const stop = T.startUploadTarget(link, "http://h/api/asset", { post: async () => {}, setTimer: () => 0, clearTimer: () => {} });
  const r = await T.enqueueExistingMedia(media, { post: async () => ({ queued: [h("a")], missing: [] }), timeoutMs: 5_000 });
  assert.deepEqual(r.skipped.map((x) => x.id), ["old", "bad", "up"]);
  stop();
});
