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

test('with the table installed, a request gets its own language', async () => {
  const { useTranslator } = await import('../i18n.mjs');
  const { LOCALES, translate } = await import('../../src/i18n/index.ts');
  useTranslator(translate, LOCALES.map((l) => l.id));
  assert.equal(await during({ 'x-pc-locale': 'zh-CN' }), translate('zh-CN', 'Failed: {0}', ['x']));
  assert.equal(await during({ 'x-pc-locale': 'ja' }), translate('ja', 'Failed: {0}', ['x']));
  assert.notEqual(await during({ 'x-pc-locale': 'ja' }), 'Failed: x');
  assert.equal(await during({ 'x-pc-locale': 'fr' }), 'Failed: x');
});

test('rows added from server code reach a request in its language', async () => {
  const { addRows, useTranslator } = await import('../i18n.mjs');
  const { LOCALES, translate } = await import('../../src/i18n/index.ts');
  useTranslator(translate, LOCALES.map((l) => l.id));
  addRows({ 'Server row kept outside the table': { zh: '表外的服务端行', ja: '表外のサーバー行' } }); // i18n-allow: the row under test
  const seen = await new Promise((resolve) => {
    localeMiddleware({ headers: { 'x-pc-locale': 'ja' } }, {}, () => resolve(tr('Server row kept outside the table')));
  });
  assert.equal(seen, '表外のサーバー行'); // i18n-allow: the row under test
});

test('a second copy of the module (loaded from disk at run time) sees the same request', async () => {
  const { useTranslator } = await import('../i18n.mjs');
  const { LOCALES, translate } = await import('../../src/i18n/index.ts');
  useTranslator(translate, LOCALES.map((l) => l.id));
  const copy = await import(new URL('../i18n.mjs?copy', import.meta.url).href);
  const seen = await new Promise((resolve) => {
    localeMiddleware({ headers: { 'x-pc-locale': 'zh-CN' } }, {}, () => resolve(copy.tr('Failed: {0}', 'x')));
  });
  assert.equal(seen, translate('zh-CN', 'Failed: {0}', ['x']));
  assert.notEqual(seen, 'Failed: x');
});
