/**
 * Timing gap when moving to the cloud (`docs/reports/AGENT-upload-timing.md`): for assets imported
 * after opening a shared project and before the editor process gets the upload target (address and
 * rw ticket of the remote asset service), the upload queue in the editor process sees a local
 * target and drops them as a no-op. The page side records them first, and submits them to the
 * upload queue by hash once the upload target is ready (the same path as enqueuing after background
 * backfills hashes).
 *
 *   UT-1  Assets imported before upload target is ready are recorded first and submitted once ready
 *         (images, audio, video all submitted; video with both tiers)
 *   UT-2  Imported when upload target is already ready: submitted immediately by hash (duplicating
 *         server prepareImport enqueue is harmless; queue deduplicates by asset)
 *   UT-3  Not a shared project: do nothing; leaving shared project before ready: discard recorded
 *         items, do not submit to another project
 *   UT-4  This machine is the host (no remote asset service found): do not record; keep failed
 *         submissions and resubmit upon next ready (renewal)
 *   UT-5  Missing from local content store during resubmission (queue returns missing): list to user
 *
 * Run: node --test src/editor/io/uploadTiming.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { applyUploadedMedia, resetTierBackfillForTest, startTierBackfill } = await import(srcUrl("editor/io/mediaUpload.ts"));
const T = await import(srcUrl("editor/media/assetTiers.ts"));

const H = (c) => c.repeat(64);
const flush = () => new Promise((r) => setTimeout(r, 20));
const waitFor = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); };

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  // These endpoints in the page all hit the editor process; unit tests return 404 across the board
  // to prevent real fetch requests going out
  globalThis.fetch = async () => new Response(null, { status: 404 });
  resetTierBackfillForTest();
  T.resetAssetTiersForTest();
});
afterEach(() => { globalThis.fetch = realFetch; resetTierBackfillForTest(); T.resetAssetTiersForTest(); });

/**
 * Controllable upload target: `link.request` waits for `release()` before issuing a ticket,
 * simulating delay in issuing rw ticket after opening a shared project. Returns
 * { stop, release, renew }: `renew()` triggers next renewal (holding timer in hand).
 */
function slowUploadTarget(base = "http://cloud/api/asset") {
  let open;
  let gate = new Promise((r) => { open = r; });
  let pendingTimer = null;
  const link = { request: async () => { await gate; return { type: "auth.ticket.ok", ticket: "rw-1", exp: Date.now() + 15 * 60_000 }; } };
  const stop = T.startUploadTarget(link, base, {
    post: async () => {},
    setTimer: (fn) => { pendingTimer = fn; return 1; },
    clearTimer: () => { pendingTimer = null; },
  });
  return {
    stop,
    release: () => open(),
    renew: () => { const fn = pendingTimer; pendingTimer = null; fn?.(); },
    link,
  };
}

/**
 * Page finishes importing an asset: addMedia(pending) → store response → applyUploadedMedia
 * (junction of all import paths)
 */
function importOne({ kind, name, hash, small }) {
  const m = actions.addMedia({ kind, name, url: "", pending: true });
  applyUploadedMedia(m.id, {
    hash, ext: name.split(".").pop(), name, url: `/@media/${hash}`, bytes: 10,
    ...(kind === "video" ? { tiers: { original: hash, small: small ?? null }, smallState: small ? "ready" : "none" } : {}),
  });
  return m.id;
}

function sharedHooks({ shared = () => true, respond = (body) => ({ queued: body.items.map((i) => i.original), missing: [] }) } = {}) {
  const bodies = [];
  const notified = [];
  const deps = {
    post: async (body) => { bodies.push(body); return respond(body); },
    shared,
    notify: (names) => notified.push(names),
  };
  const hooks = { shared, afterImport: (media) => T.queueImportedMedia(media, deps) };
  return { bodies, notified, deps, hooks };
}

test("UT-1 Media imported before the upload target is ready is recorded first and handed to the upload queue once it is ready (images, audio and video are all handed over)", async () => {
  actions.newProject("Cloud project");
  const target = slowUploadTarget();
  const { bodies, hooks } = sharedHooks();
  const stop = startTierBackfill(hooks);
  try {
    importOne({ kind: "image", name: "still.png", hash: H("1") });
    importOne({ kind: "audio", name: "voice.mp3", hash: H("2") });
    importOne({ kind: "video", name: "clip.mp4", hash: H("3"), small: H("4") });
    await flush();
    assert.equal(bodies.length, 0, "The upload target is not ready yet: do not hand over for now (if handed over, the editor process would treat it as a local target and drop it)");
    target.release();
    await waitFor(() => bodies.length > 0);
    assert.equal(bodies.length, 1, "Handed over once when ready");
    assert.deepEqual(bodies[0], { items: [
      { name: "still.png", original: H("1") },
      { name: "voice.mp3", original: H("2") },
      { name: "clip.mp4", original: H("3"), small: H("4") },
    ] });
    // Renewal pushes upload target again: do not resubmit what has already been submitted
    target.renew();
    await flush();
    assert.equal(bodies.length, 1);
  } finally { stop(); target.stop(); }
});

