/**
 * C6.6 第 4 节(`docs/plan/c66-design.md`):换档判据、预热槽位的对齐与名额、可播性探测、预取顺序、导出拦截。
 * 跑:node --test src/render/tierSwitch.test.mjs
 *
 * 用例名前缀对应设计稿的验收:T5 = 另一端打开先透明、素材小尺寸出现、素材原尺寸到了换档(帧误差不超过一帧);
 * T6 = 素材原尺寸不可播时预览停在素材小尺寸;T7 = 素材原尺寸没到时导出提示「等待上传方」、不出片。
 * 可播性探测用一个假的 DOM(只有 `<video>` 要的那几样),不起浏览器;真浏览器的那一份在
 * `scripts/probes/tier-switch-probe.mjs`。
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
const never = () => { throw new Error("不该问可播性"); };

/* ---------------- T5:换档判据 ---------------- */

test("T5-tier-1:还没问过素材服务 → 素材小尺寸(第一帧不直接拉素材原尺寸),不算等待", () => {
  assert.deepEqual(chooseTier(media, [], { playable: never }), { url: `/@media/${SMALL}`, tier: "small", awaiting: false });
});

test("T5-tier-2:问过了、两档都没到齐 → 挂素材原尺寸、这一层在等上传方(透明 + 提示)", () => {
  const c = chooseTier(media, [TIERS_KNOWN_REMOTE], { playable: never });
  assert.equal(c.url, `/@media/${ORIG}`);
  assert.equal(c.awaiting, true);
});

test("T5-tier-3:素材小尺寸到了 → 素材小尺寸;素材原尺寸也到了且这台设备放得了 → 素材原尺寸", () => {
  assert.deepEqual(chooseTier(media, [TIERS_KNOWN_REMOTE, SMALL], { playable: never }), { url: `/@media/${SMALL}`, tier: "small", awaiting: false });
  assert.equal(playbackUrl(media, [TIERS_KNOWN_REMOTE, SMALL, ORIG], { playable: () => true }), `/@media/${ORIG}`);
});

test("T5-tier-4:只有素材原尺寸一档(浏览器里导入的)→ 素材原尺寸;没到齐时等待", () => {
  const only = { ...media, tiers: { original: ORIG } };
  assert.equal(chooseTier(only, [], { playable: never }).url, `/@media/${ORIG}`);
  assert.equal(chooseTier(only, [TIERS_KNOWN_LOCAL], { playable: never }).awaiting, true);
  assert.equal(chooseTier(only, [TIERS_KNOWN_LOCAL, ORIG], { playable: never }).awaiting, false);
});

test("T5-tier-5:迁移期没有哈希的素材不算等待", () => {
  const legacy = { url: "/api/media/file?path=C%3A%2Fa.mp4" };
  assert.deepEqual(chooseTier(legacy, [TIERS_KNOWN_LOCAL]), { url: legacy.url, tier: "original", awaiting: false });
});

/* ---------------- T5:预热槽位 ---------------- */

const sc = (id, url, start, end, offset = 0) => ({ id, url, start, end, offset });
const small = sc("c1", `/@media/${SMALL}`, 0, 10, 0);
const orig = sc("c1", `/@media/${ORIG}`, 0, 10, 0);
const slot = (clip, ready = true) => ({ clip, ready });
const empty = { clip: null, ready: false };

test("T5-align-1:对齐判据 = 与画面上那一档此刻的时刻差不超过一帧", () => {
  assert.equal(tierAligned(5.0, 5.0, 30), true);
  assert.equal(tierAligned(5.033, 5.0, 30), true, "差一帧(1/30 s)以内");
  assert.equal(tierAligned(5.07, 5.0, 30), false, "差两帧");
  assert.equal(tierAligned(5.04, 5.0, 25), true, "25 fps 一帧 40 ms");
  assert.equal(tierAligned(0, 5.0, 30), false, "新档刚挂上交出的第 0 帧不算(不能跳回片头)");
  assert.equal(tierAligned(NaN, 5, 30), false);
});

test("T5-align-2:前台交帧时刻外推到预热帧的同一显示时刻", () => {
  const front = { mediaTime: 2, expectedDisplayTime: 1000 };
  assert.equal(frontTimeAtDisplay(front, 1066.667).toFixed(6), "2.066667");
  assert.equal(tierAligned(2.067, frontTimeAtDisplay(front, 1066.667), 30), true);
  assert.equal(tierAligned(2.133, frontTimeAtDisplay(front, 1066.667), 30), false);
});

