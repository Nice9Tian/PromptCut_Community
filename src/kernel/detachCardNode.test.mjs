/**
 * 摘掉片段上那张素材效果卡(`cardAuthoring.mjs` 的 `detachCardNode`,issue #35 第 3 项)。
 *
 * 它和另外三样挂载不一样:那三样是片段上的一个字段,置空就完了;这个是节点图里的一个节点,
 * 连着输入和输出。所以这里守的是**链接回去**这件事:
 * 摘中间一张,上下游要接上;摘最后一张,片段回到普通素材段;接不回去的要抛出说得清的话。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detachCardNode } from "./cardAuthoring.mjs";

/** 注册表:只要能查到 defaults 就够,画面不进这支测试 */
const getCard = (id) => ({
  invert: { id: "invert", name: "Invert colors", card: () => {}, defaults: { amount: 1 } },
  blur: { id: "blur", name: "blur", card: () => {}, defaults: { sigma: 4 } },
  xfade: { id: "xfade", name: "crossfade", kind: "transition", card: () => {}, defaults: {} },
  intro: { id: "intro", name: "Intro", card: () => {}, defaults: {} },
}[id]);

/** 素材 → 反色 → 模糊,片段的终端是模糊 */
function chain() {
  return {
    id: "p", width: 1920, height: 1080, fps: 30, duration: 5, media: [{ id: "m1", kind: "video" }],
    tracks: [{ id: "t1", clips: [{ id: "c1", mediaId: "m1", start: 0, end: 5, cardId: "blur", nodeId: "n-blur", params: { sigma: 4 } }] }],
    cardNodes: [
      { id: "n-inv", adapter: "card", cardId: "invert", kind: "filter", params: { amount: 1 }, inputs: { source: { nodeId: "@clip/c1/source" } } },
      { id: "n-blur", adapter: "card", cardId: "blur", kind: "filter", params: { sigma: 4 }, inputs: { source: { nodeId: "n-inv" } } },
    ],
  };
}

test("Detaching the last card in the chain: the clip is attached to the previous card, and the card itself is deleted from the library", () => {
  const r = detachCardNode(chain(), "c1", getCard);
  const clip = r.project.tracks[0].clips[0];
  assert.equal(clip.nodeId, "n-inv", "Downstream must be connected to upstream, otherwise the invert is lost too");
  assert.equal(clip.cardId, "invert");
  assert.deepEqual(clip.params, { amount: 1 });
  assert.deepEqual(r.project.cardNodes.map((n) => n.id), ["n-inv"]);
  assert.equal(r.removed, true);
});

test("Detaching one more: the clip returns to a plain media clip, and cardId and params go back to how they were before anything was attached", () => {
  const once = detachCardNode(chain(), "c1", getCard);
  const twice = detachCardNode(once.project, "c1", getCard);
  const clip = twice.project.tracks[0].clips[0];
  assert.equal(clip.nodeId, undefined);
  assert.equal(clip.cardId, undefined);
  assert.deepEqual(clip.params, {});
  assert.equal(clip.mediaId, "m1", "The media must not disappear with it");
  assert.deepEqual(twice.project.cardNodes, []);
});

test("The base of a card clip is a real node; after detaching the card on top, the clip is still that card", () => {
  const p = {
    id: "p", width: 1920, height: 1080, fps: 30, duration: 5, media: [],
    tracks: [{ id: "t1", clips: [{ id: "c1", start: 0, end: 5, cardId: "blur", nodeId: "n-blur", params: { sigma: 4 } }] }],
    cardNodes: [
      { id: "n-intro", adapter: "card", cardId: "intro", kind: "animation", params: {}, inputs: {} },
      { id: "n-blur", adapter: "card", cardId: "blur", kind: "filter", params: { sigma: 4 }, inputs: { source: { nodeId: "n-intro" } } },
    ],
  };
  const clip = detachCardNode(p, "c1", getCard).project.tracks[0].clips[0];
  assert.equal(clip.nodeId, "n-intro");
  assert.equal(clip.cardId, "intro", "It returns to its own card, not an empty clip");
});

test("If others still reference it, it is not deleted from the library; this clip just stops using it", () => {
  const p = chain();
  p.tracks[0].clips.push({ id: "c2", mediaId: "m1", start: 5, end: 8, cardId: "invert", nodeId: "n-other", params: {} });
  p.cardNodes.push({ id: "n-other", adapter: "card", cardId: "invert", kind: "filter", params: {}, inputs: { source: { nodeId: "n-blur" } } });
  const r = detachCardNode(p, "c1", getCard);
  assert.equal(r.removed, false);
  assert.equal(r.project.cardNodes.some((n) => n.id === "n-blur"), true, "It still feeds c2; deleting it would leave c2 blind");
  assert.equal(r.project.tracks[0].clips[0].nodeId, "n-inv");
});

test("A card with two inputs, like a transition, cannot be detached; the message says why", () => {
  const p = chain();
  p.cardNodes[1] = { id: "n-blur", adapter: "card", cardId: "xfade", kind: "transition", params: {}, inputs: { A: { nodeId: "n-inv" }, B: { nodeId: "@clip/c1/source" } } };
  p.tracks[0].clips[0].cardId = "xfade";
  assert.throws(() => detachCardNode(p, "c1", getCard), /more than one input.*A, B/s);
});

test("A card with no input cannot be detached: it is the content of this clip itself", () => {
  const p = {
    id: "p", width: 1920, height: 1080, fps: 30, duration: 5, media: [],
    tracks: [{ id: "t1", clips: [{ id: "c1", start: 0, end: 5, cardId: "intro", nodeId: "n-intro", params: {} }] }],
    cardNodes: [{ id: "n-intro", adapter: "card", cardId: "intro", kind: "animation", params: {}, inputs: {} }],
  };
  assert.throws(() => detachCardNode(p, "c1", getCard), /is the content of this clip itself/);
});

test("When nothing is attached to this clip at all, say so clearly instead of silently doing nothing", () => {
  const p = chain();
  delete p.tracks[0].clips[0].nodeId;
  assert.throws(() => detachCardNode(p, "c1", getCard), /no media effect card attached/);
});

test("Dangling pointer (the node was deleted elsewhere): erase the pointer, do not block the user", () => {
  const p = chain();
  p.cardNodes = [];
  const r = detachCardNode(p, "c1", getCard);
  assert.equal(r.project.tracks[0].clips[0].nodeId, undefined);
  assert.equal(r.removed, false);
});

test("Does not modify the passed-in project in place", () => {
  const p = chain();
  const before = JSON.stringify(p);
  detachCardNode(p, "c1", getCard);
  assert.equal(JSON.stringify(p), before, "The store detects changes by object identity, so in-place edits would be invisible to sync");
});
