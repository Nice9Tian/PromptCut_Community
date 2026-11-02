/**
 * A4:SKILL 改为桌面 APP 经 MCP 直连同一个项目(计划 docs/plan/agent-workflow-plan.md A4)。用例 SM-1～SM-14。
 *
 *   - 会话身份:两个桌面会话各记各的、厂商从 clientInfo 认得出(SM-1～SM-3);
 *   - 端口发现与没有实例时的说明(SM-4);
 *   - 登记写配置:只在临时目录、先备份、条目名固定、撤销还原(SM-5～SM-7);
 *   - 桌面会话的创造力等级跟项目(SM-8);A2 / A3 的提示出现在桌面会话的结果里(SM-9、SM-10);
 *   - AI 栏分组的数据(SM-11);SKILL 闸按类型(SM-12,细节见 skill-gate.test.mjs);
 *   - 归档后没有残留入口、对话式布局的入口不再出现(SM-13、SM-14,棘轮:只许减少)。
 *
 * **不写任何用户配置**:登记的配置路径一律经参数 / 环境变量指到临时目录;mcp-server 用 PROMPTCUT_PORT_FILE 指到临时的端口文件。
 * 跑法:node --test server/test/skill-mcp.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-skill-mcp-'));
process.env.PROMPTCUT_SKILL_DIR = path.join(TMP, 'skill');
// 保险:本文件里任何登记调用即使漏传路径,也只会落到临时目录
process.env.PROMPTCUT_CLAUDE_CONFIG = path.join(TMP, 'guard', '.claude.json');
process.env.PROMPTCUT_CODEX_CONFIG = path.join(TMP, 'guard', 'config.toml');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MCP = path.join(ROOT, 'server', 'mcp-server.mjs');
const { vendorOf, desktopSessionKey, threadOf, discoverEditor, SKILL_INSTRUCTIONS, GUIDE_TOOL, skillGuide } = await import('../agent/desktop-mcp.mjs');
const reg = await import('../desktop-register.mjs');
const { createAgentSessions } = await import('../agent/agent-sessions.mjs');
const { createAgentBoards } = await import('../agent/agent-board.mjs');
const { createMultiAgent } = await import('../agent/multi-agent.mjs');
const { checkCreativity } = await import('../agent/creativity-gate.mjs');
const { annotateResult, createUserEditingBoard, userEditingFor } = await import('../agent/user-editing.mjs');
const { createDesktopActivity } = await import('../agent/desktop-activity.mjs');
const gate = await import('../skill-gate.mjs');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* ------------------------------------------------------------------ 身份 */

test('SM-1 the vendor is identified from clientInfo: Claude Code reports claude-code, Codex reports codex-mcp-client; if unrecognized, use the name it reports itself', () => {
  assert.deepEqual(vendorOf({ name: 'claude-code', title: 'Claude Code', version: '2.1.284' }), { vendor: 'claude-code', label: 'Claude Code', client: { name: 'claude-code', version: '2.1.284' } });
  assert.deepEqual(vendorOf({ name: 'codex-mcp-client', version: '0.157.1' }), { vendor: 'codex', label: 'Codex', client: { name: 'codex-mcp-client', version: '0.157.1' } });
  const other = vendorOf({ name: 'Some Agent', title: 'Some client', version: '1' });
  assert.equal(other.vendor, 'some-agent');
  assert.equal(other.label, 'Some client');
  assert.equal(vendorOf(null).vendor, 'unknown');
  assert.equal(vendorOf({ name: 'x\u0000y' }).client.name, 'xy', 'Control characters are removed');
});

test('SM-2 session identity: one per MCP process (Claude Code); Codex per thread, the same thread keeps the same identity across processes and different threads differ; the format matches the chat ID', () => {
  const a = desktopSessionKey({ processSession: 'procA' });
  const b = desktopSessionKey({ processSession: 'procB' });
  assert.notEqual(a, b);
  for (const k of [a, b]) assert.match(k, /^desk-[A-Za-z0-9_-]{1,59}$/);
  const t1 = desktopSessionKey({ processSession: 'p1', thread: 'thread-1', vendor: 'codex' });
  assert.equal(desktopSessionKey({ processSession: 'p2', thread: 'thread-1', vendor: 'codex' }), t1, 'The same thread keeps the same identity after switching processes');
  assert.notEqual(desktopSessionKey({ processSession: 'p1', thread: 'thread-2', vendor: 'codex' }), t1);
  assert.equal(threadOf({ threadId: 'abc' }), 'abc');
  assert.equal(threadOf({ 'x-codex-turn-metadata': { thread_id: 'def' } }), 'def');
  assert.equal(threadOf({ 'claudecode/toolUseId': 'toolu_1' }), null, 'Claude Code _meta has no session id');
});

