/**
 * Pure logic resetting page zoom back to 100% after mobile browser input box blurs (`focusZoomReset.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTextEntry, clampedViewport, planReset } from './focusZoomReset.ts';

test('FZ1 Only fields that bring up the keyboard count as input boxes: text-type input, textarea, select, contenteditable', () => {
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

test('FZ2 Temporary viewport: add maximum-scale=1 to the original content, and replace any existing maximum-scale', () => {
  assert.equal(clampedViewport('width=device-width, initial-scale=1.0'), 'width=device-width, initial-scale=1.0, maximum-scale=1');
  assert.equal(clampedViewport('width=device-width,initial-scale=1,maximum-scale=5'), 'width=device-width, initial-scale=1, maximum-scale=1');
});

test('FZ3 Only pull back when zoomed in and focus has not landed on another input box', () => {
  assert.equal(planReset(1.6, false), true);
  assert.equal(planReset(1.6, true), false, 'Focus moves to the next input box: do not interrupt');
  assert.equal(planReset(1, false), false);
  assert.equal(planReset(1.005, false), false, 'within floating-point tolerance counts as not zoomed in');
  assert.equal(planReset(undefined, false), false);
});
