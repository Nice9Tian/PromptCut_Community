// The two lines of text on the background mode floating window (desktop/ui/overlay-summary.js).
// Guards against: SKILL and non-SKILL inverted, showing "waiting for connection" while session is running,
// failures written as success, tool names untranslated and falling back to undefined.
// How to run: node --test desktop/test/overlay-summary.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(fileURLToPath(new URL('../ui/overlay-summary.js', import.meta.url)), 'utf8');
const ctx = { window: {} };
vm.runInNewContext(src, ctx);
const { summarize, previewCaption, toolName } = ctx.window.pcOverlay;

test('OV-1 non-SKILL: writes background mode, no flicker', () => {
  const s = summarize({ skill: false, sessions: [{ label: 'Claude Code', current: { tool: 'update_clip' } }] });
  assert.equal(s.title, 'PromptCut is running in background mode');
  assert.equal(s.skill, false);
  assert.equal(s.busy, false);
  assert.equal(summarize(undefined).skill, false);
});

test('OV-2 SKILL has no session / editor unreachable', () => {
  assert.equal(summarize({ skill: true, editor_up: true, sessions: [] }).sub, 'Waiting for the desktop app\'s Agent to connect');
  const down = summarize({ skill: true, editor_up: false, sessions: [] });
  assert.equal(down.sub, 'The editor is not responding');
  assert.equal(down.title, 'SKILL mode');
});

test('OV-3 One session running: vendor + what it is doing, breathing', () => {
  const s = summarize({ skill: true, editor_up: true, sessions: [
    { label: 'Codex', last: { tool: 'get_project', ok: true } },
    { label: 'Claude Code', current: { tool: 'update_clip', since: 1 } },
  ] });
  assert.equal(s.sub, 'Claude Code: Edit card');
  assert.equal(s.busy, true);
});

test('OV-4 Multiple sessions running: name the first one, then give the total', () => {
  const s = summarize({ skill: true, sessions: [
    { label: 'Claude Code', current: { tool: 'add_clip' } },
    { vendor: 'codex', current: { tool: 'split_clip' } },
  ] });
  assert.equal(s.sub, 'Claude Code and others: 2 sessions working');
});

test('OV-5 None running: the last step of the most recent one, failure stated explicitly', () => {
  assert.equal(
    summarize({ skill: true, sessions: [{ label: 'Codex', last: { tool: 'remove_clip', ok: false } }] }).sub,
    'Codex, last step failed: Delete card',
  );
  assert.equal(
    summarize({ skill: true, sessions: [{ label: 'Codex', last: { tool: 'weird_tool', ok: true } }] }).sub,
    'Codex, last step: weird_tool',
  );
  assert.equal(summarize({ skill: true, sessions: [{ id: 'desk-1' }] }).sub, 'Agent connected');
});

test('OV-6 Preview caption and tool name', () => {
  const c = previewCaption({ tool: 'update_clip', t: 3.21, at: '2026-09-30T01:02:03Z' }, () => '12:00:00');
  assert.equal(c.what, 'Edit card');
  assert.equal(c.rest, ' · 3.2s · 12:00:00');
  assert.equal(previewCaption({}, () => '').what, 'Action');
  assert.equal(toolName(undefined), 'Action');
});

test('OV-7 overlay.html includes this script and wires up three things: click, right-click, ready', () => {
  const html = readFileSync(fileURLToPath(new URL('../ui/overlay.html', import.meta.url)), 'utf8');
  assert.match(html, /<script src="overlay-summary.js"><\/script>/);
  for (const ev of ['pc-overlay-open', 'pc-overlay-menu', 'pc-overlay-ready', 'pc-overlay-state', 'pc-skill-preview']) {
    assert.ok(html.includes(ev), ev);
  }
  // Event names on the shell side must match (skill_shell.rs)
  const rs = readFileSync(fileURLToPath(new URL('../src-tauri/src/skill_shell.rs', import.meta.url)), 'utf8');
  for (const ev of ['pc-overlay-open', 'pc-overlay-menu', 'pc-overlay-ready', 'pc-overlay-state', 'pc-skill-preview']) {
    assert.ok(rs.includes(`"${ev}"`), `skill_shell.rs does not contain ${ev}`);
  }
  // Startup progress for legacy headless instances has been removed (archived in A4); do not let it reappear
  assert.ok(!html.includes('start a headless instance'));
});

test('OV-8 Follows the display language: Chinese reads as it did before English became the source, Japanese too', () => {
  const load = (language) => {
    const c = { window: {}, navigator: { language } };
    vm.runInNewContext(src, c);
    return c.window.pcOverlay;
  };
  const zh = load('zh-CN');
  assert.equal(zh.summarize({ skill: false }).title, 'PromptCut 在后台运行'); // i18n-allow: the expected Chinese and Japanese output
  assert.equal(zh.summarize({ skill: true, sessions: [{ label: 'Claude Code', current: { tool: 'update_clip' } }] }).sub, 'Claude Code 正在改卡片'); // i18n-allow: the expected Chinese and Japanese output
  assert.equal(zh.toolName(undefined), '操作'); // i18n-allow: the expected Chinese and Japanese output
  const ja = load('ja-JP');
  assert.equal(ja.summarize({ skill: true, sessions: [{ label: 'Codex', last: { tool: 'remove_clip', ok: false } }] }).sub, 'Codex 前回のステップが失敗：カードを削除'); // i18n-allow: the expected Chinese and Japanese output
  assert.equal(load('en-US').t('Last step'), 'Last step');
});
