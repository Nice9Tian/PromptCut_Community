/** System default double click on a really installed build: reopen acceptance for host and member.
 * The build under test is whatever its own installer registered for `.proc`; this probe never
 * writes an association, installs anything or types into a security prompt. It prepares a room,
 * tells the operator which file to double-click in Explorer (control/handoff.json and stdout),
 * and proves each launch from the process itself: installed executable, the file on its command
 * line, Explorer as parent, created after the hand-off was armed.
 *
 *   node --import=./scripts/lib/test-silent-processes.mjs scripts/probes/reopen-installed.mjs \
 *     --manifest <release manifest.json> --app-src-hash <VERSIONS.json appSrcHash of that build> [options]
 *   --preflight-only        read-only: is the installed program for .proc that build? then exit
 *   --service <url>         hosting directory both sides register with; default is an own loopback one
 *   --external-member       host role: also admit a sealed member from another machine and wait for its edit
 *   --member --remote-host-key <public key>   the installed application is the member; the host runs
 *                           elsewhere (reopen-remote-host.mjs) and receives the member password sealed
 *   --peer-port <n>         first of three ports for the own stand-in member editor (default 5206)
 *   --control <dir>         where hand-off and exchanged files live (default <run dir>/control)
 *   --seal-dir <dir>        owned directory of the seal key / member password, when they were prepared
 *                           beforehand with reopen-sealed.mjs. Default: the host role keeps its seal key under
 *                           <run dir>/seal; the member role keeps its password in memory only
 *   --click-timeout-ms <n>  how long to wait for each double click (default 900000)
 *   --shell-open            stand-in when nobody can double-click: the probe asks Explorer to open the file
 *                           through the registered association. It proves the association and what follows,
 *                           not the double click itself, and the evidence says so.
 *   --rehearse-fixture <fixture.json>   no installed build: drive the isolated test shell and start it
 *                           with the file as argument. A rehearsal is not double-click evidence.
 * Files exchanged through --control: host-public-key.json and external-member.sealed (host role with
 * --external-member), external-ready.json, member.sealed and host.proc (member role).
 * The installed application runs on the real data directory of this Windows user: back it up first
 * (reopen-installed-state.mjs) and restore it afterwards.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';
import { isUnsafePort } from '../../server/safe-port.mjs';
import { loadNativeFixture, nativeTestEnv } from './reopen-native-fixture.mjs';
import { reopenEditorEnv } from './reopen-editor-env.mjs';
import { handoffWriter, installedIdentity, launchReceipt, openThroughExplorer, queryAssociation, queryProcesses, sha256File, watchLaunches } from './reopen-installed-lib.mjs';
import { ownedMemberSecret, ownedSealKeys, seal, unseal } from './reopen-sealed.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = name => process.argv.includes(name);
const memberRole = flag('--member'), externalMember = flag('--external-member'), rehearsal = arg('--rehearse-fixture'), shellOpen = flag('--shell-open');
assert(!(rehearsal && shellOpen), '--shell-open needs a really installed build');
const launchMode = rehearsal ? 'argument-start' : shellOpen ? 'shell-open' : 'explorer-double-click';
const clickTimeoutMs = Number(arg('--click-timeout-ms') ?? 900000), peerPort = Number(arg('--peer-port') ?? 5206);
assert.equal(process.platform, 'win32', 'Windows only');
// Explorer hands the application the long form of a path; keep the run directory in that form.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-installed-')));
const control = path.resolve(arg('--control') ?? path.join(root, 'control')), files = path.join(root, 'files');
const sealDir = arg('--seal-dir') ? path.resolve(arg('--seal-dir')) : null;
fs.mkdirSync(control, { recursive: true }); fs.mkdirSync(files);
const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const secret = () => randomBytes(32).toString('base64url');
const say = (phase, more = {}) => console.log(JSON.stringify({ phase, ...more }));
const children = new Set(), connections = new Set(), launches = [], rejectedLaunches = [];
const handoff = handoffWriter(control);
let phase = 'start', browser, createRequests = 0, service = arg('--service'), ownCloud, app, running;

async function freePort(p) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; children.delete(child);
}
/** A file the operator drops into the control directory. It may still be open for writing when it first
 * appears, so a failed or incomplete read just means: look again. */
