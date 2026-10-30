// 后台运行悬浮窗上那两行字(desktop/ui/overlay-summary.js)。
// 挡住的是:SKILL 与非 SKILL 写反、会话在跑却显示「等接入」、失败写成成功、工具名漏译成 undefined。
// 跑法:node --test desktop/test/overlay-summary.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(fileURLToPath(new URL('../ui/overlay-summary.js', import.meta.url)), 'utf8');
const ctx = { window: {} };
vm.runInNewContext(src, ctx);
const { summarize, previewCaption, toolName } = ctx.window.pcOverlay;

test('OV-1 非 SKILL:写后台运行,不闪', () => {
  const s = summarize({ skill: false, sessions: [{ label: 'Claude Code', current: { tool: 'update_clip' } }] });
  assert.equal(s.title, 'PromptCut 在后台运行');
  assert.equal(s.skill, false);
  assert.equal(s.busy, false);
  assert.equal(summarize(undefined).skill, false);
});

test('OV-2 SKILL 没有会话 / 编辑器连不上', () => {
  assert.equal(summarize({ skill: true, editor_up: true, sessions: [] }).sub, '等桌面 APP 的 Agent 接入');
  const down = summarize({ skill: true, editor_up: false, sessions: [] });
  assert.equal(down.sub, '编辑器没有响应');
  assert.equal(down.title, 'SKILL 模式');
});

test('OV-3 一个会话在跑:厂商 + 正在做什么,呼吸', () => {
  const s = summarize({ skill: true, editor_up: true, sessions: [
    { label: 'Codex', last: { tool: 'get_project', ok: true } },
    { label: 'Claude Code', current: { tool: 'update_clip', since: 1 } },
  ] });
  assert.equal(s.sub, 'Claude Code 正在改卡片');
  assert.equal(s.busy, true);
});

test('OV-4 多个会话在跑:点第一个再说总数', () => {
  const s = summarize({ skill: true, sessions: [
    { label: 'Claude Code', current: { tool: 'add_clip' } },
    { vendor: 'codex', current: { tool: 'split_clip' } },
  ] });
  assert.equal(s.sub, 'Claude Code 等 2 个会话正在工作');
});

test('OV-5 都没在跑:最近那个的上一步,失败写明', () => {
  assert.equal(
    summarize({ skill: true, sessions: [{ label: 'Codex', last: { tool: 'remove_clip', ok: false } }] }).sub,
    'Codex 上一步失败：删卡片',
  );
  assert.equal(
    summarize({ skill: true, sessions: [{ label: 'Codex', last: { tool: 'weird_tool', ok: true } }] }).sub,
    'Codex 上一步：weird_tool',
  );
  assert.equal(summarize({ skill: true, sessions: [{ id: 'desk-1' }] }).sub, 'Agent 已接入');
});

test('OV-6 预览说明与工具名', () => {
  const c = previewCaption({ tool: 'update_clip', t: 3.21, at: '2026-09-30T01:02:03Z' }, () => '12:00:00');
  assert.equal(c.what, '改卡片');
  assert.equal(c.rest, ' · 3.2s · 12:00:00');
  assert.equal(previewCaption({}, () => '').what, '操作');
  assert.equal(toolName(undefined), '操作');
});

test('OV-7 overlay.html 引了这份脚本,并接上单击、右键、就绪三件事', () => {
  const html = readFileSync(fileURLToPath(new URL('../ui/overlay.html', import.meta.url)), 'utf8');
  assert.match(html, /<script src="overlay-summary.js"><\/script>/);
  for (const ev of ['pc-overlay-open', 'pc-overlay-menu', 'pc-overlay-ready', 'pc-overlay-state', 'pc-skill-preview']) {
    assert.ok(html.includes(ev), ev);
  }
  // 外壳那头的事件名要对得上(skill_shell.rs)
  const rs = readFileSync(fileURLToPath(new URL('../src-tauri/src/skill_shell.rs', import.meta.url)), 'utf8');
  for (const ev of ['pc-overlay-open', 'pc-overlay-menu', 'pc-overlay-ready', 'pc-overlay-state', 'pc-skill-preview']) {
    assert.ok(rs.includes(`"${ev}"`), `skill_shell.rs 里没有 ${ev}`);
  }
  // 老的无头实例启动进度已经没有了(A4 归档),别再出现
  assert.ok(!html.includes('起一份无头实例'));
});
