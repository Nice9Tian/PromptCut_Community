import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('actual vault SCRIPT admin passes only the route gate; body/token mandatory and unknown routes rejected', { skip: process.platform !== 'win32' }, async () => {
  const source = await fs.readFile(new URL('../../desktop/src-tauri/src/account_vault.rs', import.meta.url), 'utf8');
  const original = /const SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(source)[1].replace(/\r\n/g, '\n');
  // Keep the actual operation/route guards; replace only HTTP so this pure test
  // starts no listener and never sends a credential. Native TLS/IPC stays root's task.
  const at = original.indexOf('try {\n $file='); assert.ok(at > 0);
  const script = original.slice(0, at) + "function Http($path,$body,$token) { return @{ok=$true;routeReached=$path} }\n" + original.slice(at);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-queue-native-route-'));
  const run = args => new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.resume();
    child.once('error', reject); child.once('close', code => { try { assert.equal(code, 0); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ directory, operation: 'request', args }));
  });
  try {
    assert.equal((await run({ path: '/hosted/shared/account/admin', accessToken: 'ram-fixture', body: {} })).routeReached, '/hosted/shared/account/admin');
    for (const args of [{ path: '/hosted/shared/account/admin', body: {} }, { path: '/hosted/shared/account/admin', accessToken: 'ram-fixture' },
      { path: '/hosted/shared/account/unknown', accessToken: 'ram-fixture', body: {} }]) assert.equal((await run(args)).ok, false);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
