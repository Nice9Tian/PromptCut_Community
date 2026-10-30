import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const memberPath = '/hosted/shared/account/members';
const projectPaths = [
  '/hosted/shared/account/create',
  '/hosted/shared/account/join',
  '/hosted/shared/account/session',
  '/hosted/shared/account/admin',
  memberPath,
];

function powershellEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  env.PSModulePath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return env;
}

test('actual account vault SCRIPT allows the exact members POST route and preserves route guards', { skip: process.platform !== 'win32' }, async () => {
  const source = await fs.readFile(new URL('../../desktop/src-tauri/src/account_vault.rs', import.meta.url), 'utf8');
  const original = /const SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(source)?.[1]?.replace(/\r\n/g, '\n');
  assert.ok(original, 'extracts the embedded SCRIPT from the real Rust source');

  // The Rust bridge still turns a present body into POST/JSON and forwards only
  // the supplied account token as Bearer; this test replaces transport below.
  assert.match(original, /\$request\.Method=if \(\$null -eq \$body\) \{ \[Net\.Http\.HttpMethod\]::Get \} else \{ \[Net\.Http\.HttpMethod\]::Post \}/);
  assert.match(original, /\[Net\.Http\.StringContent\]::new\([\s\S]*?'application\/json'\)/);
  assert.match(original, /\$request\.Headers\.Authorization=.*AuthenticationHeaderValue\]::new\('Bearer',\$token\)/);
  assert.match(source, /if input\.len\(\) > 1024 \* 1024/);
  assert.match(source, /webview\.label\(\) != "main"[\s\S]*?binding\.origin/);

  const httpStart = original.indexOf('function Http(');
  const operationStart = original.indexOf('\ntry {', httpStart);
  assert.ok(httpStart > 0 && operationStart > httpStart, 'finds the HTTP function and the real request operation');
  // Keep the actual request/path/token/body guards. Replace only outbound HTTP
  // with an in-process response shim; no socket or listener is opened.
  const script = original.slice(0, httpStart) + `function Http($path,$body,$token) {
  return @{ ok=$true; routeReached=$path; requestMethod=if ($null -eq $body) { 'GET' } else { 'POST' }; hasToken=[bool]$token; hasBody=$null -ne $body }
}` + original.slice(operationStart);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-account-member-native-route-'));
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: powershellEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (bytes) => { stdout += bytes; });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`PowerShell exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ directory, operation: 'request', args }));
  });

  try {
    const member = await run({ path: memberPath, accessToken: 'account-route-fixture-token', body: { projectId: 'fixture-project' } });
    assert.deepEqual(member, { ok: true, routeReached: memberPath, requestMethod: 'POST', hasToken: true, hasBody: true });

    for (const path of projectPaths.filter((candidate) => candidate !== memberPath)) {
      const result = await run({ path, accessToken: 'account-route-fixture-token', body: {} });
      assert.equal(result.routeReached, path, `${path} remains allowed`);
      assert.equal(result.requestMethod, 'POST');
      assert.equal(result.hasToken, true);
      assert.equal(result.hasBody, true);
    }

    const consentGet = await run({ path: '/api/account/cloud-agent-consent', accessToken: 'account-route-fixture-token' });
    assert.equal(consentGet.routeReached, '/api/account/cloud-agent-consent');
    assert.equal(consentGet.requestMethod, 'GET');
    const consentPost = await run({ path: '/api/account/cloud-agent-consent', accessToken: 'account-route-fixture-token', body: { accept: true, noticeVersion: 1, requestId: 'native-route-fixture' } });
    assert.equal(consentPost.routeReached, '/api/account/cloud-agent-consent');
    assert.equal(consentPost.requestMethod, 'POST');

    const rejected = [
      [{ path: memberPath, body: {} }, 'missing token'],
      [{ path: memberPath, accessToken: 'account-route-fixture-token' }, 'missing body maps to GET'],
      [{ path: memberPath, accessToken: 'account-route-fixture-token', body: null }, 'explicit GET has no body'],
      [{ path: '/HOSTED/shared/account/members', accessToken: 'account-route-fixture-token', body: {} }, 'case variant'],
      [{ path: `${memberPath}/`, accessToken: 'account-route-fixture-token', body: {} }, 'suffix'],
      [{ path: `/prefix${memberPath}`, accessToken: 'account-route-fixture-token', body: {} }, 'prefix'],
      [{ path: `${memberPath}?x=1`, accessToken: 'account-route-fixture-token', body: {} }, 'query suffix'],
      [{ path: '/hosted/shared/account/unknown', accessToken: 'account-route-fixture-token', body: {} }, 'unknown route'],
      [{ path: '/api/account/cloud-agent-consent', accessToken: 'account-route-fixture-token', body: { accept: false, noticeVersion: 1, requestId: 'native-route-fixture' } }, 'invalid consent body remains rejected'],
    ];
    for (const [args, label] of rejected) {
      const result = await run(args);
      assert.equal(result.ok, false, `${label} is rejected before HTTP`);
      assert.equal(Object.hasOwn(result, 'routeReached'), false, `${label} never reaches HTTP`);
    }

    assert.deepEqual(await fs.readdir(directory), [], 'request-only script writes no vault files');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
