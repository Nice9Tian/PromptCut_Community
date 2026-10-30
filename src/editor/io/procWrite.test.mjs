/**
 * `.proc` 写盘那一步(`proc.ts` 的 `writeProcToDisk`):收预渲染快照、写临时副本、出错不碰原文件。
 * 跑:node --experimental-test-module-mocks --test src/editor/io/procWrite.test.mjs
 *
 * 钉死:
 *   - 渲染(预渲染快照)等到时限还没收到:项目照存(快照是可丢的缓存),但结果里标出这次没带快照、保存流程告诉用户 —— 不静默放过;
 *
 * 文件句柄是假的:`createWritable` 回的流照浏览器的规矩办(写进临时副本,`close` 才替换原文件,`abort` 丢掉临时副本)。
 * 真浏览器里这条规矩成不成立由探针 `scripts/probes/save-state-probe.mjs --phases fail` 验。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

/** 预渲染快照这次怎么回:ok 立刻回;hang 一直不回(等到时限) */
let archiveMode = "ok";
mock.module(srcUrl("render/frameClient.ts"), {
  namedExports: {
    snapshotsFor: () => undefined,
    restoreSnapshots: () => {},
    frameRequest: (op, project, extra, signal) => {
      if (archiveMode === "ok") return Promise.resolve({ snapshots: "SNAP" });
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("帧读取失败")), { once: true }));
    },
  },
});

/** 照浏览器规矩办的假文件:内容在 `bytes`,流写进临时副本 */
function fakeFile(name, initial = "") {
  const file = { name, kind: "file", bytes: initial, swaps: 0, log: [] };
  file.createWritable = async () => {
    let swap = "";
    let open = true;
    file.swaps += 1;
    return {
      write: async (data) => {
        if (!open) throw new Error("流已关闭");
        swap += typeof data === "string" ? data : await data.text();
        if (file.failAfterHalf) { file.log.push("write-failed"); throw new Error(file.failAfterHalf); }
      },
      close: async () => { if (!open) throw new Error("流已关闭"); open = false; file.bytes = swap; file.swaps -= 1; file.log.push("close"); },
      abort: async () => { open = false; file.swaps -= 1; file.log.push("abort"); },
    };
  };
  return file;
}

let target = null;
globalThis.window = Object.assign(new EventTarget(), {
  showSaveFilePicker: async () => target,
});

const proc = await import(srcUrl("editor/io/proc.ts"));
const { saveProcFile } = await import(srcUrl("editor/io/saveFlow.ts"));
const { actions, getState } = await import(srcUrl("store/project.ts"));

function saveDeps(notes) {
  return {
    writeProc: (produce, fileName) => proc.writeProcToDisk(produce, fileName),
    settle: async () => {},
    serialize: () => proc.serializeProc(),
    saveDraft: async () => {},
    markSaved: (f) => actions.markSaved(f),
    notify: (m, tone = "error") => notes.push({ m, tone }),
    currentProject: () => getState().project,
    waitTimeoutMs: 2000,
  };
}

test("预渲染快照收到了:随文件存进去,不另行提示", async () => {
  archiveMode = "ok";
  proc.forgetSaveTarget();
  target = fakeFile("快照.proc");
  actions.newProject("快照");
  const notes = [];
  assert.equal(await saveProcFile("快照.proc", saveDeps(notes)), "saved");
  assert.equal(JSON.parse(target.bytes).snapshots, "SNAP");
  assert.deepEqual(notes, []);
});

test("预渲染快照等到时限没收到:项目照存(不带快照),结果里标出来,并告诉用户", async () => {
  archiveMode = "hang";
  proc.forgetSaveTarget();
  target = fakeFile("快照超时.proc");
  actions.newProject("快照超时");
  const outcome = await proc.writeProcToDisk(async () => proc.serializeProc(), "快照超时.proc");
  assert.equal(outcome.kind, "saved");
  assert.equal(outcome.snapshotsSkipped, true, "结果里标出这次没带快照");
  const doc = JSON.parse(target.bytes);
  assert.equal(doc.project.name, "快照超时", "项目内容照存");
  assert.equal(doc.snapshots, undefined);

  proc.forgetSaveTarget();
  target = fakeFile("快照超时2.proc");
  const notes = [];
  assert.equal(await saveProcFile("快照超时2.proc", saveDeps(notes)), "saved");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tone, "info");
  assert.match(notes[0].m, /预渲染快照/);
  assert.equal(getState().dirty, false, "项目内容完整,算保存了");
  archiveMode = "ok";
});

