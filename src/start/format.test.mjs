/**
 * 开始页自动取的项目名怎么避开重名(`src/start/format.ts`)。跑:npm test -- src/start/format.test.mjs
 *
 * 背景:项目名在这个服务里是全站唯一的(`server/auth/protocol.mjs` 的 `nameKey`),开始页「新建项目」
 * 和「说一句话」的名字都是机器取的,撞名时用户无从改起。2026-10-23 线上实测:全新游客点「新建项目」
 * 必定回 409 `name-taken`(名字恒为「未命名」,第一个人建完之后所有人都被挡死)。
 * 这里盯的就是「撞了自动换一个再试,别的错不许吞」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWithFreeName, nextProjectName } from './format.ts';

const taken = () => Object.assign(new Error('name-taken'), { code: 'name-taken' });

test('PNAME-01 the first use is the original name, the next four get suffixes 2-5, after that a four-digit hex suffix', () => {
  assert.equal(nextProjectName('Untitled', 0), 'Untitled');
  assert.deepEqual([1, 2, 3, 4].map(i => nextProjectName('Untitled', i)),
    ['Untitled 2', 'Untitled 3', 'Untitled 4', 'Untitled 5']);
  assert.match(nextProjectName('Untitled', 5), /^Untitled [0-9a-f]{4}$/);
  assert.match(nextProjectName('Untitled', 9), /^Untitled [0-9a-f]{4}$/);
});

test('PNAME-02 created on the first try: called only once, with the original name', async () => {
  const seen = [];
  const used = await createWithFreeName(async n => { seen.push(n); }, 'Untitled');
  assert.deepEqual(seen, ['Untitled']);
  assert.equal(used, 'Untitled');
});

test('PNAME-03 three collisions in a row: the fourth name succeeds, and the one actually used is returned', async () => {
  const seen = [];
  const used = await createWithFreeName(async n => { seen.push(n); if (seen.length < 4) throw taken(); }, 'Untitled');
  assert.deepEqual(seen, ['Untitled', 'Untitled 2', 'Untitled 3', 'Untitled 4']);
  assert.equal(used, 'Untitled 4');
});

test('PNAME-04 errors that are not name collisions are rethrown as is, no retry with another name (guest over limit, not logged in, network down all take this path)', async () => {
  const seen = [];
  await assert.rejects(
    () => createWithFreeName(async n => { seen.push(n); throw Object.assign(new Error('Guests can only create 1 project.'), { code: 'guest-limit' }); }, 'Untitled'),
    /Guests can only create 1 project/);
  assert.deepEqual(seen, ['Untitled'], 'tried only once');
});

test('PNAME-05 still colliding after all attempts: throw the last error, do not loop forever', async () => {
  let n = 0;
  await assert.rejects(() => createWithFreeName(async () => { n += 1; throw taken(); }, 'Untitled', 3), /name-taken/);
  assert.equal(n, 3);
});

test('PNAME-06 names generated from a single sentence take the same path (names are at most 24 characters, with the suffix they stay within the 64-character limit)', () => {
  const long = 'x'.repeat(24);
  assert.ok([...nextProjectName(long, 4)].length <= 64);
  assert.ok([...nextProjectName(long, 5)].length <= 64);
});
