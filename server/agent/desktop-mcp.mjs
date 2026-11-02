/**
 * 桌面 APP 经 MCP 直连(计划 `docs/plan/agent-workflow-plan.md` A4;语义 `user-workflow.md`「Agent 接入方式」「进度可见」)
 * 里 stdio MCP 服务(`server/mcp-server.mjs`)这一侧用到的纯函数:认厂商、定会话身份、找正在跑的编辑器、SKILL 提示词。
 *
 * 不依赖 vite,也不读写任何用户配置;测试直接调。
 *
 * 身份怎么认(报告 `docs/reports/AGENT-skill-mcp.md`「未知数的结论」):
 *   - Claude Code 每个会话一个 `claude.exe`、各起一份 stdio MCP 进程,`_meta` 里没有会话号 —— 一个 MCP 进程算一个会话;
 *   - Codex 每次 `tools/call` 的 `_meta` 都带 `threadId` —— 按线程认,多个线程共用一个 MCP 进程也分得开,
 *     同一个线程换了 MCP 进程(Codex 重启)还是同一个身份。
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tr } from '../i18n.mjs';

/** 已知客户端:`clientInfo.name` → 厂商 id 与给人看的名字 */
const KNOWN_CLIENTS = [
  { test: /^claude-code$/i, vendor: 'claude-code', label: 'Claude Code' },
  { test: /codex/i, vendor: 'codex', label: 'Codex' },
  { test: /^claude-ai$|^claude[- ]desktop$/i, vendor: 'claude-desktop', label: 'Claude' },
  { test: /antigravity|^agy/i, vendor: 'agy', label: 'Antigravity' },
  { test: /cursor/i, vendor: 'cursor', label: 'Cursor' },
];

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

/**
 * 从 MCP `initialize` 的 `clientInfo` 认厂商。认不出来就用它自报的名字(截短),都没有是 `unknown`。
 * @param {unknown} clientInfo
 * @returns {{ vendor: string, label: string, client: { name: string, version: string } }}
 */
export function vendorOf(clientInfo) {
  const info = clientInfo && typeof clientInfo === 'object' ? clientInfo : {};
  const name = clean(info.name, 64);
  const version = clean(info.version, 32);
  const title = clean(info.title, 64);
  const hit = name ? KNOWN_CLIENTS.find((k) => k.test.test(name)) : null;
  if (hit) return { vendor: hit.vendor, label: hit.label, client: { name, version } };
  const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return { vendor: id || 'unknown', label: title || name || tr("Unknown desktop app"), client: { name, version } };
}

/** 这个 MCP 进程自己的会话号(一个进程一个;Claude Code 就靠它区分会话) */
export function newProcessSession() {
  return randomBytes(6).toString('base64url');
}

/**
 * 桌面会话在编辑器里的对话 ID(登记表、文档服务的写入身份、公告板都按它区分)。
 * 格式与 AI 栏的对话 ID 共用 `[A-Za-z0-9_-]{1,64}`,前缀 `desk-` 一眼看得出来源。
 * @param {{ processSession: string, thread?: string | null, vendor?: string }} o
 */
export function desktopSessionKey({ processSession, thread = null, vendor = '' }) {
  if (typeof thread === 'string' && thread) {
    const h = createHash('sha256').update(`${vendor}\u0000${thread}`).digest('base64url').slice(0, 10);
    return `desk-${h}`;
  }
  const p = typeof processSession === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(processSession) ? processSession : newProcessSession();
  return `desk-${p}`;
}

/** `tools/call` 的 `_meta` 里的线程号(Codex 带 `threadId`,老版本在 `x-codex-turn-metadata.thread_id`) */
export function threadOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const ok = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v) ? v : null);
  return ok(meta.threadId) || ok(meta['x-codex-turn-metadata']?.thread_id) || null;
}

function defaultPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // 别的用户的进程:在,只是没权限发信号
    return e?.code === 'EPERM';
  }
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

