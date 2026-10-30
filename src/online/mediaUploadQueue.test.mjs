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

test("mediaUploadQueue: 基础校验与非法项处理", async () => {
  const q = createMediaUploadQueue({
    target: () => ({ base: "http://127.0.0.1:20035/api/asset" }),
  });

  // 缺少 original 档位
  const r1 = await q.enqueue({
    id: "item1",
    tiers: [{ tier: "small", hash: dummyHash("s1"), blob: new Blob([new Uint8Array(10)]) }],
  });
  assert.equal(r1.queued, false);
  assert.equal(r1.reason, "bad-item");

  // original 档位哈希非法
  const r2 = await q.enqueue({
    id: "item2",
    tiers: [{ tier: "original", hash: "not-a-valid-hex-64", blob: new Blob([new Uint8Array(10)]) }],
  });
  assert.equal(r2.queued, false);
  assert.equal(r2.reason, "bad-item");

  // 合法入队与重复入队合并
  const origHash = dummyHash("orig1");
  const smallHash = dummyHash("small1");
  const r3 = await q.enqueue({
    id: "item3",
    tiers: [{ tier: "original", hash: origHash, blob: new Blob([new Uint8Array(20)]) }],
  });
  assert.equal(r3.queued, true);
  assert.equal(q.stats().enqueued, 1);

  // 再次入队相同 id（补上 small 档）
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

test("mediaUploadQueue: 派发顺序铁律：所有小尺寸先传、再传原尺寸", async () => {
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

  // 派发顺序必须是：A 小 -> B 小 -> A 原 -> B 原 -> C 原
  const expected = [
    { id: "item-A", tier: "small", hash: hA_small },
    { id: "item-B", tier: "small", hash: hB_small },
    { id: "item-A", tier: "original", hash: hA_orig },
    { id: "item-B", tier: "original", hash: hB_orig },
    { id: "item-C", tier: "original", hash: hC_orig },
  ];

  assert.deepEqual(dispatched, expected, "派发顺序必须为：所有素材的小尺寸先传完，再按进队先后传原尺寸");
  assert.equal(q.stats().done, 3);
  await q.stop();
});

test("mediaUploadQueue: 原尺寸派发期间新素材进队插队（小尺寸抢占）", async () => {
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

  // 等待 item-A 的 original 档位开始派发
  await itemAOriginalPromise;

  // 在 A 的 original 档位上传中，突然新入队一个带 small 档位的 item-C
  await q.enqueue({
    id: "item-C",
    tiers: [
      { tier: "small", hash: hC_small, blob: new Blob([new Uint8Array(200)]) },
      { tier: "original", hash: hC_orig, blob: new Blob([new Uint8Array(600)]) },
    ],
  });

  await q.drain();

  // 派发顺序应为：
  // 1. A.small
  // 2. A.original（此时 C 进队）
  // 3. C.small（插队！必须先于剩下的原尺寸 B.original 和 C.original）
  // 4. B.original
  // 5. C.original
  const expected = [
    { id: "item-A", tier: "small" },
    { id: "item-A", tier: "original" },
    { id: "item-C", tier: "small" },
    { id: "item-B", tier: "original" },
    { id: "item-C", tier: "original" },
  ];

  assert.deepEqual(dispatched, expected, "A 的 original 传完后，新进队 C 的 small 必须插在剩下的原尺寸前面");
  await q.stop();
});

test("mediaUploadQueue: 退避机制（小尺寸在退避期间，任何原尺寸都不传）", async () => {
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
      // 模拟第 1 次小尺寸上传失败报 500
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

  // 等待第 1 次 pump 失败
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(q.stats().failures, 1);
  assert.deepEqual(dispatched, [{ id: "item-A", tier: "small" }]);

  // 在退避期内（virtualTime 仅前进 1000ms < 5000ms），触发 poke() 尝试调度
  virtualTime += 1000;
  q.poke();
  await new Promise((r) => setTimeout(r, 20));

  // 关键断言：小尺寸在退避时，后面的任何原尺寸都绝不提前传！
  assert.deepEqual(dispatched, [{ id: "item-A", tier: "small" }], "退避期间不得偷传任何原尺寸");

  // 快进走过退避时间（+5000ms）
  virtualTime += 5000;
  q.poke();

  await q.drain();

  // 重试成功后，完成剩余全部上传
  const expected = [
    { id: "item-A", tier: "small" }, // 失败那次
    { id: "item-A", tier: "small" }, // 重试成功
    { id: "item-A", tier: "original" },
    { id: "item-B", tier: "original" },
  ];
  assert.deepEqual(dispatched, expected);
  await q.stop();
});

test("mediaUploadQueue: holdOriginals() 挂起原尺寸派发，释放后恢复", async () => {
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

  // 1. 模拟批量导入前开启 hold
  const release = q.holdOriginals();

  // 2. 素材 A 进队，启动队列
  await q.enqueue({
    id: "item-A",
    tiers: [
      { tier: "small", hash: hA_small, blob: new Blob([new Uint8Array(100)]) },
      { tier: "original", hash: hA_orig, blob: new Blob([new Uint8Array(500)]) },
    ],
  });
  q.start();

  // 3. 等待 A.small 完成
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(dispatched, [{ id: "item-A", tier: "small" }]);

  // 此时没有剩余 small，但 hold 激活，原尺寸不应该派发
  q.poke();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(dispatched, [{ id: "item-A", tier: "small" }], "hold 期间绝不派发原尺寸");

  // 4. 随后同一批次中的素材 B 进队 (带 small)
  await q.enqueue({
    id: "item-B",
    tiers: [
      { tier: "small", hash: hB_small, blob: new Blob([new Uint8Array(100)]) },
      { tier: "original", hash: hB_orig, blob: new Blob([new Uint8Array(500)]) },
    ],
  });
  await new Promise((r) => setTimeout(r, 30));

  // B.small 应该顺利派发并完成
  assert.deepEqual(dispatched, [
    { id: "item-A", tier: "small" },
    { id: "item-B", tier: "small" },
  ]);

  // 5. 批次导入完成，释放 hold
  release();

  await q.drain();

  // 原尺寸随后按顺序派发
  assert.deepEqual(dispatched, [
    { id: "item-A", tier: "small" },
    { id: "item-B", tier: "small" },
    { id: "item-A", tier: "original" },
    { id: "item-B", tier: "original" },
  ]);
  await q.stop();
});

test("mediaUploadQueue: 401 票据过期自动换票重试", async () => {
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
      // 模拟重新获取票据
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

  assert.ok(authHeaders.includes("Bearer ticket-v1"), "初始带 v1 票据");
  assert.ok(authHeaders.includes("Bearer ticket-v2"), "401 后换用 v2 票据重试");
  assert.equal(q.stats().done, 1);
  await q.stop();
});

test("mediaUploadQueue [Integration]: 真 HTTP 素材服务（端口 20035）全链路验收", async () => {
  const PORT = 20035; // 严格在分配的 20030-20039 范围内
  const CHUNK = 16 * 1024; // 16 KiB 分片

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

    // 构造真实二进制数据
    // A: 视频（small: 15 KiB [1 片], original: 60 KiB [4 片]）
    const bytesA_small = crypto.randomBytes(15 * 1024);
    const hashA_small = sha256Buf(bytesA_small);
    const bytesA_orig = crypto.randomBytes(60 * 1024);
    const hashA_orig = sha256Buf(bytesA_orig);

    // B: 视频（small: 10 KiB [1 片], original: 40 KiB [3 片]）
    const bytesB_small = crypto.randomBytes(10 * 1024);
    const hashB_small = sha256Buf(bytesB_small);
    const bytesB_orig = crypto.randomBytes(40 * 1024);
    const hashB_orig = sha256Buf(bytesB_orig);

    // C: 图片（只有 original: 25 KiB [2 片]）
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

    // 1. 验证队列统计
    const st = q.stats();
    assert.equal(st.enqueued, 3);
    assert.equal(st.done, 3);
    assert.equal(st.failures, 0);
    assert.deepEqual(st.items, []);

    // 2. 验证写入段序（writeRuns）
    // 只看 PUT 分片与 POST complete 请求
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
      `真实 HTTP 写入请求必须按「所有视频小尺寸 -> 再到各视频与图片原尺寸」出现，实际段序：${runs.map((r) => r.hash.slice(0, 6)).join(" -> ")}`
    );

    // 验证每一段均包含完整分片且以 complete 结尾
    for (const r of runs) {
      assert.equal(r.completed, true, `${r.hash.slice(0, 6)} 必须以 complete 收尾`);
    }

    // 3. 验证素材服务上各哈希的状态均已 complete: true
    for (const hash of expectedOrder) {
      const cRes = await fetch(`http://127.0.0.1:${PORT}/api/asset/media/${hash}/chunks`);
      assert.equal(cRes.status, 200);
      const cData = await cRes.json();
      assert.equal(cData.complete, true, `${hash.slice(0, 6)} 在素材服务上必须已 complete`);
    }

    // 4. 验证素材服务上存储的内容与原始 Blob 逐字节一致
    const verifyContent = async (hash, expectedBuf) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/asset/media/${hash}`);
      assert.equal(res.status, 200);
      const arr = new Uint8Array(await res.arrayBuffer());
      const actualBuf = Buffer.from(arr);
      assert.equal(actualBuf.length, expectedBuf.length, `长度一致: ${hash.slice(0, 6)}`);
      assert.equal(sha256Buf(actualBuf), sha256Buf(expectedBuf), `内容一致: ${hash.slice(0, 6)}`);
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
