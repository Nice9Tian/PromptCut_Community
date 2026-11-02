/**
 * Assets when opening projects across machines (`docs/plan/TODO.md` "Media paths when opening
 * projects across machines") on the page side:
 *
 *   MP-M1~M4  Assets with only path and file not found locally: mark "(missing)" after open
 *             (during background store catch-up round); do not mark if found; do not mark if
 *             inconclusive; do not mark in shared projects; remove mark if previously marked but
 *             now found
 *   MP-M5~M6  With hash, but local content store lacks these bytes (.proc saved by another
 *             machine): mark similarly in local projects; remove mark once available;
 *             do not check in shared projects
 *   MP-U1~U4  When project is already "moved to the cloud", assets with backfilled hashes in the
 *             background are handed to the upload queue (images and audio too); those that cannot
 *             be backfilled are listed to the user, listed only once; if not a shared project and
 *             upload target times out, do nothing
 *
 * Run: node --test src/editor/io/mediaPath.test.mjs
 * Replace `fetch` with mock editor process: adopt, read endpoints, upload, enqueue.
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { checkHashedMedia, ingestUnhashedMedia, resetTierBackfillForTest, startTierBackfill } = await import(srcUrl("editor/io/mediaUpload.ts"));
const T = await import(srcUrl("editor/media/assetTiers.ts"));

const H = (c) => c.repeat(64);
const fileUrl = (p) => `/api/media/file?path=${encodeURIComponent(p)}`;
const get = (id) => getState().project.media.find((m) => m.id === id);
const waitFor = async (cond, ms = 6000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); };

/** Mock editor process: paths in `files` can be retrieved (adopt accepts), requests for paths in `throws` fail, all others 404 */
function fakeEditor({ files = {}, throws = [], enqueue = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body && typeof init.body === "string" ? JSON.parse(init.body) : null });
    if (u.startsWith("/api/media/adopt")) {
      const p = new URL(u, "http://x").searchParams.get("path");
      if (throws.includes(p)) throw new TypeError("fetch failed");
      const hit = files[p];
      if (hit) return Response.json({ ok: true, hash: hit, ext: p.split(".").pop(), name: p.split(/[/\\]/).pop(), path: `C:/store/${hit}`, url: `/@media/${hit}`, bytes: 10 });
      return new Response("Media path is outside PromptCut media folders", { status: 403, headers: { "X-PC-Media-Verdict": "outside" } });
    }
    if (u.startsWith("/api/media/file?")) {
      const p = new URL(u, "http://x").searchParams.get("path");
      if (throws.includes(p)) throw new TypeError("fetch failed");
      return new Response("not found", { status: 404 });
    }
    if (u === "/api/media/upload-queue/enqueue" && enqueue) return Response.json({ ok: true, ...enqueue(calls.at(-1).body) });
    if (u.startsWith("/@media/")) return new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }); // Page fallback
    return new Response(null, { status: 404 });
  };
  return { calls, fetchImpl };
}

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; resetTierBackfillForTest(); T.resetAssetTiersForTest(); });
afterEach(() => { globalThis.fetch = realFetch; resetTierBackfillForTest(); T.resetAssetTiersForTest(); });

