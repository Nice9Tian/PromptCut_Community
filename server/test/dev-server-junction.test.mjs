import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJunction, removeJunction, removeMarkedJunction, sweepStaleJunctions, portTriple, startDevServer } from '../../scripts/lib/dev-server.mjs';

/** One set per test case: fake asset catalog (with files and subdirectories) + a working directory for links */
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

test('Removing a junction removes only the link, and no file in the target is lost', (t) => {
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
  // Dismantle once more: already gone, does not throw
  assert.equal(removeJunction(f.link), false);
});

test('A real directory that is not a link, and a link pointing elsewhere, are both left alone', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(f.link);
  fs.writeFileSync(path.join(f.link, 'keep.txt'), 'x');
  assert.throws(() => removeJunction(f.link), /not a link/);
  assert.ok(fs.existsSync(path.join(f.link, 'keep.txt')));
  // Do not create links on existing paths
  assert.throws(() => createJunction(f.link, f.target), /already exists/);

  const other = path.join(f.work, 'other');
  fs.symlinkSync(f.target, other, 'junction');
  assert.throws(() => removeJunction(other, path.join(f.root, 'elsewhere')), /not/);
  assert.ok(fs.lstatSync(other).isSymbolicLink());
  removeJunction(other, f.target);
});

test('Link left behind after a forced kill: cleaned up if the process that created it is gone, left alone if it is still alive', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const before = files(f.target);
  createJunction(f.link, f.target);
  const marker = path.join(f.work, '.media-junction.json');
  const info = JSON.parse(fs.readFileSync(marker, 'utf8'));

  // pid in the marker is another living process (parent process): leave untouched
  fs.writeFileSync(marker, JSON.stringify({ ...info, pid: process.ppid }));
  assert.deepEqual(sweepStaleJunctions(path.dirname(f.work)), []);
  assert.ok(fs.lstatSync(f.link).isSymbolicLink());

  // Replace with a non-existent pid: clean up
  fs.writeFileSync(marker, JSON.stringify({ ...info, pid: 2 ** 31 - 1 }));
  assert.deepEqual(sweepStaleJunctions(path.dirname(f.work)), [path.resolve(f.link)]);
  assert.equal(fs.existsSync(f.link), false);
  assert.deepEqual(files(f.target), before);
});

test('When a port is specified, the user\'s resident ports 5190~5192 are refused', async () => {
  assert.deepEqual(portTriple(5188), [5188, 5189, 5190]);
  await assert.rejects(startDevServer({ port: 5188, logFile: path.join(os.tmpdir(), 'never.log') }), /user's long-running/);
  await assert.rejects(startDevServer({ port: 5191, logFile: path.join(os.tmpdir(), 'never.log') }), /user's long-running/);
});
