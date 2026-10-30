/**
 * C6.6 集成 3b:改卡之后等两个舞台都换上这一版卡片再重测;过了时限没换上的才重载那一个(`stageCards.ts`)。
 * 跑:node --test src/editor/stageCards.test.mjs
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const S = await import("./stageCards.ts");

test.afterEach(() => S.resetStageCardsForTest());

test("C66-3b-01 两个舞台都报到这一版才放行;先报到的不算,后报到的一到就放行", async () => {
  const reloaded = [];
  S.bindStageCards(["A", "B"], (id) => reloaded.push(id));
  let done = null;
  const p = S.whenStagesHaveCards(100, 2000).then((r) => { done = r; });
  S.noteStageCards("A", 100);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, null, "B 还没报到");
  S.noteStageCards("B", 100);
  await p;
  assert.deepEqual(done, [], "都报到了:不重载");
  assert.deepEqual(reloaded, []);
});

test("C66-3b-02 已经报到过更新的一版(舞台先收到热更新)或刚握过手:立刻放行", async () => {
  S.bindStageCards(["A", "B"], () => assert.fail("不该重载"));
  S.noteStageCards("A", 200);
  S.noteStageFresh("B", 300);
  assert.deepEqual(await S.whenStagesHaveCards(150, 2000), []);
  assert.deepEqual(S.staleStages(250), ["A"]);
});

test("C66-3b-03 过了时限还没报到的舞台才算代码过期:只重载它;legacy 单舞台只等 A", async () => {
  const reloaded = [];
  S.bindStageCards(["A", "B"], (id) => reloaded.push(id));
  S.noteStageCards("A", 500);
  assert.deepEqual(await S.whenStagesHaveCards(500, 50), ["B"]);
  assert.deepEqual(reloaded, ["B"]);
  S.resetStageCardsForTest();
  S.bindStageCards(["A"], () => assert.fail("不该重载"));
  S.noteStageCards("A", 600);
  assert.deepEqual(await S.whenStagesHaveCards(600, 50), []);
  assert.deepEqual(await S.whenStagesHaveCards(0, 50), [], "没有时间戳(没换过卡)不等");
});
