/**
 * Total duration action shared between project settings and Agent. Run:
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

test("Manually entering a shorter duration truncates it and remembers the truncation point", () => {
  projectMeta.setDurationManual(25);
  assert.equal(state.project.duration, 25);
  assert.equal(state.durationManual, 25);
});

test("Entering a value past the end of the content clamps to the end and resumes following the content", () => {
  projectMeta.setDurationManual(25);
  projectMeta.setDurationManual(90);
  assert.equal(state.project.duration, 40);
  assert.equal(state.durationManual, null);
});

test("An empty project keeps the configured duration and records no truncation point", () => {
  state.project = { duration: 30, tracks: [] };
  projectMeta.setDurationManual(30);
  assert.equal(state.project.duration, 30);
  assert.equal(state.durationManual, null);
  projectMeta.setDurationManual(60);
  assert.equal(state.project.duration, 60);
  assert.equal(state.durationManual, null);
});
