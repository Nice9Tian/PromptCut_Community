/**
 * 舞台端口的闸 —— **真的编辑器、真的舞台窗口**里的探针(`server/stage-gate.mjs`:从舞台端口来的请求缺省全拒,只放行白名单)。
 *
 * 〔2026-10-22 主会话改名〕原来叫 `stage-gate-probe.mjs`。0.7.19 的在线浏览器那一块把那个文件名**就地改写**成了
 * 「舞台闸门、崩溃记录、护栏、档位气泡」的探针（名字相近、验的是另一回事），合并后这条**安全**测试就没人跑了。
 * 验收清单改写那一块发现了这个缺口，于是在合并前把本文件另存成这个名字保住。两支探针都要跑：
 * 本文件验舞台端口的放行白名单，`stage-gate-probe.mjs` 验三道闸门里的舞台那一道。
 *
 *   node scripts/probes/stage-port-whitelist-probe.mjs --port 29000 [--out <目录>] [--json <文件>] [--shots <目录>] [--keep]
 *
 * 自己起一台隔离的编辑器(舞台端口是 +1、+2,三个连号都要空着;数据、素材、卡片改动层都指到 `--out` 下),跑完按进程号收掉。
 * 编辑器进程带 `PROMPTCUT_STAGE_PORT_LOG`:舞台端口每来一个请求,代理记一行(方法、地址、放没放行)。
 * `--out` 不要指到仓库的 `out/` 下:那里不在开发服务器的监听范围里,第 5 步改卡不会触发热更新(缺省在系统临时目录)。
 *
 * 流程:
 *   0. 往卡片改动层写一张用户卡(`probe-gate-card`):它在舞台里挂上以后**自己**去调一次 `POST /api/agent/bind`,
 *      并留一个函数,让探针叫它用卡片模块里的 `fetch`、`WebSocket` 逐个去调一批接口。
 *      素材目录里放一段视频(ffmpeg 测试图样)和一段声音(正弦波)。
 *   1. 编辑器 `?editor&nosetup=1&preview=stage`;装进一份项目:这张用户卡、一张带文字的内置卡、一张带内嵌声音的内置卡(`av-pulse`)、
 *      视频、声音,各占一条序列。点几处、播放两秒、暂停、再点。
 *      核:两个舞台窗口都在舞台端口上;可见舞台里用户卡画出来了(标记色块的像素)、视频那一块有画面而且两处时间的画面不同;
 *      播放时播放头在走、舞台里的视频也在走;卡片声音生成成功(`generateCardAudio`)。
 *   2. **到这里为止舞台端口没有一个请求被拒**(代理的流水里没有 `ok: false`)—— 白名单没有挡住舞台正当要用的东西。
 *      流水里出现过的请求按「方法 + 路径前缀」归类,写进结果(白名单就是照它定的)。
 *   3. 用户卡在可见舞台里逐个去调一批接口(Agent 绑定与对话、数据镜像、项目写入、素材写入、帧与导出的写口、MCP、文件系统类、
 *      卡片写入与同步、渲染节点、采集、网页工具、项目根下的文件、`/@fs/` 任意文件、文档服务的 WebSocket):**全部被拒**(403;WebSocket 连不上)。
 *      同一批接口从编辑器端口发(Node 里,不带 Origin):没有一个是 403。
 *   4. 被拒之后预览照常:再点一处、播一秒,用户卡和视频照样画得出来。
 *   5. 改这张用户卡的源码:舞台不重载就换成新的(热更新的 WebSocket、重新取源码都经舞台端口)。
 *
 * 贴轨道流、按住标尺拖这两样的逐帧核对用现成的 `scrub-stream-probe.mjs`(同一道闸下跑,见报告)。
 * 验收:退出码 0,结果里 `fails: []`。等待时限只为防卡死。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
/** `--observe`:只跑到第 2 步(记下舞台端口正当发的请求),不让用户卡去调那一批 */
const OBSERVE = args.includes('--observe');
const JSON_OUT = flagArg('json', null, args);
const SHOTS = flagArg('shots', null, args);
const RUN = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stage-gate-probe-${RUN}`));
if (!PORT) { console.error('要给 --port <自己起一台开发服务器的端口>'); process.exit(2); }

const WORK = path.join(OUT, 'work');
const MEDIA_DIR = path.join(WORK, 'media');
const DATA_DIR = path.join(WORK, 'data');
const OVERRIDES = path.join(WORK, 'card-overrides');
const GATE_LOG = path.join(WORK, 'stage-port.log');
const CARD_ID = 'probe-gate-card';
/** 用户卡画的色块:纯品红,别的东西不会是这个颜色 */
const MARK = [255, 0, 255];
/** 改卡之后的颜色 */
const MARK2 = [16, 32, 48];
const FPS = 30, WIDTH = 1280, HEIGHT = 720, SECONDS = 6;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 1200))); say('FAIL', { label, extra }); } return !!cond; };
async function until(label, fn, timeoutMs, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); say('TIMEOUT', { label }); return null; }
    await sleep(everyMs);
  }
}

/* ------------------------------------------------------------------ 素材与卡 */

async function makeVideo(ffmpeg) {
  const tmp = path.join(WORK, 'gate-video.mp4');
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-crf', '18', '-movflags', '+faststart', tmp], { windowsHide: true });
  const bytes = await fs.readFile(tmp);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.rename(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id: 'm-video', kind: 'video', name: 'gate-video.mp4', url: `/@media/${hash}`, hash, duration: SECONDS, width: WIDTH, height: HEIGHT, fps: FPS, bytes: bytes.length };
}
async function makeAudio() {
  const rate = 48000, n = rate * SECONDS, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 8000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  const bytes = Buffer.concat([head, data]);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(MEDIA_DIR, `${hash}.wav`), bytes);
  return { id: 'm-audio', kind: 'audio', name: 'gate-audio.wav', url: `/@media/${hash}`, hash, duration: SECONDS, bytes: bytes.length };
}

/** 用户卡:画一个品红色块;挂上以后自己调一次 Agent 绑定;留一个函数让探针叫它逐个去调 */
async function writeCard(color = MARK) {
  const dir = path.join(OVERRIDES, 'src', 'cards', 'user');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${CARD_ID}.tsx`), `import type { CardDef, CardProps } from "../../kernel/types";

/** 探针用(stage-gate-probe.mjs 临时写进改动层):一张想从舞台里调编辑器本机接口的用户卡 */
const g = globalThis as any;
async function call(item: any) {
  try {
    const res = await fetch(item.path, { method: item.method, headers: item.type ? { "Content-Type": item.type } : undefined, body: item.body === undefined ? undefined : item.body, cache: "no-store" });
    return { ...item, status: res.status, body: undefined };
  } catch (e: any) { return { ...item, status: 0, error: String(e?.message ?? e), body: undefined }; }
}
function socket(item: any) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: any) => { if (!done) { done = true; resolve({ ...item, ...r }); } };
    try {
      const ws = new WebSocket(location.origin.replace(/^http/, "ws") + item.path, item.protocols);
      ws.onopen = () => { finish({ opened: true }); ws.close(); };
      ws.onerror = () => finish({ opened: false });
      ws.onclose = () => finish({ opened: false });
      setTimeout(() => finish({ opened: false, timeout: true }), 8000);
    } catch (e: any) { finish({ opened: false, error: String(e?.message ?? e) }); }
  });
}
if (typeof window !== "undefined" && !g.__gateProbe) {
  g.__gateProbe = { origin: location.origin, auto: null, run: async (list: any[]) => { const out = []; for (const item of list) out.push(item.ws ? await socket(item) : await call(item)); return out; } };
  void call({ method: "POST", path: "/api/agent/bind", type: "application/json", body: JSON.stringify({ mode: "ticket", projectId: "p", url: "ws://attacker.invalid/" }) }).then((r) => { g.__gateProbe.auto = r; });
}
function C(_: CardProps<{}>) {
  return <div data-gate-mark style={{ position: "absolute", left: 0, top: 0, width: 320, height: 240, background: "rgb(${color.join(',')})" }} />;
}
export const probeGateCard: CardDef<{}> = {
  id: "${CARD_ID}", name: "舞台端口探针", description: "stage-gate-probe", source: "user",
  frameMode: "direct",
  defaults: {},
  controls: [],
  Component: C,
};
`);
}