test("MP-M1 Media with only a path whose file this machine cannot fetch: the background store backfill pass marks it \"(missing)\" (the name gets the marker, a \"confirmed missing\" record is written, URL and path are kept); media that can be fetched is not marked", async () => {
  actions.newProject("Cross-machine");
  const gonePath = "C:\\Users\\admin\\Videos\\PromptCut\\media\\voice-gone.mp3";
  const okPath = "D:/pc/media/voice-ok.mp3";
  const gone = actions.addMedia({ kind: "audio", name: "voice-gone.mp3", path: gonePath, url: fileUrl(gonePath) });
  const ok = actions.addMedia({ kind: "audio", name: "voice-ok.mp3", path: okPath, url: fileUrl(okPath) });
  const hashed = actions.addMedia({ kind: "video", name: "clip.mp4", path: gonePath.replace("voice-gone.mp3", "clip.mp4"), url: `/@media/${H("a")}`, hash: H("a") });
  const before = get(gone.id);
  const ed = fakeEditor({ files: { [okPath]: H("9") } });
  globalThis.fetch = ed.fetchImpl;
  const r = await ingestUnhashedMedia({ background: true, markMissing: true });
  assert.deepEqual(r.ingested, [ok.id]);
  assert.deepEqual(r.failed, [{ id: gone.id, name: "voice-gone.mp3", unreachable: true }]);
  // 0.7.18: no longer clear address; write "confirmed missing" records instead (video, audio, and
  // export show placeholders upon seeing the record, without fetching this address); address stays
  // unchanged after saving and reopening so records match
  assert.equal(get(gone.id).url, fileUrl(gonePath), "The URL is kept");
  assert.equal(get(gone.id).name, "(missing) voice-gone.mp3");
  assert.deepEqual(get(gone.id).missingMaterial, { v: 1, mediaId: gone.id, reason: "confirmed-missing",
    original: { kind: "audio", name: "(missing) voice-gone.mp3", url: fileUrl(gonePath), path: gonePath }, visual: false, audio: true });
  assert.equal(get(ok.id).missingMaterial, undefined);
  assert.equal(get(gone.id).path, gonePath, "path is kept, so switching back to a machine that has the file can still backfill it");
  assert.notEqual(get(gone.id), before, "A new object is written back");
  assert.equal(before.url, fileUrl(gonePath), "The old object was not modified in place");
  assert.equal(get(ok.id).name, "voice-ok.mp3", "Fetchable media is not marked");
  assert.equal(get(ok.id).hash, H("9"));
  assert.equal(get(hashed.id).name, "clip.mp4", "Media with a hash is not checked here");
  // Another round does not add duplicate marks
  await ingestUnhashedMedia({ markMissing: true });
  assert.equal(get(gone.id).name, "(missing) voice-gone.mp3");
});

test("MP-M2 Unclear cases are not marked: the request itself fails (editor process absent), or marking was not requested (the pack and move-to-the-cloud call sites)", async () => {
  actions.newProject("Cross-machine-unclear");
  const p = "C:/m/voice-x.mp3";
  const m = actions.addMedia({ kind: "audio", name: "voice-x.mp3", path: p, url: fileUrl(p) });
  globalThis.fetch = fakeEditor({ throws: [p] }).fetchImpl;
  const r1 = await ingestUnhashedMedia({ markMissing: true });
  assert.deepEqual(r1.failed, [{ id: m.id, name: "voice-x.mp3" }], "Request error: does not count as definitely unfetchable");
  assert.equal(get(m.id).url, fileUrl(p));
  globalThis.fetch = fakeEditor().fetchImpl;
  const r2 = await ingestUnhashedMedia();
  assert.equal(r2.failed[0].unreachable, true);
  assert.equal(get(m.id).name, "voice-x.mp3", "Marking not requested: only report, do not change the project");
});

test("MP-M3 Background check after opening a project: a local project gets \"(missing)\" marks, a shared project does not (hooks.shared)", async () => {
  const p = "C:/other-machine/voice.mp3";
  globalThis.fetch = fakeEditor().fetchImpl;
  // Shared project: do not mark
  actions.newProject("Shared");
  const a = actions.addMedia({ kind: "audio", name: "voice.mp3", path: p, url: fileUrl(p) });
  let seen = null;
  let stop = startTierBackfill({ shared: () => true, afterIngest: (r) => { seen = r; } });
  try {
    await waitFor(() => seen);
    assert.equal(seen.failed[0].unreachable, true);
    assert.equal(get(a.id).url, fileUrl(p), "Shared project: the project is not changed");
    assert.equal(get(a.id).name, "voice.mp3");
    assert.equal(get(a.id).missingMaterial, undefined, "Shared project: does not declare media missing");
  } finally { stop(); }
  // Local project: mark
  resetTierBackfillForTest();
  actions.newProject("Local");
  const b = actions.addMedia({ kind: "audio", name: "voice.mp3", path: p, url: fileUrl(p) });
  seen = null;
  stop = startTierBackfill({ shared: () => false, afterIngest: (r) => { seen = r; } });
  try {
    await waitFor(() => seen);
    assert.equal(get(b.id).url, fileUrl(p));
    assert.equal(get(b.id).name, "(missing) voice.mp3");
    assert.equal(get(b.id).missingMaterial?.reason, "confirmed-missing");
  } finally { stop(); }
});

