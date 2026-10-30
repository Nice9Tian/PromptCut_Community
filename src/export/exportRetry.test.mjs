/**
 * 在线导出请渲染节点的那一段「等得到头」(审查后补的;`src/export/exportFrames.ts` 文件头「怎么等」)。
 * 跑:node --test src/export/exportRetry.test.mjs
 *
 *   XR-01 计划已经失败:回包的 `failed` 当失败报出来,不当「没有渲染节点在线」
 *   XR-02 计划做完了却不带索引:等过一轮就报失败,不一直「正在准备」
 *   XR-03 等清单时任务已经失败(页面没收到过通知):核对任务时回包是 `failed`,报失败
 *   XR-04 等清单时任务不在了(页面断线太久被删):原样再发布,队列重建,节点接着做,导出照常到齐
 *   XR-05 节点切完计划就退出:没有进展满时限就报失败并说明;有节点认领着就不算没进展
 *   XR-06 失败之后再点导出:计划带新的标识(新的计划 id、`input.exportSalt`);没失败过不带;队列的入站校验收它
 *   XR-07 不带输入签名的不用:索引里没有签名的片段报失败;层表里没有签名的流在导出时不取
 *   XR-08 解出来的宽度和清单里的矩形对不上:报错,不裁
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInbound } from "../../server/render-queue/messages.mjs";

const F = await import(srcUrl("export/exportFrames.ts"));
const S = await import(srcUrl("export/streamFrames.ts"));
const T = await import(srcUrl("export/text.ts"));

const RK = "a".repeat(64);
const hashOf = (n) => n.toString(16).padStart(64, "0");
const derived = (from, to) => ({ id: `stream:${RK}:${from}-${to}`, kind: "stream", resultKey: RK, range: { unit: "segment", from, to },
  source: { projectId: "p1", projectRev: 7, derivedFrom: "plan:x" }, input: { clipId: "s", exportFrames: true, exportKey: "k" }, weight: { class: "medium" }, requires: {}, priority: 60 });
const indexOf = (over = {}) => ({ v: 1, projectRev: 7, unsupported: [], streams: [{ clipId: "s", kind: "card", plane: "local", resultKey: RK, envFingerprint: "f".repeat(16),
  originFrame: 12, lastFrame: 20, lastSegment: 0, segmentsPerTask: 8, fps: 30, rect: { x: 0, y: 0, w: 64, h: 32 }, offset: { x: 0, y: 0 }, inputSig: "s1-abc", tasks: [derived(0, 0)], ...over }] });
const manifest = () => ({ v: 1, kind: "export-frames", resultKey: RK, range: { from: 0, to: 0 }, header: {}, frames: Array.from({ length: 9 }, (_, i) => [12 + i, hashOf(12 + i), 10]) });

/** 假的文档服务:`states` 是任务 id → 回包里的状态(函数或字符串);`clock` 每睡一次往前走 `tick` 毫秒 */
function service({ tick = 1000 } = {}) {
  const listeners = new Set();
  const manifests = new Map();
  const published = [];
  const states = new Map();
  let t = 0;
  const hooks = { onSleep: null };
  const deps = {
    publisherId: "page-test", codeVersion: null, now: () => t,
    async request(msg) {
      if (msg.type === "publisher.hello") return { type: "publisher.welcome" };
      if (msg.type === "task.publish") {
        published.push(msg.tasks.map((x) => x.id));
        return { type: "task.published", results: msg.tasks.map((x) => { const s = states.get(x.id); return { id: x.id, state: typeof s === "function" ? s() : s ?? "open" }; }) };
      }
      if (msg.type === "content.get") { const body = manifests.get(msg.key); return body ? { type: "content.item", body } : { type: "content.item", missing: true }; }
      return { type: "error" };
    },
    subscribeQueue(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    assetBase: () => "https://asset.test", authHeaders: async () => ({}),
    sleep: async (ms, signal) => { if (signal.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true }); t += tick ?? ms; await new Promise((r) => setImmediate(r)); await hooks.onSleep?.(); },
  };
  return { deps, manifests, published, states, hooks, emit: (m) => { for (const l of [...listeners]) l(m); } };
}
const request = (svc, over = {}) => F.requestExportFrames({ projectId: "p1", projectRev: 7, project: {}, clips: ["s"], deps: svc.deps, signal: new AbortController().signal, ...over });
const planOf = () => F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"], salt: F.exportRetrySalt() });
/** 计划做完、索引随 `task.done` 到 */
const finishPlan = (svc, index = indexOf()) => { const plan = planOf(); svc.states.set(plan.id, "done"); svc.emit({ type: "task.done", id: plan.id, result: { exportIndex: index } }); };

