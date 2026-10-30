/**
 * 云端 Agent 的镜头识别(`detect_shots`、`list_shots`;拆包表 `docs/plan/cloud-agent-tools-implementation.md` 的 P1 里不含素材拼图的那一半)。
 *
 * 桌面版里这两个工具打编辑器进程的 `/api/shots/*`(`server/vite-plugin-shots.ts`),作业放在 RAM 里,结果由页面写回项目。
 * 云节点上没有编辑器进程,这里照同一份做法起 ffmpeg 与(有依赖和权重时)同一个 Python 包(`promptcut_shots`,隔离模式起),规矩是:
 *
 *   - **两档,如实标**:有依赖和权重(`onnxruntime` + `transnetv2.onnx`)才用 TransNetV2(硬切和溶解都认,溶解还给跨度);
 *     没配 Python、依赖或权重不全、素材太长,就用 ffmpeg 的 `scdet` 滤镜(只认硬切、认不出溶解)。用的是哪一档记在 `engine` 里,
 *     `scdet` 档还带一句说明为什么没用模型。模型档中途失败(Python 崩了、返回的结果格式不对)时,退到 `scdet` 再跑一遍,
 *     并在作业索引里记 `fellBackFrom: 'transnetv2'` 与原因,`list_shots` 会说出来,不假称是模型识别的。
 *     连 ffmpeg 都没有就如实回「用不了」,不起一个注定失败的作业;镜头识别彻底失败时,错误里指向 see_frames 看真实画面自己定切点;
 *   - **上下文只来自 F0**:每个调用带的 `context` 是 `tool-context.mjs` 发的可信八字段;每次读素材、起进程、写项目之前,
 *     都用 `run-resources.mjs` 的 `authorize` 重验 doc 的当前 grant / fence(`detect_shots` 要 write,`list_shots` 要 read),
 *     不信工具参数里的任何项目或路径;
 *   - **素材只经 `project-assets.mjs` 的 `openRead`**(带哈希核对)取到这个对话的工作目录(`shots/<作业号>/`),跑完删;
 *     ffprobe / ffmpeg / Python 只读这份本地文件,输入前都带 `-protocol_whitelist file`(伪装成媒体的播放列表连不了网络);
 *   - **子进程只经工作区的受限子进程起**(`workspace.mjs` 的 `spawn`:环境变量白名单、不弹窗口、起成一棵杀得掉的进程树),
 *     并登记到 `run-resources.mjs`(kind `child`):这一轮被停、转私有、Agent 关闭、服务关闭时,进程树真被杀掉、`exit` 与 `close`
 *     都到了才算关(杀树、等收尾、登记用公共实现 `runner.mjs`)。Python 抽帧再起的 ffmpeg 是孙进程,一起被杀;
 *   - **Python 用隔离模式起**(`-I`,`runner.mjs` 的 `isolatedPythonArgs`):对话工作区里是成员和模型弄进来的文件,不让它排进模块搜索路径;
 *   - **作业记在 `tool-jobs.mjs` 的持久账本里**(`shots.detect`):服务重启后 `running` 变 `interrupted`,不是「找不到」;
 *     账本只存状态与进度,中文的失败原因、用的哪一档等放在对话工作区的 `shots/jobs.json`;
 *   - **结果写项目素材的当前版本**:`project.setMediaShots` 带上取字节时的 `mediaRev` 做版本预期,素材中途被换掉就丢弃这次结果,
 *     不写;写之前再验一次 write 权限(只读成员在起作业之前就被拒);
 *   - **`list_shots` 自己答**(不再借桌面版 handler):作业在跑 / 被中断 / 失败 / 被取消都说清;每个镜头带的主体情况照桌面版折叠,
 *     主体检测那一边的「在跑 / 失败」读 `perception/subject.mjs` 写在同一个对话工作区里的 `subject/jobs.json` 与账本。
 *
 * 缩略图(桌面版抓给时间轴画标记用的小图)云端不做:它是编辑界面的东西,云端项目没有对应的存放处;转场里不带 `thumbs`。
 *
 * 工具总表(`cloud-tools.mjs`)的接线归 G 包,本文件不碰它。纯 Node,不引用浏览器;
 * 只在折叠主体情况时懒加载 `src/kernel/project.ts` 与 `src/kernel/layout.ts`(`kernel` 可注入)。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedPythonArgs, splitRoots, superviseChild } from './runner.mjs';

export const SHOTS_TOOL_NAMES = Object.freeze(['detect_shots', 'list_shots']);

export const SHOTS_DEFAULTS = Object.freeze({
  /** `ffmpeg -version` / Python `status` 的时限(Python 要 import onnxruntime) */
  versionMs: 20_000,
  statusMs: 45_000,
  /** 状态结果缓存多久 */
  statusCacheMs: 15_000,
  /** ffprobe 的时限 */
  probeMs: 60_000,
  /** 一个检测作业的时限:每秒素材 perSecondMs、下限 minDetectMs、上限 maxDetectMs。桌面版实测 5 分钟素材 TransNetV2 约 36 秒 */
  perSecondMs: 2_000,
  minDetectMs: 120_000,
  maxDetectMs: 60 * 60_000,
  /** 把素材取到工作目录:大小与时限 */
  maxFetchBytes: 1024 * 1024 * 1024,
  fetchMs: 5 * 60_000,
  /** 模型档把整段视频解成 48x27 的小帧放在内存里(每帧约 4 KB,复制两份):超过这么多帧就改用 scdet */
  maxModelFrames: 120_000,
  /** 整个进程同时在跑的检测作业 */
  maxRunning: 2,
  /** 进度写账本的最小间隔 */
  progressMinMs: 400,
  /** 工作区索引里留多少条作业 */
  historyJobs: 20,
  /** scdet 的阈值(与桌面版同一个数:压低了会在单镜头内高速运动时虚报) */
  scdetThreshold: 10,
});

export class ShotsToolError extends Error {
  constructor(message, code = 'shots-error') {
    super(message);
    this.name = 'ShotsToolError';
    this.code = code;
  }
}

const FALLBACK_HINT = '退路:用 see_frames 看真实画面,自己判断切点,不要凭空编镜头;或请用户在电脑上的 PromptCut 里检测。';
const NOT_CONFIGURED = `这台云节点没有配置镜头识别(ffmpeg 与可选的 TransNetV2 由部署者提供,云端 Agent 不能往节点上装)。${FALLBACK_HINT}`;
const NO_FFMPEG = `这台云节点上 ffmpeg 起不来,镜头识别两档都用不了(硬切检测靠 ffmpeg,模型档也要它解码)。${FALLBACK_HINT}`;

