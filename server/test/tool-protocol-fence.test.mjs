// Under the text protocol, tool calls are written in the response body, which streams to the UI
// character by character.
// The fence must be stripped mid-stream, otherwise the user sees raw JSON and an empty dark code
// block in the chat box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFenceFilter } from "../harness/tool-protocol.mjs";

/** Chunk the full text by given size and feed it in; return the body text the user ultimately sees */
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
 * Pin down this regression itself end-to-end.
 *
 * The original bug was not in the filter, but in that forwarding line: in onEvent, after the text
 * branch accumulated collectedText, there was **no return**, so it fell into else and was forwarded
 * as-is. So testing only the filter is not enough: runTextProtocolLoop must actually be run to
 * confirm that the text events received by the UI are completely clean.
 */
import { runTextProtocolLoop } from "../harness/tool-protocol.mjs";

test("End-to-end: fences and bare JSON do not stream into the UI", async () => {
  // Intentionally split inside fence markers to simulate streaming chunks
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

  // The tool itself must still be recognized and invoked: stripping fences must not strip functionality
  assert.ok(seen.some((e) => e.type === "tool_call" && e.name === "list_media"), "No tool call was recognized");
});
