/**
 * 舞台闸门与崩溃记录(`stageGate.ts`、`crashLog.ts`;语义 `product/platforms.md`「在线浏览器」的「舞台闸门」,
 * 做法 `mechanism/platforms.md`「三道闸门」的「崩溃记录」「舞台闸门的步骤」)。用例 SG-01～SG-16。
 * 跑:npm test -- src/online/stageGate.test.mjs
 *
 *   SG-01 判「崩了」:离上次还活着不到 1 分钟、没正常离开、不在后台;三样缺一样都不算
 *   SG-02 全新打开(没有记录):从低往高试,目标第三级,起手第一级
 *   SG-03 崩在哪一步停在哪一级:开可见舞台 → 最低一档;试后台舞台 → 第一级;试各一套 → 第二级;运行中第 L 级 → L−1(第一级 → 最低一档)
 *   SG-04 护栏:30 分钟起每崩一次翻倍(30、60、120、240……);护栏内停在上次到达的那一级、不试;过了护栏从头试
 *   SG-05 两种清零:往上试成功一次(试了、下次载入没判崩);软件升级(版本不同)
 *   SG-06 正常刷新(留了正常离开)不算崩;切到后台被回收不算崩;离上次还活着超过 1 分钟(用户过了 1 分钟才点重新加载)按全新打开
 *   SG-07 安卓上的 Chromium 系报不到 8 GB 不试、停在一个舞台;8 GB 才试;电脑上的 Chrome 系、Safari 直接试
 *   SG-08 iPad:停在第一级算手机,要试的先按电脑;别的身份照声明
 *   SG-09 崩在测某张卡:那张卡记进测崩的卡(下次直接当重卡),不算舞台崩、不清零;崩在测基准卡:最低一档、算舞台崩
 *   SG-10 崩在载入原尺寸:解码上限调低一级(累计),不算舞台崩
 *   SG-11 页面一侧:载入时留「开可见舞台」,往上走留每一步,走完留「第几级运行中」;定时更新还活着;正常离开、在后台照实记
 *   SG-12 握手容错退回单舞台:只管当次,不留崩溃记录、不算往上试成功
 *   SG-13 几个标签页:新开的标签页不把另一个还开着的标签页当成崩了(问一声有回音);没回音的才算
 *   SG-14 强制档位(开发与验收用):照它停,不改设备记录
 *   SG-15 记录读不懂、存不下都不抛:当没有记录;只在这一次有效
 *   SG-16 测量与素材的留记录:测完回到原来那一步;测量期间不被素材盖掉
 *   SG-17 测的时候闸门走完了:测完回「第几级运行中」(护栏内、崩过的那一次,基准卡和舞台挂好抢先后)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CRASH_LOG_KEY, CRASH_TAB_KEY, CRASH_WINDOW_MS, HEARTBEAT_MS, emptyLog, judgeLoad, looksCrashed, readCrashLog, writeCrashLog, freshTab,
} from "./crashLog.ts";
import {
  ANDROID_TRY_MEMORY_GIB, BENCHMARK_KEY, GUARD_BASE_MS, beginStageGate, decideStageGate, guardMsOf, levelAfterCrash,
} from "./stageGate.ts";
import { resetTierForTest, tierState } from "./onlineTier.ts";

const V = "v1";
const PC = { kind: "desktop", by: "uaData", ipadLike: false };
const PHONE = { kind: "phone", by: "uaData", ipadLike: false };
const IPAD = { kind: "desktop", by: "ua", ipadLike: true };
const env = (over = {}) => ({ now: 10_000_000, version: V, platform: "Windows", deviceMemory: 8, identity: PC, forced: null, ...over });
const NOT = { crashed: false, step: null, fromTab: null };
const crashAt = (step) => ({ crashed: true, step, fromTab: "t" });

function memKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

test("SG-01 judge \"crashed\": less than 1 minute since last seen alive, did not leave normally, not in background", () => {
  const now = 1_000_000;
  const t = (o) => ({ ...freshTab(now - 5_000, V, false, null), ...o });
  assert.equal(looksCrashed(t({}), now), true);
  assert.equal(looksCrashed(t({ alive: now - CRASH_WINDOW_MS + 1 }), now), true, "59.999 seconds");
  assert.equal(looksCrashed(t({ alive: now - CRASH_WINDOW_MS }), now), false, "exactly 1 minute: treat as a fresh open");
  assert.equal(looksCrashed(t({ left: true }), now), false, "normal exit");
  assert.equal(looksCrashed(t({ background: true }), now), false, "in background");
  assert.equal(looksCrashed(undefined, now), false);
  assert.equal(CRASH_WINDOW_MS, 60_000, "1 minute is a user-decided number");
  assert.ok(HEARTBEAT_MS <= 10_000, "the periodic update interval must be much less than 1 minute");
});

test("SG-02 fresh open: try from low to high (target level 3, starting at level 1)", () => {
  const d = decideStageGate(emptyLog(V), NOT, env());
  assert.deepEqual([d.target, d.reached, d.fixed, d.lowest, d.reason], [3, 1, false, null, "trial"]);
  assert.equal(d.device.stage.tried, true, "record that this attempt was made");
});

test("SG-03 stop at the level where the crash happened", () => {
  const cases = [
    [{ kind: "stage", what: "open-visible" }, 1, true],
    [{ kind: "stage", what: "visible-ready" }, 1, false],
    [{ kind: "stage", what: "try-back" }, 1, false],
    [{ kind: "stage", what: "dual-loaded" }, 2, false],
    [{ kind: "stage", what: "try-separate" }, 2, false],
    [{ kind: "stage", what: "separate-ready" }, 2, false],
    [{ kind: "running", level: 3, lowest: false }, 2, false],
    [{ kind: "running", level: 2, lowest: false }, 1, false],
    [{ kind: "running", level: 1, lowest: false }, 1, true],
    [{ kind: "running", level: 1, lowest: true }, 1, true],
  ];
  for (const [step, level, lowest] of cases) {
    assert.deepEqual(levelAfterCrash(step), { level, lowest }, JSON.stringify(step));
    const d = decideStageGate(emptyLog(V), crashAt(step), env());
    assert.equal(d.fixed, true, "do not try after a crash");
    assert.equal(d.target, level);
    assert.equal(d.lowest, lowest ? "stage" : null);
    assert.equal(d.reason, "crash");
    assert.equal(d.device.stage.crashes, 1, "one crash counts");
  }
});

test("SG-04 guard: starting at 30 minutes, doubles with each crash; within the guard, stay at the last level reached; after the guard, try from the start", () => {
  assert.equal(GUARD_BASE_MS, 30 * 60_000);
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => guardMsOf(n) / 60_000), [30, 60, 120, 240, 480]);
  let log = emptyLog(V);
  let now = 10_000_000;
  // 第 1 次崩(试各一套时):停在第二级,护栏 30 分钟
  let d = decideStageGate(log, crashAt({ kind: "stage", what: "try-separate" }), env({ now }));
  assert.equal(d.device.stage.guardUntil, now + 30 * 60_000);
  log = { ...log, device: d.device };
  // 护栏内重新打开:停在第二级,不试
  d = decideStageGate(log, NOT, env({ now: now + 10 * 60_000 }));
  assert.deepEqual([d.target, d.fixed, d.reason], [2, true, "guard"]);
  log = { ...log, device: d.device };
  // 过了护栏:从头试
  now += 31 * 60_000;
  d = decideStageGate(log, NOT, env({ now }));
  assert.deepEqual([d.target, d.reached, d.fixed, d.reason], [3, 1, false, "trial"]);
  assert.equal(d.device.stage.crashes, 1, "passing the guard only lifts the guard, the crash count is kept (the next crash doubles)");
  log = { ...log, device: d.device };
  // 又崩了(第 2 次):护栏 60 分钟
  d = decideStageGate(log, crashAt({ kind: "stage", what: "try-separate" }), env({ now: now + 1000 }));
  assert.equal(d.device.stage.crashes, 2);
  assert.equal(d.device.stage.guardUntil, now + 1000 + 60 * 60_000);
  // 第 3、4 次:120、240 分钟
  log = { ...log, device: { ...d.device, stage: { ...d.device.stage, guardUntil: null } } };
  d = decideStageGate(log, crashAt({ kind: "running", level: 2, lowest: false }), env({ now }));
  assert.equal(d.device.stage.guardUntil - now, 120 * 60_000);
  log = { ...log, device: { ...d.device, stage: { ...d.device.stage, guardUntil: null } } };
  d = decideStageGate(log, crashAt({ kind: "running", level: 2, lowest: false }), env({ now }));
  assert.equal(d.device.stage.guardUntil - now, 240 * 60_000);
});

test("SG-05 two ways to reset: one successful try upward; software upgrade", () => {
  let log = emptyLog(V);
  let d = decideStageGate(log, crashAt({ kind: "stage", what: "try-back" }), env());
  log = { ...log, device: { ...d.device, stage: { ...d.device.stage, guardUntil: null } } };
  // 过了护栏,这次试了
  d = decideStageGate(log, NOT, env());
  assert.equal(d.device.stage.tried, true);
  log = { ...log, device: d.device };
  // 下次载入没判崩:试成功一次,清零
  d = decideStageGate(log, NOT, env());
  assert.equal(d.device.stage.crashes, 0);
  assert.equal(d.device.stage.guardUntil, null);
  // 软件升级:崩的次数、护栏、测崩的卡、解码上限都清零
  const dirty = { ...emptyLog(V), device: { version: V, stage: { reached: 1, lowest: true, crashes: 3, guardUntil: Date.now() + 1e9, tried: false }, media: { lowered: 2 }, heavyCards: ["k1"] } };
  d = decideStageGate(dirty, NOT, env({ version: "v2" }));
  assert.deepEqual([d.reason, d.device.stage.crashes, d.device.stage.guardUntil, d.device.media.lowered, d.device.heavyCards.length], ["trial", 0, null, 0, 0]);
  assert.equal(d.device.version, "v2");
  // 升级之后的第一次载入看到的「崩了」(旧版本留下的)也不算
  d = decideStageGate(dirty, crashAt({ kind: "stage", what: "open-visible" }), env({ version: "v2" }));
  assert.equal(d.reason, "trial");
});

test("SG-06 a normal refresh is not a crash; being reclaimed in the background is not a crash; reloading after more than 1 minute is treated as a fresh open", () => {
  const now = 50_000_000;
  const log = emptyLog(V);
  log.tabs.a = { ...freshTab(now - 3_000, V, false, { kind: "stage", what: "try-back" }), left: true };
  assert.equal(judgeLoad(log, { tab: "a", fresh: false, now }).crashed, false, "refresh (pagehide recorded a normal exit)");
  log.tabs.a = { ...freshTab(now - 3_000, V, true, { kind: "running", level: 3, lowest: false }) };
  assert.equal(judgeLoad(log, { tab: "a", fresh: false, now }).crashed, false, "reclaimed in the background");
  log.tabs.a = { ...freshTab(now - 61_000, V, false, { kind: "running", level: 3, lowest: false }) };
  assert.equal(judgeLoad(log, { tab: "a", fresh: false, now }).crashed, false, "on the Chrome error page, the user clicked reload after more than 1 minute");
  log.tabs.a = { ...freshTab(now - 3_000, V, false, { kind: "running", level: 3, lowest: false }) };
  const j = judgeLoad(log, { tab: "a", fresh: false, now });
  assert.deepEqual([j.crashed, j.step.kind, j.fromTab], [true, "running", "a"]);
});

test("SG-07 Android Chromium-based browsers reporting under 8 GB do not try; 8 GB tries; Chrome-based browsers and Safari on computers try directly", () => {
  assert.equal(ANDROID_TRY_MEMORY_GIB, 8);
  for (const mem of [0.5, 2, 4, 6, null]) {
    const d = decideStageGate(emptyLog(V), NOT, env({ platform: "Android", deviceMemory: mem, identity: PHONE }));
    assert.deepEqual([d.target, d.fixed, d.reason], [1, true, "android-memory"], `Android ${mem} GB`);
  }
  const ok = decideStageGate(emptyLog(V), NOT, env({ platform: "Android", deviceMemory: 8, identity: PHONE }));
  assert.deepEqual([ok.target, ok.fixed], [3, false], "Android 8 GB: try");
  for (const platform of ["Windows", "macOS", "Linux", "Chrome OS", null]) {
    const d = decideStageGate(emptyLog(V), NOT, env({ platform, deviceMemory: platform ? 4 : null }));
    assert.equal(d.fixed, false, `${platform ?? "Safari (does not report OS)"}: try directly`);
  }
});

test("SG-08 iPad: stopping at level 1 counts as phone, one that needs to try goes as computer first; other identities as declared", () => {
  assert.equal(decideStageGate(emptyLog(V), NOT, env({ identity: IPAD, platform: null, deviceMemory: null })).identity, "desktop", "to try: as computer first");
  assert.equal(decideStageGate(emptyLog(V), crashAt({ kind: "stage", what: "try-back" }), env({ identity: IPAD })).identity, "phone", "crashed, stopped at level 1: phone");
  assert.equal(decideStageGate(emptyLog(V), crashAt({ kind: "stage", what: "try-separate" }), env({ identity: IPAD })).identity, "desktop", "stopped at level 2: computer");
  assert.equal(decideStageGate(emptyLog(V), NOT, env({ identity: PHONE })).identity, "phone");
  assert.equal(decideStageGate(emptyLog(V), crashAt({ kind: "stage", what: "try-back" }), env({ identity: PC })).identity, "desktop", "A PC stopped at the first tier is still a PC");
});

test("SG-09 crash while measuring a card: that card is recorded as a measurement-crash card, not counted as a stage crash; crash while measuring the baseline card: lowest tier", () => {
  const d = decideStageGate(emptyLog(V), crashAt({ kind: "measure", key: "card-k1", cardId: "fancy" }), env());
  assert.deepEqual(d.device.heavyCards, ["card-k1"]);
  assert.equal(d.reason, "trial", "Stage is tried as usual");
  assert.equal(d.device.stage.crashes, 0);
  // 上次试过、这次判崩(崩在测卡):不算往上试成功,不清零
  const log = { ...emptyLog(V), device: { ...emptyLog(V).device, stage: { reached: 3, lowest: false, crashes: 2, guardUntil: null, tried: true } } };
  const d2 = decideStageGate(log, crashAt({ kind: "measure", key: "card-k2", cardId: null }), env());
  assert.equal(d2.device.stage.crashes, 2, "Not reset to zero");
  const b = decideStageGate(emptyLog(V), crashAt({ kind: "measure", key: BENCHMARK_KEY, cardId: null }), env());
  assert.deepEqual([b.lowest, b.fixed, b.reason, b.device.stage.crashes], ["benchmark", true, "crash", 1]);
});

test("SG-10 crash while loading original size: decode limit is lowered one level (cumulative), not counted as a stage crash", () => {
  let log = emptyLog(V);
  let d = decideStageGate(log, crashAt({ kind: "media", capLevel: 3 }), env());
  assert.equal(d.device.media.lowered, 1);
  assert.equal(d.reason, "trial");
  log = { ...log, device: d.device };
  d = decideStageGate(log, crashAt({ kind: "media", capLevel: 2 }), env());
  assert.equal(d.device.media.lowered, 2);
});

/** 页面一侧的会话:存储都是假的,时钟手动拨 */
async function open({ local = memKV(), session = memKV(), now = 1_000, ping, envOver = {} } = {}) {
  let t = now;
  const clock = { now: () => t, set: (v) => { t = v; } };
  resetTierForTest();
  const g = await beginStageGate({ local, session, now: clock.now, version: V, ping, listen: false, hidden: () => false, env: { platform: "Windows", deviceMemory: 8, identity: PC, ...envOver } });
  return { g, local, session, clock, log: () => readCrashLog(local, V) };
}

