/**
 * 项目设置与 Agent 共用的总时长动作。跑:
 * node --experimental-test-module-mocks --test src/store/actions/projectMeta.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const state = { project: { duration: 30, tracks: [] }, durationManual: null };
mock.module(srcUrl("store/core.ts"), {
  exports: {
    state,
    set: (patch) => Object.assign(state, patch),
    setProject: (project) => { state.project = project; },
  },
});

const { projectMeta } = await import(srcUrl("store/actions/projectMeta.ts"));
const clip = (end) => ({ id: "c", cardId: "x", start: 0, end, params: {} });

beforeEach(() => {
  state.project = { duration: 40, tracks: [{ id: "t", name: "t", clips: [clip(40)] }] };
  state.durationManual = null;
});

test("手动输入较短时长会截短并记住截断点", () => {
  projectMeta.setDurationManual(25);
  assert.equal(state.project.duration, 25);
  assert.equal(state.durationManual, 25);
});

test("输入超过内容末尾会钳到末尾，并恢复跟随内容", () => {
  projectMeta.setDurationManual(25);
  projectMeta.setDurationManual(90);
  assert.equal(state.project.duration, 40);
  assert.equal(state.durationManual, null);
});

test("空项目保留设置的时长，不记录截断点", () => {
  state.project = { duration: 30, tracks: [] };
  projectMeta.setDurationManual(30);
  assert.equal(state.project.duration, 30);
  assert.equal(state.durationManual, null);
  projectMeta.setDurationManual(60);
  assert.equal(state.project.duration, 60);
  assert.equal(state.durationManual, null);
});
