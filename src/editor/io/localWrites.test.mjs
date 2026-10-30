/**
 * 保存前等本机写完(`docs/semantics/mechanism/document-service.md`「保存基准与修改状态检查」:「保存暂时禁用前台编辑，
 * 等待本机写完」)。跑:node --experimental-test-module-mocks --test src/editor/io/localWrites.test.mjs
 *
 * 钉死:本机 Agent 的工具、这台设备正在导入的素材、后台任务的连续写入、待文档服务确认的修改,保存都等它们写完再序列化;
 * 到时限还没完就不写文件、说清楚在等什么,并恢复编辑;序列化之后项目又被本机改了,不把它标成「已保存」。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = new EventTarget();

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { saveProcFile } = await import(srcUrl("editor/io/saveFlow.ts"));
const { beginAgentTool, endAgentTool } = await import(srcUrl("editor/userEditing.ts"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一次保存的假依赖:写盘就是把内容记下来 */
function deps(over = {}) {
  const written = [];
  const notes = [];
  const marked = [];
  const d = {
    writeProc: async (produce, fileName) => {
      const text = await produce();
      written.push(JSON.parse(text));
      return { kind: "saved", where: fileName };
    },
    settle: async () => {},
    serialize: () => JSON.stringify({ name: getState().project.name, tracks: getState().project.tracks.length }),
    saveDraft: async () => {},
    markSaved: (f) => marked.push(f),
    notify: (m, tone = "error") => notes.push({ m, tone }),
    currentProject: () => getState().project,
    waitTimeoutMs: 1500,
    ...over,
  };
  return { d, written, notes, marked };
}

function fresh(name = "起点") {
  actions.newProject(name);
}

/** 本机 Agent 的探测(与 localWrites.ts 的缺省一致,这里写成数据,改前的代码不认它也照样跑得起来) */
let agentBusy = false;
const agentProbe = { label: () => "Agent 正在执行的修改", count: () => (agentBusy ? 1 : 0) };

test("本机 Agent 的工具还在跑:保存等它写完再序列化,文件里有它最后那一笔", async () => {
  fresh();
  agentBusy = true;
  setTimeout(() => {
    actions.setProjectMeta({ name: "Agent 改的" });
    agentBusy = false;
  }, 200);
  const { d, written } = deps({ probes: [agentProbe] });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.equal(written[0].name, "Agent 改的");
});

test("这台设备正在导入的素材:等它传完;别的设备在传的(本机没有文件)不等", async () => {
  fresh();
  const m = actions.addMedia({ kind: "image", name: "本机导入.png", url: "", pending: true });
  const other = actions.addMedia({ kind: "image", name: "别人在传.png", url: "", pending: true });
  const local = new Set([m.id]);
  const mediaProbe = {
    label: (n) => `正在导入的素材（${n} 个）`,
    count: () => getState().project.media.filter((x) => x.pending && local.has(x.id)).length,
  };
  setTimeout(() => actions.updateMedia(m.id, { pending: undefined, url: "/@media/abc" }), 200);
  const { d, written } = deps({ probes: [mediaProbe], serialize: () => JSON.stringify({ pending: getState().project.media.filter((x) => x.pending).map((x) => x.id) }) });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.deepEqual(written[0].pending, [other.id], "本机那张传完了才存;别人那张还 pending 也照存");
});

test("后台任务连着写:等它停下来(一段时间没有新的落地)再序列化", async () => {
  fresh();
  // 后台任务已经在写(第一笔在点保存之前落地),之后每 60 毫秒一笔
  let n = 1;
  actions.setProjectMeta({ name: "后台第 1 笔" });
  const timer = setInterval(() => {
    n += 1;
    actions.setProjectMeta({ name: `后台第 ${n} 笔` });
    if (n === 6) clearInterval(timer);
  }, 60);
  await sleep(10);
  const { d, written } = deps({ probes: [] });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.equal(written[0].name, "后台第 6 笔", "存的是写完之后的样子,不是写到一半");
});