test("SG-11 page side: loading leaves \"open visible stage\", going up leaves every step, finishing leaves running; the record carries the software version", async () => {
  const s = await open();
  try {
    let tab = s.log().tabs[s.g.tab];
    assert.deepEqual(tab.step, { kind: "stage", what: "open-visible" });
    assert.equal(tab.version, V);
    assert.equal(s.session.getItem(CRASH_TAB_KEY), s.g.tab, "Tab id is stored in sessionStorage");
    assert.deepEqual([tierState().target, tierState().reached, tierState().gate], [3, 1, "trying"]);
    s.g.stage("visible-ready"); s.g.reached(1);
    s.g.stage("try-back");
    assert.deepEqual(s.log().tabs[s.g.tab].step, { kind: "stage", what: "try-back" });
    s.g.stage("dual-loaded"); s.g.reached(2);
    s.g.stage("try-separate");
    s.g.stage("separate-ready"); s.g.reached(3);
    s.g.done();
    tab = s.log().tabs[s.g.tab];
    assert.deepEqual(tab.step, { kind: "running", level: 3, lowest: false });
    assert.equal(s.log().device.stage.reached, 3);
    assert.equal(tierState().gate, "done");
    // 运行中崩了(重新载入同一个标签页):停在第二级
    s.clock.set(5_000);
    const again = await open({ local: s.local, session: s.session, now: 6_000 });
    assert.deepEqual([again.g.judged.crashed, again.g.decision.target, again.g.decision.fixed], [true, 2, true]);
    again.g.dispose();
  } finally { s.g.dispose(); }
});

