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

test("Order of media recovery: already in the content store → the originally recorded local path → declared missing only if neither exists", async () => {
  actions.newProject("Order");
  const inLib = actions.addMedia({ kind: "video", name: "in-lib.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "C:/gone/in-lib.mp4" });
  const byPath = actions.addMedia({ kind: "video", name: "by-path.mp4", url: `/@media/${H("b")}`, hash: H("b"), path: "D:/pc/media/by-path.mp4" });
  const nowhere = actions.addMedia({ kind: "image", name: "nowhere.png", url: `/@media/${H("c")}`, hash: H("c"), path: "C:/gone/nowhere.png" });
  const noPath = actions.addMedia({ kind: "audio", name: "no-path.mp3", url: `/@media/${H("d")}`, hash: H("d") });
  const ed = editor({ library: [H("a")], files: { "D:/pc/media/by-path.mp4": H("b") } });
  const r = await checkHashedMedia();
  assert.deepEqual(r, { missing: [nowhere.id, noPath.id], restored: [] });
  assert.equal(ed.calls.filter((u) => u.startsWith("/api/media/adopt")).length, 2, "Media already in the content store does not touch the path; media without a path is not queried");
  assert.equal(ed.calls.some((u) => u.includes(encodeURIComponent("C:/gone/in-lib.mp4"))), false);
  for (const m of [inLib, byPath]) { assert.equal(get(m.id).missingMaterial, undefined); assert.equal(get(m.id).name, m.name); }
  assert.equal(confirmedMissing(get(nowhere.id)), true); assert.equal(confirmedMissing(get(noPath.id)), true);
  assert.deepEqual([confirmedMissingVisual(get(nowhere.id)), confirmedMissingAudio(get(nowhere.id))], [true, false], "An image has only visuals");
  assert.deepEqual([confirmedMissingVisual(get(noPath.id)), confirmedMissingAudio(get(noPath.id))], [false, true], "Sound media has only sound");
  assert.deepEqual(takeMissingMaterials(), [{ id: nowhere.id, name: "nowhere.png", kind: "image" }, { id: noPath.id, name: "no-path.mp3", kind: "audio" }], "The dialog lists the original name");
});

test("The file at the original location changed (hash mismatch): the original media is still declared missing, and the dialog explains it separately", async () => {
  actions.newProject("Content changed");
  const m = actions.addMedia({ kind: "video", name: "edited.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "D:/pc/media/edited.mp4" });
  editor({ files: { "D:/pc/media/edited.mp4": H("9") } });
  assert.deepEqual(await checkHashedMedia(), { missing: [m.id], restored: [] });
  assert.equal(get(m.id).hash, H("a"), "The original hash is kept; other content is not substituted");
  assert.deepEqual([confirmedMissingVisual(get(m.id)), confirmedMissingAudio(get(m.id))], [true, true], "Video: both picture and sound count as missing");
  assert.deepEqual(takeMissingMaterials(), [{ id: m.id, name: "edited.mp4", kind: "video", changed: true }]);
});

test("Unclear cases are not declared missing: the editor process does not respond, the API errors; the clip arrangement is untouched", async () => {
  actions.newProject("Unclear");
  const m = actions.addMedia({ kind: "audio", name: "voice.mp3", url: `/@media/${H("a")}`, hash: H("a") });
  const u = actions.addMedia({ kind: "audio", name: "old.mp3", url: fileUrl("C:/m/old.mp3"), path: "C:/m/old.mp3" });
  const track = actions.addTrack("Voiceover");
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
  assert.equal(JSON.stringify(getState().project.tracks), clips, "Declaring media missing does not move clip positions or the arrangement");
});

test("After saving and reopening, the record still matches (the placeholder is still there), no dialog appears again; the placeholder shows the original name", async () => {
  actions.newProject("Save and reopen");
  const hashed = actions.addMedia({ kind: "video", name: "Scene: Interview (1).mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "C:/A/media/x.mp4" });
  actions.addMedia({ kind: "audio", name: "narration.wav", url: fileUrl("C:/A/media/narration.wav"), path: "C:/A/media/narration.wav" });
  const bare = actions.addMedia({ kind: "image", name: "(missing) 封面.png", url: "" }); // 打开老文件时已被清空地址的那种
  actions.addMedia({ kind: "audio", name: "Scene: Interview (1).mp4", url: `/@media/${H("a")}`, hash: H("a"), soundOf: hashed.id });
  editor({});
  await ingestUnhashedMedia({ background: true, markMissing: true }); await checkHashedMedia();
  assert.equal(takeMissingMaterials().length, 4);
  assert.equal(get(bare.id).url, "/@media/__missing__", "Media with no clues at all is also declared missing, and the URL is not left empty (the sound manifest does not accept empty URLs)");
  for (const external of [true, false]) {
    const media = reopen(external);
    for (const m of media) assert.equal(confirmedMissing(m), true, `${m.name} external=${external}`);
    assert.deepEqual(media.map((m) => m.url), getState().project.media.map((m) => m.url), "The URL is unchanged after reopening");
    assert.equal(confirmedMissingAudio(media[3], { media }), true, "A sound derived from a missing video is missing along with it");
  }
  // 再检查一轮(重开之后的后台检查):不重复写、不重复弹
  const before = getState().project.media;
  await ingestUnhashedMedia({ markMissing: true }); await checkHashedMedia();
  assert.equal(getState().project.media, before, "Media already declared missing does not get a new object");
  assert.deepEqual(takeMissingMaterials(), []);
});

test("A file from an old version that only added the \"(missing) \" marker and cleared the URL: the record is added after opening", async () => {
  actions.newProject("Old marker");
  const m = actions.addMedia({ kind: "video", name: "(missing) old.mp4", url: "", hash: H("a") });
  editor({});
  assert.deepEqual(await checkHashedMedia(), { missing: [m.id], restored: [] });
  assert.equal(get(m.id).url, `/@media/${H("a")}`); assert.equal(get(m.id).name, "(missing) old.mp4");
  assert.equal(confirmedMissing(get(m.id)), true);
  assert.deepEqual(takeMissingMaterials(), [{ id: m.id, name: "old.mp4", kind: "video" }]);
});

// 占位上要显示原名、不带标记。标记是写进素材名字里的,现在由 tr("(missing) ") 写;
// 而 src/audio/missingMaterialRecord.ts 的 missingMaterialLabel 还只认「(缺失) 」,所以占位上会带着 "(missing) "。
test("The placeholder shows the original name, without the missing marker", async () => {
  actions.newProject("占位原名");
  const hashed = actions.addMedia({ kind: "video", name: "Scene: Interview (1).mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "C:/A/media/x.mp4" });
  actions.addMedia({ kind: "audio", name: "narration.wav", url: fileUrl("C:/A/media/narration.wav"), path: "C:/A/media/narration.wav" });
  actions.addMedia({ kind: "image", name: "(missing) 封面.png", url: "" });
  actions.addMedia({ kind: "audio", name: "Scene: Interview (1).mp4", url: `/@media/${H("a")}`, hash: H("a"), soundOf: hashed.id });
  editor({});
  await ingestUnhashedMedia({ background: true, markMissing: true }); await checkHashedMedia();
  const media = reopen(true);
  assert.deepEqual(media.map(missingMaterialLabel), ["Scene: Interview (1).mp4", "narration.wav", "cover.png", "Scene: Interview (1).mp4"]);
});

test("Files from old versions that only got the Chinese \"(缺失) \" marker and lost their address: the record is added on open and the marker is not stacked", async () => {
  actions.newProject("旧标记-中文");
  const m = actions.addMedia({ kind: "video", name: "(missing) old.mp4", url: "", hash: H("a") });
  editor({});
  await checkHashedMedia();
  assert.equal(get(m.id).name, "(missing) old.mp4");
});

test("After media is found again, the record is cleared (the placeholder disappears): it is in the content store now, it was put back at the original path, or an old media without a hash can be fetched", async () => {
  actions.newProject("Found again");
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
  assert.equal(notified, 0, "No dialog when found again"); off();
});

test("All media present / partly missing / all missing", async () => {
  const build = () => {
    actions.newProject("Matrix");
    return [
      actions.addMedia({ kind: "video", name: "v.mp4", url: `/@media/${H("a")}`, hash: H("a") }),
      actions.addMedia({ kind: "audio", name: "s.mp3", url: `/@media/${H("b")}`, hash: H("b") }),
      actions.addMedia({ kind: "image", name: "i.png", url: `/@media/${H("c")}`, hash: H("c") }),
    ];
  };
  for (const [label, library, missing] of [["All present", [H("a"), H("b"), H("c")], []], ["Partly missing", [H("a")], [1, 2]], ["All missing", [], [0, 1, 2]]]) {
    resetTierBackfillForTest(); takeMissingMaterials();
    const media = build(); editor({ library });
    const r = await checkHashedMedia();
    assert.deepEqual(r.missing, missing.map((i) => media[i].id), label);
    assert.deepEqual(media.map((m) => confirmedMissing(get(m.id))), [0, 1, 2].map((i) => missing.includes(i)), label);
    assert.deepEqual(takeMissingMaterials().map((n) => n.name), missing.map((i) => media[i].name), label);
    assert.equal(getState().project.media.length, 3, "No media entry is lost");
  }
});

/* ---------------- 还带着协作关联的文件不认定;检查中途换了项目不乱写 ---------------- */

const { startTierBackfill } = await import(srcUrl("editor/io/mediaUpload.ts"));
const { publishGoneConversion, takeGoneNotices } = await import(srcUrl("editor/sync/recoveryAssociation.ts"));
const waitFor = async (cond, ms = 6000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); return cond(); };

test("Still carries a collaboration link but just isn't connected (offline, needs authentication, waiting for the host): not declared missing, no dialog, project unchanged; it is judged only after being proven to have become a local project", async () => {
  actions.newProject("With link");
  const hashed = actions.addMedia({ kind: "video", name: "remote-only.mp4", url: `/@media/${H("a")}`, hash: H("a") });
  const old = actions.addMedia({ kind: "audio", name: "remote-only.mp3", url: fileUrl("C:/remote/a.mp3"), path: "C:/remote/a.mp3" });
  const ed = editor({});
  let associated = true, seen = 0;
  const before = getState().project;
  const stop = startTierBackfill({ shared: () => false, associated: () => associated, afterIngest: () => { seen++; } });
  try {
    assert.equal(await waitFor(() => seen === 1), true);
    assert.equal(getState().project, before, "The project object was not replaced: nothing was written (so nothing will sync to other members after reconnecting)");
    for (const m of [hashed, old]) { assert.equal(get(m.id).missingMaterial, undefined); assert.equal(get(m.id).name, m.name); }
    assert.deepEqual(takeMissingMaterials(), [], "No dialog");
    assert.equal(ed.calls.some((u) => u.startsWith("/api/media/local?")), false, "Hashed media is not even queried");
    // 文档服务证明项目已不存在、转成了本地项目:素材表没换,但要重新判一遍
    associated = false;
    publishGoneConversion({ projectId: getState().project.id, name: "With link", from: { v: 1, roomId: `sp_${"a".repeat(26)}`, service: "https://x.example", authorityId: "doc", tombstoneRevision: 1, kid: "k", convertedAt: "t" } });
    takeGoneNotices();
    assert.equal(await waitFor(() => confirmedMissing(get(hashed.id)) && confirmedMissing(get(old.id))), true, "Declared missing after conversion to a local project");
    assert.equal(takeMissingMaterials().length, 2);
  } finally { stop(); }
});

test("The project was switched midway through the check (the same file entered a cloud project, with the same media id): this round's conclusions are not written into the new project", async () => {
  actions.newProject("Switch project");
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
  assert.equal(getState().project, after, "Not a single field of the new project was written");
  assert.equal(getState().project.media.some((m) => m.missingMaterial || m.name.startsWith("(missing)")), false);
  assert.deepEqual(takeMissingMaterials(), []);
});

/* ---------------- 只有明确的「没有」才认定;没读成(没权限、5xx、限速)不认定 ---------------- */

const { mediaVerdictOf } = await import(srcUrl("editor/io/mediaUpload.ts"));

test("Verdict: 404, page fallback, and a path not in the asset catalog mean \"absent\"; any other non-2xx is unclear", () => {
  const res = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  assert.equal(mediaVerdictOf(res(200, { "content-type": "video/mp4" })), "found");
  assert.equal(mediaVerdictOf(res(200, { "content-type": "text/html; charset=utf-8" })), "absent", "A response that falls back to the page is not media");
  assert.equal(mediaVerdictOf(res(404)), "absent");
  assert.equal(mediaVerdictOf(res(403, { "x-pc-media-verdict": "outside" })), "outside");
  for (const status of [400, 401, 403, 408, 409, 423, 429, 500, 502, 503, 507]) assert.equal(mediaVerdictOf(res(status)), "unsure", String(status));
});

test("Failing to read does not declare missing: original path 403 (not the \"not in the asset catalog\" kind), 500, 503, 429; the same for the read API", async () => {
  for (const status of [403, 500, 503, 429]) {
    resetTierBackfillForTest(); takeMissingMaterials();
    actions.newProject(`Read failed-${status}`);
    const hashed = actions.addMedia({ kind: "video", name: "h.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "D:/pc/media/h.mp4" });
    const old = actions.addMedia({ kind: "audio", name: "o.mp3", url: fileUrl("D:/pc/media/o.mp3"), path: "D:/pc/media/o.mp3" });
    editor({ adoptFail: status, fileStatus: status });
    assert.deepEqual(await checkHashedMedia(), { missing: [], restored: [] }, `With hash ${status}`);
    const r = await ingestUnhashedMedia({ markMissing: true });
    assert.equal(r.failed[0].unreachable, undefined, `Old media ${status}`);
    for (const m of [hashed, old]) { assert.equal(get(m.id).missingMaterial, undefined, `${m.name} ${status}`); assert.equal(get(m.id).name, m.name); }
    assert.deepEqual(takeMissingMaterials(), []);
  }
  // 对照:同样的两条,回答是明确的「没有」时才认定
  resetTierBackfillForTest();
  actions.newProject("Definitely absent");
  const hashed = actions.addMedia({ kind: "video", name: "h.mp4", url: `/@media/${H("a")}`, hash: H("a"), path: "D:/pc/media/h.mp4" });
  const old = actions.addMedia({ kind: "audio", name: "o.mp3", url: fileUrl("D:/pc/media/o.mp3"), path: "D:/pc/media/o.mp3" });
  editor({ adoptFail: 404, fileStatus: 404 });
  assert.deepEqual((await checkHashedMedia()).missing, [hashed.id]);
  assert.equal((await ingestUnhashedMedia({ markMissing: true })).failed[0].unreachable, true);
  assert.equal(confirmedMissing(get(hashed.id)) && confirmedMissing(get(old.id)), true);
  // 原路径没读成、读接口明确没有:仍然说不清(文件可能就在那儿)
  resetTierBackfillForTest();
  actions.newProject("Half unclear");
  const mixed = actions.addMedia({ kind: "audio", name: "m.mp3", url: fileUrl("D:/pc/media/m.mp3"), path: "D:/pc/media/m.mp3" });
  editor({ adoptFail: 500, fileStatus: 404 });
  assert.equal((await ingestUnhashedMedia({ markMissing: true })).failed[0].unreachable, undefined);
  assert.equal(get(mixed.id).missingMaterial, undefined);
});

test("Renaming missing media: the name in the record changes too, the placeholder stays valid and shows the new name; it still matches after saving and reopening", async () => {
  actions.newProject("Renamed");
  const m = actions.addMedia({ kind: "video", name: "old-name.mp4", url: `/@media/${H("a")}`, hash: H("a") });
  editor({});
  await checkHashedMedia(); takeMissingMaterials();
  assert.equal(confirmedMissing(get(m.id)), true);
  actions.updateMedia(m.id, { name: "new-name.mp4" });
  assert.equal(confirmedMissing(get(m.id)), true, "Still confirmed missing after renaming");
  assert.equal(get(m.id).missingMaterial.original.name, "new-name.mp4");
  assert.equal(missingMaterialLabel(get(m.id)), "new-name.mp4");
  assert.equal(confirmedMissing(reopen(true)[0]), true);
  // 记录与素材对不上的(别处直接改了素材而没带上记录):不算确认缺失,各处一致地照普通素材办
  const stale = { ...get(m.id), name: "renamed-elsewhere.mp4" };
  assert.equal(confirmedMissing(stale), false);
  // 再检查一轮会重新认定并把记录写对
  resetTierBackfillForTest(); editor({});
  await checkHashedMedia();
  assert.equal(confirmedMissing(get(m.id)), true);
});
