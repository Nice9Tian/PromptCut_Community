/**
 * 只读界面（`readOnly.ts` 一族）里不依赖 React 的几处：判断本身、快捷键闸、拖放载荷、总时长自动对齐。
 * 组件怎么画见 `readOnlyRender.test.mjs`；真浏览器里的整页表现见 `scripts/probes/guest-readonly-ui-probe.mjs`。
 *
 * 跑：node --test src/editor/readOnly.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const vo = await import("./io/viewOnly.ts");
const core = await import("./readOnlyCore.ts");
const keys = await import("./readOnlyKeys.ts");

/** 假的 location：`?observe=1` 那条路在 Node 里没有页面地址，借它模拟 */
function withLocation(search, fn) {
  const had = Object.hasOwn(globalThis, "location");
  const prev = globalThis.location;
  globalThis.location = { search };
  try { return fn(); } finally { if (had) globalThis.location = prev; else delete globalThis.location; }
}
const reset = () => vo.setProjectAccess(null);

test("RO1 只读权限的项目锁住，读写和没进项目的不锁；离开项目就放开", () => {
  reset();
  assert.equal(core.memberReadOnlyNow(), false, "没进共享项目(本机项目)照旧");
  vo.setProjectAccess("rw");
  assert.equal(core.memberReadOnlyNow(), false, "读写权限不锁");
  vo.setProjectAccess("r");
  assert.equal(core.memberReadOnlyNow(), true);
  assert.equal(core.blockedByReadOnly(), true);
  vo.setProjectAccess(null);
  assert.equal(core.memberReadOnlyNow(), false, "退出项目后不把只读带进下一个项目");
});

test("RO2 ?observe=1 那条老路不并进来：它不算「这个项目只给了只读权限」", () => {
  reset();
  withLocation("?observe=1", () => {
    assert.equal(vo.isViewOnly(), true, "observe 仍是只读(保存 / 删草稿 / 声音生成原来就认它)");
    assert.equal(vo.viewOnlyReason(), "observe");
    assert.equal(core.memberReadOnlyNow(), false, "新加的界面锁不覆盖它：它的表现还是原来那样");
    assert.equal(core.readOnlyState(core.memberReadOnlyNow()).locked, false);
  });
  // 两个来源同时有：权限那条优先(游客打开了带 observe 的地址)
  withLocation("?observe=1", () => {
    vo.setProjectAccess("r");
    assert.equal(vo.viewOnlyReason(), "read-only-member");
    assert.equal(core.memberReadOnlyNow(), true);
  });
  reset();
});

test("RO3 置灰说明永远是 viewOnlyText()；没锁时原来的悬停说明不动", () => {
  reset();
  const off = core.readOnlyState(false);
  assert.equal(off.locked, false);
  assert.equal(off.why, "");
  assert.equal(off.title("原来的说明"), "原来的说明");
  assert.equal(off.title(), undefined);
  vo.setProjectAccess("r");
  const on = core.readOnlyState(core.memberReadOnlyNow());
  assert.equal(on.locked, true);
  assert.equal(on.why, vo.viewOnlyText());
  assert.match(on.why, /只能查看/);
  assert.equal(on.title("原来的说明"), vo.viewOnlyText(), "锁着就是那一句，不是控件自己编的");
  assert.equal(on.title(), vo.viewOnlyText());
  reset();
});

