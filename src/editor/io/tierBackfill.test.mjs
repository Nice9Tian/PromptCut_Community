/**
 * Page side of C6.6 design doc section 9 item 2: when opening a project, ask editor process to
 * backfill transcoding for videos missing `tiers.small`, and backfill `tiers.small` once done.
 * Run: node --test src/editor/io/tierBackfill.test.mjs
 * `fetch` is replaced with fake editor process: `/api/media/tiers/backfill` and `/api/media/tiers`.
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { backfillSmallTiers, resetTierBackfillForTest, startTierBackfill } = await import(srcUrl("editor/io/mediaUpload.ts"));

const H = (c) => c.repeat(64);

test("C66-I2-03 Open project: videos lacking a small size request a backfill transcode (those without a local original size are not transcoded); ready writes tiers.small immediately, pending is watched until it is done and then written; the same session does not ask twice", async () => {
  resetTierBackfillForTest();
  actions.newProject("Backfill transcode");
  const a = actions.addMedia({ kind: "video", name: "a.mp4", url: `/@media/${H("1")}`, hash: H("1") });
  const b = actions.addMedia({ kind: "video", name: "b.mov", url: `/@media/${H("2")}`, hash: H("2"), tiers: { original: H("2") } });
  const c = actions.addMedia({ kind: "video", name: "c.mp4", url: `/@media/${H("3")}`, hash: H("3") });
  actions.addMedia({ kind: "video", name: "done.mp4", url: `/@media/${H("4")}`, hash: H("4"), tiers: { original: H("4"), small: H("5") } });
  actions.addMedia({ kind: "image", name: "pic.png", url: `/@media/${H("6")}`, hash: H("6") });
  actions.addMedia({ kind: "video", name: "legacy.mp4", url: "/api/media/file?path=x" });
  const realFetch = globalThis.fetch;
  const calls = [];
  let polls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    let body;
    if (u === "/api/media/tiers/backfill") {
      body = { ok: true, items: { [H("1")]: { state: "ready", small: H("a") }, [H("2")]: { state: "pending" }, [H("3")]: { state: "absent" } } };
    } else if (u === `/api/media/tiers?hashes=${H("2")}`) {
      polls++;
      body = { ok: true, items: { [H("2")]: polls < 2 ? { state: "pending" } : { state: "ready", small: H("b") } } };
    } else {
      throw new Error(`Unexpected request ${u}`);
    }
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal(await backfillSmallTiers(), 3);
    const asked = calls.find((x) => x.url === "/api/media/tiers/backfill").body.items.map((i) => i.hash);
    assert.deepEqual(asked, [H("1"), H("2"), H("3")], "Only ask about videos that lack a small size and have a hash; old media that already has a small size, images, or has no hash is not asked about");
    const get = (id) => getState().project.media.find((m) => m.id === id);
    assert.deepEqual(get(a.id).tiers, { original: H("1"), small: H("a") }, "ready: write tiers immediately (old media without tiers gets original filled in)");
    assert.equal(get(c.id).tiers, undefined, "absent: no original size locally, nothing is written");
    const t0 = Date.now();
    while (!get(b.id).tiers?.small && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(get(b.id).tiers, { original: H("2"), small: H("b") }, "pending: ask every 2 s and write once it is ready");
    const n = calls.length;
    assert.equal(await backfillSmallTiers(), 0, "Media already asked about in the same session is not asked again");
    assert.equal(calls.length, n);
  } finally {
    globalThis.fetch = realFetch;
    resetTierBackfillForTest();
  }
});

test("C66-I2-04 No local editor (the request fails): nothing is written, and it will ask again next time", async () => {
  resetTierBackfillForTest();
  actions.newProject("Backfill transcode-offline");
  const a = actions.addMedia({ kind: "video", name: "a.mp4", url: `/@media/${H("7")}`, hash: H("7") });
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError("fetch failed"); };
  try {
    assert.equal(await backfillSmallTiers(), 0);
    assert.equal(getState().project.media.find((m) => m.id === a.id).tiers, undefined);
    await backfillSmallTiers();
    assert.equal(n, 2, "A failed request is not recorded as asked");
  } finally {
    globalThis.fetch = realFetch;
    resetTierBackfillForTest();
  }
});

test("Store backfill in the background after opening a project: an old voiceover with no hash and a URL of /api/media/file?path=… gets its hash via adopt; those that cannot be backfilled are not retried in the background within the same session", async () => {
  resetTierBackfillForTest();
  actions.newProject("Background store backfill");
  const ok = actions.addMedia({ kind: "audio", name: "voice-ok.mp3", url: `/api/media/file?path=${encodeURIComponent("C:/m/voice-ok.mp3")}` });
  const gone = actions.addMedia({ kind: "audio", name: "voice-gone.mp3", url: `/api/media/file?path=${encodeURIComponent("C:/m/voice-gone.mp3")}` });
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("/api/media/adopt")) {
      const p = new URL(u, "http://x").searchParams.get("path");
      asked.push(p);
      if (p.endsWith("voice-ok.mp3")) return Response.json({ ok: true, hash: H("9"), ext: "mp3", name: "voice-ok.mp3", path: "C:/store/x.mp3", url: `/@media/${H("9")}`, bytes: 10 });
      return new Response("ENOENT", { status: 500 });
    }
    return new Response(null, { status: 404 });
  };
  const stop = startTierBackfill();
  try {
    const get = (id) => getState().project.media.find((m) => m.id === id);
    const t0 = Date.now();
    while (!get(ok.id).hash && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(get(ok.id).hash, H("9"));
    assert.equal(get(ok.id).url, `/@media/${H("9")}`);
    assert.equal(get(gone.id).hash, undefined);
    // Backfilling the hash and writing back to asset table triggers another round (after 1.5 s);
    // the background will not try to adopt the one that cannot be backfilled
    const goneTries = () => asked.filter((p) => p.endsWith("voice-gone.mp3")).length;
    const before = goneTries();
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(goneTries(), before, "Those the background cannot backfill are not retried repeatedly in the same session");
  } finally {
    stop();
    globalThis.fetch = realFetch;
    resetTierBackfillForTest();
  }
});
