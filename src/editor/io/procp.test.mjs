// .procp package: zip byte format, first entry, deduplication by hash, and deflate entries
// compressed by other zip tools.
//   node --test src/editor/io/procp.test.mjs
//
// procp.ts has only type imports at the top (store and proc.ts are dynamically imported inside
// functions), so it can be loaded directly here; the packaging core is packProcpFrom(procText,
// project), which does not touch store. The server side (local content store) is replaced with
// a fake fetch: content is stored by sha256, following the same rules as storeMediaStream in
// server/vite-plugin-media.ts.
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

/** Fake local content store + fake fetch: only recognizes the three routes used by procp.ts */
/** Fake asset catalog (the one in server allowedMediaRoots) and drop target for local content store */
const MEDIA_ROOT = "C:/Users/u/Videos/PromptCut/media";
const STORE_DIR = "C:/pc/out/media";
const norm = (p) => String(p).replace(/\\/g, "/");
const inRoot = (p) => norm(p).toLowerCase().startsWith(MEDIA_ROOT.toLowerCase() + "/");

function fakeStore() {
  /** hash -> {bytes, ext} */
  const store = new Map();
  /** Fake disk: old files in the asset catalog, absolute path (forward slashes) -> bytes */
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
      // Migration-period /@media/<filename>: look up by filename in the asset catalog
      const bytes = disk.get(`${MEDIA_ROOT}/${raw}`);
      return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 });
    }
    // POST /api/media/adopt?path=: only accepts paths within the asset catalog, computes hash in place
    // and mounts into the content store
    if (u.startsWith("/api/media/adopt")) {
      const p = norm(new URL(u, "http://x").searchParams.get("path") || "");
      if (!inRoot(p)) return new Response("outside", { status: 403 });
      const bytes = disk.get(p);
      if (!bytes) return new Response("ENOENT", { status: 500 });
      return Response.json(addToStore(bytes, p.split("/").pop()));
    }
    // GET /api/media/file?path=: likewise only reads within the asset catalog
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
      // Server keys by **content**; misspelled entry names in the package cannot pollute the store
      const hash = sha256(bytes);
      const deduped = store.has(hash);
      if (!deduped) store.set(hash, { bytes, ext: (name.split(".").pop() || "").toLowerCase() });
      return Response.json({ ok: true, hash, url: `/@media/${hash}`, bytes: bytes.length, deduped });
    }
    throw new Error(`The fake fetch does not recognize this route: ${u}`);
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
const PROC_TEXT = JSON.stringify({ format: "promptcut-project", version: 1, project: { name: "Package test" } });

function projectWith(hashA, hashB) {
  return {
    name: "Package test",
    media: [
      { id: "m1", kind: "video", name: "a.mp4", ext: "mp4", hash: hashA, url: `/@media/${hashA}` },
      { id: "m2", kind: "image", name: "b.png", ext: "png", hash: hashB, url: `/@media/${hashB}` },
      // Same asset referenced by a second record: there should be only one copy of bytes in the package
      { id: "m3", kind: "video", name: "a-copy.mp4", ext: "mp4", hash: hashA, url: `/@media/${hashA}` },
      // Old assets from the migration period: no hash, cannot be packed into package (and should not fail
      // entire packaging)
      { id: "m4", kind: "video", name: "legacy.mp4", url: "/@media/legacy.mp4" },
    ],
  };
}

