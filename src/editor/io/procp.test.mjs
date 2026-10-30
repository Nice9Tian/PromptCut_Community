// .procp 打包件:zip 字节格式、首条目、按哈希去重、以及别的 zip 工具压出来的 deflate 条目。
//   node --test src/editor/io/procp.test.mjs
//
// procp.ts 顶上只有类型 import(store 和 proc.ts 都是函数里动态 import 的),
// 所以这里可以直接加载它;装包本体是 packProcpFrom(procText, project),不碰 store。
// 服务端那一侧(本地内容库)用一个假的 fetch 顶上:内容按 sha256 入库,和
// server/vite-plugin-media.ts 的 storeMediaStream 是同一套规矩。
import { srcUrl } from "../../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const { packProcpFrom, unpackProcp, readZip, inflate, isProcpFile, PROCP_EXT, mediaEntries, packMissingMessage } = await import("./procp.ts");
const { actions, getState } = await import(srcUrl("store/project.ts"));
const { ingestUnhashedMedia, resetTierBackfillForTest } = await import(srcUrl("editor/io/mediaUpload.ts"));
const { restoreMediaUrls } = await import(srcUrl("editor/io/mediaUrls.ts"));

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** 假的本地内容库 + 假 fetch:只认 procp.ts 用到的那三条路由 */
/** 假的素材目录(服务端 allowedMediaRoots 里的那一个)与本地内容库的落点 */
const MEDIA_ROOT = "C:/Users/u/Videos/PromptCut/media";
const STORE_DIR = "C:/pc/out/media";
const norm = (p) => String(p).replace(/\\/g, "/");
const inRoot = (p) => norm(p).toLowerCase().startsWith(MEDIA_ROOT.toLowerCase() + "/");

function fakeStore() {
  /** hash -> {bytes, ext} */
  const store = new Map();
  /** 假磁盘:素材目录里的老文件,绝对路径(正斜杠) -> bytes */
  const disk = new Map();
  const realFetch = globalThis.fetch;
  const addToStore = (bytes, name) => {
    const hash = sha256(bytes);
    const ext = (name.split(".").pop() || "").toLowerCase();
    const deduped = store.has(hash);
    if (!deduped) store.set(hash, { bytes, ext });
    return { ok: true, hash, ext, name, path: `${STORE_DIR}/${hash}.${ext}`, url: `/@media/${hash}`, bytes: bytes.length, deduped };
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("/@media/")) {
      const raw = decodeURIComponent(u.slice("/@media/".length).split("?")[0]);
      const hash = raw.split(".")[0].toLowerCase();
      if (/^[0-9a-f]{64}$/.test(hash)) {
        const hit = store.get(hash);
        if (!hit) return new Response(null, { status: 404 });
        return new Response(hit.bytes, { status: 200 });
      }
      // 迁移期的 /@media/<文件名>:素材目录里按文件名找
      const bytes = disk.get(`${MEDIA_ROOT}/${raw}`);
      return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 });
    }
    // POST /api/media/adopt?path=:只收素材目录内的路径,就地算哈希挂进内容库
    if (u.startsWith("/api/media/adopt")) {
      const p = norm(new URL(u, "http://x").searchParams.get("path") || "");
      if (!inRoot(p)) return new Response("outside", { status: 403 });
      const bytes = disk.get(p);
      if (!bytes) return new Response("ENOENT", { status: 500 });
      return Response.json(addToStore(bytes, p.split("/").pop()));
    }
    // GET /api/media/file?path=:同样只读素材目录内的
    if (u.startsWith("/api/media/file")) {
      const p = norm(new URL(u, "http://x").searchParams.get("path") || "");
      if (!inRoot(p)) return new Response("outside", { status: 403 });
      const bytes = disk.get(p);
      return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 });
    }
    if (u.startsWith("/api/media/local")) {
      const asked = (new URL(u, "http://x").searchParams.get("hashes") || "").split(",").filter(Boolean);
      return Response.json({ ok: true, hashes: asked.filter((h) => store.has(h)) });
    }
    if (u.startsWith("/api/media/upload/")) {
      const name = decodeURIComponent(u.slice("/api/media/upload/".length).split("?")[0]);
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
      // 服务端按**内容**定键,包里条目名写错也污染不了库
      const hash = sha256(bytes);
      const deduped = store.has(hash);
      if (!deduped) store.set(hash, { bytes, ext: (name.split(".").pop() || "").toLowerCase() });
      return Response.json({ ok: true, hash, url: `/@media/${hash}`, bytes: bytes.length, deduped });
    }
    throw new Error(`假 fetch 不认识这条路由: ${u}`);
  };
  return {
    store,
    disk,
    put(bytes, ext) {
      const hash = sha256(bytes);
      store.set(hash, { bytes, ext });
      return hash;
    },
    restore() { globalThis.fetch = realFetch; },
  };
}

