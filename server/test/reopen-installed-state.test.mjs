/**
 * 真实安装验收的两个辅助：安装状态的备份/比对/还原（`scripts/probes/reopen-installed-state.mjs`），
 * 以及探针之间交接秘密的封装（`scripts/probes/reopen-sealed.mjs`）。全部在临时目录里做。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup, compare, restore, scanRoot } from '../../scripts/probes/reopen-installed-state.mjs';
import { generateSealKeys, seal, unseal, ownedSealKeys, ownedMemberSecret } from '../../scripts/probes/reopen-sealed.mjs';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-state-'));
  const install = path.join(base, 'install'), data = path.join(base, 'data');
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write(path.join(install, 'app.exe'), 'original shell');
  write(path.join(install, 'runtime/app/package.json'), '{"version":"1"}');
  write(path.join(install, 'runtime/app/out/docservice/room.json'), 'old room');
  write(path.join(install, 'cli/tool.txt'), 'managed cli');
  fs.mkdirSync(path.join(install, 'runtime/empty'), { recursive: true });
  write(path.join(data, 'settings.json'), '{}');
  const roots = [{ name: 'install', path: install, excludes: ['cli'] }, { name: 'data', path: data }];
  return { base, install, data, write, roots, out: path.join(base, 'backup') };
}
const text = file => fs.readFileSync(file, 'utf8');

test('RIS-1 备份逐文件复制并记录摘要,排除的子目录只记汇总', () => {
  const f = fixture();
  const result = backup({ out: f.out, roots: f.roots });
  assert.deepEqual(result.roots.map(r => [r.name, r.files]), [['install', 3], ['data', 1]]);
  assert.equal(text(path.join(f.out, 'install/runtime/app/out/docservice/room.json')), 'old room');
  assert.equal(fs.existsSync(path.join(f.out, 'install/cli')), false, '排除的子目录不复制');
  assert.equal(fs.statSync(path.join(f.out, 'install/runtime/empty')).isDirectory(), true, '空目录也在');
  assert.deepEqual(result.roots[0].excluded, { cli: { files: 1, bytes: 11, newestMtimeMs: Math.floor(fs.statSync(path.join(f.install, 'cli/tool.txt')).mtimeMs) } });
  assert.deepEqual(compare({ backup: f.out }).identical, true);
  assert.throws(() => backup({ out: f.out, roots: f.roots }), /already exists/, '不覆盖已有的备份');
});

test('RIS-2 比对列出新增、改动、删掉的文件和排除目录的变化', () => {
  const f = fixture(); backup({ out: f.out, roots: f.roots });
  f.write(path.join(f.install, 'app.exe'), 'candidate shell');
  f.write(path.join(f.install, 'runtime/app/server/new.mjs'), 'new');
  fs.renameSync(path.join(f.install, 'runtime/app/package.json'), path.join(f.base, 'moved-away.json'));
  f.write(path.join(f.install, 'cli/tool.txt'), 'managed cli changed');
  const result = compare({ backup: f.out }), install = result.roots.find(r => r.name === 'install');
  assert.equal(result.identical, false);
  assert.deepEqual([install.added, install.changed, install.removed], [1, 1, 1]);
  assert.deepEqual(install.sample, { added: ['runtime/app/server/new.mjs'], removed: ['runtime/app/package.json'], changed: ['app.exe'] });
  assert.deepEqual(install.excludedChanged, ['cli']);
  assert.equal(result.roots.find(r => r.name === 'data').added, 0);
});

test('RIS-3 还原把现状改名挪开、复制备份回原处,排除的子目录原样搬回,不删任何文件', () => {
  const f = fixture(); backup({ out: f.out, roots: f.roots });
  f.write(path.join(f.install, 'app.exe'), 'candidate shell');
  f.write(path.join(f.install, 'runtime/app/server/new.mjs'), 'new');
  f.write(path.join(f.data, 'collaboration/vault.json'), 'test room');
  f.write(path.join(f.install, 'cli/added-during-test.txt'), 'kept');
  const now = new Date('2026-10-05T12:00:00Z'), result = restore({ backup: f.out, now });
  assert.equal(result.identical, true);
  assert.deepEqual(result.excludedChanged, ['install:cli'], '排除的子目录里的变化只报告,不当失败');
  assert.equal(text(path.join(f.install, 'app.exe')), 'original shell');
  assert.equal(fs.existsSync(path.join(f.install, 'runtime/app/server/new.mjs')), false);
  assert.equal(text(path.join(f.install, 'cli/tool.txt')), 'managed cli', '排除的子目录回到原处');
  assert.equal(text(path.join(f.install, 'cli/added-during-test.txt')), 'kept', '排除的子目录不归还原管');
  assert.equal(fs.existsSync(path.join(f.data, 'collaboration')), false);
  const aside = `${f.install}.reopen-candidate-20261005T120000Z`;
  assert.deepEqual(result.restored.map(r => r.aside), [aside, `${f.data}.reopen-candidate-20261005T120000Z`]);
  assert.equal(text(path.join(aside, 'app.exe')), 'candidate shell', '候选版的文件留在挪开的目录里');
  assert.equal(text(path.join(aside, 'runtime/app/server/new.mjs')), 'new');
  assert.equal(text(path.join(f.out, 'install/app.exe')), 'original shell', '备份本身不动');
  assert.deepEqual(compare({ backup: f.out }).roots.map(r => [r.name, r.added, r.removed, r.changed, r.excludedChanged]),
    [['install', 0, 0, 0, ['cli']], ['data', 0, 0, 0, []]]);
});

test('RIS-4 备份不完整时在第一次改名之前就拒绝;中途失败只用改名退回', () => {
  const f = fixture(); backup({ out: f.out, roots: f.roots });
  f.write(path.join(f.install, 'app.exe'), 'candidate shell');
  fs.renameSync(path.join(f.out, 'data/settings.json'), path.join(f.base, 'lost.json'));
  assert.throws(() => restore({ backup: f.out }), /no longer matches its manifest/);
  assert.equal(text(path.join(f.install, 'app.exe')), 'candidate shell', '没有动现状');
  assert.equal(fs.readdirSync(f.base).some(n => n.includes('.reopen-')), false);

  // 第一个目录已经换回、第二个目录刚挪开时出错:两个目录都退回出错前的样子,换回的那份改名留在旁边。
  const g = fixture(); backup({ out: g.out, roots: g.roots });
  g.write(path.join(g.install, 'app.exe'), 'candidate shell');
  g.write(path.join(g.data, 'collaboration/vault.json'), 'test room');
  const now = new Date('2026-10-05T12:00:00Z');
  assert.throws(() => restore({ backup: g.out, now, afterRename: r => { if (r.name === 'data') throw new Error('injected failure'); } }),
    /injected failure; undone: data,install/);
  assert.equal(text(path.join(g.install, 'app.exe')), 'candidate shell');
  assert.equal(text(path.join(g.install, 'cli/tool.txt')), 'managed cli', '排除的子目录跟着退回');
  assert.equal(text(path.join(g.data, 'collaboration/vault.json')), 'test room');
  assert.equal(text(path.join(`${g.install}.reopen-failed-20261005T120000Z`, 'app.exe')), 'original shell');
  assert.equal(fs.existsSync(`${g.install}.reopen-candidate-20261005T120000Z`), false);
  assert.equal(restore({ backup: g.out, now: new Date('2026-10-05T12:00:01Z') }).identical, true, '退回之后可以重做');
});

test('RIS-5 目录里有链接就拒绝备份;根目录必须是真目录', () => {
  const f = fixture();
  try { fs.symlinkSync(path.join(f.data), path.join(f.install, 'runtime/linked'), 'junction'); } catch { return; }
  assert.deepEqual(scanRoot(f.install, ['cli']).links, ['runtime/linked']);
  assert.throws(() => backup({ out: f.out, roots: f.roots }), /links are not supported/);
  assert.equal(fs.existsSync(f.out), false, '拒绝时不留半份备份');
  assert.throws(() => scanRoot(path.join(f.install, 'app.exe')), /real directory/);
});

test('RSB-1 封装只能由收件方打开;改一个字节或换私钥都打不开,报错不带内容', () => {
  const receiver = generateSealKeys(), other = generateSealKeys();
  const sealed = seal(receiver.publicKey, { username: 'member', password: 'p-'.repeat(20) });
  assert.match(sealed, /^pcs1\.[A-Za-z0-9_-]+$/, '一行可转发的文本');
  assert.equal(sealed.includes('p-p-'), false);
  assert.deepEqual(unseal(receiver.privateKey, sealed), { username: 'member', password: 'p-'.repeat(20) });
  assert.throws(() => unseal(other.privateKey, sealed), /contents withheld/);
  const tampered = sealed.slice(0, -3) + (sealed.endsWith('AAA') ? 'BBB' : 'AAA');
  assert.throws(() => unseal(receiver.privateKey, tampered), /sealed text/);
  assert.throws(() => unseal(receiver.privateKey, 'plain text'), /unsupported sealed text/);
  assert.notEqual(seal(receiver.publicKey, { a: 1 }), seal(receiver.publicKey, { a: 1 }), '每次封装都用新的临时密钥');
});

test('RSB-2 自有目录里的密钥与成员口令可以重复取用,换用户名拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-sealed-'));
  const first = ownedSealKeys(dir), again = ownedSealKeys(dir);
  assert.deepEqual(again, first);
  const secret = ownedMemberSecret(dir, 'wan-member');
  assert.equal(secret.password.length >= 43, true);
  assert.deepEqual(ownedMemberSecret(dir, 'wan-member'), secret);
  assert.throws(() => ownedMemberSecret(dir, 'someone-else'), /another username/);
  assert.deepEqual(unseal(first.privateKey, seal(first.publicKey, secret)), secret);
});