const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{8,128}$/;
const OUTPUT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const INDEX_FILE = 'shots/jobs.json';
const SUBJECT_INDEX_FILE = 'subject/jobs.json';
const RESERVED = Symbol('reserved');
const NEVER_ABORTED = Object.freeze({ aborted: false });
const KINDS = new Set(['cut', 'dissolve']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * 节点上的镜头识别配置(部署决定)。
 *
 *   PROMPTCUT_FFMPEG                    ffmpeg 的绝对路径。配了镜头识别才可用(`scdet` 档只要它)
 *   PROMPTCUT_FFPROBE                   可选:ffprobe 的绝对路径;缺省取 ffmpeg 同目录下的 ffprobe
 *   PROMPTCUT_AGENT_SHOTS_PYTHON        可选:装了 onnxruntime 的 Python 解释器(绝对路径)。配了才有 TransNetV2 档
 *   PROMPTCUT_AGENT_SHOTS_MODELS        配了 Python 就要:权重目录(绝对路径;里面是 transnetv2.onnx)
 *   PROMPTCUT_AGENT_SHOTS_PYLIBS        可选:onnxruntime 等装在这个目录(同时进 Python 的模块搜索路径)
 */
export function readShotsConfig(env, { root }) {
  const ffmpeg = env.PROMPTCUT_FFMPEG;
  if (typeof ffmpeg !== 'string' || !ffmpeg) return null;
  if (!path.isAbsolute(ffmpeg) || !fs.existsSync(ffmpeg)) return { error: 'PROMPTCUT_FFMPEG 要是存在的 ffmpeg 的绝对路径' };
  const ffmpegDir = path.dirname(ffmpeg);
  const ext = path.extname(ffmpeg);
  let ffprobe = env.PROMPTCUT_FFPROBE;
  if (typeof ffprobe === 'string' && ffprobe) {
    if (!path.isAbsolute(ffprobe) || !fs.existsSync(ffprobe)) return { error: 'PROMPTCUT_FFPROBE 要是存在的 ffprobe 的绝对路径' };
  } else {
    ffprobe = path.join(ffmpegDir, `ffprobe${ext}`);
    if (!fs.existsSync(ffprobe)) return { error: '找不到 ffprobe:放在 ffmpeg 同一个目录,或用 PROMPTCUT_FFPROBE 指定' };
  }
  const base = { ffmpeg, ffprobe, ffmpegDir };
  const python = env.PROMPTCUT_AGENT_SHOTS_PYTHON;
  if (typeof python !== 'string' || !python) return base;
  if (!path.isAbsolute(python) || !fs.existsSync(python)) return { error: 'PROMPTCUT_AGENT_SHOTS_PYTHON 要是存在的解释器的绝对路径' };
  const modelsDir = env.PROMPTCUT_AGENT_SHOTS_MODELS;
  if (typeof modelsDir !== 'string' || !path.isAbsolute(modelsDir) || !fs.existsSync(modelsDir)) {
    return { error: 'PROMPTCUT_AGENT_SHOTS_MODELS 要是存在的权重目录的绝对路径' };
  }
  const pylibs = env.PROMPTCUT_AGENT_SHOTS_PYLIBS;
  if (pylibs && !path.isAbsolute(pylibs)) return { error: 'PROMPTCUT_AGENT_SHOTS_PYLIBS 要是绝对路径' };
  return {
    ...base, python, modelsDir,
    ...(pylibs ? { pylibs } : {}),
    pythonPath: [path.join(root, 'python'), ...(pylibs ? [pylibs] : [])].join(path.delimiter),
  };
}

const jsonLines = (onEvent) => {
  let buf = '';
  const feed = (text) => {
    buf += text;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { const ev = JSON.parse(line); if (ev && typeof ev === 'object') onEvent(ev); } catch { /* 不是 JSON 的行不要 */ }
    }
  };
  feed.flush = () => { if (buf.trim()) feed('\n'); };
  return feed;
};

/** 按行切文本流(ffmpeg 的 stderr / `-progress` 输出),回调拿到完整的一行 */
const textLines = (onLine) => {
  let buf = '';
  const feed = (text) => {
    buf += text;
    const parts = buf.split(/\r?\n|\r/);
    buf = parts.pop() ?? '';
    for (const line of parts) if (line) onLine(line);
  };
  feed.flush = () => { if (buf) { const line = buf; buf = ''; onLine(line); } };
  return feed;
};

/** 框按面积取前几个并取整(与桌面版 `topBoxes` 同一口径) */
function topBoxes(boxes, limit = 4) {
  return [...boxes].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, limit).map((b) => ({
    label: b.label, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), conf: Math.round(b.conf * 100) / 100,
  }));
}