const CLIP_A = Buffer.from("fake-mp4-bytes-A-".repeat(40));
const CLIP_B = Buffer.from("fake-png-bytes-B-".repeat(31));
const PROC_TEXT = JSON.stringify({ format: "promptcut-project", version: 1, project: { name: "包测试" } });

function projectWith(hashA, hashB) {
  return {
    name: "包测试",
    media: [
      { id: "m1", kind: "video", name: "a.mp4", ext: "mp4", hash: hashA, url: `/@media/${hashA}` },
      { id: "m2", kind: "image", name: "b.png", ext: "png", hash: hashB, url: `/@media/${hashB}` },
      // 同一份素材被第二条记录引用:包里只该有一份字节
      { id: "m3", kind: "video", name: "a-copy.mp4", ext: "mp4", hash: hashA, url: `/@media/${hashA}` },
      // 迁移期的老素材:没有 hash,装不进包(也不该让整次打包失败)
      { id: "m4", kind: "video", name: "legacy.mp4", url: "/@media/legacy.mp4" },
    ],
  };
}

test("装包:首条目是 project.proc,素材按 <hash>.<ext> 且按哈希去重", async () => {
  const fake = fakeStore();
  try {
    const hashA = fake.put(CLIP_A, "mp4");
    const hashB = fake.put(CLIP_B, "png");
    const { blob, missing } = await packProcpFrom(PROC_TEXT, projectWith(hashA, hashB));
    assert.deepEqual(missing, [{ id: "m4", name: "legacy.mp4" }], "没有哈希的 m4 进不了包,但一定出现在返回的清单里");

    const entries = await readZip(blob);
    assert.equal(entries[0].name, "project.proc", "第一个条目一定是编排,不解压也能 head 出来");
    assert.deepEqual(entries.map((e) => e.name).slice(1).sort(), [`media/${hashA}.mp4`, `media/${hashB}.png`]);
    assert.equal(entries.length, 3, "m3 和 m1 同哈希只装一份;m4 没有哈希,装不进");
    assert.equal(await (await inflate(entries[0])).text(), PROC_TEXT);

    const back = new Map();
    for (const e of entries.slice(1)) back.set(e.name, Buffer.from(await (await inflate(e)).arrayBuffer()));
    assert.equal(back.get(`media/${hashA}.mp4`).equals(CLIP_A), true);
    assert.equal(back.get(`media/${hashB}.png`).equals(CLIP_B), true);

    // 包自己也认得出是包(名字没了也靠 PK\x03\x04)
    assert.equal(await isProcpFile(blob), true);
    assert.equal(await isProcpFile(new Blob([PROC_TEXT])), false);
    assert.equal(await isProcpFile(Object.assign(new Blob([PROC_TEXT]), { name: `x${PROCP_EXT}` })), true);
  } finally {
    fake.restore();
  }
});

test("往返:拆到空库里是新写两份,再拆一次全是去重", async () => {
  const packer = fakeStore();
  let blob;
  let hashA;
  let hashB;
  try {
    hashA = packer.put(CLIP_A, "mp4");
    hashB = packer.put(CLIP_B, "png");
    ({ blob } = await packProcpFrom(PROC_TEXT, projectWith(hashA, hashB)));
  } finally {
    packer.restore();
  }

  // 另一台机器:内容库是空的
  const other = fakeStore();
  try {
    const first = await unpackProcp(blob);
    assert.equal(first.procText, PROC_TEXT);
    assert.equal(first.stored, 2);
    assert.equal(first.deduped, 0);
    assert.equal(other.store.get(hashA).bytes.equals(CLIP_A), true);
    assert.equal(other.store.get(hashB).bytes.equals(CLIP_B), true);

    // 同一个包再拆一次:一份字节都不再传
    const again = await unpackProcp(blob);
    assert.equal(again.stored, 0);
    assert.equal(again.deduped, 2);
    assert.equal(other.store.size, 2);
  } finally {
    other.restore();
  }
});