test("Packing: the first entry is project.proc, media files are named <hash>.<ext> and deduplicated by hash", async () => {
  const fake = fakeStore();
  try {
    const hashA = fake.put(CLIP_A, "mp4");
    const hashB = fake.put(CLIP_B, "png");
    const { blob, missing } = await packProcpFrom(PROC_TEXT, projectWith(hashA, hashB));
    assert.deepEqual(missing, [{ id: "m4", name: "legacy.mp4" }], "m4 has no hash so it cannot go into the package, but it always appears in the returned manifest");

    const entries = await readZip(blob);
    assert.equal(entries[0].name, "project.proc", "The first entry is always the arrangement, so it can be read with head without extracting");
    assert.deepEqual(entries.map((e) => e.name).slice(1).sort(), [`media/${hashA}.mp4`, `media/${hashB}.png`]);
    assert.equal(entries.length, 3, "m3 and m1 share a hash so only one copy is packed; m4 has no hash and cannot be packed");
    assert.equal(await (await inflate(entries[0])).text(), PROC_TEXT);

    const back = new Map();
    for (const e of entries.slice(1)) back.set(e.name, Buffer.from(await (await inflate(e)).arrayBuffer()));
    assert.equal(back.get(`media/${hashA}.mp4`).equals(CLIP_A), true);
    assert.equal(back.get(`media/${hashB}.png`).equals(CLIP_B), true);

    // The package is recognized as a package on its own (relies on PK\x03\x04 even without a name)
    assert.equal(await isProcpFile(blob), true);
    assert.equal(await isProcpFile(new Blob([PROC_TEXT])), false);
    assert.equal(await isProcpFile(Object.assign(new Blob([PROC_TEXT]), { name: `x${PROCP_EXT}` })), true);
  } finally {
    fake.restore();
  }
});

test("Round trip: unpacking into an empty store writes two new files, and unpacking again is all deduplicated", async () => {
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

  // Another machine: content store is empty
  const other = fakeStore();
  try {
    const first = await unpackProcp(blob);
    assert.equal(first.procText, PROC_TEXT);
    assert.equal(first.stored, 2);
    assert.equal(first.deduped, 0);
    assert.equal(other.store.get(hashA).bytes.equals(CLIP_A), true);
    assert.equal(other.store.get(hashB).bytes.equals(CLIP_B), true);

    // Unpack the same package again: not a single byte is transferred again
    const again = await unpackProcp(blob);
    assert.equal(again.stored, 0);
    assert.equal(again.deduped, 2);
    assert.equal(other.store.size, 2);
  } finally {
    other.restore();
  }
});