/**
 * 用户卡去调的那一批。`type` 是 Content-Type;写口都按自家界面的写法带 JSON。
 * 这里只列「万一放行了,后果也只落在这台探针编辑器自己的临时目录里」的接口;会动到这台机器别处的几条
 * (开资源管理器、改用户级 MCP 配置、开网页、下载、起对话、起导出)不在真舞台里试,由单测 `server/test/stage-gate.test.mjs` 核。
 */
const J = 'application/json';
const body = (o) => JSON.stringify(o);
const ATTACKS = [
  // Agent 绑定与对话
  { method: 'POST', path: '/api/agent/bind', type: J, body: body({ mode: 'ticket', projectId: 'p', url: 'ws://attacker.invalid/' }) },
  { method: 'POST', path: '/api/agent/unbind', type: J, body: '{}' },
  { method: 'POST', path: '/api/agent/ticket', type: J, body: body({ reqId: 'x', ticket: 'x' }) },
  { method: 'GET', path: '/api/agent/status' },
  { method: 'GET', path: '/api/agent/inbox' },
  { method: 'GET', path: '/api/ai/config' },
  { method: 'POST', path: '/api/ai/config', type: J, body: body({ api: { baseUrl: 'https://attacker.invalid' } }) },
  { method: 'GET', path: '/api/ai/providers' },
  { method: 'GET', path: '/api/ai/machine-code' },
  { method: 'GET', path: '/api/chats/list' },
  { method: 'POST', path: '/api/chats/save', type: J, body: body({ id: 'x', messages: [] }) },
  { method: 'POST', path: '/api/chats/attach/import', type: J, body: body({ path: 'C:/Windows/win.ini' }) },
  // 数据镜像
  { method: 'GET', path: '/api/data/project' },
  { method: 'PUT', path: '/api/data/project', type: J, body: body({ project: {} }) },
  { method: 'POST', path: '/api/data/diff', type: J, body: '{}' },
  { method: 'POST', path: '/api/data/playhead', type: J, body: body({ t: 0 }) },
  { method: 'PUT', path: '/api/data/costs', type: J, body: body({ records: [] }) },
  { method: 'GET', path: '/api/data/costs' },
  // 项目写入
  { method: 'GET', path: '/api/projects' },
  { method: 'PUT', path: '/api/projects/gate-probe', type: J, body: body({ project: {} }) },
  { method: 'DELETE', path: '/api/projects/gate-probe' },
  { method: 'GET', path: '/api/project-backups' },
  // 素材写入
  { method: 'POST', path: '/api/media/upload/gate-probe.txt', type: 'text/plain', body: 'x' },
  { method: 'POST', path: '/api/media/adopt', type: J, body: body({ path: 'C:/Windows/win.ini' }) },
  { method: 'GET', path: '/api/media/local?path=C%3A%2FWindows%2Fwin.ini' },
  { method: 'POST', path: '/api/media/upload-queue/target', type: J, body: body({ base: 'https://attacker.invalid' }) },
  { method: 'POST', path: '/api/media/prefetch', type: J, body: '{}' },
  // 帧与导出的写口
  { method: 'POST', path: '/api/frames/preload', type: J, body: '{}' },
  { method: 'POST', path: '/api/frames/yield', type: J, body: '{}' },
  { method: 'POST', path: '/api/frames/render-node', type: J, body: '{}' },
  { method: 'POST', path: '/api/export/audio-mix/x', type: 'audio/wav', body: 'x' },
  { method: 'GET', path: '/api/exports' },
  { method: 'POST', path: '/api/storage/clear-cache', type: J, body: '{}' },
  { method: 'GET', path: '/api/storage' },
  { method: 'POST', path: '/api/vision/bake', type: J, body: '{}' },
  { method: 'POST', path: '/api/vision/snapshot', type: J, body: '{}' },
  // MCP 与 Skill
  { method: 'POST', path: '/api/mcp/call', type: J, body: body({ name: 'get_project', args: {} }) },
  { method: 'GET', path: '/api/mcp/status' },
  { method: 'POST', path: '/api/mcp/result', type: J, body: '{}' },
  { method: 'GET', path: '/api/skill-lock' },
  // 卡片写入与同步、渲染节点
  { method: 'POST', path: '/api/cards/create', type: J, body: body({ id: 'gate-evil', source: 'x', existingIds: [] }) },
  { method: 'POST', path: '/api/cards/edit', type: J, body: body({ id: CARD_ID, find: 'a', replace: 'b' }) },
  { method: 'GET', path: `/api/cards/source?id=${CARD_ID}` },
  { method: 'POST', path: '/api/cards/install', type: J, body: '{}' },
  { method: 'POST', path: '/api/cards/sync/bind', type: J, body: body({ mode: 'ticket', projectId: 'p', url: 'ws://attacker.invalid/' }) },
  { method: 'POST', path: '/api/cards/sync/ticket', type: J, body: body({ reqId: 'x', ticket: 'x' }) },
  { method: 'POST', path: '/api/cards/sync/unbind', type: J, body: '{}' },
  { method: 'GET', path: '/api/cards/sync/status' },
  { method: 'POST', path: '/api/render-node/bind', type: J, body: body({ url: 'ws://attacker.invalid/' }) },
  { method: 'POST', path: '/api/render-node/ticket', type: J, body: '{}' },
  // 采集、网页工具、听写、配音、文档服务
  { method: 'GET', path: '/api/collect/cookies' },
  { method: 'GET', path: '/api/stt/status' },
  { method: 'GET', path: '/api/voice/config' },
  { method: 'GET', path: '/api/docservice/device' },
  { method: 'POST', path: '/docservice/shared/create', type: J, body: '{}' },
  // 大小写与重复斜杠的写法
  { method: 'POST', path: '/aPi/agent/bind', type: J, body: '{}' },
  { method: 'POST', path: '/api//agent/bind', type: J, body: '{}' },
  // 文件系统类:项目根下的文件、/@fs/ 任意文件
  { method: 'GET', path: '/package.json' },
  { method: 'GET', path: '/vite.config.ts?raw' },
  { method: 'GET', path: '/scripts/test-suite.mjs?raw' },
  { method: 'GET', path: '/docs/semantics/glossary.md' },
  { method: 'GET', path: '/desktop/src-tauri/tauri.conf.json' },
  { method: 'GET', path: '/.git/config' },
  { method: 'GET', path: '/out/' },
  { method: 'GET', path: `/@fs/${REPO.replace(/\\/g, '/')}/package.json` },
  { method: 'GET', path: '/@fs/C:/Windows/win.ini' },
  // WebSocket:文档服务;不带热更新子协议的升级
  { ws: true, path: '/docservice' },
  { ws: true, path: '/' },
];

