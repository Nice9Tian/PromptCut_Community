/**
 * 编辑面板的数字框与滑块:草稿后提交、一次拖动一步撤销(2026-10-20 用户定,workflow/editing.md「撤销、重做」)。
 * 跑:node --test src/editor/fields/fields.test.mjs
 *
 * 单测里没有 DOM,所以数字框的逻辑放在纯状态机里(numberDraft.ts 的 reduceField)直接驱动;
 * 滑块的提交限速(createLatestThrottle)用假时钟;撤销合并走真的 store(快照栈模式、连文档服务模式各一遍)。
 * 真实浏览器里的敲字、回车、拖动由 scripts/probes/number-input-undo-probe.mjs 和 cut-segment-panel-probe.mjs 验。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { MemDocService } from "../../testing/memDocService.mjs";

const { formatNumber, isTypingInput, reduceField } = await import(srcUrl("editor/fields/numberDraft.ts"));
const { createLatestThrottle, commitMerged, newGestureKey, GESTURE_WINDOW_MS, STEP_BURST_MS } = await import(srcUrl("editor/fields/mergedEdit.ts"));
const { actions, getState } = await import(srcUrl("store/project.ts"));
const core = await import(srcUrl("store/core.ts"));
const { DocSync, bindStore } = await import(srcUrl("store/docsync.ts"));

/* ---------------- 数字框:草稿 ---------------- */

/** 模拟一个数字框:value 是项目里的值,commits 记下提交;按事件顺序喂 reduceField,和 NumberField 一样回车触发失焦 */
function box(value, opts = {}) {
  const s = { value, draft: null, commits: [], blurs: 0 };
  const send = (ev) => {
    const out = reduceField(s.draft, ev, { value: s.value, ...opts });
    s.draft = out.draft;
    if (out.commit) { s.commits.push(out.commit); s.value = out.commit.value; }
    if (out.blur) { s.blurs++; send({ type: "blur" }); }
  };
  s.type = (raw) => send({ type: "input", raw, typing: true });
  s.step = (raw) => send({ type: "input", raw, typing: false });
  s.blur = () => send({ type: "blur" });
  s.enter = () => send({ type: "enter" });
  s.esc = () => send({ type: "escape" });
  return s;
}

test("formatNumber:最多三位小数,不是有限数显示空", () => {
  assert.equal(formatNumber(0.30000004), "0.3");
  assert.equal(formatNumber(1), "1");
  assert.equal(formatNumber(2.0005, 2), "2");
  assert.equal(formatNumber(undefined), "");
  assert.equal(formatNumber(NaN), "");
});

test("isTypingInput:有 inputType 的是敲字,没有的是方向键 / 箭头步进", () => {
  assert.equal(isTypingInput("insertText"), true);
  assert.equal(isTypingInput("deleteContentBackward"), true);
  assert.equal(isTypingInput(undefined), false);
  assert.equal(isTypingInput(""), false);
});

test("敲字过程中只改草稿、不提交:1 改成 0.3,中间的「0」「0.」不会落进项目", () => {
  const b = box(1);
  b.type("");   // 退格删掉 1
  b.type("0");
  b.type("0.");
  b.type("0.3");
  assert.deepEqual(b.commits, [], "敲字阶段一次都没提交");
  assert.equal(b.draft, "0.3");
});

test("回车提交一次,并让框失焦;之后再失焦不会提交第二次", () => {
  const b = box(1);
  b.type("0"); b.type("0.3");
  b.enter();
  assert.equal(b.blurs, 1);
  assert.deepEqual(b.commits, [{ value: 0.3, step: false }]);
  assert.equal(b.draft, null);
  b.blur(); // 没有草稿了,再失焦不提交
  assert.equal(b.commits.length, 1);
});

test("失焦也提交一次", () => {
  const b = box(1);
  b.type("0.3");
  b.blur();
  assert.deepEqual(b.commits, [{ value: 0.3, step: false }]);
});

test("Esc 放弃草稿:不提交,显示回项目里的值;之后失焦也不提交", () => {
  const b = box(1);
  b.type("0.3");
  b.esc();
  assert.equal(b.draft, null);
  b.blur();
  assert.deepEqual(b.commits, []);
});

