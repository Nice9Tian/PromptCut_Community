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
const P0 = { fps: 30, tracks: [{ id: "t", clips: [card({ text: "旧字" })] }] };
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
  assert.deepEqual(feed.suppressedAt(head), ["h"], "暂停时未 settled 先抑制");
});

test("settled 之后改卡:暂停中不再抑制", async () => {
  feed.noteSettled("front", ["h"]);
  sent.length = 0;
  head = { project: P1, t: 1, playing: false };
  assert.deepEqual(feed.suppressedAt(head), [], "settled 的卡不再抑制");
  assert.deepEqual(feed.planFeed(head).scrub, [], "planFeed 暂停态也不再进 scrub");
});

test("下一次 setTime 清掉 settled:同一张卡照常进入抑制", async () => {
  feed.noteSettled("front", ["h"]);
  head = { project: P0, t: 2, playing: false };
  feed.pickForSetTime(head);
  assert.deepEqual(feed.suppressedAt(head), ["h"], "setTime 之后重新进入抑制");
});

test("起播清掉 settled:播放后回到暂停照常进入抑制", async () => {
  feed.noteSettled("front", ["h"]);
  head = { project: P0, t: 1, playing: true };
  await feed.deliverSnapshots(stage, "front", head);
  head = { project: P0, t: 1, playing: false };
  assert.deepEqual(feed.suppressedAt(head), ["h"], "播放过一次之后 settled 已经清空");
});

test("暂停态互换之后整台精确:markAllSettled 期间一张都不抑制,setTime 后恢复", async () => {
  feed.markAllSettled("front");
  assert.deepEqual(feed.suppressedAt(head), [], "互换后整台精确,不抑制");
  feed.pickForSetTime({ project: P0, t: 1.5, playing: false });
  assert.deepEqual(feed.suppressedAt({ project: P0, t: 1.5, playing: false }), ["h"], "setTime 后恢复抑制");
});
