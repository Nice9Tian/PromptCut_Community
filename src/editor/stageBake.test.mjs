/**
 * 任务 F（`claude/queue-maint`）：舞台互换时生成快照跟着后台位置走 —— 专门的互换剧本（M7 契约第 4.3 节、D8；
 * `docs/archive/agent-reports/AGENT-rq-m7-node.md`「没做成的」第 4 条）。不起浏览器：
 *
 *   - 真的：节点编排 `src/online/browserNode.ts`、单飞队列 `stageJobs.ts`、舞台登记处 `stageBridge.ts`（含按角色滤事件、
 *     `swapStageClients` 的互换、按客户端记的推送基线）、生成快照的活 `stageBake.ts`（宿主一帧的前半段）；
 *   - 假的：舞台（按「灌进来的项目 + 本地帧」确定地出 HTML，不是后台就回 `role`，一帧在飞时角色变了回 `cancelled`，同 `StageView.tsx`）、
 *     队列（一个任务的认领、放回、完成）。
 *
 *   QM-F-01 基线：不互换，一台后台舞台做完 10 帧
 *   QM-F-02 契约的互换流程：第 4 帧在飞时补跑排进来 → 当前帧做完、放回（yield-urgent，已做 5 帧留在本页）→ 补跑在旧后台上跑 →
 *           互换 → 重新认领后在新后台上先整份重灌隔离单卡工程、从第 5 帧接着做 → 10 帧与基线逐字节相同
 *   QM-F-03 两帧之间后台位置换了人（没有补跑先行：iframe 重载、补跑刚完就开了活的那一小段窗口）：下一帧前核到换人 →
 *           改用新后台、先重灌再做；旧舞台上先发的下一帧作废；不放回、不失败；与基线逐字节相同
 *   QM-F-04 一帧中途后台位置换了人（剧本查出的缺陷，已修）：旧舞台回 cancelled，或者做完了但事件在互换后才到、被按角色滤掉 ——
 *           在新后台上重灌、重做这一帧，不计失败；与基线逐字节相同。后台位置没换人时 cancelled 照旧按可重试失败交回
 *   QM-F-05 补跑刚完、互换之前从单飞队列开出的 bake 活（活记的是旧后台）：第一帧前核到换人，帧只出自新后台、只往新后台灌
 *           隔离单卡工程；旧后台（新前台）最后留在 front 角色
 *
 * 跑：node --test src/editor/stageBake.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const bridge = await import("./stageBridge.ts");
const jobs = await import("./stageJobs.ts");
const { createStageBaker } = await import("./stageBake.ts");
const { createBrowserNode } = await import("../online/browserNode.ts");

const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const FP = "aaaaaaaaaaaaaaaa";
const FRAMES = 10;

/* ------------------------------------------------------------------ 项目与任务 */

const PROJECT = {
  id: "p", fps: 30, duration: 10, width: 1280, height: 720,
  tracks: [
    { id: "t1", clips: [{ id: "c", cardId: "punch-pill", start: 2, end: 2 + FRAMES / 30, props: { text: "hi" } }] },
    { id: "t2", clips: [{ id: "d", cardId: "bg", start: 0, end: 10 }] },
  ],
};
const TASK = {
  id: "snapshot:rk:0-9", kind: "snapshot", tier: "shared", resultKey: "rk", range: { unit: "localFrame", from: 0, to: FRAMES - 1 },
  source: { projectId: "p1", projectRev: 7, userId: "u@d" },
  input: { clipId: "c", compositing: "independent", canvasHeavy: false,
    bake: { start: 2, end: 2 + FRAMES / 30, count: FRAMES, sampling: { firstFrame: 60, phase: { numerator: 0, denominator: 1 } } } },
  weight: { class: "light" }, requires: { envFingerprint: FP, codeVersion: "cv", cardSources: {}, transcode: false, userCards: false, graphCards: false },
};

/* ------------------------------------------------------------------ 假舞台 */

