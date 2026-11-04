/**
 * Lowest tier (tier selection policy `smallOnly`) "only fetch small-size assets" and remote
 * retrieval address in online browser mode (`docs/plan/c10a-contract.md` section 8).
 * Run: node --test src/render/mediaTierSmallOnly.test.mjs
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
const never = () => { throw new Error("The lowest tier should not query playability (that would pull the original-size first frame)"); };

test("LMT1 lowest tier: if there is a small variant, always give the small variant; even with both tiers ready, do not switch to the original size, and do not query playability", () => {
  const low = { smallOnly: true, playable: never };
  assert.equal(playbackUrl(video, [], low), `/@media/${SMALL}`, "Not asked yet");
  assert.equal(playbackUrl(video, [TIERS_KNOWN_REMOTE, SMALL, ORIG], low), `/@media/${SMALL}`, "Both tiers ready");
  assert.equal(playbackUrl(video, [TIERS_KNOWN_REMOTE, SMALL], low), `/@media/${SMALL}`);
});

test("LMT2 lowest tier: small variant queried but not ready yet → give no URL, wait for the uploader, do not fall back to the original size", () => {
  const c = chooseTier(video, [TIERS_KNOWN_REMOTE, ORIG], { smallOnly: true, playable: never });
  assert.deepEqual(c, { url: "", tier: "none", awaiting: true });
});

test("LMT3 lowest tier: video without a small variant tier → wait for the uploader, do not pull the original size (whether queried or not)", () => {
  assert.deepEqual(chooseTier(videoNoSmall, [], { smallOnly: true, playable: never }), { url: "", tier: "none", awaiting: true });
  assert.deepEqual(chooseTier(videoNoSmall, [TIERS_KNOWN_REMOTE, ORIG], { smallOnly: true, playable: never }), { url: "", tier: "none", awaiting: true });
});

test("LMT4 lowest tier: images and audio have no small variant by the C6.6 design, so they get the original size as usual (deviation noted in the report); old assets during the migration period stay as they are", () => {
  assert.equal(playbackUrl(image, [TIERS_KNOWN_REMOTE, ORIG], { smallOnly: true }), `/@media/${ORIG}`);
  assert.equal(playbackUrl(audio, [TIERS_KNOWN_REMOTE, ORIG], { smallOnly: true }), `/@media/${ORIG}`);
  assert.equal(playbackUrl({ ...image, kind: "video" }, [], { smallOnly: true }), `/@media/${ORIG}`, "An old project registered an image as video, so identify it by extension");
  assert.equal(playbackUrl({ url: "/api/media/file?path=x.mp4" }, [], { smallOnly: true }), "/api/media/file?path=x.mp4");
});

test("LMT5 other tiers are unaffected (default policy)", () => {
  assert.equal(mediaTierPolicy().smallOnly, false);
  assert.equal(playbackUrl(video, [SMALL, ORIG], { playable: () => true }), `/@media/${ORIG}`);
  assert.equal(playbackUrl(videoNoSmall, [TIERS_KNOWN_REMOTE], { playable: never }), `/@media/${ORIG}`);
});

test("LMT6 policy: the module-level smallOnly takes effect; opts can override it", () => {
  try {
    setMediaTierPolicy({ smallOnly: true });
    assert.equal(playbackUrl(video, [TIERS_KNOWN_REMOTE, SMALL, ORIG], { playable: never }), `/@media/${SMALL}`);
    assert.equal(playbackUrl(video, [SMALL, ORIG], { smallOnly: false, playable: () => true }), `/@media/${ORIG}`);
  } finally {
    setMediaTierPolicy({ smallOnly: false });
  }
});

test("LMT7 online browser mode: hash URLs are replaced with the remote asset service's media/<hash>?t=<ticket>; non-hash URLs are left as is", () => {
  const remote = { base: "https://h.example/media/api/asset/", ticket: "tk+/=" };
  assert.equal(remoteMediaUrl(`/@media/${SMALL}`, { base: "https://h.example/media/api/asset", ticket: "tk+/=" }),
    `https://h.example/media/api/asset/media/${SMALL}?t=${encodeURIComponent("tk+/=")}`);
  assert.equal(remoteMediaUrl("/api/media/file?path=x", remote), "/api/media/file?path=x");
  try {
    setMediaTierPolicy({ smallOnly: true, remote });
    assert.equal(playbackUrl(video, []), `https://h.example/media/api/asset/media/${SMALL}?t=${encodeURIComponent("tk+/=")}`);
    setMediaTierPolicy({ remote: { base: "https://h.example/api/asset", ticket: null } });
    assert.equal(playbackUrl(video, []), `https://h.example/api/asset/media/${SMALL}`, "Without a ticket, no query string is attached");
  } finally {
    setMediaTierPolicy({ smallOnly: false, remote: null });
  }
  assert.equal(playbackUrl(video, []), `/@media/${SMALL}`, "The desktop runtime still goes through the local proxy as before");
});

test("LMT8 when the online page's remote asset URL is not ready, do not hand the browser a /@media hash URL", () => {
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

test("LMT9 media preview in the editor (media library thumbnails, waveforms): desktop keeps media.url as is; the online page gets no /@media, and lowest-tier video gets only the remote small variant; notify when the policy changes", () => {
  let calls = 0;
  const off = subscribeMediaTierPolicy(() => { calls++; });
  try {
    assert.equal(previewMediaUrl(video), `/@media/${ORIG}`, "Desktop runtime: character for character identical");
    setMediaTierPolicy({ online: true, smallOnly: true, remote: null });
    assert.equal(calls, 1);
    assert.equal(previewMediaUrl(video), "", "Remote URL not ready: give no URL (send no /@media request)");
    assert.equal(previewMediaUrl(image), "");
    setMediaTierPolicy({ remote: { base: "https://h.example/api/asset", ticket: "t" } });
    assert.equal(calls, 2);
    setMediaTierPolicy({ remote: { base: "https://h.example/api/asset", ticket: "t" } });
    assert.equal(calls, 2, "No notification when nothing changed");
    assert.equal(previewMediaUrl(video), `https://h.example/api/asset/media/${SMALL}?t=t`, "Lowest tier: give only the small variant");
    assert.equal(previewMediaUrl(videoNoSmall), "", "Lowest tier with no small variant: do not pull the original size");
    assert.equal(previewMediaUrl(image), `https://h.example/api/asset/media/${ORIG}?t=t`, "images have only one tier");
    setMediaTierPolicy({ smallOnly: false });
    assert.equal(previewMediaUrl(video), `https://h.example/api/asset/media/${SMALL}?t=t`, "other tiers: the small one of small-then-large");
    assert.equal(previewMediaUrl(videoNoSmall), `https://h.example/api/asset/media/${ORIG}?t=t`);
    for (const m of [video, videoNoSmall, image, audio]) assert.ok(!previewMediaUrl(m).startsWith("/@media/"));
  } finally {
    setMediaTierPolicy({ online: false, smallOnly: false, remote: null });
    off();
  }
});

test("LMT10 /@media/<hash>[.ext] in stage card params: desktop leaves it as is (same reference); online not ready gives an empty string, cookie mode swaps it for /media-s/<sid>/media/<hash>", () => {
  const raw = { photo: `/@media/${ORIG}.jpg`, caption: "户型图", sheetW: 604 };
  try {
    setMediaTierPolicy({ online: false, smallOnly: false, remote: null });
    assert.equal(resolveCardParams(raw), raw, "desktop environment returns the same object reference unchanged");

    setMediaTierPolicy({ online: true, smallOnly: false, remote: null });
    const pending = resolveCardParams(raw);
    assert.deepEqual(pending, { photo: "", caption: "户型图", sheetW: 604 }, "does not request /@media before the online remote address is ready");

    setMediaTierPolicy({ online: true, smallOnly: false, remote: { base: "/media-s/0123456789abcdef0123456789abcdef", ticket: null } });
    const mapped = resolveCardParams(raw);
    assert.deepEqual(mapped, { photo: `/media-s/0123456789abcdef0123456789abcdef/media/${ORIG}`, caption: "户型图", sheetW: 604 });
    assert.equal(resolveCardParams(raw), mapped, "reuses the same reference under the same policy (does not break memo)");
  } finally {
    setMediaTierPolicy({ online: false, smallOnly: false, remote: null });
  }
});
