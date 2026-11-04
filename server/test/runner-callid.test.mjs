/**
 * Tool calls on both codex and agy paths also carry callId (fixes C6.5 leftover: originally these
 * two paths could not obtain it and could only revert in Agent operation records).
 *
 * How to run: **must include this flag** (mock child_process):
 *   node --experimental-test-module-mocks --test server/test/runner-callid.test.mjs
 *
 * Fixtures are output streams and MCP requests recorded live on this machine on 2026-09-27
 * (codex-cli 0.156.1, agy 1.2.11; see original in docs/archive/agent-reports/AGENT-runner-callid.md;
 * contains no credentials, user directories replaced with placeholders):
 *   - codex `_meta` carries threadId (= thread_id of thread.started in output stream) and its own
 *     callId (not in output stream); output stream tool item ids are item_0, item_1: can only pair
 *     by (thread, tool name, arguments);
 *   - agy `_meta` carries conversation_id and progressToken "<uuid>:<step_number>", step number =
 *     step_index in output stream.
 * Coverage: two arrival orders, parallel with same name and same arguments (no pairing, fall back
 * to original behavior), sequential with same name and same arguments (pair their respective ones),
 * degradation on pairing failure.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as realChildProcess from 'node:child_process';

/** Mock CLI process: the test writes lines to its stdout itself, deciding when each line arrives */
let lastChild = null;
mock.module('node:child_process', { exports: { ...realChildProcess, spawn: (cmd, args, opts) => {
  if (cmd === 'taskkill') { const k = new EventEmitter(); return k; }
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.pid = 0;
  child.stdin = new Writable({ write(_c, _e, done) { done(); } });
  child.feed = (obj) => child.stdout.write(JSON.stringify(obj) + '\n');
  child.end = () => new Promise((r) => setTimeout(() => { child.emit('close', 0); r(); }, 5));
  lastChild = child;
  return child;
} } });

const { createCallPairing, argsKey } = await import('../agent/call-pairing.mjs');
const codex = await import('../runners/codex.mjs');
const agy = await import('../runners/agy.mjs');

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Fixtures (recorded live)

const CODEX_THREAD = '01a0e00b-4a61-7e70-af46-a8cf5a166523';
/**
 * Output stream of codex exec --json (live recorded, two serial get_answer; tool name replaced
 * with get_clip, arguments as-is)
 */
const codexStream = (tool = 'get_clip') => [
  { type: 'thread.started', thread_id: CODEX_THREAD },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_0', type: 'mcp_tool_call', server: 'promptcut', tool, arguments: { key: 'alpha' }, result: null, error: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_0', type: 'mcp_tool_call', server: 'promptcut', tool, arguments: { key: 'alpha' }, result: { content: [{ type: 'text', text: 'answer for alpha is 42' }], structured_content: null }, error: null, status: 'completed' } },
  { type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'promptcut', tool, arguments: { key: 'beta' }, result: null, error: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'promptcut', tool, arguments: { key: 'beta' }, result: { content: [{ type: 'text', text: 'answer for beta is 42' }], structured_content: null }, error: null, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'alpha: 42\nbeta: 42' } },
  { type: 'turn.completed', usage: { input_tokens: 29129, cached_input_tokens: 26752, output_tokens: 83 } },
];
/** _meta sent by codex to MCP tools/call (live recorded) */
const codexMeta = {
  callId: 'exec-ba81ac03-fea9-48f1-85a9-4ec13937f9f9',
  'x-codex-turn-metadata': { session_id: CODEX_THREAD, thread_id: CODEX_THREAD, reasoning_effort: 'low', turn_id: '01a0e00b-4a9a-7c10-8644-674679b27b6e', model: 'gpt-6-astra', thread_source: 'user', turn_trigger: 'exec', sandbox: 'none', sandbox_mode: 'read-only', codex_version: '0.156.1' },
  threadId: CODEX_THREAD, sessionId: CODEX_THREAD, windowId: `${CODEX_THREAD}:0`,
  itemId: 'ctc_0caa429e5666034f016ab854d340e887d08ba42bd7148af1b0', progressToken: 1,
};

