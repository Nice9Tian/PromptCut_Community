/**
 * 打开旧 `.proc` 时把 Python 卡丢掉的那条纯逻辑(H6)。
 * 跑:node --experimental-test-module-mocks --test src/editor/io/proc.test.mjs
 *
 * 钉死:`cardDefinitions` 整个字段没了、`adapter: 'python'` 的节点没了、
 * 引用它们的片段清掉 `nodeId`(素材段变回普通素材段)、别的节点和片段一个字不动、
 * 以及数出来的张数就是通知栏那句话里的 N。
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

test("cardDefinitions 整个字段删掉,不是只删 python 条目", () => {
  const raw = legacy();
  dropPythonNodes(raw);
  assert.equal("cardDefinitions" in raw, false);
});

test("丢掉 adapter python 的节点,并清掉引用它们的片段 nodeId", () => {
  const raw = legacy();
  const dropped = dropPythonNodes(raw);
  assert.equal(dropped, 2);
  assert.deepEqual(raw.cardNodes.map((n) => n.id), ["chrome-a"]);
  const clips = raw.tracks[0].clips;
  // 素材段回到普通素材段:mediaId 还在,nodeId 没了
  assert.equal("nodeId" in clips[0], false);
  assert.equal(clips[0].mediaId, "m1");
  // 纯 python 片段:既没节点也没 cardId,由 flattenOverlay 跳过
  assert.equal("nodeId" in clips[1], false);
  assert.equal(clips[1].cardId, undefined);
  // 别人的节点一个字不动
  assert.equal(clips[2].nodeId, "chrome-a");
  assert.equal(clips[2].cardId, "punch-pill");
});

test("没有 python 卡的项目一张都不丢,cardDefinitions 照样不留", () => {
  const raw = { cardNodes: [{ id: "chrome-a", adapter: "chrome" }], tracks: [{ id: "main", clips: [{ id: "a", mediaId: "m" }] }] };
  assert.equal(dropPythonNodes(raw), 0);
  assert.deepEqual(raw.cardNodes.map((n) => n.id), ["chrome-a"]);
  assert.equal(raw.tracks[0].clips[0].mediaId, "m");
});

test("空的 / 不是对象的输入不报错", () => {
  assert.equal(dropPythonNodes(null), 0);
  assert.equal(dropPythonNodes(undefined), 0);
  assert.equal(dropPythonNodes("not a project"), 0);
  assert.equal(dropPythonNodes({}), 0);
});

test("通知栏只说一次,句子里的 N 就是丢掉的张数", () => {
  takePythonDrops();
  const raw = legacy();
  publishPythonDrop(dropPythonNodes(raw));
  const n = takePythonDrops();
  assert.equal(n, 2);
  assert.equal(pythonDropMessage(n), "2 张 Python 卡已停用，不再显示");
  // 取走之后就空了 —— 同一次加载不会提示第二遍
  assert.equal(takePythonDrops(), 0);
});
