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
  invert: { id: "invert", name: "反色", card: () => {}, defaults: { amount: 1 } },
  blur: { id: "blur", name: "模糊", card: () => {}, defaults: { sigma: 4 } },
  xfade: { id: "xfade", name: "交叉溶解", kind: "transition", card: () => {}, defaults: {} },
  intro: { id: "intro", name: "片头", card: () => {}, defaults: {} },
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

test("摘掉链尾那一张:片段接到上一张,它自己从库里删掉", () => {
  const r = detachCardNode(chain(), "c1", getCard);
  const clip = r.project.tracks[0].clips[0];
  assert.equal(clip.nodeId, "n-inv", "下游要接到上游,不然反色也跟着没了");
  assert.equal(clip.cardId, "invert");
  assert.deepEqual(clip.params, { amount: 1 });
  assert.deepEqual(r.project.cardNodes.map((n) => n.id), ["n-inv"]);
  assert.equal(r.removed, true);
});

test("再摘一张:片段回到普通素材段,cardId 和参数都回到没挂过的样子", () => {
  const once = detachCardNode(chain(), "c1", getCard);
  const twice = detachCardNode(once.project, "c1", getCard);
  const clip = twice.project.tracks[0].clips[0];
  assert.equal(clip.nodeId, undefined);
  assert.equal(clip.cardId, undefined);
  assert.deepEqual(clip.params, {});
  assert.equal(clip.mediaId, "m1", "素材不能跟着没了");
  assert.deepEqual(twice.project.cardNodes, []);
});

test("卡片段的底座是真节点,摘掉上面那张之后片段还是那张卡", () => {
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
  assert.equal(clip.cardId, "intro", "回到它自己那张卡,不是变成空片段");
});

test("别人还引用着它就不从库里删,只是这一段不再用它", () => {
  const p = chain();
  p.tracks[0].clips.push({ id: "c2", mediaId: "m1", start: 5, end: 8, cardId: "invert", nodeId: "n-other", params: {} });
  p.cardNodes.push({ id: "n-other", adapter: "card", cardId: "invert", kind: "filter", params: {}, inputs: { source: { nodeId: "n-blur" } } });
  const r = detachCardNode(p, "c1", getCard);
  assert.equal(r.removed, false);
  assert.equal(r.project.cardNodes.some((n) => n.id === "n-blur"), true, "它还在喂 c2,删了那一段就瞎了");
  assert.equal(r.project.tracks[0].clips[0].nodeId, "n-inv");
});

test("转场那种两路输入的摘不了,话里写明为什么", () => {
  const p = chain();
  p.cardNodes[1] = { id: "n-blur", adapter: "card", cardId: "xfade", kind: "transition", params: {}, inputs: { A: { nodeId: "n-inv" }, B: { nodeId: "@clip/c1/source" } } };
  p.tracks[0].clips[0].cardId = "xfade";
  assert.throws(() => detachCardNode(p, "c1", getCard), /不止一路输入.*A、B/s);
});

test("无输入的卡摘不了:它本身就是这一段的内容", () => {
  const p = {
    id: "p", width: 1920, height: 1080, fps: 30, duration: 5, media: [],
    tracks: [{ id: "t1", clips: [{ id: "c1", start: 0, end: 5, cardId: "intro", nodeId: "n-intro", params: {} }] }],
    cardNodes: [{ id: "n-intro", adapter: "card", cardId: "intro", kind: "animation", params: {}, inputs: {} }],
  };
  assert.throws(() => detachCardNode(p, "c1", getCard), /本身就是这一段的内容/);
});

test("这一段根本没挂时说清楚,不是默默什么都不做", () => {
  const p = chain();
  delete p.tracks[0].clips[0].nodeId;
  assert.throws(() => detachCardNode(p, "c1", getCard), /没有挂素材效果卡/);
});

test("指针悬空(节点被别处删了):擦掉指针,不拦着用户", () => {
  const p = chain();
  p.cardNodes = [];
  const r = detachCardNode(p, "c1", getCard);
  assert.equal(r.project.tracks[0].clips[0].nodeId, undefined);
  assert.equal(r.removed, false);
});

test("不原地改传进来的项目", () => {
  const p = chain();
  const before = JSON.stringify(p);
  detachCardNode(p, "c1", getCard);
  assert.equal(JSON.stringify(p), before, "store 靠对象身份判断改动,原地改会让同步看不见");
});
