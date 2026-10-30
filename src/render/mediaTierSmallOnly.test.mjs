/**
 * 最低一档(取档策略 `smallOnly`)的「素材只拉小尺寸」与在线浏览器模式的远程取回地址(`docs/plan/c10a-contract.md` 第 8 节)。
 * 跑:node --test src/render/mediaTierSmallOnly.test.mjs
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { playbackUrl, chooseTier, setMediaTierPolicy, mediaTierPolicy, remoteMediaUrl, resolveCardParams, TIERS_KNOWN_REMOTE, previewMediaUrl, subscribeMediaTierPolicy } = await import("./mediaTier.ts");

const ORIG = "a".repeat(64);
const SMALL = "b".repeat(64);
const video = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG, small: SMALL }, ext: "mp4", kind: "video" };
const videoNoSmall = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG }, ext: "mp4", kind: "video" };
const image = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG }, ext: "png", kind: "image" };
const audio = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG }, ext: "m4a", kind: "audio" };
const never = () => { throw new Error("最低一档不该问可播性(那要拉原尺寸的首帧)"); };

test("LMT1 最低一档:有小尺寸恒给小尺寸,两档都齐也不换原尺寸,不问可播性", () => {
  const low = { smallOnly: true, playable: never };
  assert.equal(playbackUrl(video, [], low), `/@media/${SMALL}`, "还没问过");
  assert.equal(playbackUrl(video, [TIERS_KNOWN_REMOTE, SMALL, ORIG], low), `/@media/${SMALL}`, "两档都齐");
  assert.equal(playbackUrl(video, [TIERS_KNOWN_REMOTE, SMALL], low), `/@media/${SMALL}`);
});

test("LMT2 最低一档:小尺寸问过了还没到齐 → 不给地址、等待上传方,不回退到原尺寸", () => {
  const c = chooseTier(video, [TIERS_KNOWN_REMOTE, ORIG], { smallOnly: true, playable: never });
  assert.deepEqual(c, { url: "", tier: "none", awaiting: true });
});

test("LMT3 最低一档:没有小尺寸这一档的视频 → 等待上传方,不拉原尺寸(不论问没问过)", () => {
  assert.deepEqual(chooseTier(videoNoSmall, [], { smallOnly: true, playable: never }), { url: "", tier: "none", awaiting: true });
  assert.deepEqual(chooseTier(videoNoSmall, [TIERS_KNOWN_REMOTE, ORIG], { smallOnly: true, playable: never }), { url: "", tier: "none", awaiting: true });
});

test("LMT4 最低一档:图片、音频按 C6.6 设计没有小尺寸,照常给原尺寸(偏离见报告);迁移期老素材原样", () => {
  assert.equal(playbackUrl(image, [TIERS_KNOWN_REMOTE, ORIG], { smallOnly: true }), `/@media/${ORIG}`);
  assert.equal(playbackUrl(audio, [TIERS_KNOWN_REMOTE, ORIG], { smallOnly: true }), `/@media/${ORIG}`);
  assert.equal(playbackUrl({ ...image, kind: "video" }, [], { smallOnly: true }), `/@media/${ORIG}`, "老项目把图片登记成 video,按扩展名认");
  assert.equal(playbackUrl({ url: "/api/media/file?path=x.mp4" }, [], { smallOnly: true }), "/api/media/file?path=x.mp4");
});

test("LMT5 别的档不受影响(缺省策略)", () => {
  assert.equal(mediaTierPolicy().smallOnly, false);
  assert.equal(playbackUrl(video, [SMALL, ORIG], { playable: () => true }), `/@media/${ORIG}`);
  assert.equal(playbackUrl(videoNoSmall, [TIERS_KNOWN_REMOTE], { playable: never }), `/@media/${ORIG}`);
});

test("LMT6 策略:模块级的 smallOnly 生效;opts 可覆盖", () => {
  try {
    setMediaTierPolicy({ smallOnly: true });
    assert.equal(playbackUrl(video, [TIERS_KNOWN_REMOTE, SMALL, ORIG], { playable: never }), `/@media/${SMALL}`);
    assert.equal(playbackUrl(video, [SMALL, ORIG], { smallOnly: false, playable: () => true }), `/@media/${ORIG}`);
  } finally {
    setMediaTierPolicy({ smallOnly: false });
  }
});

test("LMT7 在线浏览器模式:哈希地址换成远程素材服务的 media/<hash>?t=<票据>;非哈希地址原样", () => {
  const remote = { base: "https://h.example/media/api/asset/", ticket: "tk+/=" };
  assert.equal(remoteMediaUrl(`/@media/${SMALL}`, { base: "https://h.example/media/api/asset", ticket: "tk+/=" }),
    `https://h.example/media/api/asset/media/${SMALL}?t=${encodeURIComponent("tk+/=")}`);
  assert.equal(remoteMediaUrl("/api/media/file?path=x", remote), "/api/media/file?path=x");
  try {
    setMediaTierPolicy({ smallOnly: true, remote });
    assert.equal(playbackUrl(video, []), `https://h.example/media/api/asset/media/${SMALL}?t=${encodeURIComponent("tk+/=")}`);
    setMediaTierPolicy({ remote: { base: "https://h.example/api/asset", ticket: null } });
    assert.equal(playbackUrl(video, []), `https://h.example/api/asset/media/${SMALL}`, "没有票据就不带查询串");
  } finally {
    setMediaTierPolicy({ smallOnly: false, remote: null });
  }
  assert.equal(playbackUrl(video, []), `/@media/${SMALL}`, "桌面运行环境照旧走本机代理");
});

test("LMT8 在线页远程素材地址未就绪时不交给浏览器 /@media 哈希地址", () => {
  try {
    setMediaTierPolicy({ online: true, smallOnly: true, remote: null });
    assert.deepEqual(chooseTier(video, []), { url: "", tier: "none", awaiting: true });
    assert.deepEqual(chooseTier(image, []), { url: "", tier: "none", awaiting: true });
    assert.equal(playbackUrl({ url: "blob:local" }, []), "blob:local");
    setMediaTierPolicy({ remote: { base: "https://h.example/api/asset", ticket: "t" } });
    assert.match(playbackUrl(video, []), /^https:\/\/h\.example\/api\/asset\/media\//);
  } finally {
    setMediaTierPolicy({ online: false, smallOnly: false, remote: null });
  }
});

test("LMT9 编辑界面的素材预览(素材库缩略、波形):桌面原样 media.url;在线页不给 /@media,最低一档视频只给远程小尺寸;策略变了通知", () => {
  let calls = 0;
  const off = subscribeMediaTierPolicy(() => { calls++; });
  try {
    assert.equal(previewMediaUrl(video), `/@media/${ORIG}`, "桌面运行环境:一字不差");
    setMediaTierPolicy({ online: true, smallOnly: true, remote: null });
    assert.equal(calls, 1);
    assert.equal(previewMediaUrl(video), "", "远程地址没就绪:不给地址(不发 /@media 请求)");
    assert.equal(previewMediaUrl(image), "");
    setMediaTierPolicy({ remote: { base: "https://h.example/api/asset", ticket: "t" } });
    assert.equal(calls, 2);
    setMediaTierPolicy({ remote: { base: "https://h.example/api/asset", ticket: "t" } });
    assert.equal(calls, 2, "没变不通知");
    assert.equal(previewMediaUrl(video), `https://h.example/api/asset/media/${SMALL}?t=t`, "最低一档:只给小尺寸");
    assert.equal(previewMediaUrl(videoNoSmall), "", "最低一档没有小尺寸:不拉原尺寸");
    assert.equal(previewMediaUrl(image), `https://h.example/api/asset/media/${ORIG}?t=t`, "图片只有一档");
    setMediaTierPolicy({ smallOnly: false });
    assert.equal(previewMediaUrl(video), `https://h.example/api/asset/media/${SMALL}?t=t`, "别的档:先小后大的小");
    assert.equal(previewMediaUrl(videoNoSmall), `https://h.example/api/asset/media/${ORIG}?t=t`);
    for (const m of [video, videoNoSmall, image, audio]) assert.ok(!previewMediaUrl(m).startsWith("/@media/"));
  } finally {
    setMediaTierPolicy({ online: false, smallOnly: false, remote: null });
    off();
  }
});

test("LMT10 舞台卡片参数里的 /@media/<hash>[.ext]:桌面原样不动(同一引用);在线未就绪给空串,cookie 模式换成 /media-s/<sid>/media/<hash>", () => {
  const raw = { photo: `/@media/${ORIG}.jpg`, caption: "户型图", sheetW: 604 };
  try {
    setMediaTierPolicy({ online: false, smallOnly: false, remote: null });
    assert.equal(resolveCardParams(raw), raw, "桌面环境原样返回同一对象引用");

    setMediaTierPolicy({ online: true, smallOnly: false, remote: null });
    const pending = resolveCardParams(raw);
    assert.deepEqual(pending, { photo: "", caption: "户型图", sheetW: 604 }, "在线远程地址未就绪前不请求 /@media");

    setMediaTierPolicy({ online: true, smallOnly: false, remote: { base: "/media-s/0123456789abcdef0123456789abcdef", ticket: null } });
    const mapped = resolveCardParams(raw);
    assert.deepEqual(mapped, { photo: `/media-s/0123456789abcdef0123456789abcdef/media/${ORIG}`, caption: "户型图", sheetW: 604 });
    assert.equal(resolveCardParams(raw), mapped, "同一策略下复用同一引用(不打断 memo)");
  } finally {
    setMediaTierPolicy({ online: false, smallOnly: false, remote: null });
  }
});
