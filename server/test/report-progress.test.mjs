import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../mcp-tools.mjs';
import { validateProgressReport } from '../progress-report.mjs';

test('report_progress 存在且定义正确', () => {
  const tool = tools.find(t => t.name === 'report_progress');
  assert.ok(tool, '工具应存在');
  assert.equal(tool.side, 'server');
  assert.equal(tool.timeoutMs, undefined, '不应有 timeoutMs');
  
  const required = tool.inputSchema.required;
  assert.deepEqual([...required].sort(), ['final', 'has_done', 'has_todo', 'has_problem', 'done', 'todo', 'problems'].sort());

  const props = tool.inputSchema.properties;
  assert.ok(!required.includes('stage'), 'stage 不在 required 里');
  
  for (const field of ['done', 'todo', 'problems']) {
    assert.equal(props[field].type, 'array', `${field} type is array`);
    assert.equal(props[field].items.type, 'string', `${field} items.type is string`);
  }

  for (const field of ['final', 'has_done', 'has_todo', 'has_problem']) {
    assert.equal(props[field].type, 'boolean', `${field} type is boolean`);
  }
});

test('validateProgressReport 正常输入', () => {
  const input = {
    final: false,
    stage: '测试',
    has_done: true,
    has_todo: false,
    has_problem: false,
    done: ['做了一些事'],
    todo: [],
    problems: []
  };
  const res = validateProgressReport(input);
  assert.equal(res.ok, true);
  assert.equal(res.value.stage, '测试');
  assert.equal(res.value.has_done, true);
});

test('validateProgressReport trim 与空串处理', () => {
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
  assert.equal(res.value.stage, undefined, '全空格 stage 被忽略');
  assert.deepEqual(res.value.done, ['a'], '空串被忽略，空格被 trim');
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
  assert.equal(res2.value.has_done, false, '全是空串被纠正为 false');
});

test('validateProgressReport 缺字段', () => {
  // has_* 是冗余字段,缺了不拒;数组缺了算空组
  const res = validateProgressReport({ final: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { final: true, has_done: false, has_todo: false, has_problem: false, done: [], todo: [], problems: [] });

  // 函数调用常把可选字段填成 null:按没给处理
  const res2 = validateProgressReport({ final: null, stage: null, done: ['加了字幕'], todo: null, problems: null });
  assert.equal(res2.ok, true);
  assert.equal(res2.value.final, false);
  assert.equal(res2.value.stage, undefined);
  assert.deepEqual(res2.value.done, ['加了字幕']);
  assert.equal(res2.value.has_done, true);

  // 什么都没给:不是一份报告
  const res3 = validateProgressReport({ has_done: false, has_todo: false, has_problem: false });
  assert.equal(res3.ok, false);
  assert.match(res3.error, /报告是空的/);

  const res4 = validateProgressReport({ final: false, done: 'a' });
  assert.equal(res4.ok, false);
  assert.match(res4.error, /字段 done 应该是字符串数组.*收到的是 string/);
});

test('validateProgressReport 类型错', () => {
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
  assert.match(res.error, /应该是布尔值.*收到的是 string/);

  const res2 = validateProgressReport(null);
  assert.equal(res2.ok, false);
  assert.match(res2.error, /参数应为对象/);
});

test('validateProgressReport 数组元素类型错', () => {
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
  assert.match(res.error, /字段 done 的第 2 条应为字符串.*number/);
});

test('validateProgressReport 超长截断与超 8 条截断', () => {
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
  assert.equal(res.value.done.length, 8, '超 8 条应截断');
  assert.equal(res.value.done[0].length, 60, '超长应截断到 60 字');
});

test('validateProgressReport 布尔与数组不一致被纠正', () => {
  const input = {
    final: true,
    has_done: false, // 应该是 true，因为 done 有内容
    has_todo: true,  // 应该是 false，因为 todo 为空
    has_problem: false,
    done: ['做事'],
    todo: [],
    problems: []
  };
  const res = validateProgressReport(input);
  assert.equal(res.ok, true);
  assert.equal(res.value.has_done, true, '被修正为 true');
  assert.equal(res.value.has_todo, false, '被修正为 false');
});

/*
 * blocked:停下来等用户回话(2026-10-24 用户定,起因见 docs/plan/agent-blind-stop.md)。
 * 没有这一位的时候,界面上「撞上轮次上限停了」和「在等你回话」长得一样,用户分不出球在谁那边。
 */
test('blocked:新字段不进 required,老调用一个字不改照常收', () => {
  const tool = tools.find(t => t.name === 'report_progress');
  assert.equal(tool.inputSchema.properties.blocked.type, 'boolean');
  assert.equal(tool.inputSchema.required.includes('blocked'), false, '老驱动不填也得照常收');
  assert.match(tool.description, /blocked/);
  assert.match(tool.description, /等你回话/);
});

test('blocked:true 隐含 final;false 与缺省时这一位不出现', () => {
  const base = { has_done: false, has_todo: true, has_problem: false, done: [], todo: ['请在窗口里扫码登录'], problems: [] };
  const on = validateProgressReport({ ...base, blocked: true });
  assert.equal(on.ok, true);
  assert.equal(on.value.blocked, true);
  assert.equal(on.value.final, true, 'final 漏填也按收尾算,不为这个拒收');
  assert.equal(validateProgressReport({ ...base, final: false, blocked: true }).value.final, true);

  for (const input of [{ ...base, final: true }, { ...base, final: true, blocked: false }, { ...base, final: true, blocked: null }]) {
    const res = validateProgressReport(input);
    assert.equal(res.ok, true);
    assert.equal('blocked' in res.value, false, JSON.stringify(input));
  }
});

test('blocked:不是布尔就拒收,报错说清收到的是什么', () => {
  const res = validateProgressReport({ final: true, blocked: 'yes', done: ['a'], todo: [], problems: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /blocked/);
  assert.match(res.error, /string/);
});