const AGY_CONV = '5b290f32-0511-401d-8e85-30ceb9cbd662';
/** Output stream of agy --output-format stream-json (live recorded, built-in tool manifest in init removed) */
const agyStream = [
  { event: 'init', conversation_id: AGY_CONV, init: { model: 'gemini-3.8-flash', permission_mode: 'request-review' } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { clip_id: 'c1', id: 'c1' }, ServerName: 'promptcut', ToolName: 'get_clip' } } } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', duration_seconds: 0.27, tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { clip_id: 'c1', id: 'c1' }, ServerName: 'promptcut', ToolName: 'get_clip' }, output: 'clip c1 has length 42' } } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { clip_id: 'c2', id: 'c2' }, ServerName: 'promptcut', ToolName: 'get_clip' } } } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', duration_seconds: 2.44, tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { clip_id: 'c2', id: 'c2' }, ServerName: 'promptcut', ToolName: 'get_clip' }, output: 'clip c2 has length 42' } } },
  { event: 'step_update', step_update: { conversation_id: AGY_CONV, step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'c1: 42, c2: 42' } },
  { event: 'result', result: { conversation_id: AGY_CONV, status: 'SUCCESS', response: 'c1: 42, c2: 42', num_turns: 1 } },
];
/** _meta sent by agy to MCP tools/call (live recorded; user directory in artifacts_dir replaced with placeholder) */
const agyMeta = (step) => ({
  'antigravity.google/artifacts_dir': `C:\\Users\\<user>\\.gemini\\antigravity-cli\\brain\\${AGY_CONV}`,
  'antigravity.google/conversation_id': AGY_CONV,
  progressToken: `29d2aeee-8ff2-4280-9aec-237872d543e5:${step}`,
});

// ---------------------------------------------------------------- Pairing itself

test('Pairing: check-in then claim or claim then check-in, both get the same callId that the runner sent to the page', async () => {
  const p = createCallPairing({ waitMs: 500 });
  p.open('codex:t');
  p.announce('codex:t', 'add_clip', { a: 1, b: [1, { y: 2, x: 1 }] }, 'cx-1');
  // Recognized even when key order differs
  assert.equal(await p.claim('codex:t', 'add_clip', { b: [1, { x: 1, y: 2 }], a: 1 }), 'cx-1');
  const waiting = p.claim('codex:t', 'add_clip', { a: 2 });
  await tick();
  p.announce('codex:t', 'add_clip', { a: 2 }, 'cx-2');
  assert.equal(await waiting, 'cx-2');
});

test('Pairing: same name and same arguments in parallel, cannot tell which is which, so neither side is paired (falls back to the old behavior), and no wrong pairing is allowed', async () => {
  const p = createCallPairing({ waitMs: 300 });
  p.open('codex:t');
  // Check-in first: neither of the two identical keys has been claimed yet
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-1');
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-2');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), undefined);
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), undefined);
  // Claim first: two claimers waiting for the same key
  const q = createCallPairing({ waitMs: 300 });
  q.open('codex:u');
  const w1 = q.claim('codex:u', 'add_clip', { a: 1 });
  const w2 = q.claim('codex:u', 'add_clip', { a: 1 });
  await tick();
  q.announce('codex:u', 'add_clip', { a: 1 }, 'cx-3');
  assert.deepEqual(await Promise.all([w1, w2]), [undefined, undefined]);
  assert.equal(q.stats().waiters, 0);
});

test('Pairing: same name and same arguments in sequence (the next call only comes after the previous one is settled), each pairs with its own', async () => {
  const p = createCallPairing({ waitMs: 300 });
  p.open('codex:t');
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-1');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), 'cx-1');
  p.settle('cx-1');
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-2');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), 'cx-2');
  p.settle('cx-2');
  assert.equal(p.stats().entries, 0);
});

test('Degradation on pairing failure: mismatched arguments, mismatched scope, nobody checked in, check-in already settled; all return undefined', async () => {
  const p = createCallPairing({ waitMs: 60, unknownWaitMs: 20 });
  p.open('codex:t');
  p.announce('codex:t', 'add_clip', { a: 1 }, 'cx-1');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 2 }), undefined, 'Arguments do not match');
  assert.equal(await p.claim('codex:t', 'remove_clip', { a: 1 }), undefined, 'Tool names do not match');
  assert.equal(await p.claim('codex:other', 'add_clip', { a: 1 }), undefined, 'Scopes do not match');
  p.settle('cx-1');
  assert.equal(await p.claim('codex:t', 'add_clip', { a: 1 }), undefined, 'A settled check-in can no longer be claimed');
  const t0 = Date.now();
  assert.equal(await p.claim('codex:nobody', 'get_project', {}), undefined);
  assert.ok(Date.now() - t0 < 200, 'Wait only briefly when the scope is unknown');
  assert.equal(await p.claim(undefined, 'get_project', {}), undefined);
  assert.equal(p.stats().waiters, 0);
});

