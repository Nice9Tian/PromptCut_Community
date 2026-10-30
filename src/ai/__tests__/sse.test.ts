// 运行: npx tsx --tsconfig tsconfig.app.json src/ai/__tests__/sse.test.ts
// 必须带 --tsconfig tsconfig.app.json,否则 tsx 读不到 jsx 的 react-jsx 设置,会报 React is not defined
// @ts-ignore
import assert from "node:assert";
import { parseSseChunks } from "../sse";

function test() {
  // Test 1: Complete block in one chunk
  const { events: ev1, rest: rest1 } = parseSseChunks("", "data: {\"type\":\"run\"}\n\n");
  assert.deepStrictEqual(ev1, [{ type: "run" }]);
  assert.strictEqual(rest1, "");

  // Test 2: Incomplete block, spans across chunks
  const { events: ev2, rest: rest2 } = parseSseChunks("", "data: {\"type\":\"text\"");
  assert.deepStrictEqual(ev2, []);
  assert.strictEqual(rest2, "data: {\"type\":\"text\"");

  const { events: ev3, rest: rest3 } = parseSseChunks(rest2, ",\"delta\":\"hello\"}\n\n");
  assert.deepStrictEqual(ev3, [{ type: "text", delta: "hello" }]);
  assert.strictEqual(rest3, "");

  // Test 3: Multiple events in one chunk
  const multiChunk = "data: {\"a\":1}\n\ndata: {\"b\":2}\n\n";
  const { events: ev4, rest: rest4 } = parseSseChunks("", multiChunk);
  assert.deepStrictEqual(ev4, [{ a: 1 }, { b: 2 }]);
  assert.strictEqual(rest4, "");

  // Test 4: Comment line ignored
  const withComment = ": ping\ndata: {\"ok\":true}\n\n: ping again\n";
  const { events: ev5, rest: rest5 } = parseSseChunks("", withComment);
  assert.deepStrictEqual(ev5, [{ ok: true }]);
  assert.strictEqual(rest5, ": ping again\n");

  // Test 5: A single chunk with comment + two complete events + a half event at the end
  const complexChunk = ": ping\ndata: {\"ev\":1}\n\ndata: {\"ev\":2}\n\ndata: {\"half\":";
  const { events: ev6, rest: rest6 } = parseSseChunks("", complexChunk);
  assert.deepStrictEqual(ev6, [{ ev: 1 }, { ev: 2 }]);
  assert.strictEqual(rest6, "data: {\"half\":");

  console.log("sse.test.ts passed");
}

test();
