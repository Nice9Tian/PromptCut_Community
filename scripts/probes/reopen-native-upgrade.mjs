/** Apply the committed patch installer to an owned native fixture after normal exit.
 * This exercises a real Node runtime update; it does not install an NSIS bundle,
 * register a file association, or alter the user's installation.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nativeTestEnv } from './reopen-native-fixture.mjs';

const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = args => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
function inside(root, file) {
  const rel = path.relative(root, file);
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'owned fixture path required');
}
function copy(source, target, root) {
  inside(root, target);
  const st = fs.lstatSync(source);
  assert(!st.isSymbolicLink(), 'fixture refuses links');
  if (st.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(target, name), root);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}
function inventory(dir, base = dir, files = {}) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), 'protected fixture state refuses links');
    if (stat.isDirectory()) inventory(file, base, files);
    else files[path.relative(base, file).replaceAll('\\', '/')] = sha(file);
  }
  return files;
}
async function powershell(args, log, env) {
  const started = Date.now(), output = fs.createWriteStream(log);
  // A Node child inherits PowerShell 7's module path without its legacy-shell
  // normalization. Use the Windows 5.1 modules in this child only.
  const systemShell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0');
  const childEnv = nativeTestEnv(env);
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'PSMODULEPATH') delete childEnv[key];
  childEnv.PSModulePath = path.join(systemShell, 'Modules');
  const child = spawn(path.join(systemShell, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await new Promise(resolve => output.end(resolve));
  return { code, elapsedMs: Date.now() - started, logSha256: sha(log) };
}

export async function upgradeNativeFixture(fixture, runRoot, { nsisWrapper = false } = {}) {
  assert.equal(process.platform, 'win32');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'committed source required');
  assert.equal(path.dirname(fs.realpathSync(fixture.root)), fs.realpathSync(os.tmpdir()));
  assert(path.basename(fixture.root).startsWith('pc-reopen-native-'));
  inside(fixture.root, runRoot);
  const sourceCommit = git(['rev-parse', 'HEAD']), entry = fixture.copies[1];
  inside(fixture.root, entry.runtime); inside(fixture.root, entry.exe);
  const installDir = path.dirname(entry.exe), app = path.join(entry.runtime, 'app');
  assert.equal(fs.realpathSync(installDir), installDir);
  const patchRoot = fs.mkdtempSync(path.join(runRoot, 'runtime-update-'));
  const payload = path.join(patchRoot, 'payload'); fs.mkdirSync(payload);
  const paths = execFileSync('git', ['ls-files', '-z'], { windowsHide: true }).toString().split('\0').filter(Boolean);
  for (const name of paths) {
    if (/^(?:desktop|docs|\.claude|\.github)\//.test(name) || /^\.(?:env|dev\.vars|npmrc)/.test(name)) continue;
    copy(path.resolve(name), path.join(payload, name), fixture.root);
  }
  // The existing verified web build is unchanged by this probe-only addition.
  assert(fs.existsSync('dist/index.html'), 'verified web build required');
  copy(path.resolve('dist'), path.join(payload, 'dist'), fixture.root);
  const lockHash = sha(path.join(payload, 'package-lock.json'));
  assert.equal(sha(path.join(app, 'package-lock.json')), lockHash, 'this probe updates code without changing dependencies');
  const oldProbe = path.join(app, 'src/editor/probeRunner.ts'), oldProbeSha256 = sha(oldProbe);
  const newProbeSha256 = sha(path.join(payload, 'src/editor/probeRunner.ts'));
  assert.notEqual(oldProbeSha256, newProbeSha256, 'the fixture must actually contain older code');
  const shell = path.join(installDir, 'promptcut.exe');
  if (!fs.existsSync(shell)) copy(entry.exe, shell, fixture.root);
  assert.equal(sha(shell), fixture.exeSha256);
  const versions = path.join(entry.runtime, 'VERSIONS.json');
  const appVersion = JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8')).version;
  if (fs.existsSync(versions)) {
    const previous = JSON.parse(fs.readFileSync(versions, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(previous.fixtureSource, fixture.sourceCommit);
    assert.equal(previous.app, appVersion);
    assert(!previous.patchedAt, 'only an untouched preparation from a failed attempt may be reused');
  } else fs.writeFileSync(versions, JSON.stringify({ app: appVersion, fixtureSource: fixture.sourceCommit, chrome: 'fixture', ffmpeg: 'fixture', python: 'fixture' }));
  const protectedDirs = ['data', 'member'].map(name => path.join(runRoot, name));
  const before = protectedDirs.map(dir => inventory(dir));
  assert(before[0]['device.json'] && Object.keys(before[0]).some(name => name.startsWith('collaboration/')), 'real persisted device and recovery state required');
  const preflight = path.join(patchRoot, 'preflight.ps1');
  // Abort before calling the real installer if its process-shutdown branch could run.
  // No UI automation, process termination, or user runtime access occurs in this probe.
  fs.writeFileSync(preflight, `$ErrorActionPreference='Stop'\n$root=${"'" + installDir.replaceAll("'", "''") + "'"}\n$found=@(Get-CimInstance Win32_Process -Filter \"Name = 'promptcut.exe' OR Name = 'node.exe'\" | Where-Object { $_.Name -ieq 'promptcut.exe' -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0) })\nif ($found.Count -gt 0) { exit 73 }\nexit 0\n`);
  const checked = await powershell(['-File', preflight], path.join(patchRoot, 'preflight.log'), {});
  assert.equal(checked.code, 0, 'runtime must be fully stopped; no process may be terminated by the installer');
  const files = inventory(payload);
  fs.writeFileSync(path.join(patchRoot, 'patch.json'), JSON.stringify({ format: 'promptcut-patch/1', appVersion, shellGeneration: '0.2', minShellVersion: '0.2.0', includesDeps: false, lockHash, builtAt: new Date().toISOString(), files, removed: [] }));
  const installer = path.join(patchRoot, 'apply-patch.ps1');
  copy(path.resolve('desktop/scripts/apply-patch.ps1'), installer, fixture.root);
  const installerSha256 = sha(installer);
  let applied, wrapper;
  if (nsisWrapper) {
    const compiler = path.join(process.env.LOCALAPPDATA, 'tauri/NSIS/Bin/makensis.exe');
    assert(fs.existsSync(compiler), 'existing NSIS compiler required; this probe never installs it');
    const wrapperSource = path.resolve('desktop/scripts/patch-installer.nsi');
    const executable = path.join(runRoot, 'owned-patch.exe');
    const buildLog = path.join(runRoot, 'nsis-build.log');
    const buildStream = fs.createWriteStream(buildLog);
    const child = spawn(compiler, [`-DVERSION=${appVersion}`, `-DSRCDIR=${patchRoot}`,
      `-DOUTFILE=${executable}`, `-DICON=${path.resolve('desktop/src-tauri/icons/icon.ico')}`, wrapperSource], {
      windowsHide: true, env: nativeTestEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(buildStream, { end: false }); child.stderr.pipe(buildStream, { end: false });
    const buildStarted = Date.now();
    const buildCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await new Promise(resolve => buildStream.end(resolve));
    assert.equal(buildCode, 0, 'committed NSIS wrapper must compile');
    const started = Date.now();
    const systemShell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0');
    const childEnv = nativeTestEnv({ PROMPTCUT_PATCH_NONINTERACTIVE: '1', PROMPTCUT_PORT: String(fixture.port) });
    for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'PSMODULEPATH') delete childEnv[key];
    childEnv.PSModulePath = path.join(systemShell, 'Modules');
    const updater = spawn(executable, ['-InstallDir', installDir], {
      windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const applyLog = path.join(patchRoot, 'apply.log'), applyStream = fs.createWriteStream(applyLog);
    updater.stdout.pipe(applyStream, { end: false }); updater.stderr.pipe(applyStream, { end: false });
    const code = await new Promise((resolve, reject) => { updater.once('error', reject); updater.once('close', resolve); });
    await new Promise(resolve => applyStream.end(resolve));
    applied = { code, elapsedMs: Date.now() - started, logSha256: sha(applyLog) };
    wrapper = { sourceSha256: sha(wrapperSource), executableSha256: sha(executable),
      buildCode, buildElapsedMs: started - buildStarted, buildLogSha256: sha(buildLog),
      noninteractiveConsoleHidden: true, command: '<owned-patch.exe> -InstallDir <owned copy-B>' };
  } else {
    applied = await powershell(['-File', installer, '-InstallDir', installDir], path.join(patchRoot, 'apply.log'), {
      PROMPTCUT_PATCH_NONINTERACTIVE: '1', PROMPTCUT_PORT: String(fixture.port),
    });
  }
  assert.equal(applied.code, 0, 'real committed patch installer must succeed');
  assert.equal(sha(oldProbe), newProbeSha256, 'new runtime code must be installed');
  assert.equal(sha(entry.exe), fixture.exeSha256, 'native shell remains unchanged');
  for (const [name, hash] of Object.entries(files)) assert.equal(sha(path.join(app, name)), hash, 'installed payload integrity');
  assert.deepEqual(protectedDirs.map(dir => inventory(dir)), before, 'device credentials and room service state must remain byte-identical during the update');
  const metadata = JSON.parse(fs.readFileSync(versions, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(metadata.app, appVersion); assert.equal(metadata.patchLockHash, lockHash);
  const result = { ok: true, kind: nsisWrapper ? 'committed-nsis-patch-wrapper' : 'committed-powershell-patch-installer', sourceCommit, oldRuntimeSource: fixture.sourceCommit,
    appVersionBefore: appVersion, appVersionAfter: appVersion, sameVersionCodeUpdate: true, installerSha256,
    command: nsisWrapper ? '<owned-patch.exe> -InstallDir <owned copy-B>' : 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <owned patch>/apply-patch.ps1 -InstallDir <owned copy-B>',
    preflight: checked, applied, payloadFiles: Object.keys(files).length, oldProbeSha256, newProbeSha256,
    protectedStateUnchanged: true, shellUnchanged: true, noProcessShutdown: true, nsisInstallerTested: nsisWrapper, wrapper,
    userInstallationModified: false, fileAssociationModified: false };
  fs.writeFileSync(path.join(patchRoot, 'upgrade-evidence.json'), JSON.stringify(result, null, 2));
  return result;
}
