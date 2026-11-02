import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../mcp-tools.mjs';
import { validateProgressReport } from '../progress-report.mjs';

test('report_progress exists and is defined correctly', () => {
  const tool = tools.find(t => t.name === 'report_progress');
  assert.ok(tool, 'The tool should exist');
  assert.equal(tool.side, 'server');
  assert.equal(tool.timeoutMs, undefined, 'Should not have timeoutMs');
  
  const required = tool.inputSchema.required;
  assert.deepEqual([...required].sort(), ['final', 'has_done', 'has_todo', 'has_problem', 'done', 'todo', 'problems'].sort());

  const props = tool.inputSchema.properties;
  assert.ok(!required.includes('stage'), 'stage is not in required');
  
  for (const field of ['done', 'todo', 'problems']) {
    assert.equal(props[field].type, 'array', `${field} type is array`);
    assert.equal(props[field].items.type, 'string', `${field} items.type is string`);
  }

  for (const field of ['final', 'has_done', 'has_todo', 'has_problem']) {
    assert.equal(props[field].type, 'boolean', `${field} type is boolean`);
  }
});

test('validateProgressReport normal input', () => {
  const input = {
    final: false,
    stage: '测试',
    has_done: true,
    has_todo: false,
    has_problem: false,
    done: ['Did a few things'],
    todo: [],
    problems: []
  };
  const res = validateProgressReport(input);
  assert.equal(res.ok, true);
  assert.equal(res.value.stage, '测试');
  assert.equal(res.value.has_done, true);
});

test('validateProgressReport trim and empty-string handling', () => {
  const input = {
    final: false,
    stage: '   ',
    has_done: true,
    has_todo: false,
    has_problem: false,
    done: [' a ', '', '   '],
    todo: [],
    problems: []
  };
  const res = validateProgressReport(input);
  assert.equal(res.ok, true);
  assert.equal(res.value.stage, undefined, 'A stage of only spaces is ignored');
  assert.deepEqual(res.value.done, ['a'], 'Empty strings are ignored, spaces are trimmed');
  assert.equal(res.value.has_done, true);

  const input2 = {
    final: false,
    has_done: true,
    has_todo: false,
    has_problem: false,
    done: ['', '   '],
    todo: [],
    problems: []
  };
  const res2 = validateProgressReport(input2);
  assert.equal(res2.ok, true);
  assert.equal(res2.value.has_done, false, 'All empty strings are corrected to false');
});

test('validateProgressReport missing fields', () => {
  // has_* are redundant fields and not rejected if missing; missing arrays count as empty arrays
  const res = validateProgressReport({ final: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { final: true, has_done: false, has_todo: false, has_problem: false, done: [], todo: [], problems: [] });

  // Function calls often set optional fields to null: treat as not provided
  const res2 = validateProgressReport({ final: null, stage: null, done: ['Added captions'], todo: null, problems: null });
  assert.equal(res2.ok, true);
  assert.equal(res2.value.final, false);
  assert.equal(res2.value.stage, undefined);
  assert.deepEqual(res2.value.done, ['Added captions']);
  assert.equal(res2.value.has_done, true);

  // Nothing provided: not a report
  const res3 = validateProgressReport({ has_done: false, has_todo: false, has_problem: false });
  assert.equal(res3.ok, false);
  assert.match(res3.error, /The report is empty/);

  const res4 = validateProgressReport({ final: false, done: 'a' });
  assert.equal(res4.ok, false);
  assert.match(res4.error, /Field done must be an array of strings.*got string/);
});

test('validateProgressReport wrong type', () => {
  const res = validateProgressReport({
    final: 'yes',
    has_done: true,
    has_todo: true,
    has_problem: false,
    done: [],
    todo: [],
    problems: []
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /must be a boolean.*got string/);

  const res2 = validateProgressReport(null);
  assert.equal(res2.ok, false);
  assert.match(res2.error, /Arguments must be an object/);
});

test('validateProgressReport wrong array element type', () => {
  const input = {
    final: true,
    has_done: true,
    has_todo: false,
    has_problem: false,
    done: ['ok', 123],
    todo: [],
    problems: []
  };
  const res = validateProgressReport(input);
  assert.equal(res.ok, false);
  assert.match(res.error, /Item 2 of field done must be a string.*number/);
});

test('validateProgressReport truncation of over-long entries and of more than 8 entries', () => {
  const longStr = 'a'.repeat(100);
  const input = {
    final: true,
    has_done: true,
    has_todo: false,
    has_problem: false,
    done: Array(10).fill(longStr),
    todo: [],
    problems: []
  };
  const res = validateProgressReport(input);
  assert.equal(res.ok, true);
  assert.equal(res.value.done.length, 8, 'More than 8 entries should be truncated');
  assert.equal(res.value.done[0].length, 60, 'Over-long entries should be truncated to 60 characters');
});

test('validateProgressReport inconsistent boolean and array are corrected', () => {
  const input = {
    final: true,
    has_done: false, // Should be true because done has content
    has_todo: true,  // Should be false because todo is empty
    has_problem: false,
    done: ['Did something'],
    todo: [],
    problems: []
  };
  const res = validateProgressReport(input);
  assert.equal(res.ok, true);
  assert.equal(res.value.has_done, true, 'Corrected to true');
  assert.equal(res.value.has_todo, false, 'Corrected to false');
});

/*
 * blocked: stop and wait for user reply (user decision, 2026-10-24, origin in
 * docs/plan/agent-blind-stop.md).
 * Without this bit, "stopped upon hitting round limit" and "waiting for your reply" look the same
 * in the UI, and the user cannot tell whose court the ball is in.
 */
test('blocked: the new field is not in required, and old calls are accepted as usual without any change', () => {
  const tool = tools.find(t => t.name === 'report_progress');
  assert.equal(tool.inputSchema.properties.blocked.type, 'boolean');
  assert.equal(tool.inputSchema.required.includes('blocked'), false, 'Old drivers that leave it out must still be accepted as usual');
  assert.match(tool.description, /blocked/);
  assert.match(tool.description, /waiting for your reply/);
});

test('blocked:true implies final; with false or the default, this flag does not appear', () => {
  const base = { has_done: false, has_todo: true, has_problem: false, done: [], todo: ['Please scan the QR code in the window to log in'], problems: [] };
  const on = validateProgressReport({ ...base, blocked: true });
  assert.equal(on.ok, true);
  assert.equal(on.value.blocked, true);
  assert.equal(on.value.final, true, 'A missing final is also treated as a wrap-up, and the report is not rejected for that');
  assert.equal(validateProgressReport({ ...base, final: false, blocked: true }).value.final, true);

  for (const input of [{ ...base, final: true }, { ...base, final: true, blocked: false }, { ...base, final: true, blocked: null }]) {
    const res = validateProgressReport(input);
    assert.equal(res.ok, true);
    assert.equal('blocked' in res.value, false, JSON.stringify(input));
  }
});

test('blocked: reject it if it is not a boolean, and make the error say clearly what was received', () => {
  const res = validateProgressReport({ final: true, blocked: 'yes', done: ['a'], todo: [], problems: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /blocked/);
  assert.match(res.error, /string/);
});
