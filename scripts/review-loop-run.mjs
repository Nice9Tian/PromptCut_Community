/**
 * 长时间真跑审查环路:自己起一台 dev server,无头打开编辑器页面并一直连着,
 * 用 API 直连发一条开了审查环路的对话,把进度流式打出来,跑完收工。
 *
 *   node scripts/review-loop-run.mjs --prompt "<消息>" [--attach <文件>]... [--open <.proc>]
 *
 * **一趟完整运行约 20～35 分钟、约 600 万输入 token。真跑之前先和用户确认。**
 * 只想确认环境搭得起来,用 `--connect-only`,不花 token。
 *
 * | 参数 | 说明 |
 * |---|---|
 * | `--prompt <文本>` / `--prompt-file <文件>` | 用户这一条消息,二选一(`--connect-only` 时不用) |
 * | `--attach <文件>` | 可重复。复制进 `<work>/pc-work/<会话id>/`,作为附件发出,站内地址 `/@pcwork/<会话id>/<文件名>` |
 * | `--open <.proc>` | 编辑器先用 `?open=` 打开这份工程(服务端复制一份到草稿目录,原文件不动) |
 * | `--model <名字>` | ai.json 里 `api.model`(`|` 分隔)中的一个,默认第一个 |
 * | `--work <目录>` | 默认 `%TEMP%\promptcut-review\run-<时间>` |
 * | `--port N` | 指定编辑器端口,N、N+1、N+2 都得空;默认随机挑 |
 * | `--timeout-min N` | 超过 N 分钟就中止这一趟,默认 60 |
 * | `--ai-config <ai.json>` | 直接用这份 AI 配置(同目录下的 `keys/`),不复制用户的 |
 * | `--connect-only` | 只起服务、连上编辑器、打印状态,不发对话 |
 *
 * 隔离:
 *
 * - 导出、数据、草稿、对话、附件目录全部指到 `<work>` 下面(`PROMPTCUT_EXPORT_DIR`、`_DATA_DIR`、
 *   `_PROJECTS_DIR`、`_CHATS_DIR`、`_WORK_DIR`)。
 * - AI 配置:把用户的 `ai.json`、`keys/`、`review-lessons.json` 复制到 `<work>/ai/`,
 *   `PROMPTCUT_AI_CONFIG` 指过去。审查环路会把教训写进 ai.json 同目录的 `review-lessons.json`,
 *   这样写进的是副本,不碰用户的 `%LOCALAPPDATA%\promptcut`。复制过来的 `keys/` 收工时删掉。
 * - 对话历史照旧落在 `%TEMP%\promptcut\harness-sessions\`(那是临时目录,不是用户数据)。
 *
 * 产物:
 *
 *   <work>/events.jsonl      全部 SSE 事件,一行一个
 *   <work>/reply.md          最终回复全文
 *   <work>/vite.log          dev server 的输出
 *   <work>/ai/review-lessons.json   这一趟之后的教训(有的话)
 *
 * 坑:
 *
 * - 编辑器页面是工具的执行者,整趟都要连着 `/api/mcp/events`。脚本每 15 秒查一次
 *   `/api/mcp/status`,断线、页面重载都会打 ⚠ 和时间点。不要用 Claude 桌面版的内置浏览器面板
 *   承载编辑器:面板隐藏时页面被重载过。
 * - 跑的时候别改 `server/*.ts`、`vite.config.ts`(别的会话改也算):dev server 会整台重启,
 *   跑到一半的对话被掐断。文件监听不能关 —— 定制卡的热更新靠它。脚本看到重启会打 ⚠。
 * - worker 新写的定制卡落在仓库的 `src/cards/user/`(不在 gitignore 里)。收工时列出来,不自动删。
 * - 转写要 Python(`desktop/src-tauri/runtime/python`,不入库)和 `out/pylibs`、`out/models`。
 *   worktree 里都没有:没有 Python 时一转写就失败,有 Python 缺库和模型时会现装(几个 GB)。
 *   要用主仓库那份,先设 `PROMPTCUT_PYTHON`、`PROMPTCUT_PYLIBS`、`PROMPTCUT_MODELS`。脚本启动时会提醒。
 * - 这里自己开编辑台页面,不借别的实例。
 */
