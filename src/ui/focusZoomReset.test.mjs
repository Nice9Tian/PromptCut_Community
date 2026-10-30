/**
 * 手机浏览器输入框失焦后把页面缩放拉回 100% 的纯逻辑(`focusZoomReset.ts`)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTextEntry, clampedViewport, planReset } from './focusZoomReset.ts';

test('FZ1 会唤起键盘的才算输入框:文字类 input、textarea、select、contenteditable', () => {
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextEntry({ tagName: 'input', type: '' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'password' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'email' }), true);
  assert.equal(isTextEntry({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEntry({ tagName: 'SELECT' }), true);
  assert.equal(isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
  for (const type of ['checkbox', 'radio', 'range', 'button', 'file']) assert.equal(isTextEntry({ tagName: 'INPUT', type }), false, type);
  assert.equal(isTextEntry({ tagName: 'BUTTON' }), false);
  assert.equal(isTextEntry(null), false);
});

test('FZ2 临时 viewport:原内容加 maximum-scale=1,已有的 maximum-scale 换掉', () => {
  assert.equal(clampedViewport('width=device-width, initial-scale=1.0'), 'width=device-width, initial-scale=1.0, maximum-scale=1');
  assert.equal(clampedViewport('width=device-width,initial-scale=1,maximum-scale=5'), 'width=device-width, initial-scale=1, maximum-scale=1');
});

test('FZ3 只有放大着、焦点又没落到另一个输入框时才拉回', () => {
  assert.equal(planReset(1.6, false), true);
  assert.equal(planReset(1.6, true), false, '焦点挪到下一个输入框:不打断');
  assert.equal(planReset(1, false), false);
  assert.equal(planReset(1.005, false), false, '浮点余量内算没放大');
  assert.equal(planReset(undefined, false), false);
});
