/** Isolated host on this machine for the member-role acceptance of an installed build elsewhere.
 * Own editor, own data directory, own browser; never the installed application of this machine.
 * It creates a restricted room whose only member is the remote installed application, answers each
 * member edit "<tag>-m<n>" with "<tag>-h<n>", goes offline when the member says "<tag>-bye", comes
 * back when the operator creates control/start-host, and finishes on "<tag>-done".
 *
 *   node --import=./scripts/lib/test-silent-processes.mjs scripts/probes/reopen-remote-host.mjs --service <hosting directory url> --control <dir> [--port 5203]
 * Files in --control: host-public-key.json (written first), member.sealed (from reopen-installed.mjs --member),
 * host.proc (project file for the member, no secrets), start-host (operator), remote-host-evidence.json.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';
import { reopenEditorEnv } from './reopen-editor-env.mjs';
import { ownedSealKeys, unseal } from './reopen-sealed.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const service = arg('--service'), port = Number(arg('--port') ?? 5203), waitMs = Number(arg('--wait-timeout-ms') ?? 3600000);
assert(service, '--service <hosting directory url> is required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-remote-host-'));
const control = path.resolve(arg('--control') ?? path.join(root, 'control')); fs.mkdirSync(control, { recursive: true });
const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const secret = () => randomBytes(32).toString('base64url');
const say = (phase, more = {}) => console.log(JSON.stringify({ phase, at: new Date().toISOString(), ...more }));
/** A file the operator drops into the control directory; it may still be open for writing when it first appears. */
const controlFile = (name, ms, what, complete = () => true) => waitFor(() => {
  try { const text = fs.readFileSync(path.join(control, name), 'utf8').replace(/^\uFEFF/, '').trim() || 'present'; return complete(text) ? text : false; } catch { return false; }
}, ms, what);
const online = async () => { try { return (await (await fetch(`${service}/hosting/healthz`, { signal: AbortSignal.timeout(5000) })).json()).online; } catch { return null; } };
let phase = 'start', browser, editor, createRequests = 0;

