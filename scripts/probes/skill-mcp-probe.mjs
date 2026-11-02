/**
 * SKILL probe via direct MCP connection (plan docs/plan/agent-workflow-plan.md A4). Entirely local,
 * **does not call models, does not spend quota, does not write any user config**:
 * Desktop app is simulated by two real stdio MCP clients (launches `server/mcp-server.mjs`, with
 * `clientInfo` in `initialize` reported as Claude Code and Codex respectively), locating the editor
 * launched by this probe itself via a temporary port file (`PROMPTCUT_PORT_FILE`), with SKILL status
 * and registration config both pointing to temporary directories (`PROMPTCUT_SKILL_DIR`,
 * `PROMPTCUT_CLAUDE_CONFIG`, `PROMPTCUT_CODEX_CONFIG`).
 *
 *   node scripts/probes/skill-mcp-probe.mjs [--port 5880] [--shots <dir>] [--keep]
 *
 * Launches a dev server itself (port 5880, stages 5881/5882; only 5880-5899 allowed; with
 * PROMPTCUT_NO_PORT_FILE=1, does not touch public port.json), actually opens the editor (?editor),
 * places three cards in a new project, and then:
 *   K1 Two desktop sessions initialize: obtain SKILL instructions and get_skill_guide; under
 *      Classic mode, their calls are blocked by the SKILL gate, project is untouched;
 *   K2 Click "SKILL" in top bar → dialog (registration status reads config in temporary directory,
 *      showing "Not registered") → click "Enter SKILL mode";
 *   K3 Both sessions modify one card each: writes land on page, each records its own identity
 *      (change records on bulletin board, two desktop sessions in registry, vendor recognized);
 *   K4 AI panel shows two groups, labeled with vendor (Claude Code / Codex) and current operation;
 *      when a session runs wait, its group shows "Waiting"; progress submitted by report_progress
 *      is displayed as a report card in AI panel;
 *   K5 A2: "User is editing" reported by page appears in desktop session read/write results;
 *   K6 A3: One session declares scope, the other writes into it, both receive notices in results
 *      (with vendor name); overwriting what another just wrote includes overwrote in result;
 *   K7 Creativity level follows project: after project changed to "Low", desktop session creating
 *      card is rejected;
 *   K8 SKILL floating window preview: when desktop session completes a timeline operation in SKILL
 *      mode, last-action.png appears in temporary SKILL directory;
 *   K9 Switch back to "Classic mode" in top bar: desktop session calls are rejected again.
 * Screenshots (saved by default to skill-mcp-probe-shots under system temporary directory):
 * skill-dialog.png, ai-bar-groups.png, ai-bar-busy.png.
 *
 * Only terminates processes launched by this probe itself (dev server, two MCP child processes,
 * Puppeteer's Chrome). Last line of output is a single line of JSON (counts of ok, fails, passes).
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { flagArg } from './probe-connect.mjs';
import { REPO, startDevServer } from '../lib/dev-server.mjs';

const PORT = Number(flagArg('port', 5880));
if (!(PORT >= 5880 && PORT + 2 <= 5899)) throw new Error(`Port ${PORT} is not within 5880-5899, the range allotted to this probe (the stages take +1 and +2 as well)`);
const shots = flagArg('shots', path.join(os.tmpdir(), 'skill-mcp-probe-shots'));
fs.mkdirSync(shots, { recursive: true });
const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mcp-probe-'));
const SKILL_DIR = path.join(TMP, 'skill');
const PORT_FILE = path.join(TMP, 'port.json');
const FAKE_HOME = path.join(TMP, 'home');

const fails = [];
const passes = [];
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 600) : ''));
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${!cond && extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 600) : ''}`);
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

/** Simulates a desktop app session: one stdio MCP server + JSON-RPC */
function desktopSession(label) {
  const env = { ...process.env, PROMPTCUT_PORT_FILE: PORT_FILE };
  for (const k of ['PROMPTCUT_AGENT', 'PROMPTCUT_CALLER', 'PROMPTCUT_PORT']) delete env[k];
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'mcp-server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', () => {});
  let id = 0;
  const rpc = (method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
    const my = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
    const t0 = Date.now();
    const tick = () => {
      const lines = buf.split('\n');
      const line = lines.find((l) => l.startsWith('{') && (l.includes(`"id":${my},`) || l.includes(`"id":${my}}`)));
      if (line) return resolve(JSON.parse(line));
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`${label}: ${method} got no reply within ${timeoutMs / 1000} seconds`));
      setTimeout(tick, 20);
    };
    tick();
  });
  /** Calls a tool, returns parsed result object (returns { __error } when isError) */
  const tool = async (name, args = {}, meta) => {
    const r = await rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    const text = r.result?.content?.[0]?.text ?? '';
    if (r.result?.isError) return { __error: text };
    try { return JSON.parse(text); } catch { return { __text: text }; }
  };
  return { rpc, tool, kill: () => { try { child.kill(); } catch { /* Already exited */ } } };
}

