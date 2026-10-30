/**
 * 跨机器打开项目时的素材(`docs/plan/TODO.md`「跨机器打开项目时的素材路径」)的页面一侧:
 *
 *   MP-M1～M4  只有路径、本机取不到文件的素材,打开后(后台补入库那一轮)标「(缺失)」;取得到的不标;说不清的不标;
 *              共享项目里不标;以前标过、现在取到了的去掉标记
 *   MP-M5～M6  带哈希、本地内容库里没有这份字节的(另一台机器存的 .proc):本机项目里同样标;有了去掉标记;共享项目不判
 *   MP-U1～U4  项目已经「放云端」时,后台补上哈希的素材交给上传队列(图片、音频也交);补不上的列给用户、只列一次;
 *              不是共享项目、等不到上传目标时什么都不做
 *
 * 跑:node --test src/editor/io/mediaPath.test.mjs
 * `fetch` 换成假的编辑器进程:adopt、读接口、上传、入队。
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

/** 假的编辑器进程:`files` 里的路径取得到(adopt 收),`throws` 里的路径请求本身出错,其余一律 404 */
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
    if (u.startsWith("/@media/")) return new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }); // 页面回退
    return new Response(null, { status: 404 });
  };
  return { calls, fetchImpl };
}

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; resetTierBackfillForTest(); T.resetAssetTiersForTest(); });
afterEach(() => { globalThis.fetch = realFetch; resetTierBackfillForTest(); T.resetAssetTiersForTest(); });

test("MP-M1 只有路径、本机取不到文件的素材:后台补入库那一轮标「(缺失)」(名字加标记、写「确认缺失」记录、地址与 path 留着);取得到的不标", async () => {
  actions.newProject("跨机器");
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
  // 0.7.18:不再清空地址,改写「确认缺失」的记录(画面、声音、导出见到记录出占位,不去取这个地址);存盘重开后地址不变,记录才对得上
  assert.equal(get(gone.id).url, fileUrl(gonePath), "地址留着");
  assert.equal(get(gone.id).name, "(缺失) voice-gone.mp3");
  assert.deepEqual(get(gone.id).missingMaterial, { v: 1, mediaId: gone.id, reason: "confirmed-missing",
    original: { kind: "audio", name: "(缺失) voice-gone.mp3", url: fileUrl(gonePath), path: gonePath }, visual: false, audio: true });
  assert.equal(get(ok.id).missingMaterial, undefined);
  assert.equal(get(gone.id).path, gonePath, "path 留着,换回有这个文件的机器还补得上");
  assert.notEqual(get(gone.id), before, "换新对象写回");
  assert.equal(before.url, fileUrl(gonePath), "旧对象没被原地改");
  assert.equal(get(ok.id).name, "voice-ok.mp3", "取得到的不标");
  assert.equal(get(ok.id).hash, H("9"));
  assert.equal(get(hashed.id).name, "clip.mp4", "带哈希的素材不在这里核");
  // 再来一轮不重复加标记
  await ingestUnhashedMedia({ markMissing: true });
  assert.equal(get(gone.id).name, "(缺失) voice-gone.mp3");
});

test("MP-M2 说不清的不标:请求本身出错(编辑器进程不在)、或没要求标(打包、放云端那两处调用)", async () => {
  actions.newProject("跨机器-说不清");
  const p = "C:/m/voice-x.mp3";
  const m = actions.addMedia({ kind: "audio", name: "voice-x.mp3", path: p, url: fileUrl(p) });
  globalThis.fetch = fakeEditor({ throws: [p] }).fetchImpl;
  const r1 = await ingestUnhashedMedia({ markMissing: true });
  assert.deepEqual(r1.failed, [{ id: m.id, name: "voice-x.mp3" }], "请求出错:不算确实取不到");
  assert.equal(get(m.id).url, fileUrl(p));
  globalThis.fetch = fakeEditor().fetchImpl;
  const r2 = await ingestUnhashedMedia();
  assert.equal(r2.failed[0].unreachable, true);
  assert.equal(get(m.id).name, "voice-x.mp3", "没要求标:只报告,不改项目");
});

