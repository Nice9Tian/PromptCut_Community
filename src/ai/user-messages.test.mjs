import test from 'node:test';
import assert from 'node:assert/strict';
import { isUserMessageCall, sayingsOf, userMessageText } from './userMessages.ts';

const say = (text, extra = {}) => ({ kind: 'tool', name: 'send_message', input: { to: 'user', text }, ok: true, ...extra });

test('调过 send_message(to user) 的一轮:气泡只列这些话,按先后;文字回复不进气泡', () => {
  const m = { text: '我先读一下项目', parts: [{ kind: 'text', text: '我先读一下项目' }, say('先看看开头的画面'),
    { kind: 'tool', name: 'see_frames', input: {}, ok: true }, say('标题卡放好了'), { kind: 'tool', name: 'report_progress', input: { final: true, done: ['x'] } }] };
  assert.deepEqual(sayingsOf(m).map(s => [s.text, s.from]), [['先看看开头的画面', 'send_message'], ['标题卡放好了', 'send_message']]);
});

test('一次都没调、只回了文字:文字当成一句「在做什么」;相邻文字并成一句,被工具隔开的分开', () => {
  const m = { text: '', parts: [{ kind: 'text', text: '好' }, { kind: 'thinking', text: 'hmm' }, { kind: 'text', text: '的' },
    { kind: 'tool', name: 'get_project', input: {} }, { kind: 'text', text: '  ' }, { kind: 'text', text: '改好了。' }] };
  assert.deepEqual(sayingsOf(m).map(s => s.text), ['好的', '改好了。']);
  assert.deepEqual(sayingsOf({ text: '旧记录', tools: [] }).map(s => s.text), ['旧记录'], '没有 parts 的旧记录');
});

test('发给别的 Agent、发空话、失败的那次不算对用户说话;名字带前缀也认', () => {
  assert.equal(isUserMessageCall('mcp__promptcut__send_message', { to: 'User', text: 'x' }), true);
  assert.equal(isUserMessageCall('send_message', { to: 'cc-1', text: 'x' }), false);
  assert.equal(userMessageText('send_message', { to: 'user', text: '  ' }), null);
  const m = { text: '', parts: [say('没说成', { ok: false }), { kind: 'tool', name: 'send_message', input: { to: 'all', text: '序列2 我来' } }, { kind: 'text', text: '收工' }] };
  assert.deepEqual(sayingsOf(m).map(s => [s.text, s.from]), [['收工', 'text']]);
});