const own = [];
let browser = null;
let server = null;
try {
  server = await startDevServer({
    port: PORT,
    logFile: path.join(shots, `dev-${PORT}.log`),
    env: {
      PROMPTCUT_NO_PORT_FILE: '1',
      PROMPTCUT_DATA_DIR: path.join(TMP, 'data'),
      PROMPTCUT_EXPORT_DIR: path.join(TMP, 'export'),
      PROMPTCUT_SKILL_DIR: SKILL_DIR,
      // Registration dialog reads these two configs: point to temporary directory, writes only here
      // even if register is actually clicked
      PROMPTCUT_CLAUDE_CONFIG: path.join(FAKE_HOME, '.claude.json'),
      PROMPTCUT_CODEX_CONFIG: path.join(FAKE_HOME, '.codex', 'config.toml'),
    },
  });
  own.push(server);
  const origin = server.origin;
  // Port file: same shape as public port.json written by editor, just placed in temporary directory
  fs.writeFileSync(PORT_FILE, JSON.stringify({ port: server.port, host: '127.0.0.1', pid: server.pid, startedAt: Date.now() }));
  const getJson = async (p) => (await fetch(origin + p)).json();

  browser = await puppeteer.launch({ headless: true, args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 180000, polling: 500 });
  await page.waitForFunction(() => !document.querySelector('[data-pc="probe-gate"]'), { timeout: 120000, polling: 500 }).catch(() => {});

  const ids = await page.evaluate(async () => {
    const m = await import('/src/store/project.ts');
    const reg = await import('/src/kernel/registry.ts');
    m.actions.newProject?.('skill-mcp-probe');
    const card = reg.allCards().find((c) => c.kind !== 'audio' && !c.id.startsWith('user'));
    const a = m.actions.addCardClip(card.id, 1, { duration: 3 });
    const b = m.actions.addCardClip(card.id, 6, { duration: 3 });
    const c = m.actions.addCardClip(card.id, 11, { duration: 3 });
    m.actions.select([]);
    return { a: a?.id ?? null, b: b?.id ?? null, c: c?.id ?? null, card: card.id };
  });
  check(!!ids.a && !!ids.b && !!ids.c, 'K0 three cards placed in the new project', ids);
  const bound = await waitFor(async () => { const s = await getJson('/api/agent/status'); return s.bound ? s : null; }, 60000, 500);
  check(!!bound, 'K0 Agent server is bound to the project copy (desktop session writes go through the document service)', bound && { mode: bound.mode });

  /* K1 Two desktop sessions */
  const A = desktopSession('Claude Code');
  const B = desktopSession('Codex');
  own.push({ stop: A.kill }, { stop: B.kill });
  const initA = await A.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.284' } });
  const initB = await B.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.157.1' } });
  check(/report_progress/.test(initA.result?.instructions ?? '') && initB.result?.instructions === initA.result?.instructions, 'K1 initialize returns the SKILL prompt (instructions)');
  const listA = await A.rpc('tools/list', {});
  check(listA.result?.tools?.[0]?.name === 'get_skill_guide' && listA.result.tools.some((t) => t.name === 'update_clip'), 'K1 tool list: get_skill_guide comes first, the same tool set as the AI panel', listA.result?.tools?.length);
  const guide = await A.tool('get_skill_guide');
  check(/report_progress/.test(guide.__text ?? ''), 'K1 get_skill_guide returns the full procedure');
  const THREAD = 'probe-thread-1';
  const metaB = { threadId: THREAD };
  const deniedA = await A.tool('update_clip', { clipId: ids.a, opacity: 0.5 });
  check(deniedA?.skillClosed === true && /not in SKILL mode/.test(deniedA.error ?? ''), 'K1 in Classic mode, desktop session writes are blocked by the SKILL gate, with a clear explanation', deniedA);
  const opacityA0 = await page.evaluate(async (id) => (await import('/src/store/project.ts')).getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.opacity ?? null, ids.a);
  check(opacityA0 !== 0.5, 'K1 the blocked call did not change the project', opacityA0);

  /* K2 Click SKILL in top bar → dialog → enter */
  await page.click('[data-pc="mode-skill"]');
  await page.waitForSelector('[data-pc="skill-dialog"]', { timeout: 10000 });
  await waitFor(() => page.$('[data-pc="skill-target-claude-code"]'), 10000);
  const dlg = await page.$eval('[data-pc="skill-dialog"]', (el) => el.innerText);
  check(/Claude Code/.test(dlg) && /Codex/.test(dlg) && /Not registered/.test(dlg), 'K2 SKILL dialog lists the registration status of Claude Code / Codex (reads the config in the temp directory)', dlg.slice(0, 300));
  check(dlg.includes(FAKE_HOME) || dlg.includes(FAKE_HOME.replaceAll('\\', '/')), 'K2 the config path shown in the dialog is the probe\'s temp directory, not the user\'s', dlg.slice(0, 400));
  await page.screenshot({ path: path.join(shots, 'skill-dialog.png') });
  await page.click('[data-pc="skill-enter"]');
  const skillOn = await waitFor(async () => ((await getJson('/api/skill-mode')).state?.active ? true : null), 10000);
  check(!!skillOn, 'K2 after clicking "Enter SKILL mode", the SKILL state is on (temp directory)');
  check(fs.existsSync(path.join(SKILL_DIR, 'skill-state.json')), 'K2 the state file is written to the temp SKILL directory');
  check(!fs.existsSync(path.join(FAKE_HOME, '.claude.json')) && !fs.existsSync(path.join(FAKE_HOME, '.codex')), 'K2 no config is written without clicking Register (not even in the temp directory)');

  /* K3 Both sessions modify one card each */
  const writeWithReread = async (s, clipId, args, meta) => {
    let out = null;
    for (let i = 0; i < 10; i += 1) {
      await s.tool('get_clip', { clipId }, meta);
      out = await s.tool('update_clip', { clipId, ...args }, meta);
      if (!out?.__error) return out;
      await sleep(300);
    }
    return out;
  };
  await A.tool('get_project', {}, { 'claudecode/toolUseId': 'toolu_probe_1' });
  await B.tool('get_project', {}, metaB);
  const wA = await writeWithReread(A, ids.a, { opacity: 0.8 });
  const wB = await writeWithReread(B, ids.b, { opacity: 0.7 }, metaB);
  check(wA?.ok === true && wB?.ok === true, 'K3 writes from both desktop sessions land', { a: wA?.__error ?? wA?.ok, b: wB?.__error ?? wB?.ok });
  const landed = await waitFor(async () => page.evaluate(async (ids) => {
    const clips = (await import('/src/store/project.ts')).getState().project.tracks.flatMap((t) => t.clips);
    const a = clips.find((c) => c.id === ids.a)?.opacity;
    const b = clips.find((c) => c.id === ids.b)?.opacity;
    return a === 0.8 && b === 0.7 ? { a, b } : null;
  }, ids), 8000);
  check(!!landed, 'K3 the page received the writes from both sides', landed);
  const desk = await getJson('/api/agent/desktop');
  const sA = desk.sessions.find((s) => s.vendor === 'claude-code');
  const sB = desk.sessions.find((s) => s.vendor === 'codex');
  check(desk.sessions.length === 2 && !!sA && !!sB && sA.id !== sB.id, 'K3 the registry holds two desktop sessions with separate identities and a recognizable vendor', desk.sessions.map((s) => ({ id: s.id, vendor: s.vendor, type: s.type })));
  check(sA?.type === 'desktop' && sB?.type === 'desktop' && sA?.label === 'Claude Code' && sB?.label === 'Codex', 'K3 type is desktop, vendor name is Claude Code / Codex', [sA?.type, sA?.label, sB?.type, sB?.label]);
  const board = await getJson('/api/agent/board');
  const writers = board.changes.filter((c) => c.kind === 'change' && c.by?.kind === 'agent').map((c) => c.by.agent);
  check(writers.includes(sA?.id) && writers.includes(sB?.id), 'K3 in the bulletin board\'s change log (fed by the document service\'s commit stream), each side records its own identity', board.changes.slice(-6));

  /* K4 Groups in AI panel */
  await A.tool('report_progress', { stage: 'Rough cut', done: ['Set the first card to 80% opacity'], todo: ['Add one more caption'] });
  await B.tool('report_progress', { done: ['Set the second card to 70% opacity'], problems: ['Probe: no real model'], final: true }, metaB);
  const groups = await waitFor(async () => {
    const g = await page.$$eval('[data-pc="desktop-session"]', (els) => els.map((el) => ({
      id: el.getAttribute('data-session'),
      vendor: el.querySelector('[data-pc="desktop-vendor"]')?.textContent ?? '',
      op: el.querySelector('[data-pc="desktop-op"]')?.textContent ?? '',
      reports: el.querySelectorAll('.ai-report').length,
      text: el.innerText.slice(0, 300),
    })));
    return g.length === 2 && g.every((x) => x.reports > 0) ? g : null;
  }, 10000);
  check(!!groups, 'K4 the AI panel shows two desktop session groups, each with its own progress report card', groups);
  const gA = groups?.find((g) => g.vendor === 'Claude Code');
  const gB = groups?.find((g) => g.vendor === 'Codex');
  check(!!gA && !!gB, 'K4 the two groups are labeled with the vendors Claude Code / Codex respectively', groups?.map((g) => g.vendor));
  check(/report_progress|Last step/.test(gA?.op ?? ''), 'K4 the group is labeled with the current (last step) operation', gA?.op);
  check(/Rough cut/.test(gA?.text ?? '') && /Set the first card/.test(gA?.text ?? '') && /Round summary/.test(gB?.text ?? ''), 'K4 the progress report is shown as the AI panel\'s report card (stage name, done, round summary)', [gA?.text, gB?.text]);
  const aiBox = await page.$('[data-pc="desktop-sessions"]');
  const panel = aiBox ? await aiBox.evaluateHandle((el) => el.closest('[data-pc="right"]') ?? el) : null;
  if (panel) await panel.asElement().screenshot({ path: path.join(shots, 'ai-bar-groups.png') });
  else await page.screenshot({ path: path.join(shots, 'ai-bar-groups.png') });
  // Ongoing operation: A runs wait(3 seconds) once, during which its group displays "Waiting"
  const waiting = A.tool('wait', { seconds: 3 });
  const busyOp = await waitFor(async () => {
    const op = await page.$eval(`[data-session="${sA?.id}"] [data-pc="desktop-op"]`, (el) => el.textContent).catch(() => '');
    return /Waiting · wait/.test(op) ? op : null;
  }, 2500, 100);
  check(!!busyOp, 'K4 while a session runs wait, its group shows "Waiting · wait"', busyOp);
  if (panel) await panel.asElement().screenshot({ path: path.join(shots, 'ai-bar-busy.png') });
  await waiting;
  const idleOp = await waitFor(async () => {
    const op = await page.$eval(`[data-session="${sA?.id}"] [data-pc="desktop-op"]`, (el) => el.textContent).catch(() => '');
    return /Last step/.test(op) ? op : null;
  }, 3000, 100);
  check(!!idleOp, 'K4 after it finishes, "Last step" is shown', idleOp);

  /* K5 A2 */
  await fetch(`${origin}/api/agent/editing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 'probe-page', entities: [{ clipId: ids.c, kind: 'drag' }] }) });
  const readC = await B.tool('get_clip', { clipId: ids.c }, metaB);
  check(Array.isArray(readC?.userEditing) && readC.userEditing.some((e) => e.clipId === ids.c) && /user is editing/.test(readC.notice ?? ''), 'K5 a desktop session reading a clip the user is editing gets userEditing and "user is editing" in the result', readC?.notice ?? readC);
  await fetch(`${origin}/api/agent/editing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 'probe-page', entities: [] }) });

  /* K6 A3 */
  const scopeName = await page.evaluate(async (id) => {
    const p = (await import('/src/store/project.ts')).getState().project;
    const cut = (p.cuts ?? []).find((c) => c.id === p.activeCutId)?.name ?? 'Cut 1';
    return `${cut}->${p.tracks.find((t) => t.clips.some((c) => c.id === id))?.name}`;
  }, ids.a);
  const decl = await A.tool('declare_scope', { scope: scopeName, note: 'probe' });
  check(decl?.ok === true, 'K6 the Claude Code session declares a scope', { scopeName, decl });
  const into = await writeWithReread(B, ids.a, { opacity: 0.6 }, metaB);
  check(Array.isArray(into?.scopeClash) && into.scopeClash.some((c) => c.agent === sA?.id) && /Claude Code/.test(into.notice ?? ''), 'K6 the Codex session writes into the declared scope: this result carries scopeClash (the notice includes the vendor name)', into?.scopeClash ?? into);
  check(Array.isArray(into?.overwrote) && into.overwrote.some((o) => o.by === 'agent' && /Claude Code/.test(o.label ?? '')), 'K6 overwrote a clip the Claude Code session had just written: the result carries overwrote "Agent … (Claude Code) just edited"', into?.overwrote);
  await sleep(300);
  const aNext = await A.tool('get_clip', { clipId: ids.b });
  check(Array.isArray(aNext?.scopeChanges) && aNext.scopeChanges.some((c) => c.who.includes(sB?.id)), 'K6 the Claude Code session\'s next result tells it that someone else changed the scope it declared', aNext?.scopeChanges ?? aNext);
  check(Array.isArray(aNext?.overwrittenBy) && aNext.overwrittenBy.length > 0 && /Codex/.test(JSON.stringify(aNext.overwrittenBy)), 'K6 it also learns that what it wrote was overwritten by the Codex session', aNext?.overwrittenBy);

  /* K7 Creativity level follows project */
  await page.evaluate(async () => { (await import('/src/store/project.ts')).actions.setProjectMeta({ creativity: 'low' }); });
  const lowSeen = await waitFor(async () => {
    const d = await getJson('/api/agent/desktop');
    return d.sessions.every((s) => s.creativity === 'low') ? d.sessions.map((s) => s.creativity) : null;
  }, 10000, 300);
  check(!!lowSeen, 'K7 after the project is changed to "Low", the effective level of both desktop sessions also becomes low', lowSeen);
  const newCard = await A.tool('create_card', { id: 'probe-new-card', source: 'export default {}' });
  check(newCard?.ok === false && newCard.creativity?.current === 'low', 'K7 at the low tier, creating a new card from a desktop session is rejected', newCard);
  await page.evaluate(async () => { (await import('/src/store/project.ts')).actions.setProjectMeta({ creativity: 'high' }); });

  /* K8 Floating window preview */
  const png = await waitFor(async () => (fs.existsSync(path.join(SKILL_DIR, 'last-action.png')) ? fs.statSync(path.join(SKILL_DIR, 'last-action.png')).size : null), 30000, 500);
  check(!!png, 'K8 after a desktop session\'s timeline operation in SKILL mode, last-action.png appears in the temp SKILL directory (rendered by the page per skill.preview)', png);

  /* K9 Click back to Classic mode */
  await page.click('[data-pc="mode-classic"]');
  const off = await waitFor(async () => ((await getJson('/api/skill-mode')).state?.active === false ? true : null), 10000);
  check(!!off, 'K9 clicking "Classic mode" in the top bar exits SKILL mode');
  const deniedAgain = await B.tool('get_project', {}, metaB);
  check(deniedAgain?.skillClosed === true, 'K9 after exiting, desktop session calls are rejected again (including read-only ones)', deniedAgain);
  check(pageErrors.length === 0, 'K9 the page had no uncaught exceptions throughout', pageErrors.slice(0, 5));
} catch (e) {
  check(false, `Probe error: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* Already closed */ }
  for (const p of own.reverse()) { try { p.stop(); } catch { /* Already stopped */ } }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Handles still not released */ } }
}
console.log(`Screenshots: ${shots}`);
console.log(JSON.stringify({ ok: fails.length === 0, fails, passes: passes.length }));
process.exit(fails.length ? 1 : 0);
