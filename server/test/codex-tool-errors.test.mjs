/**
 * node --test server/test/codex-tool-errors.test.mjs
 *
 * codex 那条路上工具失败时的两件事:**原因要说得出来**,**被拒要认得出来**。
 *
 * 来自一份用户诊断报告:三次工具调用的 summary 全是字面的 `[object Object]`。
 * 原因是 `String(item.error)` —— codex 的 error 是对象。后果不只是难看:
 *   1. 用户和日志都看不到真实原因;
 *   2. 模型只拿到这一坨,于是开始猜,猜出「当前会话禁止审批,请切换权限模式」这种
 *      用户根本做不到的指引(approval_policy="never" 是我们自己写死在启动参数里的);
 *   3. 更隐蔽的是,判定「是否被拒」写的是 `typeof err === 'string' && ...`,
 *      对象一律不成立 —— 于是 onPermissionDenied 不触发,claude / agy 都有的
 *      「被拒之后改用文本协议重试」那条兜底,对 codex 是死的。
 *
 * 这里直接测那两个纯函数(从模块里取,不起进程、不碰 CLI)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * errText / resultSummary / looksDenied 是模块内部函数,没有导出(导出它们只为测试,
 * 会让模块的公开面变大)。这里把源码里那三个函数抽出来单独 import —— 测的还是同一份代码,
 * 抽的时候不改一个字。
 */
const src = fs.readFileSync(new URL('../runners/codex.mjs', import.meta.url), 'utf8');
const picked = ['errText', 'resultSummary', 'looksDenied'].map((name) => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `codex.mjs 里应该有 function ${name}(`);
  // 从函数头一路截到它那一行 `}` 为止(这三个函数都顶格闭合)
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, `${name} 的函数体没找到结尾`);
  return src.slice(at, end + 2);
}).join('\n\n');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-codex-err-')), 'picked.mjs');
fs.writeFileSync(tmp, picked + '\nexport { errText, resultSummary, looksDenied };\n');
const { errText, resultSummary, looksDenied } = await import(pathToFileURL(tmp).href);

test('errText:对象错误不能再变成 [object Object]', () => {
  for (const err of [
    { message: '拒绝了' },
    { error: { message: '拒绝了' } },
    { code: 'x', message: '拒绝了' },
    { detail: '拒绝了' },
    { reason: '拒绝了' },
  ]) {
    const t = errText(err);
    assert.ok(!t.includes('[object Object]'), `${JSON.stringify(err)} → ${t}`);
    assert.ok(t.includes('拒绝了'), `${JSON.stringify(err)} → ${t}`);
  }
});

test('errText:带 code 时一起报出来 —— 光有一句话不够定位', () => {
  assert.equal(errText({ code: 'approval_denied', message: '需要审批' }), '需要审批(approval_denied)');
});

test('errText:摸不出形状的对象也要给出内容,不是类型名', () => {
  const t = errText({ weird: 1, nested: { a: 2 } });
  assert.ok(!t.includes('[object Object]'));
  assert.ok(t.includes('weird'), `应该退回 JSON,实际 ${t}`);
});

test('errText:字符串原样、空值给空串', () => {
  assert.equal(errText('boom'), 'boom');
  assert.equal(errText(null), '');
  assert.equal(errText(undefined), '');
});

test('resultSummary:成功看 result', () => {
  assert.equal(resultSummary({ result: { items: [1, 2] } }), '{"items":[1,2]}');
});

test('resultSummary:失败一定要把 error 带出来 —— 原来这里是空串', () => {
  assert.equal(resultSummary({ error: { message: '被拒' } }), '被拒');
  assert.equal(resultSummary({ error: 'plain' }), 'plain');
  assert.ok(!resultSummary({ error: { message: 'x' } }).includes('[object Object]'));
});

test('resultSummary:截到 300 字,别把整坨塞进界面', () => {
  assert.equal(resultSummary({ error: 'x'.repeat(1000) }).length, 300);
});

test('looksDenied:对象形状的拒绝也认得出来 —— 这条不成立时文本协议兜底是死的', () => {
  assert.equal(looksDenied({ message: 'tool call denied by approval policy' }), true);
  assert.equal(looksDenied({ error: { message: 'not approved' } }), true);
  assert.equal(looksDenied({ code: 'permission_error', message: '需要权限' }), true);
  assert.equal(looksDenied('request was rejected'), true);
});

test('looksDenied:别的错误不能误判成被拒 —— 否则会白走一次文本协议重试', () => {
  assert.equal(looksDenied({ message: 'connection reset' }), false);
  assert.equal(looksDenied({ message: 'model overloaded' }), false);
  assert.equal(looksDenied(null), false);
  assert.equal(looksDenied(''), false);
});
