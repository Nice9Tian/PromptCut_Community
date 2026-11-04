/**
 * node --test src/ai/aiSessionKeys.test.mjs
 *
 * When switching projects / creating a new project, **the backend session id must also be cleared**.
 *
 * From a user diagnostic report: in a brand-new project, the chat in the UI was empty and the
 * media library was also empty, yet the first-round request sent 19 messages (stage:"request",
 * messages:19 in trace), and the model immediately spoke the name of the video from the previous
 * project: it did not call list_media once, and that name was read from the previous history.
 *
 * Reason: what was cleared was only the visible chat, whereas what determines what the model sees
 * is aiSession:<provider> in localStorage, which the server uses to read back the entire history.
 * The UI and backend are disconnected in their understanding of "which chat this is": and this
 * disconnect has no UI symptoms, so it can only be guarded by tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { resetAiSessionIds, AI_SESSION_PREFIX } = await import("./aiSessionKeys.ts");

/** A sufficient localStorage stand-in */
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

test("Clear all aiSession:*, and do not touch any other preference", () => {
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

test("Keys of multi-Agent tabs carry a tabId suffix and must be cleared too", () => {
  const s = store({ "aiSession:api": "a", "aiSession:api:t-2": "b", "aiSession:codex:t-9": "c" });
  resetAiSessionIds(s);
  assert.deepEqual(s.keys(), [], "None of the suffixed ones may remain");
});

test("Does nothing when there is no session id to begin with", () => {
  const s = store({ aiProvider: "api" });
  resetAiSessionIds(s);
  assert.deepEqual(s.keys(), ["aiProvider"]);
});

test("When storage is unavailable, \"Open project\" must not break", () => {
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

test("The prefix is a publicly exported constant: other places that need to identify such keys should use the same one", () => {
  assert.equal(AI_SESSION_PREFIX, "aiSession:");
});
