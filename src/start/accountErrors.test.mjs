/**
 * Interface text for the account service's error codes (`src/start/accountErrors.ts`, issue #2 login dialog).
 * Run: npm test -- src/start/accountErrors.test.mjs
 *
 * What is pinned here: every known code has its own text in all three languages, an unknown code falls
 * back to the server's message (never swallowed), a fetch TypeError reads as "can't reach", and a step can
 * override what a code means there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_ERROR_CODES, accountErrorCodeText, accountErrorText } from './accountErrors.ts';
import { translate } from '../i18n/index.ts';

const err = (code, message = '服务器的话') => Object.assign(new Error(message), { code });

test('every known code has its own English text, and Chinese and Japanese rows', () => {
  const seen = new Set();
  for (const code of ACCOUNT_ERROR_CODES) {
    const en = accountErrorCodeText(code);
    assert.ok(en && !/[぀-ヿ㐀-鿿]/.test(en), `${code} has English text`);
    assert.ok(!seen.has(en), `${code} text is not shared with another code`);
    seen.add(en);
    assert.notEqual(translate('zh-CN', en), en, `${code} has a Chinese row`);
    assert.notEqual(translate('ja', en), en, `${code} has a Japanese row`);
  }
});

test('a known code wins over the server message', () => {
  assert.equal(accountErrorText(err('name-taken'), 'fallback'), accountErrorCodeText('name-taken'));
  // The code may also come as `error` (the response body's field)
  assert.equal(accountErrorText({ error: 'bad-code' }, 'fallback'), accountErrorCodeText('bad-code'));
});

test('an unknown code falls back to the server message, then to the fallback', () => {
  assert.equal(accountErrorText(err('brand-new-code', '新的错误'), 'fallback'), '新的错误');
  assert.equal(accountErrorText(new Error(''), 'fallback'), 'fallback');
  assert.equal(accountErrorText(null, 'fallback'), 'fallback');
  assert.equal(accountErrorText('plain text', 'fallback'), 'plain text');
});

test('fetch failing (TypeError) reads as network', () => {
  assert.equal(accountErrorText(new TypeError('Failed to fetch'), 'fallback'), accountErrorCodeText('network'));
});

test('a step can override what a code means there', () => {
  const tooShort = 'The password must be at least 8 characters.';
  assert.equal(accountErrorText(err('bad-password'), 'fallback', { 'bad-password': tooShort }), tooShort);
  assert.equal(accountErrorText(err('bad-password'), 'fallback'), accountErrorCodeText('bad-password'));
});
