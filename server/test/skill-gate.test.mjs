/**
 * SKILL 闸门(server/skill-gate.mjs)的单测。计划 docs/plan/agent-workflow-plan.md A4 把它改成**按调用方类型拦**:
 * 登记过的桌面 APP 会话(`desktop`)在 SKILL 模式关着时什么都不做,AI 栏的 Agent(`api` / `cli`)不受它管,
 * 没报身份的调用(`unknown`)不拦。原来按「这个进程是不是无头实例」拦,无头实例已归档。
 *
 * 状态文件只写在临时目录(PROMPTCUT_SKILL_DIR),不碰用户的 Documents\PromptCut-Skill。
 * 跑法:node --test server/test/skill-gate.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-skill-gate-'));
process.env.PROMPTCUT_SKILL_DIR = DIR;
const gate = await import('../skill-gate.mjs');
const STATE = path.join(DIR, 'skill-state.json');

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('SG-1 状态文件在 PROMPTCUT_SKILL_DIR 下;没有文件按关着;open / close 落盘,不再写旧版的任务字段', () => {
  assert.equal(gate.statePath(), STATE);
  assert.equal(gate.readState().active, false);
  const on = gate.openGate();
  assert.equal(on.active, true);
  assert.ok(Date.parse(on.since) > 0);
  const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(raw.active, true);
  for (const k of ['jobId', 'jobDir', 'procPath']) assert.equal(k in raw, false, `${k} 随无头实例归档,不再写`);
  const off = gate.closeGate('user');
  assert.equal(off.active, false);
  assert.equal(off.closedBy, 'user');
  assert.ok(Date.parse(off.closedAt) > 0);
});

test('SG-2 按调用方类型拦:desktop 在 SKILL 关着时拒绝、开着时放行;api / cli / unknown 一律放行', () => {
  gate.closeGate('test');
  const denied = gate.checkGate('add_clip', 'desktop');
  assert.equal(denied.ok, false);
  for (const t of ['api', 'cli', 'unknown']) assert.equal(gate.checkGate('add_clip', t).ok, true, `${t} 不受 SKILL 闸管`);
  gate.openGate();
  assert.equal(gate.checkGate('add_clip', 'desktop').ok, true, 'SKILL 开着时桌面会话放行');
  gate.closeGate('test');
});

test('SG-3 拒绝时的说明:点名工具、说项目没改、别重试、告诉用户切到 SKILL', () => {
  gate.closeGate('test');
  const { message } = gate.checkGate('update_clip', 'desktop');
  assert.match(message, /不在 SKILL 模式/);
  assert.match(message, /update_clip/);
  assert.match(message, /没有\*\*任何改动/);
  assert.match(message, /不要重试/);
  assert.match(message, /切到 SKILL/);
});

test('SG-4 状态文件坏了按关着处理(默认拒绝桌面会话)', () => {
  fs.writeFileSync(STATE, '{ 这不是 JSON');
  assert.equal(gate.readState().active, false);
  assert.equal(gate.checkGate('add_clip', 'desktop').ok, false);
  fs.unlinkSync(STATE);
  assert.equal(gate.checkGate('add_clip', 'desktop').ok, false, '文件不存在也按关着');
});
