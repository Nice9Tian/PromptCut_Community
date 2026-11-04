/**
 * Run the review loop for real over an extended period: spin up a dev server locally, open the
 * editor page headlessly and keep it connected, send a chat with the review loop enabled via direct
 * API, stream progress output, and wrap up upon completion.
 *
 *   node scripts/review-loop-run.mjs --prompt "<message>" [--attach <file>]... [--open <.proc>]
 *
 * **A full run takes about 20-35 minutes and roughly 6 million input tokens. Confirm with the user
 * before a real run.**
 * If you only want to verify the environment can be set up, use `--connect-only`,
 * which costs no tokens.
 *
 * | Parameter | Description |
 * |---|---|
 * | `--prompt <text>` / `--prompt-file <file>` | This user message, choose one (not needed with `--connect-only`) |
 * | `--attach <file>` | Repeatable. Copied into `<work>/pc-work/<session-id>/`, sent as attachment, in-site URL `/@pcwork/<session-id>/<filename>` |
 * | `--open <.proc>` | Editor opens this project first via `?open=` (server copies a replica to drafts directory, leaving original file untouched) |
 * | `--model <name>` | One of `api.model` (`|`-separated) in ai.json, defaults to first |
 * | `--work <dir>` | Defaults to `%TEMP%\promptcut-review\run-<time>` |
 * | `--port N` | Specify editor port, N, N+1, N+2 must all be free; randomly chosen by default |
 * | `--timeout-min N` | Abort this pass if it exceeds N minutes, defaults to 60 |
 * | `--ai-config <ai.json>` | Directly use this AI config (`keys/` under same directory), without copying user's |
 * | `--connect-only` | Only start service, connect editor, print status, without sending chat |
 *
 * Isolation:
 *
 * - Export, data, drafts, chats, and attachments directories are all directed under `<work>`
 *   (`PROMPTCUT_EXPORT_DIR`, `_DATA_DIR`, `_PROJECTS_DIR`, `_CHATS_DIR`, `_WORK_DIR`).
 * - AI config: copy the user's `ai.json`, `keys/`, and `review-lessons.json` to `<work>/ai/`,
 *   and point `PROMPTCUT_AI_CONFIG` there. The review loop writes lessons into `review-lessons.json`
 *   in the same directory as ai.json, so writes go to the replica without touching the user's
 *   `%LOCALAPPDATA%\promptcut`. The copied `keys/` is deleted upon completion.
 * - Chat history lands in `%TEMP%\promptcut\harness-sessions\` as usual (that is a temporary
 *   directory, not user data).
 *
 * Artifacts:
 *
 *   <work>/events.jsonl      All SSE events, one per line
 *   <work>/reply.md          Full text of final reply
 *   <work>/vite.log          dev server output
 *   <work>/ai/review-lessons.json   Lessons after this pass (if any)
 *
 * Caveats:
 *
 * - The editor page executes tools and must stay connected to `/api/mcp/events` throughout the
 *   run. The script checks `/api/mcp/status` every 15 seconds, printing ⚠ and timestamps on
 *   disconnections or page reloads. Do not host the editor in Claude desktop app's built-in
 *   browser panel: the page gets reloaded when the panel is hidden.
 * - Do not edit `server/*.ts` or `vite.config.ts` while running (edits from other sessions count
 *   too): the dev server will fully restart, severing in-flight chats. File watching cannot be
 *   disabled: custom card hot-reload depends on it. The script prints ⚠ when detecting a restart.
 * - Custom cards newly written by workers land in `src/cards/user/` in the repository (not in
 *   gitignore). Listed upon completion, not deleted automatically.
 * - Transcription requires Python (`desktop/src-tauri/runtime/python`, not tracked in repo),
 *   `out/pylibs`, and `out/models`. None exist in worktrees: transcription fails immediately
 *   without Python, and if Python is present but missing libraries and models, it installs them
 *   on the fly (several GB). To use the copy in the main checkout, set `PROMPTCUT_PYTHON`,
 *   `PROMPTCUT_PYLIBS`, and `PROMPTCUT_MODELS` first. The script warns at startup.
 * - Opens its own editor page here without borrowing other instances.
 */
import './lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
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
      if (i + 1 >= argv.length) throw new Error(`${a} must be followed by a value`);
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
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!o.connectOnly && !o.prompt?.trim()) throw new Error('Provide --prompt or --prompt-file (use --connect-only just to test the environment)');
  if (!(o.timeoutMin > 0)) throw new Error('--timeout-min must be a positive number');
  if (o.port !== undefined && !(Number.isInteger(o.port) && o.port > 0 && o.port < 65534)) throw new Error('--port must be a port number');
  for (const f of [...o.attach, ...(o.open ? [o.open] : []), ...(o.aiConfig ? [o.aiConfig] : [])]) {
    if (!fs.existsSync(f)) throw new Error(`File does not exist: ${f}`);
  }
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`${e.message}\nSee the header of scripts/review-loop-run.mjs for usage`);
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

