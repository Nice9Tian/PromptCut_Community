/**
 * C6.6 Section 4 (`docs/plan/c66-design.md`): tier switch criteria, warm-up slot alignment and
 * quota, playability probe, prefetch order, export intercept.
 * Run: node --test src/render/tierSwitch.test.mjs
 *
 * Test case name prefixes correspond to design acceptance checks: T5 = opening on other end starts
 * transparent, small-size asset appears, tier switch when original-size asset arrives (frame
 * error within one frame); T6 = preview stays at small-size asset when original-size asset is not
 * playable; T7 = when original-size asset has not arrived, export shows notice "Waiting for
 * uploader", producing no final video.
 * Playability probe uses a mock DOM (only the few things `<video>` needs) without launching a
 * browser; the real browser version is in `scripts/probes/tier-switch-probe.mjs`.
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { chooseTier, playbackUrl, prefetchOrder, missingOriginals, awaitingUploaderMessage, TIERS_KNOWN_LOCAL, TIERS_KNOWN_REMOTE } = await import("./mediaTier.ts");
const { frontTimeAtDisplay, planSlots, tierAligned } = await import("./mediaSync.ts");
const P = await import("./playability.ts");

const ORIG = "a".repeat(64);
const SMALL = "b".repeat(64);
const media = { id: "m1", name: "clip.mov", url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG, small: SMALL }, ext: "mov", kind: "video" };
const never = () => { throw new Error("Should not query playability"); };

/* ---------------- T5: Tier switch criteria ---------------- */

test("T5-tier-1: asset service not asked yet → small media size (the first frame does not fetch the original media size directly), not counted as waiting", () => {
  assert.deepEqual(chooseTier(media, [], { playable: never }), { url: `/@media/${SMALL}`, tier: "small", awaiting: false });
});

test("T5-tier-2: asked, neither tier has fully arrived → mount the original media size, this layer is waiting for the uploader (transparent + hint)", () => {
  const c = chooseTier(media, [TIERS_KNOWN_REMOTE], { playable: never });
  assert.equal(c.url, `/@media/${ORIG}`);
  assert.equal(c.awaiting, true);
});

test("T5-tier-3: small media size arrived → small media size; original media size also arrived and this device can hold it → original media size", () => {
  assert.deepEqual(chooseTier(media, [TIERS_KNOWN_REMOTE, SMALL], { playable: never }), { url: `/@media/${SMALL}`, tier: "small", awaiting: false });
  assert.equal(playbackUrl(media, [TIERS_KNOWN_REMOTE, SMALL, ORIG], { playable: () => true }), `/@media/${ORIG}`);
});

test("T5-tier-4: only the original media size tier exists (imported in the browser) → original media size; waits until it has fully arrived", () => {
  const only = { ...media, tiers: { original: ORIG } };
  assert.equal(chooseTier(only, [], { playable: never }).url, `/@media/${ORIG}`);
  assert.equal(chooseTier(only, [TIERS_KNOWN_LOCAL], { playable: never }).awaiting, true);
  assert.equal(chooseTier(only, [TIERS_KNOWN_LOCAL, ORIG], { playable: never }).awaiting, false);
});

test("T5-tier-5: media without a hash during migration is not counted as waiting", () => {
  const legacy = { url: "/api/media/file?path=C%3A%2Fa.mp4" };
  assert.deepEqual(chooseTier(legacy, [TIERS_KNOWN_LOCAL]), { url: legacy.url, tier: "original", awaiting: false });
});

/* ---------------- T5: Warm-up slots ---------------- */

const sc = (id, url, start, end, offset = 0) => ({ id, url, start, end, offset });
const small = sc("c1", `/@media/${SMALL}`, 0, 10, 0);
const orig = sc("c1", `/@media/${ORIG}`, 0, 10, 0);
const slot = (clip, ready = true) => ({ clip, ready });
const empty = { clip: null, ready: false };

test("T5-align-1: alignment criterion = time differs from the tier currently on screen by at most one frame", () => {
  assert.equal(tierAligned(5.0, 5.0, 30), true);
  assert.equal(tierAligned(5.033, 5.0, 30), true, "within one frame (1/30 s)");
  assert.equal(tierAligned(5.07, 5.0, 30), false, "two frames apart");
  assert.equal(tierAligned(5.04, 5.0, 25), true, "at 25 fps one frame is 40 ms");
  assert.equal(tierAligned(0, 5.0, 30), false, "frame 0 delivered right after a new tier is attached does not count (must not jump back to the start)");
  assert.equal(tierAligned(NaN, 5, 30), false);
});