test("T5-warm-1:预热名额用完 → 上一档接着放,新档先不装", () => {
  const p = planSlots({ slots: [slot(small), empty], shown: 0, cur: orig, next: null, t: 3, playing: true, canWarm: false });
  assert.equal(p.active, 0);
  assert.equal(p.shown, 0);
  assert.equal(p.warm, null);
  assert.equal(p.load[1], null, "没名额不装");
});

test("T5-warm-2:已经在预热的不受名额限制(接着预热、对齐了照样对调)", () => {
  const p = planSlots({ slots: [slot(small), slot(orig, false)], shown: 0, cur: orig, next: null, t: 3, playing: true, canWarm: false });
  assert.equal(p.warm, 1);
  const q = planSlots({ slots: [slot(small), slot(orig, true)], shown: 0, cur: orig, next: null, t: 3, playing: true, canWarm: false });
  assert.equal(q.shown, 1);
  assert.equal(q.warm, null);
});

test("T5-warm-3:预热期间不拿预热槽位去装下一段", () => {
  const next = sc("c2", "/@media/" + "c".repeat(64), 10, 12, 0);
  const p = planSlots({ slots: [slot(small), empty], shown: 0, cur: orig, next, t: 9.5, playing: true });
  assert.equal(p.warm, 1);
  assert.equal(p.preload, null);
  assert.equal(p.load[1].url, orig.url);
});

test("T5-warm-4:上一档从没出过画(等待上传方时挂失败了)→ 不预热,按普通换段直接装新档", () => {
  const p = planSlots({ slots: [slot(orig, false), empty], shown: 0, cur: small, next: null, t: 3, playing: false });
  assert.equal(p.warm, null);
  assert.equal(p.load[p.active].url, small.url);
});

/* ---------------- T5:预取顺序 ---------------- */

