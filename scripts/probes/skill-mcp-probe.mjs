/**
 * SKILL 经 MCP 直连探针(计划 docs/plan/agent-workflow-plan.md A4)。全程本机,**不调用模型、不花额度、不写任何用户配置**:
 * 桌面 APP 由两个真的 stdio MCP 客户端模拟(起 `server/mcp-server.mjs`,`initialize` 的 `clientInfo` 分别报成
 * Claude Code 与 Codex 的样子),端口按一个临时的端口文件找到本探针自己起的编辑器(`PROMPTCUT_PORT_FILE`),
 * SKILL 状态与登记配置都指到临时目录(`PROMPTCUT_SKILL_DIR`、`PROMPTCUT_CLAUDE_CONFIG`、`PROMPTCUT_CODEX_CONFIG`)。
 *
 *   node scripts/probes/skill-mcp-probe.mjs [--port 5880] [--shots <目录>] [--keep]
 *
 * 自己起一台 dev server(端口 5880,舞台 5881/5882;只许用 5880～5899;带 PROMPTCUT_NO_PORT_FILE=1,不碰公共的 port.json),
 * 真的打开编辑台(?editor),新项目放三张卡,然后:
 *   K1 两个桌面会话 initialize:拿到 SKILL 提示词(instructions)与 get_skill_guide;传统式下它们的调用被 SKILL 闸拦下,项目没动;
 *   K2 在顶栏点「SKILL」→ 对话框(登记状态读的是临时目录里的配置,显示「未登记」)→ 点「进入 SKILL 模式」;
 *   K3 两个会话各改一张卡:写入都落到页面、各记各的身份(公告板的改动记录、登记表里两个 desktop 会话、厂商认得出);
 *   K4 AI 栏出现两个分组,标着厂商(Claude Code / Codex)与当前操作;一个会话跑 wait 时它那组显示「正在等待」;
 *      report_progress 交的进度按 AI 栏的报告卡显示;
 *   K5 A2:页面报的「用户正在编辑」出现在桌面会话读写的结果里;
 *   K6 A3:一个会话声明范围、另一个写进去,双方结果里都有提示(带厂商名);覆盖别人刚写的,结果带 overwrote;
 *   K7 创造力等级跟项目:项目改成「低」后桌面会话新建卡被拒;
 *   K8 SKILL 悬浮窗预览:SKILL 模式下桌面会话做成一次时间轴操作,临时 SKILL 目录里出现 last-action.png;
 *   K9 顶栏点回「传统式」:桌面会话的调用再次被拒。
 * 截图(缺省存到系统临时目录下的 skill-mcp-probe-shots):skill-dialog.png、ai-bar-groups.png、ai-bar-busy.png。
 *
 * 只结束本探针自己起的进程(dev server、两个 MCP 子进程、puppeteer 的 Chrome)。结果最后一行是一行 JSON(ok、fails、passes 数)。
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
if (!(PORT >= 5880 && PORT + 2 <= 5899)) throw new Error(`端口 ${PORT} 不在分给本探针的 5880～5899 里(舞台再占 +1、+2)`);
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

/** 模拟桌面 APP 的一个会话:一份 stdio MCP 服务 + JSON-RPC */
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
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`${label}:${method} ${timeoutMs / 1000} 秒没回`));
      setTimeout(tick, 20);
    };
    tick();
  });
  /** 调一个工具,回解析过的结果对象(isError 时回 { __error }) */
  const tool = async (name, args = {}, meta) => {
    const r = await rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    const text = r.result?.content?.[0]?.text ?? '';
    if (r.result?.isError) return { __error: text };
    try { return JSON.parse(text); } catch { return { __text: text }; }
  };
  return { rpc, tool, kill: () => { try { child.kill(); } catch { /* 已经退了 */ } } };
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
      // 登记对话框会读这两份配置:指到临时目录,真的点了登记也只写这里
      PROMPTCUT_CLAUDE_CONFIG: path.join(FAKE_HOME, '.claude.json'),
      PROMPTCUT_CODEX_CONFIG: path.join(FAKE_HOME, '.codex', 'config.toml'),
    },
  });
  own.push(server);
  const origin = server.origin;
  // 端口文件:和编辑器写公共 port.json 同样的形状,只是放在临时目录
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
  check(!!ids.a && !!ids.b && !!ids.c, 'K0 新项目里放了三张卡', ids);
  const bound = await waitFor(async () => { const s = await getJson('/api/agent/status'); return s.bound ? s : null; }, 60000, 500);
  check(!!bound, 'K0 Agent 服务端绑上了项目副本(桌面会话的写入走文档服务)', bound && { mode: bound.mode });

  /* K1 两个桌面会话 */
  const A = desktopSession('Claude Code');
  const B = desktopSession('Codex');
  own.push({ stop: A.kill }, { stop: B.kill });
  const initA = await A.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.284' } });
  const initB = await B.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.157.1' } });
  check(/report_progress/.test(initA.result?.instructions ?? '') && initB.result?.instructions === initA.result?.instructions, 'K1 initialize 回 SKILL 提示词(instructions)');
  const listA = await A.rpc('tools/list', {});
  check(listA.result?.tools?.[0]?.name === 'get_skill_guide' && listA.result.tools.some((t) => t.name === 'update_clip'), 'K1 工具列表:get_skill_guide 在最前,与 AI 栏同一套工具', listA.result?.tools?.length);
  const guide = await A.tool('get_skill_guide');
  check(/report_progress/.test(guide.__text ?? ''), 'K1 get_skill_guide 回完整做法');
  const THREAD = 'probe-thread-1';
  const metaB = { threadId: THREAD };
  const deniedA = await A.tool('update_clip', { clipId: ids.a, opacity: 0.5 });
  check(deniedA?.skillClosed === true && /不在 SKILL 模式/.test(deniedA.error ?? ''), 'K1 传统式下桌面会话的写入被 SKILL 闸拦下,说明写清楚', deniedA);
  const opacityA0 = await page.evaluate(async (id) => (await import('/src/store/project.ts')).getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.opacity ?? null, ids.a);
  check(opacityA0 !== 0.5, 'K1 被拦下的调用没有改项目', opacityA0);

  /* K2 顶栏点 SKILL → 对话框 → 进入 */
  await page.click('[data-pc="mode-skill"]');
  await page.waitForSelector('[data-pc="skill-dialog"]', { timeout: 10000 });
  await waitFor(() => page.$('[data-pc="skill-target-claude-code"]'), 10000);
  const dlg = await page.$eval('[data-pc="skill-dialog"]', (el) => el.innerText);
  check(/Claude Code/.test(dlg) && /Codex/.test(dlg) && /未登记/.test(dlg), 'K2 SKILL 对话框列出 Claude Code / Codex 的登记状态(读的是临时目录的配置)', dlg.slice(0, 300));
  check(dlg.includes(FAKE_HOME) || dlg.includes(FAKE_HOME.replaceAll('\\', '/')), 'K2 对话框显示的配置路径是探针的临时目录,不是用户的', dlg.slice(0, 400));
  await page.screenshot({ path: path.join(shots, 'skill-dialog.png') });
  await page.click('[data-pc="skill-enter"]');
  const skillOn = await waitFor(async () => ((await getJson('/api/skill-mode')).state?.active ? true : null), 10000);
  check(!!skillOn, 'K2 点「进入 SKILL 模式」后 SKILL 状态开着(临时目录)');
  check(fs.existsSync(path.join(SKILL_DIR, 'skill-state.json')), 'K2 状态文件写在临时 SKILL 目录');
  check(!fs.existsSync(path.join(FAKE_HOME, '.claude.json')) && !fs.existsSync(path.join(FAKE_HOME, '.codex')), 'K2 没点登记就没有写任何配置(连临时目录的也没写)');

  /* K3 两个会话各改一张卡 */
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
  check(wA?.ok === true && wB?.ok === true, 'K3 两个桌面会话的写入都落地', { a: wA?.__error ?? wA?.ok, b: wB?.__error ?? wB?.ok });
  const landed = await waitFor(async () => page.evaluate(async (ids) => {
    const clips = (await import('/src/store/project.ts')).getState().project.tracks.flatMap((t) => t.clips);
    const a = clips.find((c) => c.id === ids.a)?.opacity;
    const b = clips.find((c) => c.id === ids.b)?.opacity;
    return a === 0.8 && b === 0.7 ? { a, b } : null;
  }, ids), 8000);
  check(!!landed, 'K3 页面收到了两边的写入', landed);
  const desk = await getJson('/api/agent/desktop');
  const sA = desk.sessions.find((s) => s.vendor === 'claude-code');
  const sB = desk.sessions.find((s) => s.vendor === 'codex');
  check(desk.sessions.length === 2 && !!sA && !!sB && sA.id !== sB.id, 'K3 登记表里两个桌面会话,身份分开,厂商认得出', desk.sessions.map((s) => ({ id: s.id, vendor: s.vendor, type: s.type })));
  check(sA?.type === 'desktop' && sB?.type === 'desktop' && sA?.label === 'Claude Code' && sB?.label === 'Codex', 'K3 类型是 desktop,厂商名 Claude Code / Codex', [sA?.type, sA?.label, sB?.type, sB?.label]);
  const board = await getJson('/api/agent/board');
  const writers = board.changes.filter((c) => c.kind === 'change' && c.by?.kind === 'agent').map((c) => c.by.agent);
  check(writers.includes(sA?.id) && writers.includes(sB?.id), 'K3 公告板的改动记录(由文档服务的提交流喂)里两边各记各的身份', board.changes.slice(-6));

  /* K4 AI 栏的分组 */
  await A.tool('report_progress', { stage: '粗剪', done: ['把第一张卡调成 80% 不透明'], todo: ['再加一段字幕'] });
  await B.tool('report_progress', { done: ['把第二张卡调成 70% 不透明'], problems: ['探针:没有真的模型'], final: true }, metaB);
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
  check(!!groups, 'K4 AI 栏里出现两个桌面会话分组,各自带进度报告卡', groups);
  const gA = groups?.find((g) => g.vendor === 'Claude Code');
  const gB = groups?.find((g) => g.vendor === 'Codex');
  check(!!gA && !!gB, 'K4 两组分别标着厂商 Claude Code / Codex', groups?.map((g) => g.vendor));
  check(/report_progress|上一步/.test(gA?.op ?? ''), 'K4 分组标着当前(上一步)操作', gA?.op);
  check(/粗剪/.test(gA?.text ?? '') && /把第一张卡/.test(gA?.text ?? '') && /本轮小结/.test(gB?.text ?? ''), 'K4 进度报告按 AI 栏的报告卡显示(阶段名、做了、本轮小结)', [gA?.text, gB?.text]);
  const aiBox = await page.$('[data-pc="desktop-sessions"]');
  const panel = aiBox ? await aiBox.evaluateHandle((el) => el.closest('[data-pc="right"]') ?? el) : null;
  if (panel) await panel.asElement().screenshot({ path: path.join(shots, 'ai-bar-groups.png') });
  else await page.screenshot({ path: path.join(shots, 'ai-bar-groups.png') });
  // 正在进行的操作:A 跑一次 wait(3 秒),这期间它那组显示「正在等待」
  const waiting = A.tool('wait', { seconds: 3 });
  const busyOp = await waitFor(async () => {
    const op = await page.$eval(`[data-session="${sA?.id}"] [data-pc="desktop-op"]`, (el) => el.textContent).catch(() => '');
    return /正在等待 · wait/.test(op) ? op : null;
  }, 2500, 100);
  check(!!busyOp, 'K4 会话跑 wait 时它那组显示「正在等待 · wait」', busyOp);
  if (panel) await panel.asElement().screenshot({ path: path.join(shots, 'ai-bar-busy.png') });
  await waiting;
  const idleOp = await waitFor(async () => {
    const op = await page.$eval(`[data-session="${sA?.id}"] [data-pc="desktop-op"]`, (el) => el.textContent).catch(() => '');
    return /上一步/.test(op) ? op : null;
  }, 3000, 100);
  check(!!idleOp, 'K4 跑完之后显示「上一步」', idleOp);

  /* K5 A2 */
  await fetch(`${origin}/api/agent/editing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 'probe-page', entities: [{ clipId: ids.c, kind: 'drag' }] }) });
  const readC = await B.tool('get_clip', { clipId: ids.c }, metaB);
  check(Array.isArray(readC?.userEditing) && readC.userEditing.some((e) => e.clipId === ids.c) && /用户正在编辑/.test(readC.notice ?? ''), 'K5 桌面会话读用户正在编辑的片段,结果带 userEditing 与「用户正在编辑」', readC?.notice ?? readC);
  await fetch(`${origin}/api/agent/editing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 'probe-page', entities: [] }) });

  /* K6 A3 */
  const scopeName = await page.evaluate(async (id) => {
    const p = (await import('/src/store/project.ts')).getState().project;
    const cut = (p.cuts ?? []).find((c) => c.id === p.activeCutId)?.name ?? '剪辑1';
    return `${cut}->${p.tracks.find((t) => t.clips.some((c) => c.id === id))?.name}`;
  }, ids.a);
  const decl = await A.tool('declare_scope', { scope: scopeName, note: '探针' });
  check(decl?.ok === true, 'K6 Claude Code 会话声明范围', { scopeName, decl });
  const into = await writeWithReread(B, ids.a, { opacity: 0.6 }, metaB);
  check(Array.isArray(into?.scopeClash) && into.scopeClash.some((c) => c.agent === sA?.id) && /Claude Code/.test(into.notice ?? ''), 'K6 Codex 会话写进它声明的范围:这次结果带 scopeClash(提示里带厂商名)', into?.scopeClash ?? into);
  check(Array.isArray(into?.overwrote) && into.overwrote.some((o) => o.by === 'agent' && /Claude Code/.test(o.label ?? '')), 'K6 覆盖了 Claude Code 会话刚写的片段:结果带 overwrote「Agent …(Claude Code)刚改过」', into?.overwrote);
  await sleep(300);
  const aNext = await A.tool('get_clip', { clipId: ids.b });
  check(Array.isArray(aNext?.scopeChanges) && aNext.scopeChanges.some((c) => c.who.includes(sB?.id)), 'K6 Claude Code 会话下一次结果得知别人改了它声明的范围', aNext?.scopeChanges ?? aNext);
  check(Array.isArray(aNext?.overwrittenBy) && aNext.overwrittenBy.length > 0 && /Codex/.test(JSON.stringify(aNext.overwrittenBy)), 'K6 也得知自己写的被 Codex 会话覆盖了', aNext?.overwrittenBy);

  /* K7 创造力等级跟项目 */
  await page.evaluate(async () => { (await import('/src/store/project.ts')).actions.setProjectMeta({ creativity: 'low' }); });
  const lowSeen = await waitFor(async () => {
    const d = await getJson('/api/agent/desktop');
    return d.sessions.every((s) => s.creativity === 'low') ? d.sessions.map((s) => s.creativity) : null;
  }, 10000, 300);
  check(!!lowSeen, 'K7 项目改成「低」,两个桌面会话生效的等级都跟着变成低', lowSeen);
  const newCard = await A.tool('create_card', { id: 'probe-new-card', source: 'export default {}' });
  check(newCard?.ok === false && newCard.creativity?.current === 'low', 'K7 低档时桌面会话新建卡被拒', newCard);
  await page.evaluate(async () => { (await import('/src/store/project.ts')).actions.setProjectMeta({ creativity: 'high' }); });

  /* K8 悬浮窗预览 */
  const png = await waitFor(async () => (fs.existsSync(path.join(SKILL_DIR, 'last-action.png')) ? fs.statSync(path.join(SKILL_DIR, 'last-action.png')).size : null), 30000, 500);
  check(!!png, 'K8 SKILL 模式下桌面会话的时间轴操作,临时 SKILL 目录里有了 last-action.png(页面按 skill.preview 渲的)', png);

  /* K9 点回传统式 */
  await page.click('[data-pc="mode-classic"]');
  const off = await waitFor(async () => ((await getJson('/api/skill-mode')).state?.active === false ? true : null), 10000);
  check(!!off, 'K9 顶栏点「传统式」退出 SKILL 模式');
  const deniedAgain = await B.tool('get_project', {}, metaB);
  check(deniedAgain?.skillClosed === true, 'K9 退出后桌面会话的调用再次被拒(包括只读的)', deniedAgain);
  check(pageErrors.length === 0, 'K9 全程页面没有未捕获的异常', pageErrors.slice(0, 5));
} catch (e) {
  check(false, `探针异常:${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* 已经关了 */ }
  for (const p of own.reverse()) { try { p.stop(); } catch { /* 已经停了 */ } }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 还有句柄没放 */ } }
}
console.log(`截图:${shots}`);
console.log(JSON.stringify({ ok: fails.length === 0, fails, passes: passes.length }));
process.exit(fails.length ? 1 : 0);
