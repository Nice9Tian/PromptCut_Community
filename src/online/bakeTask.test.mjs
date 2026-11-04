/**
 * Pure functions for snapshot generation on pure browser nodes (M7 contract sections 4.3 and 4.5):
 *   - `input.bake` provided by splitter to browser → isolated single-card project, identical to
 *     desktop `FramePipeline#isolatedCardProject` (sharing `src/kernel/isolatedCard.mjs`);
 *   - Manifest shape matches desktop `collectSnapshotResult`, passes desktop `manifestMatches`;
 *     key matches `manifestKeyOf`;
 *   - Deduplication criteria: correct shape, covers entire segment, and both tiers present.
 * Run: node --test src/online/bakeTask.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bakeInputOf, isolatedCardProject, manifestKey, snapshotManifest, manifestCovers, manifestBlocks, RESULT_MAX_BYTES } from "./bakeTask.ts";
import { splitPlan } from "../../server/render-node/split.mjs";
import { manifestMatches, manifestKeyOf, RESULT_MAX_BYTES as SERVER_MAX } from "../../server/artifact-transfer.mjs";
import { FramePipeline } from "../../server/frame-pipeline.mjs";

const H = (n) => String(n).padStart(64, "0");

const PROJECT = {
  id: "p1", width: 1920, height: 1080, fps: 30, duration: 4, tracks: [
    { id: "t1", clips: [
      { id: "clip-a", cardId: "punch-pill", start: 1.5, end: 3.5, params: { text: "x" } },
      { id: "clip-b", cardId: "mu-number-ticker", start: 0, end: 1 },
    ] },
    { id: "t2", clips: [{ id: "clip-c", mediaId: "m", start: 0, end: 4 }] },
  ],
};
const CONTROL = { clipId: "clip-a", cardId: "punch-pill", snapshotKey: "sk-a", tier: "shared", contentKey: "ck-a", start: 1.5, end: 3.5, count: 60,
  sampling: { firstFrame: 45, phase: { numerator: "1", denominator: "60" } }, compositing: "independent",
  capabilities: { compositing: "independent", canvasHeavy: false } };

function browserTask() {
  const planTask = { id: "plan:p1@3#clips:x", kind: "plan", resultKey: "p1@3#clips:x", source: { projectId: "p1", projectRev: 3 }, input: { clips: ["clip-a"] }, requires: {} };
  const tasks = splitPlan({ planTask, entryKey: "e1", cardPlan: [CONTROL], prerenderSet: new Set(["clip-a"]), envFingerprint: "aaaaaaaaaaaaaaaa",
    codeVersion: "cv-1", weightOf: () => ({ class: "medium", estMs: null }), browserFingerprints: ["bbbbbbbbbbbbbbbb"] });
  const t = tasks.find((x) => x.requires.envFingerprint === "bbbbbbbbbbbbbbbb");
  assert.ok(t, `The splitter should produce the browser's share: ${JSON.stringify(tasks.map((x) => x.requires.envFingerprint))}`);
  return t;
}

test("M7-BT-01 the share the splitter gives the browser, input.bake → an isolated single-card project, identical field by field to desktop FramePipeline#isolatedCardProject", () => {
  const task = browserTask();
  const input = bakeInputOf(task);
  assert.ok(input, JSON.stringify(task.input));
  assert.equal(input.clipId, "clip-a");
  const page = isolatedCardProject(PROJECT, input);
  const desktop = new FramePipeline({ root: ".", origin: () => "" }).isolatedCardProject(PROJECT, { ...CONTROL, clipId: "clip-a" });
  assert.deepEqual(page, desktop);
  const visible = page.tracks.filter((tr) => !tr.hidden);
  assert.deepEqual(visible.map((tr) => tr.clips.map((c) => c.id)), [["clip-a"]]);
  assert.equal(visible[0].clips[0].start, -1 / 60);
  assert.notEqual(page, PROJECT, "returns a new object, does not modify in place");
  assert.equal(PROJECT.tracks[0].clips[0].start, 1.5);
});

test("M7-BT-02 bakeInputOf returns null when something is missing (no guessing)", () => {
  assert.equal(bakeInputOf({ input: { clipId: "c" } }), null);
  assert.equal(bakeInputOf({ input: { bake: { start: 0, end: 1, count: 30, sampling: { phase: { numerator: 0, denominator: 1 } } } } }), null);
  assert.equal(bakeInputOf({ input: { clipId: "c", bake: { start: 0, end: 1, count: 0, sampling: { phase: { numerator: 0, denominator: 1 } } } } }), null);
  assert.equal(bakeInputOf({ input: { clipId: "c", bake: { start: 0, end: 1, count: 3, sampling: {} } } }), null);
  assert.ok(bakeInputOf({ input: { clipId: "c", bake: { start: 0, end: 1, count: 3, sampling: { phase: { numerator: "0", denominator: "1" } } } } }));
});

test("M7-BT-03 manifest shape same as collectSnapshotResult: passes manifestMatches; key same as manifestKeyOf; over the limit throws non-retryable", () => {
  const task = { ...browserTask(), range: { unit: "localFrame", from: 0, to: 2 } };
  const frames = [2, 0, 1].map((f) => ({ localFrame: f, hash: H(f + 1), bytes: 100 + f, small: { hash: H(f + 11), bytes: 50 } }));
  const m = snapshotManifest(task, frames);
  assert.deepEqual(m, {
    v: 1, kind: "snapshot", tier: "shared", resultKey: task.resultKey, dirKey: task.resultKey, entryKey: null,
    range: { from: 0, to: 2 }, canvasHeavy: false,
    frames: [[0, H(1), 100], [1, H(2), 101], [2, H(3), 102]],
    small: [[0, H(11), 50], [1, H(12), 50], [2, H(13), 50]],
  });
  assert.equal(manifestMatches(m, { kind: "snapshot", resultKey: task.resultKey, range: task.range }), true);
  assert.equal(manifestKey(task), manifestKeyOf(task));
  assert.equal(RESULT_MAX_BYTES, SERVER_MAX);
  assert.equal(manifestCovers(m, task), true);
  assert.deepEqual(manifestBlocks(m).map((b) => `${b.ns}/${b.hash}`).sort(), [...[1, 2, 3].map((n) => `snap/${H(n)}`), ...[11, 12, 13].map((n) => `px/${H(n)}`)].sort());
  // If there is no small size, small is omitted; at this point, both tiers are not considered present
  const noSmall = snapshotManifest(task, frames.map(({ small, ...f }) => f));
  assert.equal("small" in noSmall, false);
  assert.equal(manifestCovers(noSmall, task), false);
  // Missing frames do not count as coverage
  assert.equal(manifestCovers(snapshotManifest(task, frames.slice(1)), task), false);
  // Exceeds 256 KiB: throws result-too-large, non-retryable
  const many = Array.from({ length: 4000 }, (_, i) => ({ localFrame: i, hash: H(i), bytes: 1 }));
  assert.throws(() => snapshotManifest({ ...task, range: { from: 0, to: 3999 } }, many), (e) => e.code === "result-too-large" && e.retryable === false);
});
