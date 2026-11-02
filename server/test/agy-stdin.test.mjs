/**
 * Prompts on the agy path must go through stdin and cannot be stuffed into the command line.
 *
 * How to run: **must include this flag**:
 *   node --experimental-test-module-mocks --test server/test/agy-stdin.test.mjs
 *
 * Pins down a real incident: originally it was `-p <entire prompt>`. The single command-line
 * limit on Windows is 32767 characters; the system prompt itself at just over 15,000 could hold up,
 * but once stacked with the text protocol tool manifest (33,000) it reached 49,000, directly
 * triggering spawn ENAMETOOLONG: meaning the fallback path of "native tools rejected -> retry using
 * text protocol" had never succeeded and blew up upon entry. claude.mjs / codex.mjs have long used
 * stdin; agy was the sole exception.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as realChildProcess from 'node:child_process';
import { useFakeCliHome } from './fake-cli-home.mjs';

// claude / agy resolve to fake .exe in temp directory, so asserting spawn args is unaffected by local install (npm shims, etc.)
const fakeCli = useFakeCliHome();
after(() => fakeCli.dispose());

/** Hard limit for a single Windows command line (including exe path and all arguments) */
const WINDOWS_CMDLINE_LIMIT = 32767;

let spawned;
// Only swap spawn and pass through the rest as-is: replacing the whole module would cause other
// modules in the same graph (runners/auth.mjs needs execFile) to fail at import due to missing exports
mock.module('node:child_process', { exports: { ...realChildProcess, spawn: (exe, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  let stdin = '';
  child.stdin = new Writable({ write(chunk, _enc, done) { stdin += chunk.toString(); done(); } });
  child.stdin.on('finish', () => {
    spawned.stdin = stdin;
    // Return a minimal result so runner finishes normally
    child.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Got it' } }) + '\n');
    queueMicrotask(() => child.emit('close', 0));
  });
  spawned = { exe, args, stdin: '' };
  return child;
} } });

const { startRun } = await import('../runners/agy.mjs');

/** Run one round and return the spawn arguments and what was written to stdin this time */
async function run(opts) {
  spawned = null;
  const events = [];
  const r = startRun({
    provider: 'agy', cwd: 'C:\\tmp', onEvent: (e) => events.push(e),
    systemPrompt: 's', prompt: 'p', ...opts,
  });
  await r.done;
  return { ...spawned, events };
}

test('The prompt goes into stdin, not the command line', async () => {
  const big = 'x'.repeat(49000);
  const { args, stdin } = await run({ systemPrompt: big, prompt: 'Do something' });

  assert.ok(!args.some((a) => a.includes(big)), 'The prompt should not appear in any command-line argument');
  assert.ok(!args.includes('-p'), 'No longer pass the prompt with -p (--input-format stream-json is itself print mode)');
  assert.ok(args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json');

  assert.ok(stdin.includes(big), 'The whole prompt should be written into stdin');
  assert.ok(stdin.includes('Do something'));
});

test('Command-line length is independent of the prompt: however large the prompt is, it cannot blow past 32767', async () => {
  const len = (args) => args.join(' ').length;
  const small = await run({ systemPrompt: 's'.repeat(100) });
  const huge = await run({ systemPrompt: 's'.repeat(200000) });
  assert.equal(len(small.args), len(huge.args), 'Prompt size should not affect command-line length');
  assert.ok(len(huge.args) < WINDOWS_CMDLINE_LIMIT / 10, `The command line holds only flags, so it should be far below the limit, actual ${len(huge.args)}`);
});

test('stdin is the kind of NDJSON that agy accepts: it rejects input missing event or message', async () => {
  const { stdin } = await run({ systemPrompt: 'System', prompt: 'User' });
  const lines = stdin.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'One round, one message');
  const msg = JSON.parse(lines[0]);
  // Names of these two fields were tested against the real CLI; mistyping either causes agy to error immediately
  assert.equal(msg.event, 'user');
  assert.equal(msg.message.role, 'user');
  assert.match(msg.message.content, /System[\s\S]*User/);
});

test('Model / reasoning tier / session id still go on the command line and were not moved along with it', async () => {
  const { args } = await run({ model: 'gemini-3.8-flash', effort: 'low', sessionId: 'abc' });
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args[args.indexOf('--conversation') + 1], 'abc');
});

/*
 * Names written with tiers (gemini-3.8-flash-low) must pair with --effort; if they mismatch, agy
 * rejects the whole round outright.
 * The panel has been split into "base name + tier", but paths like background tasks and split-work
 * mode do not go through the panel, and earlier names with suffixes might still be in session
 * history: this is the last line of defense.
 */
test('A model name with a tier suffix: strip it down to the base name and use the suffix as the tier, so the pair is guaranteed to be valid', async () => {
  const { args } = await run({ model: 'gemini-3.8-flash-low', effort: 'high' });
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(args[args.indexOf('--effort') + 1], 'low', 'The tier in the name wins, and a mismatched high must not be sent');
});

test('Suffix present but no tier given: fill one in anyway, otherwise agy says requires --effort', async () => {
  const { args } = await run({ model: 'gemini-3.1-pro-high', effort: '' });
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.1-pro');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
});

test('A model name without a tier suffix is passed as is, and no tier is forced onto it', async () => {
  const { args } = await run({ model: 'claude-sonnet-4-6', effort: '' });
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6');
  assert.ok(!args.includes('--effort'), 'claude-sonnet-4-6 does not accept --effort, and passing it gets rejected');
});
