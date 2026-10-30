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
  return { vendor: id || 'unknown', label: title || name || '未知的桌面 APP', client: { name, version } };
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
    if (!(port > 0 && port < 65536)) return { ok: false, source: 'port', message: `指定的端口 ${explicit} 不合法` };
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
        ? `没有找到正在运行的 PromptCut(没有端口文件 ${file})。请先打开 PromptCut(桌面版,或在仓库里 npm run dev),再回来重试。`
        : `PromptCut 的端口文件 ${file} 读不出来(${e?.message || e})。请重新打开 PromptCut 再试。`,
    };
  }
  const port = Number(data?.port);
  if (!(Number.isSafeInteger(port) && port > 0 && port < 65536)) {
    return { ok: false, source: file, message: `PromptCut 的端口文件 ${file} 里没有有效的端口。请重新打开 PromptCut 再试。` };
  }
  if (Number.isSafeInteger(data?.pid) && !pidAlive(data.pid)) {
    return { ok: false, source: file, message: `PromptCut 没在运行:端口文件里记的进程 ${data.pid}(端口 ${port})已经退出。请先打开 PromptCut,再回来重试。` };
  }
  return { ok: true, port, hosts: hostsOf(data?.host), source: file };
}

/**
 * 给桌面 APP 的 SKILL 提示词,短版:放进 MCP `initialize` 的 `instructions`(Claude Code 拼进系统提示词,上限 2048 字符)。
 * 细节在 `get_skill_guide` 里,这里只说最要紧的几条。
 */
export const SKILL_INSTRUCTIONS = [
  'PromptCut 是一个视频剪辑软件。你经这组工具直接改用户此刻在 PromptCut 里打开的那个项目,和编辑界面里的用户、AI 栏里的其它 Agent 同时协作。',
  '开工先调一次 get_skill_guide 读完整做法。要点:',
  '1. 只用这组工具读写项目,不要去改磁盘上的项目文件或 PromptCut 的源码。',
  '2. 你的文字回复 PromptCut 看不到。用户在 PromptCut 里看到的是你用 report_progress 交的进度条目:每做完一个阶段交一次(done 做了什么、todo 还剩什么、problems 遇到的问题),整个任务收尾交一次 final: true。',
  '3. 工具结果里带「用户正在编辑」或「刚改过」的提示时,先别覆盖那一处,告诉用户或换一处改;删除片段、序列、效果时 reason 写清理由。',
  '4. 被拒绝的调用(PromptCut 没开、不在 SKILL 模式、创造力等级不够)不要反复重试,照结果里的说明告诉用户。',
  '5. 需要用户做决定或回答时,停下来问,不要继续改。',
].join('\n');

/** 桌面会话才有的本地工具:回完整的 SKILL 做法(不经编辑器,编辑器没开也能读) */
export const GUIDE_TOOL = Object.freeze({
  name: 'get_skill_guide',
  description: '开工先调一次:读 PromptCut 的完整做法(怎么读项目、怎么改、怎么看画面、怎么用 report_progress 汇报进度、被拒绝时怎么办)。不需要参数,不改任何东西。',
  inputSchema: { type: 'object', properties: {} },
});

/** `get_skill_guide` 回的全文 */
export function skillGuide({ vendorLabel = '' } = {}) {
  return [
    '# 在 PromptCut 里干活',
    '',
    `你是${vendorLabel ? ` ${vendorLabel} 里的` : '桌面 APP 里的'}一个 Agent 会话,经 MCP 接入用户正在用的 PromptCut。你改的就是用户此刻打开的那个项目:用户可能同时开着编辑界面在看、在改,AI 栏里也可能有别的 Agent。每个会话是一个独立的身份,你的每次写入都记在你的名下。`,
    '',
    '## 流程',
    '1. 先读:get_project 看项目全貌(序列、片段、时长),list_cards / list_media 看有哪些卡片和素材;要看画面用 see_frames。',
    '2. 动手前想清楚改哪几处。多人同时改时先 declare_scope 声明你要改的范围(剪辑->序列),list_agents 看别人在改哪儿,必要时 send_message 协调。',
    '3. 改:用对应的工具(add_clip、update_clip、set_clip_rect 等)。改完用 see_frames 看一眼对不对。',
    '4. 汇报:见下一节。',
    '',
    '## 汇报进度(必须)',
    'PromptCut 拿不到你的文字回复。用户在 PromptCut 的 AI 栏里看到的是你用 report_progress 交上来的进度条目,和 AI 栏里的 Agent 显示方式相同:',
    '- 每做完一个阶段交一次:stage 写阶段名(12 字以内),done 写做了什么,todo 写还剩什么,problems 写遇到的问题;每组最多 8 条、每条 60 字以内。',
    '- 整个任务收尾时再交一次,final 设为 true。',
    '- 不要把长篇说明塞进条目,一条说一件事。',
    '',
    '## 保护规则',
    '- 工具结果里有 userEditing 或「用户正在编辑」:用户正在改那一处,先别覆盖;这只是提示,用户可能正是让你改这里,拿不准就问。',
    '- 结果里有「刚改过」「被……覆盖了」:别的 Agent 或用户刚动过同一处,双方都知道了;需要的话用 send_message 协调。',
    '- 删除片段、序列、效果时 reason 必填,写给用户看。',
    '- 创造力等级跟随项目的设置:低档只能改已有卡片和效果的参数,中档能改它们的代码但不能新建,高档都可以。越级的调用会被拒绝,拒绝时照结果告诉用户,不要绕。',
    '',
    '## 被拒绝时',
    '- 「PromptCut 没在运行」:请用户打开 PromptCut。',
    '- 「不在 SKILL 模式」:请用户在 PromptCut 顶栏切到 SKILL。',
    '- 「编辑界面没有打开」:这个工具要在编辑界面里执行,请用户打开编辑界面。',
    '- 以上都不要反复重试,说清楚后等用户。',
    '',
    '## 其它',
    '- 只用这组工具改项目,不要去读写磁盘上的项目文件、PromptCut 的安装目录或源码。',
    '- 需要用户做决定或回答时,停下来问。',
  ].join('\n');
}
