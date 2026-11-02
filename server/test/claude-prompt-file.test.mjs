/**
 * The system prompt for the claude path must go through a file and cannot be stuffed into
 * the command line.
 *
 * How to run: **must include this flag**:
 *   node --experimental-test-module-mocks --test server/test/claude-prompt-file.test.mjs
 *
 * Pins down a real incident (diagnostic report chat-diagnostic-20260910-204342): originally it was
 * `--append-system-prompt <full-text>`. Once native tools were rejected, it retried via text
 * protocol; appending the tool manifest into the system prompt reached 48,000 characters, exceeding
 * the Windows single command-line limit of 32767 and triggering `spawn ENAMETOOLONG` on the spot.
 * See agy-stdin.test.mjs for the same pitfall on the agy side.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as realChildProcess from 'node:child_process';
import { useFakeCliHome } from './fake-cli-home.mjs';

// claude / agy resolve to fake .exe in temp directory, so asserting spawn args is unaffected by local install (npm shims, etc.)
const fakeCli = useFakeCliHome();
after(() => fakeCli.dispose());

const WINDOWS_CMDLINE_LIMIT = 32767;

let spawned;
/** Lines emitted to stdout by the mock CLI on each spawn */
let script = [];
/** Extra fields included in the mock CLI finalization result (e.g. permission_denials) */
let resultExtra = {};
let spawnCount = 0;
mock.module('node:child_process', { exports: { ...realChildProcess, spawn: (exe, args) => {
  spawnCount++;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const i = args.indexOf('--append-system-prompt-file');
  // The file must already exist when the CLI starts, with the system prompt as its content
  const promptFile = i >= 0 ? args[i + 1] : null;
  spawned = { exe, args, promptFile, promptText: promptFile && fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : null };
  child.stdin = new Writable({ write(_c, _e, done) { done(); } });
  child.stdin.on('finish', () => {
    for (const line of script) child.stdout.write(JSON.stringify(line) + '\n');
    child.stdout.write(JSON.stringify({ type: 'result', session_id: 's1', usage: {}, ...resultExtra }) + '\n');
    queueMicrotask(() => child.emit('close', 0));
  });
  return child;
} } });

const { startRun } = await import('../runners/claude.mjs');

async function run(opts = {}) {
  spawned = null;
  spawnCount = 0;
  const events = [];
  const r = startRun({ provider: 'claude', cwd: 'C:\\tmp', onEvent: (e) => events.push(e), systemPrompt: 's', prompt: 'p', ...opts });
  await r.done;
  return { ...spawned, events, spawnCount };
}

/*
 * Built-in tools (Read / Grep / Bash / Write / Skill) are always rejected here anyway; this
 * cannot be taken as "native tool channel broken". Previously, any rejection triggered a text
 * protocol retry: after the full round finished and the reply was ready, it swallowed done and
 * reran from scratch: #7, #13, and #15 in diagnostic report chat-diagnostic-20260910-234339 all
 * threw errors at the final step this way.
 */
test('Only the built-in tools were denied: finish normally, no rerun', async () => {
  script = [];
  resultExtra = { permission_denials: [
    { tool_name: 'Grep', tool_use_id: 't1', tool_input: {} },
    { tool_name: 'Skill', tool_use_id: 't2', tool_input: {} },
  ] };
  try {
    const { events, spawnCount } = await run();
    assert.equal(spawnCount, 1);
    assert.ok(!events.some((e) => e.type === 'status' && /text protocol/.test(e.text)));
    assert.equal(events.filter((e) => e.type === 'done').length, 1);
  } finally { resultExtra = {}; }
});

test('PromptCut\'s own tools were denied: retry via the text protocol', async () => {
  script = [];
  resultExtra = { permission_denials: [{ tool_name: 'mcp__promptcut__get_project', tool_use_id: 't1', tool_input: {} }] };
  try {
    const { events, spawnCount } = await run();
    assert.equal(spawnCount, 2);
    assert.ok(events.some((e) => e.type === 'status' && /retrying with text protocol/.test(e.text)));
    assert.equal(events.filter((e) => e.type === 'done').length, 1, 'The first round\'s done is swallowed, only the retry round\'s remains');
  } finally { resultExtra = {}; }
});

test('The system prompt goes into a file, not the command line; command line length is independent of prompt size', async () => {
  script = [];
  const big = 'x'.repeat(49000);
  const { args, promptText } = await run({ systemPrompt: big });
  assert.ok(!args.includes('--append-system-prompt'), 'Must no longer use the flag that stuffs the whole text into an argument');
  assert.ok(!args.some((a) => a.includes(big)), 'The prompt must not appear in any command line argument');
  assert.ok(promptText && promptText.includes(big), 'When the CLI starts, the file must already hold the whole system prompt');
  assert.ok(args.join(' ').length < WINDOWS_CMDLINE_LIMIT / 2, 'The command line holds only flags and the tool allowlist');
});

test('The system prompt is followed by a mapping table for the built-in tools', async () => {
  script = [];
  const { promptText } = await run({ systemPrompt: 'Main prompt' });
  assert.match(promptText, /^Main prompt/);
  assert.match(promptText, /built-in tools/);
  assert.match(promptText, /cardUrl/);
  assert.match(promptText, /collect_search/);
});

test('Delete the temp file after the run', async () => {
  script = [];
  const { promptFile } = await run();
  assert.ok(promptFile);
  assert.ok(!fs.existsSync(promptFile), `The temp file should have been deleted: ${promptFile}`);
});

/*
 * When calling tools with the same name in parallel, results must be matched back by
 * tool_use_id. Previously without callId, the UI matched by name, completely misaligning
 * four parallel see_frames results (diagnostic report lines 7939-7979: the call passing A
 * had D's result attached underneath).
 */
test('tool_call / tool_result carry callId', async () => {
  script = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tu_1', name: 'mcp__promptcut__see_frames', input: { mediaId: 'a' } },
      { type: 'tool_use', id: 'tu_2', name: 'mcp__promptcut__see_frames', input: { mediaId: 'b' } },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'B\'s result' },
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'A\'s result' },
    ] } },
  ];
  const { events } = await run();
  const calls = events.filter((e) => e.type === 'tool_call');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(calls.map((c) => c.callId), ['tu_1', 'tu_2']);
  assert.deepEqual(results.map((r) => [r.callId, r.summary]), [['tu_2', 'B\'s result'], ['tu_1', 'A\'s result']]);
});