test("非法值不提交:空、「-」、「.」、不是数、validate 不认、和显示的值一样", () => {
  for (const raw of ["", "-", ".", "abc", "1e999"]) {
    const b = box(1);
    b.type(raw);
    b.blur();
    assert.deepEqual(b.commits, [], `「${raw}」不提交`);
    assert.equal(b.draft, null, "失焦后显示回原值");
  }
  const w = box(undefined, { validate: (n) => n > 0 });
  w.type("0"); w.blur();
  w.type("-5"); w.blur();
  assert.deepEqual(w.commits, []);
  w.type("120"); w.blur();
  assert.deepEqual(w.commits, [{ value: 120, step: false }]);
  const same = box(0.30000004);
  same.type("0.3"); same.blur();
  assert.deepEqual(same.commits, [], "和显示的值一样 = 没改,不把 0.30000004 悄悄改写");
});

test("方向键 / 上下箭头步进:每一下立即提交(标记为步进,由调用方并成一步撤销);草稿清掉", () => {
  const b = box(1);
  b.step("0.95"); b.step("0.9"); b.step("0.85");
  assert.deepEqual(b.commits.map((c) => [c.value, c.step]), [[0.95, true], [0.9, true], [0.85, true]]);
  assert.equal(b.draft, null);
});

/* ---------------- 滑块:提交限速 ---------------- */

function fakeEnv() {
  let t = 0;
  const timers = [];
  return {
    env: {
      now: () => t,
      setTimeout: (fn, ms) => { const h = { fn, at: t + ms, dead: false }; timers.push(h); return h; },
      clearTimeout: (h) => { h.dead = true; },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((h) => !h.dead && h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at; next.dead = true; next.fn();
      }
      t = end;
    },
  };
}

test("限速:第一个值立刻交,拖动中最快每 50 ms 交一次最新值,flush 补交最后一个", () => {
  const clock = fakeEnv();
  const seen = [];
  const th = createLatestThrottle((v) => seen.push(v), 50, clock.env);
  th.push(1);
  assert.deepEqual(seen, [1]);
  for (let i = 2; i <= 9; i++) { clock.advance(5); th.push(i); } // 40 ms 内来了 8 个值
  assert.deepEqual(seen, [1], "窗口内的值先攒着");
  clock.advance(10);
  assert.deepEqual(seen, [1, 9], "到点只交最新的");
  clock.advance(5); th.push(10); clock.advance(5); th.push(11);
  th.flush();
  assert.deepEqual(seen, [1, 9, 11], "松手 flush 补交最后一个");
  th.flush();
  assert.deepEqual(seen, [1, 9, 11], "没有待交的就什么也不做");
  clock.advance(1000);
  assert.deepEqual(seen, [1, 9, 11]);
});

test("限速:cancel 丢掉没交的", () => {
  const clock = fakeEnv();
  const seen = [];
  const th = createLatestThrottle((v) => seen.push(v), 50, clock.env);
  th.push(1); th.push(2);
  th.cancel();
  clock.advance(500);
  assert.deepEqual(seen, [1]);
});

/* ---------------- 撤销合并:快照栈模式 ---------------- */

function loadCutProject() {
  actions.loadProject({
    version: 1, id: "p-fields", name: "t", width: 1280, height: 720, fps: 30, duration: 20, themeId: "midnight", media: [],
    tracks: [{ id: "ta", name: "序列 1", clips: [] }],
    cuts: [
      { id: "A", name: "剪辑A" },
      { id: "B", name: "剪辑B", tracks: [{ id: "tb", name: "序列 1", clips: [{ id: "b1", cardId: "", mediaId: "m", start: 0, end: 8, params: {} }] }], duration: 8, transitions: [] },
    ],
    activeCutId: "A",
  });
  return actions.addCutSegment("B", 2, { trackId: "ta" }).id;
}
const opacityOf = (id) => getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.opacity;

