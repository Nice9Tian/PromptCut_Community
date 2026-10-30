/**
 * 谁把一份素材认定为「确认缺失」(`mediaUpload.ts` 打开本机项目后的后台检查),以及认定之后:
 * 弹窗列项的通知、保存重开后记录还对得上、素材找回来以后记录清掉。
 * 对应 `docs/plan/account-binding-task.md`「逐项验收」的「缺失视觉/音频素材」一行里不需要页面的部分;
 * 素材全在 / 部分缺 / 全缺三格在最后一条。
 *
 * `fetch` 换成假的编辑器进程:`/api/media/local`(内容库里有哪些哈希)、`/api/media/adopt`(按原路径找)、读接口。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { checkHashedMedia, ingestUnhashedMedia, resetTierBackfillForTest } = await import(srcUrl("editor/io/mediaUpload.ts"));
const { restoreMediaUrls } = await import(srcUrl("editor/io/mediaUrls.ts"));
const { takeMissingMaterials, onMissingMaterials } = await import(srcUrl("editor/io/missingMaterialBus.ts"));
const { confirmedMissing, confirmedMissingAudio, confirmedMissingVisual, missingMaterialLabel } = await import(srcUrl("audio/missingMaterialRecord.ts"));

const H = (c) => c.repeat(64);
const get = (id) => getState().project.media.find((m) => m.id === id);
const fileUrl = (p) => `/api/media/file?path=${encodeURIComponent(p)}`;

/** 假编辑器进程。`library`:内容库里有的哈希;`files`:原路径 → 那里的文件现在的哈希;`down`:整个进程不应答 */
function editor({ library = [], files = {}, down = false, localStatus = 200, adoptFail = null, fileStatus = 404 } = {}) {
  const calls = [];
  const lib = new Set(library);
  globalThis.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (down) throw new TypeError("fetch failed");
    if (u.startsWith("/api/media/local?")) {
      if (localStatus !== 200) return new Response("busy", { status: localStatus });
      const asked = new URL(u, "http://x").searchParams.get("hashes").split(",");
      return Response.json({ ok: true, hashes: asked.filter((h) => lib.has(h)) });
    }
    if (u.startsWith("/api/media/adopt")) {
      const p = new URL(u, "http://x").searchParams.get("path");
      const hash = files[p];
      if (!hash && adoptFail) return new Response("failed", { status: adoptFail });
      if (!hash) return new Response("Media path is outside PromptCut media folders", { status: 403, headers: { "X-PC-Media-Verdict": "outside" } });
      lib.add(hash); // 就地挂进内容库
      return Response.json({ ok: true, hash, ext: p.split(".").pop(), name: p.split(/[/\\]/).pop(), path: p, url: `/@media/${hash}`, bytes: 10 });
    }
    if (u.startsWith("/api/media/file?")) return new Response("not found", { status: fileStatus });
    if (u.startsWith("/@media/")) return new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
    return new Response(null, { status: 404 });
  };
  return { calls, lib };
}

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; resetTierBackfillForTest(); takeMissingMaterials(); });
afterEach(() => { globalThis.fetch = realFetch; resetTierBackfillForTest(); });

/** 存盘再打开:过一遍 JSON,再过打开文件时还原地址的那一步(两种路径写法都试) */
const reopen = (external) => restoreMediaUrls(JSON.parse(JSON.stringify(getState().project.media)), { externalPathUrl: external }).media;

