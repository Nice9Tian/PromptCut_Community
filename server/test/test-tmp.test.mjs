import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describeLeftovers, emptyDir, findEscaped, formatReport, prefixOf, sandboxEnv, sharedTmpDir, SHARED_TMP_ENV } from './test-tmp-sandbox.mjs';

test('prefixOf drops the mkdtemp suffix and log timestamps', () => {
  assert.equal(prefixOf('pc-order-AbC123'), 'pc-order');
  assert.equal(prefixOf('pc-doc-assembly-child-1791429762928.log'), 'pc-doc-assembly-child');
  assert.equal(prefixOf('abcdef'), 'abcdef');
});

test('sandbox env redirects temp dirs but keeps the shared one reachable', () => {
  const env = sandboxEnv('/sandbox', '/real', { PATH: 'x' });
  assert.deepEqual([env.TMPDIR, env.TEMP, env.TMP, env.PATH], ['/sandbox', '/sandbox', '/sandbox', 'x']);
  assert.equal(sharedTmpDir(env), '/real');
  assert.equal(sharedTmpDir({}), os.tmpdir());
  assert.equal(SHARED_TMP_ENV in env, true);
});

test('leftovers are counted, grouped, reported and emptied; escapes are found', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-test-tmp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(formatReport('x', describeLeftovers(dir)), '');
  const since = Date.now() - 1000;
  fs.mkdirSync(path.join(dir, 'pc-a-AAAAAA'));
  fs.mkdirSync(path.join(dir, 'pc-a-BBBBBB'));
  fs.writeFileSync(path.join(dir, 'pc-a-BBBBBB', 'f'), 'hello');
  fs.writeFileSync(path.join(dir, 'pc-b-child-1791429762928.log'), 'x');
  const left = describeLeftovers(dir);
  assert.equal(left.count, 3);
  assert.equal(left.bytes, 6);
  assert.deepEqual(left.byPrefix.get('pc-a'), { count: 2, bytes: 5 });
  assert.match(formatReport('x', left), /pc-a ×2/);
  assert.deepEqual(findEscaped(dir, since, null), ['pc-a-AAAAAA', 'pc-a-BBBBBB', 'pc-b-child-1791429762928.log']);
  assert.deepEqual(findEscaped(dir, Date.now() + 60000, null), []);
  emptyDir(dir);
  assert.deepEqual(fs.readdirSync(dir), []);
});
