import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { resolveCli, cliCommand, cliEnv } from '../runners/cli-runtime.mjs';
import { createSetupService, authUrlFrom, normalizeAuthCode } from '../runners/setup.mjs';
import { probeAuth } from '../runners/auth.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-cli-test-'));
const previousRoot = process.env.PROMPTCUT_CLI_HOME;
process.env.PROMPTCUT_CLI_HOME = path.join(root, '中文 user & space');
test.after(() => {
  if (previousRoot === undefined) delete process.env.PROMPTCUT_CLI_HOME;
  else process.env.PROMPTCUT_CLI_HOME = previousRoot;
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('promptcut-cli-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.fail('timed out'); }
function fakeService(options = {}) {
  const calls = [];
  const service = createSetupService({
    launch(command, args, opts) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      // 只有任务要求把标准输入接成管道(stdio[0] === 'pipe')才有 stdin,和真的 spawn 一致。
      if (opts?.stdio?.[0] === 'pipe') {
        child.stdin = new PassThrough();
        child.stdin.written = '';
        child.stdin.on('data', chunk => { child.stdin.written += chunk.toString(); });
      }
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)); };
      calls.push({ command, args, opts, child });
      return child;
    },
    verifyInstall: async () => {}, verifyVersion: async () => {},
    verifyAuth: async () => ({ loggedIn: true }), ...options,
  });
  return { service, calls };
}

