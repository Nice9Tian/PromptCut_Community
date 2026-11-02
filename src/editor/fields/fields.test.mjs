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

test("formatNumber: at most three decimal places; a non-finite number shows empty", () => {
  assert.equal(formatNumber(0.30000004), "0.3");
  assert.equal(formatNumber(1), "1");
  assert.equal(formatNumber(2.0005, 2), "2");
  assert.equal(formatNumber(undefined), "");
  assert.equal(formatNumber(NaN), "");
});

test("isTypingInput: events with an inputType are typing; events without one are arrow-key / arrow stepping", () => {
  assert.equal(isTypingInput("insertText"), true);
  assert.equal(isTypingInput("deleteContentBackward"), true);
  assert.equal(isTypingInput(undefined), false);
  assert.equal(isTypingInput(""), false);
});

test("While typing, only the draft changes and nothing is committed: changing 1 to 0.3, the intermediate \"0\" and \"0.\" never land in the project", () => {
  const b = box(1);
  b.type("");   // 退格删掉 1
  b.type("0");
  b.type("0.");
  b.type("0.3");
  assert.deepEqual(b.commits, [], "Nothing was committed during the typing phase");
  assert.equal(b.draft, "0.3");
});

test("Enter commits once and blurs the field; a later blur does not commit a second time", () => {
  const b = box(1);
  b.type("0"); b.type("0.3");
  b.enter();
  assert.equal(b.blurs, 1);
  assert.deepEqual(b.commits, [{ value: 0.3, step: false }]);
  assert.equal(b.draft, null);
  b.blur(); // 没有草稿了,再失焦不提交
  assert.equal(b.commits.length, 1);
});

test("Blur also commits once", () => {
  const b = box(1);
  b.type("0.3");
  b.blur();
  assert.deepEqual(b.commits, [{ value: 0.3, step: false }]);
});

test("Esc discards the draft: no commit, shows the project value again; a later blur does not commit either", () => {
  const b = box(1);
  b.type("0.3");
  b.esc();
  assert.equal(b.draft, null);
  b.blur();
  assert.deepEqual(b.commits, []);
});

test("Invalid values are not committed: empty, \"-\", \".\", not a number, rejected by validate, same as the displayed value", () => {
  for (const raw of ["", "-", ".", "abc", "1e999"]) {
    const b = box(1);
    b.type(raw);
    b.blur();
    assert.deepEqual(b.commits, [], `"${raw}" is not committed`);
    assert.equal(b.draft, null, "After blur it shows the original value again");
  }
  const w = box(undefined, { validate: (n) => n > 0 });
  w.type("0"); w.blur();
  w.type("-5"); w.blur();
  assert.deepEqual(w.commits, []);
  w.type("120"); w.blur();
  assert.deepEqual(w.commits, [{ value: 120, step: false }]);
  const same = box(0.30000004);
  same.type("0.3"); same.blur();
  assert.deepEqual(same.commits, [], "Same as the displayed value = unchanged, so 0.30000004 is not silently rewritten");
});