const controlFile = async (name, ms, what, complete) => waitFor(() => {
  try { const text = fs.readFileSync(path.join(control, name), 'utf8').replace(/^\uFEFF/, '').trim(); return text && complete(text) ? text : false; } catch { return false; }
}, ms, what);
const isSealed = text => /^pcs1\.[A-Za-z0-9_-]{100,}$/.test(text);
const isProjectFile = text => { try { return !!JSON.parse(text).collaboration?.roomId; } catch { return false; } };
const online = async () => { try { return (await (await fetch(`${service}/hosting/healthz`, { signal: AbortSignal.timeout(5000) })).json()).online; } catch { return null; } };

/** Own loopback hosting directory, used when no --service is given. */
async function startOwnCloud(docPort = 0, assetPort = 0) {
  const dataDir = path.join(root, 'cloud'); fs.mkdirSync(dataDir, { recursive: true });
  const url = pathToFileURL(path.resolve('cloud/server/hosted/combo.mjs')).href;
  const code = `import { startHostedCombo } from ${JSON.stringify(url)};
    const c = await startHostedCombo({ dataDir: process.env.PROMPTCUT_DATA_DIR, docPort: Number(process.env.PC_PROBE_DOC_PORT), assetPort: Number(process.env.PC_PROBE_ASSET_PORT), host: '127.0.0.1', trustLoopback: false, clusterToken: process.env.PROMPTCUT_CLUSTER_TOKEN, log: () => {} });
    console.log(JSON.stringify({ docPort: c.docPort, assetPort: c.assetPort }));
    process.stdin.resume(); process.stdin.on('end', () => c.close().then(() => process.exit(0)));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true,
    env: reopenEditorEnv(dataDir, { PROMPTCUT_CLUSTER_TOKEN: secret(), PC_PROBE_DOC_PORT: String(docPort), PC_PROBE_ASSET_PORT: String(assetPort) }), stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); child.stderr.resume();
  let ports, output = ''; child.stdout.on('data', b => { output += b; if (output.includes('\n') && !ports) ports = JSON.parse(output.split('\n')[0]); });
  await waitFor(() => { assert.equal(child.exitCode, null, 'own hosting directory exited'); return ports; }, 15000, 'own hosting directory');
  return { ...ports, child, pid: child.pid };
}
/** Own stand-in member: an isolated editor and a headless page, never the installed application. */
async function peerEditor() {
  for (const p of [peerPort, peerPort + 1, peerPort + 2]) await freePort(p);
  const data = path.join(root, 'peer'); fs.mkdirSync(data, { recursive: true });
  const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(peerPort), '--strictPort'], { cwd: process.cwd(), windowsHide: true,
    env: reopenEditorEnv(data, { PROMPTCUT_DEVICE_NAME: 'isolated-peer', PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_LAN_HOST: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.stdout.resume(); child.stderr.resume();
  await waitFor(async () => { assert.equal(child.exitCode, null, 'own peer editor exited'); try { return (await fetch(`http://127.0.0.1:${peerPort}/api/docservice/device`)).ok; } catch { return false; } }, 30000, 'own peer editor');
  return child;
}
async function observe(p) {
  p.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/shared/create')) createRequests++; });
  await p.waitForFunction(() => !!document.querySelector('.pc-app-shell'), { timeout: 60000 });
  await p.evaluate(async () => {
    const [sync, proc, store, collab] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts'), import('/src/editor/sync/collab.ts')]);
    window.probe = { sync, proc, store, collab }; await sync.startSync();
  });
  return p;
}
async function peerPage() {
  const context = await browser.createBrowserContext(), p = await context.newPage();
  await p.goto(`http://127.0.0.1:${peerPort}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
  return observe(p);
}
/** The first-run provider panel and the optional speech prompt can cover the recovery control.
 * Close them through their own Close / Ignore buttons only; never change a setting. */
async function clearOverlays(p, waitMs = 0) {
  if (waitMs) await p.waitForSelector('.ais-dialog', { timeout: waitMs }).catch(() => {});
  const closed = await p.evaluate(() => {
    const close = [...document.querySelectorAll('.ais-dialog button')].find(b => b.textContent?.trim() === '关闭');
    close?.click(); return !!close;
  });
  if (closed) await p.waitForSelector('.ais-dialog', { hidden: true });
  return closed;
}
async function authenticate(p, username, password) {
  await p.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'needs-auth', { timeout: 30000 });
  let speechPromptDismissed = false;
  await waitFor(async () => {
    await clearOverlays(p);
    const point = await p.evaluate(() => {
      const b = document.querySelector('[data-pc="recovery-auth-open"]'), r = b?.getBoundingClientRect();
      const hit = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { ready: !!b && hit?.closest('[data-pc="recovery-auth-open"]') === b, speech: !!hit?.closest('.dep-prompt') };
    });
    if (point.speech) { await p.click('.dep-prompt button.dep-prompt-btn:not(.is-primary)'); await p.waitForSelector('.dep-prompt', { hidden: true }); speechPromptDismissed = true; }
    return point.ready;
  }, 20000, 'actual recovery control hit target');
  await p.click('[data-pc="recovery-auth-open"]'); await p.waitForSelector('form[aria-label="恢复原协作身份"]');
  await p.type('form[aria-label="恢复原协作身份"] input[autocomplete="username"]', username);
  await p.type('form[aria-label="恢复原协作身份"] input[type="password"]', password);
  await p.click('form[aria-label="恢复原协作身份"] button[type="submit"]');
  return { actualAuthenticationUi: true, speechPromptDismissed };
}
const connected = async (p, room, user, ms = 30000) => {
  try { await p.waitForFunction((r, u) => { const v = window.probe.sync.getSyncView(); return v.shared?.projectId === r && v.shared.username === u && v.status === 'online'; }, { timeout: ms }, room, user); }
  catch { throw new Error(`${user} did not reconnect: ${JSON.stringify(await viewOf(p))}`); }
};
const viewOf = p => p.evaluate(() => { const v = window.probe.sync.getSyncView(); return { reopen: v.reopenState, status: v.status, room: v.shared?.projectId, username: v.shared?.username, creator: v.shared?.creator, registration: v.hostRegistration }; }).catch(() => null);
const reopenState = (p, state, ms = 30000) => p.waitForFunction(s => window.probe.sync.getSyncView().reopenState === s, { timeout: ms }, state);
const saved = p => p.evaluate(async () => { await window.probe.sync.whenSaved(); return window.probe.proc.serializeProc(); });
const setName = (p, value) => p.evaluate(n => window.probe.store.actions.setProjectMeta({ name: n }), value);
const sees = (p, value, ms = 30000) => p.waitForFunction(n => window.probe.store.getState().project.name === n, { timeout: ms }, value);
const openText = (p, text) => p.evaluate(t => window.probe.store.actions.loadProject(window.probe.proc.loadProc(t), 'reopen-installed.proc'), text);
const deviceOf = p => p.evaluate(() => { const d = window.probe.sync.getSyncView().device; return typeof d === 'string' ? d : d?.id ?? null; });
const binding = p => p.evaluate(async () => { const v = window.probe.sync.getSyncView(), r = await window.probe.sync.recoveryRequest('select', v.association, { contentId: window.probe.store.getState().project.id }); return { creator: v.shared.creator, where: v.shared.where, hostBinding: !!r.host, rev: r.journal.rev }; });
/** A member page uploads and reads back 50 kB in each asset namespace with freshly issued tickets. */
const assetRoundTrip = p => p.evaluate(async () => {
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

/** What is under test: the installed build, or for a rehearsal the isolated test shell. */
function target() {
  if (rehearsal) {
    const fixture = loadNativeFixture(rehearsal), entry = fixture.copies[0];
    const settings = Object.fromEntries(['AI_CONFIG:settings/ai.json', 'CLI_HOME:settings/cli', 'AGY_SETTINGS:settings/agy.json', 'CLAUDE_CONFIG:settings/claude.json', 'CODEX_CONFIG:settings/codex.toml', 'SKILL_DIR:skills']
      .map(x => x.split(':')).map(([k, rel]) => [`PROMPTCUT_${k}`, path.join(root, rel)]));
    let launchNo = 0;
    // Every start gets an empty WebView profile, like the other isolated native probes.
    const env = () => nativeTestEnv({ ...settings, PC_REOPEN_NATIVE_ROOT: root, PC_REOPEN_NATIVE_BROWSER_DIR: path.join(root, `browser-${++launchNo}`), PROMPTCUT_RUNTIME_DIR: entry.runtime,
      PROMPTCUT_PROJECTS_DIR: path.join(root, 'data/drafts'), PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_LAN_HOST: '0' });
    let lastEnv;
    const start = (args, reuse) => { const child = spawn(entry.exe, args, { cwd: path.dirname(entry.exe), windowsHide: true, env: reuse ? lastEnv : (lastEnv = env()), stdio: 'ignore' }); children.add(child); child.once('exit', () => children.delete(child)); };
    return { rehearsal: true, exe: entry.exe, port: fixture.port, parentName: 'node.exe', firstRunWaitMs: 60000, sourceCommit: fixture.sourceCommit,
      startPlain: () => start([]), simulateDoubleClick: (file, secondary) => start([file], secondary) };
  }
  const manifestFile = arg('--manifest'), appSrcHash = arg('--app-src-hash');
  assert(manifestFile && appSrcHash, '--manifest and --app-src-hash identify the build that must be installed');
  const association = queryAssociation();
  const identity = installedIdentity(association, { manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')), appSrcHash });
  say('preflight', { ok: identity.ok, reasons: identity.reasons, progId: association.progId, userChoice: !!association.userChoice, exeSha256: identity.exeSha256, versions: identity.versions, payload: identity.payload });
  assert.equal(identity.ok, true, `the installed program for .proc is not the build under test: ${identity.reasons.join('; ')}`);
  return { rehearsal: false, exe: identity.exe, port: 5210, parentName: 'explorer.exe', firstRunWaitMs: 15000, identity, association,
    // Explorer starts the program with the user's ordinary environment; a child of this probe would inherit test settings.
    startPlain: () => { openThroughExplorer(identity.exe); } };
}

/** Attach to a running instance through the debugging port its own shell opened for the agent webview. */
async function attach(pid, { file } = {}) {
  let port;
  await waitFor(() => { const views = queryProcesses(app.exe).webviews; port = (views.find(w => w.parentPid === pid) ?? (views.length === 1 ? views[0] : null))?.port; return port; }, 90000, 'WebView debugging port of the launched instance');
  // The shell takes whatever free port the system hands out. Node refuses to dial a few well-known ones,
  // which is a property of that port, not of the launch; say so instead of timing out.
  assert.equal(isUnsafePort(port), false, `the shell chose debugging port ${port}, which Node refuses to connect to; start again`);
  let connection;
  await waitFor(async () => { try { connection = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }); return true; } catch { return false; } }, 60000, `WebView debugging endpoint on port ${port}`);
  connections.add(connection);
  let p;
  await waitFor(async () => { p = (await connection.pages()).find(x => x.url().startsWith(`http://127.0.0.1:${app.port}/`)); return p; }, 90000, 'editor page of the launched instance');
  if (file) assert.equal(String(new URL(p.url()).searchParams.get('open')).toLowerCase(), file.toLowerCase(), 'the double-clicked file must reach the boot address');
  await observe(p);
  assert.equal(await p.evaluate(() => !!window.__TAURI__?.core?.invoke), true, 'actual desktop shell required');
  assert.equal((await p.evaluate(() => window.__TAURI__.core.invoke('agent_webview_info'))).port, port, 'attached to another debugging endpoint');
  running = { pid, p, connection, port };
  return running;
}
async function startPlain() {
  for (const p of [app.port, app.port + 1, app.port + 2]) await freePort(p);
  assert.equal(queryProcesses(app.exe).processes.length, 0, 'the application under test is already running');
  const watcher = await watchLaunches(app.exe);
  try {
    app.startPlain();
    let row; await waitFor(() => (row = watcher.rows.find(r => r.exe)), 60000, 'application start');
    return attach(row.pid);
  } finally { watcher.stop(); }
}
/** Hand the next double click to the operator and accept only a launch that proves itself. */
async function explorerLaunch(file, { secondary = false } = {}) {
  if (!secondary) {
    for (const p of [app.port, app.port + 1, app.port + 2]) await freePort(p);
    assert.equal(queryProcesses(app.exe).processes.length, 0, 'a cold double click needs the application closed');
  }
  const watcher = await watchLaunches(app.exe), rejected = [];
  try {
    const armedAt = new Date().toISOString();
    handoff.write({ stage: launchMode === 'explorer-double-click' ? 'awaiting-double-click' : 'probe-opens-the-file', launchMode, file, folder: path.dirname(file), secondary, armedAt, deadlineAt: new Date(Date.now() + clickTimeoutMs).toISOString() });
    let helperPid;
    if (app.rehearsal) app.simulateDoubleClick(file, secondary); else if (shellOpen) helperPid = openThroughExplorer(file).pid;
    let row;
    try {
      await waitFor(() => {
        for (const r of watcher.rows.splice(0)) {
          const verdict = launchReceipt(r, { exe: app.exe, file, armedAt, parentName: app.parentName, parentPid: helperPid });
          if (verdict.ok) { row = r; return true; }
          rejected.push({ pid: r.pid, createdAt: r.createdAt, parentName: r.parentName, exitedBeforeQuery: !!r.exitedBeforeQuery, reasons: verdict.reasons });
          // A second launch can end before its details are read; ask for it again instead of guessing.
          if (launchMode === 'explorer-double-click') handoff.write({ stage: 'awaiting-double-click', retry: true, file, folder: path.dirname(file), secondary, armedAt, rejected: rejected.length });
        }
        return false;
      }, clickTimeoutMs, 'a double click that starts the build under test with this file');
    } finally { rejectedLaunches.push(...rejected.map(r => ({ ...r, secondary }))); }
    const receipt = { secondary, pid: row.pid, createdAt: row.createdAt, armedAt, parentName: row.parentName, parentPid: row.parentPid, parentCreatedAt: row.parentCreatedAt,
      installedExecutable: true, fileOnCommandLine: true, via: launchMode, explorerHelperPid: helperPid, rejectedBefore: rejected.length };
    launches.push(receipt); handoff.write({ stage: 'launched', file, secondary, pid: row.pid });
    return receipt;
  } finally { watcher.stop(); }
}
async function quit() {
  const { pid, p, connection } = running; running = null;
  await p.evaluate(() => window.__TAURI__.core.invoke('desktop_titlebar_command', { command: 'quit' })).catch(() => {});
  connection.disconnect(); connections.delete(connection);
  await waitFor(() => !queryProcesses(app.exe).processes.some(x => x.pid === pid), 30000, 'normal exit of the application');
  await waitFor(async () => { try { for (const port of [app.port, app.port + 1, app.port + 2]) await freePort(port); return true; } catch { return false; } }, 30000, 'editor ports released');
}
/** The running window must take over the file of a second double click. */
async function secondDoubleClick(file, room, username) {
  const { p } = running;
  await p.evaluate(async target => {
    window.reopenOpenEvents = 0; window.reopenLinkBefore = window.probe.sync.currentSharedLink();
    await window.__TAURI__.event.listen('pc-open-file', ev => { if (String(ev.payload).toLowerCase() === target.toLowerCase()) window.reopenOpenEvents++; });
  }, file);
  const receipt = await explorerLaunch(file, { secondary: true });
  await p.waitForFunction(() => window.reopenOpenEvents >= 1, { timeout: 30000 });
  // The event arrives before the shell has read the file; require the replacement link, not the old one.
  await p.waitForFunction(() => window.probe.sync.currentSharedLink() !== window.reopenLinkBefore && window.probe.sync.getSyncView().reopenState === 'connected', { timeout: 60000 });
  await connected(p, room, username);
  assert.equal(queryProcesses(app.exe).processes.filter(x => x.pid === running.pid).length, 1, 'the first instance must stay');
  return { ...receipt, openEvents: await p.evaluate(() => window.reopenOpenEvents), replacedLink: true };
}

async function hostRole() {
  // An installed build keeps its rooms between runs; a fixed name would collide with the previous run.
  const roomName = `reopen-installed-${randomBytes(4).toString('hex')}`;
  const password = secret(), creatorPassword = secret(), list = [{ username: 'member', password }];
  let external = null;
  if (externalMember) {
    phase = 'receive sealed external member';
    const keys = ownedSealKeys(sealDir ?? path.join(root, 'seal'));
    fs.writeFileSync(path.join(control, 'host-public-key.json'), JSON.stringify({ publicKey: keys.publicKey }));
    say('host-public-key', { publicKey: keys.publicKey, expects: path.join(control, 'external-member.sealed') });
    external = unseal(keys.privateKey, await controlFile('external-member.sealed', clickTimeoutMs, 'sealed external member', isSealed));
    assert(/^[a-z][a-z0-9-]{2,31}$/.test(external.username) && external.username !== 'member' && external.username !== 'host' && typeof external.password === 'string' && external.password.length >= 32, 'external member secret is not usable');
    list.push({ username: external.username, password: external.password });
  }
  phase = 'start own member'; let peerProcess = await peerEditor(), peer = await peerPage();
  phase = 'start the application and create the room';
  let native = await startPlain(); await native.p.waitForSelector('.sp-hero', { timeout: 60000 }); await native.p.click('.sp-hero'); await clearOverlays(native.p, app.firstRunWaitMs);
  const created = await native.p.evaluate(o => window.probe.collab.enableCollab(o), { where: 'lan', mode: 'restricted', name: roomName, creator: { username: 'host', password: creatorPassword }, projectPassword: password, list, hostedUrl: service });
  assert.equal(created.ok, true, `room creation failed (${created.error || 'unknown'})`);
  const hostFile = await saved(native.p), descriptor = JSON.parse(hostFile).collaboration, room = descriptor.roomId;
  assert.equal(descriptor.service, service);
  for (const s of [password, creatorPassword, external?.password].filter(Boolean)) assert.equal(hostFile.includes(s), false, 'project file must not contain a password');
  await waitFor(async () => (await online()) > 0, 30000, 'host registration');
  phase = 'own member first authentication';
  await openText(peer, hostFile); const firstAuth = await authenticate(peer, 'member', password);
  await connected(peer, room, 'member'); const memberFile = await saved(peer);
  const file = path.join(files, 'original-host.proc'); fs.writeFileSync(file, hostFile);
  const fileHash = sha256File(file), device = await deviceOf(native.p), firstPid = native.pid;
  phase = 'edits before the application closes';
  await setName(peer, 'member-before'); await sees(native.p, 'member-before');
  await setName(native.p, 'host-before'); await sees(peer, 'host-before'); await saved(native.p); await saved(peer);
  phase = 'close the application, stop own member'; await quit();
  await waitFor(async () => (await online()) === 0, 60000, 'host offline in the directory');
  await peer.close(); await stop(peerProcess);
  let cloudRestarted = false;
  if (ownCloud) { const previous = ownCloud; await stop(previous.child); ownCloud = await startOwnCloud(previous.docPort, previous.assetPort); assert.notEqual(ownCloud.pid, previous.pid); cloudRestarted = true; }
  phase = 'own member reopens first and waits';
  createRequests = 0; peerProcess = await peerEditor(); peer = await peerPage(); await openText(peer, memberFile);
  await reopenState(peer, 'waiting-host');
  phase = 'cold double click on the host file';
  const cold = await explorerLaunch(file); native = await attach(cold.pid, { file });
  const firstRunPanelClosed = await clearOverlays(native.p, app.firstRunWaitMs);
  await connected(native.p, room, 'host', 60000); await waitFor(async () => (await online()) > 0, 30000, 'host registration after reopen');
  await connected(peer, room, 'member', 60000);
  assert.notEqual(native.pid, firstPid); assert.equal(await deviceOf(native.p), device, 'stable device identity');
  await sees(native.p, 'host-before'); await sees(peer, 'host-before');
  await setName(peer, 'member-after'); await sees(native.p, 'member-after');
  await setName(native.p, 'host-after'); await sees(peer, 'host-after'); await saved(native.p); await saved(peer);
  const bound = await binding(native.p);
  assert.deepEqual([bound.creator, bound.hostBinding, bound.where], [true, true, 'lan']); assert(bound.rev >= 5);
  phase = 'member reads ticketed assets'; const asset = await assetRoundTrip(peer);
  let externalResult = null;
  if (external) {
    phase = 'external member joins the reopened room';
    const ready = { service, roomId: room, username: external.username, expected: 'host-after', edit: 'external-after-reopen', asset: { hash: asset.hash, size: asset.bytes } };
    fs.writeFileSync(path.join(control, 'external-ready.json'), JSON.stringify(ready)); say('external-ready', ready);
    await sees(native.p, 'external-after-reopen', clickTimeoutMs); await sees(peer, 'external-after-reopen');
    externalResult = { username: external.username, editSeenByHostAndMember: true };
  }
  phase = 'second double click while the window is open';
  const forwarded = await secondDoubleClick(file, room, 'host');
  await sees(native.p, external ? 'external-after-reopen' : 'host-after');
  assert.equal(createRequests, 0, 'reopening must not create a room'); assert.equal(sha256File(file), fileHash, 'opening must not alter the file');
  await native.p.screenshot({ path: path.join(root, 'installed-restored.png') }); await quit();
  await peer.close(); await stop(peerProcess);
  return { actor: 'host', room, firstAuth, hostPidBefore: firstPid, hostPidAfter: cold.pid, memberWaitThenAutomaticJoin: true, stableDevice: true, bidirectionalEdits: 4,
    binding: bound, asset, external: externalResult, forwarded, cloudRestarted, firstRunPanelClosed, recoveryCreateRequests: createRequests, originalFileUnchanged: true };
}

async function memberRole_() {
  const hostKey = arg('--remote-host-key'); assert(hostKey, '--remote-host-key: the public key printed by reopen-remote-host.mjs');
  phase = 'seal own member password for the remote host';
  // Without --seal-dir the member password exists only in this process.
  const mine = sealDir ? ownedMemberSecret(sealDir, 'member') : { username: 'member', password: secret() }, sealed = seal(hostKey, mine);
  fs.writeFileSync(path.join(control, 'member.sealed'), sealed); say('member-sealed', { sealed, expects: path.join(control, 'host.proc') });
  const hostFile = await controlFile('host.proc', clickTimeoutMs, 'project file of the remote host', isProjectFile);
  const descriptor = JSON.parse(hostFile).collaboration, room = descriptor.roomId; service = descriptor.service;
  assert.equal(hostFile.includes(mine.password), false, 'project file must not contain a password');
  phase = 'start the application and authenticate as member';
  let native = await startPlain(); await native.p.waitForSelector('.sp-hero', { timeout: 60000 }); await native.p.click('.sp-hero'); await clearOverlays(native.p, app.firstRunWaitMs);
  await openText(native.p, hostFile); const firstAuth = await authenticate(native.p, 'member', mine.password);
  await connected(native.p, room, 'member', 60000);
  const tag = `r${randomBytes(4).toString('hex')}`, firstPid = native.pid, device = await deviceOf(native.p);
  // The remote host answers every "<tag>-m<n>" with "<tag>-h<n>"; seeing the answer proves both directions.
  phase = 'edits before the application closes';
  await setName(native.p, `${tag}-m1`); await sees(native.p, `${tag}-h1`, 60000);
  const memberFile = await saved(native.p), file = path.join(files, 'original-member.proc'); fs.writeFileSync(file, memberFile);
  const fileHash = sha256File(file);
  await setName(native.p, `${tag}-bye`); await saved(native.p);
  phase = 'close the application; remote host goes offline'; await quit();
  await waitFor(async () => (await online()) === 0, 300000, 'remote host offline in the directory');
  phase = 'cold double click on the member file';
  createRequests = 0;
  const cold = await explorerLaunch(file); native = await attach(cold.pid, { file });
  const firstRunPanelClosed = await clearOverlays(native.p, app.firstRunWaitMs);
  await reopenState(native.p, 'waiting-host', 60000);
  fs.writeFileSync(path.join(control, 'member-waiting.json'), JSON.stringify({ room, at: new Date().toISOString() })); say('member-waiting-host', { room });
  phase = 'remote host returns; member joins without input';
  await connected(native.p, room, 'member', clickTimeoutMs);
  assert.notEqual(native.pid, firstPid); assert.equal(await deviceOf(native.p), device, 'stable device identity');
  await setName(native.p, `${tag}-m2`); await sees(native.p, `${tag}-h2`, 60000); await saved(native.p);
  const bound = await binding(native.p);
  assert.deepEqual([bound.creator, bound.hostBinding, bound.where], [false, false, 'lan']); assert(bound.rev >= 5);
  phase = 'member reads ticketed assets'; const asset = await assetRoundTrip(native.p);
  phase = 'second double click while the window is open';
  const forwarded = await secondDoubleClick(file, room, 'member');
  await sees(native.p, `${tag}-h2`);
  assert.equal(createRequests, 0, 'reopening must not create a room'); assert.equal(sha256File(file), fileHash, 'opening must not alter the file');
  await native.p.screenshot({ path: path.join(root, 'installed-restored.png') });
  await setName(native.p, `${tag}-done`); await saved(native.p); await quit();
  return { actor: 'member', room, firstAuth, memberPidBefore: firstPid, memberPidAfter: cold.pid, memberWaitThenAutomaticJoin: true, stableDevice: true, bidirectionalEdits: 4, echoTag: tag,
    binding: bound, asset, forwarded, firstRunPanelClosed, recoveryCreateRequests: createRequests, originalFileUnchanged: true, remoteHost: true };
}

try {
  phase = 'identify the build under test'; app = target();
  if (flag('--preflight-only')) { say('preflight-only', { ok: true, exe: app.exe }); process.exit(0); }
  say('run', { root, control, files, role: memberRole ? 'member' : 'host', rehearsal: app.rehearsal });
  if (!memberRole) {
    if (!service) { phase = 'start own hosting directory'; ownCloud = await startOwnCloud(); service = `http://127.0.0.1:${ownCloud.docPort}`; }
    phase = 'start own browser';
    browser = await puppeteer.launch({ headless: true, userDataDir: path.join(root, 'peer-browser'), args: ['--no-sandbox'] });
  }
  const result = memberRole ? await memberRole_() : await hostRole();
  const evidence = { ok: true, kind: 'promptcut-installed-reopen-v1', ...result, service: ownCloud ? 'own-loopback-directory' : service,
    launchMode, osDoubleClick: launchMode === 'explorer-double-click', osShellOpen: launchMode === 'shell-open', rehearsal: app.rehearsal, sourceCommit: app.sourceCommit,
    installed: app.identity && { exeSha256: app.identity.exeSha256, versions: app.identity.versions, payload: app.identity.payload, progId: app.association.progId, userChoice: !!app.association.userChoice },
    launches, rejectedLaunches, fileAssociationsChanged: false, evidenceDirectory: root };
  fs.writeFileSync(path.join(root, 'installed-evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} catch (e) {
  const states = [];
  for (const connection of [...connections, ...(browser ? [browser] : [])]) for (const p of await connection.pages().catch(() => [])) {
    const state = await p.evaluate(() => (window.probe ? { url: location.origin, firstRunPanel: !!document.querySelector('.ais-dialog'), recoveryForm: !!document.querySelector('form[aria-label="恢复原协作身份"]') } : null)).catch(() => null);
    if (state) states.push({ ...state, ...(await viewOf(p)) });
  }
  console.error(JSON.stringify({ ok: false, phase, errorClass: e?.name || 'Error', message: String(e?.message ?? '').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 400),
    states, launches, rejectedLaunches, evidenceDirectory: root })); process.exitCode = 1;
} finally {
  // Leave a really installed application to its own Quit; only processes this probe started are stopped.
  if (running) await running.p.evaluate(() => window.__TAURI__.core.invoke('desktop_titlebar_command', { command: 'quit' })).catch(() => {});
  for (const connection of connections) connection.disconnect();
  if (browser) await browser.close().catch(() => {});
  for (const child of [...children]) await stop(child);
}