test("Agent 一直没写完:到时限不写文件,说清楚在等 Agent;之后恢复编辑", async () => {
  fresh();
  agentBusy = true;
  const { d, written, notes, marked } = deps({ probes: [agentProbe], waitTimeoutMs: 400 });
  try {
    assert.equal(await saveProcFile("a.proc", d), "failed");
  } finally {
    agentBusy = false;
  }
  assert.equal(written.length, 0, "没写文件");
  assert.equal(marked.length, 0, "没标已保存");
  assert.match(notes[0].m, /Agent/);
  assert.match(notes[0].m, /原来的文件没有改动/);
  const { isSaveLocked } = await import(srcUrl("editor/saveLock.ts"));
  assert.equal(isSaveLocked(), false, "锁解开了");
});

test("素材一直没导完:到时限不写文件,提示里有件数", async () => {
  fresh();
  const m = actions.addMedia({ kind: "video", name: "大文件.mp4", url: "", pending: true });
  const probe = { label: (n) => `正在导入的素材（${n} 个）`, count: () => (getState().project.media.find((x) => x.id === m.id)?.pending ? 1 : 0) };
  const { d, written, notes } = deps({ probes: [probe], waitTimeoutMs: 300 });
  assert.equal(await saveProcFile("a.proc", d), "failed");
  assert.equal(written.length, 0);
  assert.match(notes[0].m, /正在导入的素材（1 个）/);
});

test("待文档服务确认的修改等不到:不写文件,沿用原来的说法", async () => {
  fresh();
  const { d, written, notes } = deps({ probes: [], settle: async () => { throw new Error("timeout"); } });
  assert.equal(await saveProcFile("a.proc", d), "failed");
  assert.equal(written.length, 0);
  assert.match(notes[0].m, /文档服务确认/);
});

test("序列化之后项目又被本机改了(写盘期间 Agent 落了一笔):文件照存,但不标「已保存」,并告诉用户", async () => {
  fresh();
  const { d, written, marked, notes } = deps({
    probes: [],
    writeProc: async (produce, fileName) => {
      const text = await produce();
      // 写盘这段时间里 Agent 的工具落了一笔
      beginAgentTool();
      actions.setProjectMeta({ name: "写盘期间改的" });
      endAgentTool();
      written.push(JSON.parse(text));
      return { kind: "saved", where: fileName };
    },
  });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.equal(written[0].name, "起点");
  assert.equal(marked.length, 0, "项目已经不是文件里那一份,不能标成已保存");
  assert.equal(getState().dirty, true);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tone, "info");
  assert.match(notes[0].m, /还没保存/);
});

test("缺省的探测:Agent 工具在跑时 agentToolProbe 记 1;本机正在导入的素材才算", async () => {
  const lw = await import(srcUrl("editor/io/localWrites.ts"));
  beginAgentTool();
  assert.equal(lw.agentToolProbe.count(), 1);
  endAgentTool();
  assert.equal(lw.agentToolProbe.count(), 0);
  const probe = lw.mediaImportProbe(() => [{ id: "a", pending: true }, { id: "b", pending: true }, { id: "c" }], (id) => id !== "b");
  assert.equal(probe.count(), 1);
  assert.equal(probe.label(1), "正在导入的素材（1 个）");
});

test("序列化之后协作者的修改到了(不是本机落的):不标「已保存」,但也不另外提示", async () => {
  fresh();
  const core = await import(srcUrl("store/core.ts"));
  const { d, written, marked, notes } = deps({
    probes: [],
    writeProc: async (produce, fileName) => {
      const text = await produce();
      // 别的设备的修改经文档服务到了:docsync 直接换 state.project 并标脏(src/store/docsync.ts 的 bindStore)
      core.set({ project: { ...getState().project, name: "协作者改的" }, dirty: true });
      written.push(JSON.parse(text));
      return { kind: "saved", where: fileName };
    },
  });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.equal(written[0].name, "起点");
  assert.equal(marked.length, 0, "文件里没有协作者那一笔,不能标已保存");
  assert.deepEqual(notes, [], "协作者的修改本来就随时把项目标脏,不另说");
});