test("T5-align-2: the foreground frame delivery time is extrapolated to the same display time as the warm-up frame", () => {
  const front = { mediaTime: 2, expectedDisplayTime: 1000 };
  assert.equal(frontTimeAtDisplay(front, 1066.667).toFixed(6), "2.066667");
  assert.equal(tierAligned(2.067, frontTimeAtDisplay(front, 1066.667), 30), true);
  assert.equal(tierAligned(2.133, frontTimeAtDisplay(front, 1066.667), 30), false);
});

test("T5-warm-1: warm-up quota used up → previous tier keeps playing, new tier is not loaded yet", () => {
  const p = planSlots({ slots: [slot(small), empty], shown: 0, cur: orig, next: null, t: 3, playing: true, canWarm: false });
  assert.equal(p.active, 0);
  assert.equal(p.shown, 0);
  assert.equal(p.warm, null);
  assert.equal(p.load[1], null, "no quota, not loaded");
});

test("T5-warm-2: tiers already warming up are not limited by the quota (keep warming, and still swap once aligned)", () => {
  const p = planSlots({ slots: [slot(small), slot(orig, false)], shown: 0, cur: orig, next: null, t: 3, playing: true, canWarm: false });
  assert.equal(p.warm, 1);
  const q = planSlots({ slots: [slot(small), slot(orig, true)], shown: 0, cur: orig, next: null, t: 3, playing: true, canWarm: false });
  assert.equal(q.shown, 1);
  assert.equal(q.warm, null);
});

test("T5-warm-3: during warm-up, the warm-up slot is not used to load the next segment", () => {
  const next = sc("c2", "/@media/" + "c".repeat(64), 10, 12, 0);
  const p = planSlots({ slots: [slot(small), empty], shown: 0, cur: orig, next, t: 9.5, playing: true });
  assert.equal(p.warm, 1);
  assert.equal(p.preload, null);
  assert.equal(p.load[1].url, orig.url);
});

test("T5-warm-4: previous tier never showed a picture (failed while waiting for the uploader) → no warm-up, load the new tier directly like a normal segment switch", () => {
  const p = planSlots({ slots: [slot(orig, false), empty], shown: 0, cur: small, next: null, t: 3, playing: false });
  assert.equal(p.warm, null);
  assert.equal(p.load[p.active].url, small.url);
});

/* ---------------- T5: Prefetch order ---------------- */

test("T5-prefetch-order: all small media first, then all original-size media, each in the order of clips on the timeline; unused ones last; each hash only once", () => {
  const h = (c) => c.repeat(64);
  const project = {
    media: [
      { id: "late", url: `/@media/${h("1")}`, hash: h("1"), tiers: { original: h("1"), small: h("2") } },
      { id: "unused", url: `/@media/${h("3")}`, hash: h("3"), tiers: { original: h("3") } },
      { id: "early", url: `/@media/${h("4")}`, hash: h("4"), tiers: { original: h("4"), small: h("5") } },
      { id: "legacy", url: "/api/media/file?path=x" },
      { id: "dup", url: `/@media/${h("4")}`, hash: h("4"), tiers: { original: h("4"), small: h("5") } },
    ],
    tracks: [
      { id: "t1", clips: [{ id: "a", mediaId: "late", start: 20, end: 30 }] },
      { id: "t2", clips: [{ id: "b", mediaId: "early", start: 0, end: 5 }, { id: "c", mediaId: "late", start: 40, end: 45 }, { id: "d", mediaId: "dup", start: 1, end: 2 }] },
    ],
  };
  assert.deepEqual(prefetchOrder(project).map((i) => `${i.tier}:${i.hash[0]}`), ["small:5", "small:2", "original:4", "original:1", "original:3"]);
});

/* ---------------- T6: Playability ---------------- */