async function startEditor() {
  for (const p of [port, port + 1, port + 2]) { const s = net.createServer(); await new Promise((ok, no) => { s.once('error', no); s.listen(p, '127.0.0.1', ok); }); await new Promise(r => s.close(r)); }
  const data = path.join(root, 'host'); fs.mkdirSync(data, { recursive: true });
  const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), windowsHide: true,
    env: reopenEditorEnv(data, { PROMPTCUT_DEVICE_NAME: 'isolated-remote-host', PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_LAN_HOST: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  await waitFor(async () => { assert.equal(child.exitCode, null, 'own host editor exited'); try { return (await fetch(`http://127.0.0.1:${port}/api/docservice/device`)).ok; } catch { return false; } }, 30000, 'own host editor');
  const context = await browser.createBrowserContext(), p = await context.newPage();
  p.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/shared/create')) createRequests++; });
  await p.goto(`http://127.0.0.1:${port}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!document.querySelector('.pc-app-shell'), { timeout: 60000 });
  await p.evaluate(async () => {
    const [sync, proc, store, collab] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts'), import('/src/editor/sync/collab.ts')]);
    window.probe = { sync, proc, store, collab }; await sync.startSync();
  });
  return { child, p, pid: child.pid };
}
async function stopEditor() {
  await editor.p.close().catch(() => {});
  const ended = new Promise(r => editor.child.once('exit', r)); editor.child.kill(); await ended;
}
const saved = p => p.evaluate(async () => { await window.probe.sync.whenSaved(); return window.probe.proc.serializeProc(); });
const nameOf = p => p.evaluate(() => window.probe.store.getState().project.name);
const hostView = p => p.evaluate(() => { const v = window.probe.sync.getSyncView(); return { reopen: v.reopenState, status: v.status, room: v.shared?.projectId, username: v.shared?.username, creator: v.shared?.creator, registration: v.hostRegistration }; });
/** Answer member edits until the member sends one of the stop words. */
async function echoUntil(p, stops, answered) {
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    const name = await nameOf(p), edit = /^(r[0-9a-f]{8})-m(\d+)$/.exec(name ?? ''), stop = /^(r[0-9a-f]{8})-(bye|done)$/.exec(name ?? '');
    if (edit) { await p.evaluate(n => window.probe.store.actions.setProjectMeta({ name: n }), `${edit[1]}-h${edit[2]}`); await saved(p); answered.push(Number(edit[2])); say('answered', { edit: Number(edit[2]) }); }
    else if (stop && stops.includes(stop[2])) return stop[2];
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`member did not send ${stops.join('/')} in time`);
}

try {
  phase = 'publish seal key and wait for the member password';
  const keys = ownedSealKeys(path.join(root, 'seal'));
  fs.writeFileSync(path.join(control, 'host-public-key.json'), JSON.stringify({ publicKey: keys.publicKey }));
  say('host-public-key', { publicKey: keys.publicKey, control, expects: 'member.sealed' });
  const member = unseal(keys.privateKey, await controlFile('member.sealed', waitMs, 'sealed member password', text => /^pcs1\.[A-Za-z0-9_-]{100,}$/.test(text)));
  assert(member.username === 'member' && typeof member.password === 'string' && member.password.length >= 32, 'member secret is not usable');
  phase = 'start own host and create the room';
  browser = await puppeteer.launch({ headless: true, userDataDir: path.join(root, 'browser'), args: ['--no-sandbox'] });
  editor = await startEditor(); const firstPid = editor.pid, creatorPassword = secret();
  const created = await editor.p.evaluate(async o => { window.probe.proc.newProject('reopen-remote-host'); return window.probe.collab.enableCollab(o); },
    { where: 'lan', mode: 'restricted', name: `reopen-remote-host-${randomBytes(4).toString('hex')}`, creator: { username: 'host', password: creatorPassword }, projectPassword: secret(), list: [{ username: member.username, password: member.password }], hostedUrl: service });
  assert.equal(created.ok, true, `room creation failed (${created.error || 'unknown'})`);
  const hostFile = await saved(editor.p), descriptor = JSON.parse(hostFile).collaboration, room = descriptor.roomId;
  assert.equal(descriptor.service, service);
  assert.equal(hostFile.includes(member.password) || hostFile.includes(creatorPassword), false, 'project file must not contain a password');
  await waitFor(async () => (await online()) > 0, 30000, 'host registration');
  fs.writeFileSync(path.join(control, 'host.proc'), hostFile); say('room-ready', { room, service, hostFile: path.join(control, 'host.proc') });
  const answered = [];
  phase = 'answer the member until it leaves'; await echoUntil(editor.p, ['bye'], answered);
  phase = 'host offline'; await saved(editor.p); await stopEditor();
  await waitFor(async () => (await online()) === 0, 60000, 'host offline in the directory'); say('host-offline', { room, expects: 'start-host' });
  await controlFile('start-host', waitMs, 'operator signal that the member is waiting');
  phase = 'host returns from its own file'; createRequests = 0; editor = await startEditor();
  await editor.p.evaluate(t => window.probe.store.actions.loadProject(window.probe.proc.loadProc(t), 'reopen-remote-host.proc'), hostFile);
  await editor.p.waitForFunction(r => { const v = window.probe.sync.getSyncView(); return v.shared?.projectId === r && v.shared.username === 'host' && v.status === 'online'; }, { timeout: 60000 }, room)
    .catch(async () => { throw new Error(`host did not recover: ${JSON.stringify(await hostView(editor.p))}`); });
  await waitFor(async () => (await online()) > 0, 30000, 'host registration after return'); say('host-online', { room });
  phase = 'answer the member until it is done'; await echoUntil(editor.p, ['done'], answered);
  const view = await hostView(editor.p);
  const evidence = { ok: true, kind: 'promptcut-remote-host-v1', room, service, hostPidBefore: firstPid, hostPidAfter: editor.pid, answeredMemberEdits: answered,
    hostAfterReturn: view, recoveryCreateRequests: createRequests, isolatedEditorPort: port, evidenceDirectory: root };
  assert.equal(createRequests, 0, 'the returning host must not create a room'); assert.notEqual(editor.pid, firstPid);
  fs.writeFileSync(path.join(control, 'remote-host-evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} catch (e) {
  console.error(JSON.stringify({ ok: false, phase, errorClass: e?.name || 'Error', message: String(e?.message ?? '').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 400), evidenceDirectory: root })); process.exitCode = 1;
} finally {
  if (editor?.child.exitCode === null) await stopEditor().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}