test('Pairing: the agy hint (chat + step number) matches only that one entry; a matching hint with mismatched arguments does not pair', async () => {
  const p = createCallPairing({ waitMs: 60 });
  p.open(`agy:${AGY_CONV}`);
  // Two steps with the same name and arguments are both pending; still distinguished with hint
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c1' }, `agy:${AGY_CONV}:2`);
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c1' }, `agy:${AGY_CONV}:3`);
  assert.equal(await p.claim(`agy:${AGY_CONV}`, 'get_clip', { id: 'c1' }, `agy:${AGY_CONV}:3`), `agy:${AGY_CONV}:3`);
  assert.equal(await p.claim(`agy:${AGY_CONV}`, 'get_clip', { id: 'c1' }, `agy:${AGY_CONV}:2`), `agy:${AGY_CONV}:2`);
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c9' }, `agy:${AGY_CONV}:7`);
  assert.equal(await p.claim(`agy:${AGY_CONV}`, 'get_clip', { id: 'zz' }, `agy:${AGY_CONV}:7`), undefined);
  // The hinted step has not checked in yet: wait for it; check-ins from other steps do not preempt
  const w = p.claim(`agy:${AGY_CONV}`, 'get_clip', { id: 'c5' }, `agy:${AGY_CONV}:9`);
  await tick();
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c5' }, `agy:${AGY_CONV}:8`);
  p.announce(`agy:${AGY_CONV}`, 'get_clip', { id: 'c5' }, `agy:${AGY_CONV}:9`);
  assert.equal(await w, `agy:${AGY_CONV}:9`);
});

test('argsKey: key order does not matter, different values are different', () => {
  assert.equal(argsKey({ b: 1, a: { d: 1, c: 2 } }), argsKey({ a: { c: 2, d: 1 }, b: 1 }));
  assert.notEqual(argsKey({ a: 1 }), argsKey({ a: '1' }));
  assert.equal(argsKey(undefined), argsKey({}));
});

// ---------------------------------------------------------------- runner using live-recorded output stream

async function startCodex(pairing) {
  const events = [];
  const run = codex.startRun({ provider: 'codex', cwd: 'C:\\tmp', systemPrompt: 's', prompt: 'p', onEvent: (e) => events.push(e), callPairing: pairing });
  await tick();
  return { run, events, child: lastChild };
}

test('codex: recorded output stream: tool_call / tool_result carry the same callId, and the MCP side can claim it whether it arrives first or later', async () => {
  const pairing = createCallPairing({ waitMs: 500, unknownWaitMs: 500 });
  const { run, events, child } = await startCodex(pairing);
  const [started, turn, s0, c0, s1, c1, msg, done] = codexStream();
  const scope = `codex:${CODEX_THREAD}`;
  child.feed(started); child.feed(turn);
  await tick();
  // First time: MCP arrives first (that line in output stream has not arrived yet)
  const claim0 = pairing.claim(scope, 'get_clip', { key: 'alpha' });
  await tick();
  child.feed(s0);
  const id0 = await claim0;
  child.feed(c0);
  // Second time: output stream arrives first
  child.feed(s1);
  await tick();
  const id1 = await pairing.claim(scope, 'get_clip', { key: 'beta' });
  child.feed(c1); child.feed(msg); child.feed(done);
  await child.end();
  await run.done;

  const calls = events.filter((e) => e.type === 'tool_call');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.equal(calls.length, 2);
  assert.match(calls[0].callId, /^cx-[a-z0-9]+-item_0$/);
  assert.match(calls[1].callId, /^cx-[a-z0-9]+-item_1$/);
  assert.equal(id0, calls[0].callId, 'MCP arrives first: waits for the check-in, then claims');
  assert.equal(id1, calls[1].callId, 'Output stream arrives first: claim directly');
  assert.deepEqual(results.map((r) => r.callId), calls.map((c) => c.callId), 'The result carries the same callId, and the page stamps by it');
  assert.deepEqual(pairing.stats(), { entries: 0, waiters: 0, scopes: 0 }, 'Everything is cleared when the run ends');
});

test('codex: same name and same arguments in parallel (both items start before either ends): neither is paired, and the events still carry their own callIds', async () => {
  const pairing = createCallPairing({ waitMs: 200 });
  const { run, events, child } = await startCodex(pairing);
  const [started, turn, s0, c0] = codexStream('add_clip');
  const same = (o, id) => ({ ...o, item: { ...o.item, id, arguments: { key: 'same' } } });
  const scope = `codex:${CODEX_THREAD}`;
  child.feed(started); child.feed(turn);
  child.feed(same(s0, 'item_0')); child.feed(same(s0, 'item_1'));
  await tick();
  const got = await Promise.all([pairing.claim(scope, 'add_clip', { key: 'same' }), pairing.claim(scope, 'add_clip', { key: 'same' })]);
  assert.deepEqual(got, [undefined, undefined], 'Not paired when they cannot be told apart, falling back to the old behavior: undo is only possible in the Agent action log');
  child.feed(same(c0, 'item_0')); child.feed(same(c0, 'item_1'));
  await child.end();
  await run.done;
  const calls = events.filter((e) => e.type === 'tool_call');
  assert.equal(new Set(calls.map((c) => c.callId)).size, 2, 'On the page side the two entries each have their own id, so results are not stamped on the wrong row');
});