test("T5-prefetch-order:先全部素材小尺寸、再全部素材原尺寸,各按片段在时间轴上的先后;没用到的排最后;同一哈希只一次", () => {
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

/* ---------------- T6:可播性 ---------------- */

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
    // 「未知」冷却结束的那一下由用例手动触发(env.retries),不自己响:免得串到后面的用例里
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

test("T6-probe-1:canPlayType 回空串 → 判放不了、记进本机缓存;预览永远停在素材小尺寸", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ canPlay: "" });
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mxf"), false);
    assert.deepEqual(env.asked, ["application/mxf"]);
    assert.equal(P.playableOnThisHost(ORIG), false);
    for (let i = 0; i < 3; i++) assert.equal(playbackUrl(media, [TIERS_KNOWN_REMOTE, SMALL, ORIG]), `/@media/${SMALL}`, "两档都到齐也停在素材小尺寸");
    assert.equal(playbackUrl(media, [TIERS_KNOWN_REMOTE, ORIG]), `/@media/${ORIG}`, "没有素材小尺寸可给时才回退到素材原尺寸");
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-2:MOV 按 Chrome 实际用的 ISO BMFF 容器问(video/mp4);试放报 error(ProRes 这类)→ 放不了", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ canPlay: "maybe", behavior: (el) => el.fire("error") });
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mov"), false);
    assert.deepEqual(env.asked, ["video/mp4"]);
    assert.equal(env.removed, 1, "离屏元素用完就卸掉");
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-3:loadeddata 之后还要等帧回调真交出一帧才判放得了", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  fakeDom({ canPlay: "probably" });
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4"), true);
    assert.equal(P.playableOnThisHost(ORIG), true);
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
  // 有 loadeddata、帧回调一直不来:超时 → 未知(不是放得了)
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  fakeDom({ canPlay: "probably", frames: false });
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4"), undefined);
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-4:超时记「未知」:不进缓存、冷却期内不重探、过了冷却再探;本地 5 s、远端 10 s", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ behavior: () => {} });
  try {
    env.now = 1_000_000;
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4"), undefined);
    assert.equal(await P.probePlayable(SMALL, `/@media/${SMALL}`, "mp4", "video", { remote: true }), undefined);
    assert.deepEqual(env.timeouts.filter((ms) => ms < P.RETRY_UNKNOWN_MS), [P.PROBE_TIMEOUT_LOCAL_MS, P.PROBE_TIMEOUT_REMOTE_MS]);
    assert.equal(P.playableOnThisHost(ORIG), undefined, "未知不记成放不了");
    assert.equal(P.shouldProbe(ORIG), false, "冷却中");
    env.now += P.RETRY_UNKNOWN_MS;
    assert.equal(P.shouldProbe(ORIG), true, "冷却过了再探");
    // 未知期间预览给素材小尺寸
    assert.equal(playbackUrl(media, [TIERS_KNOWN_LOCAL, SMALL, ORIG], { probe: false }), `/@media/${SMALL}`);
  } finally { clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-4b:超时之后首帧才到(慢链路):按迟到的结论记下并通知订阅方,不等重探", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ behavior: () => {} });
  let n = 0;
  const off = P.subscribePlayability(() => n++);
  try {
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4", "video", { remote: true }), undefined, "时限内没等到:未知");
    assert.equal(env.removed, 0, "离屏元素留着接着等");
    env.els[0].fire("loadeddata");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(P.playableOnThisHost(ORIG), true, "迟到的首帧照样算放得了");
    assert.equal(n, 1, "记下即通知(暂停中的画面层当场换档)");
    assert.equal(env.removed, 1, "有了结论就卸掉");
    env.retries.forEach((fn) => fn());
    assert.equal(n, 1, "冷却结束时已经有结论,不再多通知");
  } finally { off(); clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-4c:冷却结束仍没有结论:卸掉离屏元素、主动通知订阅方重判(暂停着没有别的重渲染也会重探)", async () => {
  P.forgetPlayable(); P.setBrowserMajorForTest("152");
  const env = fakeDom({ behavior: () => {} });
  let n = 0;
  const off = P.subscribePlayability(() => n++);
  try {
    env.now = 2_000_000;
    assert.equal(await P.probePlayable(ORIG, `/@media/${ORIG}`, "mp4", "video", { remote: true }), undefined);
    assert.equal(P.shouldProbe(ORIG), false, "冷却中");
    assert.equal(env.retries.length, 1);
    env.retries[0](); // 冷却结束(真墙钟上的计时器);墙钟读数故意不往前拨:通知之后必须真能重探
    assert.equal(env.removed, 1);
    assert.equal(n, 1, "主动通知了一次");
    assert.equal(P.shouldProbe(ORIG), true, "通知之后重判就会重探");
    assert.equal(P.playableOnThisHost(ORIG), undefined, "仍是未知,不记成放不了");
  } finally { off(); clearDom(); P.setBrowserMajorForTest(null); P.forgetPlayable(); }
});

test("T6-probe-5:缓存键带浏览器主版本:换了主版本就当没探过", () => {
  P.forgetPlayable();
  P.setBrowserMajorForTest("151");
  P.rememberPlayable(ORIG, false);
  assert.equal(P.playableOnThisHost(ORIG), false);
  P.setBrowserMajorForTest("152");
  assert.equal(P.playableOnThisHost(ORIG), undefined);
  P.setBrowserMajorForTest(null);
  P.forgetPlayable();
});

test("T6-probe-6:探出结论时通知订阅方(画面层暂停中也当场换档)", () => {
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

/* ---------------- T7:导出拦截 ---------------- */

test("T7-gate-1:时间轴上用到的素材原尺寸没到齐的才拦;没用到的、迁移期的不拦;提示写「等待上传方」和素材名", () => {
  const h = (c) => c.repeat(64);
  const project = {
    media: [
      { id: "a", name: "开场.mov", url: `/@media/${h("1")}`, hash: h("1"), tiers: { original: h("1"), small: h("2") } },
      { id: "b", name: "结尾.mp4", url: `/@media/${h("3")}`, hash: h("3") },
      { id: "c", name: "没用到.mp4", url: `/@media/${h("4")}`, hash: h("4") },
      { id: "d", name: "老素材.mp4", url: "/api/media/file?path=x" },
    ],
    tracks: [{ id: "t", clips: [{ id: "x", mediaId: "b", start: 5, end: 6 }, { id: "y", mediaId: "a", start: 0, end: 5 }, { id: "z", mediaId: "d", start: 6, end: 7 }] }],
  };
  // 素材小尺寸到齐了也不算:导出只用素材原尺寸
  const missing = missingOriginals(project, [h("2"), h("3")]);
  assert.deepEqual(missing.map((m) => m.name), ["开场.mov"]);
  assert.deepEqual(missingOriginals(project, [h("1"), h("3")]), []);
  const msg = awaitingUploaderMessage(missingOriginals(project, []));
  assert.match(msg, /等待上传方/);
  assert.match(msg, /开场\.mov、结尾\.mp4/);
  assert.doesNotMatch(msg, /没用到/);
});