test("UT-2 Media imported when the upload target is already ready: handed over once by hash immediately", async () => {
  actions.newProject("Cloud project");
  const target = slowUploadTarget();
  target.release();
  await waitFor(() => T.uploadTargetReadyForTest() !== null);
  const { bodies, hooks } = sharedHooks();
  const stop = startTierBackfill(hooks);
  try {
    importOne({ kind: "audio", name: "late.mp3", hash: H("5") });
    await waitFor(() => bodies.length > 0);
    assert.deepEqual(bodies, [{ items: [{ name: "late.mp3", original: H("5") }] }]);
  } finally { stop(); target.stop(); }
});

test("UT-3 Not a shared project: do nothing; leaving a shared project before it is ready: the recorded items are dropped", async () => {
  actions.newProject("Local project");
  {
    const { bodies, hooks } = sharedHooks({ shared: () => false });
    const stop = startTierBackfill(hooks);
    importOne({ kind: "image", name: "local.png", hash: H("6") });
    const target = slowUploadTarget();
    target.release();
    await waitFor(() => T.uploadTargetReadyForTest() !== null);
    await flush();
    assert.equal(bodies.length, 0, "Media of a local project is not handed over");
    stop(); target.stop();
  }
  T.resetAssetTiersForTest();
  {
    const target = slowUploadTarget();
    const { bodies, hooks } = sharedHooks();
    const stop = startTierBackfill(hooks);
    importOne({ kind: "image", name: "left-behind.png", hash: H("7") });
    // Leave shared project (syncManager → disconnectSharedAssets): upload target returns to this machine
    target.stop();
    T.disconnectSharedAssets();
    // Later entered another shared project and target is ready: items recorded in previous project
    // are not submitted
    const next = slowUploadTarget("http://other/api/asset");
    next.release();
    await waitFor(() => T.uploadTargetReadyForTest() !== null);
    await flush();
    assert.equal(bodies.length, 0, "Items recorded before leaving are dropped");
    stop(); next.stop(); target.release();
  }
});

test("UT-4 This machine is the host: nothing is recorded; items whose hand-over failed are kept and handed over again the next time it is ready (ticket renewal)", async () => {
  actions.newProject("Cloud project");
  {
    // This machine is the host: no remote asset service found, startUploadTarget(link, null)
    const link = { request: async () => ({ type: "auth.ticket.ok", ticket: "rw", exp: Date.now() + 60_000 }) };
    const stopLocal = T.startUploadTarget(link, null, { post: async () => {} });
    const { bodies, hooks } = sharedHooks();
    const stop = startTierBackfill(hooks);
    importOne({ kind: "image", name: "host.png", hash: H("8") });
    assert.equal(T.deferredImportsForTest().length, 0, "This machine is the host: importing writes straight into this project's asset service, so there is nothing to record");
    assert.equal(bodies.length, 0);
    stop(); stopLocal();
  }
  T.resetAssetTiersForTest();
  {
    const target = slowUploadTarget();
    let fail = true;
    const { bodies, hooks } = sharedHooks({ respond: (body) => (fail ? null : { queued: body.items.map((i) => i.original), missing: [] }) });
    const stop = startTierBackfill(hooks);
    importOne({ kind: "audio", name: "retry.mp3", hash: H("9") });
    target.release();
    await waitFor(() => bodies.length === 1);
    await flush();
    assert.deepEqual(T.deferredImportsForTest(), [H("9")], "The hand-over did not succeed (the editor process did not reply): keep it");
    fail = false;
    target.renew();
    await waitFor(() => bodies.length === 2);
    await flush();
    assert.deepEqual(bodies[1], { items: [{ name: "retry.mp3", original: H("9") }] });
    assert.equal(T.deferredImportsForTest().length, 0);
    stop(); target.stop();
  }
});

test("UT-5 Items missing from the local content store at hand-over time: listed to the user", async () => {
  actions.newProject("Cloud project");
  const target = slowUploadTarget();
  const { notified, hooks } = sharedHooks({ respond: () => ({ queued: [], missing: [H("a")] }) });
  const stop = startTierBackfill(hooks);
  try {
    importOne({ kind: "image", name: "gone.png", hash: H("a") });
    target.release();
    await waitFor(() => notified.length > 0);
    assert.deepEqual(notified, [["gone.png"]]);
  } finally { stop(); target.stop(); }
});
