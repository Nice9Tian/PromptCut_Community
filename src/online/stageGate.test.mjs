/**
 * Stage gate and crash log (`stageGate.ts`, `crashLog.ts`; semantics in "Stage gate" under "Online browser"
 * in `product/platforms.md`, implementation in "Crash log" and "Stage gate steps" under "Three gates" in
 * `mechanism/platforms.md`). Test cases SG-01-SG-16.
 * Run: npm test -- src/online/stageGate.test.mjs
 *
 *   SG-01 Classify as "crashed": <1 min since last alive, did not exit normally, not in background;
 *     missing any does not count
 *   SG-02 Clean open (no record): test from low to high, target level 3, start at level 1
 *   SG-03 Stop at level where crash occurred: open visible stage → lowest tier;
 *     test background stage → level 1; test one set of each → level 2;
 *     running at level L → L-1 (level 1 → lowest tier)
 *   SG-04 Guard: doubles each crash starting from 30 min (30, 60, 120, 240...); within guard, stay at
 *     last reached level without testing; past guard, test from the beginning
 *   SG-05 Two reset conditions: one successful upward test (tested, next load not classified as
 *     crashed); software upgrade (version differs)
 *   SG-06 Normal refresh (recorded normal exit) does not count as crash; switched to background and
 *     reclaimed does not count as crash; >1 min since last alive (user reloaded after 1 min) treated
 *     as clean open
 *   SG-07 Chromium-based on Android reporting <8 GB does not test, stays at single stage; tests only
 *     at 8 GB; Chrome-based and Safari on desktop test directly
 *   SG-08 iPad: staying at level 1 treated as mobile, testing treated as desktop first; other
 *     identities as declared
 *   SG-09 Crash testing a card: record card into crash-tested cards (treated directly as heavy card
 *     next time), not a stage crash, no reset; crash testing baseline card: lowest tier, stage crash
 *   SG-10 Crash loading original size: lower decode limit by one level (cumulative), not a stage crash
 *   SG-11 Page side: record "open visible stage" on load, each step moving up, and "running at level N"
 *     when done; periodically update alive; record normal exit and in-background truthfully
 *   SG-12 Handshake fault-tolerant fallback to single stage: applies to current run only, leaves no
 *     crash log, does not count as successful upward test
 *   SG-13 Multiple tabs: a new tab does not treat another open tab as crashed (ping has echo);
 *     only counts if no echo
 *   SG-14 Forced tier (for dev and acceptance check): stop accordingly, do not change device record
 *   SG-15 Unreadable or unsaveable records do not throw: treat as no record; valid for this run only
 *   SG-16 Recording for measurement and assets: return to original step after measurement; not
 *     overwritten by assets during measurement
 *   SG-17 Gate finished while measuring: return to "running at level N" after measurement (within guard,
 *     the run that crashed, race between baseline card and stage mounting)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CRASH_LOG_KEY, CRASH_TAB_KEY, CRASH_WINDOW_MS, HEARTBEAT_MS, emptyLog, judgeLoad, looksCrashed, readCrashLog, writeCrashLog, freshTab,
} from "./crashLog.ts";
import {
  ANDROID_TRY_MEMORY_GIB, BENCHMARK_KEY, GUARD_BASE_MS, beginStageGate, decideStageGate, guardMsOf, levelAfterCrash, readGateEnv,
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
  // 1st crash (when testing one set of each): stay at level 2, guard 30 minutes
  let d = decideStageGate(log, crashAt({ kind: "stage", what: "try-separate" }), env({ now }));
  assert.equal(d.device.stage.guardUntil, now + 30 * 60_000);
  log = { ...log, device: d.device };
  // Reopened within guard: stay at level 2, do not test
  d = decideStageGate(log, NOT, env({ now: now + 10 * 60_000 }));
  assert.deepEqual([d.target, d.fixed, d.reason], [2, true, "guard"]);
  log = { ...log, device: d.device };
  // Past guard: test from the beginning
  now += 31 * 60_000;
  d = decideStageGate(log, NOT, env({ now }));
  assert.deepEqual([d.target, d.reached, d.fixed, d.reason], [3, 1, false, "trial"]);
  assert.equal(d.device.stage.crashes, 1, "passing the guard only lifts the guard, the crash count is kept (the next crash doubles)");
  log = { ...log, device: d.device };
  // Crashed again (2nd time): guard 60 minutes
  d = decideStageGate(log, crashAt({ kind: "stage", what: "try-separate" }), env({ now: now + 1000 }));
  assert.equal(d.device.stage.crashes, 2);
  assert.equal(d.device.stage.guardUntil, now + 1000 + 60 * 60_000);
  // 3rd and 4th times: 120, 240 minutes
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
  // Past guard, tested this time
  d = decideStageGate(log, NOT, env());
  assert.equal(d.device.stage.tried, true);
  log = { ...log, device: d.device };
  // Next load not classified as crashed: test succeeded once, reset
  d = decideStageGate(log, NOT, env());
  assert.equal(d.device.stage.crashes, 0);
  assert.equal(d.device.stage.guardUntil, null);
  // Software upgrade: crash count, guard, crash-tested cards, and decode limit all reset
  const dirty = { ...emptyLog(V), device: { version: V, stage: { reached: 1, lowest: true, crashes: 3, guardUntil: Date.now() + 1e9, tried: false }, media: { lowered: 2 }, heavyCards: ["k1"] } };
  d = decideStageGate(dirty, NOT, env({ version: "v2" }));
  assert.deepEqual([d.reason, d.device.stage.crashes, d.device.stage.guardUntil, d.device.media.lowered, d.device.heavyCards.length], ["trial", 0, null, 0, 0]);
  assert.equal(d.device.version, "v2");
  // "Crashed" seen on first load after upgrade (left by old version) does not count either
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
  // Tested last time, classified as crashed this time (crashed testing cards):
  // does not count as upward test success, no reset
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

/** Page-side session: storage is mocked, clock is advanced manually */
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
    // Crashed during runtime (reloading the same tab): stay at level 2
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
    // Another new tab (no sessionStorage), opened 3s later: first tab still open, ping gets echo
    const second = await open({ local, now: 4_000, ping: async (ids) => new Set(ids) });
    opened.push(second);
    assert.equal(second.g.judged.crashed, false);
    assert.equal(second.g.decision.reason, "trial");
    // Open another: second still open (echo), first has no echo (actually crashed, user opened new tab):
    // counts as crash, criterion comes from the first
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
    // Crash-tested cards: appear directly in crash-tested cards table on next load
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

