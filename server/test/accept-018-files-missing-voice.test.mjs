/**
 * The small piece of 0.7.18 itemized acceptance check 2.1-12 "Missing visual/audio assets" that can
 * be verified on main right now: the placeholder voice file itself distributed with the software.
 * The contract (account-binding-contract.md "Missing asset placeholder") specifies:
 * `src/audio/assets/missing-material.wav`, PCM 16-bit, 48 kHz, mono, 1.37 s, 131,564 bytes, SHA-256
 * `5E615376504BDD9350A88E890E3FE320109719A5DAB42D760BC658B993CCF4E7`; it is not a project asset,
 * and is not stored into the project.
 * Visual placeholders, dialogs, recovery, online browser, and export playback are all on branch
 * `claude/v18-missing` and cannot be verified on main (see map 2.1-12).
 *
 * Run: npm test -- server/test/accept-018-files-missing-voice.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WAV = path.join(ROOT, 'src', 'audio', 'assets', 'missing-material.wav');

test('ACC018-VOICE-1 the placeholder voice file matches what the contract says: size, SHA-256, PCM16/48kHz/mono, duration 1.37 s', () => {
  const bytes = fs.readFileSync(WAV);
  assert.equal(bytes.length, 131_564);
  assert.equal(createHash('sha256').update(bytes).digest('hex').toUpperCase(), '5E615376504BDD9350A88E890E3FE320109719A5DAB42D760BC658B993CCF4E7');
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  // Find fmt and data chunks
  let p = 12, fmt = null, dataBytes = null;
  while (p + 8 <= bytes.length) {
    const id = bytes.toString('ascii', p, p + 4), size = bytes.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: bytes.readUInt16LE(p + 8), channels: bytes.readUInt16LE(p + 10), rate: bytes.readUInt32LE(p + 12), bits: bytes.readUInt16LE(p + 22) };
    if (id === 'data') dataBytes = size;
    p += 8 + size + (size % 2);
  }
  assert.deepEqual(fmt, { format: 1, channels: 1, rate: 48_000, bits: 16 });
  assert.ok(Math.abs(dataBytes / 2 / 48_000 - 1.37) < 0.005, `duration ${dataBytes / 2 / 48_000} s`);
});

test('ACC018-VOICE-2 the placeholder voice is not project media: the project file (.proc serialization) contains neither its path nor its hash', () => {
  // Serialization is only in proc.ts; here only guard the textual fact that "nothing in the
  // repository registers this wav as a project asset or presets it into the media library".
  const hash = '5e615376504bdd9350a88e890e3fe320109719a5dab42d760bc658b993ccf4e7';
  const hits = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'dist-online', '.worktrees', 'out'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(ts|tsx|mjs|json)$/.test(e.name) && !/accept-018/.test(e.name) && /project|media|proc/i.test(e.name)) {
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes(hash) || text.includes('missing-material.wav')) hits.push(path.relative(ROOT, full));
    }
  } };
  walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'server'));
  // After A3, the closed-source parts live under cloud/ (this directory does not exist in the public
  // repository); this check originally guarded them, and must continue guarding them after the move
  for (const d of ['cloud/src', 'cloud/server']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  const isTest = (h) => /\.test\./.test(h) || h.split(path.sep).includes('test');
  assert.deepEqual(hits.filter(h => !isTest(h)), [], 'project/media/packaging code does not register this file');
});
