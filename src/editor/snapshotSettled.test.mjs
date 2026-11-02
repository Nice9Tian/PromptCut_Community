/**
 * 根因 B 的回归测试:暂停态重卡已经 settled(精确活渲、舞台摘了快照)之后,父页不能再把快照投回去。
 * 跑:node --experimental-test-module-mocks --test src/editor/snapshotSettled.test.mjs
 *
 * 以前 `noteSettled` 只删投递基线;之后任何一条 SSE 消息触发的 `pumpFeed` → `deliverSnapshots`
 * 都会把(可能是改之前旧键的)快照重新投回去,盖在已经改好的活组件上 —— 违背「停下就精确」。
 *
 * 现在:父页记「暂停态已 settled」集合,暂停中不再给这些卡投快照;下一次 `setTime`(`pickForSetTime`)
 * 或播放时清空。暂停态第二路互换之后整台都是精确活渲,`markAllSettled` 一并收下。
 *
 * 真模块:snapshotFeed.ts(planFeed / deliverSnapshots / noteSettled)、snapshotPick、pipelinePlan。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
mock.module(srcUrl("store/project.ts"), { exports: { getState: () => ({}), subscribe: () => () => {} } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]) }] }) } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));

let push = null;
const sent = [];
const stage = { setSnapshots: async (patch, opts) => { sent.push({ patch, opts }); return { ok: true }; } };
const card = (params) => ({ id: "h", cardId: "c", start: 0, end: 10, params });
const P0 = { fps: 30, tracks: [{ id: "t", clips: [card({ text: "Old text" })] }] };
const P1 = { fps: 30, tracks: [{ id: "t", clips: [card({ text: "" })] }] };   // 用户删掉了卡里的字
const tick = () => new Promise((r) => setTimeout(r, 40));   // > 33 ms 节流
let head;

beforeEach(async () => {
  feed.resetSnapshotFeed();
  feed.setSnapshotSource({
    subscribeReady: (_s, _r, cb) => { push = cb; return () => {}; },
    fetchSnapshot: async (kind, key, f) => `<div>${key}@${f}</div>`,
  });
  sent.length = 0;
  head = { project: P0, t: 1, playing: false };
  feed.syncSnapshotSubscription(() => { void feed.deliverSnapshots(stage, "front", head); });
  push({ type: "layer", clipId: "h", kind: "html", key: "OLDKEY", ranges: [[0, 299]] });
  assert.deepEqual(feed.suppressedAt(head), ["h"], "When paused, suppress first if not yet settled");
});

test("Editing a card after settled: no longer suppressed while paused", async () => {
  feed.noteSettled("front", ["h"]);
  sent.length = 0;
  head = { project: P1, t: 1, playing: false };
  assert.deepEqual(feed.suppressedAt(head), [], "A settled card is no longer suppressed");
  assert.deepEqual(feed.planFeed(head).scrub, [], "planFeed no longer puts it into scrub in the paused state either");
});

test("The next setTime clears settled: the same card enters suppression as usual", async () => {
  feed.noteSettled("front", ["h"]);
  head = { project: P0, t: 2, playing: false };
  feed.pickForSetTime(head);
  assert.deepEqual(feed.suppressedAt(head), ["h"], "Re-enters suppression after setTime");
});

test("Starting playback clears settled: after playing and returning to pause, it enters suppression as usual", async () => {
  feed.noteSettled("front", ["h"]);
  head = { project: P0, t: 1, playing: true };
  await feed.deliverSnapshots(stage, "front", head);
  head = { project: P0, t: 1, playing: false };
  assert.deepEqual(feed.suppressedAt(head), ["h"], "After playing once, settled has been cleared");
});

test("After a swap in paused state, the whole stage is exact: during markAllSettled no card is suppressed, and suppression resumes after setTime", async () => {
  feed.markAllSettled("front");
  assert.deepEqual(feed.suppressedAt(head), [], "After the swap the whole stage is exact, no suppression");
  feed.pickForSetTime({ project: P0, t: 1.5, playing: false });
  assert.deepEqual(feed.suppressedAt({ project: P0, t: 1.5, playing: false }), ["h"], "Suppression resumes after setTime");
});