/** 一个假的编辑器:记下 /api/mcp/call 的请求体 */
async function fakeEditor() {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/mcp/call') bodies.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { ok: true, echo: JSON.parse(body || '{}').tool } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, bodies, close: () => { srv.close(); srv.closeAllConnections?.(); } };
}

/** 起一份 mcp-server,按行收 JSON-RPC 回复 */
function mcpClient(env) {
  const clean = { ...process.env };
  for (const k of ['PROMPTCUT_AGENT', 'PROMPTCUT_CALLER', 'PROMPTCUT_PORT', 'PROMPTCUT_PORT_FILE']) delete clean[k];
  const child = spawn(process.execPath, [MCP], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const my = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
    const t0 = Date.now();
    const tick = () => {
      const line = buf.split('\n').find((l) => l.includes(`"id":${my},`) || l.includes(`"id":${my}}`));
      if (line) return resolve(JSON.parse(line));
      if (Date.now() - t0 > 10000) return reject(new Error(`No reply to ${method} within 10 seconds`));
      setTimeout(tick, 20);
    };
    tick();
  });
  return { call, kill: () => child.kill() };
}

function portFile(port, pid = process.pid) {
  const f = path.join(TMP, `port-${port}-${pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ port, host: '127.0.0.1', pid }));
  return f;
}

test('SM-3 the two desktop sessions (Claude Code, Codex) each record their own identity and vendor; instructions and get_skill_guide are present; the AI panel path does not report a desktop identity', async () => {
  const ed = await fakeEditor();
  const pf = portFile(ed.port);
  const claude = mcpClient({ PROMPTCUT_PORT_FILE: pf });
  const codex = mcpClient({ PROMPTCUT_PORT_FILE: pf });
  const cli = mcpClient({ PROMPTCUT_CALLER: 'cli', PROMPTCUT_PORT: String(ed.port), PROMPTCUT_AGENT: 'conv-x' });
  try {
    const i1 = await claude.call('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.284' }, capabilities: {} });
    const i2 = await codex.call('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'codex-mcp-client', version: '0.157.1' }, capabilities: {} });
    const i3 = await cli.call('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'claude-code' }, capabilities: {} });
    assert.equal(i1.result.instructions, SKILL_INSTRUCTIONS);
    assert.ok(SKILL_INSTRUCTIONS.length <= 2000, 'Claude Code limits instructions to 2048 characters');
    assert.match(SKILL_INSTRUCTIONS, /report_progress/);
    assert.equal(i2.result.instructions, SKILL_INSTRUCTIONS);
    assert.equal('instructions' in i3.result, false, 'The AI panel command-line tool does not get the SKILL prompt');

    const l1 = await claude.call('tools/list', {});
    assert.equal(l1.result.tools[0].name, GUIDE_TOOL.name, 'Desktop sessions have one extra tool, get_skill_guide');
    const schemaCalls = ed.bodies.filter((b) => b.tool === 'list_cards' || b.tool === 'list_parts');
    assert.ok(schemaCalls.length >= 2 && schemaCalls.every((b) => !('caller' in b)), 'Fetching the card manifest to assemble the schema when listing tools does not report a desktop identity (not grouped, not governed by the gate)');
    const l3 = await cli.call('tools/list', {});
    assert.equal(l3.result.tools.some((t) => t.name === GUIDE_TOOL.name), false);
    assert.equal(l3.result.tools.some((t) => t.name === 'submit_merge'), false, 'submit_merge is archived');

    const before = ed.bodies.length;
    const g = await claude.call('tools/call', { name: GUIDE_TOOL.name, arguments: {} });
    assert.match(g.result.content[0].text, /report_progress/);
    assert.match(g.result.content[0].text, /Claude Code/);
    assert.equal(ed.bodies.length, before, 'get_skill_guide is answered locally, without going through the editor');
    assert.match(skillGuide(), /SKILL/);

    await claude.call('tools/call', { name: 'get_project', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_A' } });
    await claude.call('tools/call', { name: 'update_clip', arguments: { clipId: 'c1' } });
    await codex.call('tools/call', { name: 'get_project', arguments: {}, _meta: { threadId: 'th-1' } });
    await codex.call('tools/call', { name: 'get_project', arguments: {}, _meta: { threadId: 'th-2' } });
    await cli.call('tools/call', { name: 'get_project', arguments: {} });
    const calls = ed.bodies.filter((b) => b.tool === 'get_project' || b.tool === 'update_clip');
    const [a1, a2, b1, b2, c1] = calls.slice(-5);
    assert.equal(a1.caller.type, 'desktop');
    assert.equal(a1.caller.vendor, 'claude-code');
    assert.equal(a1.caller.label, 'Claude Code');
    assert.equal(a1.caller.key, a2.caller.key, 'The same Claude Code session has the same identity');
    assert.equal(a1.callId, 'toolu_A', 'Claude Code toolUseId is forwarded as before');
    assert.equal('agent' in a1, false, 'Desktop sessions carry no AI panel chat ID');
    assert.equal(b1.caller.vendor, 'codex');
    assert.notEqual(b1.caller.key, a1.caller.key, 'The two desktop apps each keep their own');
    assert.notEqual(b1.caller.key, b2.caller.key, 'Codex splits identities by thread');
    assert.equal(b1.caller.thread, 'th-1');
    assert.equal(c1.agent, 'conv-x');
    assert.equal('caller' in c1, false, 'The AI panel command-line tool does not report a desktop identity');
  } finally {
    claude.kill(); codex.kill(); cli.kill(); ed.close();
  }
});

/* ------------------------------------------------------------------ 端口发现 */

test('SM-4 port discovery: arguments / environment variables take priority; a missing port file, a corrupted one, or an exited process each return a clear explanation; mcp-server passes the explanation to the desktop app as is', async () => {
  const none = discoverEditor({ env: {}, argv: [], tmpdir: path.join(TMP, 'no-such') });
  assert.equal(none.ok, false);
  assert.match(none.message, /No running PromptCut found/);
  assert.match(none.message, /Open PromptCut first/);
  const dead = discoverEditor({ env: { PROMPTCUT_PORT_FILE: portFile(5881, 424242) }, argv: [], pidAlive: () => false });
  assert.equal(dead.ok, false);
  assert.match(dead.message, /not running.*424242.*5881/);
  const bad = path.join(TMP, 'bad-port.json');
  fs.writeFileSync(bad, '{ broken');
  assert.match(discoverEditor({ env: { PROMPTCUT_PORT_FILE: bad }, argv: [] }).message, /Cannot read PromptCut's port file/);
  const live = discoverEditor({ env: { PROMPTCUT_PORT_FILE: portFile(5882) }, argv: [] });
  assert.deepEqual([live.ok, live.port, live.hosts[0]], [true, 5882, '127.0.0.1']);
  assert.equal(discoverEditor({ env: { PROMPTCUT_PORT: '5883', PROMPTCUT_PORT_FILE: portFile(5882) }, argv: [] }).port, 5883, 'The port from the environment variable takes priority over the port file');
  assert.equal(discoverEditor({ env: {}, argv: ['--port-file', portFile(5884)] }).port, 5884, 'The --port-file argument');
  assert.equal(discoverEditor({ env: { PROMPTCUT_PORT: '5883' }, argv: ['--port', '5885'] }).port, 5885, 'The --port argument has top priority');
  assert.equal(discoverEditor({ env: { PROMPTCUT_PORT: 'abc' }, argv: [] }).ok, false);

  // 真的起 mcp-server:没有实例时 tools/call 回 isError 与说明,不挂住
  const c = mcpClient({ PROMPTCUT_PORT_FILE: path.join(TMP, 'missing-port.json') });
  try {
    await c.call('initialize', { clientInfo: { name: 'claude-code' } });
    const r = await c.call('tools/call', { name: 'get_project', arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /No running PromptCut found/);
    // 端口文件指着一个没人听的端口(借一个空闲端口再放掉)
    const idle = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const c2 = mcpClient({ PROMPTCUT_PORT_FILE: portFile(idle) });
    try {
      const r2 = await c2.call('tools/call', { name: 'get_project', arguments: {} });
      assert.equal(r2.result.isError, true);
      assert.ok(r2.result.content[0].text.includes(`not running (no service on port ${idle})`), r2.result.content[0].text);
    } finally { c2.kill(); }
  } finally { c.kill(); }
});

/* ------------------------------------------------------------------ 登记 */

const WANT = { command: 'C:\\Program Files\\PromptCut\\node.exe', args: ['C:\\Program Files\\PromptCut\\app\\server\\mcp-server.mjs'] };

test('SM-5 registering with Claude Code (JSON): writes only to a temp directory, backs up the original file first, the entry name is fixed as promptcut, other keys are untouched; registering again changes nothing; after undo the file matches the original', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'claude-'));
  const file = path.join(dir, '.claude.json');
  const stateDir = path.join(dir, 'state');
  const original = { numStartups: 7, projects: { 'D:/x': { allowedTools: [] } }, mcpServers: { other: { type: 'stdio', command: 'x', args: [] } } };
  fs.writeFileSync(file, JSON.stringify(original, null, 2));
  const opts = { configPath: file, stateDir };
  assert.equal(reg.registrationStatus('claude-code', WANT, opts).registered, false);
  const r = reg.register('claude-code', WANT, opts);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.backup && r.backup.startsWith(stateDir), 'The backup is in PromptCut\'s own state directory');
  assert.deepEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')), original, 'The backup is the original file from before registration');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers).sort(), ['other', 'promptcut']);
  assert.deepEqual(after.mcpServers.promptcut, { type: 'stdio', command: WANT.command, args: WANT.args, env: {} });
  assert.equal(after.numStartups, 7);
  assert.deepEqual(after.projects, original.projects);
  const st = reg.registrationStatus('claude-code', WANT, opts);
  assert.deepEqual([st.registered, st.current, st.undoable], [true, true, true]);
  assert.equal(reg.register('claude-code', WANT, opts).unchanged, true, 'Nothing is written if it is already the same entry');
  // 登记之后 Claude Code 自己又改了别的键:撤销只还原 promptcut 这一条,不丢这次改动
  fs.writeFileSync(file, JSON.stringify({ ...after, numStartups: 8 }, null, 2));
  const u = reg.unregister('claude-code', WANT, opts);
  assert.equal(u.ok, true, u.error);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...original, numStartups: 8 });
  assert.equal(reg.registrationStatus('claude-code', WANT, opts).registered, false);
});

test('SM-6 an entry with the same name already exists: registering overwrites it and undo restores the original one; undo is refused if the user has modified the entry; if the original file does not exist it is created, and after undo there is no promptcut', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'claude2-'));
  const file = path.join(dir, '.claude.json');
  const opts = { configPath: file, stateDir: path.join(dir, 'state') };
  const mine = { type: 'stdio', command: 'old-node', args: ['old.mjs'], env: { A: '1' } };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { promptcut: mine } }));
  const st0 = reg.registrationStatus('claude-code', WANT, opts);
  assert.deepEqual([st0.registered, st0.current], [true, false], 'A same-name entry pointing elsewhere');
  assert.equal(reg.register('claude-code', WANT, opts).ok, true);
  assert.equal(reg.unregister('claude-code', WANT, opts).restored, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.promptcut, mine, 'Restored to the entry from before registration');
  // 用户改过
  assert.equal(reg.register('claude-code', WANT, opts).ok, true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.mcpServers.promptcut.args.push('--debug');
  fs.writeFileSync(file, JSON.stringify(doc));
  const refused = reg.unregister('claude-code', WANT, opts);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /has been modified/);
  // 原文件不存在
  const fresh = path.join(dir, 'fresh', '.claude.json');
  const o2 = { configPath: fresh, stateDir: path.join(dir, 'state2') };
  const r = reg.register('claude-code', WANT, o2);
  assert.equal(r.ok, true);
  assert.equal(r.backup, null, 'No original file means no backup');
  assert.equal(reg.unregister('claude-code', WANT, o2).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')).mcpServers, {});
  // 坏 JSON:不动它
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ nope');
  assert.throws(() => reg.register('claude-code', WANT, { configPath: broken, stateDir: path.join(dir, 's3') }), /is not valid JSON/);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ nope');
});

test('SM-7 registering with Codex (TOML): touches only the [mcp_servers.promptcut] table (including its subtables), everything else is kept as is; after undo the text is identical to the original character by character; other forms are rejected; the default path can be overridden', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'codex-'));
  const file = path.join(dir, 'config.toml');
  const opts = { configPath: file, stateDir: path.join(dir, 'state') };
  const original = [
    'model = "gpt-6-sol"',
    '',
    '[mcp_servers.other]',
    'command = "x"',
    '',
    '[mcp_servers.promptcut]',
    'command = "old"',
    'args = ["old.mjs"]',
    '',
    '[mcp_servers.promptcut.env]',
    'A = "1"',
    '',
    '[projects."D:\\\\x"]',
    'trust_level = "trusted"',
    '',
  ].join('\r\n');
  fs.writeFileSync(file, original);
  const r = reg.register('codex', WANT, opts);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(r.backup, 'utf8'), original, 'The backup is the original text');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\[mcp_servers\.promptcut\]\r\ncommand = "C:\\\\Program Files\\\\PromptCut\\\\node\.exe"\r\nargs = \["C:\\\\Program Files\\\\PromptCut\\\\app\\\\server\\\\mcp-server\.mjs"\]/);
  assert.equal(text.includes('[mcp_servers.promptcut.env]'), false, 'The subtable is replaced together with it');
  assert.match(text, /\[mcp_servers\.other\]\r\ncommand = "x"/);
  assert.match(text, /trust_level = "trusted"/);
  assert.equal(reg.registrationStatus('codex', WANT, opts).current, true);
  assert.equal(reg.unregister('codex', WANT, opts).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'Restored character by character after undo');

  // 新文件
  const fresh = path.join(dir, 'new', 'config.toml');
  const o2 = { configPath: fresh, stateDir: path.join(dir, 's2') };
  assert.equal(reg.register('codex', WANT, o2).ok, true);
  assert.match(fs.readFileSync(fresh, 'utf8'), /^\[mcp_servers\.promptcut\]\n/);
  assert.equal(reg.unregister('codex', WANT, o2).ok, true);
  assert.equal(fs.readFileSync(fresh, 'utf8').includes('promptcut'), false);

  // 别的写法
  const odd = path.join(dir, 'odd.toml');
  fs.writeFileSync(odd, '[mcp_servers]\npromptcut = { command = "x" }\n');
  assert.throws(() => reg.register('codex', WANT, { configPath: odd, stateDir: path.join(dir, 's3') }), /in another form/);

  // 默认路径:环境变量覆盖;测试进程里指的是临时目录
  assert.equal(reg.configPathOf('codex'), process.env.PROMPTCUT_CODEX_CONFIG);
  assert.equal(reg.configPathOf('claude-code'), process.env.PROMPTCUT_CLAUDE_CONFIG);
  assert.equal(reg.configPathOf('codex', { env: {}, home: 'H:\\u' }), path.join('H:\\u', '.codex', 'config.toml'));
  assert.equal(reg.configPathOf('claude-code', { env: {}, home: 'H:\\u' }), path.join('H:\\u', '.claude.json'));
  assert.ok(reg.stateDirOf().startsWith(TMP), 'The backup directory follows PROMPTCUT_SKILL_DIR');
  assert.equal(reg.ENTRY_NAME, 'promptcut');
  assert.deepEqual(reg.mcpCommand('R:\\app', { execPath: 'N:\\node.exe' }), { command: 'N:\\node.exe', args: [path.join('R:\\app', 'server', 'mcp-server.mjs')] });
});

/* ------------------------------------------------------------------ 等级、A2、A3 */

test('SM-8 the creativity level of a desktop session follows the project: the override passed at registration does not count; creating a card is rejected when the project is at a low tier and allowed at a high tier', () => {
  const s = createAgentSessions();
  s.register('desk-A', { type: 'desktop', vendor: 'claude-code', label: 'Claude Code', client: { name: 'claude-code', version: '2' }, role: null, creativity: 'high' });
  const e = s.get('desk-A');
  assert.deepEqual([e.type, e.vendor, e.label, e.client.name, e.override], ['desktop', 'claude-code', 'Claude Code', 'claude-code', null]);
  const low = s.creativityOf('desk-A', 'low');
  assert.equal(low.level, 'low');
  assert.match(low.source, /Desktop app sessions follow the project/);
  assert.equal(checkCreativity('create_card', { id: 'new-card', tsx: 'x' }, low.level, { cardExists: () => false }).ok, false);
  assert.equal(checkCreativity('create_card', { id: 'new-card', tsx: 'x' }, s.creativityOf('desk-A', 'high').level, { cardExists: () => false }).ok, true);
  assert.equal(s.creativityOf('desk-A', 'medium').level, 'medium', 'When the project changes its level, the desktop session changes with it');
});

/** 与 vite-plugin-ai.ts 相同的接法:登记表、公告板(厂商名用 label)、multiAgent */
function rig() {
  const sessions = createAgentSessions();
  const labelOf = (k) => { const e = sessions.get(k); return e.label ?? e.vendor; };
  const boards = createAgentBoards(() => ({ labelOf, infoOf: (k) => { const e = sessions.get(k); return { role: e.role, parent: e.parent }; } }));
  const board = () => boards.boardFor('p');
  const ma = createMultiAgent({ sessions, board, projectCreativity: () => 'high', openTab: async () => { throw new Error('The editor is not open, so there is no tab to open'); } });
  return { sessions, board, ma };
}

test('SM-9 the A3 notice appears in the desktop session result: another desktop session writes into the scope it declared, both sides are told, and the vendor name is written in the notice; a desktop session cannot spawn a subagent', async () => {
  const r = rig();
  r.sessions.register('desk-A', { type: 'desktop', vendor: 'claude-code', label: 'Claude Code', role: null });
  r.sessions.register('desk-B', { type: 'desktop', vendor: 'codex', label: 'Codex', role: null });
  const b = r.board();
  b.declareScope('desk-A', { scope: 'Cut 1->Track 2' });
  const p0 = { tracks: [{ id: 't2', name: 'Track 2', clips: [] }], cuts: [{ id: 'c1', name: 'Cut 1' }], activeCutId: 'c1' };
  const p1 = { ...p0, tracks: [{ ...p0.tracks[0], clips: [{ id: 'x' }] }] };
  const w = await r.ma.wrap('desk-B', 'add_clip', async () => {
    b.noteCommit({ rev: 2, opId: 'op1', actor: { role: 'agent', session: 'agent:desk-B' }, before: p0, after: p1 });
    return { ok: true, id: 'x' };
  });
  assert.match(w.notice, /This write falls within a scope another Agent is editing: "Cut 1->Track 2" that Agent desk-A\(Claude Code\)/);
  const a = await r.ma.wrap('desk-A', 'get_clip', async () => ({ ok: true }));
  assert.match(a.notice, /Someone else is editing a scope you declared: Agent desk-B\(Codex\) using add_clip changed Cut 1->Track 2/);
  // 消息:没有页签可投,带在它下一次工具结果里
  b.deliver({ from: 'desk-B', to: 'desk-A', text: 'I\'ll edit track2' });
  const m = await r.ma.wrap('desk-A', 'get_project', async () => ({ ok: true }));
  assert.match(JSON.stringify(m), /I'll edit track2/);
  const sp = await r.ma.handle('spawn_agent', { role: 'director', task: 't' }, 'desk-A');
  assert.equal(sp.ok, false);
  assert.equal(sp.code, 'no-tab');
});

test('SM-10 the A2 "user is editing" notice appears in the desktop session result (for the clips named by the arguments; when reading the whole project, all are listed)', () => {
  const editing = createUserEditingBoard();
  editing.report('page-1', [{ clipId: 'c1', kind: 'drag' }]);
  const cur = editing.current();
  const out = annotateResult({ ok: true }, { userEditing: userEditingFor({ tool: 'update_clip', args: { clipId: 'c1' }, editing: cur }) });
  assert.equal(out.userEditing[0].clipId, 'c1');
  assert.match(out.notice, /User is editing/);
  const whole = annotateResult({ ok: true }, { userEditing: userEditingFor({ tool: 'get_project', args: {}, editing: cur }) });
  assert.equal(whole.userEditing.length, 1);
  const other = annotateResult({ ok: true }, { userEditing: userEditingFor({ tool: 'update_clip', args: { clipId: 'c9' }, editing: cur }) });
  assert.equal(other.notice, undefined, 'No notice if the clips the user is editing were not touched');
});

/* ------------------------------------------------------------------ AI 栏分组 */

test('SM-11 data for AI panel groups: one group per session, with the operation in progress, recent calls, and progress reports (validated); limit and idleness', () => {
  let t = 1000;
  let changes = 0;
  const act = createDesktopActivity({ now: () => t, onChange: () => { changes++; }, limits: { recentCalls: 3, reports: 2, sessions: 2, idleMs: 5000 } });
  const A = { vendor: 'claude-code', label: 'Claude Code', client: { name: 'claude-code', version: '2' } };
  const B = { vendor: 'codex', label: 'Codex' };
  const h1 = act.begin('desk-A', A, 'update_clip', { clipId: 'c1' });
  let snap = act.snapshot();
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0].current, { tool: 'update_clip', since: 1000 });
  assert.equal(snap[0].label, 'Claude Code');
  t = 1100;
  act.end(h1, { ok: true }, null);
  act.end(act.begin('desk-B', B, 'add_clip', {}), { ok: false, error: 'SKILL mode is off' }, null);
  act.begin('desk-A', A, 'report_progress', { stage: 'Rough cut', done: ['Arranged three segments'], todo: ['Add captions'] });
  act.begin('desk-A', A, 'report_progress', { done: [1] });
  snap = act.snapshot();
  assert.deepEqual(snap.map((s) => s.id), ['desk-A', 'desk-B'], 'Most recently active first');
  const a = snap[0];
  assert.equal(a.reports.length, 1, 'Reports that fail validation do not count');
  assert.deepEqual(a.reports[0].report.done, ['Arranged three segments']);
  assert.equal(a.recent[0].tool, 'update_clip');
  assert.equal(snap[1].last.ok, false);
  assert.match(snap[1].last.error, /SKILL/);
  assert.ok(changes >= 5);
  // 上限:第三个会话把最久没动的挤掉;闲置超时的不给
  act.begin('desk-C', B, 'get_project', {});
  assert.equal(act.has('desk-B'), false);
  t = 1100 + 6000;
  assert.deepEqual(act.snapshot().map((s) => s.id).sort(), ['desk-A', 'desk-C'], 'A session with calls still running does not disappear due to idleness');
  const idle = createDesktopActivity({ now: () => t, limits: { idleMs: 5000 } });
  idle.end(idle.begin('desk-Z', B, 'get_project', {}), { ok: true }, null);
  assert.equal(idle.snapshot().length, 1);
  t += 6000;
  assert.equal(idle.snapshot().length, 0, 'Sessions that are idle past the timeout with no calls running are no longer shown');
});

test('SM-12 the SKILL gate is by caller type (same logic as vite-plugin-ai.ts: registered callers use their registered type, unregistered ones are unknown)', () => {
  const s = createAgentSessions();
  s.register('desk-A', { type: 'desktop', vendor: 'codex', role: null });
  s.register('conv-1', { type: 'cli', vendor: 'claude' });
  const typeOf = (k) => { const e = s.get(k); return e.registeredAt ? e.type : 'unknown'; };
  gate.closeGate('test');
  assert.equal(gate.checkGate('get_project', typeOf('desk-A')).ok, false);
  assert.equal(gate.checkGate('get_project', typeOf('conv-1')).ok, true);
  assert.equal(gate.checkGate('get_project', typeOf('never-seen')).ok, true);
  gate.openGate();
  assert.equal(gate.checkGate('get_project', typeOf('desk-A')).ok, true);
  gate.closeGate('test');
  // 总入口随 Agent 服务搬到 server/agent/service/instance.mjs(契约 cloud-agent-contract.md 第 2.1 节)
  const src = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'service', 'instance.mjs'), 'utf8');
  assert.match(src, /gate\.checkGate\(tool, callerEntry\.registeredAt \? callerEntry\.type : 'unknown'\)/, 'The main entry point decides by the type in the registry');
  assert.equal(/PROMPTCUT_HEADLESS/.test(fs.readFileSync(path.join(ROOT, 'server', 'skill-gate.mjs'), 'utf8')), false, 'No longer decides by "is it a headless instance"');
});

/* ------------------------------------------------------------------ 归档(棘轮:只许减少) */

function walk(dirs, skip) {
  const files = [];
  const go = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      const rel = path.relative(ROOT, file).replaceAll('\\', '/');
      if (item.isDirectory()) { if (item.name !== 'node_modules') go(file); continue; }
      if (!/\.(tsx?|mjs|js|cjs|css|json|html)$/.test(item.name) || skip.has(rel)) continue;
      files.push([rel, fs.readFileSync(file, 'utf8')]);
    }
  };
  for (const d of dirs) go(path.join(ROOT, d));
  return files;
}

test('SM-13 after archiving the headless instance, task directory, submit_merge and three-way merge, no leftover entry points remain: the files, identifiers and routes are all gone', () => {
  const gone = ['scripts/headless.mjs', 'scripts/pc-tool.mjs', 'server/skill-templates.mjs', 'server/claude-desktop.ts', 'server/codex-desktop.ts',
    'server/vite-plugin-view-gate.ts', 'src/headless.ts', 'src/editor/right/SkillLock.tsx', 'src/editor/io/combineImport.ts', 'src/kernel/combine.ts'];
  for (const f of gone) assert.equal(fs.existsSync(path.join(ROOT, f)), false, `${f} should have been deleted`);
  const patterns = [/\bsubmit_merge\b/, /merge-request\.json/, /merge-result/, /\bserveMergeRequest\b/, /\bapplyCombine\b/, /\bcombineImport\b/,
    /scripts\/headless\.mjs/, /__pcHeadless/, /\binstallHeadlessHooks\b/, /PROMPTCUT_OWNER_TOKEN/, /PROMPTCUT_VIEW_TOKEN/, /\bviewGatePlugin\b/,
    /\bSkillLock\b/, /\/api\/skill\/jobs/, /\/api\/skill\/start/, /skill-templates/, /\blaunchClaudeTask\b/, /\bcreateCodexTask\b/,
    /menu-merge-skill/, /Merge Skill results/, /\beditorOwner\b/, /x-pc-owner/];
  // 这几个是说明历史的测试与数据文件(说明里记着删了哪些入口)
  const skip = new Set(['server/test/skill-mcp.test.mjs', 'server/test/c10-api-ratchet-baseline.json', 'server/test/c10a-online-build.test.mjs', 'server/test/c10a-online-api-paths.json']);
  const hits = [];
  for (const [rel, text] of walk(['src', 'server', 'scripts'], skip)) for (const re of patterns) if (re.test(text)) hits.push(`${rel} :: ${re}`);
  assert.deepEqual(hits, [], `Archived entry points still have leftovers:\n${hits.join('\n')}`);
  // PROMPTCUT_HEADLESS 只许留在「起子进程时把它从环境里删掉」的清单里(防旧环境带进来)
  const envScrub = new Set(['server/render-node/host.mjs', 'cloud/scripts/render-host.mjs', 'server/test/render-host.test.mjs', 'server/test/c66-integ.test.mjs', 'server/test/media-tiers.test.mjs']);
  const headless = walk(['src', 'server', 'scripts'], skip).filter(([rel, text]) => /PROMPTCUT_HEADLESS/.test(text) && !envScrub.has(rel) && !rel.startsWith('scripts/probes/')).map(([rel]) => rel);
  assert.deepEqual(headless, [], `PROMPTCUT_HEADLESS is still in feature code: ${headless.join(', ')}`);
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/test/c10-api-ratchet-baseline.json'), 'utf8')).paths;
  for (const p of ['/api/skill/jobs', '/api/skill/jobs/', '/api/skill/start']) assert.equal(baseline.includes(p), false, `The /api ratchet baseline of the online build drops ${p}`);
});

test('SM-14 the entry points of the chat layout no longer appear: the top bar switch only has Classic mode / SKILL, the layout mode module and the mini progress bar are removed, and there is no "chat" layout', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'src/editor/ModeSwitch.tsx'), 'utf8');
  assert.equal(/label: "Chat mode"/.test(sw), false);
  assert.match(sw, /label: tr\("Classic mode"\)/);
  assert.match(sw, /label: "SKILL"/);
  for (const f of ['src/editor/layoutMode.ts', 'src/editor/preview/MiniScrubber.tsx']) assert.equal(fs.existsSync(path.join(ROOT, f)), false, `${f} should have been deleted`);
  const patterns = [/\buseLayoutMode\b/, /\bgetLayoutMode\b/, /\bsetLayoutMode\b/, /\bDockMode\b/, /\buseSideVisible\b/, /\bMiniScrubber\b/, /layoutMode === "chat"/, /mode === "chat"/, /pc\.layout\.mode/, /label: "Chat mode"/];
  const hits = [];
  for (const [rel, text] of walk(['src'], new Set())) for (const re of patterns) if (re.test(text)) hits.push(`${rel} :: ${re}`);
  assert.deepEqual(hits, [], `Chat mode layout still has leftovers:\n${hits.join('\n')}`);
});
