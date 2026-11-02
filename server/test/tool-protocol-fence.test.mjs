// 文本协议下,工具调用是写在回复正文里的,而正文一个字一个字流给界面。
// 围栏必须在流的途中就摘掉,否则用户会在聊天框里看到裸 JSON 和一条空的深色代码块。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFenceFilter } from "../harness/tool-protocol.mjs";

/** 把整段文本按给定大小切块喂进去,返回用户最终看到的正文 */
function feed(text, chunkSize) {
  const f = createFenceFilter();
  let out = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    out += f.push(text.slice(i, i + chunkSize));
  }
  return out + f.flush();
}

const CALL = '```promptcut-tool\n{"name":"list_media","input":{}}\n```';

test("Without a fence it passes through unchanged", () => {
  const text = "First I will check the video media, then add captions based on its content.";
  for (const n of [1, 3, 7, 1000]) assert.equal(feed(text, n), text);
});

test("The whole fence is stripped, and the text before and after it stays", () => {
  const text = `First I will check the video media.\n\n${CALL}\n\nDone.`;
  const want = "First I will check the video media.\n\n\n\nDone.";
  for (const n of [1, 2, 5, 13, 1000]) {
    assert.equal(feed(text, n), want, `Not stripped cleanly at chunk size ${n}`);
  }
});

test("Feeding one character at a time does not leak JSON or backticks either", () => {
  const seen = feed(`Say something.${CALL}`, 1);
  assert.ok(!seen.includes("list_media"), `Leaked the tool name: ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes("`"), `Leaked backticks: ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes("promptcut-tool"), "Leaked the fence marker");
  assert.ok(seen.startsWith("Say something."), "Swallowed the body text as well");
});

test("Several fences in a row are all stripped", () => {
  const text = `One.${CALL}Two.${CALL}Three.`;
  assert.equal(feed(text, 4), "One.Two.Three.");
});

test("An ordinary ``` code block is unaffected: if the start marker cannot be assembled, it must pass through", () => {
  const text = "Look at this:\n```js\nconst a = 1;\n```\nThat is all.";
  for (const n of [1, 3, 9, 1000]) assert.equal(feed(text, n), text);
});

test("Merely mentioning the word promptcut must not be treated as a fence", () => {
  const text = "We came up with the name promptcut-tool ourselves.";
  assert.equal(feed(text, 2), text);
});

test("A fence that never closes is dropped entirely, rather than dumping partial JSON on the user", () => {
  const seen = feed('Say something.```promptcut-tool\n{"name":"list_me', 3);
  assert.equal(seen, "Say something.");
});

test("A held-back partial marker that never ends up forming a fence must be released on flush", () => {
  const f = createFenceFilter();
  let out = f.push("Ends with a backtick `");
  out += f.flush();
  assert.equal(out, "Ends with a backtick `");
});

test("Text after the fence flows out as usual", () => {
  const f = createFenceFilter();
  let out = f.push(CALL);
  out += f.push("The tool finished running,");
  out += f.push("continuing.");
  out += f.flush();
  assert.equal(out, "The tool finished running,continuing.");
});

/*
 * 端到端钉住这次的回归本身。
 *
 * 原来的 bug 不在过滤器,而在转发那一句:onEvent 里 text 分支累积完 collectedText
 * 之后**没有 return**,又落进 else 被原样转发出去。所以光测过滤器不够 —— 得真跑一遍
 * runTextProtocolLoop,确认界面收到的 text 事件里干干净净。
 */
import { runTextProtocolLoop } from "../harness/tool-protocol.mjs";

test("End-to-end: fences and bare JSON do not stream into the UI", async () => {
  // 故意在围栏标记中间断开,模拟流式分块
  const chunks = [
    "First I will check the video media.\n\n``",
    '`promptcut-tool\n{"name":"li',
    'st_media","input":{}}\n```\n\n',
    "Done.",
  ];
  let round = 0;
  const startRun = ({ onEvent }) => {
    round += 1;
    const mine = round;
    const done = (async () => {
      if (mine === 1) for (const c of chunks) onEvent({ type: "text", delta: c });
      else onEvent({ type: "text", delta: "Everything is arranged." });
      onEvent({ type: "done" });
    })();
    return { abort() {}, done };
  };

  const seen = [];
  await runTextProtocolLoop({
    startRun,
    opts: {
      systemPrompt: "sys",
      prompt: "Add captions to the video",
      callTool: async () => ({ media: [] }),
    },
    onEvent: (ev) => seen.push(ev),
  }).done;

  const shown = seen.filter((e) => e.type === "text").map((e) => e.delta).join("");
  assert.ok(!shown.includes("promptcut-tool"), `The fence marker leaked out: ${JSON.stringify(shown)}`);
  assert.ok(!shown.includes("list_media"), `The tool name leaked out: ${JSON.stringify(shown)}`);
  assert.ok(!shown.includes("```"), `Backticks leaked out: ${JSON.stringify(shown)}`);
  assert.ok(shown.includes("First I will check the video media."), "Swallowed the body text");
  assert.ok(shown.includes("Done."), "The text after the fence was lost");

  // 工具本身仍然要被识别、被调用 —— 摘围栏不能把功能一起摘掉
  assert.ok(seen.some((e) => e.type === "tool_call" && e.name === "list_media"), "No tool call was recognized");
});
