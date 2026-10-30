import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSourceVersion } from './cardSourceVersion.mjs';

test('card source version follows only its static relative dependency closure', () => {
  const files = {
    '/src/cards/a.tsx': "export const a={id:'a'}; import { helper } from './helper'; import './a.css';",
    '/src/cards/helper.ts': 'export const helper=1;', '/src/cards/a.css': '.a{color:red}',
    '/src/cards/b.tsx': "export const b={id:'b'};", '/src/cards/unrelated.ts': 'export const x=1;',
  };
  const card = { id: 'a', defaults: {}, controls: [] };
  const before = cardSourceVersion(card, files);
  files['/src/cards/unrelated.ts'] = 'export const x=2;';
  assert.equal(cardSourceVersion(card, files), before);
  files['/src/cards/helper.ts'] = 'export const helper=2;';
  assert.notEqual(cardSourceVersion(card, files), before);
});

test('card source version ignores line endings (CRLF and LF checkouts give the same key)', () => {
  const lf = {
    '/src/cards/a.tsx': "export const a={id:'a'};\nimport { helper } from './helper';\nimport './a.css';\n",
    '/src/cards/helper.ts': 'export const helper=1;\n// two\n', '/src/cards/a.css': '.a{\n  color:red\n}\n',
  };
  const crlf = Object.fromEntries(Object.entries(lf).map(([k, v]) => [k, v.replace(/\n/g, '\r\n')]));
  const card = { id: 'a', defaults: {}, controls: [] };
  assert.notEqual(crlf['/src/cards/helper.ts'], lf['/src/cards/helper.ts']);
  assert.equal(cardSourceVersion(card, crlf), cardSourceVersion(card, lf));
  // 用户卡走显式入口那条路也一样
  assert.equal(cardSourceVersion(card, crlf, '/src/cards/a.tsx'), cardSourceVersion(card, lf, '/src/cards/a.tsx'));
  // 内容真变了照样换键
  const changed = { ...crlf, '/src/cards/helper.ts': 'export const helper=2;\r\n// two\r\n' };
  assert.notEqual(cardSourceVersion(card, changed), cardSourceVersion(card, lf));
});