test('finds a newly installed executable without PATH or cached misses', () => {
  const home = path.join(root, 'another 用户');
  const opts = { home, env: {}, root: path.join(root, 'managed'), platform: 'win32', lookup() { throw new Error('no PATH'); } };
  assert.equal(resolveCli('claude', opts), 'claude');
  const exe = path.join(home, '.local', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
  assert.equal(resolveCli('claude', opts), exe);
});

test('does not mistake Codex Desktop internal runtime for an installed CLI', () => {
  const local = path.join(root, 'LocalAppData');
  const desktop = path.join(local, 'OpenAI', 'Codex', 'bin', 'internal', 'codex.exe');
  fs.mkdirSync(path.dirname(desktop), { recursive: true }); fs.writeFileSync(desktop, '');
  const result = resolveCli('codex', {
    env: { LOCALAPPDATA: local }, home: path.join(root, 'home'), root: path.join(root, 'managed-missing'), platform: 'win32',
    lookup: () => desktop,
  });
  assert.equal(result, 'codex');
});

test('npm shim uses bundled Node and preserves JSON and shell metacharacters', () => {
  const bin = path.join(root, 'npm 中文 & spaced');
  const pkg = path.join(bin, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'cli.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  const args = ['a & b', '配置文件', '{"path":"C:\\space here","value":"$HOME"}', 'a"b', 'line\nbreak'];
  const cmd = cliCommand(path.join(bin, 'codex.cmd'), args, 'win32');
  assert.equal(cmd.command, process.execPath);
  assert.deepEqual(JSON.parse(execFileSync(cmd.command, cmd.args, { encoding: 'utf8' })), args);
});

test('Codex home is created and inherited PowerShell module paths are removed', () => {
  const env = cliEnv('codex', { CODEX_HOME: 'unrelated desktop', PSModulePath: 'powershell7', Path: 'custom' });
  assert.notEqual(env.CODEX_HOME, 'unrelated desktop');
  assert.ok(fs.existsSync(env.CODEX_HOME));
  assert.equal(env.PSModulePath, undefined);
  assert.ok(env.Path.endsWith('custom'));
});

// 桌面外壳为了不让 Vite 自己开浏览器,给后台进程设了 BROWSER=none;这个值传给登录命令,
// Claude Code 就把 "none" 当成浏览器程序去找,找不到,登录页不弹(2026-10-06 用户真机)。
test('the BROWSER=none marker set by the desktop shell is not passed on to a CLI, a real browser choice is', () => {
  for (const provider of ['claude', 'codex', 'agy']) {
    assert.equal(cliEnv(provider, { BROWSER: 'none', Path: 'custom' }).BROWSER, undefined, provider);
    assert.equal(cliEnv(provider, { Browser: ' None ', Path: 'custom' }).Browser, undefined, provider);
  }
  const firefox = String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`;
  assert.equal(cliEnv('claude', { BROWSER: firefox, Path: 'custom' }).BROWSER, firefox);
  const base = { BROWSER: 'none', Path: 'custom' };
  cliEnv('claude', base);
  assert.equal(base.BROWSER, 'none', 'the environment object passed in is left alone');
});

// Claude Code 2.1.x 把登录页从 claude.ai 换到了 claude.com/cai/oauth/authorize。
test('Claude login link on claude.com is recognised, look-alike hosts are not', () => {
  const link = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y';
  const out = ['Opening browser to sign in…', `If the browser did not open, visit: ${link}`, 'Paste code here if prompted > '].join('\n');
  assert.equal(authUrlFrom(out, 'claude'), link);
  assert.equal(authUrlFrom('visit: https://claude.ai/oauth/authorize?x=1', 'claude'), 'https://claude.ai/oauth/authorize?x=1');
  assert.equal(authUrlFrom('https://claude.com.attacker.test/cai/oauth/authorize', 'claude'), undefined);
  assert.equal(authUrlFrom('https://evil-claude.com/cai/oauth/authorize', 'claude'), undefined);
  assert.equal(authUrlFrom(link, 'codex'), undefined);
});

test('deduplicates clicks and tracks providers independently', async () => {
  const { service, calls } = fakeService();
  const first = service.start('codex', 'install');
  assert.equal(service.start('codex', 'login').id, first.id);
  service.start('agy', 'install');
  assert.equal(calls.length, 2);
  calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'succeeded');
  assert.equal(service.list()[1].state, 'running');
  service.dispose(); await tick();
});

test('spawn error is reported, and retry creates a fresh job', async () => {
  const { service, calls } = fakeService();
  const first = service.start('codex', 'install');
  calls[0].child.emit('error', new Error('ENOENT'));
  await until(() => service.list()[0].state === 'failed');
  assert.match(service.list()[0].message, /ENOENT/);
  assert.notEqual(service.start('codex', 'install').id, first.id);
  service.dispose(); await tick();
});

test('exit zero is insufficient without successful binary verification', async () => {
  const { service, calls } = fakeService({ verifyInstall: async () => { throw new Error('binary missing'); } });
  service.start('agy', 'install'); calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'failed');
  assert.match(service.list()[0].message, /binary missing/);
});

test('login URL survives split chunks; raw output is never returned', async () => {
  const { service, calls } = fakeService();
  service.start('codex', 'login'); await until(() => calls.length === 1);
  calls[0].child.stderr.write('secret-token-value\nhttps://auth.');
  calls[0].child.stderr.write('openai.com/oauth/authorize?state=example\n');
  assert.equal(service.list()[0].url, 'https://auth.openai.com/oauth/authorize?state=example');
  assert.ok(!JSON.stringify(service.list()).includes('secret-token-value'));
  calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'succeeded');
  assert.equal(service.list()[0].url, undefined);
});

test('login is not marked successful without verified authentication', async () => {
  const { service, calls } = fakeService({ verifyAuth: async () => ({ loggedIn: false }) });
  service.start('claude', 'login'); await until(() => calls.length === 1);
  calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'failed');
});

test('Antigravity login uses a hidden ConPTY helper, never a visible shell', async () => {
  const { service, calls } = fakeService();
  service.start('agy', 'login'); await until(() => calls.length === 1);
  assert.equal(calls[0].command, process.execPath);
  assert.ok(calls[0].args[0].endsWith('agy-login.mjs'));
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.detached, undefined);
  calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'succeeded');
});

test('timeout stops the child and makes the operation retryable', async () => {
  const { service, calls } = fakeService({ timeoutMs: 30 });
  service.start('agy', 'install');
  await until(() => service.list()[0].state === 'failed');
  assert.equal(calls[0].child.killed, true);
  assert.match(service.list()[0].message, /超时/);
});

test('cancel waits for child exit before allowing retry', async () => {
  const { service, calls } = fakeService();
  const first = service.start('codex', 'install'); service.cancel('codex');
  assert.equal(service.start('codex', 'install').id, first.id);
  await until(() => service.list()[0].state === 'failed');
  assert.equal(calls[0].child.killed, true);
});

test('rejects arbitrary providers and untrusted login URL hosts', () => {
  const { service } = fakeService();
  assert.throws(() => service.start('__proto__', 'install'));
  assert.throws(() => service.start('codex & whoami', 'login'));
  assert.equal(authUrlFrom('https://auth.openai.com.attacker.test/login', 'codex'), undefined);
  assert.equal(authUrlFrom('https://user:pass@auth.openai.com/login', 'codex'), undefined);
});

test('Codex auth accepts status on stderr (actual child process)', { skip: process.platform !== 'win32' }, async () => {
  const appdata = path.join(root, 'roaming');
  const bin = path.join(appdata, 'npm'); const pkg = path.join(bin, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'cli.cjs'), 'console.error("Logged in using ChatGPT")');
  const before = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.APPDATA = appdata; process.env.LOCALAPPDATA = path.join(root, 'local');
  try { assert.equal((await probeAuth('codex', { refresh: true })).loggedIn, true); }
  finally { for (const [k,v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('Codex Desktop under Programs\ is excluded too, not just the where.exe hit', () => {
  // 这条路径曾经写在候选表里、当作合法 CLI 直接返回,而排除只写在 where.exe 那一支 ——
  // 候选表命中就 return,那道排除对它永远跑不到。
  const local = path.join(root, 'LocalAppData-programs');
  const desktop = path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(desktop), { recursive: true }); fs.writeFileSync(desktop, '');
  const result = resolveCli('codex', {
    env: { LOCALAPPDATA: local }, home: path.join(root, 'home'), root: path.join(root, 'managed-missing'), platform: 'win32',
    lookup: () => desktop,
  });
  assert.equal(result, 'codex');
});

// ---- 粘贴授权码:登录任务接上标准输入(2026-10-21 用户定做) ----
// 下面这串是测试里随手编的占位值,不是任何真实授权码。
const FAKE_CODE = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA_-.~#c3RhdGUtc3RhdGUtc3RhdGU9';

test('only Claude login gets a stdin pipe; other logins and installs keep stdin ignored', async () => {
  const { service, calls } = fakeService();
  service.start('claude', 'login'); service.start('codex', 'login'); service.start('agy', 'login');
  await until(() => calls.length === 3);
  const byProvider = new Map(calls.map(c => [c.child.setupJob.provider, c]));
  assert.equal(byProvider.get('claude').opts.stdio[0], 'pipe');
  assert.equal(byProvider.get('codex').opts.stdio[0], 'ignore');
  assert.equal(byProvider.get('agy').opts.stdio[0], 'ignore');
  for (const c of calls) assert.equal(c.opts.windowsHide, true);
  service.dispose(); await tick();
});

test('install jobs never get a stdin pipe', async () => {
  const { service, calls } = fakeService();
  service.start('claude', 'install'); await until(() => calls.length === 1);
  assert.equal(calls[0].opts.stdio[0], 'ignore');
  assert.equal(service.list()[0].acceptsCode, undefined);
  service.dispose(); await tick();
});

test('submitted code reaches the login process stdin as one line and is not exposed anywhere', async () => {
  const { service, calls } = fakeService();
  service.start('claude', 'login'); await until(() => calls.length === 1);
  const child = calls[0].child;
  assert.equal(service.list()[0].acceptsCode, true);
  const seen = [];
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map(name => { const orig = console[name]; console[name] = (...a) => seen.push(a.join(' ')); return [name, orig]; });
  const origWrite = process.stdout.write; process.stdout.write = (chunk) => { seen.push(String(chunk)); return true; };
  let view;
  try {
    view = service.submitCode('claude', '  ' + FAKE_CODE + '\n');
    // CLI 回显码或把它写进报错时,也不能经任务对外的字段出去。
    child.stdout.write('Paste code here if prompted > ' + FAKE_CODE + '\n');
    child.stderr.write('code ' + FAKE_CODE + ' rejected\n');
    await tick();
  } finally {
    process.stdout.write = origWrite;
    for (const [name, orig] of spies) console[name] = orig;
  }
  assert.equal(child.stdin.written, FAKE_CODE + '\n');
  assert.ok(!JSON.stringify(view).includes(FAKE_CODE));
  assert.ok(!JSON.stringify(service.list()).includes(FAKE_CODE));
  assert.ok(!seen.join('\n').includes(FAKE_CODE), 'the code must not be logged');
  service.dispose(); await tick();
});

test('malformed codes are refused before anything is written to the child', async () => {
  const { service, calls } = fakeService();
  service.start('claude', 'login'); await until(() => calls.length === 1);
  const bad = [
    '', '   ', 'short', 'a'.repeat(15), 'a'.repeat(513),
    FAKE_CODE.slice(0, 20) + ' ' + FAKE_CODE.slice(20),   // 中间有空格
    FAKE_CODE.slice(0, 20) + '\n' + 'calc.exe',            // 多行:第二行会变成命令行输入
    FAKE_CODE.slice(0, 20) + '\r\n' + FAKE_CODE.slice(20),
    FAKE_CODE + '"; whoami; "', FAKE_CODE + '&& dir', FAKE_CODE + '\x00', FAKE_CODE + '\x1b[31m',
    '密'.repeat(20), undefined, null, 12345678901234567890, { toString: () => FAKE_CODE }, [FAKE_CODE],
  ];
  for (const code of bad) {
    let message = '';
    assert.throws(() => service.submitCode('claude', code), error => { message = error.message; return /授权码格式不对/.test(message); });
    assert.ok(!message.includes(FAKE_CODE.slice(0, 20)), 'the error must not echo the input');
  }
  assert.equal(calls[0].child.stdin.written, '');
  assert.equal(normalizeAuthCode('  ' + FAKE_CODE + '  '), FAKE_CODE);
  service.dispose(); await tick();
});

test('code is refused when no login job is waiting for it', async () => {
  const { service, calls } = fakeService();
  assert.throws(() => service.submitCode('claude', FAKE_CODE), /没有在等授权码/);
  assert.throws(() => service.submitCode('__proto__', FAKE_CODE), /没有在等授权码/);
  service.start('codex', 'login'); await until(() => calls.length === 1);
  assert.throws(() => service.submitCode('codex', FAKE_CODE), /没有在等授权码/, 'codex login has no stdin pipe');
  service.start('claude', 'install'); await until(() => calls.length === 2);
  assert.throws(() => service.submitCode('claude', FAKE_CODE), /没有在等授权码/, 'install jobs never accept a code');
  calls[1].child.emit('close', 0);
  await until(() => service.list().find(j => j.provider === 'claude').state === 'succeeded');
  service.start('claude', 'login'); await until(() => calls.length === 3);
  service.cancel('claude');
  assert.throws(() => service.submitCode('claude', FAKE_CODE), /没有在等授权码/, 'a cancelled login no longer accepts a code');
  await until(() => service.list().find(j => j.provider === 'claude').state === 'failed');
  service.dispose(); await tick();
});

test('stdin is closed when the login finishes, fails, times out, is cancelled, or cannot start', async () => {
  for (const how of ['success', 'failure', 'timeout', 'cancel', 'error']) {
    const { service, calls } = fakeService(how === 'timeout' ? { timeoutMs: 30 } : {});
    service.start('claude', 'login'); await until(() => calls.length === 1);
    const { child } = calls[0];
    assert.equal(child.stdin.destroyed, false, how);
    if (how === 'success') child.emit('close', 0);
    else if (how === 'failure') child.emit('close', 1);
    else if (how === 'cancel') service.cancel('claude');
    else if (how === 'error') child.emit('error', new Error('boom'));
    await until(() => service.list()[0].state !== 'running');
    assert.equal(child.stdin.destroyed, true, how + ': stdin destroyed');
    assert.equal(service.list()[0].acceptsCode, false, how + ': no longer accepts a code');
    assert.throws(() => service.submitCode('claude', FAKE_CODE), /没有在等授权码/, how);
    service.dispose(); await tick();
  }
});

test('dispose closes the stdin of a running login too', async () => {
  const { service, calls } = fakeService();
  service.start('claude', 'login'); await until(() => calls.length === 1);
  service.dispose();
  await until(() => service.list()[0].state !== 'running');
  assert.equal(calls[0].child.stdin.destroyed, true);
});

test('a child that exits early does not crash the service when a code is written (EPIPE)', async () => {
  const { service, calls } = fakeService();
  service.start('claude', 'login'); await until(() => calls.length === 1);
  calls[0].child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  service.submitCode('claude', FAKE_CODE);
  calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'succeeded');
});

test('code submissions per login are capped', async () => {
  const { service, calls } = fakeService();
  service.start('claude', 'login'); await until(() => calls.length === 1);
  for (let i = 0; i < 5; i++) service.submitCode('claude', FAKE_CODE);
  assert.throws(() => service.submitCode('claude', FAKE_CODE), /次数太多/);
  assert.equal(calls[0].child.stdin.written, (FAKE_CODE + '\n').repeat(5));
  service.dispose(); await tick();
});

test('a retried login starts with a clean submission count and a fresh stdin', async () => {
  const { service, calls } = fakeService();
  service.start('claude', 'login'); await until(() => calls.length === 1);
  for (let i = 0; i < 5; i++) service.submitCode('claude', FAKE_CODE);
  calls[0].child.emit('close', 1);
  await until(() => service.list()[0].state === 'failed');
  service.start('claude', 'login'); await until(() => calls.length === 2);
  service.submitCode('claude', FAKE_CODE);
  assert.equal(calls[1].child.stdin.written, FAKE_CODE + '\n');
  service.dispose(); await tick();
});

test('real child process: the pasted code arrives on its stdin, and an unfinished login ends when stdin closes', async () => {
  // 真的 spawn 一个 Node 进程当「登录命令」:读一行标准输入,和期望值一致才以 0 退出。
  const script = `
    process.stdout.write('Paste code here if prompted > ');
    let data = '';
    process.stdin.on('data', c => { data += c; if (data.includes(String.fromCharCode(10))) process.exit(data.trim() === process.env.EXPECT_CODE ? 0 : 3); });
    process.stdin.on('end', () => process.exit(4));
  `;
  const real = (env) => createSetupService({
    launch: (_cmd, _args, opts) => spawn(process.execPath, ['-e', script], { ...opts, env: { ...process.env, ...env } }),
    verifyVersion: async () => {}, verifyAuth: async () => ({ loggedIn: true }),
  });
  const ok = real({ EXPECT_CODE: FAKE_CODE });
  ok.start('claude', 'login');
  await until(() => ok.list()[0]?.acceptsCode === true);
  ok.submitCode('claude', FAKE_CODE);
  await until(() => ok.list()[0].state !== 'running'); assert.equal(ok.list()[0].state, 'succeeded', ok.list()[0].message);
  assert.equal(ok.list()[0].acceptsCode, false);

  // 码不对:进程以 3 退出,任务失败,界面拿到的失败信息里没有码
  const wrong = real({ EXPECT_CODE: 'something-else-entirely' });
  wrong.start('claude', 'login');
  await until(() => wrong.list()[0]?.acceptsCode === true);
  wrong.submitCode('claude', FAKE_CODE);
  await until(() => wrong.list()[0].state === 'failed');
  assert.ok(!JSON.stringify(wrong.list()).includes(FAKE_CODE));

  // 取消:标准输入随任务关掉,进程不留着
  const cancelled = real({ EXPECT_CODE: FAKE_CODE });
  cancelled.start('claude', 'login');
  await until(() => cancelled.list()[0]?.acceptsCode === true);
  cancelled.cancel('claude');
  await until(() => cancelled.list()[0].state === 'failed');
});