/** 帧率文本 `25/1` / `30000/1001` / `25` -> 数 */
function parseRate(raw) {
  if (typeof raw !== 'string') return 0;
  const [n, d] = raw.split('/').map(Number);
  const v = d === undefined ? n : (d ? n / d : 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * @param {object} d
 * @param {object | null} d.config `readShotsConfig` 的结果;没有就是 null(工具如实回「没配」)
 * @param {object} d.resources `run-resources.mjs` 的 `createRunResources`(register / authorize / verifyFence)
 * @param {object} d.assets `project-assets.mjs` 的 `createProjectAssets`(只用 `openRead`)
 * @param {object} d.jobs `tool-jobs.mjs` 的 `createToolJobs`
 * @param {(context: object) => (object | Promise<object>)} d.workspace 这个对话的工作区(`workspace.mjs` 的 `open()` 的结果)
 * @param {object} d.project 项目一侧的窄接口(G 包接到 doc 的版本预期与操作栅栏):
 *   `getMedia(context, mediaId)` -> 项目当前副本里的素材记录或 null(带 `mediaRev`);
 *   `setMediaShots(context, { mediaId, expectedMediaRev, shots, jobId })` -> `{ projectRev? }`,版本对不上抛带 `code: 'media-changed'` 的错;
 *   `getStage(context)` -> `{ width, height }`(可选;折叠主体情况时给 suggestedRect 用,没有就不给 suggestedRect)
 * @param {object} d.kernel 宿主经 ssr-host 载入缝取来注入:`{ subjectForRange, suggestPosition, rectForSafeSide }`(必需)
 */
export function createShotsTools({
  config = null, resources, assets, jobs, workspace, project,
  kernel = null, limits: limitsIn = {}, now = Date.now, log = () => {},
} = {}) {
  for (const [name, dep, methods] of [['resources', resources, ['register', 'authorize']], ['assets', assets, ['openRead']],
    ['jobs', jobs, ['start', 'update', 'get', 'checkpointRetained']], ['project', project, ['getMedia', 'setMediaShots']]]) {
    if (!dep || methods.some((m) => typeof dep[m] !== 'function')) throw new ShotsToolError(`镜头识别缺少依赖:${name}`, 'shots-unconfigured');
  }
  if (typeof workspace !== 'function') throw new ShotsToolError('镜头识别缺少依赖:workspace', 'shots-unconfigured');
  for (const fn of ['subjectForRange', 'suggestPosition', 'rectForSafeSide']) {
    if (typeof kernel?.[fn] !== 'function') throw new ShotsToolError(`镜头识别没配置全:缺内核函数 ${fn}(宿主要经 ssr-host 载入缝取来注入 kernel)`, 'shots-unconfigured');
  }
  const limits = { ...SHOTS_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };
  /** `config.args` 只给单测与探针(把解释器整个换成替身脚本);正式的一律隔离模式,包目录来自部署配置 */
  const stubArgs = config && Array.isArray(config.args) && config.args.length ? config.args : null;
  const pythonGlobals = config?.python ? ['--models-dir', config.modelsDir, ...(config.pylibs ? ['--pylibs', config.pylibs] : []), '--local-only'] : [];
  const pythonArgv = (subArgs) => (stubArgs
    ? [...stubArgs, ...pythonGlobals, ...subArgs]
    : isolatedPythonArgs('promptcut_shots', { roots: splitRoots(config.pythonPath), args: [...pythonGlobals, ...subArgs] }));
  /** `config.ffmpegArgs` / `config.ffprobeArgs` 同样只给单测与探针(把可执行文件换成替身脚本) */
  const ffmpegArgv = (args) => [...(Array.isArray(config?.ffmpegArgs) ? config.ffmpegArgs : []), ...args];
  const ffprobeArgv = (args) => [...(Array.isArray(config?.ffprobeArgs) ? config.ffprobeArgs : []), ...args];
  const loadKernel = async () => kernel;

  /** 正在跑的作业(本进程):jobId -> 状态。close 要等它们的子进程真关 */
  const live = new Map();
  /** 同一素材同一时刻只一个检测作业:`项目\0素材` -> jobId */
  const byMedia = new Map();
  /** 正在登记账本、还没进 live 的检测作业数(两个并发调用不能同时越过上限检查) */
  let reserving = 0;
  let statusCache = null;
  let ffmpegCache = null;
  let closing = false;
  const settled = new Set();
  /** 本进程起的、还没关的子进程(含 version / status / ffprobe):close 要全部杀掉并等它们真关 */
  const children = new Set();

  const authorize = async (context, action) => {
    if (closing) throw new ShotsToolError('云端 Agent 服务正在关闭,镜头识别不再接新活。', 'shots-closing');
    try { return await resources.authorize(context, action); }
    catch (error) {
      if (error instanceof ShotsToolError) throw error;
      // 文档服务联系不上:fail closed,但说清是「上游不可用」(503),不是「没权限」(403)
      if (['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable'].includes(error?.code)) {
        throw Object.assign(new ShotsToolError('文档服务暂时联系不上,没法确认这一轮的权限,镜头识别没有开始。稍后再试。', 'authority-unavailable'), { status: 503 });
      }
      throw Object.assign(new ShotsToolError(action === 'write' ? '这一轮没有写项目的权限(只读成员、被停止或已转私有),镜头识别没有开始。' : '这一轮没有读项目的权限,镜头识别没有开始。', 'shots-forbidden'), { status: 403 });
    }
  };

  /* ---------------------------------------------------------------- 工作区索引(中文原因、用的哪一档等账本不存的东西) */

  function readIndexFile(ws, file) {
    try {
      if (!ws.exists(file)) return [];
      const rows = JSON.parse(ws.read(file, { maxBytes: 1024 * 1024 }).toString('utf8'));
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    } catch { return []; }
  }
  const readIndex = (ws) => readIndexFile(ws, INDEX_FILE);
  /** 读-改-写在一个同步段里完成,同一进程内不会交错 */
  function mutateIndex(ws, mutate) {
    try {
      const rows = readIndex(ws);
      mutate(rows);
      ws.write(INDEX_FILE, JSON.stringify(rows.slice(-limits.historyJobs)));
    } catch (err) { say('agent.shots.index-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
  }

  /* ---------------------------------------------------------------- 起子进程 */

  /** 路径与盘符不回给模型 */
  const scrub = (text, ws) => {
    let out = String(text ?? '');
    let workDir = null;
    try { workDir = ws?.dir?.() ?? null; } catch { workDir = null; }
    if (workDir) out = out.split(workDir).join('<工作目录>');
    out = out.replace(/(?:<工作目录>[/\x5c])?shots[/\x5c]job_[^/\x5c\s]+[/\x5c]media\.[A-Za-z0-9]+/g, '<素材文件>');
    for (const secret of [config?.modelsDir, config?.python, config?.pylibs, config?.ffmpeg, config?.ffprobe, ...(config?.pythonPath ?? '').split(path.delimiter)].filter(Boolean)) {
      out = out.split(secret).join('<节点目录>');
    }
    return out.replace(/[A-Za-z]:\\[^\s'",)]+/g, '<节点目录>');
  };

  const pathEnv = () => {
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH';
    return config?.ffmpegDir ? { [pathKey]: `${config.ffmpegDir}${path.delimiter}${process.env[pathKey] ?? ''}` } : {};
  };

  /**
   * 起一个子进程(ffmpeg / ffprobe / Python),登记到 run-resources(整棵进程树真关了才算关)。
   * 回 `{ done, kill, signal, closed }`:`done` 解析成 `{ code, timedOut, stderrTail, spawnError }`。
   */
  async function runChild(context, ws, command, args, { timeoutMs, env = {}, onStdout = () => {}, onStderr = () => {} } = {}) {
    const child = ws.spawn(command, args, { env });
    const stderrTail = [];
    let run;
    try {
      run = await superviseChild(child, {
        resources, context, timeoutMs,
        onStdout: (d) => onStdout(d.toString('utf8')),
        onStderr: (d) => {
          const text = d.toString('utf8');
          onStderr(text);
          for (const l of text.split(/\r?\n/)) if (l.trim()) { stderrTail.push(l.trim().slice(0, 300)); if (stderrTail.length > 20) stderrTail.shift(); }
        },
      });
    } catch {
      // 登记被拒:superviseChild 已经杀掉整棵树并等它收干净
      throw new ShotsToolError('这一轮已经没有权限继续(被停止、转私有或 Agent 关闭),镜头识别进程没有启动。', 'shots-forbidden');
    }
    const done = run.done.then((end) => ({
      code: end.spawnError ? -1 : (end.code ?? -1), timedOut: end.timedOut, stderrTail,
      spawnError: end.spawnError ?? null,
    }));
    const entry = { kill: run.kill, closed: done.then(() => undefined) };
    children.add(entry);
    void entry.closed.then(() => children.delete(entry));
    if (closing) entry.kill();
    return { done, kill: entry.kill, signal: run.signal ?? NEVER_ABORTED, closed: entry.closed };
  }

  /** ffmpeg 起得来吗(`-version`)。成功缓存一会儿,失败不缓存太久。回 `{ ok, reason? }` */
  async function ffmpegStatus(context, ws, { fresh = false } = {}) {
    if (!config) return { ok: false, reason: NOT_CONFIGURED };
    if (!fresh && ffmpegCache && now() - ffmpegCache.at < (ffmpegCache.value.ok ? limits.statusCacheMs : 2000)) return ffmpegCache.value;
    let value;
    try {
      let out = '';
      const run = await runChild(context, ws, config.ffmpeg, ffmpegArgv(['-hide_banner', '-nostdin', '-version']), { timeoutMs: limits.versionMs, onStdout: (t) => { if (out.length < 400) out += t; } });
      const end = await run.done;
      await run.closed;
      const version = out.split(/\r?\n/)[0]?.match(/ffmpeg version (\S+)/)?.[1];
      value = end.code === 0 && version ? { ok: true, version } : { ok: false, reason: NO_FFMPEG };
    } catch (error) {
      if (error?.code === 'shots-forbidden') throw error;
      value = { ok: false, reason: NO_FFMPEG };
    }
    ffmpegCache = { at: now(), value };
    return value;
  }


  /** 模型档就绪吗:Python 的 `status`(要 onnxruntime 与权重文件都在)。回 `{ ready, why?, reason?, detail? }`;只有权限被撤才抛 */
  async function modelStatus(context, ws, { fresh = false } = {}) {
    if (!config?.python) {
      return { ready: false, why: 'no-python', reason: '节点没有配置 TransNetV2(没有 Python 解释器与权重)。' };
    }
    if (!fresh && statusCache && now() - statusCache.at < limits.statusCacheMs) return statusCache.value;
    const events = [];
    const feed = jsonLines((ev) => { events.push(ev); });
    let run;
    try { run = await runChild(context, ws, config.python, pythonArgv(['status']), { timeoutMs: limits.statusMs, env: pathEnv(), onStdout: (t) => feed(t) }); }
    catch (error) {
      if (error?.code === 'shots-forbidden') throw error;
      return { ready: false, why: 'not-ready', reason: scrub(error?.message, ws) };
    }
    const end = await run.done;
    await run.closed;
    feed.flush();
    const ev = events.find((e) => e.event === 'status');
    let value;
    if (!ev) {
      const tail = end.stderrTail.slice(-2).join(' ');
      value = { ready: false, why: 'not-ready', reason: end.timedOut ? '查 TransNetV2 状态超时。' : scrub(tail || '解释器没有返回可解析的状态', ws) };
    } else {
      const runtimeOk = ev.runtime?.installed === true;
      const modelOk = ev.model?.exists === true;
      const missing = [
        !runtimeOk && `onnxruntime 没装${ev.runtime?.error ? `(${scrub(ev.runtime.error, ws).slice(0, 120)})` : ''}`,
        !modelOk && '权重文件 transnetv2.onnx 不在节点的权重目录里',
      ].filter(Boolean);
      value = {
        ready: ev.ready === true && runtimeOk && modelOk,
        why: 'not-ready',
        ...(missing.length ? { reason: `TransNetV2 用不了:${missing.join(';')}。` } : null),
        detail: {
          runtime: { installed: runtimeOk, version: ev.runtime?.version ?? null },
          model: { exists: modelOk, ...(Number.isFinite(ev.model?.bytes) ? { bytes: ev.model.bytes } : {}) },
        },
      };
      if (value.ready) delete value.why;
    }
    statusCache = value.ready ? { at: now(), value } : null;
    return value;
  }

  /** 选这次用哪一档。ffmpeg 起不来就两档都没有 */
  async function chooseEngine(context, ws) {
    const ff = await ffmpegStatus(context, ws);
    if (!ff.ok) return { unavailable: true, reason: ff.reason };
    const model = await modelStatus(context, ws);
    if (model.ready) return { engine: 'transnetv2', model };
    return { engine: 'scdet', scdetWhy: model.reason, model };
  }

  /* ---------------------------------------------------------------- 账本更新 */

  /**
   * 一个作业的账本句柄:更新串行(revision 精确),共有已读任务进入 retained 后自动补一次检查点。
   * 作业已经是终态(被栅栏取消)时回 `{ terminal: true }`,调用方据此收手。
   */
  function tracker(context, jobId, startRevision = 0) {
    let revision = startRevision;
    let tail = Promise.resolve();
    let dead = false;
    const apply = async (patch) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await jobs.update(context, jobId, revision, patch); revision += 1; return { ok: true }; }
        catch (error) {
          if (error?.code === 'terminal-job') { dead = true; return { ok: false, terminal: true }; }
          if (error?.code === 'job-scope-mismatch' && attempt === 0) {
            try { const cp = await jobs.checkpointRetained(context, jobId, revision); revision = cp.revision; continue; }
            catch (inner) { return { ok: false, error: inner }; }
          }
          return { ok: false, error };
        }
      }
      return { ok: false };
    };
    return {
      patch(patchValue) {
        const next = tail.then(() => (dead ? { ok: false, terminal: true } : apply(patchValue)));
        tail = next.catch(() => {});
        return next;
      },
      get dead() { return dead; },
    };
  }

  /* ---------------------------------------------------------------- detect_shots */

  const mediaIdOf = (args) => {
    const id = args?.mediaId;
    if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) throw new ShotsToolError('mediaId 必填,是素材的 id(可用 list_media 查看)', 'bad-args');
    return id;
  };
  const notFound = (id) => new ShotsToolError(`找不到素材 ${String(id).slice(0, 80)}(没有这个 id,或它不在当前项目里)`, 'media-not-found');
  const KIND_NAME = { image: '图片', audio: '音频', video: '视频' };

  async function detectShots(context, args, options = {}) {
    await authorize(context, 'write');
    const mediaId = mediaIdOf(args);
    const ws = await workspace(context);
    const media = await project.getMedia(context, mediaId);
    if (!media) throw notFound(mediaId);
    if (media.kind !== 'video') {
      throw new ShotsToolError(`${media.name} 不是视频${KIND_NAME[media.kind] ? `(是${KIND_NAME[media.kind]})` : ''},没有镜头可分`, 'media-kind');
    }
    if (media.pending) throw new ShotsToolError(`${media.name} 还没进素材服务(上传没完成或失败),稍后再试或重新导入`, 'media-pending');
    if (!config) return { ok: false, cloudUnavailable: true, error: NOT_CONFIGURED };

    if (media.shots && args?.force !== true) {
      return {
        reused: true, mediaId, engine: media.shots.engine,
        shots: media.shots.shots.length, transitions: media.shots.transitions.length,
        hint: '这个素材已经检测过了,直接用 list_shots 取结果;要重测传 force:true',
      };
    }
    const choice = await chooseEngine(context, ws);
    if (choice.unavailable) return { ok: false, cloudUnavailable: true, error: choice.reason };
    const engine = choice.engine;

    const mediaKey = `${context.projectId}\0${mediaId}`;
    const digest = sha(JSON.stringify({ v: 1, mediaId }));
    const already = byMedia.get(mediaKey);
    if (already) {
      const liveJob = live.get(already);
      if (liveJob && liveJob.digest === digest && liveJob.conversationId === context.conversationId) {
        return { jobId: already, started: false, alreadyRunning: true, mediaId, engine, hint: '同样的镜头识别已经在跑,用 list_shots 轮询,不要重复启动。' };
      }
      throw new ShotsToolError('这个素材正在做镜头识别,等它跑完(用 list_shots 轮询)再重测。', 'shots-busy');
    }
    if (live.size + reserving >= limits.maxRunning) throw new ShotsToolError('节点上镜头识别正在跑的作业太多了,过一会儿再试。', 'shots-busy');

    const requestId = REQUEST_RE.test(options.requestId ?? '') ? options.requestId : `sh_${randomUUID().replace(/-/g, '')}`;
    // 先占位再 await:同一素材的两个并发调用,第二个看到占位就回 busy
    byMedia.set(mediaKey, RESERVED);
    reserving += 1;
    let started;
    try { started = await jobs.start(context, 'shots.detect', digest, requestId); }
    catch (error) {
      byMedia.delete(mediaKey);
      throw new ShotsToolError(`镜头识别没能登记作业(${error?.code ?? '账本不可用'})`, 'shots-job');
    } finally { reserving -= 1; }
    if (closing) {
      byMedia.delete(mediaKey);
      void tracker(context, started.jobId).patch({ state: 'interrupted', errorCode: 'SERVICE_CLOSING' });
      throw new ShotsToolError('云端 Agent 服务正在关闭,镜头识别不再接新活。', 'shots-closing');
    }
    const seconds = Number(media.duration);
    const etaSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * (engine === 'transnetv2' ? 0.15 : 0.05)) + 5 : undefined;
    const result = {
      jobId: started.jobId, started: true, mediaId, engine,
      ...(engine === 'scdet' ? { engineNote: `ffmpeg scdet 兜底,只认硬切、认不出溶解。${choice.scdetWhy ?? ''}`.trim() } : null),
      ...(etaSeconds ? { etaSeconds } : null),
      hint: '镜头识别已在后台开始,请用 list_shots 轮询该 mediaId;'
        + `${engine === 'transnetv2' ? '实测 5 分钟素材约 36 秒' : 'scdet 比模型档快'},间隔用 wait 工具等,别每秒都问。`
        + '素材很长或模型中途出错时会换成 scdet,最终用的是哪一档以 list_shots 返回的 engine 为准。',
    };
    if (started.state !== 'queued' || live.has(started.jobId)) {
      // 同一 requestId 的重试:作业已经开了,不再开第二个
      if (byMedia.get(mediaKey) === RESERVED) byMedia.delete(mediaKey);
      return { ...result, started: false, alreadyRunning: started.state === 'queued' || started.state === 'running', state: started.state };
    }

    const job = {
      jobId: started.jobId, context, mediaId, mediaKey, digest, engine, scdetWhy: choice.scdetWhy ?? null,
      conversationId: context.conversationId, cancelRequested: null, kill: null, done: null,
    };
    live.set(job.jobId, job);
    byMedia.set(mediaKey, job.jobId);
    mutateIndex(ws, (rows) => {
      rows.push({ jobId: job.jobId, kind: 'detect', mediaId, digest, engine, ...(choice.scdetWhy ? { scdetWhy: choice.scdetWhy } : null), status: 'queued', startedAt: now() });
    });
    job.done = runDetectJob(job, ws).catch((error) => say('agent.shots.worker-crashed', { message: String(error?.message ?? error).slice(0, 160) }))
      .finally(() => { live.delete(job.jobId); if (byMedia.get(mediaKey) === job.jobId) byMedia.delete(mediaKey); settled.delete(job.done); });
    settled.add(job.done);
    return result;
  }

  /** 作业的收尾:账本一笔、工作区索引一笔。账本写不了(权限已撤)也不抛——栅栏取消由宿主的 `cancelForFence` 补 */
  async function finishJob(job, ws, track, { state, errorCode, message, extra = {} }) {
    const patch = { state, ...(errorCode ? { errorCode } : {}), ...(state === 'done' ? { progress: 1 } : {}), ...(extra.outputRefs ? { outputRefs: extra.outputRefs } : {}) };
    const applied = await track.patch(patch);
    mutateIndex(ws, (rows) => {
      const row = rows.find((r) => r.jobId === job.jobId);
      if (row) Object.assign(row, { status: state, finishedAt: now(), ...(errorCode ? { errorCode } : {}), ...(message ? { message } : {}), ...(extra.index ?? {}) });
    });
    return applied;
  }

  /** ffprobe 取帧率和时长。回 `{ ok, fps, duration }` 或 `{ ok:false, message, ... }` */
  async function probeVideo(job, ws, file) {
    const { context } = job;
    let out = '';
    let run;
    try {
      run = await runChild(context, ws, config.ffprobe, ffprobeArgv([
        '-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0',
        '-show_entries', 'stream=r_frame_rate,avg_frame_rate:format=duration', '-of', 'json', ws.resolve(file),
      ]), { timeoutMs: limits.probeMs, onStdout: (t) => { if (out.length < 64 * 1024) out += t; } });
    } catch (error) { return { ok: false, message: scrub(error?.message ?? 'ffprobe 没能启动', ws), forbidden: true }; }
    job.kill = run.kill;
    if (job.cancelRequested || closing) run.kill();
    const end = await run.done;
    await run.closed;
    job.kill = null;
    if (job.cancelRequested || closing || run.signal.aborted) return { ok: false, cancelled: true };
    if (end.timedOut) return { ok: false, message: `读素材信息超时(超过 ${Math.round(limits.probeMs / 1000)} 秒),已强制结束。` };
    if (end.code !== 0) {
      const tail = scrub(end.stderrTail.join(' ').trim(), ws).slice(0, 300);
      return { ok: false, message: `ffprobe 读不出这个文件的视频信息${tail ? `(${tail})` : ''}。文件可能损坏或不是视频。` };
    }
    let info;
    try { info = JSON.parse(out); } catch { return { ok: false, message: 'ffprobe 输出解析失败。' }; }
    const stream = info?.streams?.[0];
    if (!stream) return { ok: false, message: '这个文件里没有视频轨,没有镜头可分。' };
    const fps = parseRate(stream.r_frame_rate) || parseRate(stream.avg_frame_rate);
    if (!fps) return { ok: false, message: '读不出这个视频的帧率。' };
    const duration = Number(info?.format?.duration);
    return { ok: true, fps, duration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
  }

  /** 校验 Python 的 result 事件并折成项目里 `MediaAsset.shots` 的形状;格式不对抛 `bad-result` */
  function shotsFromPython(ev, at) {
    const finite = (v) => typeof v === 'number' && Number.isFinite(v);
    const transitions = Array.isArray(ev.transitions) ? ev.transitions : null;
    const shots = Array.isArray(ev.shots) ? ev.shots : null;
    const okTransition = (t) => t && typeof t === 'object' && KINDS.has(t.kind) && finite(t.start) && finite(t.end) && finite(t.time) && finite(t.confidence) && t.end >= t.start && t.start >= 0;
    const okShot = (s) => s && typeof s === 'object' && finite(s.start) && finite(s.end) && s.end > s.start && s.start >= 0
      && (s.inTransition === null || KINDS.has(s.inTransition)) && (s.outTransition === null || KINDS.has(s.outTransition));
    if (!transitions || !shots || shots.length === 0 || !transitions.every(okTransition) || !shots.every(okShot)) {
      throw new ShotsToolError('镜头识别模型返回的结果格式不对,已丢弃。', 'bad-result');
    }
    return {
      engine: 'transnetv2',
      createdAt: new Date(at).toISOString(),
      transitions: transitions.map((t) => ({ kind: t.kind, start: t.start, end: t.end, time: t.time, confidence: t.confidence })),
      shots: shots.map((s) => ({ start: s.start, end: s.end, inTransition: s.inTransition, outTransition: s.outTransition })),
    };
  }

  /** scdet 的命中点 -> 项目里 `MediaAsset.shots` 的形状(一律硬切:scdet 只给一个时间点,没有跨度;与桌面版同一口径) */
  function shotsFromScdet(hits, duration, at) {
    const times = [...new Set(hits.map((h) => round3(h.t)))].sort((a, b) => a - b);
    const transitions = times.map((t) => {
      const hit = hits.find((h) => round3(h.t) === t);
      // scdet 的分数是 0~100 的画面差异;折成 0~1 当置信度(桌面版一律写 1)
      const confidence = Number.isFinite(hit?.score) ? Math.min(1, Math.round(hit.score * 10) / 1000) : 1;
      return { kind: 'cut', start: t, end: t, time: t, confidence };
    });
    const shots = [];
    let cursor = 0;
    for (const t of times) {
      if (t > cursor) shots.push({ start: cursor, end: t, inTransition: shots.length ? 'cut' : null, outTransition: 'cut' });
      cursor = t;
    }
    if (duration > cursor) shots.push({ start: cursor, end: round3(duration), inTransition: times.length ? 'cut' : null, outTransition: null });
    if (shots.length === 0) throw new ShotsToolError('算不出镜头:素材没有时长信息。', 'bad-result');
    return { engine: 'scdet', createdAt: new Date(at).toISOString(), transitions, shots };
  }

  /** 跑 ffmpeg scdet。回 `{ ok, shots }` 或 `{ ok:false, cancelled | timedOut | message }` */
  async function runScdet(job, ws, file, meta, track, limitMs) {
    const { context } = job;
    const hits = [];
    let lastOut = 0;
    let lastSent = 0;
    let lastPct = -1;
    const errFeed = textLines((line) => {
      const m = line.match(/lavfi\.scd\.score:\s*([0-9.]+),\s*lavfi\.scd\.time:\s*([0-9.]+)/);
      if (m && hits.length < 100_000) hits.push({ score: Number(m[1]), t: Number(m[2]) });
    });
    const outFeed = textLines((line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (!m) return;
      lastOut = Number(m[1]) / 1e6;
      if (!(meta.duration > 0)) return;
      const pct = Math.max(0, Math.min(99, Math.round((lastOut / meta.duration) * 100)));
      const t = now();
      if (pct !== lastPct && t - lastSent >= limits.progressMinMs) {
        lastSent = t; lastPct = pct;
        void track.patch({ progress: Math.max(0.1, Math.min(0.95, 0.1 + 0.85 * (pct / 100))) });
      }
    });
    let run;
    try {
      run = await runChild(context, ws, config.ffmpeg, ffmpegArgv([
        '-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', ws.resolve(file),
        '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `scdet=threshold=${limits.scdetThreshold}`,
        '-f', 'null', '-progress', 'pipe:1', '-nostats', '-',
      ]), { timeoutMs: limitMs, onStdout: (t) => outFeed(t), onStderr: (t) => errFeed(t) });
    } catch (error) { return { ok: false, message: scrub(error?.message ?? 'ffmpeg 没能启动', ws), forbidden: true }; }
    job.kill = run.kill;
    if (job.cancelRequested || closing) run.kill();
    const end = await run.done;
    await run.closed;
    job.kill = null;
    errFeed.flush(); outFeed.flush();
    if (job.cancelRequested || closing || run.signal.aborted) return { ok: false, cancelled: true };
    if (end.timedOut) return { ok: false, timedOut: true };
    if (end.code !== 0) {
      const tail = scrub(end.stderrTail.slice(-3).join(' '), ws).slice(0, 300);
      return { ok: false, message: `ffmpeg 退出码 ${end.code}${tail ? `:${tail}` : ''}` };
    }
    try { return { ok: true, shots: shotsFromScdet(hits, meta.duration > 0 ? meta.duration : lastOut, now()) }; }
    catch (error) { return { ok: false, message: error.message }; }
  }

  /** 跑 TransNetV2(Python)。回 `{ ok, shots }` 或 `{ ok:false, cancelled | timedOut | message }` */
  async function runTransNet(job, ws, file, meta, track, limitMs) {
    const { context } = job;
    let resultEvent = null;
    let errorEvent = null;
    let lastSent = 0;
    let lastPct = -1;
    const feed = jsonLines((ev) => {
      if (ev.event === 'progress' && ev.phase === 'infer' && Number.isFinite(Number(ev.percent))) {
        const pct = Math.max(0, Math.min(99, Math.round(Number(ev.percent))));
        const t = now();
        if (pct !== lastPct && t - lastSent >= limits.progressMinMs) {
          lastSent = t; lastPct = pct;
          void track.patch({ progress: Math.max(0.1, Math.min(0.95, 0.1 + 0.85 * (pct / 100))) });
        }
      } else if (ev.event === 'result') resultEvent = ev;
      else if (ev.event === 'error') errorEvent = ev;
    });
    let run;
    try {
      run = await runChild(context, ws, config.python, pythonArgv(['detect', ws.resolve(file), '--fps', String(meta.fps)]), { timeoutMs: limitMs, env: pathEnv(), onStdout: (t) => feed(t) });
    } catch (error) { return { ok: false, message: scrub(error?.message ?? 'Python 没能启动', ws), forbidden: true }; }
    job.kill = run.kill;
    if (job.cancelRequested || closing) run.kill();
    const end = await run.done;
    await run.closed;
    job.kill = null;
    feed.flush();
    if (job.cancelRequested || closing || run.signal.aborted) return { ok: false, cancelled: true };
    if (end.timedOut) return { ok: false, timedOut: true };
    if (!resultEvent) {
      const message = scrub(errorEvent?.message || end.stderrTail.join('\n').trim() || (end.code === 0 ? '镜头识别模型没有返回结果' : `镜头识别进程异常退出(代码 ${end.code})`), ws).slice(0, 400);
      return { ok: false, message };
    }
    try { return { ok: true, shots: shotsFromPython(resultEvent, now()) }; }
    catch (error) { return { ok: false, message: error.message }; }
  }

  async function runDetectJob(job, ws) {
    const { context, mediaId } = job;
    const track = tracker(context, job.jobId);
    const rel = `shots/${job.jobId}/media`;
    let mediaFile = null;
    const stopped = () => job.cancelRequested || closing;
    const cancelledNote = (suffix = '') => ({
      state: closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SHOTS_CANCELLED',
      message: closing ? `镜头识别被服务关闭中断,没有结果。可以重新调 detect_shots(force:true)。${suffix}` : `镜头识别已被取消。${suffix}`,
    });
    try {
      const first = await track.patch({ state: 'running', stage: 'fetch', progress: 0 });
      if (!first.ok) return;

      // 1) 取素材字节(带哈希核对)到工作目录
      let read;
      try { read = await assets.openRead(context, mediaId); }
      catch (error) {
        const message = error?.status === 404 || error?.message === 'asset-missing' ? '素材的字节在素材服务上找不到(上传没完成或已被清理)。' : `取素材失败(${scrub(error?.code ?? error?.message ?? error).slice(0, 80)})。`;
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'MEDIA_FETCH_FAILED', message });
      }
      const mediaRev = read.mediaRev;
      const ext = typeof read.assetRef?.ext === 'string' && /^[a-z0-9]{1,8}$/.test(read.assetRef.ext) ? read.assetRef.ext : 'bin';
      mediaFile = `${rel}.${ext}`;
      let fetchError = null;
      job.abortFetch = () => read.stream.destroy();
      const writer = ws.writer(mediaFile);
      let fetched = 0;
      const fetchTimer = setTimeout(() => { fetchError = new ShotsToolError('取素材超时', 'fetch-timeout'); read.stream.destroy(); }, limits.fetchMs);
      fetchTimer.unref?.();
      try {
        for await (const piece of read.stream) {
          if (stopped()) throw new ShotsToolError('已取消', 'cancelled');
          fetched += piece.length;
          if (fetched > limits.maxFetchBytes) throw new ShotsToolError('素材太大,云端镜头识别取不下来', 'too-large');
          writer.write(piece);
        }
        if (fetchError) throw fetchError;
        writer.end();
      } catch (error) {
        writer.abort();
        read.stream.destroy();
        await read.closed.catch(() => {});
        if (stopped()) return await finishJob(job, ws, track, cancelledNote());
        const message = error?.code === 'too-large' ? '素材太大,云端镜头识别取不下来。' : error?.code === 'fetch-timeout' ? '取素材超时。' : `取素材失败(${scrub(error?.code ?? error?.message ?? error).slice(0, 80)})。`;
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'MEDIA_FETCH_FAILED', message });
      } finally { clearTimeout(fetchTimer); job.abortFetch = null; }
      await read.closed.catch(() => {});
      if (stopped()) return await finishJob(job, ws, track, cancelledNote());

      // 2) ffprobe:帧率与时长
      await track.patch({ stage: 'probe', progress: 0.05 });
      mutateIndex(ws, (rows) => { const row = rows.find((r) => r.jobId === job.jobId); if (row) row.status = 'running'; });
      const meta = await probeVideo(job, ws, mediaFile);
      if (meta.cancelled || stopped()) return await finishJob(job, ws, track, cancelledNote());
      if (!meta.ok) {
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SHOTS_FAILED', message: `镜头识别没成功:${meta.message}${FALLBACK_HINT}` });
      }

      // 3) 选档并检测。模型档的帧数太多会吃光内存,改用 scdet;模型档中途出错也改用 scdet(并如实记下)
      let engine = job.engine;
      let scdetWhy = job.scdetWhy;
      if (engine === 'transnetv2' && meta.duration * meta.fps > limits.maxModelFrames) {
        engine = 'scdet';
        scdetWhy = `素材太长(约 ${Math.round(meta.duration / 60)} 分钟),模型档要把整段视频解成小帧放进内存,所以改用 ffmpeg 的 scdet 兜底。`;
      }
      const limitMs = Math.min(limits.maxDetectMs, Math.max(limits.minDetectMs, (meta.duration || 0) * limits.perSecondMs));
      await track.patch({ stage: 'detect', progress: 0.1 });
      let fellBackFrom = null;
      let fallbackReason = null;
      let outcome = null;
      if (engine === 'transnetv2') {
        outcome = await runTransNet(job, ws, mediaFile, meta, track, limitMs);
        if (!outcome.ok && !outcome.cancelled && !outcome.timedOut && !outcome.forbidden && !stopped()) {
          fellBackFrom = 'transnetv2';
          fallbackReason = String(outcome.message ?? '原因未知').slice(0, 300);
          engine = 'scdet';
          scdetWhy = `本来要跑 TransNetV2,中途出错退回了 scdet:${fallbackReason}`;
          say('agent.shots.model-fell-back', { message: fallbackReason.slice(0, 120) });
          outcome = null;
        }
      }
      if (engine === 'scdet' && !outcome) {
        mutateIndex(ws, (rows) => {
          const row = rows.find((r) => r.jobId === job.jobId);
          if (row) Object.assign(row, { engine: 'scdet', ...(scdetWhy ? { scdetWhy } : null), ...(fellBackFrom ? { fellBackFrom, fallbackReason } : null) });
        });
        outcome = await runScdet(job, ws, mediaFile, meta, track, limitMs);
      }

      if (outcome.cancelled || stopped()) return await finishJob(job, ws, track, cancelledNote());
      if (outcome.timedOut) {
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SHOTS_TIMEOUT', message: `镜头识别超时(超过 ${limitMs < 10_000 ? Number((limitMs / 1000).toFixed(1)) : Math.round(limitMs / 1000)} 秒),已强制结束。素材可能太长。${FALLBACK_HINT}` });
      }
      if (!outcome.ok) {
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SHOTS_FAILED', message: `镜头识别没成功:${outcome.message}。${FALLBACK_HINT}` });
      }
      const shots = outcome.shots;

      // 4) 写项目素材的当前版本(带取字节时的 mediaRev 做版本预期)
      const committing = await track.patch({ stage: 'commit', progress: 0.97 });
      if (!committing.ok) {
        // 账本已被栅栏取消(终态),或权限已撤、账本写不了:都不写项目
        return await finishJob(job, ws, track, { state: 'cancelled', errorCode: 'FENCE_CANCELLED', message: '这一轮已不能写项目(被停止、转私有或权限变了),检测结果没有写入。' });
      }
      try { await authorize(context, 'write'); }
      catch { return await finishJob(job, ws, track, { state: 'cancelled', errorCode: 'FENCE_CANCELLED', message: '这一轮已不能写项目(被停止、转私有或权限变了),检测结果没有写入。' }); }
      if (stopped()) return await finishJob(job, ws, track, cancelledNote('结果没有写入。'));
      try { await project.setMediaShots(context, { mediaId, expectedMediaRev: mediaRev, shots, jobId: job.jobId }); }
      catch (error) {
        const changed = error?.code === 'media-changed';
        return await finishJob(job, ws, track, {
          state: 'error', errorCode: changed ? 'MEDIA_CHANGED' : 'COMMIT_REJECTED',
          message: changed ? '检测期间这个素材被换掉或重新导入了,这次结果对不上新素材,已丢弃。请重新调 detect_shots。' : `检测结果没能写进项目(${scrub(error?.code ?? error?.message ?? '被拒绝', ws).slice(0, 80)})。`,
        });
      }
      const ref = OUTPUT_ID_RE.test(mediaId) ? mediaId : sha(mediaId).slice(0, 32);
      await finishJob(job, ws, track, {
        state: 'done', extra: {
          outputRefs: [{ kind: 'shots', id: ref }],
          index: { engine: shots.engine, shots: shots.shots.length, transitions: shots.transitions.length, ...(fellBackFrom ? { fellBackFrom, fallbackReason } : {}) },
        },
      });
    } finally {
      if (mediaFile) { try { ws.remove(mediaFile); } catch { /* 留给对话删除时清 */ } try { fs.rmSync(path.dirname(ws.resolve(mediaFile)), { recursive: true, force: true }); } catch { /* 同上 */ } }
    }
  }

  /* ---------------------------------------------------------------- list_shots */

  const INTERRUPTED = '上一次镜头识别被服务重启或关闭中断了,没有结果。可以重新调 detect_shots(传 force:true)。';
  const FINISHED = ['done', 'error', 'cancelled', 'interrupted'];

  /** 一条工作区索引里的作业现在是什么状态:账本是主;作业已经收尾而账本没写成(权限已撤)时以索引里的终态为准 */
  async function stateOf(context, row, isLive) {
    let ledger = null;
    try { ledger = await jobs.get(context, row.jobId); } catch { ledger = null; }
    const state = !ledger
      ? (row.status === 'queued' || row.status === 'running' ? 'interrupted' : row.status)
      : (FINISHED.includes(row.status) && !FINISHED.includes(ledger.state) && !isLive ? row.status : ledger.state);
    return { state, ledger };
  }

  /** 主体检测那一边的「在跑 / 失败」(读 `perception/subject.mjs` 写在同一个对话工作区里的索引与账本) */
  async function subjectJobState(context, ws, mediaId) {
    const row = [...readIndexFile(ws, SUBJECT_INDEX_FILE)].reverse().find((r) => r.kind === 'detect' && r.mediaId === mediaId);
    if (!row) return null;
    const { state, ledger } = await stateOf(context, row, false);
    if (state === 'queued' || state === 'running') return { pending: { percent: Math.max(0, Math.min(99, Math.round((ledger?.progress ?? 0) * 100))) } };
    if (state === 'error' || state === 'cancelled' || state === 'interrupted') {
      return { error: row.message || (state === 'interrupted' ? '主体检测被服务重启或关闭中断了,没有结果' : '没有成功') };
    }
    return null;
  }

  /** 与桌面版 `subjectDigest` 同一口径(`stage` 不知道时不给 suggestedRect) */
  function subjectDigest(k, info, stage) {
    if (!info) return null;
    const round2 = (v) => Math.round(v * 100) / 100;
    const sug = k.suggestPosition(info.safeSide, info.occupancy);
    return {
      safeSide: info.safeSide,
      ...sug,
      ...(stage ? { suggestedRect: sug.suggestedPosition == null ? null : k.rectForSafeSide(info.safeSide, stage, 40) } : null),
      occupancy: { left: round2(info.occupancy.left), right: round2(info.occupancy.right), top: round2(info.occupancy.top), bottom: round2(info.occupancy.bottom) },
      sampledAt: info.times,
      boxCount: info.boxes.length,
      boxes: topBoxes(info.boxes),
      ...(info.approximate ? { approximate: true, note: '这段区间里没有采样点,数字来自时间上最近的一次采样,只是近似' } : null),
    };
  }

  async function listShots(context, args) {
    await authorize(context, 'read');
    const mediaId = mediaIdOf(args);
    const media = await project.getMedia(context, mediaId);
    if (!media) throw notFound(mediaId);
    const ws = await workspace(context);
    const row = [...readIndex(ws)].reverse().find((r) => r.kind === 'detect' && r.mediaId === mediaId);
    const older = media.shots ? '(项目里还留着更早成功的一批结果,不是这次的。)' : '';
    if (row) {
      const { state, ledger } = await stateOf(context, row, live.has(row.jobId));
      if (state === 'queued' || state === 'running') {
        const percent = Math.max(0, Math.min(99, Math.round((ledger?.progress ?? 0) * 100)));
        return {
          running: true, percent, engine: row.engine,
          ...(media.shots ? { stale: true, staleNote: '上一批结果还在,但新一次检测正在跑,这里不给镜头;跑完再调一次本工具' } : null),
        };
      }
      if (state === 'error' || state === 'cancelled' || state === 'interrupted') {
        const message = row.message || (state === 'interrupted' ? INTERRUPTED : '上一次镜头识别没有成功。');
        throw new ShotsToolError(`${message}${older}`, `job-${state}`);
      }
    }
    if (!media.shots) return null;

    const k = await loadKernel();
    let stage = null;
    if (typeof project.getStage === 'function') {
      try { const s = await project.getStage(context); if (s && s.width > 0 && s.height > 0) stage = { width: s.width, height: s.height }; } catch { stage = null; }
    }
    const subjectJob = await subjectJobState(context, ws, mediaId);
    // 这一批结果是哪一档、为什么:作业索引里找得到就说原因(找不到,比如是别的对话跑的,只说档位)
    const doneRow = row && row.status === 'done' && row.engine === media.shots.engine ? row : null;
    const engineNote = media.shots.engine === 'scdet'
      ? `当前用的是 ffmpeg scdet 兜底,只认硬切,溶解等渐变转场检测不出来${doneRow?.scdetWhy ? `。${doneRow.scdetWhy}` : ''}`
      : 'TransNetV2,硬切和溶解都认得';
    const result = {
      running: false,
      engine: media.shots.engine,
      engineNote,
      ...(doneRow?.fellBackFrom ? { fellBackFrom: doneRow.fellBackFrom, fallbackNote: `本来要跑 TransNetV2,中途出错退回了 scdet:${doneRow.fallbackReason ?? '原因未知'}。所以这批结果只有硬切。` } : null),
      shots: media.shots.shots.map((s) => ({ ...s, subject: subjectDigest(k, k.subjectForRange(media.subjects, s.start, s.end), stage) })),
      transitions: media.shots.transitions.map(({ thumbs: _thumbs, ...rest }) => rest),
    };
    // 顺序有讲究(与桌面版一致):1. 主体检测上次失败 2. 在跑 3. 没检测过 4. 整批采样全失败 5. 有结果
    if (subjectJob?.error) {
      return {
        ...result,
        subjectHint: `上次主体检测失败:${subjectJob.error}。`
          + (media.subjects ? '下面每个镜头的 subject 来自更早成功的那一批,不是这次的。' : '')
          + '先调 subject_status 看 engine:为 null 说明这台机器上两档都用不了(没有兜底档),'
          + "退回 see_frames({ source: 'timeline', t }) 看真实画面判断人在哪,**不要继续轮询本工具**;"
          + 'engine 不为 null 才值得调 detect_subjects 并传 force:true 重试。',
      };
    }
    if (subjectJob?.pending) {
      return {
        ...result,
        subjectHint: `主体检测正在跑(${subjectJob.pending.percent}%),跑完再调一次本工具就能看到每个镜头的人物位置${media.subjects ? ';下面的 subject 是上一批的结果,新一批跑完会替换' : ''}`,
      };
    }
    if (!media.subjects) {
      return { ...result, subjectHint: '这些镜头还没做主体检测,所以每个 subject 都是 null。要决定卡片放哪边、别遮住人物的脸,先调 detect_subjects 拿人物位置。' };
    }
    if (result.shots.every((s) => s.subject === null)) {
      return {
        ...result,
        subjectEngine: media.subjects.engine,
        subjectFailedCount: media.subjects.failedCount ?? 0,
        subjectHint: `主体检测跑完了,但这一批 ${media.subjects.samples.length} 个采样没有一个可用`
          + '(全部抽帧失败,见 subjectFailedCount),所以每个 subject 都是 null —— 这不是「画面里没有人」。'
          + "换几个时刻用 detect_subjects 传 times 重测,或退回 see_frames({ source: 'timeline', t }) 看图。",
      };
    }
    return {
      ...result,
      subjectEngine: media.subjects.engine,
      ...(media.subjects.failedCount ? { subjectFailedCount: media.subjects.failedCount } : null),
      ...(media.subjects.fellBackFrom
        ? {
          subjectFellBackFrom: media.subjects.fellBackFrom,
          subjectFallbackNote: `本来要跑 full 档,中途退回了 light:${media.subjects.fallbackReason ?? '原因未知'}。所以 prompt 没生效,label 只可能是 person / face。`,
        }
        : null),
      subjectHint: '每个镜头的 subject.suggestedPosition 可以直接填进卡片的 params.position(只会是 left / right / bottom,不会返回 center);boxes 是原始视频像素的人物框。'
        + 'suggestedPosition 为 null 表示四档全被人物占住(看 suggestedOccupancy 和 warning),那个镜头没有不遮人的位置,别硬填。'
        + '能不能填以 list_cards({cardId}) 的 controls 为准,卡片不支持这个值就换一张卡,不要退回默认的居中 —— 居中正是人脸所在。',
    };
  }

  /* ---------------------------------------------------------------- 对外 */

  const handlers = {
    detect_shots: (context, args, options) => detectShots(context, args, options),
    list_shots: (context, args) => listShots(context, args),
  };

  return Object.freeze({
    handles: new Set(SHOTS_TOOL_NAMES),
    /**
     * @param {string} name 工具名
     * @param {object} args 模型给的参数(只收 mediaId / force)
     * @param {object} context F0 发的可信八字段
     * @param {{ requestId?: string }} [options] 宿主给的幂等号(工具调用 id);同一号重试不会开第二个作业
     */
    call(name, args, context, options = {}) {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
      if (!handler) return Promise.reject(new ShotsToolError(`镜头识别不处理 ${String(name).slice(0, 60)}`, 'unknown-tool'));
      return Promise.resolve().then(() => handler(context, args ?? {}, options));
    },
    /** 这台节点上镜头识别能跑到哪一档(宿主与探针用,不是模型能调的工具)。需要 read 权限 */
    async status(context) {
      await authorize(context, 'read');
      const ws = await workspace(context);
      if (!config) return { ready: false, ffmpeg: false, engine: null, reason: NOT_CONFIGURED };
      const ff = await ffmpegStatus(context, ws, { fresh: true });
      if (!ff.ok) return { ready: false, ffmpeg: false, engine: null, reason: ff.reason };
      const model = await modelStatus(context, ws, { fresh: true });
      return {
        ready: true, ffmpeg: true, ffmpegVersion: ff.version, engine: model.ready ? 'transnetv2' : 'scdet',
        model: { ready: model.ready, ...(model.reason ? { reason: model.reason } : null), ...(model.detail ? { detail: model.detail } : null) },
      };
    },
    /** 取消本对话的一个检测作业(宿主的控制路径与单测用;不是模型能调的工具)。回子进程已关的凭据 */
    async cancel(context, jobId) {
      await authorize(context, 'write');
      const job = live.get(jobId);
      if (!job || job.context.projectId !== context.projectId || job.context.conversationId !== context.conversationId) {
        return { cancelled: false, reason: 'not-running' };
      }
      job.cancelRequested = 'cancel';
      job.abortFetch?.();
      job.kill?.();
      await job.done;
      return { cancelled: true };
    },
    async close(reason = 'close') {
      closing = true;
      for (const job of live.values()) { job.cancelRequested = job.cancelRequested ?? 'close'; job.abortFetch?.(); job.kill?.(); }
      for (const child of children) child.kill();
      const outcomes = await Promise.allSettled([...settled, ...[...children].map((c) => c.closed)]);
      return { childrenClosed: outcomes.every((o) => o.status === 'fulfilled') && children.size === 0, streamsClosed: true, workPending: live.size, reason };
    },
  });
}