test("MP-M4 Previously marked \"(missing)\" on another machine but fetchable on this one: backfill the hash and remove the mark", async () => {
  actions.newProject("Back on original machine");
  const p = "D:/pc/media/voice-back.mp3";
  const m = actions.addMedia({ kind: "audio", name: "(missing) voice-back.mp3", path: p, url: fileUrl(p) });
  globalThis.fetch = fakeEditor({ files: { [p]: H("7") } }).fetchImpl;
  const r = await ingestUnhashedMedia({ background: true, markMissing: true });
  assert.deepEqual(r.ingested, [m.id]);
  assert.equal(get(m.id).hash, H("7"));
  assert.equal(get(m.id).url, `/@media/${H("7")}`);
  assert.equal(get(m.id).name, "voice-back.mp3");
});

test("MP-M5 Media with a hash whose bytes are not in the local content store gets \"(missing)\" (the hash is kept); media whose bytes are there is not marked; nothing changes when no answer is available", async () => {
  actions.newProject("With hash");
  const have = actions.addMedia({ kind: "video", name: "have.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "C:/A/out/media/x.mp4" });
  const lack = actions.addMedia({ kind: "audio", name: "lack.mp3", url: `/@media/${H("b")}`, hash: H("b"), path: "C:/A/out/media/y.mp3" });
  const tiered = actions.addMedia({ kind: "video", name: "tiered.mp4", url: `/@media/${H("c")}`, hash: H("c"), tiers: { original: H("c"), small: H("d") } });
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("/api/media/local?")) {
      asked.push(new URL(u, "http://x").searchParams.get("hashes").split(","));
      return Response.json({ ok: true, hashes: [H("a"), H("c")] });
    }
    // If not in content store, search by original path again (0.7.18):
    // here original path is also explicitly missing (404)
    if (u.startsWith("/api/media/adopt?")) return new Response("Not found", { status: 404 });
    throw new Error(`Unexpected request ${u}`);
  };
  const r = await checkHashedMedia();
  assert.deepEqual(asked, [[H("a"), H("b"), H("c")]]);
  assert.deepEqual(r, { missing: [lack.id], restored: [] });
  assert.equal(get(lack.id).url, `/@media/${H("b")}`, "The URL keeps the hash-based one");
  assert.equal(get(lack.id).name, "(missing) lack.mp3");
  assert.deepEqual(get(lack.id).missingMaterial, { v: 1, mediaId: lack.id, reason: "confirmed-missing",
    original: { kind: "audio", name: "(missing) lack.mp3", url: `/@media/${H("b")}`, hash: H("b"), path: "C:/A/out/media/y.mp3" }, visual: false, audio: true });
  assert.equal(get(have.id).missingMaterial, undefined);
  assert.equal(get(lack.id).hash, H("b"), "The hash is kept: next time it is opened, it is still looked up by hash");
  assert.equal(get(have.id).url, `/@media/${H("a")}`);
  assert.equal(get(tiered.id).name, "tiered.mp4");
  // Remembered what exists: next round only asks for the missing one;
  // already marked items are not marked again
  const r2 = await checkHashedMedia();
  assert.deepEqual(asked[1], [H("b")]);
  assert.deepEqual(r2, { missing: [], restored: [] });
  // Editor process absent: do not modify
  actions.newProject("With hash-offline");
  const off = actions.addMedia({ kind: "audio", name: "off.mp3", url: `/@media/${H("e")}`, hash: H("e") });
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await checkHashedMedia(), { missing: [], restored: [] });
  assert.equal(get(off.id).url, `/@media/${H("e")}`);
});

