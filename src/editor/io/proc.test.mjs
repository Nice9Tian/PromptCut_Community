/**
 * Pure logic for dropping Python cards when opening an old `.proc` (H6). Run:
 *   node --experimental-test-module-mocks --test src/editor/io/proc.test.mjs
 *
 * Pin down: entire `cardDefinitions` field is gone, nodes with `adapter: 'python'` are gone, clips
 * referencing them have `nodeId` cleared (media clips turn back into normal media clips), other
 * nodes and clips are left completely untouched, and the counted number of cards is N in that
 * message on the notice bar.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { dropPythonNodes, pythonDropMessage, publishPythonDrop, takePythonDrops } from "./pythonDrop.ts";

const legacy = () => ({
  id: "old",
  cardDefinitions: [
    { id: "invert", language: "python", entry: "Card", kind: "filter", source: "class Card: pass" },
    { id: "legacy-tsx", language: "tsx", source: "export const x = 1" },
  ],
  cardNodes: [
    { id: "py-a", adapter: "python", definitionId: "invert", inputs: {} },
    { id: "py-b", adapter: "python", definitionId: "invert", inputs: {} },
    { id: "chrome-a", adapter: "chrome", cardId: "punch-pill", inputs: {} },
  ],
  tracks: [
    { id: "main", clips: [
      { id: "shot", mediaId: "m1", nodeId: "py-a", start: 0, end: 2 },
      { id: "pure", nodeId: "py-b", start: 2, end: 3 },
      { id: "card", cardId: "punch-pill", nodeId: "chrome-a", start: 3, end: 4 },
    ] },
  ],
});

test("The whole cardDefinitions field is removed, not just the python entries", () => {
  const raw = legacy();
  dropPythonNodes(raw);
  assert.equal("cardDefinitions" in raw, false);
});

test("Drop the nodes whose adapter is python, and clear the nodeId of clips that reference them", () => {
  const raw = legacy();
  const dropped = dropPythonNodes(raw);
  assert.equal(dropped, 2);
  assert.deepEqual(raw.cardNodes.map((n) => n.id), ["chrome-a"]);
  const clips = raw.tracks[0].clips;
  // Media clip reverts to normal media clip: mediaId remains, nodeId is gone
  assert.equal("nodeId" in clips[0], false);
  assert.equal(clips[0].mediaId, "m1");
  // Pure python clip: has neither node nor cardId, skipped by flattenOverlay
  assert.equal("nodeId" in clips[1], false);
  assert.equal(clips[1].cardId, undefined);
  // Others' nodes are left completely untouched
  assert.equal(clips[2].nodeId, "chrome-a");
  assert.equal(clips[2].cardId, "punch-pill");
});

test("A project with no python cards drops none, and cardDefinitions is still not kept", () => {
  const raw = { cardNodes: [{ id: "chrome-a", adapter: "chrome" }], tracks: [{ id: "main", clips: [{ id: "a", mediaId: "m" }] }] };
  assert.equal(dropPythonNodes(raw), 0);
  assert.deepEqual(raw.cardNodes.map((n) => n.id), ["chrome-a"]);
  assert.equal(raw.tracks[0].clips[0].mediaId, "m");
});

test("Empty / non-object input does not throw", () => {
  assert.equal(dropPythonNodes(null), 0);
  assert.equal(dropPythonNodes(undefined), 0);
  assert.equal(dropPythonNodes("not a project"), 0);
  assert.equal(dropPythonNodes({}), 0);
});

test("The notification bar says it only once, and N in the sentence is the number of dropped cards", () => {
  takePythonDrops();
  const raw = legacy();
  publishPythonDrop(dropPythonNodes(raw));
  const n = takePythonDrops();
  assert.equal(n, 2);
  assert.equal(pythonDropMessage(n), "2 Python cards were disabled and are no longer shown");
  // Empty once taken: will not notify a second time during the same load
  assert.equal(takePythonDrops(), 0);
});
