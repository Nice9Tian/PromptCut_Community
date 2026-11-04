import "../testing/registerTs.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const { createMediaUploadQueue, CHUNK_SIZE, UPLOAD_BACKOFF_MS } = await import("./mediaUploadQueue.ts");
const { createAssetHarness } = await import("../../server/test/fake-asset-service.mjs");
const { recordingFetch } = await import("../../server/test/c66-kit.mjs");

const sha256Buf = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const dummyHash = (seed) => sha256Buf(Buffer.from(seed, "utf8"));

test("mediaUploadQueue: basic validation and invalid item handling", async () => {
  const q = createMediaUploadQueue({
    target: () => ({ base: "http://127.0.0.1:20035/api/asset" }),
  });

  // Missing original tier
  const r1 = await q.enqueue({
    id: "item1",
    tiers: [{ tier: "small", hash: dummyHash("s1"), blob: new Blob([new Uint8Array(10)]) }],
  });
  assert.equal(r1.queued, false);
  assert.equal(r1.reason, "bad-item");

  // Invalid original tier hash
  const r2 = await q.enqueue({
    id: "item2",
    tiers: [{ tier: "original", hash: "not-a-valid-hex-64", blob: new Blob([new Uint8Array(10)]) }],
  });
  assert.equal(r2.queued, false);
  assert.equal(r2.reason, "bad-item");

  // Valid enqueue and duplicate enqueue merge
  const origHash = dummyHash("orig1");
  const smallHash = dummyHash("small1");
  const r3 = await q.enqueue({
    id: "item3",
    tiers: [{ tier: "original", hash: origHash, blob: new Blob([new Uint8Array(20)]) }],
  });
  assert.equal(r3.queued, true);
  assert.equal(q.stats().enqueued, 1);

  // Re-enqueue same id (adding small tier)
  const r4 = await q.enqueue({
    id: "item3",
    tiers: [
      { tier: "original", hash: origHash, blob: new Blob([new Uint8Array(20)]) },
      { tier: "small", hash: smallHash, blob: new Blob([new Uint8Array(10)]) },
    ],
  });
  assert.equal(r4.queued, true);
  assert.equal(q.stats().merged, 1);

  await q.stop();
});