test("MP-M6 Media with a hash that was marked \"(missing)\": once it is in the content store, remove the mark and switch back to the hash-based URL; the background check does not judge hashed media in a shared project", async () => {
  actions.newProject("With hash-back");
  const m = actions.addMedia({ kind: "audio", name: "(missing) back.mp3", url: "", hash: H("f") });
  globalThis.fetch = async (url) => String(url).startsWith("/api/media/local?") ? Response.json({ ok: true, hashes: [H("f")] }) : new Response(null, { status: 404 });
  assert.deepEqual(await checkHashedMedia(), { missing: [], restored: [m.id] });
  assert.equal(get(m.id).name, "back.mp3");
  assert.equal(get(m.id).url, `/@media/${H("f")}`);
  assert.equal(get(m.id).missingMaterial, undefined);
  // Shared project: background check does not query /api/media/local
  resetTierBackfillForTest();
  actions.newProject("Shared-with hash");
  const s = actions.addMedia({ kind: "audio", name: "remote.mp3", url: `/@media/${H("9")}`, hash: H("9") });
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return String(url).startsWith("/api/media/local?") ? Response.json({ ok: true, hashes: [] }) : new Response(null, { status: 404 }); };
  let seen = null;
  const stop = startTierBackfill({ shared: () => true, afterIngest: (r) => { seen = r; } });
  try {
    await waitFor(() => seen);
    assert.ok(!urls.some((u) => u.startsWith("/api/media/local?")), "Not judged in a shared project");
    assert.equal(get(s.id).url, `/@media/${H("9")}`);
  } finally { stop(); }
  // Local project: background check will evaluate
  resetTierBackfillForTest();
  actions.newProject("Local-with hash");
  const l = actions.addMedia({ kind: "audio", name: "gone.mp3", url: `/@media/${H("8")}`, hash: H("8") });
  seen = null;
  const stop2 = startTierBackfill({ shared: () => false, afterIngest: (r) => { seen = r; } });
  try {
    await waitFor(() => seen);
    assert.equal(get(l.id).name, "(missing) gone.mp3");
  } finally { stop2(); }
});

// In old projects (saved with the Chinese UI), the tag was "(missing) " (in Chinese); current code
// only recognizes the one written by tr("(missing) ") and does not recognize the old tag.
test("MP-M4b the Chinese marker \"(缺失) \" from old projects can be removed too", async () => {
  actions.newProject("回到原机器-老标记");
  const p = "D:/pc/media/voice-back.mp3";
  const m = actions.addMedia({ kind: "audio", name: "(missing) voice-back.mp3", path: p, url: fileUrl(p) });
  globalThis.fetch = fakeEditor({ files: { [p]: H("7") } }).fetchImpl;
  await ingestUnhashedMedia({ background: true, markMissing: true });
  assert.equal(get(m.id).name, "voice-back.mp3");
});

test("MP-M6b the Chinese marker \"(缺失) \" from old projects is also removed once hashed media is found again", async () => {
  actions.newProject("带哈希-回来-老标记");
  const m = actions.addMedia({ kind: "audio", name: "(missing) back.mp3", url: "", hash: H("f") });
  globalThis.fetch = async (url) => String(url).startsWith("/api/media/local?") ? Response.json({ ok: true, hashes: [H("f")] }) : new Response(null, { status: 404 });
  await checkHashedMedia();
  assert.equal(get(m.id).name, "back.mp3");
});

/** Make "editor process gets upload target with rw ticket" hold true (same as EQE-2 in enqueueExisting.test.mjs) */
function readyUploadTarget() {
  const link = { request: async () => ({ type: "auth.ticket.ok", ticket: "rw-1", exp: Date.now() + 15 * 60_000 }) };
  return T.startUploadTarget(link, "http://cloud/api/asset", { post: async () => {}, setTimer: () => 0, clearTimer: () => {} });
}

