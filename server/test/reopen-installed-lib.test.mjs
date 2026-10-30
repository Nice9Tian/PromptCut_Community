/**
 * 真实安装验收探针里决定「这次启动算不算数」的判定（`scripts/probes/reopen-installed-lib.mjs`）。
 * 只测纯函数与临时目录，不查注册表、不起进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { debuggingPort, installedIdentity, launchReceipt, verifyPayload } from '../../scripts/probes/reopen-installed-lib.mjs';

const exe = path.join(os.tmpdir(), 'PromptCut', 'promptcut.exe'), file = path.join(os.tmpdir(), 'run', 'files', 'original-host.proc');
const row = (over = {}) => ({ pid: 4321, exe, commandLine: `"${exe}" "${file}"`, createdAt: '2026-10-05T12:00:05.000Z',
  parentPid: 100, parentName: 'explorer.exe', parentCreatedAt: '2026-10-05T08:00:00.000Z', ...over });
const expected = { exe, file, armedAt: '2026-10-05T12:00:00.000Z', parentName: 'explorer.exe' };

test('RIL-1 调试端口从 WebView2 命令行里取,取不到或越界返回 null', () => {
  assert.equal(debuggingPort('msedgewebview2.exe --embedded-browser-webview=1 --remote-debugging-port=51234 --lang=zh-CN'), 51234);
  assert.equal(debuggingPort('--remote-debugging-port=0'), null);
  assert.equal(debuggingPort('--remote-debugging-port=99999'), null);
  assert.equal(debuggingPort('--remote-debugging-port=512345'), null, '六位数不截成五位');
  assert.equal(debuggingPort('--other=1'), null);
  assert.equal(debuggingPort(undefined), null);
});

test('RIL-2 回执四个条件:安装目录的程序、命令行带文件、就绪之后创建、父进程是资源管理器', () => {
  assert.deepEqual(launchReceipt(row(), expected), { ok: true, reasons: [] });
  assert.deepEqual(launchReceipt(row({ exe: exe.toUpperCase(), commandLine: `"${exe}" "${file.toUpperCase()}"`, parentName: 'Explorer.EXE' }), expected).ok, true, 'Windows 上不分大小写');
  assert.deepEqual(launchReceipt(row({ exe: path.join(os.tmpdir(), 'other', 'promptcut.exe') }), expected).reasons, ['another executable']);
  assert.deepEqual(launchReceipt(row({ commandLine: `"${exe}"` }), expected).reasons, ['command line lacks the file']);
  assert.deepEqual(launchReceipt(row({ commandLine: `"${exe}" "${file}.bak"`.replace('original-host.proc.bak', 'another.proc') }), expected).reasons, ['command line lacks the file']);
  assert.deepEqual(launchReceipt(row({ createdAt: '2026-10-05T11:59:59.999Z' }), expected).reasons, ['started before the hand-off was armed']);
  assert.deepEqual(launchReceipt(row({ parentName: 'node.exe' }), expected).reasons, ['parent is node.exe, not explorer.exe']);
  assert.deepEqual(launchReceipt(row({ parentName: null }), expected).reasons, ['parent is unknown, not explorer.exe']);
});

test('RIL-3 进程号被别的程序重用时不认它当父进程;来不及读到详情的启动不算数', () => {
  assert.deepEqual(launchReceipt(row({ parentCreatedAt: '2026-10-05T12:00:06.000Z' }), expected).reasons, ['parent is younger than the launched process']);
  assert.deepEqual(launchReceipt({ pid: 77, exitedBeforeQuery: true }, expected).ok, false);
  assert.deepEqual(launchReceipt(null, expected), { ok: false, reasons: ['no process'] });
  // 探针自己请资源管理器打开时,认它启动的那个帮手进程号;帮手已退出、查不到名字也认,别的进程号不认
  assert.deepEqual(launchReceipt(row({ parentName: null, parentCreatedAt: null, parentPid: 555 }), { ...expected, parentPid: 555 }), { ok: true, reasons: [] });
  assert.deepEqual(launchReceipt(row({ parentName: null, parentCreatedAt: null, parentPid: 556 }), { ...expected, parentPid: 555 }).reasons, ['parent is unknown, not explorer.exe']);
  assert.deepEqual(launchReceipt(row({ parentPid: 555, commandLine: '' }), { ...expected, parentPid: 555 }).reasons, ['command line lacks the file']);
  const all = launchReceipt(row({ exe: 'C:/x/y.exe', commandLine: '', createdAt: '2026-10-05T11:00:00Z', parentName: 'cmd.exe' }), expected).reasons;
  assert.equal(all.length, 4, '每个不成立的条件都列出来');
});

function installed({ appSrcHash = 'a'.repeat(64), version = '0.7.14', exeName = 'promptcut.exe' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-identity-')), app = path.join(dir, 'runtime', 'app');
  fs.mkdirSync(path.join(app, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, exeName), 'shell'); fs.writeFileSync(path.join(app, 'package.json'), '{"version":"0.7.14"}'); fs.writeFileSync(path.join(app, 'server/a.mjs'), 'export {}');
  fs.writeFileSync(path.join(dir, 'runtime', 'VERSIONS.json'), JSON.stringify({ app: version, appSrcHash }));
  const sha = f => createHash('sha256').update(fs.readFileSync(path.join(app, f))).digest('hex');
  const manifest = { appVersion: '0.7.14', files: { 'package.json': sha('package.json'), 'server/a.mjs': sha('server/a.mjs') } };
  return { dir, app, manifest, association: { exe: path.join(dir, exeName), progId: 'PromptCut Project', userChoice: null } };
}

test('RIL-4 已装的就是清单那一份:运行副本摘要一致且逐文件对上才算', () => {
  const f = installed();
  const good = installedIdentity(f.association, { manifest: f.manifest, appSrcHash: 'a'.repeat(64) });
  assert.equal(good.ok, true); assert.deepEqual(good.payload, { files: 2, missing: 0, mismatched: 0, sample: [] });
  assert.equal(good.installDir, fs.realpathSync(f.dir)); assert.match(good.exeSha256, /^[0-9a-f]{64}$/);

  assert.deepEqual(installedIdentity(f.association, { manifest: f.manifest, appSrcHash: 'b'.repeat(64) }).reasons, ['installed runtime is not the candidate (appSrcHash differs)']);
  fs.writeFileSync(path.join(f.app, 'server/a.mjs'), 'export const changed = 1');
  fs.renameSync(path.join(f.app, 'package.json'), path.join(f.dir, 'moved.json'));
  assert.deepEqual(verifyPayload(f.app, f.manifest), { files: 2, missing: ['package.json'], mismatched: ['server/a.mjs'] });
  assert.deepEqual(installedIdentity(f.association, { manifest: f.manifest, appSrcHash: 'a'.repeat(64) }).reasons, ['installed files differ from the manifest (1 missing, 1 changed)']);
});

test('RIL-5 关联指向别的程序、被用户选择覆盖、或根本没有安装时都拒绝', () => {
  const other = installed({ exeName: 'promptcut-recovery-test.exe' });
  assert.deepEqual(installedIdentity(other.association, { manifest: other.manifest, appSrcHash: 'a'.repeat(64) }).reasons, ['.proc opens promptcut-recovery-test.exe']);
  const chosen = installed(); chosen.association.userChoice = 'Applications\\notepad.exe';
  assert.deepEqual(installedIdentity(chosen.association, { manifest: chosen.manifest, appSrcHash: 'a'.repeat(64) }).reasons, ['a per-user choice overrides the installed association']);
  assert.deepEqual(installedIdentity({ exe: null }, { manifest: { files: {} }, appSrcHash: 'x' }), { ok: false, reasons: ['.proc has no installed program'] });
  assert.deepEqual(installedIdentity({ exe: path.join(os.tmpdir(), 'missing', 'promptcut.exe') }, { manifest: { files: {} }, appSrcHash: 'x' }).ok, false);
  const patched = installed(); const versionsFile = path.join(patched.dir, 'runtime', 'VERSIONS.json');
  fs.writeFileSync(versionsFile, String.fromCharCode(0xFEFF) + fs.readFileSync(versionsFile, 'utf8'));
  assert.equal(installedIdentity(patched.association, { manifest: patched.manifest, appSrcHash: 'a'.repeat(64) }).ok, true, '带字节序标记的 VERSIONS.json 照常读');
  fs.writeFileSync(versionsFile, 'not json');
  assert.deepEqual(installedIdentity(patched.association, { manifest: patched.manifest, appSrcHash: 'a'.repeat(64) }).reasons, ['installed runtime has no readable VERSIONS.json']);
  const old = installed({ version: '0.7.13' });
  assert.deepEqual(installedIdentity(old.association, { manifest: old.manifest, appSrcHash: 'a'.repeat(64) }).reasons, ['installed application version differs from the manifest']);
});
