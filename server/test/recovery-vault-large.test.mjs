/**
 * Local collaboration recovery info's protected storage (`server/recovery/vault.mjs`) can hold
 * offline edit records for large projects.
 *
 * Original issue (hit when implementing "move to the cloud", two places): On Windows, protected
 * storage calls DPAPI via PowerShell,
 *   1. `spawnSync` output cap is default 1 MiB: once project body in a room exceeds ~780 KB,
 *      offline edit records cannot be written (ENOBUFS → endpoint returns 503 "Cannot reliably
 *      read or save collaboration recovery information"); page save, cancel multi-user
 *      collaboration, and move to the cloud all fail as well;
 *   2. The regex checking whether output is base64 has repeating groups, overflowing the call
 *      stack (RangeError) when output reaches a few MB.
 *
 *   RVL-01 Offline edit record with 1.6 million characters of body: can be written; opening
 *          another instance (equivalent to restart) reads it back verbatim
 *   RVL-02 Output cap is an explicit number (same order of magnitude as recovery endpoint request
 *          body), not the default value
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRecoveryVault, PROTECT_MAX_BUFFER } from '../recovery/vault.mjs';

test('RVL-01 a large project\'s offline edit log can be written to the protected store and read back after reopening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-vault-large-'));
  try {
    const descriptor = { version: 1, roomId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', service: 'http://127.0.0.1:1', where: 'lan' };
    const project = { id: 'content', name: 'Large text', tracks: [], media: [], note: 'body'.repeat(1_200_000) };
    const journal = { version: 1, projectId: descriptor.roomId, project, rev: 7, offlineRev: null, pending: [] };
    assert.ok(Buffer.byteLength(JSON.stringify(journal)) > 4 * 1024 * 1024, 'the record itself is larger than 4 MiB');
    openRecoveryVault({ dir }).journal(descriptor, 'content', journal);
    const back = openRecoveryVault({ dir }).select(descriptor, 'content').journal;
    assert.equal(back.rev, 7);
    assert.equal(back.project.note.length, 4_800_000);
    assert.deepEqual(back, journal);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RVL-02 the protected store\'s output limit is an explicit number', () => {
  assert.equal(PROTECT_MAX_BUFFER, 256 * 1024 * 1024);
  assert.ok(PROTECT_MAX_BUFFER >= 64 * 1024 * 1024, 'not smaller than the request body limit of the recovery endpoint');
});
