/**
 * node --test server/test/codex-tool-errors.test.mjs
 *
 * Two things when a tool fails on the codex path: **the reason must be explainable**, **denial must
 * be recognizable**.
 *
 * From a user diagnostic report: the summary of three tool calls was literally `[object Object]`.
 * The reason is `String(item.error)`: codex error is an object. The consequence is not just being
 * ugly:
 *   1. Neither the user nor logs can see the real reason;
 *   2. The model only receives this blob, so it starts guessing, producing guidance that the user
 *      cannot possibly follow like "Current session forbids approval, please switch permission mode"
 *      (approval_policy="never" is hardcoded by ourselves in the launch arguments);
 *   3. More subtly, the check for "whether denied" was written as `typeof err === 'string' && ...`,
 *      which never holds for objects: thus onPermissionDenied does not trigger, and the fallback
 *      available in both claude / agy to "retry with text protocol after denial" is dead for codex.
 *
 * Directly test those two pure functions here (imported from the module without spawning processes
 * or touching the CLI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * errText / resultSummary / looksDenied are module-internal functions and not exported (exporting
 * them just for testing would expand the module's public surface). Here those three functions are
 * extracted from the source code and imported separately: it still tests the exact same code,
 * without changing a single character during extraction.
 */
const src = fs.readFileSync(new URL('../runners/codex.mjs', import.meta.url), 'utf8');
const picked = ['errText', 'resultSummary', 'looksDenied'].map((name) => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `codex.mjs should contain function ${name}(`);
  // Slice from the function header all the way to its closing `}` line (all three functions close
  // flush-left)
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, `Could not find the end of the body of ${name}`);
  return src.slice(at, end + 2);
}).join('\n\n');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-codex-err-')), 'picked.mjs');
fs.writeFileSync(tmp, picked + '\nexport { errText, resultSummary, looksDenied };\n');
const { errText, resultSummary, looksDenied } = await import(pathToFileURL(tmp).href);

test('errText: object errors must no longer turn into [object Object]', () => {
  for (const err of [
    { message: 'Refused' },
    { error: { message: 'Refused' } },
    { code: 'x', message: 'Refused' },
    { detail: 'Refused' },
    { reason: 'Refused' },
  ]) {
    const t = errText(err);
    assert.ok(!t.includes('[object Object]'), `${JSON.stringify(err)} → ${t}`);
    assert.ok(t.includes('Refused'), `${JSON.stringify(err)} → ${t}`);
  }
});

test('errText: when there is a code, report it too. A sentence alone is not enough to locate the problem', () => {
  assert.equal(errText({ code: 'approval_denied', message: 'Approval required' }), 'Approval required(approval_denied)');
});

test('errText: an object of unrecognizable shape must still yield content, not the type name', () => {
  const t = errText({ weird: 1, nested: { a: 2 } });
  assert.ok(!t.includes('[object Object]'));
  assert.ok(t.includes('weird'), `Should fall back to JSON, got ${t}`);
});

test('errText: strings pass through as is, empty values give an empty string', () => {
  assert.equal(errText('boom'), 'boom');
  assert.equal(errText(null), '');
  assert.equal(errText(undefined), '');
});

test('resultSummary: on success, look at result', () => {
  assert.equal(resultSummary({ result: { items: [1, 2] } }), '{"items":[1,2]}');
});

test('resultSummary: on failure the error must be included. It used to be an empty string here', () => {
  assert.equal(resultSummary({ error: { message: 'Rejected' } }), 'Rejected');
  assert.equal(resultSummary({ error: 'plain' }), 'plain');
  assert.ok(!resultSummary({ error: { message: 'x' } }).includes('[object Object]'));
});

test('resultSummary: truncate to 300 characters, do not stuff the whole blob into the UI', () => {
  assert.equal(resultSummary({ error: 'x'.repeat(1000) }).length, 300);
});

test('looksDenied: object-shaped denials are recognized too. When this does not hold, the text protocol fallback is dead', () => {
  assert.equal(looksDenied({ message: 'tool call denied by approval policy' }), true);
  assert.equal(looksDenied({ error: { message: 'not approved' } }), true);
  assert.equal(looksDenied({ code: 'permission_error', message: 'Permission required' }), true);
  assert.equal(looksDenied('request was rejected'), true);
});

test('looksDenied: other errors must not be misjudged as denied. Otherwise a text protocol retry would be wasted', () => {
  assert.equal(looksDenied({ message: 'connection reset' }), false);
  assert.equal(looksDenied({ message: 'model overloaded' }), false);
  assert.equal(looksDenied(null), false);
  assert.equal(looksDenied(''), false);
});