/* ---------------- Teardown ---------------- */

let server = null;
let browser = null;
let chat = null;         // AbortController: disconnecting SSE causes the server to abort this pass
let copiedKeys = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { chat?.abort(); } catch {}
  if (browser) killTree(browser.process()?.pid);
  if (server) { server.stop(); log('dev server stopped'); }
  if (copiedKeys) {
    fs.rmSync(copiedKeys, { recursive: true, force: true });
    log('Deleted the copied keys/');
  }
}

process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { log(`Received ${sig}, aborting this run and wrapping up`); cleanup(); process.exit(130); });
}
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });

/* ---------------- Setup ---------------- */

/** Replica of user AI config. Returns { configPath, keysDir, apiReady } */
function prepareAiConfig() {
  if (opts.aiConfig) return { configPath: opts.aiConfig, keysDir: path.join(path.dirname(opts.aiConfig), 'keys'), copied: false };
  const src = process.env.PROMPTCUT_AI_CONFIG || path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut', 'ai.json');
  if (!fs.existsSync(src)) throw new Error(`AI config ${src} not found, point to one with --ai-config`);
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

/** Check whether direct API is configured before sending request, to avoid waiting until service starts to find out */
function apiProblem({ configPath, keysDir }) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const source = cfg?.api?.source;
    if (!source) return 'api.source in ai.json is empty, direct API will not read the key file';
    if (!fs.existsSync(path.join(keysDir, `${source}.key`))) return `No keys/${source}.key`;
    return null;
  } catch (e) {
    return `Cannot read ai.json: ${e.message}`;
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

/** Copy attachments into chat working directory, landing in the same place as "+" uploads in the UI */
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

/** Changes under src/cards/user/ (custom cards written by workers land here) */
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

/* ---------------- Main workflow ---------------- */

async function main() {
  fs.mkdirSync(work, { recursive: true });
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  log(`Working directory ${work}`);

  const ai = prepareAiConfig();
  log(`AI config ${ai.configPath}${ai.copied ? ' (copy of the user\'s config)' : ''}`);
  const problem = apiProblem(ai);
  if (problem) log(`⚠ Direct API is not configured correctly: ${problem}. Sending this run will fail immediately`);
  // Python lookup order for transcription matches findPython in server/vite-plugin-stt.ts
  const python = [process.env.PROMPTCUT_PYTHON, path.join(REPO, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'),
    path.join(REPO, 'python', '.venv', 'Scripts', 'python.exe')].find((p) => p && fs.existsSync(p));
  const missing = ['pylibs', 'models'].filter((d) => !process.env[`PROMPTCUT_${d.toUpperCase()}`] && !fs.existsSync(path.join(REPO, 'out', d)));
  if (!python) log('⚠ Python for transcription not found: transcribing in chat fails immediately (/api/stt/status returns 503). To use the one from the main checkout, set PROMPTCUT_PYTHON, PROMPTCUT_PYLIBS, PROMPTCUT_MODELS');
  else if (missing.length) log(`⚠ This working copy has no out/${missing.join(', out/')}: transcribing in a chat will install it on the fly (several GB). To reuse the one from the main checkout, set PROMPTCUT_PYLIBS / PROMPTCUT_MODELS`);

  const env = { ...dirs, PROMPTCUT_AI_CONFIG: ai.configPath };
  server = await startDevServer({ env, logFile: path.join(work, 'vite.log'), port: opts.port, log });
  log(`dev server ready ${server.origin} (stage ${server.stagePorts.join(' / ')})`);

  /* ---- Editor page ---- */
  const stats = { pageErrors: 0, consoleErrors: 0, reloads: 0, disconnects: 0 };
  // Synchronous append: Ctrl+C, timeout, and process.exit will not lose the last few entries
  const events = fs.openSync(path.join(work, 'events.jsonl'), 'a');
  const record = (ev) => fs.writeSync(events, JSON.stringify({ at: Date.now() - t0, ...ev }) + '\n');

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: [
      '--hide-scrollbars',
      '--no-first-run',
      '--disable-gpu',
      // Software WebGL: ensures 3D cards are not empty canvases in headless mode
      '--enable-unsafe-swiftshader',
      // The pass takes half an hour; the page must not be treated as background and throttled
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 960 });
  page.on('pageerror', (e) => { stats.pageErrors++; record({ type: 'page_error', message: e.message }); log(`⚠ Page error: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') { stats.consoleErrors++; record({ type: 'page_console_error', text: m.text() }); } });
  page.on('response', (r) => { if (r.status() >= 400) record({ type: 'page_http_error', status: r.status(), method: r.request().method(), url: r.url() }); });
  let loaded = false;
  page.on('framenavigated', (f) => {
    if (f !== page.mainFrame()) return;
    if (loaded) { stats.reloads++; record({ type: 'page_reload', url: f.url() }); log(`⚠ Editor page reloaded (time ${stats.reloads})`); }
    loaded = true;
  });

  const editorUrl = `${server.origin}/?editor&nosetup=1${opts.open ? `&open=${encodeURIComponent(opts.open)}` : ''}`;
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitHttp(`${server.origin}/api/mcp/status`, (d) => d?.editorConnected === true, 90000, 'Waiting for the editor to connect to the MCP bridge');
  log(`Editor connected to the MCP bridge (${editorUrl})`);

  /* ---- Check every 15s whether editor is still connected ---- */
  let connected = true;
  const watch = setInterval(async () => {
    try {
      const st = await fetch(`${server.origin}/api/mcp/status`).then((r) => r.json());
      if (connected && !st.editorConnected) { stats.disconnects++; record({ type: 'editor_disconnected' }); log('⚠ Editor disconnected'); }
      if (!connected && st.editorConnected) { record({ type: 'editor_reconnected' }); log('Editor reconnected'); }
      connected = !!st.editorConnected;
    } catch (e) {
      if (connected) { stats.disconnects++; log(`⚠ Cannot reach /api/mcp/status: ${e.message}`); }
      connected = false;
    }
  }, 15000);

  if (opts.connectOnly) {
    await sleep(5000);
    clearInterval(watch);
    const st = await fetch(`${server.origin}/api/mcp/status`).then((r) => r.json());
    log(`Status: ${JSON.stringify(st)}`);
    log(st.editorConnected && !stats.pageErrors ? '✓ Environment OK (--connect-only, no chat sent)' : '✖ Environment not OK');
    return st.editorConnected && !stats.pageErrors ? 0 : 1;
  }

  /* ---- Send chat ---- */
  const cardsBefore = userCardChanges();
  const convId = `rl-${stamp()}`;
  const attachments = prepareAttachments(convId);
  const body = { provider: 'api', reviewLoop: true, prompt: opts.prompt, attachments, ...(opts.model ? { model: opts.model } : {}) };
  log(`Sending /api/ai/chat (provider: api, reviewLoop: true${attachments.length ? `, ${attachments.length} attachments` : ''}), timeout ${opts.timeoutMin} minutes`);

  chat = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; log(`✖ Exceeded ${opts.timeoutMin} minutes, aborting`); chat.abort(); }, opts.timeoutMin * 60000);
  const run = { done: null, errors: [], tools: new Map(), toolErrors: 0, verdicts: [], reply: '' };
  const heartbeat = setInterval(() => {
    const calls = [...run.tools.values()].reduce((a, b) => a + b, 0);
    log(`… In progress: ${calls} tool calls, editor ${connected ? 'connected' : 'disconnected'}${server.restarts() ? `, dev server restarted ${server.restarts()} times` : ''}`);
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
          if (ev.stage === 'configuration') log(`Model ${ev.data?.vendor} / ${ev.data?.model}, effort ${ev.data?.effort}`);
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

  /* ---- Summary ---- */
  fs.writeFileSync(path.join(work, 'reply.md'), run.reply);
  const cardsAfter = [...userCardChanges()].filter((l) => !cardsBefore.has(l));
  const calls = [...run.tools.entries()].sort((a, b) => b[1] - a[1]);
  const u = run.done?.usage;
  console.log('');
  log('-- Result --');
  log(`Elapsed ${clock()}; ${run.done ? `finished (outcome ${run.done.outcome ?? '—'})` : timedOut ? 'aborted on timeout' : 'no done received'}`);
  if (u) log(`token: input ${u.input} (cache hits ${u.cacheRead}), output ${u.output}`);
  log(`${calls.reduce((a, [, n]) => a + n, 0)} tool calls, ${run.toolErrors} failed${calls.length ? `; most frequent: ${calls.slice(0, 6).map(([k, n]) => `${k}×${n}`).join(', ')}` : ''}`);
  if (run.verdicts.length) log(`judger verdict: ${run.verdicts.join(' → ')}`);
  if (run.errors.length) log(`${run.errors.length} errors, first: ${run.errors[0].split('\n')[0]}`);
  log(`Editor disconnected ${stats.disconnects} times, page reloaded ${stats.reloads} times, ${stats.pageErrors} page errors, dev server restarted ${server.restarts()} times`);
  if (cardsAfter.length) log(`⚠ src/cards/user/ has these extra changes (not deleted, decide yourself whether to keep them):\n         ${cardsAfter.join('\n         ')}`);
  log(`Final reply ${path.join(work, 'reply.md')} (${run.reply.length} chars); events ${path.join(work, 'events.jsonl')}`);
  const lessons = path.join(path.dirname(ai.configPath), 'review-lessons.json');
  if (fs.existsSync(lessons)) log(`Lessons ${lessons}`);
  return run.done && !run.errors.length && !timedOut ? 0 : 1;
}

main()
  .then((code) => { cleanup(); process.exit(code); })
  .catch((e) => { console.error(`✖ ${e.message}`); cleanup(); process.exit(1); });