/**
 * 一台舞台（一个 iframe 的 RPC 客户端）。`bakeFrame` 的产出只由「此刻灌进来的项目」与本地帧决定：
 * 灌的是隔离单卡工程时目标片段从 0 起、项目时长是这张卡的；灌的是整个项目（补跑）时片段从 2 s 起 —— 没重灌就出不一样的字节。
 */
function fakeStage(name, role) {
  const handlers = new Set();
  const s = {
    name, role, disposed: false, project: null, gen: 0,
    calls: [],          // [['setRole', role, job] | ['setProject', reset, visibleClip] | ['bakeFrame', frame] | ['bakeCancel']]
    hold: null,         // (frame) => boolean：这一帧先停住，等 release(frame)
    lateEvent: null,    // (frame) => boolean：这一帧的事件等 flushLate() 才发
    waiting: new Map(), late: [],
    onEvent(h) { handlers.add(h); return () => handlers.delete(h); },
    emit(e) { for (const h of [...handlers]) h(e); },
    async setRole(r, opts) { s.role = r; s.calls.push(["setRole", r, opts?.job ?? null]); return { ok: true }; },
    async setProject(project, opts) {
      s.project = project; s.gen++;
      const vis = project.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).map((c) => c.id).join(",");
      s.calls.push(["setProject", !!opts?.reset, vis]);
      return { ok: true };
    },
    async bakeCancel() { s.gen++; s.calls.push(["bakeCancel"]); return { ok: true }; },
    async bakeFrame(req) {
      s.calls.push(["bakeFrame", req.localFrame]);
      if (s.role !== "back") return { ok: false, reason: "role" };
      const p = s.project;
      if (!p) return { ok: false, reason: "no-project" };
      const gen = ++s.gen;
      if (s.hold?.(req.localFrame)) await new Promise((r) => s.waiting.set(req.localFrame, r));
      else await new Promise((r) => setImmediate(r));
      // 同 StageView：一帧在飞时角色变了、被作废（新的一帧、bakeCancel）、项目换了，都回 cancelled，不发事件
      if (s.role !== "back" || gen !== s.gen || s.project !== p) return { ok: false, reason: "cancelled" };
      const clip = p.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).find((c) => c.id === req.clipId);
      if (!clip) return { ok: false, reason: "no-clip" };
      const local = req.localFrame / p.fps - clip.start;
      const html = `<div data-pc-clip="${clip.id}" data-t="${local.toFixed(5)}" data-dur="${p.duration}">${JSON.stringify(clip.props ?? {})}</div>`;
      const bytes = new TextEncoder().encode(html);
      const hash = sha256(bytes);
      const event = { type: "bake-frame", session: req.session, clipId: req.clipId, localFrame: req.localFrame, hash, bytes: bytes.length, htmlRaw: bytes.buffer, small: null };
      // 事件与回包走同一条 postMessage 通道、事件在前：事件晚到时回包也跟在它后面（flushLate 先发事件、再放回包）
      if (s.lateEvent?.(req.localFrame)) await new Promise((r) => s.late.push({ event, r })); else s.emit(event);
      return { ok: true, localFrame: req.localFrame, hash, bytes: bytes.length, small: null, ms: 1, pausedMs: 0, remounted: false, smallMs: 0, readyMs: 0 };
    },
    release(frame) { const r = s.waiting.get(frame); s.waiting.delete(frame); r?.(); },
    flushLate() { for (const { event, r } of s.late.splice(0)) { s.emit(event); r(); } },
    bakedFrames() { return s.calls.filter((c) => c[0] === "bakeFrame").map((c) => c[1]); },
  };
  return s;
}

/** K5 的互换（`stageSwap.ts` 的 `swapAndDress` 的前几步）：登记处对调，再改两台的角色 */
async function swap(newFront, newBack) {
  bridge.swapStageClients({ client: newFront }, { client: newBack });
  await newBack.setRole("back");
  await newFront.setRole("front");
}