test("XR-01 计划已经失败:报失败,不当「没有渲染节点在线」", async () => {
  F.resetExportRetry();
  const svc = service();
  svc.states.set(planOf().id, "failed");
  const statuses = [];
  await assert.rejects(request(svc, { onStatus: (s) => statuses.push(s.phase) }), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("plan-failed"));
  assert.deepEqual(statuses, ["publishing"], "没有显示过「没有渲染节点在线」");
  assert.ok(F.exportRetrySalt(), "下一次带新的标识");
});

test("XR-02 计划做完了却不带索引:等过一轮就报失败", async () => {
  F.resetExportRetry();
  const svc = service();
  svc.states.set(planOf().id, "done");
  await assert.rejects(request(svc), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("no-index"));
  assert.equal(svc.published.length, 2);
});

test("XR-03 等清单时任务已经失败、页面没收到过通知:核对任务时报失败", async () => {
  F.resetExportRetry();
  const svc = service();
  svc.states.set(`stream:${RK}:0-0`, "failed");
  svc.hooks.onSleep = async () => { if (svc.published.length === 1) finishPlan(svc); };
  await assert.rejects(request(svc), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("task-failed"));
  assert.deepEqual(svc.published.at(-1), [`stream:${RK}:0-0`], "把还没到的任务原样再发布了一次");
});

test("XR-04 等清单时任务不在了:原样再发布(队列重建),之后照常到齐", async () => {
  F.resetExportRetry();
  const svc = service();
  let rounds = 0;
  svc.hooks.onSleep = async () => {
    rounds++;
    if (rounds === 1) finishPlan(svc);
    // 任务被重新发布之后节点才接着做完
    if (svc.published.some((ids) => ids[0] === `stream:${RK}:0-0`) && rounds >= 3) svc.manifests.set(`${RK}:0-0`, manifest());
  };
  const got = await request(svc);
  assert.equal(got.coverage.get("s").frames.size, 9);
  const reposts = svc.published.filter((ids) => ids[0] === `stream:${RK}:0-0`);
  assert.ok(reposts.length >= 1);
  const sent = parseInbound({ type: "task.publish", tasks: [derived(0, 0)] });
  assert.equal(sent.ok, true, "索引里带的任务原样发得出去(队列的入站校验收它)");
  assert.equal(F.exportRetrySalt(), null, "没失败过不带标识");
});

