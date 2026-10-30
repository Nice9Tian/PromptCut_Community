/**
 * 保存时暂停前台编辑(`docs/semantics/mechanism/document-service.md`「保存基准与修改状态检查」:
 * 「保存暂时禁用前台编辑，等待本机写完；失败不覆盖上次有效保存，并恢复编辑」)。
 * 跑:node --experimental-test-module-mocks --test src/editor/saveLock.test.mjs
 *
 * 钉死:从挑好落点开始到保存结束(成功、超时、写失败)之间,键盘快捷键、拖放、鼠标、Agent 面板的输入
 * 都到不了编辑器自己的处理函数,项目改不动;保存一结束(不论成败)就恢复。用户在「另存为」里点取消不上锁。
 *
 * node 里没有 DOM:拿一个 EventTarget 当 window。真页面里的拦截见探针 `scripts/probes/save-state-probe.mjs`。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// 编辑器的输入监听都挂在 window 上;拦截要在模块载入时先挂上,所以 window 得先有
globalThis.window = new EventTarget();

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { saveProcFile, savePackedFile } = await import(srcUrl("editor/io/saveFlow.ts"));
const { undoRedoKey } = await import(srcUrl("editor/undoKeys.ts"));

/** 模拟编辑器各处自己挂的输入处理:快捷键撤销、拖放导入素材、鼠标改片段、Agent 面板回车发送 */
const agentSent = [];
window.addEventListener("keydown", (e) => {
  const op = undoRedoKey(e);
  if (op === "undo") actions.undo();
  if (e.key === "Delete") actions.setProjectMeta({ name: "按 Delete 改的" });
  if (e.key === "Enter" && e.pcTarget === "agent-input") agentSent.push("帮我把标题改成 X");
});
window.addEventListener("drop", () => {
  actions.addMedia({ kind: "image", name: "拖进来的.png", url: "" });
});
window.addEventListener("pointerdown", () => {
  actions.setProjectMeta({ name: "鼠标改的" });
});
window.addEventListener("paste", () => {
  actions.setProjectMeta({ name: "粘贴改的" });
});
// 桌面版标题栏菜单的「撤销」(TopBar 收这个事件)
window.addEventListener("pc-titlebar-command", (e) => {
  if (e.detail === "undo") actions.undo();
});

function fire(type, props = {}) {
  const e = new Event(type, { cancelable: true });
  // Event 的 target 是只读的、由派发填:测试里「焦点在哪」另放在 pcTarget 上
  Object.assign(e, { ctrlKey: false, metaKey: false, shiftKey: false, key: "" }, props);
  window.dispatchEvent(e);
  return e;
}

/** 一个停在「写盘」那一步的保存:返回放行函数 */
function heldDeps(overrides = {}) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const written = [];
  const notes = [];
  const deps = {
    writeProc: async (produce, fileName) => {
      const text = await produce();
      await gate;
      written.push({ fileName, text });
      return { kind: "saved", where: fileName };
    },
    settle: async () => {},
    serialize: () => JSON.stringify({ name: getState().project.name }),
    saveDraft: async () => {},
    markSaved: () => {},
    notify: (m) => notes.push(m),
    ...overrides,
  };
  return { deps, release: () => release(), written, notes };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function startProject() {
  actions.newProject("起点");
  actions.setProjectMeta({ name: "改过一次" });
  agentSent.length = 0;
}

test("保存进行中:快捷键撤销、Delete、拖放、鼠标、粘贴、Agent 面板回车都改不动项目", async () => {
  startProject();
  const mediaBefore = getState().project.media.length;
  const projectBefore = getState().project;
  const h = heldDeps();
  const saving = saveProcFile("a.proc", h.deps);
  await tick();
  try {
    fire("keydown", { key: "z", ctrlKey: true });
    fire("keydown", { key: "Delete" });
    fire("drop");
    fire("pointerdown");
    fire("paste");
    fire("keydown", { key: "Enter", pcTarget: "agent-input" });
    fire("pc-titlebar-command", { detail: "undo" });

    assert.equal(getState().project, projectBefore, "保存期间项目对象一次都没换");
    assert.equal(getState().project.name, "改过一次");
    assert.equal(getState().project.media.length, mediaBefore);
    assert.deepEqual(agentSent, [], "Agent 面板没有发出去");
  } finally {
    h.release();
  }
  assert.equal(await saving, "saved");
  assert.equal(JSON.parse(h.written[0].text).name, "改过一次");
});

