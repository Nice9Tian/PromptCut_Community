/**
 * Wiring for "user is editing" (src/editor/userEditing.ts, plan docs/plan/agent-workflow-plan.md A2).
 * Test cases UE-W1~UE-W2.
 * Listen to store: modifications to selected clips by this page count as "recently modified";
 * unselected clips and modifications during tools executed by the page for the Agent do not count;
 * push via /api/agent/editing.
 * Run: node --test src/editor/userEditing.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) });
  return { ok: true, json: async () => ({ ok: true }) };
};

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { createEmptyProject } = await import(srcUrl("kernel/project.ts"));
const ue = await import(srcUrl("editor/userEditing.ts"));
/** A project with two clips (not dependent on card registry) */
function load(name) {
  const p = createEmptyProject(name);
  p.tracks = [{ id: "t1", name: "Video", clips: [
    { id: "a", cardId: "title", params: {}, start: 0, end: 2 },
    { id: "b", cardId: "title", params: {}, start: 5, end: 7 },
  ] }];
  actions.loadProject(p);
  return { a: { id: "a" }, b: { id: "b" } };
}
const kinds = () => ue.userEditingSnapshot().map((e) => `${e.clipId}:${e.kind}`);

test("UE-W1 A selected clip changed by this page counts as \"just touched\"; only selecting, or changing an unselected one, does not count; pushed to /api/agent/editing", async () => {
  const { a, b } = load("ue");
  const stop = ue.startUserEditing();
  try {
    actions.select([a.id]);
    assert.deepEqual(kinds(), [], "Selecting alone does not count");
    actions.updateClip(b.id, { opacity: 0.5 });
    assert.deepEqual(kinds(), [], "Changing an unselected one does not count");
    actions.updateClip(a.id, { opacity: 0.4 });
    assert.deepEqual(kinds(), [`${a.id}:recent`]);
    await new Promise((r) => setTimeout(r, 300));
    const last = posts.at(-1);
    assert.equal(last.url, "/api/agent/editing");
    assert.match(last.body.session, /^ue-/);
    assert.deepEqual(last.body.entities.map((e) => [e.clipId, e.kind]), [[a.id, "recent"]]);
    assert.ok(last.body.entities[0].remainingMs > 29_000 && last.body.entities[0].remainingMs <= 30_000);
    actions.select([]);
    assert.deepEqual(kinds(), [], "Deselecting withdraws it");
  } finally {
    stop();
  }
});

test("UE-W2 Edits made during a tool that the Agent has the page execute do not count as the user having touched it", () => {
  const { a } = load("ue2");
  const stop = ue.startUserEditing();
  try {
    actions.select([a.id]);
    ue.beginAgentTool();
    actions.updateClip(a.id, { opacity: 0.3 });
    ue.endAgentTool();
    assert.deepEqual(kinds(), []);
    assert.equal(getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === a.id).opacity, 0.3);
  } finally {
    stop();
  }
});