test("别的 zip 工具压出来的 deflate 条目也读得了", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-procp-"));
  try {
    const text = "PromptCut .procp deflate fixture\n".repeat(400); // 够重复,一定会被压
    const src = path.join(dir, "project.proc");
    const zip = path.join(dir, "made-by-powershell.zip");
    fs.writeFileSync(src, text);
    try {
      // Use the OS zip implementation directly: Archive module autoload depends on the parent shell's module path.
      const zipOutside = `${dir}-external.zip`;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${dir.replaceAll("'", "''")}', '${zipOutside.replaceAll("'", "''")}')`], { stdio: "pipe", windowsHide: true });
      fs.renameSync(zipOutside, zip);
    } catch (err) {
      t.skip(`这台机器上跑不了系统 zip 实现: ${err.message}`);
      return;
    }
    const blob = new Blob([fs.readFileSync(zip)]);
    assert.equal(await isProcpFile(blob), true);
    const entries = await readZip(blob);
    const proc = entries.find((e) => e.name === "project.proc");
    assert.ok(proc, "PowerShell 压的包里应当有 project.proc");
    assert.equal(proc.method, 8, "系统 zip 用的是 deflate,正好验到 method 8 那条路");
    assert.equal(await (await inflate(proc)).text(), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------- 补入库:没有哈希的老素材也要进包(用户真机缺陷:老项目的配音没进 .procp) ------------- */

const VOICE_A = Buffer.from("fake-mp3-voice-A-".repeat(23));
const VOICE_B = Buffer.from("fake-mp3-voice-B-".repeat(29));
const VOICE_C = Buffer.from("fake-mp3-voice-C-".repeat(17));
const CLIP_V = Buffer.from("fake-mp4-video-V-".repeat(37));

/** 编排文本:和 serializeProc 一样把项目放在 project 下(这里只关心素材表) */
const procOf = (project) => JSON.stringify({ format: "promptcut-project", version: 1, project });

test("补入库后装包:带哈希的视频、只有 path 的音频、地址为 /api/media/file?path=… 的音频三份字节都进包,包内 project.proc 三条都带哈希;拆到空库后没有缺失", async () => {
  const fake = fakeStore();
  resetTierBackfillForTest();
  let blob;
  try {
    const hashV = fake.put(CLIP_V, "mp4");
    fake.disk.set(`${MEDIA_ROOT}/voice-a.mp3`, VOICE_A);
    const bPath = `${MEDIA_ROOT}/voice-决赛开场-b.mp3`;
    fake.disk.set(bPath, VOICE_B);
    actions.newProject("补入库");
    actions.addMedia({ kind: "video", name: "v.mp4", ext: "mp4", hash: hashV, url: `/@media/${hashV}` });
    // 老形态:只有 path(Windows 反斜杠)
    const a = actions.addMedia({ kind: "audio", name: "voice-a.mp3", url: "", path: `${MEDIA_ROOT}/voice-a.mp3`.replace(/\//g, "\\") });
    // 0.7.0 / 0.7.1 生成的配音:地址是 /api/media/file?path=…,没有哈希
    const b = actions.addMedia({ kind: "audio", name: "voice-决赛开场-b.mp3", url: `/api/media/file?path=${encodeURIComponent(bPath)}` });
    const oldA = getState().project.media.find((m) => m.id === a.id);

    const r = await ingestUnhashedMedia();
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.ingested.sort(), [a.id, b.id].sort());
    assert.equal(oldA.hash, undefined, "不原地改 store 里的旧对象");
    const media = getState().project.media;
    for (const m of media) assert.match(m.hash, /^[0-9a-f]{64}$/, `${m.name} 补上了哈希`);
    assert.equal(media.find((m) => m.id === a.id).hash, sha256(VOICE_A));
    assert.equal(media.find((m) => m.id === b.id).url, `/@media/${sha256(VOICE_B)}`);

    const packed = await packProcpFrom(procOf(getState().project), getState().project);
    blob = packed.blob;
    assert.deepEqual(packed.missing, []);
    const entries = await readZip(blob);
    assert.deepEqual(entries.slice(1).map((e) => e.name).sort(), [`media/${hashV}.mp4`, `media/${sha256(VOICE_A)}.mp3`, `media/${sha256(VOICE_B)}.mp3`].sort());
    const inner = JSON.parse(await (await inflate(entries[0])).text()).project;
    assert.equal(inner.media.length, 3);
    for (const m of inner.media) assert.match(m.hash, /^[0-9a-f]{64}$/, `包内 project.proc 里 ${m.name} 带哈希`);
  } finally {
    fake.restore();
  }

  // 另一台机器:内容库和素材目录都是空的
  const other = fakeStore();
  try {
    const { procText, stored } = await unpackProcp(blob);
    assert.equal(stored, 3);
    const back = JSON.parse(procText).project;
    const { missing } = restoreMediaUrls(back.media, { externalPathUrl: true });
    assert.deepEqual(missing, [], "拆到空库后按哈希都能还原,没有(缺失)");
    for (const m of back.media) assert.equal(other.store.has(m.hash), true, `${m.name} 的字节在对面的内容库里`);
  } finally {
    other.restore();
  }
});

test("补入库:服务端不收那条路径(换了机器、路径对不上)时,经 /@media/<文件名> 取字节再入库", async () => {
  const fake = fakeStore();
  resetTierBackfillForTest();
  try {
    fake.disk.set(`${MEDIA_ROOT}/voice-c.mp3`, VOICE_C);
    actions.newProject("换机器");
    const c = actions.addMedia({ kind: "audio", name: "voice-c.mp3", url: "/@media/voice-c.mp3", path: "D:\\old-machine\\media\\voice-c.mp3" });
    const r = await ingestUnhashedMedia();
    assert.deepEqual(r, { ingested: [c.id], failed: [] });
    assert.equal(getState().project.media[0].hash, sha256(VOICE_C));
    assert.equal(fake.store.get(sha256(VOICE_C)).bytes.equals(VOICE_C), true);
  } finally {
    fake.restore();
  }
});

test("补入库:「只要声音」那份跟着源视频的哈希;还在导入的(pending)不动", async () => {
  const fake = fakeStore();
  resetTierBackfillForTest();
  try {
    const hashV = fake.put(CLIP_V, "mp4");
    actions.newProject("派生声音");
    const v = actions.addMedia({ kind: "video", name: "v.mp4", ext: "mp4", hash: hashV, url: `/@media/${hashV}`, tiers: { original: hashV } });
    const s = actions.addMedia({ kind: "audio", name: "v · 声音", url: `/@media/${hashV}`, soundOf: v.id });
    const p = actions.addMedia({ kind: "audio", name: "uploading.mp3", url: "", pending: true });
    const r = await ingestUnhashedMedia();
    assert.deepEqual(r, { ingested: [s.id], failed: [] });
    const got = getState().project.media.find((m) => m.id === s.id);
    assert.equal(got.hash, hashV);
    assert.equal(got.tiers, undefined, "派生的声音不挂视频的两档");
    assert.equal(getState().project.media.find((m) => m.id === p.id).hash, undefined);
  } finally {
    fake.restore();
  }
});

test("文件真的不在了:补不上的列在补入库与装包的返回值里,提示文案列出名字", async () => {
  const fake = fakeStore();
  resetTierBackfillForTest();
  try {
    const hashV = fake.put(CLIP_V, "mp4");
    actions.newProject("缺文件");
    actions.addMedia({ kind: "video", name: "v.mp4", ext: "mp4", hash: hashV, url: `/@media/${hashV}` });
    const gone = actions.addMedia({ kind: "audio", name: "voice-gone.mp3", url: `/api/media/file?path=${encodeURIComponent(`${MEDIA_ROOT}/voice-gone.mp3`)}` });
    const dead = actions.addMedia({ kind: "image", name: "(缺失) pic.png", url: "" });
    const r = await ingestUnhashedMedia();
    assert.deepEqual(r.ingested, []);
    assert.deepEqual(r.failed.map((f) => f.id).sort(), [gone.id, dead.id].sort());

    const { blob, missing } = await packProcpFrom(procOf(getState().project), getState().project);
    assert.deepEqual(missing.map((m) => m.id).sort(), [gone.id, dead.id].sort(), "进不了包的都在清单里");
    assert.equal((await readZip(blob)).length, 2, "编排 + 那一条视频");
    const msg = packMissingMessage(missing);
    assert.match(msg, /2 条素材/);
    assert.match(msg, /voice-gone\.mp3/);
    assert.match(msg, /· pic\.png/, "名字前的(缺失)标记不重复显示");
    assert.equal(packMissingMessage([]), "");
  } finally {
    fake.restore();
  }
});

test("守门 mediaEntries:没哈希的条目不许悄悄跳过,一律出现在 unhashed 里", () => {
  const H = "a".repeat(64);
  const { entries, unhashed } = mediaEntries({
    media: [
      { id: "1", kind: "video", name: "v.mp4", hash: H },
      { id: "2", kind: "audio", name: "old.mp3", path: "C:/x/old.mp3" },
      { id: "3", kind: "audio", name: "bad.mp3", hash: "not-a-hash" },
      { id: "4", kind: "video", name: "dup.mp4", hash: H.toUpperCase() },
    ],
  });
  assert.deepEqual(entries, [{ hash: H, file: `${H}.mp4`, ids: ["1", "4"] }]);
  assert.deepEqual(unhashed, [{ id: "2", name: "old.mp3" }, { id: "3", name: "bad.mp3" }]);
});

test("取不到字节的有哈希素材(内容库里没有)也列进 missing,每条引用它的记录都列", async () => {
  const fake = fakeStore();
  try {
    const H = "b".repeat(64);
    const { missing } = await packProcpFrom(PROC_TEXT, { media: [
      { id: "x1", kind: "video", name: "x.mp4", hash: H },
      { id: "x2", kind: "video", name: "x-copy.mp4", hash: H },
    ] });
    assert.deepEqual(missing, [{ id: "x1", name: "x.mp4" }, { id: "x2", name: "x-copy.mp4" }]);
  } finally {
    fake.restore();
  }
});

test("打开包:包里带着字节的素材去掉打包方机器上的 path(导出不再去读另一台机器的文件),不在包里的原样留着", async () => {
  const { dropPackedPaths } = await import("./procp.ts");
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  const project = { name: "p", media: [
    { id: "a", kind: "video", name: "a.mp4", hash: H1, url: `/@media/${H1}`, path: "C:\Users\admin\Videos\PromptCut\media\a.mp4" },
    { id: "b", kind: "audio", name: "b.mp3", hash: H2, url: `/@media/${H2}`, path: "C:\other\b.mp3" },
    { id: "c", kind: "audio", name: "c.mp3", url: "/api/media/file?path=x", path: "C:\old\c.mp3" },
  ] };
  const out = dropPackedPaths(project, [H1.toUpperCase()]);
  assert.notEqual(out, project, "换新对象");
  assert.equal(project.media[0].path.endsWith("a.mp4"), true, "不改入参");
  assert.equal("path" in out.media[0], false);
  assert.equal(out.media[1].path, "C:\other\b.mp3", "包里没带字节的不动");
  assert.equal(out.media[2].path, "C:\old\c.mp3");
  assert.equal(dropPackedPaths(project, []), project);
});

test("拆包回报这个包带来的哈希(新写的 + 本来就有的)", async () => {
  const packer = fakeStore();
  let blob, hashA, hashB;
  try {
    hashA = packer.put(CLIP_A, "mp4");
    hashB = packer.put(CLIP_B, "png");
    ({ blob } = await packProcpFrom(PROC_TEXT, projectWith(hashA, hashB)));
  } finally {
    packer.restore();
  }
  const other = fakeStore();
  try {
    other.put(CLIP_A, "mp4");
    const r = await unpackProcp(blob);
    assert.deepEqual(r.landed.sort(), [hashA, hashB].sort());
  } finally {
    other.restore();
  }
});
