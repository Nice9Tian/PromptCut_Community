/**
 * Unit tests for tier switch criteria (playbackUrl in `mediaTier.ts`) and local playability cache
 * (`playability.ts`). Run: node --test src/render/mediaTier.test.mjs
 *
 * Locks down three rules from the T1a review:
 *   #3 Small-size asset has not finished uploading, original-size asset finished uploading →
 *      provide original-size asset; criteria only check "hash set reported complete by asset
 *      service";
 *   #4 Playability is a conclusion of **this device**, stored in the local cache, ignoring the
 *      project document (whatever is written on MediaAsset does not count);
 *   Empty set (asset service not queried yet) → provide small-size asset if available (since C6.6;
 *   previously always `media.url`).
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
  // Legacy media without hashes during transition period: as is
  assert.equal(playbackUrl({ url: "/api/media/file?path=C%3A%2Fa.mp4" }, [ORIG]), "/api/media/file?path=C%3A%2Fa.mp4");
  // Only has hash, no url: construct hash URL
  assert.equal(playbackUrl({ url: "", hash: ORIG }, []), `/@media/${ORIG}`);
});

test("#3: small asset variant not fully uploaded, original asset fully uploaded → original asset", () => {
  assert.equal(playbackUrl(media, [ORIG], { playable: () => true }), `/@media/${ORIG}`);
  // Media without the small-size asset tier (browser imports only have original-size assets)
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
  // Even if someone wrote playable: true in the project document, ignore it
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
  // C6.6: Query MOV using the ISO BMFF demuxer actually used by Chrome (canPlayType("video/quicktime")
  // always returns empty string in Chrome)
  assert.equal(mimeForExt("MOV"), "video/mp4");
  assert.equal(mimeForExt("xyz"), null);
  assert.equal(hashFromUrl(`/@media/${ORIG}.mp4?x=1`), ORIG);
  assert.equal(hashFromUrl("/@media/name.mp4"), null);
});