class FakeMedia {
  constructor(tag, env) { this.tag = tag; this.env = env; this.l = {}; this.style = {}; this.videoWidth = 640; this.duration = 3; }
  canPlayType(m) { this.env.asked.push(m); return this.env.canPlay; }
  addEventListener(type, fn) { this.l[type] = fn; }
  set src(v) { this._src = v; queueMicrotask(() => this.env.behavior(this)); }
  get src() { return this._src; }
  removeAttribute() {}
  setAttribute() {}
  load() {}
  remove() { this.env.removed++; }
  requestVideoFrameCallback(cb) { this.rvfc = cb; }
  set currentTime(v) { if (this.rvfc && this.env.frames) setTimeout(() => this.rvfc(0, { mediaTime: v })); }
  fire(type) { this.l[type]?.(); }
}
function fakeDom({ canPlay = "maybe", behavior = (el) => el.fire("loadeddata"), frames = true } = {}) {
  const env = { canPlay, behavior, frames, asked: [], removed: 0, timeouts: [], retries: [], els: [] };
  globalThis.document = { createElement: (tag) => { const el = new FakeMedia(tag, env); env.els.push(el); return el; }, body: { appendChild() {} } };
  globalThis.window = {
    // The moment "unknown" cooldown ends is triggered manually by test case (env.retries), not firing
    // on its own: to avoid spilling into subsequent test cases
    __pcRealSetTimeout: (fn, ms) => {
      env.timeouts.push(ms);
      if (ms >= P.RETRY_UNKNOWN_MS) { env.retries.push(fn); return 0; }
      return setTimeout(fn, Math.min(ms, 30));
    },
    __pcRealNow: () => env.now ?? Date.now(),
  };
  return env;
}
function clearDom() { delete globalThis.document; delete globalThis.window; }

test("T6-probe-1: canPlayType returns an empty string → judged unplayable, recorded in the local cache; preview stays on the small media forever", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ canPlay: "" });
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mxf"), false);
    assert.deepEqual(env.asked, ["application/mxf"]);
    assert.equal(P.playableOnThisHost(ORIG), false);
    for (let i = 0; i < 3; i++) assert.equal(playbackUrl(media, [TIERS_KNOWN_REMOTE, SMALL, ORIG]), `/@media/${SMALL}`, "stays on the small media even when both tiers have arrived");
    assert.equal(playbackUrl(media, [TIERS_KNOWN_REMOTE, ORIG]), `/@media/${ORIG}`, "falls back to the original-size media only when no small media is available");
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-2: MOV is queried with the ISO BMFF container Chrome actually uses (video/mp4); a trial playback that reports an error (such as ProRes) → unplayable", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ canPlay: "maybe", behavior: (el) => el.fire("error") });
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mov"), false);
    assert.deepEqual(env.asked, ["video/mp4"]);
    assert.equal(env.removed, 1, "off-screen element is removed after use");
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-3: after loadeddata, wait until the frame callback actually delivers a frame before judging it playable", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  fakeDom({ canPlay: "probably" });
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4"), true);
    assert.equal(P.playableOnThisHost(ORIG), true);
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
  // loadeddata fired, frame callback never arrives: timeout → unknown (not playable)
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  fakeDom({ canPlay: "probably", frames: false });
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4"), undefined);
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-4: a timeout is recorded as \"unknown\": not cached, no re-probe during cooldown, probe again after cooldown; 5 s local, 10 s remote", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ behavior: () => {} });
  try {
    env.now = 1_000_000;
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4"), undefined);
    assert.equal(await P.probePlayable(SMALL, `/@media/${SMALL}`, "mp4", "video", { remote: true }), undefined);
    assert.deepEqual(env.timeouts.filter((ms) => ms < P.RETRY_UNKNOWN_MS), [P.PROBE_TIMEOUT_LOCAL_MS, P.PROBE_TIMEOUT_REMOTE_MS]);
    assert.equal(P.playableOnThisHost(ORIG), undefined, "unknown is not recorded as unplayable");
    assert.equal(P.shouldProbe(ORIG), false, "cooling down");
    env.now += P.RETRY_UNKNOWN_MS;
    assert.equal(P.shouldProbe(ORIG), true, "probe again after cooldown");
    // Preview serves small-size asset during the unknown period
    assert.equal(playbackUrl(media, [TIERS_KNOWN_LOCAL, SMALL, ORIG], { probe: false }), `/@media/${SMALL}`);
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-4b: first frame arrives after the timeout (slow link): record the late result and notify subscribers, without waiting for a re-probe", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ behavior: () => {} });
  let n = 0;
  const off = P.subscribePlayability(() => n++);
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4", "video", { remote: true }), undefined, "not received within the time limit: unknown");
    assert.equal(env.removed, 0, "off-screen element is kept to keep waiting");
    env.els[0].fire("loadeddata");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(P.playableOnThisHost(ORIG), true, "a late first frame still counts as playable");
    assert.equal(n, 1, "notify as soon as it is recorded (a paused picture layer switches tier on the spot)");
    assert.equal(env.removed, 1, "removed once there is a result");
    env.retries.forEach((fn) => fn());
    assert.equal(n, 1, "a result already exists when the cooldown ends, no extra notification");
  } finally { off(); clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-4c: still no result after the cooldown ends: remove the off-screen element, proactively notify subscribers to re-evaluate (probes again even when paused with no other re-render)", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ behavior: () => {} });
  let n = 0;
  const off = P.subscribePlayability(() => n++);
  try {
    env.now = 2_000_000;
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4", "video", { remote: true }), undefined);
    assert.equal(P.shouldProbe(ORIG), false, "cooling down");
    assert.equal(env.retries.length, 1);
    env.retries[0](); // Cooldown ends (timer on real wall clock); wall clock reading is intentionally not advanced: must really be able to re-probe after notification
    assert.equal(env.removed, 1);
    assert.equal(n, 1, "notified proactively once");
    assert.equal(P.shouldProbe(ORIG), true, "re-evaluation after the notification will probe again");
    assert.equal(P.playableOnThisHost(ORIG), undefined, "still unknown, not recorded as unplayable");
  } finally { off(); clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-5: the cache key includes the browser major version: a changed major version is treated as never probed", () => {
  P.forgetPlayable();
  P.setBrowserMajorForTest("151");
  P.rememberPlayable(ORIG, false);
  assert.equal(P.playableOnThisHost(ORIG), false);
  P.setBrowserMajorForTest("152");
  assert.equal(P.playableOnThisHost(ORIG), undefined);
  P.setBrowserMajorForTest(null);
  P.forgetPlayable();
});

