/**
 * node --test server/test/wait-tool.test.mjs
 *
 * `wait` tool. The reason for its existence is explained in that description in mcp-tools.mjs:
 * a dozen tools tell the model to "ask again every few seconds", but before this the model had
 * no way to wait and could only borrow the shell to sleep, while unattended agy automatically
 * rejects run_command, ruining the entire round once rejected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tools } = await import('../mcp-tools.mjs');

const wait = tools.find((t) => t.name === 'wait');

test('The tool manifest has wait, and it is marked as server-side execution (not through the browser bridge)', () => {
  assert.ok(wait, 'The wait tool is not in the manifest');
  assert.equal(wait.side, 'server');
  assert.equal(wait.inputSchema.properties.seconds.type, 'number');
  assert.ok(!wait.inputSchema.required, 'seconds should be optional, defaulting to 3 seconds when omitted');
});

test('The description explicitly discourages "finding your own way to sleep": that is exactly the path that wrecks the whole round', () => {
  assert.match(wait.description, /shell/, 'It must name shell so the model knows which path is meant');
  assert.match(wait.description, /reject|interrupt/, 'The consequences must be spelled out, otherwise it will not take it seriously');
});

test('Tools that make the caller poll must point to wait in their description', () => {
  const dl = tools.find((t) => t.name === 'collect_download');
  assert.ok(dl, 'collect_download is not in the manifest');
  assert.match(dl.description, /wait/, 'collect_download makes the caller ask every 3 seconds, so it must say what to wait with');
});

/*
 * The server-side execution logic currently lives in callToolInternal in vite-plugin-ai.ts (it
 * needs the SKILL gate and tool table; moving it out carries a higher cost). Here the same logic
 * is duplicated to verify the behavioral contract: clamp range, default values, illegal inputs.
 * When modifying that side, these two tests will remind you to sync.
 */
function waitSeconds(args) {
  const raw = args?.seconds;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(30, Math.max(1, raw)) : 3;
}

test('Seconds: default 3, clamped to 1~30', () => {
  assert.equal(waitSeconds(undefined), 3);
  assert.equal(waitSeconds({}), 3);
  assert.equal(waitSeconds({ seconds: 5 }), 5);
  assert.equal(waitSeconds({ seconds: 0 }), 1, '0 seconds is the same as not waiting, raised to 1');
  assert.equal(waitSeconds({ seconds: -10 }), 1);
  assert.equal(waitSeconds({ seconds: 9999 }), 30, 'Do not let it sleep forever');
});

test('Seconds: garbage input must not turn into NaN and sleep forever', () => {
  assert.equal(waitSeconds({ seconds: 'abc' }), 3);
  assert.equal(waitSeconds({ seconds: null }), 3);
  assert.equal(waitSeconds({ seconds: {} }), 3);
});