/* ------------------------------------------------------------------ 假队列 + 节点 */

function rig({ stages, afterFrame = null }) {
  const log = [];
  let token = 0, version = 1, state = "open", result = null;
  const htmlOf = new Map();
  const bakedOn = new Map();
  let node = null;
  const view = () => ({ ...TASK, state, version });
  const reply = (m) => queueMicrotask(() => node.receive(m));
  const handle = (m) => {
    switch (m.type) {
      case "node.hello": reply({ type: "node.welcome", nodeId: "n", envFingerprint: FP, resumed: [], lost: [] }); break;
      case "queue.watch": reply({ type: "queue.snapshot", tasks: state === "open" ? [view()] : [] }); break;
      case "task.claim":
        if (state !== "open" || m.expectVersion !== version) { reply({ type: "task.claim-rejected", id: m.id, reason: "stale", state, version }); break; }
        state = "claimed"; version++; token++;
        reply({ type: "task.claimed", id: TASK.id, token, version, leaseUntil: Infinity, task: view() });
        break;
      case "task.progress": reply({ type: "task.renewed", id: m.id, token: m.token, leaseUntil: Infinity }); break;
      case "task.release":
        state = "open"; version++;
        reply({ type: "task.released", id: m.id });
        reply({ type: "task.opened", task: view() });
        break;
      case "task.complete": state = "done"; result = m.result; reply({ type: "task.completed", id: m.id }); break;
      case "task.fail": state = "open"; version++; reply({ type: "task.fail-ack", id: m.id, state: "open" }); reply({ type: "task.opened", task: view() }); break;
      default: break;
    }
  };
  const idle = () => jobs.urgentBackJobs() === 0;
  const baker = createStageBaker({
    runBackJob: (kind, run) => jobs.runBackJob(kind, run), backStage: bridge.backStage, pushProject: bridge.pushProject, onStageEvent: bridge.onStageEvent,
    onUrgent: () => node.yieldFor("urgent"), isIdle: idle, mode: "seq", small: false,
  });
  node = createBrowserNode({
    nodeId: "n", projectId: "p1", userId: "u@d", codeVersion: "cv", environment: { platform: "", userAgent: "", renderer: "", vendor: "" },
    now: () => 1_000_000, isIdle: idle,
    send: (m) => { log.push(JSON.parse(JSON.stringify(m))); queueMicrotask(() => handle(m)); return true; },
    keptProject: () => PROJECT, fetchSnapshot: async () => null,
    bakeFrame: async (job) => {
      const { event, stage } = await baker.bakeFrame(job);
      htmlOf.set(job.localFrame, new TextDecoder().decode(new Uint8Array(event.htmlRaw)));
      bakedOn.set(job.localFrame, stage.name);
      // 宿主一帧的后半段（解压、推素材服务、进页面内快照库）：剧本可以在这里停住，造出「两帧之间」
      if (afterFrame) await afterFrame(job.localFrame);
      return { hash: event.hash, bytes: event.bytes, small: null };
    },
    finishTask: async ({ frames }) => ({ frames: frames.map((f) => [f.localFrame, f.hash, f.bytes]) }),
    onTaskEnd: () => baker.close(),
  });
  node.start();
  return {
    node, baker, log, stages, htmlOf, bakedOn,
    get result() { return result; },
    of: (type) => log.filter((m) => m.type === type),
    /** 节点的节拍（宿主每 250 ms 一次）走到 until 成立 */
    async run(until, max = 300) {
      for (let i = 0; i < max; i++) { node.tick(); await flush(); if (until()) return; }
      throw new Error(`剧本没走到：${JSON.stringify(log.map((m) => m.type))}`);
    },
  };
}

beforeEach(() => {
  jobs.resetStageJobs();
  bridge.resetStageBridge();
});