test("MP-M3 打开项目后的后台检查:本机项目标「(缺失)」,共享项目里不标(hooks.shared)", async () => {
  const p = "C:/other-machine/voice.mp3";
  globalThis.fetch = fakeEditor().fetchImpl;
  // 共享项目:不标
  actions.newProject("共享");
  const a = actions.addMedia({ kind: "audio", name: "voice.mp3", path: p, url: fileUrl(p) });
  let seen = null;
  let stop = startTierBackfill({ shared: () => true, afterIngest: (r) => { seen = r; } });
  try {
    await waitFor(() => seen);
    assert.equal(seen.failed[0].unreachable, true);
    assert.equal(get(a.id).url, fileUrl(p), "共享项目:不改项目");
    assert.equal(get(a.id).name, "voice.mp3");
    assert.equal(get(a.id).missingMaterial, undefined, "共享项目:不认定缺失");
  } finally { stop(); }
  // 本机项目:标
  resetTierBackfillForTest();
  actions.newProject("本机");
  const b = actions.addMedia({ kind: "audio", name: "voice.mp3", path: p, url: fileUrl(p) });
  seen = null;
  stop = startTierBackfill({ shared: () => false, afterIngest: (r) => { seen = r; } });
  try {
    await waitFor(() => seen);
    assert.equal(get(b.id).url, fileUrl(p));
    assert.equal(get(b.id).name, "(缺失) voice.mp3");
    assert.equal(get(b.id).missingMaterial?.reason, "confirmed-missing");
  } finally { stop(); }
});

test("MP-M4 以前在别的机器上标过「(缺失)」、这台机器取得到:补上哈希并去掉标记", async () => {
  actions.newProject("回到原机器");
  const p = "D:/pc/media/voice-back.mp3";
  const m = actions.addMedia({ kind: "audio", name: "(缺失) voice-back.mp3", path: p, url: fileUrl(p) });
  globalThis.fetch = fakeEditor({ files: { [p]: H("7") } }).fetchImpl;
  const r = await ingestUnhashedMedia({ background: true, markMissing: true });
  assert.deepEqual(r.ingested, [m.id]);
  assert.equal(get(m.id).hash, H("7"));
  assert.equal(get(m.id).url, `/@media/${H("7")}`);
  assert.equal(get(m.id).name, "voice-back.mp3");
});

test("MP-M5 带哈希、本地内容库里没有这份字节的素材标「(缺失)」(哈希留着);有的不标;答不上来时不改", async () => {
  actions.newProject("带哈希");
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
    // 内容库里没有的,按原路径再找一次(0.7.18):这里原路径上也明确没有(404)
    if (u.startsWith("/api/media/adopt?")) return new Response("Not found", { status: 404 });
    throw new Error(`没料到的请求 ${u}`);
  };
  const r = await checkHashedMedia();
  assert.deepEqual(asked, [[H("a"), H("b"), H("c")]]);
  assert.deepEqual(r, { missing: [lack.id], restored: [] });
  assert.equal(get(lack.id).url, `/@media/${H("b")}`, "地址留着按哈希的那一个");
  assert.equal(get(lack.id).name, "(缺失) lack.mp3");
  assert.deepEqual(get(lack.id).missingMaterial, { v: 1, mediaId: lack.id, reason: "confirmed-missing",
    original: { kind: "audio", name: "(缺失) lack.mp3", url: `/@media/${H("b")}`, hash: H("b"), path: "C:/A/out/media/y.mp3" }, visual: false, audio: true });
  assert.equal(get(have.id).missingMaterial, undefined);
  assert.equal(get(lack.id).hash, H("b"), "哈希留着:下次打开照样按哈希找");
  assert.equal(get(have.id).url, `/@media/${H("a")}`);
  assert.equal(get(tiered.id).name, "tiered.mp4");
  // 有的记住了:下一轮只问没有的那个;标过的不重复标
  const r2 = await checkHashedMedia();
  assert.deepEqual(asked[1], [H("b")]);
  assert.deepEqual(r2, { missing: [], restored: [] });
  // 编辑器进程不在:不改
  actions.newProject("带哈希-离线");
  const off = actions.addMedia({ kind: "audio", name: "off.mp3", url: `/@media/${H("e")}`, hash: H("e") });
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await checkHashedMedia(), { missing: [], restored: [] });
  assert.equal(get(off.id).url, `/@media/${H("e")}`);
});