test("SG-18 readGateEnv falls back to Android userAgent on non-HTTPS origins without userAgentData", () => {
  const androidHttp = readGateEnv({
    userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36",
    maxTouchPoints: 5,
  });
  assert.equal(androidHttp.platform, "Android");
  assert.equal(androidHttp.deviceMemory, null);
  const dHttp = decideStageGate(emptyLog(V), NOT, env({ ...androidHttp }));
  assert.deepEqual([dHttp.target, dHttp.fixed, dHttp.reason], [1, true, "android-memory"]);

  const androidHttps8Gb = readGateEnv({
    userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36",
    userAgentData: { platform: "Android", mobile: true },
    deviceMemory: 8,
    maxTouchPoints: 5,
  });
  assert.equal(androidHttps8Gb.platform, "Android");
  assert.equal(androidHttps8Gb.deviceMemory, 8);
  const dHttps = decideStageGate(emptyLog(V), NOT, env({ ...androidHttps8Gb }));
  assert.deepEqual([dHttps.target, dHttps.fixed], [3, false]);

  const safariIos = readGateEnv({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
  });
  assert.equal(safariIos.platform, null);

  const linuxUaDataOverrides = readGateEnv({
    userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
    userAgentData: { platform: "Linux", mobile: false },
    deviceMemory: 4,
  });
  assert.equal(linuxUaDataOverrides.platform, "Linux");
});