/** 公共端口文件的位置:编辑器起来时写(`server/vite-plugin-ai.ts`),测试与探针起的编辑器不写 */
export function defaultPortFile(tmpdir = os.tmpdir()) {
  return path.join(tmpdir, 'promptcut', 'port.json');
}

/**
 * 找用户正在用的那个编辑器实例。优先级:
 *   1. `--port <n>` 或环境变量 `PROMPTCUT_PORT`(AI 栏的命令行工具那条路由编辑器自己塞);
 *   2. `--port-file <文件>` 或 `PROMPTCUT_PORT_FILE`(探针用它指到自己起的实例,不读真正的 port.json);
 *   3. 公共的 `%TEMP%\promptcut\port.json`。
 * 端口文件里记了进程号且那个进程已经不在,算没有在跑的实例。
 *
 * @returns {{ ok: true, port: number, hosts: string[], source: string } | { ok: false, message: string, source: string }}
 */
export function discoverEditor({ env = process.env, argv = process.argv.slice(2), tmpdir = os.tmpdir(), pidAlive = defaultPidAlive, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const hostsOf = (lockHost) => {
    const set = new Set();
    if (typeof lockHost === 'string' && lockHost) {
      let host = lockHost;
      if (host === '::' || host === '0.0.0.0') host = '127.0.0.1';
      else if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
      set.add(host);
    }
    set.add('127.0.0.1');
    return [...set];
  };
  const explicit = argValue(argv, '--port') ?? env.PROMPTCUT_PORT;
  if (explicit != null && explicit !== '') {
    const port = Number.parseInt(String(explicit), 10);
    if (!(port > 0 && port < 65536)) return { ok: false, source: 'port', message: tr("The specified port {0} is invalid", explicit) };
    return { ok: true, port, hosts: hostsOf(null), source: 'port' };
  }
  const file = argValue(argv, '--port-file') || env.PROMPTCUT_PORT_FILE || defaultPortFile(tmpdir);
  let data;
  try {
    data = JSON.parse(readFile(file));
  } catch (e) {
    const missing = e?.code === 'ENOENT';
    return {
      ok: false,
      source: file,
      message: missing
        ? tr("No running PromptCut found (no port file {0}). Open PromptCut first (the desktop app, or npm run dev in the repo), then try again.", file)
        : tr("Cannot read PromptCut's port file {0} ({1}). Reopen PromptCut and try again.", file, e?.message || e),
    };
  }
  const port = Number(data?.port);
  if (!(Number.isSafeInteger(port) && port > 0 && port < 65536)) {
    return { ok: false, source: file, message: tr("PromptCut's port file {0} has no valid port. Reopen PromptCut and try again.", file) };
  }
  if (Number.isSafeInteger(data?.pid) && !pidAlive(data.pid)) {
    return { ok: false, source: file, message: tr("PromptCut is not running: the process {0} (port {1}) recorded in the port file has exited. Open PromptCut first, then try again.", data.pid, port) };
  }
  return { ok: true, port, hosts: hostsOf(data?.host), source: file };
}

/**
 * 给桌面 APP 的 SKILL 提示词,短版:放进 MCP `initialize` 的 `instructions`(Claude Code 拼进系统提示词,上限 2048 字符)。
 * 细节在 `get_skill_guide` 里,这里只说最要紧的几条。
 */
export const SKILL_INSTRUCTIONS = [
  'PromptCut is a video editing app. Through this set of tools you directly edit the project the user currently has open in PromptCut, working at the same time as the user in the editor and the other Agents in the AI panel.',
  'Call get_skill_guide once before starting to read the full procedure. Key points:',
  '1. Use only this set of tools to read and write the project. Do not modify project files on disk or PromptCut\'s source code.',
  '2. PromptCut cannot see your text replies. What the user sees in PromptCut are the progress entries you submit with report_progress: submit one after each stage (done: what was done, todo: what remains, problems: problems encountered), and submit one with final: true when the whole task ends.',
  '3. When a tool result carries a "user is editing" or "just changed" hint, do not overwrite that spot: tell the user or edit somewhere else; when deleting clips, tracks or effects, state the reason in reason.',
  '4. Do not retry rejected calls repeatedly (PromptCut is not open, not in SKILL mode, creativity level too low); follow the explanation in the result and tell the user.',
  '5. When you need the user to decide or answer, stop and ask; do not keep editing.',
].join('\n');

/** 桌面会话才有的本地工具:回完整的 SKILL 做法(不经编辑器,编辑器没开也能读) */
export const GUIDE_TOOL = Object.freeze({
  name: 'get_skill_guide',
  description: 'Call once before starting: reads PromptCut\'s full procedure (how to read the project, how to edit, how to view frames, how to report progress with report_progress, what to do when rejected). Takes no parameters and changes nothing.',
  inputSchema: { type: 'object', properties: {} },
});

/** `get_skill_guide` 回的全文 */
export function skillGuide({ vendorLabel = '' } = {}) {
  return [
    '# Working in PromptCut',
    '',
    `You are an Agent session${vendorLabel ? ` in ${vendorLabel}` : ' in the desktop app'}, connected through MCP to the PromptCut the user is using. What you edit is the project the user currently has open: the user may have the editor open at the same time, watching and editing, and there may be other Agents in the AI panel too. Each session is an independent identity, and every write you make is recorded under your name.`,
    '',
    '## Procedure',
    '1. Read first: get_project shows the whole project (tracks, clips, duration), list_cards / list_media show which cards and media exist; use see_frames to view frames.',
    '2. Before acting, decide which spots to change. When several parties edit at once, first declare the range you will edit with declare_scope (cut->track), use list_agents to see where others are editing, and coordinate with send_message when needed.',
    '3. Edit: use the matching tools (add_clip, update_clip, set_clip_rect, etc.). After editing, check with see_frames that it looks right.',
    '4. Report: see the next section.',
    '',
    '## Reporting progress (required)',
    'PromptCut cannot get your text replies. What the user sees in PromptCut\'s AI panel are the progress entries you submit with report_progress, displayed the same way as Agents in the AI panel:',
    '- Submit one after each stage: stage is the stage name (at most 12 characters), done is what was done, todo is what remains, problems is the problems encountered; at most 8 items per group, each at most 60 characters.',
    '- Submit once more when the whole task ends, with final set to true.',
    '- Do not stuff long explanations into an entry; one entry says one thing.',
    '',
    '## Protection rules',
    '- A tool result has userEditing or "user is editing": the user is editing that spot, so do not overwrite it yet; this is only a hint, the user may well have asked you to change exactly this, so ask if unsure.',
    '- A result has "just changed" or "overwritten by ...": another Agent or the user just touched the same spot, and both sides know; coordinate with send_message if needed.',
    '- When deleting clips, tracks or effects, reason is required and is written for the user to read.',
    '- The creativity level follows the project\'s setting: the low tier can only change parameters of existing cards and effects, the middle tier can change their code but not create new ones, the high tier can do everything. Calls beyond the level are rejected; when rejected, tell the user as the result says, and do not work around it.',
    '',
    '## When rejected',
    '- "PromptCut is not running": ask the user to open PromptCut.',
    '- "Not in SKILL mode": ask the user to switch to SKILL in PromptCut\'s top bar.',
    '- "The editor is not open": this tool must run in the editor, so ask the user to open the editor.',
    '- Do not retry any of the above repeatedly; explain clearly, then wait for the user.',
    '',
    '## Other',
    '- Use only this set of tools to change the project; do not read or write project files on disk, PromptCut\'s install directory or its source code.',
    '- When you need the user to decide or answer, stop and ask.',
  ].join('\n');
}
