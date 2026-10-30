import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJunction, removeJunction, removeMarkedJunction, sweepStaleJunctions, portTriple, startDevServer } from '../../scripts/lib/dev-server.mjs';

/** 每个用例一套:假素材目录(带文件和子目录)+ 一个放链接的工作目录 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-junction-'));
  const target = path.join(root, 'media-src');
  fs.mkdirSync(path.join(target, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(target, 'clip 一.mp4'), 'video');
  fs.writeFileSync(path.join(target, 'sub', 'deep.png'), 'image');
  const work = path.join(root, 'runs', 'run-1');
  fs.mkdirSync(work, { recursive: true });
  return { root, target, work, link: path.join(work, 'media') };
}

const files = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test('拆 junction 只拆链接,目标里的文件一个不少', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const before = files(f.target);
  createJunction(f.link, f.target);
  assert.ok(fs.lstatSync(f.link).isSymbolicLink());
  assert.deepEqual(files(f.link), before);
  assert.equal(removeMarkedJunction(f.work), true);
  assert.equal(fs.existsSync(f.link), false);
  assert.equal(fs.existsSync(path.join(f.work, '.media-junction.json')), false);
  assert.deepEqual(files(f.target), before);
  // 再拆一次:已经没有了,不报错
  assert.equal(removeJunction(f.link), false);
});

test('不是链接的真目录、指向别处的链接都不拆', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(f.link);
  fs.writeFileSync(path.join(f.link, 'keep.txt'), 'x');
  assert.throws(() => removeJunction(f.link), /不是链接/);
  assert.ok(fs.existsSync(path.join(f.link, 'keep.txt')));
  // 已存在的路径上不建链接
  assert.throws(() => createJunction(f.link, f.target), /已经存在/);

  const other = path.join(f.work, 'other');
  fs.symlinkSync(f.target, other, 'junction');
  assert.throws(() => removeJunction(other, path.join(f.root, 'elsewhere')), /不是/);
  assert.ok(fs.lstatSync(other).isSymbolicLink());
  removeJunction(other, f.target);
});

test('强杀后留下的链接:建它的进程已经不在就清掉,还活着就不动', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const before = files(f.target);
  createJunction(f.link, f.target);
  const marker = path.join(f.work, '.media-junction.json');
  const info = JSON.parse(fs.readFileSync(marker, 'utf8'));

  // 标记里的 pid 是一个活着的别的进程(父进程):不动
  fs.writeFileSync(marker, JSON.stringify({ ...info, pid: process.ppid }));
  assert.deepEqual(sweepStaleJunctions(path.dirname(f.work)), []);
  assert.ok(fs.lstatSync(f.link).isSymbolicLink());

  // 换成一个不存在的 pid:清掉
  fs.writeFileSync(marker, JSON.stringify({ ...info, pid: 2 ** 31 - 1 }));
  assert.deepEqual(sweepStaleJunctions(path.dirname(f.work)), [path.resolve(f.link)]);
  assert.equal(fs.existsSync(f.link), false);
  assert.deepEqual(files(f.target), before);
});

test('指定端口时拒绝用户常驻的 5190~5192', async () => {
  assert.deepEqual(portTriple(5188), [5188, 5189, 5190]);
  await assert.rejects(startDevServer({ port: 5188, logFile: path.join(os.tmpdir(), 'never.log') }), /用户常驻/);
  await assert.rejects(startDevServer({ port: 5191, logFile: path.join(os.tmpdir(), 'never.log') }), /用户常驻/);
});