test("SG-12 handshake fault tolerance falls back to a single stage: affects only the current run, leaves no crash record, does not count as a successful step up", async () => {
  const s = await open();
  try {
    s.g.stage("visible-ready"); s.g.reached(1);
    s.g.stage("try-back");
    s.g.fallback(1);
    assert.deepEqual([tierState().target, tierState().reached, tierState().gate], [1, 1, "done"]);
    assert.deepEqual(s.log().tabs[s.g.tab].step, { kind: "running", level: 1, lowest: false }, "Does not leave the \"try background stage\" step (otherwise a reload would treat it as crashed there)");
    assert.equal(s.log().device.stage.tried, false, "Not counted as a step-up attempt");
  } finally { s.g.dispose(); }
});

test("SG-13 several tabs: a newly opened tab does not treat another still-open tab as crashed; only one with no reply counts", async () => {
  const local = memKV();
  const opened = [];
  try {
    const first = await open({ local, now: 1_000 });
    opened.push(first);
    first.g.stage("visible-ready");
    // 另一个新标签页(没有 sessionStorage),3 秒后打开:第一个还开着,问一声有回音
    const second = await open({ local, now: 4_000, ping: async (ids) => new Set(ids) });
    opened.push(second);
    assert.equal(second.g.judged.crashed, false);
    assert.equal(second.g.decision.reason, "trial");
    // 再开一个:第二个还开着(回音),第一个没回音(其实已经崩了,用户新开了标签页):算崩,判据来自第一个
    const third = await open({ local, now: 5_000, ping: async () => new Set([second.g.tab]) });
    opened.push(third);
    assert.equal(third.g.judged.crashed, true);
    assert.equal(third.g.judged.fromTab, first.g.tab);
    assert.equal(third.g.decision.target, 1, "Crash after the visible stage is ready, background not tried: stay at the first tier");
    assert.equal(readCrashLog(local, V).tabs[first.g.tab].left, true, "The segment already counted is marked as left and not counted again");
  } finally {
    for (const o of opened) o.g.dispose();
  }
});