test("Arrow key / up-down arrow stepping: each press commits immediately (marked as a step, merged into one undo step by the caller); the draft is cleared", () => {
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

test("Throttling: the first value is submitted immediately, during a drag the latest value is submitted at most every 50 ms, and flush submits the last pending one", () => {
  const clock = fakeEnv();
  const seen = [];
  const th = createLatestThrottle((v) => seen.push(v), 50, clock.env);
  th.push(1);
  assert.deepEqual(seen, [1]);
  for (let i = 2; i <= 9; i++) { clock.advance(5); th.push(i); } // 40 ms 内来了 8 个值
  assert.deepEqual(seen, [1], "Values within the window are buffered");
  clock.advance(10);
  assert.deepEqual(seen, [1, 9], "When time is up, only the latest value is submitted");
  clock.advance(5); th.push(10); clock.advance(5); th.push(11);
  th.flush();
  assert.deepEqual(seen, [1, 9, 11], "On release, flush submits the last one");
  th.flush();
  assert.deepEqual(seen, [1, 9, 11], "With nothing pending, it does nothing");
  clock.advance(1000);
  assert.deepEqual(seen, [1, 9, 11]);
});

test("Throttling: cancel drops what has not been submitted", () => {
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
    tracks: [{ id: "ta", name: "Track 1", clips: [] }],
    cuts: [
      { id: "A", name: "Cut A" },
      { id: "B", name: "Cut B", tracks: [{ id: "tb", name: "Track 1", clips: [{ id: "b1", cardId: "", mediaId: "m", start: 0, end: 8, params: {} }] }], duration: 8, transitions: [] },
    ],
    activeCutId: "A",
  });
  return actions.addCutSegment("B", 2, { trackId: "ta" }).id;
}
const opacityOf = (id) => getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.opacity;

test("Snapshot stack: within one drag, a pause of more than 300 ms between commits is still a single step (unique key + infinite window); the next drag starts a new step", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const id = loadCutProject();
    const before = core.history.length;
    const k1 = newGestureKey("test-drag");
    for (const v of [0.9, 0.7, 0.5]) {
      commitMerged(k1, GESTURE_WINDOW_MS, () => actions.updateClip(id, { opacity: v }));
      mock.timers.tick(1500); // 按住不动一阵再动
    }
    assert.equal(core.history.length - before, 1, "One drag adds only one step to the undo stack");
    assert.equal(opacityOf(id), 0.5);
    const k2 = newGestureKey("test-drag");
    commitMerged(k2, GESTURE_WINDOW_MS, () => actions.updateClip(id, { opacity: 0.2 }));
    assert.equal(core.history.length - before, 2, "The second drag starts a new step");
    actions.undo();
    assert.equal(opacityOf(id), 0.5);
    actions.undo();
    assert.equal(opacityOf(id), undefined, "One undo returns to before the drag (opacity never set = 1)");
  } finally {
    mock.timers.reset();
  }
});

test("Snapshot stack: stepping uses a rolling window, a gap longer than the window starts a new step; another edit in between also starts a new step", () => {
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
    assert.equal(core.history.length - before, 2, "A pause longer than the window starts a new step");
    actions.setProjectMeta({ name: "Another edit" });
    commitMerged(k, STEP_BURST_MS, () => actions.updateClip(id, { opacity: 0.75 }));
    assert.equal(core.history.length - before, 4, "Another edit in between prevents merging");
  } finally {
    mock.timers.reset();
  }
});

test("Edits without withMerge (a single commit on Enter / blur in a number field) are one step each; nothing lingers after leaving withMerge", () => {
  const id = loadCutProject();
  const before = core.history.length;
  commitMerged(newGestureKey("x"), GESTURE_WINDOW_MS, () => actions.updateClip(id, { opacity: 0.5 }));
  actions.updateClip(id, { opacity: 0.3 });
  actions.updateClip(id, { opacity: 0.2 });
  assert.equal(core.history.length - before, 3);
});

/* ---------------- 撤销合并:连文档服务 ---------------- */

test("With the document service: one drag merges into a single undo step, but each commit still sends its own message → throttling determines how many are sent; the next drag starts a new step", () => {
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
    assert.equal(svc.log.length - logBefore, 4, "Merging only affects the undo stack; each commit still sends its own message (hence throttling during drags)");
    assert.equal(opacityOf(id), 0.4);
    const k2 = newGestureKey("test-drag");
    commitMerged(k2, GESTURE_WINDOW_MS, () => actions.updateClip(id, { opacity: 0.1 }));
    svc.drain();
    actions.undo();
    assert.equal(opacityOf(id), 0.4, "Undo the second drag");
    actions.undo();
    assert.equal(opacityOf(id), undefined, "One undo returns to before the first drag");
    svc.drain();
    assert.equal(JSON.stringify(getState().project), JSON.stringify(svc.project));
  } finally {
    unbind();
  }
});