test("XR-05 节点退出了:没有进展满时限报失败;有节点认领着不算", async () => {
  F.resetExportRetry();
  // 任务一直是 open(没人接):每睡一次走 1 秒,时限 5 秒
  const svc = service({ tick: 1000 });
  svc.hooks.onSleep = async () => { if (svc.published.length === 1) finishPlan(svc); };
  const statuses = [];
  await assert.rejects(request({ ...svc, deps: { ...svc.deps, stallMs: 5000, taskCheckMs: 2000 } }, { onStatus: (s) => statuses.push(s.phase) }),
    (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeStalled(5000) && /5 秒没有进展/.test(e.message));
  assert.ok(statuses.filter((p) => p === "rendering").length >= 4, "到时限之前照常显示在渲");
  assert.match(T.ONLINE_EXPORT_TEXT.nodeStalled(F.EXPORT_STALL_MS), /3 分钟没有进展/);
  // 有节点认领着:走过两倍时限也不报,清单到了就到齐
  F.resetExportRetry();
  const busy = service({ tick: 1000 });
  busy.states.set(`stream:${RK}:0-0`, "claimed");
  let rounds = 0;
  busy.hooks.onSleep = async () => { rounds++; if (rounds === 1) finishPlan(busy); if (rounds === 12) busy.manifests.set(`${RK}:0-0`, manifest()); };
  const got = await request({ ...busy, deps: { ...busy.deps, stallMs: 5000, taskCheckMs: 2000 } });
  assert.equal(got.coverage.get("s").frames.size, 9);
});

test("XR-06 失败之后再点导出:计划带新的标识", async () => {
  F.resetExportRetry();
  const plain = F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"] });
  assert.equal(plain.input.exportSalt, undefined);
  const svc = service();
  svc.states.set(plain.id, "failed");
  await assert.rejects(request(svc));
  const salt = F.exportRetrySalt();
  assert.match(salt, /^[0-9a-z]{1,32}$/);
  // 下一次:新的计划 id、带标识;队列收它
  const again = service();
  let seen = null;
  again.hooks.onSleep = async () => { seen = again.published[0][0]; finishPlan(again); again.manifests.set(`${RK}:0-0`, manifest()); };
  await request(again);
  const retry = F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"], salt });
  assert.equal(seen, retry.id);
  assert.notEqual(retry.id, plain.id);
  assert.equal(retry.input.exportSalt, salt);
  assert.equal(parseInbound({ type: "task.publish", tasks: [retry] }).ok, true);
  assert.equal(parseInbound({ type: "task.publish", tasks: [retry] }).body.tasks[0].input.exportSalt, salt);
  assert.equal(F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"], salt: "Bad Salt!" }).id, plain.id, "形状不对的标识当没带");
});

test("XR-07 不带输入签名的不用", async () => {
  F.resetExportRetry();
  const svc = service();
  svc.hooks.onSleep = async () => { if (svc.published.length === 1) finishPlan(svc, indexOf({ inputSig: undefined })); };
  await assert.rejects(request(svc), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("no-input-signature"));
  // 层表里的流:没带签名的行导出时不取
  const init = "0123456789abcdef";
  const row = (extra) => ({ clipIds: ["a"], topClipId: "a", kind: "card", plane: "local", contentKey: "ck", candidates: [{ envFingerprint: "f".repeat(16), resultKey: RK }], originFrame: 12, lastSegment: 0, segmentsPerTask: 8, ...extra });
  const deps = (streams) => ({
    assetBase: () => null, authHeaders: async () => ({}),
    async request(msg) {
      if (msg.key === "layers:proj") return { type: "content.item", body: { v: 3, kind: "layer-map", layers: [], streams } };
      if (msg.key === `${RK}:0-0`) return { type: "content.item", body: { kind: "stream", resultKey: RK, header: { fps: 30 }, inits: { [init]: { hash: hashOf(1), rect: { x: 0, y: 0, w: 64, h: 32 } } }, segments: { 0: { hash: hashOf(2), init, stride: 1, samples: 9 } } } };
      return { type: "content.item", missing: true };
    },
  });
  assert.equal((await S.loadReadableStreams("proj", {}, deps([row({})]))).length, 0, "没带签名:不取");
  const signed = await S.loadReadableStreams("proj", {}, deps([row({ inputSig: "s1-abc" })]));
  assert.equal(signed.length, 1);
  assert.equal(signed[0].dense.get(0), 9);
});

test("XR-08 解出来的宽度和清单里的矩形对不上:报错,不裁", () => {
  assert.equal(S.frameWidthOf(64, { x: 0, y: 0, w: 64, h: 32 }, 12), 64);
  assert.throws(() => S.frameWidthOf(48, { x: 0, y: 0, w: 64, h: 32 }, 12), /对不上/);
  assert.throws(() => S.frameWidthOf(80, { x: 0, y: 0, w: 64, h: 32 }, 12), /对不上/);
});

test("XR-09 只为导出的计划并发与限流: 同一项目同一发布方进行中拒绝并发", async () => {
  F.resetExportRetry();
  const svc = service();
  let release = null;
  const holding = new Promise((r) => { release = r; });
  svc.hooks.onSleep = async () => {
    // 第一次进入 sleep 时模拟正在执行/等待节点
    if (release) await holding;
  };
  const firstP = request(svc);
  // 等它进入执行
  await new Promise((r) => setImmediate(r));
  // 此时并发发起第二个请求：必须被限流拦截
  await assert.rejects(
    request(svc),
    (err) => err.throttled === true && /同一项目正在等待或执行导出计划/.test(err.message)
  );
  // 释放第一个请求让它失败结束
  const rel = release;
  release = null;
  svc.states.set(planOf().id, "failed");
  rel();
  await assert.rejects(firstP);
  // resetExportRetry 后限流状态清空
  F.resetExportRetry();
  const state = F.exportPlanThrottleState("p1", svc.deps.publisherId);
  assert.equal(state, null, "resetExportRetry 清空节流状态");
});

