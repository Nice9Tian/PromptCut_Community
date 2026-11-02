import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localeMiddleware, tr } from '../i18n.mjs';

const during = (headers) => new Promise((resolve) => {
  localeMiddleware({ headers }, {}, () => resolve(tr('Failed: {0}', 'x')));
});

test('outside a request text stays English', () => {
  assert.equal(tr('Failed: {0}', 'x'), 'Failed: x');
});

test('an unknown language header falls back to English', async () => {
  assert.equal(await during({ 'x-pc-locale': 'fr' }), 'Failed: x');
  assert.equal(await during({}), 'Failed: x');
});

test('the language holds across awaits inside the request', async () => {
  const seen = await new Promise((resolve) => {
    localeMiddleware({ headers: { 'x-pc-locale': 'ja' } }, {}, async () => {
      await new Promise((r) => setTimeout(r, 1));
      resolve(tr('Not in the table'));
    });
  });
  assert.equal(seen, 'Not in the table');
});