test("Deflate entries produced by other zip tools can be read too", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-procp-"));
  try {
    const text = "PromptCut .procp deflate fixture\n".repeat(400); // Repetitive enough, definitely gets compressed
    const src = path.join(dir, "project.proc");
    const zip = path.join(dir, "made-by-powershell.zip");
    fs.writeFileSync(src, text);
    try {
      // Use the OS zip implementation directly: Archive module autoload depends on the parent shell's module path.
      const zipOutside = `${dir}-external.zip`;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${dir.replaceAll("'", "''")}', '${zipOutside.replaceAll("'", "''")}')`], { stdio: "pipe", windowsHide: true });
      fs.renameSync(zipOutside, zip);
    } catch (err) {
      t.skip(`The system zip implementation cannot run on this machine: ${err.message}`);
      return;
    }
    const blob = new Blob([fs.readFileSync(zip)]);
    assert.equal(await isProcpFile(blob), true);
    const entries = await readZip(blob);
    const proc = entries.find((e) => e.name === "project.proc");
    assert.ok(proc, "A package compressed by PowerShell should contain project.proc");
    assert.equal(proc.method, 8, "The system zip uses deflate, which exercises the method 8 path");
    assert.equal(await (await inflate(proc)).text(), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------- Backfill into store: old assets without hashes must also enter the package
 * (defect on real user machine: voiceover from old projects was missing from .procp) ------------- */

const VOICE_A = Buffer.from("fake-mp3-voice-A-".repeat(23));
const VOICE_B = Buffer.from("fake-mp3-voice-B-".repeat(29));
const VOICE_C = Buffer.from("fake-mp3-voice-C-".repeat(17));
const CLIP_V = Buffer.from("fake-mp4-video-V-".repeat(37));

/** Arrangement text: places project under project like serializeProc (here only cares about asset table) */
const procOf = (project) => JSON.stringify({ format: "promptcut-project", version: 1, project });

test("Packing after the store backfill: a video with a hash, an audio with only a path, and an audio whose URL is /api/media/file?path=… all have their bytes packed, all three entries in the in-package project.proc carry a hash; nothing is missing after unpacking into an empty store", async () => {
  const fake = fakeStore();
  resetTierBackfillForTest();
  let blob;
  try {
    const hashV = fake.put(CLIP_V, "mp4");
    fake.disk.set(`${MEDIA_ROOT}/voice-a.mp3`, VOICE_A);
    const bPath = `${MEDIA_ROOT}/voice-决赛开场-b.mp3`;
    fake.disk.set(bPath, VOICE_B);
    actions.newProject("Store backfill");
    actions.addMedia({ kind: "video", name: "v.mp4", ext: "mp4", hash: hashV, url: `/@media/${hashV}` });
    // Old format: only path (Windows backslashes)
    const a = actions.addMedia({ kind: "audio", name: "voice-a.mp3", url: "", path: `${MEDIA_ROOT}/voice-a.mp3`.replace(/\//g, "\\") });
    // Voiceover generated by 0.7.0 / 0.7.1: address is /api/media/file?path=…, no hash
    const b = actions.addMedia({ kind: "audio", name: "voice-决赛开场-b.mp3", url: `/api/media/file?path=${encodeURIComponent(bPath)}` });
    const oldA = getState().project.media.find((m) => m.id === a.id);

    const r = await ingestUnhashedMedia();
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.ingested.sort(), [a.id, b.id].sort());
    assert.equal(oldA.hash, undefined, "The old object in the store is not modified in place");
    const media = getState().project.media;
    for (const m of media) assert.match(m.hash, /^[0-9a-f]{64}$/, `${m.name} got its hash backfilled`);
    assert.equal(media.find((m) => m.id === a.id).hash, sha256(VOICE_A));
    assert.equal(media.find((m) => m.id === b.id).url, `/@media/${sha256(VOICE_B)}`);

    const packed = await packProcpFrom(procOf(getState().project), getState().project);
    blob = packed.blob;
    assert.deepEqual(packed.missing, []);
    const entries = await readZip(blob);
    assert.deepEqual(entries.slice(1).map((e) => e.name).sort(), [`media/${hashV}.mp4`, `media/${sha256(VOICE_A)}.mp3`, `media/${sha256(VOICE_B)}.mp3`].sort());
    const inner = JSON.parse(await (await inflate(entries[0])).text()).project;
    assert.equal(inner.media.length, 3);
    for (const m of inner.media) assert.match(m.hash, /^[0-9a-f]{64}$/, `${m.name} carries a hash in the in-package project.proc`);
  } finally {
    fake.restore();
  }

  // Another machine: content store and asset catalog are both empty
  const other = fakeStore();
  try {
    const { procText, stored } = await unpackProcp(blob);
    assert.equal(stored, 3);
    const back = JSON.parse(procText).project;
    const { missing } = restoreMediaUrls(back.media, { externalPathUrl: true });
    assert.deepEqual(missing, [], "After unpacking into an empty store everything can be restored by hash, with no (missing)");
    for (const m of back.media) assert.equal(other.store.has(m.hash), true, `The bytes of ${m.name} are in the other side's content store`);
  } finally {
    other.restore();
  }
});

test("Store backfill: when the server does not accept that path (different machine, path mismatch), fetch the bytes via /@media/<filename> and then store them", async () => {
  const fake = fakeStore();
  resetTierBackfillForTest();
  try {
    fake.disk.set(`${MEDIA_ROOT}/voice-c.mp3`, VOICE_C);
    actions.newProject("Switch machine");
    const c = actions.addMedia({ kind: "audio", name: "voice-c.mp3", url: "/@media/voice-c.mp3", path: "D:\\old-machine\\media\\voice-c.mp3" });
    const r = await ingestUnhashedMedia();
    assert.deepEqual(r, { ingested: [c.id], failed: [] });
    assert.equal(getState().project.media[0].hash, sha256(VOICE_C));
    assert.equal(fake.store.get(sha256(VOICE_C)).bytes.equals(VOICE_C), true);
  } finally {
    fake.restore();
  }
});

test("Store backfill: the \"Audio only\" copy follows the source video's hash; media still importing (pending) is left alone", async () => {
  const fake = fakeStore();
  resetTierBackfillForTest();
  try {
    const hashV = fake.put(CLIP_V, "mp4");
    actions.newProject("Derived sound");
    const v = actions.addMedia({ kind: "video", name: "v.mp4", ext: "mp4", hash: hashV, url: `/@media/${hashV}`, tiers: { original: hashV } });
    const s = actions.addMedia({ kind: "audio", name: "v · Sound", url: `/@media/${hashV}`, soundOf: v.id });
    const p = actions.addMedia({ kind: "audio", name: "uploading.mp3", url: "", pending: true });
    const r = await ingestUnhashedMedia();
    assert.deepEqual(r, { ingested: [s.id], failed: [] });
    const got = getState().project.media.find((m) => m.id === s.id);
    assert.equal(got.hash, hashV);
    assert.equal(got.tiers, undefined, "A derived sound does not carry the video's two tiers");
    assert.equal(getState().project.media.find((m) => m.id === p.id).hash, undefined);
  } finally {
    fake.restore();
  }
});

test("The file is really gone: media that cannot be backfilled is listed in the return values of the store backfill and of packing, and the notice text lists the names", async () => {
  const fake = fakeStore();
  resetTierBackfillForTest();
  try {
    const hashV = fake.put(CLIP_V, "mp4");
    actions.newProject("Missing file");
    actions.addMedia({ kind: "video", name: "v.mp4", ext: "mp4", hash: hashV, url: `/@media/${hashV}` });
    const gone = actions.addMedia({ kind: "audio", name: "voice-gone.mp3", url: `/api/media/file?path=${encodeURIComponent(`${MEDIA_ROOT}/voice-gone.mp3`)}` });
    const dead = actions.addMedia({ kind: "image", name: "(missing) pic.png", url: "" });
    const r = await ingestUnhashedMedia();
    assert.deepEqual(r.ingested, []);
    assert.deepEqual(r.failed.map((f) => f.id).sort(), [gone.id, dead.id].sort());

    const { blob, missing } = await packProcpFrom(procOf(getState().project), getState().project);
    assert.deepEqual(missing.map((m) => m.id).sort(), [gone.id, dead.id].sort(), "Everything that cannot go into the package is in the manifest");
    assert.equal((await readZip(blob)).length, 2, "The arrangement + that one video");
    const msg = packMissingMessage(missing);
    assert.match(msg, /2 media items/);
    assert.match(msg, /voice-gone\.mp3/);
    assert.match(msg, /· pic\.png/, "The (missing) marker before the name is not shown twice");
    assert.equal(packMissingMessage([]), "");
  } finally {
    fake.restore();
  }
});

test("Gatekeeper mediaEntries: entries without a hash must not be skipped silently, they always appear in unhashed", () => {
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

test("Hashed media whose bytes cannot be fetched (not in the content store) is also listed in missing, and every record that references it is listed", async () => {
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

test("Opening a package: media whose bytes are in the package drops the path from the machine that created the package (export no longer reads files on another machine), and media not in the package is left as is", async () => {
  const { dropPackedPaths } = await import("./procp.ts");
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  const project = { name: "p", media: [
    { id: "a", kind: "video", name: "a.mp4", hash: H1, url: `/@media/${H1}`, path: "C:\Users\admin\Videos\PromptCut\media\a.mp4" },
    { id: "b", kind: "audio", name: "b.mp3", hash: H2, url: `/@media/${H2}`, path: "C:\other\b.mp3" },
    { id: "c", kind: "audio", name: "c.mp3", url: "/api/media/file?path=x", path: "C:\old\c.mp3" },
  ] };
  const out = dropPackedPaths(project, [H1.toUpperCase()]);
  assert.notEqual(out, project, "Returns a new object");
  assert.equal(project.media[0].path.endsWith("a.mp4"), true, "The input argument is not modified");
  assert.equal("path" in out.media[0], false);
  assert.equal(out.media[1].path, "C:\other\b.mp3", "Media whose bytes are not in the package is left untouched");
  assert.equal(out.media[2].path, "C:\old\c.mp3");
  assert.equal(dropPackedPaths(project, []), project);
});

test("Unpacking reports the hashes this package brought (newly written + already present)", async () => {
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