test("被拦下的输入事件取消了缺省动作(浏览器不会再去打字、粘贴、放下文件)", async () => {
  startProject();
  const h = heldDeps();
  const saving = saveProcFile("a.proc", h.deps);
  await tick();
  try {
    for (const type of ["keydown", "beforeinput", "drop", "dragover", "paste", "cut", "pointerdown", "mousedown", "click", "wheel", "contextmenu"]) {
      const e = fire(type, { key: "x" });
      assert.equal(e.defaultPrevented, true, `${type} 的缺省动作被取消`);
    }
  } finally {
    h.release();
    await saving;
  }
});

test("保存成功结束后恢复编辑:同样的快捷键又能改了", async () => {
  startProject();
  const h = heldDeps();
  const saving = saveProcFile("a.proc", h.deps);
  await tick();
  h.release();
  assert.equal(await saving, "saved");
  fire("keydown", { key: "z", ctrlKey: true });
  assert.equal(getState().project.name, "起点", "撤销生效");
  fire("drop");
  assert.ok(getState().project.media.some((m) => m.name === "拖进来的.png"));
});

test("等确认超时(不写文件)之后恢复编辑", async () => {
  startProject();
  let timeUp;
  const h = heldDeps({ settle: () => new Promise((_, reject) => { timeUp = () => reject(new Error("timeout")); }) });
  const saving = saveProcFile("a.proc", h.deps);
  // 先等它走到「等文档服务确认」那一步(前面还要等后台写入停下来)
  while (!timeUp) await new Promise((r) => setTimeout(r, 20));
  try {
    fire("keydown", { key: "Delete" });
    assert.equal(getState().project.name, "改过一次", "等的时候也改不动");
  } finally {
    timeUp();
  }
  assert.equal(await saving, "failed");
  assert.equal(h.written.length, 0);
  fire("keydown", { key: "Delete" });
  assert.equal(getState().project.name, "按 Delete 改的", "超时之后能改");
});

test("写盘失败之后恢复编辑", async () => {
  startProject();
  const h = heldDeps({
    writeProc: async (produce) => { await produce(); throw new Error("磁盘满了"); },
  });
  assert.equal(await saveProcFile("a.proc", h.deps), "failed");
  fire("pointerdown");
  assert.equal(getState().project.name, "鼠标改的");
});

test("用户在「另存为」里点取消:整个过程不上锁", async () => {
  startProject();
  let pickerOpen;
  const opened = new Promise((r) => { pickerOpen = r; });
  let answer;
  const h = heldDeps({
    writeProc: async () => { pickerOpen(); await new Promise((r) => { answer = r; }); return { kind: "cancelled" }; },
  });
  const saving = saveProcFile("a.proc", h.deps);
  await opened;
  fire("keydown", { key: "Delete" });
  assert.equal(getState().project.name, "按 Delete 改的", "挑落点期间(还没开始存)照常能改");
  answer();
  assert.equal(await saving, "cancelled");
});

test("打包保存同样上锁,挑好落点之后到写完之间改不动", async () => {
  startProject();
  let release;
  const gate = new Promise((r) => { release = r; });
  const writes = [];
  const target = {
    createWritable: async () => ({
      write: async (b) => { await gate; writes.push(b); },
      close: async () => {},
      abort: async () => {},
    }),
  };
  const saving = savePackedFile("a.procp", {
    pick: async () => target,
    settle: async () => {},
    pack: async () => ({ blob: new Blob(["zip"]), missing: [] }),
    download: () => {},
    missingMessage: () => "",
    notify: () => {},
  });
  await tick(); await tick();
  try {
    fire("keydown", { key: "Delete" });
    assert.equal(getState().project.name, "改过一次");
  } finally {
    release();
  }
  assert.equal(await saving, "saved");
  fire("keydown", { key: "Delete" });
  assert.equal(getState().project.name, "按 Delete 改的");
});

test("保存进行中再点一次保存:不另起一次", async () => {
  startProject();
  const h = heldDeps();
  const first = saveProcFile("a.proc", h.deps);
  await tick();
  const other = heldDeps();
  other.release();
  let second;
  try {
    second = await saveProcFile("a.proc", other.deps);
  } finally {
    h.release();
  }
  assert.equal(second, "busy");
  assert.equal(other.written.length, 0, "第二次什么都没写");
  assert.equal(await first, "saved");
});