import './lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { REPO, startDevServer, killTree, waitHttp, sleep, stamp } from './lib/dev-server.mjs';

const DEFAULT_ROOT = path.join(os.tmpdir(), 'promptcut-review');
const t0 = Date.now();
const clock = () => {
  const s = Math.floor((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const log = (msg) => console.log(`[${clock()}] ${msg}`);

function parseArgs(argv) {
  const o = { attach: [], timeoutMin: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 后面要跟一个值`);
      return argv[++i];
    };
    if (a === '--prompt') o.prompt = next();
    else if (a === '--prompt-file') o.prompt = fs.readFileSync(next(), 'utf8');
    else if (a === '--attach') o.attach.push(next());
    else if (a === '--open') o.open = path.resolve(next());
    else if (a === '--model') o.model = next();
    else if (a === '--work') o.work = next();
    else if (a === '--port') o.port = Number(next());
    else if (a === '--timeout-min') o.timeoutMin = Number(next());
    else if (a === '--ai-config') o.aiConfig = path.resolve(next());
    else if (a === '--connect-only') o.connectOnly = true;
    else throw new Error(`不认识的参数 ${a}`);
  }
  if (!o.connectOnly && !o.prompt?.trim()) throw new Error('要给 --prompt 或 --prompt-file(只想试环境用 --connect-only)');
  if (!(o.timeoutMin > 0)) throw new Error('--timeout-min 要是正数');
  if (o.port !== undefined && !(Number.isInteger(o.port) && o.port > 0 && o.port < 65534)) throw new Error('--port 要是一个端口号');
  for (const f of [...o.attach, ...(o.open ? [o.open] : []), ...(o.aiConfig ? [o.aiConfig] : [])]) {
    if (!fs.existsSync(f)) throw new Error(`文件不存在:${f}`);
  }
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`${e.message}\n用法见 scripts/review-loop-run.mjs 文件头`);
  process.exit(2);
}

const work = path.resolve(opts.work || path.join(DEFAULT_ROOT, `run-${stamp()}`));
const dirs = {
  PROMPTCUT_EXPORT_DIR: path.join(work, 'exports'),
  PROMPTCUT_DATA_DIR: path.join(work, 'data'),
  PROMPTCUT_PROJECTS_DIR: path.join(work, 'projects'),
  PROMPTCUT_CHATS_DIR: path.join(work, 'chats'),
  PROMPTCUT_WORK_DIR: path.join(work, 'pc-work'),
};

/* ---------------- 收工 ---------------- */

let server = null;
let browser = null;
let chat = null;         // AbortController:断开 SSE,服务端就中止这一趟
let copiedKeys = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { chat?.abort(); } catch {}
  if (browser) killTree(browser.process()?.pid);
  if (server) { server.stop(); log('已关 dev server'); }
  if (copiedKeys) {
    fs.rmSync(copiedKeys, { recursive: true, force: true });
    log('已删复制过来的 keys/');
  }
}

process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { log(`收到 ${sig},中止这一趟并收工`); cleanup(); process.exit(130); });
}
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });

/* ---------------- 准备 ---------------- */

/** 用户 AI 配置的副本。返回 { configPath, keysDir, apiReady } */
function prepareAiConfig() {
  if (opts.aiConfig) return { configPath: opts.aiConfig, keysDir: path.join(path.dirname(opts.aiConfig), 'keys'), copied: false };
  const src = process.env.PROMPTCUT_AI_CONFIG || path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut', 'ai.json');
  if (!fs.existsSync(src)) throw new Error(`没找到 AI 配置 ${src},用 --ai-config 指一份`);
  const dir = path.join(work, 'ai');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, 'ai.json'));
  const lessons = path.join(path.dirname(src), 'review-lessons.json');
  if (fs.existsSync(lessons)) fs.copyFileSync(lessons, path.join(dir, 'review-lessons.json'));
  const keys = path.join(path.dirname(src), 'keys');
  if (fs.existsSync(keys)) {
    fs.cpSync(keys, path.join(dir, 'keys'), { recursive: true });
    copiedKeys = path.join(dir, 'keys');
  }
  return { configPath: path.join(dir, 'ai.json'), keysDir: path.join(dir, 'keys'), copied: true };
}

/** 发请求之前先看一眼 API 直连配没配好,省得等服务起来才知道 */
function apiProblem({ configPath, keysDir }) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const source = cfg?.api?.source;
    if (!source) return 'ai.json 的 api.source 是空的,API 直连不会去读 key 文件';
    if (!fs.existsSync(path.join(keysDir, `${source}.key`))) return `没有 keys/${source}.key`;
    return null;
  } catch (e) {
    return `ai.json 读不了:${e.message}`;
  }
}

const KINDS = {
  video: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'],
  srt: ['srt', 'vtt'],
  json: ['json'],
  pdf: ['pdf'],
  text: ['txt', 'md'],
};
const kindOf = (file) => {
  const ext = path.extname(file).slice(1).toLowerCase();
  return Object.keys(KINDS).find((k) => KINDS[k].includes(ext)) || 'other';
};

/** 附件复制进对话工作目录,和界面「+」上传落在同一个地方 */
function prepareAttachments(convId) {
  if (!opts.attach.length) return [];
  const dir = path.join(dirs.PROMPTCUT_WORK_DIR, convId);
  fs.mkdirSync(dir, { recursive: true });
  return opts.attach.map((file) => {
    const name = path.basename(file);
    const dest = path.join(dir, name);
    fs.copyFileSync(file, dest);
    return { kind: kindOf(name), name, url: `/@pcwork/${encodeURIComponent(convId)}/${encodeURIComponent(name)}`, path: dest, bytes: fs.statSync(dest).size };
  });
}

/** src/cards/user/ 下的改动(worker 写的定制卡落在这里) */
function userCardChanges() {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src/cards/user'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  return new Set((r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
}

/* ---------------- SSE ---------------- */

async function* sse(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      try { yield JSON.parse(data); } catch { yield { type: 'unparsed', raw: data }; }
    }
  }
}

const indent = (text) => String(text).split('\n').join('\n         ');

/* ---------------- 主流程 ---------------- */

async function main() {
  fs.mkdirSync(work, { recursive: true });
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  log(`工作目录 ${work}`);

  const ai = prepareAiConfig();
  log(`AI 配置 ${ai.configPath}${ai.copied ? '(用户配置的副本)' : ''}`);
  const problem = apiProblem(ai);
  if (problem) log(`⚠ API 直连没配好:${problem}。这一趟发出去会直接报错`);
  // 转写找 Python 的顺序同 server/vite-plugin-stt.ts 的 findPython
  const python = [process.env.PROMPTCUT_PYTHON, path.join(REPO, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'),
    path.join(REPO, 'python', '.venv', 'Scripts', 'python.exe')].find((p) => p && fs.existsSync(p));
  const missing = ['pylibs', 'models'].filter((d) => !process.env[`PROMPTCUT_${d.toUpperCase()}`] && !fs.existsSync(path.join(REPO, 'out', d)));
  if (!python) log('⚠ 找不到转写用的 Python:对话里一转写就失败(/api/stt/status 回 503)。要用主仓库那份,设 PROMPTCUT_PYTHON、PROMPTCUT_PYLIBS、PROMPTCUT_MODELS');
  else if (missing.length) log(`⚠ 这个工作副本没有 out/${missing.join('、out/')}:对话里一转写就会现装(几个 GB)。要复用主仓库那份,设 PROMPTCUT_PYLIBS / PROMPTCUT_MODELS`);

  const env = { ...dirs, PROMPTCUT_AI_CONFIG: ai.configPath };
  server = await startDevServer({ env, logFile: path.join(work, 'vite.log'), port: opts.port, log });
  log(`dev server 就绪 ${server.origin}(舞台 ${server.stagePorts.join(' / ')})`);

  /* ---- 编辑器页面 ---- */
  const stats = { pageErrors: 0, consoleErrors: 0, reloads: 0, disconnects: 0 };
  // 同步追加:Ctrl+C、超时、process.exit 都不会丢掉最后几条
  const events = fs.openSync(path.join(work, 'events.jsonl'), 'a');
  const record = (ev) => fs.writeSync(events, JSON.stringify({ at: Date.now() - t0, ...ev }) + '\n');

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: [
      '--hide-scrollbars',
      '--no-first-run',
      '--disable-gpu',
      // 软件 WebGL:三维卡在无头里才不是空画布
      '--enable-unsafe-swiftshader',
      // 整趟半小时,页面不能被当成后台降频
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 960 });
  page.on('pageerror', (e) => { stats.pageErrors++; record({ type: 'page_error', message: e.message }); log(`⚠ 页面错误:${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') { stats.consoleErrors++; record({ type: 'page_console_error', text: m.text() }); } });
  page.on('response', (r) => { if (r.status() >= 400) record({ type: 'page_http_error', status: r.status(), method: r.request().method(), url: r.url() }); });
  let loaded = false;
  page.on('framenavigated', (f) => {
    if (f !== page.mainFrame()) return;
    if (loaded) { stats.reloads++; record({ type: 'page_reload', url: f.url() }); log(`⚠ 编辑器页面重载了(第 ${stats.reloads} 次)`); }
    loaded = true;
  });

  const editorUrl = `${server.origin}/?editor&nosetup=1${opts.open ? `&open=${encodeURIComponent(opts.open)}` : ''}`;
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitHttp(`${server.origin}/api/mcp/status`, (d) => d?.editorConnected === true, 90000, '等编辑器连上 MCP 桥');
  log(`编辑器已连上 MCP 桥(${editorUrl})`);

  /* ---- 每 15 秒看一次编辑器还连着没有 ---- */
  let connected = true;
  const watch = setInterval(async () => {
    try {
      const st = await fetch(`${server.origin}/api/mcp/status`).then((r) => r.json());
      if (connected && !st.editorConnected) { stats.disconnects++; record({ type: 'editor_disconnected' }); log('⚠ 编辑器断线了'); }
      if (!connected && st.editorConnected) { record({ type: 'editor_reconnected' }); log('编辑器重新连上了'); }
      connected = !!st.editorConnected;
    } catch (e) {
      if (connected) { stats.disconnects++; log(`⚠ 查不到 /api/mcp/status:${e.message}`); }
      connected = false;
    }
  }, 15000);

  if (opts.connectOnly) {
    await sleep(5000);
    clearInterval(watch);
    const st = await fetch(`${server.origin}/api/mcp/status`).then((r) => r.json());
    log(`状态:${JSON.stringify(st)}`);
    log(st.editorConnected && !stats.pageErrors ? '✓ 环境正常(--connect-only,没发对话)' : '✖ 环境不正常');
    return st.editorConnected && !stats.pageErrors ? 0 : 1;
  }

  /* ---- 发对话 ---- */
  const cardsBefore = userCardChanges();
  const convId = `rl-${stamp()}`;
  const attachments = prepareAttachments(convId);
  const body = { provider: 'api', reviewLoop: true, prompt: opts.prompt, attachments, ...(opts.model ? { model: opts.model } : {}) };
  log(`发 /api/ai/chat(provider: api,reviewLoop: true${attachments.length ? `,附件 ${attachments.length} 个` : ''}),超时 ${opts.timeoutMin} 分钟`);

  chat = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; log(`✖ 超过 ${opts.timeoutMin} 分钟,中止`); chat.abort(); }, opts.timeoutMin * 60000);
  const run = { done: null, errors: [], tools: new Map(), toolErrors: 0, verdicts: [], reply: '' };
  const heartbeat = setInterval(() => {
    const calls = [...run.tools.values()].reduce((a, b) => a + b, 0);
    log(`… 进行中:工具调用 ${calls} 次,编辑器${connected ? '连着' : '断开'}${server.restarts() ? `,dev server 重启 ${server.restarts()} 次` : ''}`);
  }, 60000);

  try {
    const res = await fetch(`${server.origin}/api/ai/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: chat.signal,
    });
    if (!res.ok) throw new Error(`/api/ai/chat ${res.status}:${await res.text()}`);
    for await (const ev of sse(res)) {
      record(ev);
      switch (ev.type) {
        case 'run': log(`runId ${ev.runId}`); break;
        case 'session': log(`sessionId ${ev.sessionId}`); break;
        case 'diagnostic':
          if (ev.stage === 'configuration') log(`模型 ${ev.data?.vendor} / ${ev.data?.model},effort ${ev.data?.effort}`);
          break;
        case 'status':
          if (/^judger:/.test(ev.text)) run.verdicts.push(ev.text.split('\n')[0]);
          log(indent(ev.text));
          break;
        case 'tool_call':
          run.tools.set(ev.name, (run.tools.get(ev.name) || 0) + 1);
          log(`→ ${ev.role ? `${ev.role} ` : ''}${ev.name}`);
          break;
        case 'tool_result':
          if (ev.ok === false) { run.toolErrors++; log(`  ✖ ${ev.name}:${String(ev.summary || '').split('\n')[0].slice(0, 200)}`); }
          break;
        case 'text': run.reply += ev.delta || ''; break;
        case 'error': run.errors.push(ev.message); log(`✖ ${indent(ev.message)}`); break;
        case 'done': run.done = ev; break;
        default: break;
      }
    }
  } catch (e) {
    if (!timedOut) { run.errors.push(e.message); log(`✖ ${e.message}`); }
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    clearInterval(watch);
  }

  /* ---- 汇总 ---- */
  fs.writeFileSync(path.join(work, 'reply.md'), run.reply);
  const cardsAfter = [...userCardChanges()].filter((l) => !cardsBefore.has(l));
  const calls = [...run.tools.entries()].sort((a, b) => b[1] - a[1]);
  const u = run.done?.usage;
  console.log('');
  log('—— 结果 ——');
  log(`用时 ${clock()};${run.done ? `结束(outcome ${run.done.outcome ?? '—'})` : timedOut ? '超时中止' : '没收到 done'}`);
  if (u) log(`token:输入 ${u.input}(其中缓存命中 ${u.cacheRead}),输出 ${u.output}`);
  log(`工具调用 ${calls.reduce((a, [, n]) => a + n, 0)} 次,失败 ${run.toolErrors} 次${calls.length ? `;最多的:${calls.slice(0, 6).map(([k, n]) => `${k}×${n}`).join('、')}` : ''}`);
  if (run.verdicts.length) log(`judger 裁决:${run.verdicts.join(' → ')}`);
  if (run.errors.length) log(`错误 ${run.errors.length} 条,第一条:${run.errors[0].split('\n')[0]}`);
  log(`编辑器断线 ${stats.disconnects} 次,页面重载 ${stats.reloads} 次,页面错误 ${stats.pageErrors} 个,dev server 重启 ${server.restarts()} 次`);
  if (cardsAfter.length) log(`⚠ src/cards/user/ 多了这些改动(没删,自己看要不要留):\n         ${cardsAfter.join('\n         ')}`);
  log(`最终回复 ${path.join(work, 'reply.md')}(${run.reply.length} 字);事件 ${path.join(work, 'events.jsonl')}`);
  const lessons = path.join(path.dirname(ai.configPath), 'review-lessons.json');
  if (fs.existsSync(lessons)) log(`教训 ${lessons}`);
  return run.done && !run.errors.length && !timedOut ? 0 : 1;
}

main()
  .then((code) => { cleanup(); process.exit(code); })
  .catch((e) => { console.error(`✖ ${e.message}`); cleanup(); process.exit(1); });