test("快照栈:一次拖动里提交停顿超过 300 ms 也还是一步(独一份的 key + 无穷窗口);下一次拖动另起一步", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const id = loadCutProject();
    const before = core.history.length;
    const k1 = newGestureKey("test-drag");
    for (const v of [0.9, 0.7, 0.5]) {
      commitMerged(k1, GESTURE_WINDOW_MS, () => actions.updateClip(id, { opacity: v }));
      mock.timers.tick(1500); // 按住不动一阵再动
    }
    assert.equal(core.history.length - before, 1, "一次拖动只进撤销栈一步");
    assert.equal(opacityOf(id), 0.5);
    const k2 = newGestureKey("test-drag");
    commitMerged(k2, GESTURE_WINDOW_MS, () => actions.updateClip(id, { opacity: 0.2 }));
    assert.equal(core.history.length - before, 2, "第二次拖动另起一步");
    actions.undo();
    assert.equal(opacityOf(id), 0.5);
    actions.undo();
    assert.equal(opacityOf(id), undefined, "撤销一次回到拖动前(没设过不透明度 = 1)");
  } finally {
    mock.timers.reset();
  }
});

test("快照栈:步进用滚动窗口,相隔超过窗口就另起一步;中间夹了别的修改也另起", () => {
  mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  try {
    const id = loadCutProject();
    const before = core.history.length;
    const k = newGestureKey("test-step");
    commitMerged(k, STEP_BURST_MS, () => actions.updateClip(id, { opacity: 0.95 }));
    mock.timers.tick(600);
    commitMerged(k, STEP_BURST_MS, () => actions.updateClip(id, { opacity: 0.9 }));
    mock.timers.tick(600); // 距第一下 1200 ms,但距上一下只有 600 ms:滚动窗口
    commitMerged(k, STEP_BURST_MS, () => actions.updateClip(id, { opacity: 0.85 }));
    assert.equal(core.history.length - before, 1);
    mock.timers.tick(STEP_BURST_MS + 1);
    commitMerged(k, STEP_BURST_MS, () => actions.updateClip(id, { opacity: 0.8 }));
    assert.equal(core.history.length - before, 2, "停顿超过窗口另起一步");
    actions.setProjectMeta({ name: "别的修改" });
    commitMerged(k, STEP_BURST_MS, () => actions.updateClip(id, { opacity: 0.75 }));
    assert.equal(core.history.length - before, 4, "中间夹了别的修改不合并");
  } finally {
    mock.timers.reset();
  }
});

test("不带 withMerge 的修改(数字框回车 / 失焦的一次提交)每次各一步;withMerge 出来之后不残留", () => {
  const id = loadCutProject();
  const before = core.history.length;
  commitMerged(newGestureKey("x"), GESTURE_WINDOW_MS, () => actions.updateClip(id, { opacity: 0.5 }));
  actions.updateClip(id, { opacity: 0.3 });
  actions.updateClip(id, { opacity: 0.2 });
  assert.equal(core.history.length - before, 3);
});

/* ---------------- 撤销合并:连文档服务 ---------------- */

test("连文档服务:一次拖动合成一步撤销,但每次提交仍各发一条 → 限速决定条数;下一次拖动另起一步", () => {
  const id = loadCutProject();
  const p0 = getState().project;
  let t = 5000;
  const svc = new MemDocService({ project: structuredClone(p0), rev: 1 });
  let link;
  const A = new DocSync(p0, { projectId: "P", session: "A", send: (m) => link.send(m), now: () => t });
  link = svc.connect("A", (m) => A.receive(m));
  const unbind = bindStore(A);
  A.connect();
  svc.drain();
  try {
    const logBefore = svc.log.length;
    const k1 = newGestureKey("test-drag");
    for (const v of [0.9, 0.7, 0.5, 0.4]) {
      commitMerged(k1, GESTURE_WINDOW_MS, () => actions.updateClip(id, { opacity: v }));
      t += 2000; // 停顿远超 300 ms
    }
    svc.drain();
    assert.equal(svc.log.length - logBefore, 4, "合并只管撤销栈;每次提交照样各发一条(所以拖动中要限速)");
    assert.equal(opacityOf(id), 0.4);
    const k2 = newGestureKey("test-drag");
    commitMerged(k2, GESTURE_WINDOW_MS, () => actions.updateClip(id, { opacity: 0.1 }));
    svc.drain();
    actions.undo();
    assert.equal(opacityOf(id), 0.4, "撤销第二次拖动");
    actions.undo();
    assert.equal(opacityOf(id), undefined, "撤销一次回到第一次拖动之前");
    svc.drain();
    assert.equal(JSON.stringify(getState().project), JSON.stringify(svc.project));
  } finally {
    unbind();
  }
});
