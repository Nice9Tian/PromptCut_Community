/**
 * Assets imported in shared projects must be transmitted to document service (defect exposed by
 * C6.6 T9). Run: node --test src/editor/io/mediaSharedSync.test.mjs
 *
 * Pins down that: when store is connected to docsync, store responses written back to asset table
 * (hash / url / ext / size / tiers, clearing pending) and backfilling tiers.small when small-size
 * asset arrives later must all become project.op sent to document service, visible to another page
 * session (observer side); and mutating existing objects in store in-place is not allowed
 * (docsync's local replica and store are the same instance; mutating in-place prevents diffProject
 * from detecting changes).
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { MemDocService } from "../../testing/memDocService.mjs";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { DocSync, bindStore } = await import(srcUrl("store/docsync.ts"));
const { applyUploadedMedia, backfillSmallTiers } = await import(srcUrl("editor/io/mediaUpload.ts"));

const ORIG = "c".repeat(64);
const SMALL = "d".repeat(64);
const ORIG2 = "e".repeat(64);
const SMALL2 = "f".repeat(64);

/** Creator A connects to store, observer B is just another DocSync; returns { svc, A, B, unbind } */
function share(name) {
  actions.newProject(name);
  const p0 = getState().project;
  const svc = new MemDocService({ project: structuredClone(p0), rev: 1 });
  let linkA;
  const A = new DocSync(p0, { projectId: "P", session: "A", send: (m) => linkA.send(m) });
  linkA = svc.connect("A", (m) => A.receive(m));
  const unbind = bindStore(A);
  A.connect();
  let linkB;
  const B = new DocSync(structuredClone(p0), { projectId: "P", session: "B", send: (m) => linkB.send(m) });
  linkB = svc.connect("B", (m) => B.receive(m));
  B.connect();
  svc.drain();
  return { svc, A, B, unbind };
}

const mediaOf = (project, id) => project.media.find((x) => x.id === id);

async function waitFor(pred, ms = 8000) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
}

test("Shared project: both the store response and a later-arriving small-size asset are sent to the document service and visible to the observer; the old object in the store is not modified in place", async () => {
  const { svc, B, unbind } = share("Shared import");
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), new RegExp(`^/api/media/tiers\\?hashes=${ORIG}$`));
    asked++;
    const item = asked < 2 ? { state: "pending" } : { state: "ready", small: SMALL };
    return new Response(JSON.stringify({ ok: true, items: { [ORIG]: item } }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const m = actions.addMedia({ kind: "video", name: "clip.mp4", url: "", pending: true });
    svc.drain();
    assert.equal(mediaOf(B.project, m.id)?.pending, true);

    const before = mediaOf(getState().project, m.id);
    const listBefore = getState().project.media;
    applyUploadedMedia(m.id, {
      hash: ORIG, ext: "mp4", name: "clip.mp4", path: "C:/lib/clip.mp4", url: `/@media/${ORIG}`, bytes: 123,
      tiers: { original: ORIG, small: null }, smallState: "pending",
    });
    // Existing objects and existing arrays left untouched as-is
    assert.equal(before.pending, true);
    assert.equal(before.hash, undefined);
    assert.equal(before.tiers, undefined);
    assert.equal(listBefore.find((x) => x.id === m.id), before);

    svc.drain();
    for (const [where, project] of [["Document service", svc.project], ["Observer", B.project]]) {
      const got = mediaOf(project, m.id);
      assert.equal(got.hash, ORIG, `${where} hash`);
      assert.equal(got.url, `/@media/${ORIG}`, `${where} url`);
      assert.equal(got.ext, "mp4", `${where} ext`);
      assert.equal(got.size, 123, `${where} size`);
      assert.equal(got.path, "C:/lib/clip.mp4", `${where} path`);
      assert.deepEqual(got.tiers, { original: ORIG }, `${where} tiers`);
      assert.equal(got.pending, undefined, `${where} pending`);
    }

    // Small-size asset arrives later (watchSmallTier polls every 2 s)
    const beforeSmall = mediaOf(getState().project, m.id);
    await waitFor(() => !!mediaOf(getState().project, m.id)?.tiers?.small);
    assert.deepEqual(beforeSmall.tiers, { original: ORIG }, "Backfilling the small-size asset does not modify the old object in place");
    svc.drain();
    assert.deepEqual(mediaOf(svc.project, m.id).tiers, { original: ORIG, small: SMALL });
    assert.deepEqual(mediaOf(B.project, m.id).tiers, { original: ORIG, small: SMALL });
    assert.equal(JSON.stringify(B.project), JSON.stringify(svc.project));
  } finally {
    globalThis.fetch = realFetch;
    unbind();
  }
});

test("Shared project: when the store fails, clearing pending is also sent to the document service", () => {
  const { svc, B, unbind } = share("Shared failure");
  try {
    const m = actions.addMedia({ kind: "video", name: "bad.mp4", url: "", pending: true });
    svc.drain();
    applyUploadedMedia(m.id, null);
    svc.drain();
    assert.equal(mediaOf(B.project, m.id).pending, undefined);
    assert.equal(mediaOf(svc.project, m.id).pending, undefined);
  } finally {
    unbind();
  }
});

test("Shared project: the small-size asset backfill-transcoded when the project opens (backfill returns ready) is also sent to the document service", async () => {
  const { svc, B, unbind } = share("Shared backfill transcode");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "/api/media/tiers/backfill");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.items.map((x) => x.hash), [ORIG2]);
    return new Response(JSON.stringify({ ok: true, items: { [ORIG2]: { state: "ready", small: SMALL2 } } }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const m = actions.addMedia({ kind: "video", name: "old.mp4", url: `/@media/${ORIG2}`, hash: ORIG2, tiers: { original: ORIG2 } });
    svc.drain();
    const before = mediaOf(getState().project, m.id);
    assert.equal(await backfillSmallTiers(), 1);
    assert.deepEqual(before.tiers, { original: ORIG2 }, "The old object is not modified in place");
    svc.drain();
    assert.deepEqual(mediaOf(svc.project, m.id).tiers, { original: ORIG2, small: SMALL2 });
    assert.deepEqual(mediaOf(B.project, m.id).tiers, { original: ORIG2, small: SMALL2 });
  } finally {
    globalThis.fetch = realFetch;
    unbind();
  }
});
