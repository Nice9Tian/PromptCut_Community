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

test('PNAME-01 第一次用原名,接下来四次缀 2～5,再往后缀四位十六进制', () => {
  assert.equal(nextProjectName('未命名', 0), '未命名');
  assert.deepEqual([1, 2, 3, 4].map(i => nextProjectName('未命名', i)),
    ['未命名 2', '未命名 3', '未命名 4', '未命名 5']);
  assert.match(nextProjectName('未命名', 5), /^未命名 [0-9a-f]{4}$/);
  assert.match(nextProjectName('未命名', 9), /^未命名 [0-9a-f]{4}$/);
});

test('PNAME-02 一次就建成:只调一次,用的是原名', async () => {
  const seen = [];
  const used = await createWithFreeName(async n => { seen.push(n); }, '未命名');
  assert.deepEqual(seen, ['未命名']);
  assert.equal(used, '未命名');
});

test('PNAME-03 连撞三次:第四个名字建成,返回真正用上的那个', async () => {
  const seen = [];
  const used = await createWithFreeName(async n => { seen.push(n); if (seen.length < 4) throw taken(); }, '未命名');
  assert.deepEqual(seen, ['未命名', '未命名 2', '未命名 3', '未命名 4']);
  assert.equal(used, '未命名 4');
});

test('PNAME-04 不是重名的错照原样抛出,不换名重试(游客超额、没登录、网络断都走这条)', async () => {
  const seen = [];
  await assert.rejects(
    () => createWithFreeName(async n => { seen.push(n); throw Object.assign(new Error('游客只能建 1 个项目。'), { code: 'guest-limit' }); }, '未命名'),
    /游客只能建 1 个项目/);
  assert.deepEqual(seen, ['未命名'], '只试了一次');
});

test('PNAME-05 试满次数还在撞:抛最后那个错,不无限转', async () => {
  let n = 0;
  await assert.rejects(() => createWithFreeName(async () => { n += 1; throw taken(); }, '未命名', 3), /name-taken/);
  assert.equal(n, 3);
});

test('PNAME-06 说一句话取的名字也走同一条路(名字最长 24 字,缀上去不超 64 字上限)', () => {
  const long = '一'.repeat(24);
  assert.ok([...nextProjectName(long, 4)].length <= 64);
  assert.ok([...nextProjectName(long, 5)].length <= 64);
});