/* ------------------------------------------------------------------ 流水 */

const readLog = () => { try { return fsSync.readFileSync(GATE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
/** 一条请求归成「方法 + 路径的形状」:哈希、数字、文件名这些会变的段换成占位 */
function shapeOf(row) {
  const p = row.u.split('?')[0];
  let shape = p;
  if (/^\/@fs\//.test(p)) shape = /\/node_modules\//.test(p) ? '/@fs/…/node_modules/…' : `/@fs/…/${p.split('/').slice(-1)[0]}`;
  else if (/^\/(src|server|node_modules|@id|@vite)\//.test(p)) shape = `/${p.split('/')[1]}/…`;
  else shape = p.replace(/[0-9a-f]{32,}/gi, '<hash>').replace(/\/\d+(?=\/|$)/g, '/<n>');
  return `${row.ws ? 'WS' : row.m} ${shape}`;
}
const shapes = (rows) => { const m = new Map(); for (const r of rows) { const k = shapeOf(r); m.set(k, (m.get(k) ?? 0) + 1); } return Object.fromEntries([...m].sort()); };

/* ------------------------------------------------------------------ 主流程 */

const out = { out: OUT, port: PORT };
let dev = null, browser = null;
const started = Date.now();
try {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (SHOTS) await fs.mkdir(SHOTS, { recursive: true });
  const env = { PROMPTCUT_EXPORT_DIR: WORK, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_CARD_OVERRIDES: OVERRIDES, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_STAGE_PORT_LOG: GATE_LOG,
    PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `gateprobe-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'gate-probe' };
  Object.assign(process.env, env);
  const { findFfmpeg } = await import('../../server/bakery/ffmpeg.mjs');
  await writeCard();
  const media = { video: await makeVideo(await findFfmpeg()), audio: await makeAudio() };
  dev = await startDevServer({ env, port: PORT, logFile: path.join(WORK, 'vite.log'), log: (m) => say('dev', { m }) });
  const origin = dev.origin;
  out.origin = origin; out.stagePorts = dev.stagePorts;
  say('spawn', { pid: dev.pid, port: PORT, stagePorts: dev.stagePorts });

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1200 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  const stagePorts = dev.stagePorts.map(String);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const frontId = () => page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
  const frontFrame = async () => { const id = await frontId(); return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null; };
  check(stageFrames().length === 2, '两个舞台窗口都开在舞台端口上', page.frames().map((f) => f.url().slice(0, 80)));

  /* ---------------------------------------------------------------- 1. 项目 */
  // 整份项目直接装进去(片段的时间、所在的序列都写死;用「加一张卡」那几个动作的话,同一条序列上放不下的会被往后挪)
  const clips = { user: 'clip-user', pill: 'clip-pill', pulse: 'clip-pulse', video: 'clip-video', audio: 'clip-audio' };
  const PROJECT = { id: `stage-gate-${RUN}`, name: '舞台端口探针', width: WIDTH, height: HEIGHT, fps: FPS, duration: SECONDS, themeId: 'dark', filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    media: [media.video, media.audio],
    tracks: [
      { id: 'tr-user', name: 'user', hidden: false, clips: [{ id: clips.user, kind: 'card', cardId: CARD_ID, start: 0, end: SECONDS, params: {} }] },
      { id: 'tr-pill', name: 'pill', hidden: false, clips: [{ id: clips.pill, kind: 'card', cardId: 'punch-pill', start: 0, end: SECONDS, params: { text: '舞台端口探针 Stage Gate 123' } }] },
      { id: 'tr-pulse', name: 'pulse', hidden: false, clips: [{ id: clips.pulse, kind: 'card', cardId: 'av-pulse', embeddedAudio: true, start: 0.5, end: 2.5, params: { color: '#60a5fa', frequency: 880, gain: 0.3, duration: 0.3 } }] },
      { id: 'tr-video', name: 'video', hidden: false, clips: [{ id: clips.video, mediaId: media.video.id, cardId: '', mediaOffset: 0, start: 0, end: SECONDS, params: {}, label: media.video.name }] },
      { id: 'tr-audio', name: 'audio', hidden: false, clips: [{ id: clips.audio, mediaId: media.audio.id, cardId: '', mediaOffset: 0, start: 0, end: SECONDS, params: {}, label: media.audio.name }] },
    ] };
  const loaded = await page.evaluate(async (project) => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.loadProject(project);
    actions.seek(1);
    const p = getState().project;
    return { size: [p.width, p.height], clips: p.tracks.map((t) => t.clips.map((c) => `${c.cardId || c.mediaId}@${c.start}-${c.end}`)) };
  }, PROJECT);
  out.loaded = loaded;
  check(loaded.clips.length === 5 && loaded.clips.every((c) => c.length === 1), '项目里放上了用户卡、文字卡、有声卡、视频、声音(各占一条序列,都从头开始)', loaded);
  out.clips = clips;

  const stageBox = () => page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].filter((el) => /stage=1/.test(el.src) && getComputedStyle(el).opacity !== '0')
      .map((el) => el.getBoundingClientRect()).find((r) => r.width > 100);
    return f ? { x: Math.round(f.left), y: Math.round(f.top), width: Math.round(f.width), height: Math.round(f.height) } : null;
  });
  const shoot = async (name) => {
    const f = await frontFrame();
    await f?.evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r())))).catch(() => {});
    const box = await stageBox();
    if (!box) return null;
    const buf = await page.screenshot({ clip: box });
    if (SHOTS && name) await fs.writeFile(path.join(SHOTS, `${name}.png`), buf);
    return PNG.sync.read(buf);
  };
  /** 截图里:品红标记有多少像素;右下四分之一(视频露出来的地方)的平均色与离散程度 */
  const measure = (png) => {
    if (!png) return null;
    let mark = 0, sum = 0, sq = 0, n = 0; const sig = [];
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4, r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (r > 240 && g < 16 && b > 240) mark++;
      if (x > png.width * 0.55 && y > png.height * 0.6) { const l = (r + g + b) / 3; sum += l; sq += l * l; n++; if ((x + y * 7) % 97 === 0) sig.push(r >> 3, g >> 3, b >> 3); }
    }
    const mean = sum / n;
    return { size: [png.width, png.height], mark, markShare: +(mark / (png.width * png.height)).toFixed(4), videoMean: +mean.toFixed(1), videoStd: +Math.sqrt(Math.max(0, sq / n - mean * mean)).toFixed(1), sig: crypto.createHash('sha1').update(Buffer.from(sig)).digest('hex').slice(0, 12) };
  };
  const stageState = async () => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((ids) => {
      const d = window.__pcStageDiag?.();
      const v = document.querySelector('video');
      return { origin: location.origin, t: d?.t ?? null, role: d?.role ?? null, mark: !!document.querySelector('[data-gate-mark]'), probe: !!globalThis.__gateProbe,
        video: v ? { readyState: v.readyState, currentTime: +v.currentTime.toFixed(3), src: (v.currentSrc || v.src).replace(/[0-9a-f]{40,}/, '<hash>'), w: v.videoWidth } : null,
        user: !!document.querySelector(`[data-pc-clip="${ids.user}"]`), pill: !!document.querySelector(`[data-pc-clip="${ids.pill}"]`), fontsReady: document.fonts.status, fonts: [...document.fonts].filter((x) => x.status === 'loaded').length };
    }, clips).catch((e) => ({ error: String(e).slice(0, 200) }));
  };
  const seek = (t) => page.evaluate(async (t) => (await import('/src/store/project.ts')).actions.seek(t), t);
  const storeT = () => page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);

  // 新卡头一次上舞台要先测一遍成本,测完要等播放头动一下才挂上:每隔几秒在 1 秒附近挪一帧
  let nudge = 0;
  const first = await until('可见舞台里用户卡挂上、视频解出画面', async () => {
    const s = await stageState();
    if (s?.mark && s?.video?.readyState >= 2) return s;
    if (++nudge % 6 === 0) await seek(nudge % 12 === 0 ? 1 : 1 + 1 / FPS);
    return null;
  }, 240000, 500);
  await seek(1);
  await until('舞台里的视频回到 1 秒', async () => { const s = await stageState(); return s?.video && Math.abs(s.video.currentTime - 1) < 0.05 ? s : null; }, 60000);
  out.stageAt1 = first ?? await stageState();
  check(!!first && new URL(first.origin).port !== String(PORT), '可见舞台在舞台端口上,用户卡挂上了,视频解出了画面', out.stageAt1);
  await sleep(800);
  const shot1 = measure(await shoot('1-seek-1s'));
  await seek(3.2);
  await until('舞台里的视频走到 3.2 秒', async () => { const s = await stageState(); return s?.video && Math.abs(s.video.currentTime - 3.2) < 0.1 ? s : null; }, 60000);
  await sleep(800);
  const shot2 = measure(await shoot('2-seek-3s'));
  out.shots = { at1: shot1, at3: shot2 };
  check(shot1 && shot1.mark > 2000 && shot2 && shot2.mark > 2000, '截图里有用户卡的色块(两处时间都有)', out.shots);
  check(shot1 && shot2 && shot1.videoStd > 8 && shot2.videoStd > 8 && shot1.sig !== shot2.sig, '截图里视频那一块有画面,两处时间的画面不同', out.shots);

  // 播放两秒
  await seek(0.5);
  await sleep(500);
  const before = { t: await storeT(), stage: await stageState() };
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.play());
  await sleep(2000);
  const during = { t: await storeT(), stage: await stageState() };
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.pause());
  await sleep(600);
  const after = { t: await storeT(), stage: await stageState() };
  out.play = { before: { t: before.t, video: before.stage?.video?.currentTime }, during: { t: during.t, video: during.stage?.video?.currentTime }, after: { t: after.t, video: after.stage?.video?.currentTime } };
  check(during.t - before.t > 1 && (during.stage?.video?.currentTime ?? 0) - (before.stage?.video?.currentTime ?? 0) > 0.8, '播放:播放头在走,舞台里的视频也在走', out.play);
  check(Math.abs(after.t - (after.stage?.video?.currentTime ?? -9)) < 0.2, '暂停以后舞台里的视频停在播放头上', out.play);
  const shot3 = measure(await shoot('3-after-play'));
  out.shots.afterPlay = shot3;
  check(shot3 && shot3.mark > 2000 && shot3.videoStd > 8, '播放之后截图里用户卡和视频都在', shot3);
  out.fonts = { status: after.stage?.fontsReady, loaded: after.stage?.fonts };

  // 卡片声音(有声卡的 audio() 在编辑器页里求值、入库)
  const audio = await page.evaluate(async (clipId) => {
    const G = await import('/src/editor/io/cardAudioGeneration.ts');
    const S = await import('/src/store/project.ts');
    try {
      const r = await G.generateCardAudio(clipId);
      const m = S.getState().project.media.find((x) => x.id === r.mediaId);
      return { ok: r.ok, hash: m?.hash ?? null, duration: m?.duration ?? null };
    } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  }, clips.pulse);
  out.cardAudio = audio;
  check(audio.ok === true && /^[a-f0-9]{64}$/.test(audio.hash ?? ''), '卡片声音生成成功', audio);
  // 带着声音再播一秒(素材声音、卡片声音都在轨上)
  await seek(0.6);
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.play());
  await sleep(1200);
  const sound = await page.evaluate(async () => {
    const t = (await import('/src/store/project.ts')).getState().t;
    const els = [...document.querySelectorAll('audio, video')].map((el) => ({ tag: el.tagName, paused: el.paused, t: +el.currentTime.toFixed(2), ready: el.readyState }));
    return { t, els };
  });
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.pause());
  out.sound = sound;
  check(sound.t > 1.2, '带着素材声音和卡片声音播放,播放头照走', sound);

  /* ---------------------------------------------------------------- 2. 到这里没有一个请求被拒 */
  await sleep(500);
  const logBefore = readLog();
  const deniedBefore = logBefore.filter((r) => !r.ok);
  // 用户卡挂上时自己发的那一条 Agent 绑定是预期被拒的,不算在「正当请求」里
  const unexpected = deniedBefore.filter((r) => !(r.m === 'POST' && r.u === '/api/agent/bind'));
  out.observed = { total: logBefore.length, shapes: shapes(logBefore.filter((r) => r.ok)), deniedBeforeAttack: shapes(deniedBefore) };
  check(logBefore.length > 50, '舞台端口的流水记下来了', logBefore.length);
  check(unexpected.length === 0, '新建项目、点、播放、卡片声音这一路,舞台端口没有一个正当请求被拒', shapes(unexpected));

  if (OBSERVE) throw new Error('observe');
  /* ---------------------------------------------------------------- 3. 用户卡逐个去调 */
  const front = await frontFrame();
  const auto = await until('用户卡挂上时自己发的那一条有了结果', () => front.evaluate(() => globalThis.__gateProbe?.auto ?? null), 30000);
  out.auto = auto;
  check(auto?.status === 403, '用户卡挂上时自己调 POST /api/agent/bind:403', auto);
  const fromStage = await front.evaluate((list) => globalThis.__gateProbe.run(list), ATTACKS);
  const http = fromStage.filter((r) => !r.ws), sockets = fromStage.filter((r) => r.ws);
  out.attack = { origin: await front.evaluate(() => globalThis.__gateProbe.origin), count: fromStage.length,
    statuses: http.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}),
    notDenied: http.filter((r) => r.status !== 403).map((r) => `${r.method} ${r.path} → ${r.status}`), sockets: sockets.map((r) => `${r.path} opened=${r.opened}`) };
  check(new URL(out.attack.origin).port !== String(PORT), '这一批是从舞台端口那个源发的', out.attack.origin);
  check(out.attack.notDenied.length === 0, `用户卡从舞台里调 ${http.length} 个接口,全部 403`, out.attack.notDenied);
  check(sockets.every((r) => r.opened === false), '用户卡从舞台里连文档服务的 WebSocket、不带热更新子协议的升级:连不上', out.attack.sockets);
  // 同一批从编辑器端口发(Node,不带 Origin):没有一个是 403(各接口自己回什么照旧)
  const fromEditor = [];
  for (const a of ATTACKS.filter((x) => !x.ws)) {
    const status = await fetch(origin + a.path, { method: a.method, headers: a.type ? { 'Content-Type': a.type } : undefined, body: a.body, signal: AbortSignal.timeout(20000) }).then((r) => r.status, (e) => `错误:${e.message}`);
    fromEditor.push({ method: a.method, path: a.path, status });
  }
  out.editorPort = { count: fromEditor.length, statuses: fromEditor.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}), list: fromEditor.map((r) => `${r.method} ${r.path} → ${r.status}`) };
  const editorDenied = fromEditor.filter((r) => r.status === 403 && !/^\/(\.git|@fs\/c:\/windows)/i.test(r.path));
  check(editorDenied.length === 0, '同一批接口从编辑器端口发,没有被这道闸拒(.git 与工作区之外的 /@fs/ 是开发服务器自己的文件系统限制,不算)', editorDenied);
  const logAfter = readLog().slice(logBefore.length);
  out.deniedInAttack = logAfter.filter((r) => !r.ok).length;

  /* ---------------------------------------------------------------- 4. 之后预览照常 */
  await seek(2);
  await until('舞台里的视频走到 2 秒', async () => { const s = await stageState(); return s?.video && Math.abs(s.video.currentTime - 2) < 0.1 ? s : null; }, 60000);
  await sleep(800);
  const shot4 = measure(await shoot('4-after-attack'));
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.play());
  await sleep(1000);
  const t5 = await storeT();
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.pause());
  out.afterAttack = { shot: shot4, t: t5, stage: await stageState() };
  check(shot4 && shot4.mark > 2000 && shot4.videoStd > 8 && t5 > 2.5, '被拒之后预览照常:用户卡、视频都画得出来,能播放', out.afterAttack);

  /* ---------------------------------------------------------------- 5. 改卡:舞台跟着热更新(热更新的 WebSocket 与重新取源码都经舞台端口) */
  for (const f of stageFrames()) await f.evaluate(() => { globalThis.__gateStay = 1; }).catch(() => {});
  await writeCard(MARK2);
  const colorNow = async () => (await frontFrame())?.evaluate(() => { const el = document.querySelector('[data-gate-mark]'); return el ? { color: getComputedStyle(el).backgroundColor, stayed: globalThis.__gateStay === 1 } : null; }).catch(() => null);
  const hot = await until('舞台里的用户卡换成改过的颜色', async () => { const c = await colorNow(); return c?.color === `rgb(${MARK2.join(', ')})` ? c : null; }, 60000);
  await sleep(500);
  const shot5 = await shoot('5-after-card-edit');
  const px = shot5 ? [0, 1, 2].map((k) => shot5.data[(Math.round(shot5.height * 0.15) * shot5.width + Math.round(shot5.width * 0.1)) * 4 + k]) : null;
  out.hotUpdate = { dom: hot ?? await colorNow(), pixel: px };
  check(!!hot && hot.stayed, '改了用户卡的源码,舞台不重载就换成新的(热更新经舞台端口照常)', out.hotUpdate);
  check(px && px.every((v, k) => Math.abs(v - MARK2[k]) <= 6), '截图里那一块是改过之后的颜色', out.hotUpdate);
  const tail = readLog().slice(logBefore.length + logAfter.length).filter((r) => !r.ok);
  check(tail.length === 0, '之后舞台端口没有新的正当请求被拒', shapes(tail));
  out.pageErrors = pageErrors.slice(0, 10);
} catch (e) {
  if (e?.message !== 'observe') fails.push(`异常:${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch {}
  try { dev?.stop(); } catch {}
  out.ms = Date.now() - started;
  out.fails = fails;
  if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2)).catch(() => {});
  if (!KEEP && !fails.length) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(fails.length ? 1 : 0);
}