test("T6-probe-6: notify subscribers when a probe reaches a result (the picture layer switches tier on the spot even when paused)", () => {
  P.forgetPlayable();
  let n = 0;
  const off = P.subscribePlayability(() => n++);
  const v0 = P.playabilityVersion();
  P.rememberPlayable(ORIG, true);
  assert.equal(n, 1);
  assert.equal(P.playabilityVersion(), v0 + 1);
  off();
  P.forgetPlayable();
});

/* ---------------- T7: Export intercept ---------------- */

test("T7-gate-1: block only when the original-size media used on the timeline has not fully arrived; unused ones and ones in migration are not blocked; the message says \"waiting for the uploader\" and the media name", () => {
  const h = (c) => c.repeat(64);
  const project = {
    media: [
      { id: "a", name: "开场.mov", url: `/@media/${h("1")}`, hash: h("1"), tiers: { original: h("1"), small: h("2") } },
      { id: "b", name: "结尾.mp4", url: `/@media/${h("3")}`, hash: h("3") },
      { id: "c", name: "unused.mp4", url: `/@media/${h("4")}`, hash: h("4") },
      { id: "d", name: "old-media.mp4", url: "/api/media/file?path=x" },
    ],
    tracks: [{ id: "t", clips: [{ id: "x", mediaId: "b", start: 5, end: 6 }, { id: "y", mediaId: "a", start: 0, end: 5 }, { id: "z", mediaId: "d", start: 6, end: 7 }] }],
  };
  // Even if all small-size assets have arrived, it does not count: export uses only
  // original-size assets
  const missing = missingOriginals(project, [h("2"), h("3")]);
  assert.deepEqual(missing.map((m) => m.name), ["开场.mov"]);
  assert.deepEqual(missingOriginals(project, [h("1"), h("3")]), []);
  const msg = awaitingUploaderMessage(missingOriginals(project, []));
  assert.match(msg, /Waiting for uploader/);
  assert.match(msg, /开场\.mov, 结尾\.mp4/);
  assert.doesNotMatch(msg, /unused/);
});