test("MP-U1 Media that only gets its hash in the background after moving to the cloud enters the upload queue (both audio and video are submitted); media that cannot be backfilled is listed to the user", async () => {
  actions.newProject("Move to the cloud");
  const voicePath = "D:/pc/media/voice-old.mp3";
  const vidPath = "D:/pc/media/old.mp4";
  const gonePath = "C:/elsewhere/voice-gone.mp3";
  const voice = actions.addMedia({ kind: "audio", name: "voice-old.mp3", path: voicePath, url: fileUrl(voicePath) });
  const vid = actions.addMedia({ kind: "video", name: "old.mp4", path: vidPath, url: fileUrl(vidPath) });
  actions.addMedia({ kind: "audio", name: "voice-gone.mp3", path: gonePath, url: fileUrl(gonePath) });
  actions.addMedia({ kind: "image", name: "already.png", url: `/@media/${H("c")}`, hash: H("c") });
  const ed = fakeEditor({ files: { [voicePath]: H("1"), [vidPath]: H("2") }, enqueue: (body) => ({ queued: body.items.map((i) => i.original), missing: [] }) });
  globalThis.fetch = ed.fetchImpl;
  const stopTarget = readyUploadTarget();
  const notified = [];
  const hooks = {
    shared: () => true,
    afterIngest: (r) => T.queueBackfilledMedia(r, getState().project.media, {
      post: async (body) => { const res = await fetch("/api/media/upload-queue/enqueue", { method: "POST", body: JSON.stringify(body) }); const j = await res.json(); return { queued: j.queued, missing: j.missing }; },
      shared: () => true,
      notify: (names) => notified.push(names),
      timeoutMs: 2000,
    }),
  };
  const stop = startTierBackfill(hooks);
  try {
    await waitFor(() => ed.calls.some((c) => c.url === "/api/media/upload-queue/enqueue") && notified.length);
    const enq = ed.calls.filter((c) => c.url === "/api/media/upload-queue/enqueue");
    assert.equal(enq.length, 1);
    assert.deepEqual(enq[0].body, { items: [{ name: "voice-old.mp3", original: H("1") }, { name: "old.mp4", original: H("2") }] },
      "Only submit the ones that got a hash this time (audio too; those that already had a hash are not resubmitted here)");
    assert.equal(get(voice.id).hash, H("1"));
    assert.equal(get(vid.id).hash, H("2"));
    assert.deepEqual(notified, [["voice-gone.mp3"]], "Media that cannot be backfilled is listed to the user");
  } finally { stop(); stopTarget(); }
});

test("MP-U2 The same media that cannot be backfilled is listed only once per session; media the upload queue reports as missing is listed by name", async () => {
  const media = [
    { id: "a", name: "a.mp3", hash: H("a") },
    { id: "b", name: "b.png", hash: H("b") },
  ];
  const stopTarget = readyUploadTarget();
  const notified = [];
  const bodies = [];
  const deps = {
    post: async (body) => { bodies.push(body); return { queued: [H("a")], missing: [H("b")] }; },
    shared: () => true,
    notify: (names) => notified.push(names),
    timeoutMs: 2000,
  };
  try {
    const r = await T.queueBackfilledMedia({ ingested: ["a", "b"], failed: [{ id: "g", name: "(missing) gone.mp3" }] }, media, deps);
    assert.deepEqual(r.queued, [H("a")]);
    assert.deepEqual(notified, [["(missing) gone.mp3", "b.png"]]);
    // Same failure for another round (background check re-triggered by asset table change):
    // no longer list, nor wait for upload target
    assert.equal(await T.queueBackfilledMedia({ ingested: [], failed: [{ id: "g", name: "(missing) gone.mp3" }] }, media, deps), null);
    assert.equal(notified.length, 1);
    assert.equal(bodies.length, 1);
  } finally { stopTarget(); }
});

test("MP-U3 Not a shared project, or no enqueue hook: do nothing", async () => {
  const bodies = [];
  const post = async (b) => { bodies.push(b); return { queued: [], missing: [] }; };
  const r = { ingested: ["a"], failed: [{ id: "g", name: "g" }] };
  const media = [{ id: "a", name: "a", hash: H("a") }];
  const notified = [];
  assert.equal(await T.queueBackfilledMedia(r, media, { post, shared: () => false, notify: (n) => notified.push(n), timeoutMs: 50 }), null);
  assert.equal(await T.queueBackfilledMedia(r, media, { post: null, shared: () => true, notify: (n) => notified.push(n), timeoutMs: 50 }), null);
  assert.equal(bodies.length, 0);
  assert.equal(notified.length, 0);
});

test("MP-U4 Shared project but no upload target is available (this machine is the host, no rw ticket can be issued): do not enqueue, show no notice", async () => {
  const bodies = [];
  const notified = [];
  const r = await T.queueBackfilledMedia({ ingested: ["a"], failed: [{ id: "g", name: "g" }] }, [{ id: "a", name: "a", hash: H("a") }], {
    post: async (b) => { bodies.push(b); return { queued: [], missing: [] }; },
    shared: () => true,
    notify: (n) => notified.push(n),
    timeoutMs: 50,
  });
  assert.equal(r, null);
  assert.equal(bodies.length, 0);
  assert.equal(notified.length, 0);
});
