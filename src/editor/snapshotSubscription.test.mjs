/**
 * 根因 E 的回归测试:就绪索引的订阅只按 session 做键,编辑(localRev + 1)不重连、不清表。
 * 跑:node --experimental-test-module-mocks --test src/editor/snapshotSubscription.test.mjs
 *
 * 以前 `syncSnapshotSubscription` 的键是 `session#localRev`:每次编辑 localRev + 1 就清空 readyIndex、
 * 重连 SSE,而服务端 `/api/frames/ready` 根本不看 session / localRev(`vite-plugin-frames.ts`)。
 * 重连空档里播放中的重卡一律透明。现在:客户端不再抢先清表,只听服务端的 `reset`
 * (预渲染进程在 `adoptCardPlan` 换了 entry 时发)。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
let key = { session: "s", localRev: 1 };
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => key, pushWanted: () => {} } });
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]) }] }) } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));

test("编辑不重连、不清表;服务端 reset 才清;换 session 才重连", () => {
  const subs = [];
  feed.setSnapshotSource({
    subscribeReady: (session, rev, cb) => { const sub = { session, rev, cb, closed: false }; subs.push(sub); return () => { sub.closed = true; }; },
    fetchSnapshot: async () => "<div/>",
  });
  feed.syncSnapshotSubscription(() => {});
  assert.equal(subs.length, 1);
  subs[0].cb({ type: "layer", clipId: "h", kind: "html", key: "K", ranges: [[0, 299]] });
  assert.ok(feed.currentReadyIndex().get("h"), "层到了");

  // 用户编辑:localRev + 1,宿主照常再调一次
  key = { session: "s", localRev: 2 };
  feed.syncSnapshotSubscription(() => {});
  assert.equal(subs.length, 1, "同一个 session 不重连");
  assert.equal(subs[0].closed, false);
  assert.ok(feed.currentReadyIndex().get("h"), "客户端不抢先清表:旧层留着顶上,直到服务端 reset");

  // 服务端换了 entry:reset + 全量 layer
  subs[0].cb({ type: "reset", localRev: 2 });
  assert.equal(feed.currentReadyIndex().size, 0, "reset 清表");
  subs[0].cb({ type: "layer", clipId: "h", kind: "html", key: "K2", ranges: [[0, 10]] });
  assert.equal(feed.currentReadyIndex().get("h").get("html").key, "K2");

  // 换项目(session 变了):重连并清表
  key = { session: "s2", localRev: 1 };
  feed.syncSnapshotSubscription(() => {});
  assert.equal(subs.length, 2);
  assert.equal(subs[0].closed, true);
  assert.equal(subs[1].session, "s2");
  assert.equal(feed.currentReadyIndex().size, 0);
});