test('codex: without an editor attached (no callPairing given) it runs as usual, and the events still carry callId', async () => {
  const { run, events, child } = await startCodex(undefined);
  for (const l of codexStream()) child.feed(l);
  await child.end();
  await run.done;
  assert.equal(events.filter((e) => e.type === 'tool_call' && e.callId).length, 2);
  assert.ok(events.some((e) => e.type === 'done'));
});

test('agy: recorded output stream: callId is agy:<chat>:<step number>, matches the hint assembled from _meta, and can be claimed', async () => {
  const pairing = createCallPairing({ waitMs: 500 });
  const events = [];
  const run = agy.startRun({ provider: 'agy', cwd: 'C:\\tmp', systemPrompt: 's', prompt: 'p', onEvent: (e) => events.push(e), callPairing: pairing });
  await tick();
  const child = lastChild;
  const scope = `agy:${AGY_CONV}`;
  const hintOf = (meta) => `agy:${meta['antigravity.google/conversation_id']}:${Number(/:(\d+)$/.exec(meta.progressToken)[1])}`;
  const [init, user, a2, d2, a3, d3, text, result] = agyStream;
  child.feed(init); child.feed(user);
  await tick();
  // Step 2: MCP arrives first
  const claim2 = pairing.claim(scope, 'get_clip', { clip_id: 'c1', id: 'c1' }, hintOf(agyMeta(2)));
  await tick();
  child.feed(a2);
  const id2 = await claim2;
  child.feed(d2);
  // Step 3: output stream arrives first
  child.feed(a3);
  await tick();
  const id3 = await pairing.claim(scope, 'get_clip', { clip_id: 'c2', id: 'c2' }, hintOf(agyMeta(3)));
  child.feed(d3); child.feed(text); child.feed(result);
  await child.end();
  await run.done;

  const calls = events.filter((e) => e.type === 'tool_call');
  assert.deepEqual(calls.map((c) => c.callId), [`agy:${AGY_CONV}:2`, `agy:${AGY_CONV}:3`]);
  assert.equal(id2, calls[0].callId);
  assert.equal(id3, calls[1].callId);
  assert.deepEqual(events.filter((e) => e.type === 'tool_result').map((r) => r.callId), calls.map((c) => c.callId));
  assert.deepEqual(pairing.stats(), { entries: 0, waiters: 0, scopes: 0 });
});

// ---------------------------------------------------------------- mcp-server forwards clues in _meta to editor

test('mcp-server: codex _meta becomes pair.scope, agy _meta becomes scope + hint; Claude toolUseId is unchanged, without pair', async () => {
  const bodies = [];
  const bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/mcp/call') bodies.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { ok: true } }));
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  const port = bridge.address().port;
  // Launch mcp-server with real spawn (the mock above is for runner; here obtain from original module)
  const child = realChildProcess.spawn(process.execPath, [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url))], { env: { ...process.env, PROMPTCUT_PORT: String(port), PROMPTCUT_AGENT: 'conv-x' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  const call = async (id, name, args, meta) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }) + '\n');
    const t0 = Date.now();
    while (!buf.split('\n').some((l) => l.includes(`"id":${id}`))) {
      if (Date.now() - t0 > 10000) throw new Error(`No reply for id ${id} received within 10 s`);
      await tick(20);
    }
  };
  try {
    await call(21, 'get_clip', { key: 'alpha' }, codexMeta);
    await call(22, 'get_clip', { clip_id: 'c1', id: 'c1' }, agyMeta(2));
    await call(23, 'get_clip', { id: 'c1' }, { 'claudecode/toolUseId': 'toolu_01XYZ', progressToken: 3 });
    await call(24, 'get_clip', { id: 'c1' }, { progressToken: 'weird' });
    await call(25, 'get_clip', { id: 'c1' }, { 'antigravity.google/conversation_id': AGY_CONV, progressToken: 7 });
    const got = bodies.filter((b) => b.tool === 'get_clip');
    if (got.length !== 5) console.error(buf);
    assert.equal(got.length, 5);
    assert.deepEqual(got[0].pair, { scope: `codex:${CODEX_THREAD}` });
    assert.equal('callId' in got[0], false, 'codex\'s own _meta.callId is not in the output stream, so it cannot be used as the callId');
    assert.deepEqual(got[1].pair, { scope: `agy:${AGY_CONV}`, hint: `agy:${AGY_CONV}:2` });
    assert.equal(got[2].callId, 'toolu_01XYZ');
    assert.equal('pair' in got[2], false);
    assert.equal('pair' in got[3], false, 'If the vendor cannot be identified, omit it');
    assert.deepEqual(got[4].pair, { scope: `agy:${AGY_CONV}` }, 'If progressToken is not "<uuid>:<step number>", give no hint');
    assert.equal(got[0].agent, 'conv-x');
  } finally {
    child.kill();
    bridge.close();
    bridge.closeAllConnections?.();
  }
});
