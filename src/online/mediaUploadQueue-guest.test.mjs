/**
 * Online upload queue × guest video count ((user decision, 2026-10-23) "total video media cannot
 * exceed three items"): real queue (`mediaUploadQueue.ts`) against real asset service
 * (`server/asset-service.ts` + project data layer fs, composite document service authority,
 * subject is guest).
 *
 * Covers:
 * - Each chunk of a cloud account project carries `X-Media-Tier` (small tier `small`, original size
 *   `original`); non-account projects do not carry it (for local projects via hosted relay, it is
 *   not in the preflight allowed headers; including it causes the browser to block the entire PUT);
 * - A guest uploads 3 videos (6 files) via the queue, all stored; the 4th video is rejected at the
 *   small tier (small tier also counts, claude/guest-fix), this item **is entirely dequeued, marked as
 *   rejected, and not retried**, images queued behind it upload normally, and subscribers are notified
 *   (the UI shows that message accordingly). Previously this item retried with permanent backoff,
 *   blocking everything behind it (Review D, PROBE-3: images cannot be uploaded): this test guards
 *   against exactly that. An even earlier version (counting 3 by file count) rejected at the original
 *   size of the 2nd video; this is also guarded.
 */
import "../testing/registerTs.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

const { createMediaUploadQueue, subscribeMediaUploadRejected, PERMANENT_REFUSALS } = await import("./mediaUploadQueue.ts");
const { uploadRejectedText } = await import("../editor/left/uploadRejectedNotice.ts");
const { compileAssetModules } = await import("../../server/test/fixtures/asset-project-service.mjs");
const { createProjectAssetStores } = await import("../../server/asset-store/project-stores.mjs");
const { createProjectAssetAccess } = await import("../../server/asset-store/project-access.mjs");

const GUEST = "gst_" + "0123456789abcdef01234567";
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const tierOf = (label, tier) => {
  const bytes = Buffer.from(`queue guest ${label} ${tier} ${crypto.randomUUID()}`);
  return { tier, hash: sha(bytes), ext: "mp4", blob: new Blob([bytes]) };
};
const videoItem = (label) => ({ id: `v-${label}`, name: `${label}.mp4`, tiers: [tierOf(label, "small"), tierOf(label, "original")] });

const out = await fsp.mkdtemp(path.join(os.tmpdir(), "pc-queue-guest-"));
after(() => fsp.rm(out, { recursive: true, force: true }));
const { asset, media } = await compileAssetModules(out);

/** Ticket is the project id; subject is always that guest */
const principalOf = (token) => (/^[A-Za-z0-9-]+$/.test(String(token ?? ""))
  ? { projectId: token, access: "rw", accountId: GUEST, loginId: `l-${GUEST}`, credentialId: `c-${GUEST}`, authorizationId: `auth-${token}` }
  : null);