/* ── 写到一半失败:旧保存不能被覆盖 ── */

test("写到一半出错:原文件逐字节不变,临时副本丢掉(abort),没有 close", async () => {
  archiveMode = "ok";
  proc.forgetSaveTarget();
  target = fakeFile("半截.proc", "上一次有效保存的内容");
  target.failAfterHalf = "磁盘满了";
  actions.newProject("半截");
  await assert.rejects(() => proc.writeProcToDisk(async () => proc.serializeProc(), "半截.proc"), (e) => {
    assert.match(e.message, /磁盘满了/);
    assert.match(e.message, /原来的文件没有改动/);
    return true;
  });
  assert.equal(target.bytes, "上一次有效保存的内容", "原文件逐字节不变");
  assert.deepEqual(target.log, ["write-failed", "abort"], "临时副本 abort 掉了,没有 close(close 才会替换原文件)");
  assert.equal(target.swaps, 0, "没有留下没收尾的临时副本");
});

test("关闭(替换原文件)那一步出错:也 abort,原文件不变", async () => {
  proc.forgetSaveTarget();
  const file = fakeFile("关不上.proc", "旧内容");
  const create = file.createWritable;
  file.createWritable = async () => {
    const w = await create();
    return { ...w, close: async () => { file.log.push("close-failed"); throw new Error("替换文件时出错"); } };
  };
  target = file;
  actions.newProject("关不上");
  await assert.rejects(() => proc.writeProcToDisk(async () => proc.serializeProc(), "关不上.proc"), /原来的文件没有改动/);
  assert.equal(file.bytes, "旧内容");
  assert.deepEqual(file.log, ["close-failed", "abort"]);
});

test("保存流程里写到一半出错:提示说清原文件没动、不标已保存、不更新草稿、恢复编辑", async () => {
  proc.forgetSaveTarget();
  target = fakeFile("流程.proc", "旧的");
  target.failAfterHalf = "设备没有空间";
  actions.newProject("流程");
  actions.setProjectMeta({ name: "流程改过" });
  const notes = [];
  let drafts = 0;
  const d = { ...saveDeps(notes), saveDraft: async () => { drafts += 1; } };
  assert.equal(await saveProcFile("流程.proc", d), "failed");
  assert.equal(target.bytes, "旧的");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tone, "error");
  assert.match(notes[0].m, /设备没有空间/);
  assert.match(notes[0].m, /原来的文件没有改动/);
  assert.equal(getState().dirty, true, "不标已保存");
  assert.equal(drafts, 0, "草稿不动");
  const { isSaveLocked } = await import(srcUrl("editor/saveLock.ts"));
  assert.equal(isSaveLocked(), false, "恢复编辑");
});

test("出错之后再存一次(这回写得进去):照常存成,原文件换成新内容", async () => {
  target.failAfterHalf = null;
  const notes = [];
  assert.equal(await saveProcFile("流程.proc", saveDeps(notes)), "saved");
  assert.equal(JSON.parse(target.bytes).project.name, "流程改过");
  assert.equal(getState().dirty, false);
});

test("打包保存写到一半出错:包文件不变、abort、提示原文件没动", async () => {
  const { savePackedFile } = await import(srcUrl("editor/io/saveFlow.ts"));
  const pkg = fakeFile("包.procp", "旧包");
  pkg.failAfterHalf = "写包出错";
  const notes = [];
  const result = await savePackedFile("包.procp", {
    pick: async () => pkg,
    settle: async () => {},
    pack: async () => ({ blob: new Blob(["新包的字节"]), missing: [] }),
    download: () => {},
    missingMessage: () => "",
    notify: (m, tone = "error") => notes.push({ m, tone }),
    waitTimeoutMs: 2000,
  });
  assert.equal(result, "failed");
  assert.equal(pkg.bytes, "旧包");
  assert.deepEqual(pkg.log, ["write-failed", "abort"]);
  assert.match(notes[0].m, /原来的文件没有改动/);
});
