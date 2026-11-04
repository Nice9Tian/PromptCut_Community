// node --test src/editor/io/mediaUrls.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { restoreMediaUrls, mediaUrlFromPath } = await import("./mediaUrls.ts");

const name = "雄伟的寺庙！浅草寺 [BV1Zn4y1d71C].mp4";

test("mediaUrlFromPath: takes the last path segment and encodes it; no path gives null", () => {
  assert.equal(mediaUrlFromPath(`C:\\Users\\admin\\Videos\\PromptCut\\media\\${name}`), `/@media/${encodeURIComponent(name)}`);
  assert.equal(mediaUrlFromPath("/srv/media/a b.mp4"), "/@media/a%20b.mp4");
  assert.equal(mediaUrlFromPath(undefined), null);
  assert.equal(mediaUrlFromPath(""), null);
});

test("Bare file name left by saving + path (this time's 3.proc) → /@media/<filename>", () => {
  const { media, missing } = restoreMediaUrls([
    { id: "m1", kind: "video", name, url: name, path: `C:\\x\\media\\${name}` },
  ]);
  assert.equal(media[0].url, `/@media/${encodeURIComponent(name)}`);
  assert.equal(media[0].name, name);
  assert.deepEqual(missing, []);
});

test("Dead blob: URLs: recovered if there is a path; marked missing with the URL cleared if there is none", () => {
  const { media, missing } = restoreMediaUrls([
    { id: "a", kind: "video", name: "a.mp4", url: "blob:http://127.0.0.1:5210/x", path: "C:/m/a.mp4" },
    { id: "b", kind: "video", name: "b.mp4", url: "blob:http://127.0.0.1:5210/y" },
  ]);
  assert.equal(media[0].url, "/@media/a.mp4");
  assert.equal(media[1].url, "");
  assert.equal(media[1].name, "(missing) b.mp4");
  assert.deepEqual(missing.map((m) => m.id), ["b"]);
});

test("A bare file name without a path is marked missing; reopening repeatedly does not stack \"(missing)\"", () => {
  const once = restoreMediaUrls([{ id: "c", kind: "image", name: "c.jpg", url: "c.jpg" }]).media;
  const twice = restoreMediaUrls([{ ...once[0], url: "c.jpg" }]).media;
  assert.equal(once[0].name, "(missing) c.jpg");
  assert.equal(twice[0].name, "(missing) c.jpg");
});

test("The Chinese marker \"(缺失) \" already in old projects does not get another one stacked on top", () => {
  const once = restoreMediaUrls([{ id: "c", kind: "image", name: "(missing) c.jpg", url: "c.jpg" }]).media;
  assert.equal(once[0].name, "(missing) c.jpg");
});

test("URLs that already work are kept as is; an empty url does not count as missing; the input arguments are not modified", () => {
  const input = [
    { id: "1", kind: "video", name: "1", url: "/@media/x.mp4" },
    { id: "2", kind: "video", name: "2", url: "https://example.com/v.mp4" },
    { id: "3", kind: "image", name: "3", url: "data:image/png;base64,AA==" },
    { id: "4", kind: "video", name: "4", url: "" },
  ];
  const snapshot = JSON.stringify(input);
  const { media, missing } = restoreMediaUrls(input);
  assert.deepEqual(media.map((m) => m.url), input.map((m) => m.url));
  assert.deepEqual(missing, []);
  assert.equal(JSON.stringify(input), snapshot);
});

test("\"· Sound\" derived media carries the source file's path and is recovered by path just the same", () => {
  const src = "山田豊 [BV1r64y1q7uB].m4a";
  const { media } = restoreMediaUrls([
    { id: "s", kind: "audio", name: "山田豊 · 声音", url: src, path: `C:\\m\\${src}`, soundOf: "v" },
  ]);
  assert.equal(media[0].url, `/@media/${encodeURIComponent(src)}`);
});

test("Old projects that recorded jpg / mp3 as video are migrated to the right tab by extension", () => {
  const { media, moved } = restoreMediaUrls([
    { id: "jpg", kind: "video", name: "东京.jpg", url: "/@media/%E4%B8%9C%E4%BA%AC.jpg" },
    { id: "mp3", kind: "video", name: "bgm.mp3", url: "/@media/bgm.mp3" },
    { id: "ok", kind: "image", name: "cover.jpg", url: "/@media/cover.jpg" },
  ]);
  assert.deepEqual(media.map((m) => m.kind), ["image", "audio", "image"]);
  assert.deepEqual(moved.map((m) => [m.id, m.from, m.to]), [
    ["jpg", "video", "image"],
    ["mp3", "video", "audio"],
  ]);
});

test("Derived sound media is not migrated back to video even if the source file is mp4", () => {
  const { media, moved } = restoreMediaUrls([
    { id: "sound", kind: "audio", name: "Clip · Sound", url: "/@media/a.mp4", path: "C:/m/a.mp4", soundOf: "video" },
  ]);
  assert.equal(media[0].kind, "audio");
  assert.deepEqual(moved, []);
});

/* ---------------- A1: asset key (content sha256) takes precedence over everything ---------------- */

const HASH = "c28c081b3ffbc80cf0feafd8efba149355609f625e4968b62b7375d2954b31cb";

test("mediaUrlFromHash: only a 64-digit hex is accepted, uppercase is normalized, anything else gives null", async () => {
  const { mediaUrlFromHash } = await import("./mediaUrls.ts");
  assert.equal(mediaUrlFromHash(HASH), `/@media/${HASH}`);
  assert.equal(mediaUrlFromHash(HASH.toUpperCase()), `/@media/${HASH}`);
  assert.equal(mediaUrlFromHash("deadbeef"), null);
  assert.equal(mediaUrlFromHash(undefined), null);
});

test("If there is a hash, it is always /@media/<hash>: a path from another machine makes no difference, and pending is cleared along the way", () => {
  const { media, missing } = restoreMediaUrls([
    // The drop target from that machine when saved does not exist at all on this machine
    { id: "h", kind: "video", name: "a.mp4", url: "", hash: HASH, ext: "mp4", path: "D:/another-machine/media/a.mp4", pending: true },
    // Dead blob: is still recovered by hash
    { id: "b", kind: "image", name: "b.png", url: "blob:http://127.0.0.1:5204/x", hash: HASH },
  ]);
  assert.equal(media[0].url, `/@media/${HASH}`);
  assert.equal(media[0].pending, undefined, "pending only has meaning within the session of that one import");
  assert.equal(media[1].url, `/@media/${HASH}`);
  assert.deepEqual(missing, [], "Having a hash does not count as missing");
});

test("An old .proc without a hash can still be recovered by the file name in its path as before", () => {
  const { media, missing } = restoreMediaUrls([
    { id: "old", kind: "video", name: "旧片.mp4", url: "blob:http://127.0.0.1:5190/y", path: "C:\\m\\旧片.mp4" },
  ]);
  assert.equal(media[0].url, `/@media/${encodeURIComponent("旧片.mp4")}`);
  assert.deepEqual(missing, []);
});
