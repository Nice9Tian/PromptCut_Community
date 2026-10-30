/**
 * node --test src/ai/aiSessionKeys.test.mjs
 *
 * 换项目 / 新建项目时,**后端的会话 id 也必须清掉**。
 *
 * 来自一份用户诊断报告:全新项目、界面上对话空的、素材库也空的,而第一轮请求就发出去
 * 19 条消息(trace 里 stage:"request", messages:19),模型张口就说出上一个项目里
 * 那条视频的名字 —— 它一次 list_media 都没调,那个名字是从上一段历史里读到的。
 *
 * 原因:清的只是看得见的那段对话,而决定模型看到什么的是 localStorage 里的
 * aiSession:<provider>,服务端拿它去读回整段历史。界面和后端对「这是哪段对话」
 * 的认知是脱节的 —— 而这种脱节没有任何界面症状,只能靠测试守住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { resetAiSessionIds, AI_SESSION_PREFIX } = await import("./aiSessionKeys.ts");

/** 一份够用的 localStorage 替身 */
function store(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

test("aiSession:* 全部清掉,别的偏好一个都不许动", () => {
  const s = store({
    "aiSession:api": "api-9433c3ac",
    "aiSession:claude": "c-123",
    aiProvider: "api",
    aiShowThinking: "1",
    aiViewMode: "simple",
  });
  resetAiSessionIds(s);
  assert.deepEqual(s.keys().sort(), ["aiProvider", "aiShowThinking", "aiViewMode"]);
});

test("多 Agent 分页的键带 tabId 后缀,也要一起清", () => {
  const s = store({ "aiSession:api": "a", "aiSession:api:t-2": "b", "aiSession:codex:t-9": "c" });
  resetAiSessionIds(s);
  assert.deepEqual(s.keys(), [], "带后缀的一个都不能留");
});

test("本来就没有会话 id 时什么也不做", () => {
  const s = store({ aiProvider: "api" });
  resetAiSessionIds(s);
  assert.deepEqual(s.keys(), ["aiProvider"]);
});

test("storage 用不了的时候不许把「打开项目」搞挂", () => {
  const boom = {
    get length() { throw new Error("storage disabled"); },
    key: () => { throw new Error("storage disabled"); },
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
    removeItem: () => { throw new Error("storage disabled"); },
  };
  assert.doesNotThrow(() => resetAiSessionIds(boom));
  assert.doesNotThrow(() => resetAiSessionIds(undefined));
});

test("前缀是对外公开的常量 —— 别处要判断这类键时用同一个", () => {
  assert.equal(AI_SESSION_PREFIX, "aiSession:");
});