test("SG-14 forced tier (for development and acceptance checks): stop at it, do not change the device record", async () => {
  const s = await open({ envOver: { forced: "low" } });
  try {
    assert.deepEqual([s.g.decision.reason, s.g.decision.lowest, tierState().lowest, tierState().target], ["forced", "stage", "stage", 1]);
    s.g.done();
    assert.equal(s.log().device.stage.reached, null, "A forced tier is not written to the device record");
  } finally { s.g.dispose(); }
});

test("SG-15 an unreadable record or a failed save never throws", async () => {
  const bad = memKV({ [CRASH_LOG_KEY]: "{not json" });
  assert.deepEqual(readCrashLog(bad, V).tabs, {});
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
  assert.equal(writeCrashLog(broken, emptyLog(V)), false);
  const s = await open({ local: broken, session: broken });
  assert.equal(s.g.decision.reason, "trial");
  s.g.stage("visible-ready");
  s.g.done();
  s.g.dispose();
});

test("SG-16 measurement and media leave records: after measuring, return to the previous step; during measurement it is not overwritten by media", async () => {
  const s = await open();
  try {
    s.g.stage("visible-ready"); s.g.reached(1);
    s.g.done();
    const running = s.log().tabs[s.g.tab].step;
    s.g.measureStart("card-k", "fancy");
    assert.deepEqual(s.log().tabs[s.g.tab].step, { kind: "measure", key: "card-k", cardId: "fancy" });
    s.g.mediaStart(2);
    assert.equal(s.log().tabs[s.g.tab].step.kind, "measure", "Media does not overwrite during measurement (a crash is counted against the card being measured)");
    s.g.measureEnd();
    assert.deepEqual(s.log().tabs[s.g.tab].step, running);
    s.g.mediaStart(2);
    assert.deepEqual(s.log().tabs[s.g.tab].step, { kind: "media", capLevel: 2 });
    s.g.mediaEnd();
    assert.deepEqual(s.log().tabs[s.g.tab].step, running);
    // 测崩的卡:下次载入直接在测崩的卡表里
    s.g.measureStart("card-boom", "boom");
    const again = await open({ local: s.local, session: s.session, now: 3_000 });
    assert.ok(again.g.heavyCards().has("card-boom"));
    again.g.dispose();
  } finally { s.g.dispose(); }
});

test("SG-17 measurement started while still at some step of the stage gate, and the gate finished during the measurement: after measuring, return to \"tier N running\", not to that step", async () => {
  const s = await open();
  try {
    s.g.stage("visible-ready");
    s.g.measureStart("@benchmark", "punch-pill");
    s.g.reached(1);
    s.g.done();
    s.g.measureEnd();
    assert.equal(s.log().tabs[s.g.tab].step.kind, "running", "It returns to running, not to the stale \"visible stage ready\"");
    s.g.mediaStart(2);
    s.g.mediaEnd();
    assert.equal(s.log().tabs[s.g.tab].step.kind, "running");
  } finally { s.g.dispose(); }
});
