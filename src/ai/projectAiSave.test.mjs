/**
 * 项目文件里存的对话取本项目第一个会话的(2026-10-22:分页清单按项目分开后,新会话各有自己的 store)。
 * 跑:node --test src/ai/projectAiSave.test.mjs。用例 PA-1:没有会话存空;第一个会话的对话存进去;打开带对话的项目文件补成「Agent 1」。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };

const tabs = await import(srcUrl("ai/agentTabs.ts"));
const chat = await import(srcUrl("ai/liveChat.ts"));
const ai = await import(srcUrl("ai/projectAi.ts"));

test("PA-1 The first session's chat is saved with the project file; with no session, empty is saved; opening a project file that contains chat backfills it as Agent 1", () => {
  tabs.setAgentProject("pA");
  assert.deepEqual(ai.collectProjectAi().messages, []);
  assert.equal(ai.hasProjectAi(), false);
  const first = tabs.commitDraft(tabs.getActiveTabId());
  chat.getChatStore(first.id).replace([{ id: "m1", role: "user", text: "Hello" }, { id: "m2", role: "assistant", text: "OK", pending: true }]);
  assert.deepEqual(ai.collectProjectAi().messages.map((m) => m.id), ["m1"], "Messages that have not finished running are not saved");
  assert.equal(ai.hasProjectAi(), true);
  // 打开另一个带对话的项目文件:对话灌进来,新项目补一个页接住
  ai.applyProjectAi({ script: "", messages: [{ id: "x1", role: "user", text: "Old chat" }] });
  tabs.setAgentProject("pB");
  assert.deepEqual(tabs.getTabs().map((t) => [t.id, t.title]), [["pB_main", "Agent 1"]]);
  assert.deepEqual(ai.collectProjectAi().messages.map((m) => m.id), ["x1"]);
});