const authority = {
  async checkAccess({ principal, projectId }) { return { allowed: principal?.projectId === projectId, accessRevision: 1, revocationSeq: 0 }; },
  subscribeRevocations() { return () => {}; },
};
const projectAccess = createProjectAssetAccess({ authority, resolvePrincipal: async (req) => principalOf(/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]) });
const factory = createProjectAssetStores({ dir: path.join(out, "assets"), contentTypeForExt: media.contentTypeForExt });
const handler = asset.assetServiceMiddleware(out, { projectStores: factory, projectAccess, pullArtifact: null, pxEvict: null });
const server = http.createServer((req, res) => { void handler(req, res, () => { res.statusCode = 404; res.end("no route"); }); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => { server.closeAllConnections?.(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}/api/asset`;

/** Record the tier header carried by each PUT */
function recording() {
  const puts = [];
  const f = async (url, init = {}) => {
    if (init.method === "PUT") puts.push({ hash: /\/media\/([0-9a-f]{64})\//.exec(String(url))?.[1], tier: (init.headers ?? {})["X-Media-Tier"] });
    return fetch(url, init);
  };
  return { puts, fetch: f };
}

async function runQueue(items, target) {
  const rec = recording();
  const events = [];
  const rejected = [];
  const q = createMediaUploadQueue({ target: () => target, fetch: rec.fetch, backoff: [60_000], log: (event, fields) => events.push({ event, ...fields }), onRejected: (r) => rejected.push(r) });
  for (const it of items) assert.equal((await q.enqueue(it)).queued, true);
  q.start();
  // Wait until each item either dequeues or has failed once (failed items enter backoff, won't retry
  // within 60 seconds)
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const s = q.stats();
    if (s.done + s.failures >= items.length && !s.working) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await q.stop();
  return { puts: rec.puts, events, stats: q.stats(), rejected };
}

test("A guest uploads 3 videos (6 files) through the online upload queue and all are accepted; after the 4th video is rejected its whole item is dequeued, and the images after it upload as usual", async () => {
  const projectId = "p-queue";
  const imgBytes = Buffer.from(`queue guest image ${crypto.randomUUID()}`);
  const image = { id: "img", name: "a.png", tiers: [{ tier: "original", hash: sha(imgBytes), ext: "png", blob: new Blob([imgBytes]) }] };
  const items = [videoItem("one"), videoItem("two"), videoItem("three"), videoItem("four"), image];
  const { puts, events, stats, rejected } = await runQueue(items, { base, ticket: projectId, accountProject: true });
  console.log("D", JSON.stringify({ done: stats.done, failures: stats.failures, rejected: stats.rejected, items: stats.items, codes: rejected.map((r) => r.code) }));
  const store = factory.project(projectId).stores.media;
  const stored = new Map((await store.inventory()).stored.map((e) => [e.hash, e.tier]));
  for (const it of items.slice(0, 3)) for (const t of it.tiers) assert.equal(stored.get(t.hash), t.tier, `${it.name} ${t.tier} stored with the correct tier`);
  const [small4, original4] = items[3].tiers;
  assert.equal(stored.has(small4.hash), false, "The small tier of the 4th video is rejected (the small tier counts too)");
  assert.equal(stored.has(original4.hash), false, "The original size of the 4th video was not uploaded either");
  assert.equal(stored.get(image.tiers[0].hash), "original", "The image queued after it was uploaded (it was blocked before the fix)");
  assert.equal(stats.done, 4, "The first 3 videos and the image are dequeued");
  assert.deepEqual(stats.items, [], "The rejected item does not stay in the queue");
  assert.equal(stats.rejected, 1);
  assert.deepEqual(rejected.map((r) => [r.id, r.code]), [["v-four", "guest-video-limit"]]);
  assert.equal(events.filter((e) => e.event === "upload.retry").length, 0, "Rejected items do not enter backoff retry");
  assert.equal(uploadRejectedText(rejected[0]), "\"four.mp4\" was not uploaded to the cloud: Guests can upload at most 3 videos. To upload more, please sign up for an account.");
  // Every chunk carries the tier header, matching this tier
  const tierByHash = new Map(items.flatMap((it) => it.tiers.map((t) => [t.hash, t.tier])));
  assert.ok(puts.length >= 7);
  for (const p of puts) assert.equal(p.tier, tierByHash.get(p.hash), `X-Media-Tier of PUT ${p.hash.slice(0, 8)}`);
});

test("Other 403s (not quota) still get backoff retry; only the quota kinds count as permanently rejected; the global subscription receives them", async () => {
  assert.deepEqual([...PERMANENT_REFUSALS].sort(), ["guest-file-too-large", "guest-read-only", "guest-video-limit"]);
  const bytes = Buffer.from(`queue 403 ${crypto.randomUUID()}`);
  const item = { id: "x", name: "x.mp4", tiers: [{ tier: "original", hash: sha(bytes), ext: "mp4", blob: new Blob([bytes]) }] };
  const answer = (code) => async () => new Response(JSON.stringify({ ok: false, error: code }), { status: 403, headers: { "content-type": "application/json" } });
  for (const [code, permanent] of [["forbidden", false], ["guest-file-too-large", true]]) {
    const events = [], rejected = [];
    const q = createMediaUploadQueue({ target: () => ({ base, ticket: "p-403", accountProject: true }), fetch: answer(code), backoff: [60_000],
      log: (event, fields) => events.push({ event, ...fields }), onRejected: (r) => rejected.push(r) });
    await q.enqueue(item);
    q.start();
    for (let i = 0; i < 200 && q.stats().failures < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await q.stop();
    assert.equal(q.stats().items.length, permanent ? 0 : 1, code);
    assert.equal(rejected.length, permanent ? 1 : 0, code);
    assert.equal(events.some((e) => e.event === "upload.retry"), !permanent, code);
  }
  // Global subscription: receives nothing after unsubscribing
  const got = [];
  const off = subscribeMediaUploadRejected((r) => got.push(r.code));
  off();
  assert.deepEqual(got, []);
});

test("Not a target of a cloud account project (local project, via hosted relay): PUT carries no X-Media-Tier", async () => {
  const { puts, stats } = await runQueue([videoItem("local")], { base, ticket: "p-local", accountProject: false });
  assert.equal(stats.done, 1);
  assert.equal(puts.length, 2);
  for (const p of puts) assert.equal(p.tier, undefined);
});
