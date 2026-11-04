/**
 * C10a capability gate: assets only fetch small size in the lowest tier (`docs/plan/c10a-contract.md`
 * Section 8 "Assets only fetch small size", Section 12 "Capability gates").
 * Run: node --experimental-test-module-mocks --test src/render/c10a-gates.test.mjs
 *
 * How the lowest tier tells `mediaTier.ts`: `opts.smallOnly === true` (originally hypothesis K3
 * `opts.lowMemory`, renamed on 2026-10-22 when low-memory tier was revoked).
 * Skip the whole suite when `src/online/onlineTier.ts` is absent. Playability module is replaced
 * with a stub, recording whether it probed original size (probing needs to pull the first frame
 * of original size).
 *
 * Video assets only: C6.6 only provides small-size assets for video (`c66-design.md` Section 2);
 * what to do with images and audio in the lowest tier is not specified in the contract,
 * see correction recommendations in the report.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { exists, skipIf, TIER_FILE } from "../../server/test/c10a-kit.mjs";

const missing = !exists(TIER_FILE);
const skip = skipIf(missing, `${TIER_FILE} (the small-size-only branch of mediaTier follows the tier)`);
const it = (name, fn) => test(name, { skip }, fn);

const probes = [];
let T = null;
if (!missing) {
  mock.module(srcUrl("render/playability.ts"), {
    exports: {
      playableOnThisHost: () => undefined,
      probePlayable: async (...args) => { probes.push(args); return undefined; },
      shouldProbe: () => true,
      rememberPlayable: () => {},
      forgetPlayable: () => {},
    },
  });
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: true } });
  T = await import(srcUrl("render/mediaTier.ts"));
}
beforeEach(() => { probes.length = 0; });

const h = (c) => c.repeat(64);
const ORIG = h("a");
const SMALL = h("b");
const video = { id: "v", kind: "video", ext: "mp4", url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG, small: SMALL } };
const onlyOriginal = { id: "o", kind: "video", ext: "mp4", url: `/@media/${h("c")}`, hash: h("c"), tiers: { original: h("c") } };
const REMOTE = "@known:remote";
const LOW = { smallOnly: true };

it("C10A-GT-01 lowest tier: both tiers arrived and original size can be placed, still give small size; do not probe original size", () => {
  const all = [REMOTE, ORIG, SMALL];
  assert.equal(T.playbackUrl(video, all, { ...LOW, playable: () => true }), `/@media/${SMALL}`);
  assert.equal(T.playbackUrl(video, all, { ...LOW, playable: () => undefined }), `/@media/${SMALL}`);
  assert.equal(probes.length, 0, "do not probe original size even when playability is unknown");
  assert.equal(T.chooseTier(video, all, LOW).tier, "small");
  // Control: other tiers switch back to original size per C6.6
  assert.equal(T.playbackUrl(video, all, { playable: () => true }), `/@media/${ORIG}`);
});

/*
 * Integration reconciliation changed this rule: the implementation does not attach a URL
 * (`url: ''`, `tier: 'none'`, `awaiting: true`) when "the asset service was queried, but small
 * size is not ready yet"; this layer displays a placeholder and a "Waiting for uploader" badge;
 * after small size is fully ready, the URL changes from empty to small size and attaches again,
 * rather than attaching a small-size URL not yet on the asset service (which causes 404 and is
 * recorded by the stage as video decoding failure). What remains unchanged is what this rule
 * verifies: never provide original size. As before, provide small size first when the asset
 * service has not been queried yet.
 */
it("C10A-GT-02 lowest tier: only original size arrived, small size has not, still do not give original size (this layer waits for the uploader, no URL that has not arrived is attached)", () => {
  const choice = T.chooseTier(video, [REMOTE, ORIG], LOW);
  assert.notEqual(choice.tier, "original");
  assert.equal(choice.url.includes(ORIG), false, `the URL must not contain original size: ${choice.url}`);
  assert.equal(choice.awaiting, true, "this layer is waiting for the uploader");
  assert.equal(T.chooseTier(video, [], LOW).url, `/@media/${SMALL}`, "asset service not queried yet: give small size first");
  const none = T.chooseTier(video, [REMOTE], LOW);
  assert.equal(none.url.includes(ORIG), false, "no tier arrived: do not give original size");
  assert.equal(none.awaiting, true, "no tier arrived: wait for the uploader");
});

it("C10A-GT-03 lowest tier: a video without small size does not fetch original size, this layer waits for the uploader (placeholder + badge)", () => {
  for (const hashes of [[], [REMOTE], [REMOTE, h("c")]]) {
    const choice = T.chooseTier(onlyOriginal, hashes, LOW);
    assert.notEqual(choice.tier, "original", `hashes=${JSON.stringify(hashes)}`);
    assert.equal(choice.url.includes(h("c")), false, `the URL must not contain original size: ${choice.url}`);
    if (hashes.length) assert.equal(choice.awaiting, true, "after the asset service was queried, this layer is waiting for the uploader");
  }
  assert.equal(T.playbackUrl(onlyOriginal, [REMOTE, h("c")], LOW).includes(h("c")), false);
});

it("C10A-GT-04 lowest tier + online asset service: the small-size URL is built on the public URL of the asset service", () => {
  const base = "https://203-0-113-16.sslip.io/media/api/asset";
  const url = T.playbackUrl(video, [REMOTE, ORIG, SMALL], { ...LOW, cloudBase: base, playable: () => true });
  assert.ok(url.startsWith(base), url);
  assert.ok(url.endsWith(SMALL), url);
});