test("mediaUploadQueue: dispatch order rule: all small sizes upload first, then original sizes", async () => {
  const dispatched = [];
  const fakeStore = new Map();

  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url);
    const m = /\/media\/([0-9a-f]{64})(?:\/(\d+|chunks|complete))?$/i.exec(u.pathname);
    const hash = m?.[1];
    const sub = m?.[2];

    if (sub === "chunks") {
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      return new Response(JSON.stringify(entry), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (sub === "complete") {
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      entry.complete = true;
      fakeStore.set(hash, entry);
      return new Response(JSON.stringify({ ok: true, complete: true, hash }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (init.method === "PUT") {
      const n = Number(sub);
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      if (!entry.received.includes(n)) entry.received.push(n);
      fakeStore.set(hash, entry);
      return new Response(JSON.stringify({ ok: true, n }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  const q = createMediaUploadQueue({
    target: () => ({ base: "http://fake-asset.local/api/asset" }),
    fetch: fakeFetch,
    chunkSize: 1024,
    log: (event, fields) => {
      if (event === "upload.tier-start") {
        dispatched.push({ id: fields.id, tier: fields.tier, hash: fields.hash });
      }
    },
  });

  const hA_small = dummyHash("A_small");
  const hA_orig = dummyHash("A_orig");
  const hB_small = dummyHash("B_small");
  const hB_orig = dummyHash("B_orig");
  const hC_orig = dummyHash("C_orig");

  await q.enqueue({
    id: "item-A",
    name: "A.mp4",
    tiers: [
      { tier: "small", hash: hA_small, blob: new Blob([new Uint8Array(500)]) },
      { tier: "original", hash: hA_orig, blob: new Blob([new Uint8Array(2000)]) },
    ],
  });
  await q.enqueue({
    id: "item-B",
    name: "B.mp4",
    tiers: [
      { tier: "small", hash: hB_small, blob: new Blob([new Uint8Array(400)]) },
      { tier: "original", hash: hB_orig, blob: new Blob([new Uint8Array(1500)]) },
    ],
  });
  await q.enqueue({
    id: "item-C",
    name: "C.png",
    tiers: [
      { tier: "original", hash: hC_orig, blob: new Blob([new Uint8Array(800)]) },
    ],
  });

  q.start();
  await q.drain();

  // Dispatch order must be: A small -> B small -> A original -> B original -> C original
  const expected = [
    { id: "item-A", tier: "small", hash: hA_small },
    { id: "item-B", tier: "small", hash: hB_small },
    { id: "item-A", tier: "original", hash: hA_orig },
    { id: "item-B", tier: "original", hash: hB_orig },
    { id: "item-C", tier: "original", hash: hC_orig },
  ];

  assert.deepEqual(dispatched, expected, "Dispatch order must be: the small sizes of all media finish first, then original sizes in queue order");
  assert.equal(q.stats().done, 3);
  await q.stop();
});

test("mediaUploadQueue: new media joins the queue and jumps ahead during original-size dispatch (small sizes preempt)", async () => {
  const dispatched = [];
  const fakeStore = new Map();

  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url);
    const m = /\/media\/([0-9a-f]{64})(?:\/(\d+|chunks|complete))?$/i.exec(u.pathname);
    const hash = m?.[1];
    const sub = m?.[2];

    if (sub === "chunks") {
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      return new Response(JSON.stringify(entry), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (sub === "complete") {
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      entry.complete = true;
      fakeStore.set(hash, entry);
      return new Response(JSON.stringify({ ok: true, complete: true, hash }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (init.method === "PUT") {
      const n = Number(sub);
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      if (!entry.received.includes(n)) entry.received.push(n);
      fakeStore.set(hash, entry);
      return new Response(JSON.stringify({ ok: true, n }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  let onItemAOriginalStart = null;
  const itemAOriginalPromise = new Promise((resolve) => { onItemAOriginalStart = resolve; });

  const q = createMediaUploadQueue({
    target: () => ({ base: "http://fake-asset.local/api/asset" }),
    fetch: fakeFetch,
    chunkSize: 1024,
    log: (event, fields) => {
      if (event === "upload.tier-start") {
        dispatched.push({ id: fields.id, tier: fields.tier });
        if (fields.id === "item-A" && fields.tier === "original") {
          onItemAOriginalStart();
        }
      }
    },
  });

  const hA_small = dummyHash("A_s");
  const hA_orig = dummyHash("A_o");
  const hB_orig = dummyHash("B_o");
  const hC_small = dummyHash("C_s");
  const hC_orig = dummyHash("C_o");

  await q.enqueue({
    id: "item-A",
    tiers: [
      { tier: "small", hash: hA_small, blob: new Blob([new Uint8Array(100)]) },
      { tier: "original", hash: hA_orig, blob: new Blob([new Uint8Array(500)]) },
    ],
  });
  await q.enqueue({
    id: "item-B",
    tiers: [
      { tier: "original", hash: hB_orig, blob: new Blob([new Uint8Array(400)]) },
    ],
  });

  q.start();

  // Wait for item-A original tier to start dispatching
  await itemAOriginalPromise;

  // While A's original tier is uploading, a new item-C with small tier is suddenly enqueued
  await q.enqueue({
    id: "item-C",
    tiers: [
      { tier: "small", hash: hC_small, blob: new Blob([new Uint8Array(200)]) },
      { tier: "original", hash: hC_orig, blob: new Blob([new Uint8Array(600)]) },
    ],
  });

  await q.drain();

  // Dispatch order should be:
  // 1. A.small
  // 2. A.original (C enters queue at this point)
  // 3. C.small (cut in line! Must precede remaining original sizes B.original and C.original)
  // 4. B.original
  // 5. C.original
  const expected = [
    { id: "item-A", tier: "small" },
    { id: "item-A", tier: "original" },
    { id: "item-C", tier: "small" },
    { id: "item-B", tier: "original" },
    { id: "item-C", tier: "original" },
  ];

  assert.deepEqual(dispatched, expected, "After A's original finishes, the small of newly queued C must be inserted before the remaining original sizes");
  await q.stop();
});

test("mediaUploadQueue: backoff mechanism (while small sizes are in backoff, no original size is uploaded)", async () => {
  let virtualTime = 1000;
  let smallAAttempts = 0;
  const dispatched = [];
  const fakeStore = new Map();

  const hA_small = dummyHash("backoff_A_s");
  const hA_orig = dummyHash("backoff_A_o");
  const hB_orig = dummyHash("backoff_B_o");

  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url);
    const m = /\/media\/([0-9a-f]{64})(?:\/(\d+|chunks|complete))?$/i.exec(u.pathname);
    const hash = m?.[1];
    const sub = m?.[2];

    if (hash === hA_small && init.method === "PUT" && smallAAttempts < 1) {
      // Simulate 1st small-size upload failing with 500
      smallAAttempts++;
      return new Response(JSON.stringify({ error: "server error" }), { status: 500 });
    }

    if (sub === "chunks") {
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      return new Response(JSON.stringify(entry), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (sub === "complete") {
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      entry.complete = true;
      fakeStore.set(hash, entry);
      return new Response(JSON.stringify({ ok: true, complete: true, hash }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (init.method === "PUT") {
      const n = Number(sub);
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      if (!entry.received.includes(n)) entry.received.push(n);
      fakeStore.set(hash, entry);
      return new Response(JSON.stringify({ ok: true, n }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  const q = createMediaUploadQueue({
    target: () => ({ base: "http://fake-asset.local/api/asset" }),
    fetch: fakeFetch,
    chunkSize: 1024,
    backoff: [5000, 30000],
    now: () => virtualTime,
    log: (event, fields) => {
      if (event === "upload.tier-start") {
        dispatched.push({ id: fields.id, tier: fields.tier });
      }
    },
  });

  await q.enqueue({
    id: "item-A",
    tiers: [
      { tier: "small", hash: hA_small, blob: new Blob([new Uint8Array(100)]) },
      { tier: "original", hash: hA_orig, blob: new Blob([new Uint8Array(500)]) },
    ],
  });
  await q.enqueue({
    id: "item-B",
    tiers: [
      { tier: "original", hash: hB_orig, blob: new Blob([new Uint8Array(400)]) },
    ],
  });

  q.start();

  // Wait for 1st pump to fail
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(q.stats().failures, 1);
  assert.deepEqual(dispatched, [{ id: "item-A", tier: "small" }]);

  // During backoff (virtualTime advances only 1000ms < 5000ms), trigger poke() to attempt scheduling
  virtualTime += 1000;
  q.poke();
  await new Promise((r) => setTimeout(r, 20));

  // Key assertion: while small size is in backoff, no subsequent original size may upload early!
  assert.deepEqual(dispatched, [{ id: "item-A", tier: "small" }], "No original size may be uploaded sneakily during backoff");

  // Fast-forward past backoff time (+5000ms)
  virtualTime += 5000;
  q.poke();

  await q.drain();

  // After retry succeeds, complete all remaining uploads
  const expected = [
    { id: "item-A", tier: "small" }, // The failed attempt
    { id: "item-A", tier: "small" }, // Successful retry
    { id: "item-A", tier: "original" },
    { id: "item-B", tier: "original" },
  ];
  assert.deepEqual(dispatched, expected);
  await q.stop();
});

test("mediaUploadQueue: holdOriginals() suspends original-size dispatch, resumes after release", async () => {
  const dispatched = [];
  const fakeStore = new Map();

  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url);
    const m = /\/media\/([0-9a-f]{64})(?:\/(\d+|chunks|complete))?$/i.exec(u.pathname);
    const hash = m?.[1];
    const sub = m?.[2];

    if (sub === "chunks") {
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      return new Response(JSON.stringify(entry), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (sub === "complete") {
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      entry.complete = true;
      fakeStore.set(hash, entry);
      return new Response(JSON.stringify({ ok: true, complete: true, hash }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (init.method === "PUT") {
      const n = Number(sub);
      const entry = fakeStore.get(hash) ?? { complete: false, received: [] };
      if (!entry.received.includes(n)) entry.received.push(n);
      fakeStore.set(hash, entry);
      return new Response(JSON.stringify({ ok: true, n }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  const q = createMediaUploadQueue({
    target: () => ({ base: "http://fake-asset.local/api/asset" }),
    fetch: fakeFetch,
    chunkSize: 1024,
    log: (event, fields) => {
      if (event === "upload.tier-start") {
        dispatched.push({ id: fields.id, tier: fields.tier });
      }
    },
  });

  const hA_small = dummyHash("hold_A_s");
  const hA_orig = dummyHash("hold_A_o");
  const hB_small = dummyHash("hold_B_s");
  const hB_orig = dummyHash("hold_B_o");

  // 1. Simulate enabling hold before batch import
  const release = q.holdOriginals();

  // 2. Asset A enters queue, start queue
  await q.enqueue({
    id: "item-A",
    tiers: [
      { tier: "small", hash: hA_small, blob: new Blob([new Uint8Array(100)]) },
      { tier: "original", hash: hA_orig, blob: new Blob([new Uint8Array(500)]) },
    ],
  });
  q.start();

  // 3. Wait for A.small to complete
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(dispatched, [{ id: "item-A", tier: "small" }]);

  // No remaining small at this point, but hold is active, original size should not dispatch
  q.poke();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(dispatched, [{ id: "item-A", tier: "small" }], "Original sizes must never be dispatched during hold");

  // 4. Asset B in the same batch subsequently enters queue (with small)
  await q.enqueue({
    id: "item-B",
    tiers: [
      { tier: "small", hash: hB_small, blob: new Blob([new Uint8Array(100)]) },
      { tier: "original", hash: hB_orig, blob: new Blob([new Uint8Array(500)]) },
    ],
  });
  await new Promise((r) => setTimeout(r, 30));

  // B.small should dispatch smoothly and complete
  assert.deepEqual(dispatched, [
    { id: "item-A", tier: "small" },
    { id: "item-B", tier: "small" },
  ]);

  // 5. Batch import complete, release hold
  release();

  await q.drain();

  // Original sizes are subsequently dispatched in order
  assert.deepEqual(dispatched, [
    { id: "item-A", tier: "small" },
    { id: "item-B", tier: "small" },
    { id: "item-A", tier: "original" },
    { id: "item-B", tier: "original" },
  ]);
  await q.stop();
});

test("mediaUploadQueue: 401 ticket expiry automatically swaps the ticket and retries", async () => {
  let ticket = "ticket-v1";
  let firstPut = true;
  const authHeaders = [];
  let isComplete = false;

  const fakeFetch = async (url, init = {}) => {
    const auth = init.headers?.Authorization;
    authHeaders.push(auth);

    if (init.method === "PUT" && firstPut) {
      firstPut = false;
      ticket = "ticket-v2";
      return new Response(JSON.stringify({ error: "expired ticket" }), { status: 401 });
    }

    const u = new URL(url);
    const sub = u.pathname.split("/").pop();
    if (sub === "chunks") {
      return new Response(JSON.stringify({ complete: isComplete, received: isComplete ? [0] : [] }), { status: 200 });
    }
    if (sub === "complete") {
      isComplete = true;
      return new Response(JSON.stringify({ ok: true, complete: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, n: 0 }), { status: 200 });
  };

  const q = createMediaUploadQueue({
    target: () => {
      // Simulate re-acquiring ticket
      return { base: "http://fake-asset.local/api/asset", ticket };
    },
    fetch: fakeFetch,
    chunkSize: 1024,
  });

  const hOrig = dummyHash("auth_orig");
  await q.enqueue({
    id: "item-auth",
    tiers: [{ tier: "original", hash: hOrig, blob: new Blob([new Uint8Array(100)]) }],
  });

  q.start();
  await q.drain();

  assert.ok(authHeaders.includes("Bearer ticket-v1"), "Initially carries the v1 ticket");
  assert.ok(authHeaders.includes("Bearer ticket-v2"), "After the 401, retries with the v2 ticket");
  assert.equal(q.stats().done, 1);
  await q.stop();
});

test("mediaUploadQueue [Integration]: real HTTP asset service (port 20035) full-pipeline acceptance check", async () => {
  const PORT = 20035; // Strictly within the allocated 20030-20039 range
  const CHUNK = 16 * 1024; // 16 KiB chunks

  const harness = createAssetHarness();
  const a = await harness.asset();
  const stores = {
    media: await harness.memoryStore(CHUNK),
    snap: await harness.memoryStore(CHUNK),
    px: await harness.memoryStore(CHUNK),
  };
  const service = a.assetServiceMiddleware("test-worktree-root", { stores, isTrusted: () => true });

  const server = http.createServer((req, res) => {
    void service(req, res, () => {
      res.statusCode = 404;
      res.end("no route");
    });
  });

  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  try {
    const rec = recordingFetch();
    const q = createMediaUploadQueue({
      target: () => ({ base: `http://127.0.0.1:${PORT}/api/asset` }),
      fetch: rec.fetch,
      chunkSize: CHUNK,
    });

    // Construct real binary data
    // A: Video (small: 15 KiB [1 chunk], original: 60 KiB [4 chunks])
    const bytesA_small = crypto.randomBytes(15 * 1024);
    const hashA_small = sha256Buf(bytesA_small);
    const bytesA_orig = crypto.randomBytes(60 * 1024);
    const hashA_orig = sha256Buf(bytesA_orig);

    // B: Video (small: 10 KiB [1 chunk], original: 40 KiB [3 chunks])
    const bytesB_small = crypto.randomBytes(10 * 1024);
    const hashB_small = sha256Buf(bytesB_small);
    const bytesB_orig = crypto.randomBytes(40 * 1024);
    const hashB_orig = sha256Buf(bytesB_orig);

    // C: Image (only original: 25 KiB [2 chunks])
    const bytesC_orig = crypto.randomBytes(25 * 1024);
    const hashC_orig = sha256Buf(bytesC_orig);

    await q.enqueue({
      id: "video-A",
      name: "videoA.mp4",
      tiers: [
        { tier: "small", hash: hashA_small, ext: "mp4", blob: new Blob([bytesA_small]) },
        { tier: "original", hash: hashA_orig, ext: "mp4", blob: new Blob([bytesA_orig]) },
      ],
    });

    await q.enqueue({
      id: "video-B",
      name: "videoB.mp4",
      tiers: [
        { tier: "small", hash: hashB_small, ext: "mp4", blob: new Blob([bytesB_small]) },
        { tier: "original", hash: hashB_orig, ext: "mp4", blob: new Blob([bytesB_orig]) },
      ],
    });

    await q.enqueue({
      id: "image-C",
      name: "imageC.png",
      tiers: [
        { tier: "original", hash: hashC_orig, ext: "png", blob: new Blob([bytesC_orig]) },
      ],
    });

    q.start();
    await q.drain();

    // 1. Verify queue statistics
    const st = q.stats();
    assert.equal(st.enqueued, 3);
    assert.equal(st.done, 3);
    assert.equal(st.failures, 0);
    assert.deepEqual(st.items, []);

    // 2. Verify write runs (writeRuns)
    // Only inspect PUT chunks and POST complete requests
    const runs = [];
    for (const e of rec.log) {
      if (e.ns !== "media" || (e.action !== "put" && e.action !== "complete")) continue;
      let last = runs[runs.length - 1];
      if (!last || last.hash !== e.hash) {
        last = { hash: e.hash, puts: [], completed: false };
        runs.push(last);
      }
      if (e.action === "put") last.puts.push(e.n);
      else if (e.action === "complete") last.completed = true;
    }

    const expectedOrder = [hashA_small, hashB_small, hashA_orig, hashB_orig, hashC_orig];
    assert.deepEqual(
      runs.map((r) => r.hash),
      expectedOrder,
      `Real HTTP write requests must appear in the order "all video small sizes -> then each video and image original size", actual segment order: ${runs.map((r) => r.hash.slice(0, 6)).join(" -> ")}`
    );

    // Verify each run contains complete chunks and ends with complete
    for (const r of runs) {
      assert.equal(r.completed, true, `${r.hash.slice(0, 6)} must end with complete`);
    }

    // 3. Verify status of each hash on the asset service is complete: true
    for (const hash of expectedOrder) {
      const cRes = await fetch(`http://127.0.0.1:${PORT}/api/asset/media/${hash}/chunks`);
      assert.equal(cRes.status, 200);
      const cData = await cRes.json();
      assert.equal(cData.complete, true, `${hash.slice(0, 6)} must already be complete on the asset service`);
    }

    // 4. Verify content stored on asset service matches original Blob byte-for-byte
    const verifyContent = async (hash, expectedBuf) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/asset/media/${hash}`);
      assert.equal(res.status, 200);
      const arr = new Uint8Array(await res.arrayBuffer());
      const actualBuf = Buffer.from(arr);
      assert.equal(actualBuf.length, expectedBuf.length, `Length matches: ${hash.slice(0, 6)}`);
      assert.equal(sha256Buf(actualBuf), sha256Buf(expectedBuf), `Content matches: ${hash.slice(0, 6)}`);
    };

    await verifyContent(hashA_small, bytesA_small);
    await verifyContent(hashA_orig, bytesA_orig);
    await verifyContent(hashB_small, bytesB_small);
    await verifyContent(hashB_orig, bytesB_orig);
    await verifyContent(hashC_orig, bytesC_orig);

    await q.stop();
  } finally {
    server.closeAllConnections?.();
    server.close();
    await harness.cleanup();
  }
});
