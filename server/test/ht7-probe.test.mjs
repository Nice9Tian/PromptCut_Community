/**
 * HT7 探针 `scripts/probes/ht7-probe.mjs` 自身的用例（阿里云上的真核对由主会话在部署后跑）。
 * 跑：node --test server/test/ht7-probe.test.mjs
 *
 * - 不给 `--base`：不连任何地址，退出码 2；
 * - 对着本机的托管组合（`PROMPTCUT_TRUST_LOOPBACK=0` 加集群令牌）：五项全过，退出码 0；
 * - 对着信任回环的托管组合（`=1`）：从回环敲当然不被拒，探针报失败，退出码 1（说明它真能分辨）。
 * 后两条要本机信任开关到位（假设 H13）。
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

test('HT7-probe-no-base 不给 --base：不连任何地址，退出码 2', async () => {
  const r = await runProbe([]);
  assert.equal(r.code, 2);
  assert.equal(r.result?.error, 'usage');
});

test('HT7-probe-local 本机托管组合、信任开关 0：五项匿名拒绝全过，退出码 0', { skip: SKIP_TRUST, timeout: 60_000 }, async (t) => {
  const r = await runProbe(await hosted(t, '0'));
  assert.equal(r.code, 0, r.out);
  assert.equal(r.result.ok, true);
  assert.deepEqual(r.result.checks.map((c) => [c.name, c.ok]), [
    ['ws-anonymous', true], ['ws-bad-token', true], ['asset-anonymous', true], ['admin-no-token', true], ['admin-bad-token', true],
  ]);
});

test('HT7-probe-discriminates 信任回环的组合（=1）从回环敲：探针报失败，退出码 1', { skip: SKIP_TRUST, timeout: 60_000 }, async (t) => {
  const r = await runProbe(await hosted(t, '1'));
  assert.equal(r.code, 1, r.out);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.checks.find((c) => c.name === 'ws-anonymous').status, 101);
});
