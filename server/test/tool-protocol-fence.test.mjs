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

test("没有围栏就原样放行", () => {
  const text = "我先确认视频素材，再根据内容添加字幕。";
  for (const n of [1, 3, 7, 1000]) assert.equal(feed(text, n), text);
});

test("围栏整段摘掉,前后的话都留着", () => {
  const text = `我先确认视频素材。\n\n${CALL}\n\n好了。`;
  const want = "我先确认视频素材。\n\n\n\n好了。";
  for (const n of [1, 2, 5, 13, 1000]) {
    assert.equal(feed(text, n), want, `分块大小 ${n} 时没摘干净`);
  }
});

test("逐字符喂也不会漏出 JSON 或反引号", () => {
  const seen = feed(`说一句。${CALL}`, 1);
  assert.ok(!seen.includes("list_media"), `漏出了工具名: ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes("`"), `漏出了反引号: ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes("promptcut-tool"), "漏出了围栏标记");
  assert.ok(seen.startsWith("说一句。"), "把正文也吞了");
});

test("连着几个围栏都摘掉", () => {
  const text = `一。${CALL}二。${CALL}三。`;
  assert.equal(feed(text, 4), "一。二。三。");
});

test("普通 ``` 代码块不受影响 —— 起始标记拼不出来就得放行", () => {
  const text = "看这段:\n```js\nconst a = 1;\n```\n就这样。";
  for (const n of [1, 3, 9, 1000]) assert.equal(feed(text, n), text);
});

test("只是提到 promptcut 两个字,不该被当成围栏", () => {
  const text = "promptcut-tool 这个名字是我们自己起的。";
  assert.equal(feed(text, 2), text);
});

test("围栏没收尾就整段丢掉,不把半截 JSON 甩给用户", () => {
  const seen = feed('说一句。```promptcut-tool\n{"name":"list_me', 3);
  assert.equal(seen, "说一句。");
});

test("扣住的半截标记如果最终没拼成围栏,要在 flush 时放出来", () => {
  const f = createFenceFilter();
  let out = f.push("结尾有个反引号 `");
  out += f.flush();
  assert.equal(out, "结尾有个反引号 `");
});

test("围栏之后的正文照常流出来", () => {
  const f = createFenceFilter();
  let out = f.push(CALL);
  out += f.push("工具跑完了，");
  out += f.push("接着说。");
  out += f.flush();
  assert.equal(out, "工具跑完了，接着说。");
});

/*
 * 端到端钉住这次的回归本身。
 *
 * 原来的 bug 不在过滤器,而在转发那一句:onEvent 里 text 分支累积完 collectedText
 * 之后**没有 return**,又落进 else 被原样转发出去。所以光测过滤器不够 —— 得真跑一遍
 * runTextProtocolLoop,确认界面收到的 text 事件里干干净净。
 */
import { runTextProtocolLoop } from "../harness/tool-protocol.mjs";

test("端到端:围栏和裸 JSON 不会流到界面上", async () => {
  // 故意在围栏标记中间断开,模拟流式分块
  const chunks = [
    "我先确认视频素材。\n\n``",
    '`promptcut-tool\n{"name":"li',
    'st_media","input":{}}\n```\n\n',
    "好了。",
  ];
  let round = 0;
  const startRun = ({ onEvent }) => {
    round += 1;
    const mine = round;
    const done = (async () => {
      if (mine === 1) for (const c of chunks) onEvent({ type: "text", delta: c });
      else onEvent({ type: "text", delta: "都排好了。" });
      onEvent({ type: "done" });
    })();
    return { abort() {}, done };
  };

  const seen = [];
  await runTextProtocolLoop({
    startRun,
    opts: {
      systemPrompt: "sys",
      prompt: "给视频加字幕",
      callTool: async () => ({ media: [] }),
    },
    onEvent: (ev) => seen.push(ev),
  }).done;

  const shown = seen.filter((e) => e.type === "text").map((e) => e.delta).join("");
  assert.ok(!shown.includes("promptcut-tool"), `围栏标记漏出来了: ${JSON.stringify(shown)}`);
  assert.ok(!shown.includes("list_media"), `工具名漏出来了: ${JSON.stringify(shown)}`);
  assert.ok(!shown.includes("```"), `反引号漏出来了: ${JSON.stringify(shown)}`);
  assert.ok(shown.includes("我先确认视频素材。"), "把正文吞了");
  assert.ok(shown.includes("好了。"), "围栏后面的正文丢了");

  // 工具本身仍然要被识别、被调用 —— 摘围栏不能把功能一起摘掉
  assert.ok(seen.some((e) => e.type === "tool_call" && e.name === "list_media"), "没有识别出工具调用");
});
