/**
 * C6.6 Integration 3b: after modifying a card, wait until both stages switch to this card revision
 * before retesting; only reload the one that has not switched after timeout (`stageCards.ts`).
 * Run: node --test src/editor/stageCards.test.mjs
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const S = await import("./stageCards.ts");

test.afterEach(() => S.resetStageCardsForTest());

test("C66-3b-01 Proceed only when both stages have checked in for this version; the one that checked in first does not count on its own, and as soon as the later one arrives it proceeds", async () => {
  const reloaded = [];
  S.bindStageCards(["A", "B"], (id) => reloaded.push(id));
  let done = null;
  const p = S.whenStagesHaveCards(100, 2000).then((r) => { done = r; });
  S.noteStageCards("A", 100);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, null, "B has not checked in yet");
  S.noteStageCards("B", 100);
  await p;
  assert.deepEqual(done, [], "Both have checked in: no reload");
  assert.deepEqual(reloaded, []);
});

test("C66-3b-02 A newer version has already been checked in (the stage received the hot update first) or a handshake has just happened: proceed immediately", async () => {
  S.bindStageCards(["A", "B"], () => assert.fail("Should not reload"));
  S.noteStageCards("A", 200);
  S.noteStageFresh("B", 300);
  assert.deepEqual(await S.whenStagesHaveCards(150, 2000), []);
  assert.deepEqual(S.staleStages(250), ["A"]);
});

test("C66-3b-03 Only a stage that has not checked in after the time limit counts as running stale code: reload only it; a legacy single stage waits only for A", async () => {
  const reloaded = [];
  S.bindStageCards(["A", "B"], (id) => reloaded.push(id));
  S.noteStageCards("A", 500);
  assert.deepEqual(await S.whenStagesHaveCards(500, 50), ["B"]);
  assert.deepEqual(reloaded, ["B"]);
  S.resetStageCardsForTest();
  S.bindStageCards(["A"], () => assert.fail("Should not reload"));
  S.noteStageCards("A", 600);
  assert.deepEqual(await S.whenStagesHaveCards(600, 50), []);
  assert.deepEqual(await S.whenStagesHaveCards(0, 50), [], "No timestamp (no card has been changed): do not wait");
});
