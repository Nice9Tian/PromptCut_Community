import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { SyncLink } = await import(srcUrl("editor/sync/link.ts"));
const { createEmptyProject } = await import(srcUrl("kernel/project.ts"));
const { parseSessionItem } = await import("../../../server/docservice/session.mjs");
const pause = ms => new Promise(r => setTimeout(r, ms));
function link(protocols, onProtocolError) {
  return new SyncLink({ url: "ws://isolated.invalid", projectId: "room", session: "probe", initial: createEmptyProject("saved-content"),
    protocols, onProtocolError, reconnect: { minMs: 1, maxMs: 3 } });
}
test("可信接口明确拒绝后终止连接，不按网络故障反复认证", async () => {
  let attempts = 0, classified = 0;
  const c = link(async () => { attempts++; throw { status: 410 }; }, e => { classified++; assert.equal(e.status, 410); return true; });
  c.start(); await pause(60);
  assert.equal(attempts, 1); assert.equal(classified, 1); assert.equal(c.connected, false);
  c.start(); await pause(10); assert.equal(attempts, 1);
});
test("暂时取证明失败继续重试，停止后不再重试", async () => {
  let attempts = 0;
  const c = link(async () => { attempts++; throw new TypeError("network"); }, () => false);
  c.start(); await pause(90); c.stop(); const stoppedAt = attempts;
  assert.ok(stoppedAt > 1); await pause(20); assert.equal(attempts, stoppedAt);
});
test("离开后迟到的取证明错误不能修改新页面", async () => {
  let reject, classified = 0;
  const c = link(() => new Promise((_r, no) => { reject = no; }), () => { classified++; return true; });
  c.start(); c.stop(); reject({ status: 410 }); await pause(10);
  assert.equal(classified, 0);
});
