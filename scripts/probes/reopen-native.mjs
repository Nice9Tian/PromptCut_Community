/** Native argument/IPC and runtime-copy recovery acceptance. Own fixture only, no installation.
 * First build: node scripts/probes/reopen-native-fixture.mjs --build
 * Then run: node scripts/probes/reopen-native.mjs <fixture.json>
 * Add --member to exercise native member file arguments and IPC, with an isolated peer host.
 * Add --patch-upgrade to run the committed patch installer on stopped copy-B before reopening.
 * Add --nsis-patch-upgrade instead to build and run its committed NSIS wrapper silently.
 * The code update preserves the current version number and does not test an NSIS setup bundle.
 * --standalone-smoke verifies the private Explorer environment bootstrap via arguments only.
 * 操作系统默认关联的真双击不在这支探针里：在 PC 上临时改写 .proc 打开命令那条路 19 轮都没拿到回执，
 * 用户 2026-10-05 改定不再改写关联，改为在笔记本真实安装候选包、由安装器登记关联后在资源管理器真双击
 * （做法见 docs/plan/collaboration-reopen-installed-acceptance.md，探针 reopen-installed.mjs）。
 * 本探针只验参数与 IPC 两条路，它们不算默认关联双击的证据。
 * 原先的 --os-double-click / --allow-temporary-open-command / --allow-extended-association-lease /
 * --isolated-default-progid / --allow-temporary-default-progid 五个开关与配套脚本已于 2026-10-23 的探针总审删除
 * （报告 docs/reports/AGENT-claude-probe-audit.md）。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';
import { loadNativeFixture, nativeTestEnv } from './reopen-native-fixture.mjs';
import { upgradeNativeFixture } from './reopen-native-upgrade.mjs';
import { prepareStandaloneLaunch } from './reopen-native-association.mjs';

const fixture = loadNativeFixture(process.argv[2]);
const { port } = fixture;
const root = fs.mkdtempSync(path.join(fixture.root, 'run-'));
const nativeMember = process.argv.includes('--member');

assert.equal(port, 5203);
const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const secret = () => randomBytes(32).toString('base64url');
const password = secret(), creatorPassword = secret();
const children = new Set(), nativeConnections = new Set();
const isolatedSettings = {
  PROMPTCUT_AI_CONFIG: path.join(root, 'settings/ai.json'),
  PROMPTCUT_CLI_HOME: path.join(root, 'settings/cli'),
  PROMPTCUT_AGY_SETTINGS: path.join(root, 'settings/agy.json'),
  PROMPTCUT_CLAUDE_CONFIG: path.join(root, 'settings/claude.json'),
  PROMPTCUT_CODEX_CONFIG: path.join(root, 'settings/codex.toml'),
  PROMPTCUT_SKILL_DIR: path.join(root, 'skills'),
};
let browser, cloud, phase = 'start', createRequests = 0, runtimeUpgrade;
async function freePort(p) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', resolve); });
  const actual = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return actual;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; children.delete(child);
}
async function hosted(docPort = 0, assetPort = 0) {
  fs.mkdirSync(path.join(root, 'cloud'), { recursive: true });
  const url = pathToFileURL(path.resolve('cloud/server/hosted/combo.mjs')).href;
  const code = `import { startHostedCombo } from ${JSON.stringify(url)};
    const c = await startHostedCombo({ dataDir: process.env.PROMPTCUT_DATA_DIR, docPort: Number(process.env.PC_PROBE_DOC_PORT), assetPort: Number(process.env.PC_PROBE_ASSET_PORT), host: '127.0.0.1', trustLoopback: false, clusterToken: process.env.PROMPTCUT_CLUSTER_TOKEN, log: () => {} });
    console.log(JSON.stringify({ docPort:c.docPort, assetPort:c.assetPort }));
    process.stdin.resume(); process.stdin.on('end', () => c.close().then(() => process.exit(0)));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true,
    env: nativeTestEnv({ PROMPTCUT_DATA_DIR: path.join(root, 'cloud'), PROMPTCUT_CLUSTER_TOKEN: secret(), PC_PROBE_DOC_PORT: String(docPort), PC_PROBE_ASSET_PORT: String(assetPort) }), stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); child.stderr.resume();
  let ports, output = ''; child.stdout.on('data', b => { output += b; if (output.includes('\n') && !ports) ports = JSON.parse(output.split('\n')[0]); });
  await waitFor(() => { assert.equal(child.exitCode, null, 'own cloud exited'); return ports; }, 15000);
  return { ...ports, child, pid: child.pid, online: async () => (await (await fetch(`http://127.0.0.1:${ports.docPort}/hosting/healthz`)).json()).online === 1 };
}
async function memberProcess() {
  for (const p of [5206, 5207, 5208]) await freePort(p);
  const data = path.join(root, 'member'); fs.mkdirSync(data, { recursive: true });
  const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '5206', '--strictPort'], { cwd: process.cwd(), windowsHide: true,
    env: nativeTestEnv({ ...isolatedSettings, PROMPTCUT_DATA_DIR: data, PROMPTCUT_DOCSERVICE_DATA: path.join(data, 'docservice'), PROMPTCUT_EXPORT_DIR: path.join(data, 'export'), PROMPTCUT_PROJECTS_DIR: path.join(data, 'drafts'),
      PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_NO_PORT_FILE: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.stdout.resume(); child.stderr.resume();
  await waitFor(async () => { assert.equal(child.exitCode, null, 'own member exited'); try { return (await fetch('http://127.0.0.1:5206/api/docservice/device')).ok; } catch { return false; } }, 30000);
  return child;
}
async function observe(p) {
  p.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/shared/create')) createRequests++; });
  await p.waitForFunction(() => !!document.querySelector('.pc-app-shell'), { timeout: 30000 });
  await p.evaluate(async () => {
    const [sync, proc, store, collab] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts'), import('/src/editor/sync/collab.ts')]);
    window.probe = { sync, proc, store, collab }; await sync.startSync();
  });
  assert.equal(await p.evaluate(async () => {
    const data = await (await fetch('/api/ai/config')).json(), c = data.config ?? data;
    return !c.api?.apiKey?.set && !c.keys?.custom?.set && !c.keys?.router?.set;
  }), true, 'test app must not load user provider credentials');
  return p;
}
async function closeFirstRun(p) {
  // The panel belongs to Editor, and appears after provider discovery. Home has no such panel.
  await p.waitForSelector('.ais-dialog', { timeout: 60000 });
  const buttons = await p.$$('.ais-dialog button');
  const close = await Promise.all(buttons.map(b => b.evaluate(el => el.textContent?.trim() === '关闭')));
  assert.equal(close.filter(Boolean).length, 1, 'one actual first-run close control');
  await buttons[close.indexOf(true)].click();
  await p.waitForSelector('.ais-dialog', { hidden: true });
}
async function exposeRecoveryControl(p) {
  // A fresh native profile shows the optional speech-engine notification. Dismiss it
  // through its real Ignore control only when hit testing proves it covers recovery.
  const blockedBySpeechPrompt = await p.evaluate(() => {
    const b = document.querySelector('[data-pc="recovery-auth-open"]'), r = b?.getBoundingClientRect();
    return !!r && !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.dep-prompt');
  });
  if (blockedBySpeechPrompt) {
    await p.click('.dep-prompt button.dep-prompt-btn:not(.is-primary)');
    await p.waitForSelector('.dep-prompt', { hidden: true });
  }
  await p.waitForFunction(() => {
    const b = document.querySelector('[data-pc="recovery-auth-open"]'), r = b?.getBoundingClientRect();
    return !!r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-pc="recovery-auth-open"]') === b;
  });
  return blockedBySpeechPrompt;
}
async function native(copy, file = null) {
  phase = `native ${copy} test port preflight`;
  for (const p of [port, port + 1, port + 2]) await freePort(p);
  const cdpPort = await freePort(0), profile = path.join(root, `browser-${copy}`);
  assert.equal(fs.existsSync(profile), false, 'native restart must use an empty browser profile');
  const entry = fixture.copies[copy === 'A' ? 0 : 1];
  const launchEnv = nativeTestEnv({ ...isolatedSettings, PC_REOPEN_NATIVE_ROOT: root, PC_REOPEN_NATIVE_BROWSER_DIR: profile, PROMPTCUT_RUNTIME_DIR: entry.runtime, PROMPTCUT_AGENT_CDP: String(cdpPort),
    PROMPTCUT_PROJECTS_DIR: path.join(root, 'data/drafts'), PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_LAN_HOST: '0' });
  let child;
  {
    const standaloneSmoke = file && process.argv.includes('--standalone-smoke');
    if (standaloneSmoke) prepareStandaloneLaunch(process.argv[2],entry,file,launchEnv);
    child = spawn(entry.exe, file ? [file] : [], { cwd: path.dirname(entry.exe), windowsHide: true,
      env: standaloneSmoke ? nativeTestEnv() : launchEnv, stdio: ['ignore','pipe','pipe'] });
  }
  children.add(child); child.stdout.resume(); child.stderr.resume();
  phase = `native ${copy} start and debugging endpoint`;
  let connection;
  await waitFor(async () => { assert.equal(child.exitCode, null, 'isolated native shell exited'); try { connection = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null }); return true; } catch { return false; } }, 60000);
  nativeConnections.add(connection);
  phase = `native ${copy} editor navigation`;
  let p;
  await waitFor(async () => { p = (await connection.pages()).find(p => p.url().startsWith(`http://127.0.0.1:${port}/`)); return p; }, 60000);
  if (file) assert.equal(new URL(p.url()).searchParams.get('open'), file, 'native Rust argument must reach the original boot URL');
  phase = `native ${copy} real shell permissions`;
  await observe(p);
  if (file) await closeFirstRun(p);
  assert.equal(await p.evaluate(() => !!window.__TAURI__?.core?.invoke), true, 'actual Tauri shell required');
  const info = await p.evaluate(() => window.__TAURI__.core.invoke('agent_webview_info'));
  assert.equal(info.port, cdpPort, 'only our shell debugging endpoint may be connected');
  return { child, p, connection, pid: child.nativePid ?? child.pid, profile, entry, cdpPort };
}
async function quit(n) {
  const ended = new Promise(resolve => n.child.once('exit', resolve));
  await n.p.evaluate(() => window.__TAURI__.core.invoke('desktop_titlebar_command', { command: 'quit' })).catch(() => {});
  await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('own native exit timed out')), 15000))]);
  assert.equal(n.child.exitCode, 0, 'native normal exit required'); children.delete(n.child);
  n.connection.disconnect(); nativeConnections.delete(n.connection);
  await waitFor(async () => { try { for (const p of [port, port + 1, port + 2]) await freePort(p); return true; } catch { return false; } }, 15000);
}
const connected = (p, room, user) => p.waitForFunction((r, u) => { const v = window.probe.sync.getSyncView(); return v.shared?.projectId === r && v.shared.username === u && v.status === 'online'; }, { timeout: 30000 }, room, user);
const saved = p => p.evaluate(async () => { await window.probe.sync.whenSaved(); return window.probe.proc.serializeProc(); });
const name = (p, value) => p.evaluate(n => window.probe.store.actions.setProjectMeta({ name: n }), value);
const sees = (p, value) => p.waitForFunction(n => window.probe.store.getState().project.name === n, { timeout: 20000 }, value);
const open = (p, text) => p.evaluate(t => window.probe.store.actions.loadProject(window.probe.proc.loadProc(t), 'isolated-native.proc'), text);
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function memberPage() {
  const context = await browser.createBrowserContext(), p = await context.newPage();
  await p.goto('http://127.0.0.1:5206/?editor&nosetup=1', { waitUntil: 'domcontentloaded' }); return observe(p);
}
try {
  phase = 'start isolated cloud'; cloud = await hosted();
  phase = 'start own member browser';
  browser = await puppeteer.launch({ headless: true, userDataDir: path.join(root, 'member-browser'), args: ['--no-sandbox'] });
  const first = await native('A');
  await first.p.click('.sp-hero');
  phase = 'close native first-run Editor panel'; await closeFirstRun(first.p);
  const peerBefore = await memberProcess(), peer = await memberPage();
  let host = nativeMember ? peer : first.p, member = nativeMember ? first.p : peer;
  phase = 'create original native room and member';
  const created = await host.evaluate(o => window.probe.collab.enableCollab(o), { where: 'lan', mode: 'restricted', name: 'isolated-native-reopen', creator: { username: 'host', password: creatorPassword }, projectPassword: password, list: [{ username: 'member', password }], hostedUrl: `http://127.0.0.1:${cloud.docPort}` });
  assert.equal(created.ok, true, 'isolated native room creation');
  const hostFile = await saved(host), descriptor = JSON.parse(hostFile).collaboration, room = descriptor.roomId;
  phase = 'initial isolated host registration';
  await waitFor(() => cloud.online(), 10000);
  phase = 'initial native member needs authentication';
  await open(member, hostFile);
  await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'needs-auth');
  phase = 'initial member actual authentication UI';
  const optionalSpeechPromptDismissed = await exposeRecoveryControl(member);
  await member.screenshot({ path: path.join(root, 'native-auth-before-click.png') });
  await member.evaluate(() => {
    window.nativeAuthClicks = [];
    document.addEventListener('click', e => window.nativeAuthClicks.push({ button: !!e.target?.closest?.('[data-pc="recovery-auth-open"]'), tag: e.target?.tagName }), true);
    const b = document.querySelector('[data-pc="recovery-auth-open"]'), rect = b?.getBoundingClientRect();
    window.nativeAuthBefore = { count: document.querySelectorAll('[data-pc="recovery-auth-open"]').length,
      rect: rect?.toJSON(), hit: !!rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest?.('[data-pc="recovery-auth-open"]') === b };
  });
  await member.click('[data-pc="recovery-auth-open"]'); await member.waitForSelector('form[aria-label="恢复原协作身份"]');
  await member.type('form[aria-label="恢复原协作身份"] input[autocomplete="username"]', 'member');
  await member.type('form[aria-label="恢复原协作身份"] input[type="password"]', password);
  assert.equal(await member.evaluate(pw => {
    const form = document.querySelector('form[aria-label="恢复原协作身份"]');
    return form?.querySelector('input[autocomplete="username"]')?.value === 'member' && form?.querySelector('input[type="password"]')?.value === pw;
  }, password), true, 'actual UI inputs must receive authentication values');
  await member.click('form[aria-label="恢复原协作身份"] button[type="submit"]');
  phase = 'initial member authenticated sync';
  await connected(member, room, 'member'); const memberFile = await saved(member);
  const filePath = path.join(root, nativeMember ? 'original-member.proc' : 'original-host.proc');
  fs.writeFileSync(filePath, nativeMember ? memberFile : hostFile);
  const fileHash = sha(filePath), deviceFile = path.join(root, 'data/device.json'), deviceHash = sha(deviceFile);
  const peerDeviceFile = path.join(root, 'member/device.json'), peerDeviceHash = sha(peerDeviceFile);
  await name(member, 'native-member-before'); await sees(host, 'native-member-before');
  await name(host, 'native-host-before'); await sees(member, 'native-host-before'); await saved(host); await saved(member);
  phase = 'normal native exit, stop member and cloud'; await quit(first);
  if (!nativeMember) await waitFor(async () => !(await cloud.online()), 10000);
  await peer.close(); await stop(peerBefore);
  await waitFor(async () => !(await cloud.online()), 10000);
  const cloudBefore = cloud; await stop(cloud.child);
  if (process.argv.includes('--patch-upgrade') || process.argv.includes('--nsis-patch-upgrade')) {
    phase = 'apply committed installer to the stopped isolated runtime';
    runtimeUpgrade = await upgradeNativeFixture(fixture, root, { nsisWrapper: process.argv.includes('--nsis-patch-upgrade') });
  }
  cloud = await hosted(cloudBefore.docPort, cloudBefore.assetPort); assert.notEqual(cloud.pid, cloudBefore.pid);
  phase = 'other runtime copy with native original file argument and empty WebView profile';
  createRequests = 0;
  let second, peerAfter;
  if (nativeMember) {
    second = await native('B', filePath); member = second.p;
    await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'waiting-host', { timeout: 15000 });
    peerAfter = await memberProcess(); host = await memberPage(); await open(host, hostFile);
  } else {
    peerAfter = await memberProcess(); member = await memberPage(); await open(member, memberFile);
    await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'waiting-host', { timeout: 15000 });
    second = await native('B', filePath); host = second.p;
  }
  assert.notEqual(first.pid, second.pid); assert.notEqual(peerAfter.pid, peerBefore.pid);
  await connected(host, room, 'host'); await waitFor(() => cloud.online(), 15000); await connected(member, room, 'member');
  assert.equal(sha(deviceFile), deviceHash, 'stable native device identity across runtime directories');
  assert.equal(sha(peerDeviceFile), peerDeviceHash, 'stable peer identity across actual process restart');
  await sees(host, 'native-host-before'); await sees(member, 'native-host-before');
  await name(member, 'native-member-after'); await sees(host, 'native-member-after');
  await name(host, 'native-host-after'); await sees(member, 'native-host-after'); await saved(host); await saved(member);
  const binding = await second.p.evaluate(async () => { const v = window.probe.sync.getSyncView(), r = await window.probe.sync.recoveryRequest('select', v.association, { contentId: window.probe.store.getState().project.id }); return { creator: v.shared.creator, where: v.shared.where, hostBinding: !!r.host, rev: r.journal.rev }; });
  assert.equal(binding.creator, !nativeMember); assert.equal(binding.hostBinding, !nativeMember); assert.equal(binding.where, 'lan'); assert(binding.rev >= 5);
  phase = 'native second launch IPC reopens original file in existing instance';
  await second.p.evaluate(async target => {
    window.nativeOpenEvents = 0; window.nativeIpcOriginalLink = window.probe.sync.currentSharedLink();
    await window.__TAURI__.event.listen('pc-open-file', ev => { if (ev.payload === target) window.nativeOpenEvents++; });
  }, filePath);
  {
    const ipc = spawn(second.entry.exe, [filePath], { cwd: path.dirname(second.entry.exe), windowsHide: true, env: nativeTestEnv({ ...isolatedSettings, PC_REOPEN_NATIVE_ROOT: root, PC_REOPEN_NATIVE_BROWSER_DIR: second.profile, PROMPTCUT_RUNTIME_DIR: second.entry.runtime }), stdio: 'ignore' });
    children.add(ipc); assert.equal(await new Promise(resolve => ipc.once('exit', resolve)), 0); children.delete(ipc);
  }
  phase = 'native IPC file loading and replacement sync complete';
  await second.p.waitForFunction(() => window.nativeOpenEvents === 1);
  // The IPC event is delivered before Shell finishes its asynchronous file read.
  // Require the resulting new link, rather than observing the previous online link.
  await second.p.waitForFunction(() => window.probe.sync.currentSharedLink() !== window.nativeIpcOriginalLink && window.probe.sync.getSyncView().reopenState === 'connected', { timeout: 30000 });
  await connected(second.p, room, nativeMember ? 'member' : 'host'); await sees(second.p, 'native-host-after');
  phase = 'member ticket reads bytes through recovered cloud relay';
  const asset = await member.evaluate(async () => {
    const v = window.probe.sync.getSyncView(), link = window.probe.sync.currentSharedLink();
    const issued = await link.request({ type: 'auth.ticket', kind: 'asset', access: 'rw' }); if (issued.type !== 'auth.ticket.ok') throw new Error('asset ticket failed');
    const base = v.shared.base.replace(/\/doc$/, '/asset/api/asset'), bytes = crypto.getRandomValues(new Uint8Array(50000));
    const hashOf = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('');
    const hash = await hashOf(bytes);
    for (const ns of ['media', 'snap', 'px']) {
      const upload = await fetch(`${base}/${ns}/${hash}/0`, { method: 'PUT', headers: { Authorization: `Bearer ${issued.ticket}`, 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), 'X-Media-Ext': 'bin' }, body: bytes });
      if (!upload.ok || !(await fetch(`${base}/${ns}/${hash}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${issued.ticket}` } })).ok) throw new Error('asset upload failed');
    }
    const read = await link.request({ type: 'auth.ticket', kind: 'asset', access: 'r' });
    for (const ns of ['media', 'snap', 'px']) { const r = await fetch(`${base}/${ns}/${hash}?t=${encodeURIComponent(read.ticket)}`); if (!r.ok) throw new Error('asset read failed'); const got = await r.arrayBuffer(); if (got.byteLength !== bytes.length || await hashOf(got) !== hash) throw new Error('asset mismatch'); }
    return { bytes: bytes.length, hash, namespaces: ['media', 'snap', 'px'] };
  });
  assert.equal(createRequests, 0, 'native restoration must not create a room'); assert.equal(sha(filePath), fileHash, 'native path opening must not alter the original file');
  await second.p.screenshot({ path: path.join(root, 'native-restored.png') }); await quit(second);
  const evidence = { ok: true, sourceCommit: fixture.sourceCommit, nativeArgument: true, nativeSingleInstanceIpc: true, nativeNormalExit: true,
    runtimeCopyChanged: true, emptyBrowserProfiles: true, stableDevice: true, stableRoom: room, memberWaitThenAutomaticJoin: true,
    nativeActor: nativeMember ? 'member' : 'host', actualInitialAuthenticationUi: true, optionalSpeechPromptDismissed,
    hostPidBefore: nativeMember ? peerBefore.pid : first.pid, hostPidAfter: nativeMember ? peerAfter.pid : second.pid,
    memberPidBefore: nativeMember ? first.pid : peerBefore.pid, memberPidAfter: nativeMember ? second.pid : peerAfter.pid,
    bidirectionalEdits: 4, binding, asset, originalFileUnchanged: true, recoveryCreateRequests: createRequests,
    nativeOsDoubleClick: false, standaloneBootstrapTested:process.argv.includes('--standalone-smoke'),
    installerUpgrade: !!runtimeUpgrade, runtimeUpgrade, actualComputerRestart: false,
    isolatedProviderConfiguration: true, evidenceDirectory: root };
  fs.writeFileSync(path.join(root, 'native-evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} catch (e) {
  const primitive = x => x === null || ['boolean', 'number'].includes(typeof x) ? x : undefined;
  const states = [];
  for (const connection of [...nativeConnections, ...(browser ? [browser] : [])]) {
    for (const p of await connection.pages().catch(() => [])) {
      const state = await p.evaluate(() => {
        if (!window.probe) return null;
        const v = window.probe.sync.getSyncView();
        return { reopen: v.reopenState, status: v.status, room: v.shared?.projectId, username: v.shared?.username,
          creator: v.shared?.creator, registration: v.hostRegistration, firstRunPanel: !!document.querySelector('.ais-dialog'), recoveryForm: !!document.querySelector('form[aria-label="恢复原协作身份"]'),
          authBefore: window.nativeAuthBefore, authClicks: window.nativeAuthClicks?.slice(-4) };
      }).catch(() => null);
      if (state) states.push(state);
    }
  }
  console.error(JSON.stringify({ ok: false, phase, errorClass: e?.name || 'Error', errorCode: /^[A-Z_0-9]+$/.test(e?.code || '') ? e.code : undefined,
    actual: primitive(e?.actual), expected: primitive(e?.expected), states, evidenceDirectory: root })); process.exitCode = 1;
} finally {
  for (const connection of nativeConnections) connection.disconnect();
  if (browser) await browser.close();
  for (const child of [...children]) await stop(child);
}
