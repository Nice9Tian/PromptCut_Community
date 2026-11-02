/**
 * The chat saved in the project file is taken from this project's first session (2026-10-22: after
 * tab manifests were split per project, new sessions each have their own store).
 * Run: node --test src/ai/projectAiSave.test.mjs. Case PA-1: save empty when there are no sessions;
 * save the first session's chat; opening a project file with chat supplements it as "Agent 1".
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
  // Open another project file with chat: chat is poured in, and the new project adds a tab to catch it
  ai.applyProjectAi({ script: "", messages: [{ id: "x1", role: "user", text: "Old chat" }] });
  tabs.setAgentProject("pB");
  assert.deepEqual(tabs.getTabs().map((t) => [t.id, t.title]), [["pB_main", "Agent 1"]]);
  assert.deepEqual(ai.collectProjectAi().messages.map((m) => m.id), ["x1"]);
});