test("MP-M6 标过「(缺失)」的带哈希素材,内容库里有了之后去掉标记、换回按哈希的地址;后台检查在共享项目里不判带哈希的", async () => {
  actions.newProject("带哈希-回来");
  const m = actions.addMedia({ kind: "audio", name: "(缺失) back.mp3", url: "", hash: H("f") });
  globalThis.fetch = async (url) => String(url).startsWith("/api/media/local?") ? Response.json({ ok: true, hashes: [H("f")] }) : new Response(null, { status: 404 });
  assert.deepEqual(await checkHashedMedia(), { missing: [], restored: [m.id] });
  assert.equal(get(m.id).name, "back.mp3");
  assert.equal(get(m.id).url, `/@media/${H("f")}`);
  assert.equal(get(m.id).missingMaterial, undefined);
  // 共享项目:后台检查不问 /api/media/local
  resetTierBackfillForTest();
  actions.newProject("共享-带哈希");
  const s = actions.addMedia({ kind: "audio", name: "remote.mp3", url: `/@media/${H("9")}`, hash: H("9") });
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return String(url).startsWith("/api/media/local?") ? Response.json({ ok: true, hashes: [] }) : new Response(null, { status: 404 }); };
  let seen = null;
  const stop = startTierBackfill({ shared: () => true, afterIngest: (r) => { seen = r; } });
  try {
    await waitFor(() => seen);
    assert.ok(!urls.some((u) => u.startsWith("/api/media/local?")), "共享项目里不判");
    assert.equal(get(s.id).url, `/@media/${H("9")}`);
  } finally { stop(); }
  // 本机项目:后台检查会判
  resetTierBackfillForTest();
  actions.newProject("本机-带哈希");
  const l = actions.addMedia({ kind: "audio", name: "gone.mp3", url: `/@media/${H("8")}`, hash: H("8") });
  seen = null;
  const stop2 = startTierBackfill({ shared: () => false, afterIngest: (r) => { seen = r; } });
  try {
    await waitFor(() => seen);
    assert.equal(get(l.id).name, "(缺失) gone.mp3");
  } finally { stop2(); }
});

/** 让「编辑器进程拿到带 rw 票据的上传目标」成立(同 enqueueExisting.test.mjs 的 EQE-2) */
function readyUploadTarget() {
  const link = { request: async () => ({ type: "auth.ticket.ok", ticket: "rw-1", exp: Date.now() + 15 * 60_000 }) };
  return T.startUploadTarget(link, "http://cloud/api/asset", { post: async () => {}, setTimer: () => 0, clearTimer: () => {} });
}

test("MP-U1 放云端之后后台才补上哈希的素材进上传队列(音频、视频都交);补不上的列给用户", async () => {
  actions.newProject("放云端");
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
      "只交这次补上哈希的(音频也交;已经有哈希的不在这里重交)");
    assert.equal(get(voice.id).hash, H("1"));
    assert.equal(get(vid.id).hash, H("2"));
    assert.deepEqual(notified, [["voice-gone.mp3"]], "补不上的列给用户");
  } finally { stop(); stopTarget(); }
});

test("MP-U2 补不上的同一条素材一个会话里只列一次;上传队列回 missing 的按名字列", async () => {
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
    const r = await T.queueBackfilledMedia({ ingested: ["a", "b"], failed: [{ id: "g", name: "(缺失) gone.mp3" }] }, media, deps);
    assert.deepEqual(r.queued, [H("a")]);
    assert.deepEqual(notified, [["(缺失) gone.mp3", "b.png"]]);
    // 同样的失败再来一轮(后台检查被素材表的变化再触发):不再列、也不再等上传目标
    assert.equal(await T.queueBackfilledMedia({ ingested: [], failed: [{ id: "g", name: "(缺失) gone.mp3" }] }, media, deps), null);
    assert.equal(notified.length, 1);
    assert.equal(bodies.length, 1);
  } finally { stopTarget(); }
});

test("MP-U3 不是共享项目、或没有入队的口子:什么都不做", async () => {
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

test("MP-U4 共享项目但等不到上传目标(本机就是主机、签不到 rw 票据):不入队、不提示", async () => {
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
