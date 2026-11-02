/**
 * Review loop lessons persisted across runs (lessonsStore in runners/api.mjs): placed in the same
 * directory as ai.json, deduplicated, keeping only the latest 30, and does not crash if the file is
 * corrupted. Point PROMPTCUT_AI_CONFIG to a temporary directory without touching real config.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lessonsStore } from '../runners/api.mjs';

function withTempConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-lessons-'));
  const prev = process.env.PROMPTCUT_AI_CONFIG;
  process.env.PROMPTCUT_AI_CONFIG = path.join(dir, 'ai.json');
  try { fn(dir); } finally {
    if (prev === undefined) delete process.env.PROMPTCUT_AI_CONFIG; else process.env.PROMPTCUT_AI_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('With no file, an empty list is read; saved lessons live in the same directory as ai.json', () => withTempConfig((dir) => {
  const s = lessonsStore();
  assert.deepEqual(s.read(), []);
  s.add(['Look at the picture before laying out cards']);
  assert.ok(fs.existsSync(path.join(dir, 'review-lessons.json')));
  assert.deepEqual(lessonsStore().read(), ['Look at the picture before laying out cards']);
}));

test('Duplicate lessons are not stacked, a lesson that reappears moves to the end; only the latest 30 are kept', () => withTempConfig(() => {
  const s = lessonsStore();
  s.add(['One', 'Two']);
  s.add(['One']);
  assert.deepEqual(s.read(), ['Two', 'One']);
  s.add(Array.from({ length: 40 }, (_, i) => `Lesson ${i}`));
  const all = s.read();
  assert.equal(all.length, 30);
  assert.equal(all.at(-1), 'Lesson 39');
}));

test('A corrupted file is treated as missing, without throwing an error', () => withTempConfig((dir) => {
  fs.writeFileSync(path.join(dir, 'review-lessons.json'), '{not JSON');
  assert.deepEqual(lessonsStore().read(), []);
}));