test("RO4 快捷键闸：只读时 Delete / Backspace / 撤销 / 重做到不了编辑器，空格和输入框里的键不拦", () => {
  const press = (init) => ({ key: "", ctrlKey: false, metaKey: false, shiftKey: false, target: { tagName: "DIV" }, ...init });
  // 纯判断：哪些键是「改项目的键」(不看锁)
  assert.equal(keys.isProjectEditKey(press({ key: "Delete" })), true);
  assert.equal(keys.isProjectEditKey(press({ key: "Backspace" })), true);
  assert.equal(keys.isProjectEditKey(press({ key: "z", ctrlKey: true })), true);
  assert.equal(keys.isProjectEditKey(press({ key: "Z", ctrlKey: true, shiftKey: true })), true);
  assert.equal(keys.isProjectEditKey(press({ key: "y", metaKey: true })), true);
  assert.equal(keys.isProjectEditKey(press({ key: " " })), false, "空格是播放 / 暂停，只读也要能用");
  assert.equal(keys.isProjectEditKey(press({ key: "ArrowLeft" })), false);
  assert.equal(keys.isProjectEditKey(press({ key: "Delete", target: { tagName: "INPUT" } })), false, "输入框里的删除键归输入框");
  assert.equal(keys.isProjectEditKey(press({ key: "z", ctrlKey: true, target: { tagName: "TEXTAREA" } })), false);

  // 装在一个假的 window 上:只读时 preventDefault + stopImmediatePropagation，没锁时什么都不做
  const handlers = [];
  const fakeWindow = { addEventListener: (type, fn, opts) => handlers.push({ type, fn, opts }) };
  keys.installReadOnlyKeyGuard(fakeWindow);
  keys.installReadOnlyKeyGuard(fakeWindow);
  assert.equal(handlers.length, 1, "幂等：装两次只挂一份");
  assert.equal(handlers[0].type, "keydown");
  assert.equal(handlers[0].opts.capture, true, "捕获阶段：赶在编辑器冒泡阶段的监听前面");
  const fire = (init) => {
    const log = { prevented: false, stopped: false };
    handlers[0].fn({ ...press(init), preventDefault: () => { log.prevented = true; }, stopImmediatePropagation: () => { log.stopped = true; } });
    return log;
  };
  reset();
  assert.deepEqual(fire({ key: "Delete" }), { prevented: false, stopped: false }, "没锁：不拦");
  vo.setProjectAccess("r");
  assert.deepEqual(fire({ key: "Delete" }), { prevented: true, stopped: true });
  assert.deepEqual(fire({ key: "z", ctrlKey: true }), { prevented: true, stopped: true });
  assert.deepEqual(fire({ key: " " }), { prevented: false, stopped: false }, "只读也能播放");
  assert.deepEqual(fire({ key: "Delete", target: { tagName: "INPUT" } }), { prevented: false, stopped: false });
  reset();
});

test("RO5 拖放载荷：只读时不记，时间轴就不会摆出落点预览和「新建序列」落区", async () => {
  const added = [];
  globalThis.window = { addEventListener: (type) => added.push(type) };
  const dnd = await import("./dnd.ts");
  const payload = { kind: "card", cardId: "x", name: "x", duration: 2 };
  reset();
  dnd.clearDragPayload();
  dnd.setDragPayload(payload);
  assert.deepEqual(dnd.getDragPayload(), payload, "读写：照常记");
  dnd.clearDragPayload();
  vo.setProjectAccess("r");
  dnd.setDragPayload(payload);
  assert.equal(dnd.getDragPayload(), null, "只读：不记");
  reset();
  delete globalThis.window;
});

test("RO6 总时长自动对齐是个写：只读项目里不做（读写照旧）", async () => {
  const stateCore = await import(srcUrl("store/core.ts"));
  const { actions, getState } = await import(srcUrl("store/project.ts"));
  const D = await import(srcUrl("editor/timeline/durationSync.ts"));
  const clip = (id, start, end) => ({ id, cardId: "", start, end, params: {} });
  const load = () => {
    actions.newProject("时长");
    const p = getState().project;
    // 内容末尾 4 秒，但项目里记的总时长是 10 秒：对齐的话会改成 4
    stateCore.setProject({ ...p, tracks: [{ ...p.tracks[0], clips: [clip("a", 0, 2), clip("b", 2, 4)] }], duration: 10 }, { undoable: false });
    stateCore.set({ durationManual: null });
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  reset();
  load();
  const stopRw = D.mountDurationSync();
  await settle();
  assert.equal(getState().project.duration, 4, "读写：对齐到内容末尾");
  stopRw();

  vo.setProjectAccess("r");
  load();
  const stopRo = D.mountDurationSync();
  await settle();
  assert.equal(getState().project.duration, 10, "只读：不改项目里的总时长");
  stopRo();
  reset();
  D.resetDurationSync();
});