test("素材找回的先后:内容库里已有 → 原来记的本机路径 → 都没有才认定缺失", async () => {
  actions.newProject("先后");
  const inLib = actions.addMedia({ kind: "video", name: "in-lib.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "C:/gone/in-lib.mp4" });
  const byPath = actions.addMedia({ kind: "video", name: "by-path.mp4", url: `/@media/${H("b")}`, hash: H("b"), path: "D:/pc/media/by-path.mp4" });
  const nowhere = actions.addMedia({ kind: "image", name: "nowhere.png", url: `/@media/${H("c")}`, hash: H("c"), path: "C:/gone/nowhere.png" });
  const noPath = actions.addMedia({ kind: "audio", name: "no-path.mp3", url: `/@media/${H("d")}`, hash: H("d") });
  const ed = editor({ library: [H("a")], files: { "D:/pc/media/by-path.mp4": H("b") } });
  const r = await checkHashedMedia();
  assert.deepEqual(r, { missing: [nowhere.id, noPath.id], restored: [] });
  assert.equal(ed.calls.filter((u) => u.startsWith("/api/media/adopt")).length, 2, "内容库里有的不去碰路径;没有路径的不问");
  assert.equal(ed.calls.some((u) => u.includes(encodeURIComponent("C:/gone/in-lib.mp4"))), false);
  for (const m of [inLib, byPath]) { assert.equal(get(m.id).missingMaterial, undefined); assert.equal(get(m.id).name, m.name); }
  assert.equal(confirmedMissing(get(nowhere.id)), true); assert.equal(confirmedMissing(get(noPath.id)), true);
  assert.deepEqual([confirmedMissingVisual(get(nowhere.id)), confirmedMissingAudio(get(nowhere.id))], [true, false], "图片只有画面");
  assert.deepEqual([confirmedMissingVisual(get(noPath.id)), confirmedMissingAudio(get(noPath.id))], [false, true], "声音素材只有声音");
  assert.deepEqual(takeMissingMaterials(), [{ id: nowhere.id, name: "nowhere.png", kind: "image" }, { id: noPath.id, name: "no-path.mp3", kind: "audio" }], "弹窗列的是原名");
});

test("原位置的文件内容变了(哈希对不上):原素材仍认定缺失,弹窗里单独说明", async () => {
  actions.newProject("内容变了");
  const m = actions.addMedia({ kind: "video", name: "edited.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "D:/pc/media/edited.mp4" });
  editor({ files: { "D:/pc/media/edited.mp4": H("9") } });
  assert.deepEqual(await checkHashedMedia(), { missing: [m.id], restored: [] });
  assert.equal(get(m.id).hash, H("a"), "原哈希留着,不拿别的内容顶替");
  assert.deepEqual([confirmedMissingVisual(get(m.id)), confirmedMissingAudio(get(m.id))], [true, true], "视频:画面和声音都按缺失");
  assert.deepEqual(takeMissingMaterials(), [{ id: m.id, name: "edited.mp4", kind: "video", changed: true }]);
});

test("说不清的不认定:编辑器进程不应答、接口报错;片段编排不动", async () => {
  actions.newProject("说不清");
  const m = actions.addMedia({ kind: "audio", name: "voice.mp3", url: `/@media/${H("a")}`, hash: H("a") });
  const u = actions.addMedia({ kind: "audio", name: "old.mp3", url: fileUrl("C:/m/old.mp3"), path: "C:/m/old.mp3" });
  const track = actions.addTrack("配音");
  actions.addMediaClip(m.id, 2, { trackId: track.id, duration: 3 });
  const clips = JSON.stringify(getState().project.tracks);
  for (const world of [{ down: true }, { localStatus: 500 }, { localStatus: 429 }]) {
    editor(world);
    assert.deepEqual(await checkHashedMedia(), { missing: [], restored: [] }, JSON.stringify(world));
    if (world.down) { const r = await ingestUnhashedMedia({ markMissing: true }); assert.equal(r.failed[0].unreachable, undefined); }
    for (const x of [m, u]) { assert.equal(get(x.id).missingMaterial, undefined); assert.equal(get(x.id).name, x.name); assert.equal(get(x.id).url, x.url); }
  }
  assert.deepEqual(takeMissingMaterials(), []);
  editor({});
  await checkHashedMedia(); await ingestUnhashedMedia({ markMissing: true });
  assert.equal(confirmedMissing(get(m.id)), true); assert.equal(confirmedMissing(get(u.id)), true);
  assert.equal(JSON.stringify(getState().project.tracks), clips, "认定缺失不动片段的位置和编排");
});

test("保存重开后记录还对得上(占位还在),不再弹窗;占位上显示原名", async () => {
  actions.newProject("保存重开");
  const hashed = actions.addMedia({ kind: "video", name: "场景:访谈(一).mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "C:/A/media/x.mp4" });
  actions.addMedia({ kind: "audio", name: "旁白.wav", url: fileUrl("C:/A/media/旁白.wav"), path: "C:/A/media/旁白.wav" });
  const bare = actions.addMedia({ kind: "image", name: "(缺失) 封面.png", url: "" }); // 打开老文件时已被清空地址的那种
  actions.addMedia({ kind: "audio", name: "场景:访谈(一).mp4", url: `/@media/${H("a")}`, hash: H("a"), soundOf: hashed.id });
  editor({});
  await ingestUnhashedMedia({ background: true, markMissing: true }); await checkHashedMedia();
  assert.equal(takeMissingMaterials().length, 4);
  assert.equal(get(bare.id).url, "/@media/__missing__", "没有任何线索的也认定缺失,地址不留空(出声清单不收空地址)");
  for (const external of [true, false]) {
    const media = reopen(external);
    for (const m of media) assert.equal(confirmedMissing(m), true, `${m.name} external=${external}`);
    assert.deepEqual(media.map((m) => m.url), getState().project.media.map((m) => m.url), "重开后地址不变");
    assert.deepEqual(media.map(missingMaterialLabel), ["场景:访谈(一).mp4", "旁白.wav", "封面.png", "场景:访谈(一).mp4"], "占位上是原名,不带「(缺失) 」");
    assert.equal(confirmedMissingAudio(media[3], { media }), true, "从缺失视频派生的声音跟着出人声");
  }
  // 再检查一轮(重开之后的后台检查):不重复写、不重复弹
  const before = getState().project.media;
  await ingestUnhashedMedia({ markMissing: true }); await checkHashedMedia();
  assert.equal(getState().project.media, before, "已经认定过的不换对象");
  assert.deepEqual(takeMissingMaterials(), []);
});

test("旧版本只加了「(缺失) 」标记、清空了地址的文件:打开后补上记录", async () => {
  actions.newProject("旧标记");
  const m = actions.addMedia({ kind: "video", name: "(缺失) old.mp4", url: "", hash: H("a") });
  editor({});
  assert.deepEqual(await checkHashedMedia(), { missing: [m.id], restored: [] });
  assert.equal(get(m.id).url, `/@media/${H("a")}`); assert.equal(get(m.id).name, "(缺失) old.mp4");
  assert.equal(confirmedMissing(get(m.id)), true);
  assert.deepEqual(takeMissingMaterials(), [{ id: m.id, name: "old.mp4", kind: "video" }]);
});

test("素材找回来以后记录清掉(占位消失):内容库里有了、原路径上放回来了、没哈希的老素材取得到了", async () => {
  actions.newProject("找回来");
  const a = actions.addMedia({ kind: "video", name: "a.mp4", url: `/@media/${H("a")}`, hash: H("a") });
  const b = actions.addMedia({ kind: "audio", name: "b.mp3", url: `/@media/${H("b")}`, hash: H("b"), path: "D:/pc/media/b.mp3" });
  const c = actions.addMedia({ kind: "audio", name: "c.mp3", url: fileUrl("D:/pc/media/c.mp3"), path: "D:/pc/media/c.mp3" });
  editor({});
  await ingestUnhashedMedia({ markMissing: true }); await checkHashedMedia();
  assert.deepEqual([a, b, c].map((m) => confirmedMissing(get(m.id))), [true, true, true]); takeMissingMaterials();
  let notified = 0; const off = onMissingMaterials(() => { notified++; });
  resetTierBackfillForTest();
  editor({ library: [H("a")], files: { "D:/pc/media/b.mp3": H("b"), "D:/pc/media/c.mp3": H("c") } });
  const ingested = await ingestUnhashedMedia({ markMissing: true });
  assert.deepEqual(ingested.ingested, [c.id]);
  assert.deepEqual(await checkHashedMedia(), { missing: [], restored: [a.id, b.id] });
  for (const [m, url] of [[a, `/@media/${H("a")}`], [b, `/@media/${H("b")}`], [c, `/@media/${H("c")}`]]) {
    assert.equal(get(m.id).missingMaterial, undefined, m.name); assert.equal(get(m.id).name, m.name); assert.equal(get(m.id).url, url);
    assert.equal(confirmedMissing(get(m.id)), false);
  }
  assert.equal(notified, 0, "找回来不弹窗"); off();
});

test("素材全在 / 部分缺 / 全缺", async () => {
  const build = () => {
    actions.newProject("矩阵");
    return [
      actions.addMedia({ kind: "video", name: "v.mp4", url: `/@media/${H("a")}`, hash: H("a") }),
      actions.addMedia({ kind: "audio", name: "s.mp3", url: `/@media/${H("b")}`, hash: H("b") }),
      actions.addMedia({ kind: "image", name: "i.png", url: `/@media/${H("c")}`, hash: H("c") }),
    ];
  };
  for (const [label, library, missing] of [["全在", [H("a"), H("b"), H("c")], []], ["部分缺", [H("a")], [1, 2]], ["全缺", [], [0, 1, 2]]]) {
    resetTierBackfillForTest(); takeMissingMaterials();
    const media = build(); editor({ library });
    const r = await checkHashedMedia();
    assert.deepEqual(r.missing, missing.map((i) => media[i].id), label);
    assert.deepEqual(media.map((m) => confirmedMissing(get(m.id))), [0, 1, 2].map((i) => missing.includes(i)), label);
    assert.deepEqual(takeMissingMaterials().map((n) => n.name), missing.map((i) => media[i].name), label);
    assert.equal(getState().project.media.length, 3, "素材条目一条不少");
  }
});

/* ---------------- 还带着协作关联的文件不认定;检查中途换了项目不乱写 ---------------- */

const { startTierBackfill } = await import(srcUrl("editor/io/mediaUpload.ts"));
const { publishGoneConversion, takeGoneNotices } = await import(srcUrl("editor/sync/recoveryAssociation.ts"));
const waitFor = async (cond, ms = 6000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); return cond(); };

test("还带着协作关联、只是没连上(断网、要认证、等主机):不认定、不弹窗、项目不被改;被证明转成本地项目后才判", async () => {
  actions.newProject("带着关联");
  const hashed = actions.addMedia({ kind: "video", name: "只在远端.mp4", url: `/@media/${H("a")}`, hash: H("a") });
  const old = actions.addMedia({ kind: "audio", name: "只在远端.mp3", url: fileUrl("C:/remote/a.mp3"), path: "C:/remote/a.mp3" });
  const ed = editor({});
  let associated = true, seen = 0;
  const before = getState().project;
  const stop = startTierBackfill({ shared: () => false, associated: () => associated, afterIngest: () => { seen++; } });
  try {
    assert.equal(await waitFor(() => seen === 1), true);
    assert.equal(getState().project, before, "项目对象没换:没有任何写入(也就没有东西会在重连后同步给别的成员)");
    for (const m of [hashed, old]) { assert.equal(get(m.id).missingMaterial, undefined); assert.equal(get(m.id).name, m.name); }
    assert.deepEqual(takeMissingMaterials(), [], "不弹窗");
    assert.equal(ed.calls.some((u) => u.startsWith("/api/media/local?")), false, "带哈希的连问都不问");
    // 文档服务证明项目已不存在、转成了本地项目:素材表没换,但要重新判一遍
    associated = false;
    publishGoneConversion({ projectId: getState().project.id, name: "带着关联", from: { v: 1, roomId: `sp_${"a".repeat(26)}`, service: "https://x.example", authorityId: "doc", tombstoneRevision: 1, kid: "k", convertedAt: "t" } });
    takeGoneNotices();
    assert.equal(await waitFor(() => confirmedMissing(get(hashed.id)) && confirmedMissing(get(old.id))), true, "转成本地项目之后认定");
    assert.equal(takeMissingMaterials().length, 2);
  } finally { stop(); }
});

test("检查到一半换了项目(同一份文件进了云端项目、素材号相同):这一轮的结论不写进新项目", async () => {
  actions.newProject("换项目");
  const media = { id: "m-same", kind: "video", name: "v.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "D:/pc/media/v.mp4" };
  const oldMedia = { id: "m-old", kind: "audio", name: "o.mp3", url: fileUrl("C:/gone/o.mp3"), path: "C:/gone/o.mp3" };
  actions.addMedia(media); actions.addMedia(oldMedia);
  // 请求挂着不回,趁这时候换项目
  let release; const gate = new Promise((r) => { release = r; });
  const real = editor({});
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => { await gate; return inner(url, init); };
  void real;
  const hashedRun = checkHashedMedia();
  const ingestRun = ingestUnhashedMedia({ markMissing: true });
  actions.loadProject({ ...getState().project, id: "another-project", media: [{ ...media }, { ...oldMedia }] });
  const after = getState().project;
  release();
  assert.deepEqual(await hashedRun, { missing: [], restored: [] });
  await ingestRun;
  assert.equal(getState().project, after, "新项目一个字段都没被写");
  assert.equal(getState().project.media.some((m) => m.missingMaterial || m.name.startsWith("(缺失)")), false);
  assert.deepEqual(takeMissingMaterials(), []);
});

/* ---------------- 只有明确的「没有」才认定;没读成(没权限、5xx、限速)不认定 ---------------- */

const { mediaVerdictOf } = await import(srcUrl("editor/io/mediaUpload.ts"));

test("判词:404、页面回退、路径不在素材目录里是「没有」;别的非 2xx 都是说不清", () => {
  const res = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  assert.equal(mediaVerdictOf(res(200, { "content-type": "video/mp4" })), "found");
  assert.equal(mediaVerdictOf(res(200, { "content-type": "text/html; charset=utf-8" })), "absent", "落到页面回退的不是素材");
  assert.equal(mediaVerdictOf(res(404)), "absent");
  assert.equal(mediaVerdictOf(res(403, { "x-pc-media-verdict": "outside" })), "outside");
  for (const status of [400, 401, 403, 408, 409, 423, 429, 500, 502, 503, 507]) assert.equal(mediaVerdictOf(res(status)), "unsure", String(status));
});

test("没读成不认定:原路径 403(不是「不在素材目录」那种)、500、503、429;读接口同理", async () => {
  for (const status of [403, 500, 503, 429]) {
    resetTierBackfillForTest(); takeMissingMaterials();
    actions.newProject(`没读成-${status}`);
    const hashed = actions.addMedia({ kind: "video", name: "h.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "D:/pc/media/h.mp4" });
    const old = actions.addMedia({ kind: "audio", name: "o.mp3", url: fileUrl("D:/pc/media/o.mp3"), path: "D:/pc/media/o.mp3" });
    editor({ adoptFail: status, fileStatus: status });
    assert.deepEqual(await checkHashedMedia(), { missing: [], restored: [] }, `带哈希 ${status}`);
    const r = await ingestUnhashedMedia({ markMissing: true });
    assert.equal(r.failed[0].unreachable, undefined, `老素材 ${status}`);
    for (const m of [hashed, old]) { assert.equal(get(m.id).missingMaterial, undefined, `${m.name} ${status}`); assert.equal(get(m.id).name, m.name); }
    assert.deepEqual(takeMissingMaterials(), []);
  }
  // 对照:同样的两条,回答是明确的「没有」时才认定
  resetTierBackfillForTest();
  actions.newProject("明确没有");
  const hashed = actions.addMedia({ kind: "video", name: "h.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "D:/pc/media/h.mp4" });
  const old = actions.addMedia({ kind: "audio", name: "o.mp3", url: fileUrl("D:/pc/media/o.mp3"), path: "D:/pc/media/o.mp3" });
  editor({ adoptFail: 404, fileStatus: 404 });
  assert.deepEqual((await checkHashedMedia()).missing, [hashed.id]);
  assert.equal((await ingestUnhashedMedia({ markMissing: true })).failed[0].unreachable, true);
  assert.equal(confirmedMissing(get(hashed.id)) && confirmedMissing(get(old.id)), true);
  // 原路径没读成、读接口明确没有:仍然说不清(文件可能就在那儿)
  resetTierBackfillForTest();
  actions.newProject("一半说不清");
  const mixed = actions.addMedia({ kind: "audio", name: "m.mp3", url: fileUrl("D:/pc/media/m.mp3"), path: "D:/pc/media/m.mp3" });
  editor({ adoptFail: 500, fileStatus: 404 });
  assert.equal((await ingestUnhashedMedia({ markMissing: true })).failed[0].unreachable, undefined);
  assert.equal(get(mixed.id).missingMaterial, undefined);
});

test("缺失素材改名:记录里的名字跟着改,占位不失效,占位上显示新名字;存盘重开仍然对得上", async () => {
  actions.newProject("改名");
  const m = actions.addMedia({ kind: "video", name: "旧名字.mp4", url: `/@media/${H("a")}`, hash: H("a") });
  editor({});
  await checkHashedMedia(); takeMissingMaterials();
  assert.equal(confirmedMissing(get(m.id)), true);
  actions.updateMedia(m.id, { name: "新名字.mp4" });
  assert.equal(confirmedMissing(get(m.id)), true, "改名后仍是确认缺失");
  assert.equal(get(m.id).missingMaterial.original.name, "新名字.mp4");
  assert.equal(missingMaterialLabel(get(m.id)), "新名字.mp4");
  assert.equal(confirmedMissing(reopen(true)[0]), true);
  // 记录与素材对不上的(别处直接改了素材而没带上记录):不算确认缺失,各处一致地照普通素材办
  const stale = { ...get(m.id), name: "别处改的.mp4" };
  assert.equal(confirmedMissing(stale), false);
  // 再检查一轮会重新认定并把记录写对
  resetTierBackfillForTest(); editor({});
  await checkHashedMedia();
  assert.equal(confirmedMissing(get(m.id)), true);
});