/** 不互换跑一遍，拿每帧的 HTML 当基线 */
async function baseline() {
  jobs.resetStageJobs();
  bridge.resetStageBridge();
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  const r = rig({ stages: { A, B } });
  await r.run(() => r.result !== null);
  const html = [...r.htmlOf.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
  jobs.resetStageJobs();
  bridge.resetStageBridge();
  return { r, html, frames: r.result.frames };
}

test("QM-F-01 基线：不互换，一台后台舞台做完 10 帧（灌一次隔离单卡工程，每帧只出自后台）", async () => {
  const { r, html, frames } = await baseline();
  assert.equal(frames.length, FRAMES);
  assert.deepEqual(frames.map((f) => f[0]), [...Array(FRAMES).keys()]);
  assert.equal(r.stages.B.calls.filter((c) => c[0] === "setProject").length, 1);
  assert.deepEqual(r.stages.B.calls.find((c) => c[0] === "setProject"), ["setProject", true, "c"], "整份重灌、只有目标片段可见");
  assert.equal(r.stages.A.bakedFrames().length, 0, "可见舞台一帧不做");
  assert.ok(html[0].includes('data-t="0.00000"'), "隔离单卡工程里本地帧 0 就是片段起点");
  assert.equal(r.of("task.release").length + r.of("task.fail").length, 0);
});

test("QM-F-02 契约的互换流程：第 4 帧在飞时补跑排进来 → 当前帧做完、放回 → 补跑 → 互换 → 新后台上重灌、从第 5 帧接着做；与基线逐字节相同", async () => {
  const base = await baseline();
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  B.hold = (f) => f === 4;
  const r = rig({ stages: { A, B } });
  await r.run(() => B.waiting.has(4));
  assert.deepEqual(B.bakedFrames(), [0, 1, 2, 3, 4], "0～3 做完，第 4 帧在飞（顺推时先发的那一帧）");

  // 补跑（更急）排进来：单飞队列 abort 生成快照的活，节点要求让路
  const catchupOrder = [];
  const catchup = jobs.runBackJob("catchup", async (ctx) => {
    catchupOrder.push(["catchup-start", ctx.stage.name, r.of("task.release").length]);
    await bridge.pushProject("back", PROJECT, { reset: true });
  });
  await flush();
  assert.equal(r.of("task.release").length, 0, "当前帧还没做完：不放回");
  assert.equal(catchupOrder.length, 0, "生成快照的活没交还之前补跑不开工（单飞）");
  B.release(4);
  await catchup;
  const release = r.of("task.release");
  assert.equal(release.length, 1);
  assert.equal(release[0].reason, "yield-urgent");
  const lastProgressBefore = r.log.slice(0, r.log.indexOf(r.log.find((m) => m.type === "task.release"))).filter((m) => m.type === "task.progress").at(-1);
  assert.equal(lastProgressBefore.done, 5, "当前帧（第 4 帧）做完、报了 5 帧之后才放回");
  assert.deepEqual(catchupOrder, [["catchup-start", "B", 1]], "放回之后补跑才在旧后台 B 上开工");
  assert.deepEqual(B.bakedFrames(), [0, 1, 2, 3, 4], "让路之后旧后台上不再先发下一帧");

  // K5：补跑完 B 转到前台，A 接任后台
  await swap(B, A);
  assert.equal(bridge.backStage(), A);
  await r.run(() => r.result !== null);

  assert.deepEqual(A.bakedFrames(), [5, 6, 7, 8, 9], "新后台从留着的帧之后接着做，不重做 0～4");
  assert.deepEqual(B.bakedFrames(), [0, 1, 2, 3, 4], "互换之后旧后台（现在是前台）一帧不做");
  const aFirstBake = A.calls.findIndex((c) => c[0] === "bakeFrame");
  const aPush = A.calls.findIndex((c) => c[0] === "setProject");
  assert.ok(aPush >= 0 && aPush < aFirstBake, `新后台先整份重灌隔离单卡工程再做帧：${JSON.stringify(A.calls)}`);
  assert.deepEqual(A.calls[aPush], ["setProject", true, "c"]);
  assert.ok(A.calls.some((c) => c[0] === "setRole" && c[1] === "back" && c[2] === "bake"), "单飞队列把 bake 工作项发给了新后台");
  assert.deepEqual(r.result.frames, base.frames, "清单（帧号、哈希、字节数）与不互换时相同");
  const html = [...r.htmlOf.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
  assert.deepEqual(html, base.html, "每帧 HTML 与不互换时逐字节相同");
  assert.deepEqual([...r.bakedOn.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s), ["B", "B", "B", "B", "B", "A", "A", "A", "A", "A"]);
  assert.equal(r.of("task.fail").length, 0);
  assert.equal(r.of("task.claim").length, 2, "重新认领了一次");
});

test("QM-F-03 两帧之间后台位置换了人（没有补跑先行）：下一帧前核到换人 → 改用新后台、先重灌再做；先发的那一帧作废；不放回不失败", async () => {
  const base = await baseline();
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  B.hold = (f) => f === 3;
  // 第 2 帧还在推素材服务（宿主一帧的后半段）时，顺推先发的第 3 帧已经在 B 上：这时互换 —— 节点此刻不在等任何一帧
  let pushDone;
  const pushing = new Promise((res) => { pushDone = res; });
  const r = rig({ stages: { A, B }, afterFrame: (f) => (f === 2 ? pushing : undefined) });
  await r.run(() => B.waiting.has(3) && r.htmlOf.has(2));
  await swap(B, A);
  B.release(3);
  await flush();
  pushDone();
  await r.run(() => r.result !== null);
  assert.equal(r.baker.diag().redos, 0, "两帧之间换人：靠每帧前核位置，不走中途重做");
  assert.deepEqual(B.bakedFrames(), [0, 1, 2, 3], "B 上只有互换前的，先发的第 3 帧（回 cancelled）作废");
  assert.deepEqual(A.bakedFrames(), [3, 4, 5, 6, 7, 8, 9], "第 3 帧起在新后台上做");
  const aPush = A.calls.findIndex((c) => c[0] === "setProject");
  assert.ok(aPush >= 0 && aPush < A.calls.findIndex((c) => c[0] === "bakeFrame"), "先重灌再做帧");
  assert.equal(r.baker.diag().restages, 1, "每帧前核后台位置：核到换人一次");
  assert.equal(r.of("task.release").length + r.of("task.fail").length, 0, "不放回、不失败");
  assert.deepEqual(r.result.frames, base.frames);
  assert.deepEqual([...r.htmlOf.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h), base.html, "逐字节相同");
});

for (const variant of ["cancelled", "late-event"]) {
  test(`QM-F-04 一帧中途后台位置换了人（${variant === "cancelled" ? "旧舞台回 cancelled" : "旧舞台做完了、事件在互换后才到被按角色滤掉"}）：在新后台上重灌重做这一帧，不计失败；逐字节相同`, async () => {
    const base = await baseline();
    const A = fakeStage("A", "front"), B = fakeStage("B", "back");
    bridge.setStageClient("front", A);
    bridge.setStageClient("back", B);
    const r = rig({ stages: { A, B } });
    // 用拍子控住：第 5 帧由节点亲自来要（先把顺推时先发的那一帧挡掉：它回来前就互换）
    if (variant === "cancelled") {
      B.hold = (f) => f === 5;
      await r.run(() => B.waiting.has(5));
      // 等节点真的在等第 5 帧（第 4 帧已记下）
      await r.run(() => r.htmlOf.has(4));
      await swap(B, A);
      B.release(5);
    } else {
      B.hold = (f) => f === 5;
      B.lateEvent = (f) => f === 5;
      await r.run(() => B.waiting.has(5));
      await r.run(() => r.htmlOf.has(4));
      // 旧舞台做完第 5 帧、事件与回包还在路上时互换：事件到父页时 B 已是前台，被登记处按角色滤掉，回包 ok 跟在后面
      B.release(5);
      await r.run(() => B.late.length === 1, 50);
      await swap(B, A);
      B.flushLate();
    }
    await r.run(() => r.result !== null);
    assert.equal(r.of("task.fail").length, 0, "不计失败");
    assert.equal(r.of("task.release").length, 0);
    assert.ok(A.bakedFrames().includes(5), `第 5 帧在新后台上重做：A ${JSON.stringify(A.bakedFrames())}`);
    assert.ok(r.baker.diag().redos >= 1, JSON.stringify(r.baker.diag()));
    assert.equal(r.bakedOn.get(5), "A");
    assert.deepEqual(r.result.frames, base.frames);
    assert.deepEqual([...r.htmlOf.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h), base.html, "逐字节相同");
  });
}

test("QM-F-04b 后台位置没换人时，舞台回 cancelled 照旧按可重试失败交回（行为不变）", async () => {
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  // 第 2 帧先发的那一次与节点亲自来要的那一次都回 cancelled（后台一直是 B）
  let n2 = 0;
  const orig = B.bakeFrame;
  B.bakeFrame = async (req) => {
    if (req.localFrame === 2 && n2++ < 2) { B.calls.push(["bakeFrame", 2]); return { ok: false, reason: "cancelled" }; }
    return orig(req);
  };
  const r = rig({ stages: { A, B } });
  await r.run(() => r.of("task.fail").length > 0 || r.result !== null);
  assert.equal(r.of("task.fail").length, 1, "按失败交回");
  const f = r.of("task.fail")[0];
  assert.equal(f.retryable, true);
  assert.match(String(f.error), /cancelled/);
  assert.equal(r.baker.diag().redos, 0, "没换人不重做");
});

test("QM-F-05 补跑刚完、互换之前开出的 bake 活：帧只出自互换后的后台；新前台最后留在 front 角色", async () => {
  const base = await baseline();
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  // 补跑先占住单飞队列
  let finishCatchup;
  const gate = new Promise((res) => { finishCatchup = res; });
  const catchup = jobs.runBackJob("catchup", async () => { await bridge.pushProject("back", PROJECT, { reset: true }); await gate; });
  await flush();
  // 节点在补跑期间不认领（不闲）；这里直接让它的活排在补跑后面：模拟认领到时还在取项目（prep），补跑才来
  const r = rig({ stages: { A, B } });
  await flush();
  assert.equal(r.of("task.claim").length, 0, "补跑在跑：节点不闲，不认领");
  // 认领一次（绕过闲判据，模拟补跑来之前已认领、还在 prep）
  r.node.receive({ type: "task.claimed", id: TASK.id, token: 1, version: 2, leaseUntil: Infinity, task: { ...TASK, state: "claimed", version: 2 } });
  await flush();
  // 补跑完，紧跟着互换（runSettleSwap：await catchUpBack 之后 swapAndDress）
  finishCatchup();
  await catchup;
  await swap(B, A);
  await r.run(() => r.result !== null || r.of("task.fail").length > 0);
  assert.equal(r.of("task.fail").length, 0, JSON.stringify(r.of("task.fail")));
  assert.deepEqual(B.bakedFrames(), [], `帧不出自旧后台（现在是前台）：${JSON.stringify(B.calls)}`);
  assert.deepEqual(A.bakedFrames(), [...Array(FRAMES).keys()]);
  assert.equal(B.role, "front", `新前台最后的角色：${JSON.stringify(B.calls)}`);
  // 剧本看到的：bake 活是在互换前从单飞队列里开出来的，活记的舞台是旧后台 B；第一帧前核位置时改到 A、在 A 上重灌
  assert.equal(r.baker.diag().restages, 1, "活开在旧后台上，第一帧前核到换人");
  assert.equal(B.calls.filter((c) => c[0] === "setProject").length, 1, "B 只收过补跑那一份整场景项目，没收隔离单卡工程");
  assert.deepEqual(r.result.frames, base.frames);
});
