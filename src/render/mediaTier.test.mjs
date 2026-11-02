/**
 * 换档判据(`mediaTier.ts` 的 playbackUrl)与本机可播性缓存(`playability.ts`)的单测。
 * 跑:node --test src/render/mediaTier.test.mjs
 *
 * 钉的是 T1a 审查的三条:
 *   #3 素材小尺寸还没传完、素材原尺寸传完了 → 给素材原尺寸;判据只看「素材服务报 complete 的哈希集合」;
 *   #4 可播性是**这台设备**的结论,存在本机缓存里,不看项目文档(MediaAsset 上写了什么都不算);
 *   集合为空(还没问过素材服务)→ 有素材小尺寸给素材小尺寸(C6.6 起;以前是一律 `media.url`)。
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { playbackUrl, hashFromUrl } = await import("./mediaTier.ts");
const { forgetPlayable, playableOnThisHost, rememberPlayable, mimeForExt, probePlayable } = await import("./playability.ts");

const ORIG = "a".repeat(64);
const SMALL = "b".repeat(64);
const media = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG, small: SMALL }, ext: "mov", kind: "video" };
const never = () => { throw new Error("Should not query playability"); };

test("Set is empty (asset service not queried yet): give the small asset variant if there is one, otherwise the original asset, and do not query playability (C6.6: the first frame does not pull the original asset directly)", () => {
  assert.equal(playbackUrl(media, [], { playable: never }), `/@media/${SMALL}`);
  assert.equal(playbackUrl(media, new Set(), { playable: never }), `/@media/${SMALL}`);
  assert.equal(playbackUrl({ ...media, tiers: { original: ORIG } }, [], { playable: never }), `/@media/${ORIG}`);
  // 迁移期没有哈希的老素材:原样
  assert.equal(playbackUrl({ url: "/api/media/file?path=C%3A%2Fa.mp4" }, [ORIG]), "/api/media/file?path=C%3A%2Fa.mp4");
  // 只有哈希、没有 url 的:拼哈希地址
  assert.equal(playbackUrl({ url: "", hash: ORIG }, []), `/@media/${ORIG}`);
});

test("#3: small asset variant not fully uploaded, original asset fully uploaded → original asset", () => {
  assert.equal(playbackUrl(media, [ORIG], { playable: () => true }), `/@media/${ORIG}`);
  // 没有素材小尺寸这一档的素材(浏览器里导入的只有素材原尺寸)
  const onlyOriginal = { ...media, tiers: { original: ORIG } };
  assert.equal(playbackUrl(onlyOriginal, [ORIG], { playable: never }), `/@media/${ORIG}`);
});

test("Small first, then large: only the small asset variant fully uploaded → small asset variant; both tiers fully uploaded and this device can play it → original asset", () => {
  assert.equal(playbackUrl(media, [SMALL], { playable: never }), `/@media/${SMALL}`);
  assert.equal(playbackUrl(media, [SMALL, ORIG], { playable: () => true }), `/@media/${ORIG}`);
});

test("Neither tier fully uploaded → original asset (when there is no small asset variant yet, pull the original asset directly)", () => {
  assert.equal(playbackUrl(media, ["c".repeat(64)], { playable: never }), `/@media/${ORIG}`);
});

test("#4: this device cannot play the original asset → if there is a small asset variant, stay on it; fall back to the original asset only when the small asset variant is not fully uploaded", () => {
  const no = () => false;
  assert.equal(playbackUrl(media, [SMALL, ORIG], { playable: no }), `/@media/${SMALL}`);
  assert.equal(playbackUrl(media, [ORIG], { playable: no }), `/@media/${ORIG}`, "No small asset variant to give: force fallback to the original asset");
});

test("#4: playability not known yet → give the small asset variant first; with the no-probe option, no probe is triggered", () => {
  assert.equal(playbackUrl(media, [SMALL, ORIG], { playable: () => undefined, probe: false }), `/@media/${SMALL}`);
});

test("#4: playability is stored in the local cache, keyed by content hash; whatever the project document says does not count", () => {
  forgetPlayable();
  assert.equal(playableOnThisHost(ORIG), undefined);
  // 项目文档里就算有人写了 playable: true,也不看它
  const claimed = { ...media, playable: true };
  assert.equal(playbackUrl(claimed, [SMALL, ORIG], { probe: false }), `/@media/${SMALL}`);
  rememberPlayable(ORIG.toUpperCase(), true);
  assert.equal(playableOnThisHost(ORIG), true, "Hash is case-insensitive");
  assert.equal(playbackUrl(media, [SMALL, ORIG]), `/@media/${ORIG}`);
  rememberPlayable(ORIG, false);
  assert.equal(playbackUrl(media, [SMALL, ORIG]), `/@media/${SMALL}`);
  forgetPlayable();
});

test("Without a DOM the probe draws no conclusion (returns undefined, records nothing)", async () => {
  forgetPlayable();
  assert.equal(await probePlayable(ORIG, `/@media/${ORIG}`, "mov"), undefined);
  assert.equal(playableOnThisHost(ORIG), undefined);
});

test("cloudBase: hash URLs are replaced with absolute URLs of the remote asset service, other URLs are left alone", () => {
  assert.equal(playbackUrl(media, [SMALL], { cloudBase: "https://assets.example/", playable: never }), `https://assets.example/@media/${SMALL}`);
  assert.equal(playbackUrl({ url: "/api/media/file?path=x" }, [], { cloudBase: "https://assets.example" }), "/api/media/file?path=x");
});

test("mimeForExt / hashFromUrl", () => {
  // C6.6:MOV 按 Chrome 实际用的 ISO BMFF 解复用器问(canPlayType("video/quicktime") 在 Chrome 恒回空串)
  assert.equal(mimeForExt("MOV"), "video/mp4");
  assert.equal(mimeForExt("xyz"), null);
  assert.equal(hashFromUrl(`/@media/${ORIG}.mp4?x=1`), ORIG);
  assert.equal(hashFromUrl("/@media/name.mp4"), null);
});
