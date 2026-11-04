/**
 * Test cases for HT7 probe `scripts/probes/ht7-probe.mjs` itself (real verification on Alibaba Cloud
 * is run by the lead session after deployment).
 * Run: node --test server/test/ht7-probe.test.mjs
 *
 * - Without `--base`: does not connect to any address, exit code 2;
 * - Against the local hosted bundle (`PROMPTCUT_TRUST_LOOPBACK=0` plus cluster token): all five
 *   items pass, exit code 0;
 * - Against the hosted bundle that trusts loopback (`=1`): hitting from loopback is naturally not
 *   rejected, probe reports failure, exit code 1 (showing it can truly distinguish).
 * The latter two require the local trust switch to be in place (assumption H13).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { SKIP_TRUST, ROOT, runHostedMain } from './ht-kit.mjs';

const PROBE = path.join(ROOT, 'scripts', 'probes', 'ht7-probe.mjs');

function runProbe(args) {
  const child = spawn(process.execPath, [PROBE, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  return new Promise((resolve) => child.once('exit', (code) => {
    const last = out.trim().split('\n').at(-1);
    let result = null;
    try { result = JSON.parse(last); } catch { result = null; }
    resolve({ code, out, result });
  }));
}

async function hosted(t, trust) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ht7-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const r = await runHostedMain(t, { PROMPTCUT_DATA_DIR: d, PROMPTCUT_TRUST_LOOPBACK: trust, PROMPTCUT_CLUSTER_TOKEN: crypto.randomBytes(32).toString('base64url') });
  assert.equal(r.code, null, r.out.slice(-1500));
  return ['--base', `http://127.0.0.1:${r.doc}`, '--asset', `http://127.0.0.1:${r.asset}/api/asset`, '--admin', `http://127.0.0.1:${r.asset}`, '--timeout-ms', '5000'];
}

test('HT7-probe-no-base without --base: connects to no address, exit code 2', async () => {
  const r = await runProbe([]);
  assert.equal(r.code, 2);
  assert.equal(r.result?.error, 'usage');
});

test('HT7-probe-local local hosted setup, trust switch 0: all five anonymous rejections pass, exit code 0', { skip: SKIP_TRUST, timeout: 60_000 }, async (t) => {
  const r = await runProbe(await hosted(t, '0'));
  assert.equal(r.code, 0, r.out);
  assert.equal(r.result.ok, true);
  assert.deepEqual(r.result.checks.map((c) => [c.name, c.ok]), [
    ['ws-anonymous', true], ['ws-bad-token', true], ['asset-anonymous', true], ['admin-no-token', true], ['admin-bad-token', true],
  ]);
});

test('HT7-probe-discriminates a setup that trusts loopback (=1) hit from loopback: the probe reports failure, exit code 1', { skip: SKIP_TRUST, timeout: 60_000 }, async (t) => {
  const r = await runProbe(await hosted(t, '1'));
  assert.equal(r.code, 1, r.out);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.checks.find((c) => c.name === 'ws-anonymous').status, 101);
});
