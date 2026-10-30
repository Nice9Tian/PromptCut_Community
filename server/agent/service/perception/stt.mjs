/**
 * 云端 Agent 的语音转写工具(`stt_status`、`stt_install`、`transcribe_media`;计划 `docs/plan/cloud-agent-tools-implementation.md` 的 P2 包)。
 *
 * 桌面版里这三个工具由页面执行,背后打编辑器进程的 `/api/stt/*`(`server/vite-plugin-stt.ts`),作业放在编辑器进程的内存里,
 * 转写完成靠页面把结果写回项目。云节点上没有页面也没有编辑器进程,所以在 Agent 服务一侧另做一份:
 *
 *   - **每次调用都带可信的 ToolRunContext**(F0 的 `tool-context.mjs`,由文档服务确认读过消息后的当前运行授权构造),
 *     并先过 `authorize(read|write)`:`stt_status` 只需读,`stt_install`、`transcribe_media` 要写。模型给的参数里没有项目、授权、路径。
 *   - **素材字节只经 ProjectAssets**(F0 的 `project-assets.mjs`):按 mediaId 取到本对话的工作区,边收边核哈希;别的项目的素材取不到。
 *   - **作业记在 ToolJobs 里**(F0 的 `tool-jobs.mjs`,SQLite):同一条消息里同样的请求只开一个作业;重启后跑到一半的标成 interrupted;
 *     撤销/停止时由宿主调 `cancelForFence` 标 cancelled,本模块负责让子进程真的退出。
 *   - **Python 子进程只带固定参数**:隔离模式(`python -I …`,`runner.mjs` 的 `isolatedPythonArgs`)跑 `promptcut_stt <status|install|transcribe> ...`,参数全由本模块拼,
 *     模型只能选引擎(枚举)、模型名(枚举)、语言(语言代码);没有 pip 参数、索引地址、shell。环境变量按白名单重建,工作目录是本对话的工作区。
 *     转写一律带 `--offline`:权重只用部署者预先放好的,不联网下载;ffmpeg 只读本地文件。
 *   - **安装只装锁定依赖**:`stt_install` 用部署者在节点配置里指定的依赖文件(见 `python/requirements-faster-whisper.lock.txt`),
 *     没配就如实回「这台节点不开放安装」。
 *   - **子进程挂到运行资源登记器**(F0 的 `run-resources.mjs`):撤销、停止、Agent 关闭时一并杀掉整棵进程树,并等到真的 exit + close。
 *     起进程、杀树、等收尾、登记用的是公共实现 `runner.mjs`(与主体识别、运动追踪、网页采集同一份)。
 *   - **结果写回项目只经宿主给的 `commitTranscript`**(项目写入的缝,由 G 包接到文档服务的 mutate):本模块在提交前重核写权限与素材版本。
 *
 * 本文件不引用 `src/`。节点上的 Python、引擎、权重、ffmpeg 要部署者提供,没有时如实回应而不是假装能用。
 */
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { childEnv } from '../workspace.mjs';
import { createSlot } from '../hosted-sound.mjs';
import { isolatedPythonArgs, killTree, spawnTree, superviseChild } from './runner.mjs';

export const STT_TOOL_NAMES = Object.freeze(['stt_status', 'stt_install', 'transcribe_media']);
export const STT_ENGINES = Object.freeze(['faster-whisper', 'whisper']);
export const STT_MODELS = Object.freeze(['tiny', 'base', 'small', 'medium', 'large-v3']);

export const STT_DEFAULTS = Object.freeze({
  /** 允许模型选的引擎(部署者可收窄) */
  engines: ['faster-whisper'],
  defaultEngine: 'faster-whisper',
  defaultModel: 'small',
  /** `status` 子命令的时限 */
  statusMs: 20_000,
  /** 一次转写的时限(含抽音轨与解码) */
  transcribeMs: 30 * 60_000,
  /** 一次安装的时限 */
  installMs: 30 * 60_000,
  /** 单个素材取到工作区的上限(再受工作区自己的单文件上限约束) */
  maxMediaBytes: 1024 * 1024 * 1024,
  /** 一份文字稿最多多少段、每段最多多少字,免得一份异常结果撑大项目 */
  maxSegments: 20_000,
  maxSegmentChars: 4_000,
  /** 作业进度写库的最小间隔(每次写库要过几道授权) */
  progressMs: 1_500,
  /** `close()` 等子进程真的退出的时限 */
  closeMs: 10_000,
  device: 'auto',
});

/** 给模型看的错误说明;作业记录里只存码(ToolJobs 的 errorCode),这里是码对应的人话 */
export const STT_ERROR_TEXT = Object.freeze({
  ENGINE_NOT_INSTALLED: '这台云节点上没有安装所选的语音识别引擎。先用 stt_status 看哪些引擎已装;能装的话用 stt_install。',
  MODEL_NOT_INSTALLED: '这台云节点上没有所选模型的权重(云端不联网下载权重,由托管方预先放好)。先用 stt_status 看 availableModels,换一个已有的模型。',
  FFMPEG_MISSING: '这台云节点没有装 ffmpeg,抽不了音轨,转写不了。请告诉用户联系托管方。',
  NO_AUDIO: '这份素材里没有音轨(或是图片),没有可转写的声音。',
  MEDIA_UNAVAILABLE: '素材取不到:它不在本项目里,或你此刻没有读它的权限。',
  MEDIA_TOO_LARGE: '素材太大,云端放不下这个文件,没有转写。',
  MEDIA_CHANGED: '转写期间这份素材在项目里被换掉或删掉了,结果没有写入项目。',
  TIMEOUT: '转写超过了云端允许的时限,已经停掉。可以换更小的模型,或只转写更短的素材。',
  TRANSCRIBE_FAILED: '转写失败。可以换一个模型再试;反复失败请告诉用户。',
  TRANSCRIPT_TOO_LARGE: '转写出来的段数异常地多,没有写入项目。',
  INSTALL_FAILED: '安装失败(依赖没装全)。请告诉用户联系托管方查看节点。',
  FENCE_CANCELLED: '这一轮对话的权限被收回(设为私有、被停止或 Agent 被关闭),作业已取消。',
  INTERRUPTED_ON_RESTART: 'Agent 服务重启时这个作业正在跑,已中断;可以重新发起。',
  FORBIDDEN: '没有权限:此刻你不能改这个项目。',
});

export class SttToolError extends Error {
  constructor(message, { code = 'stt-error', status = 400 } = {}) {
    super(message);
    this.name = 'SttToolError';
    this.code = code;
    this.status = status;
  }
}

const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const EXT_RE = /^[a-z0-9]{1,8}$/;
const OUTPUT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const BAD_JOB = new Set(['error', 'cancelled', 'interrupted']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const unavailable = (code, error, extra = {}) => ({ ok: false, cloudUnavailable: true, code, error, ...extra });
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** 探测环境失败(Python 跑不出来)——这类如实回「不可用」;权限被收回等别的错误照常往上抛 */
const isProbeFailure = (error) => error instanceof SttToolError && (error.code === 'status-failed' || error.code === 'python-missing');

/** 取素材失败的说法:404/403 都说成「取不到」,不透露素材在不在别的项目里 */
function assetFailure(error) {
  const status = error?.status;
  if (status === 404 || status === 403 || status === 409 || error?.code === 'asset-missing') {
    return new SttToolError(STT_ERROR_TEXT.MEDIA_UNAVAILABLE, { code: 'media-unavailable', status: 404 });
  }
  return error;
}

/**
 * @param {object} d
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<object>, register(context: object, o: { kind: string, resource: object }): Promise<{ signal: AbortSignal, closed: Promise<void> }>, signalFor(context: object): AbortSignal }} d.resources
 *   F0 的运行资源登记器(`createRunResources`)
 * @param {{ openRead(context: object, mediaId: string): Promise<{ stream: import('node:stream').Readable, assetRef: object, mediaRev: string, kind: string, closed: Promise<void> }> }} d.assets
 *   F0 的 `createProjectAssets`
 * @param {{ start: Function, update: Function, get: Function, checkpointRetained: Function }} d.jobs  F0 的 `createToolJobs`
 * @param {(context: object) => object | Promise<object>} d.workspace 这个对话的工作区(`workspace.mjs` 的 `open()`)
 * @param {(context: object, input: { mediaId: string, mediaRev: string, assetHash: string, transcript: object, jobId: string }) => Promise<{ committed: true }>} d.commitTranscript
 *   项目写入的缝:把文字稿写到项目里 `mediaId` 那份素材上。宿主在文档服务的 mutate 里实现,提交时要核素材还在、还是同一份(assetHash)
 * @param {object} [d.runtime] 部署者提供的节点配置
 * @param {string} [d.runtime.pythonPath] 解释器(必须是可执行文件,不经 shell)
 * @param {string} [d.runtime.sourceRoot] 包的源码目录(开发/测试用;正式节点把包装进 site-packages)
 * @param {string} [d.runtime.pylibs] 第三方库目录(PROMPTCUT_PYLIBS)
 * @param {string} [d.runtime.modelsDir] 模型权重目录(PROMPTCUT_MODELS)
 * @param {string} [d.runtime.ffmpegDir] ffmpeg 所在目录,放进子进程 PATH 前面
 * @param {Record<string, string>} [d.runtime.requirements] 引擎名 → 锁定依赖文件;没有这一项的引擎不开放安装
 * @param {string} [d.runtime.indexUrl] 部署者指定的包索引(只来自节点配置)
 * @param {object} [d.limits] 覆盖 `STT_DEFAULTS`
 */
export function createSttTools({ resources, assets, jobs, workspace, commitTranscript, runtime = {}, limits = {}, spawnImpl = nodeSpawn, now = Date.now } = {}) {
  if (typeof resources?.authorize !== 'function' || typeof resources?.register !== 'function' || typeof resources?.signalFor !== 'function' ||
      typeof assets?.openRead !== 'function' ||
      !['start', 'update', 'get', 'checkpointRetained'].every((k) => typeof jobs?.[k] === 'function') ||
      typeof workspace !== 'function' || typeof commitTranscript !== 'function') {
    throw new SttToolError('云端语音转写没有配置全(缺运行资源登记器、素材、作业表、工作区或项目写入口)。', { code: 'stt-unconfigured', status: 503 });
  }
  const cfg = { ...STT_DEFAULTS, ...limits };
  const allowedEngines = (cfg.engines ?? []).filter((e) => STT_ENGINES.includes(e));
  const handles = new Set(STT_TOOL_NAMES);
  /** 在跑的后台任务(转写、安装) */
  const pending = new Set();
  /** 本进程里正在做的转写作业号(防止同一个作业被两个并发调用各开一份工) */
  const transcribing = new Set();
  /** 节点里同时只允许一个安装;转写同时只跑一个(CPU 活) */
  let installing = null;
  const slot = createSlot();
  const killers = new Set();
  let closing = false;
  let closePromise = null;

  const authorize = async (context, action) => {
    if (closing) throw new SttToolError('云端语音转写正在关闭。', { code: 'stt-closed', status: 503 });
    await resources.authorize(context, action);
  };

  const wsOf = async (context) => workspace(context);

  /* ------------------------------------------------------------------ 起 Python */

  const pythonReady = () => {
    if (typeof runtime.pythonPath !== 'string' || !runtime.pythonPath) return false;
    try { return fs.statSync(runtime.pythonPath).isFile(); } catch { return false; }
  };

  /** 隔离模式:工作区(当前目录)不进模块搜索路径;包的源码目录只来自节点配置,经引导代码递进去 */
  function pythonArgs(sub) {
    return isolatedPythonArgs('promptcut_stt', { roots: runtime.sourceRoot ? [runtime.sourceRoot] : [], args: sub });
  }

  function pythonEnv(cwd, extra = {}) {
    // PYTHON* 环境变量在隔离模式下不生效(UTF-8、不看用户 site 都由命令行开关给),这里不设
    const env = childEnv(cwd, { PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', ...extra });
    if (runtime.ffmpegDir) {
      // Windows 的环境变量名不分大小写,白名单里 PATH/Path 可能都在:每个都加
      const sep = process.platform === 'win32' ? ';' : ':';
      const keys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
      if (!keys.length) env.PATH = runtime.ffmpegDir;
      for (const k of keys) env[k] = `${runtime.ffmpegDir}${sep}${env[k]}`;
    }
    // 下面两项是节点配置,不是模型给的;工作区的 childEnv 会丢掉所有 PROMPTCUT_* 变量,所以在它之后加
    if (runtime.pylibs) env.PROMPTCUT_PYLIBS = runtime.pylibs;
    if (runtime.modelsDir) env.PROMPTCUT_MODELS = runtime.modelsDir;
    return env;
  }

  /**
   * 跑一次 Python 子命令。回 `{ code, events, stderr, timedOut, aborted }`,在子进程**真的 exit + close 之后**才回。
   * 子进程先挂到运行资源登记器:撤销/停止/关闭时登记器杀它(我们把它的 kill 换成杀整棵树)。
   */
  async function runPython(context, cwd, sub, { timeoutMs, onEvent, extraEnv } = {}) {
    if (!pythonReady()) throw new SttToolError('这台云节点没有配置语音识别用的 Python。', { code: 'python-missing', status: 503 });
    // 这一轮的授权已经被收回(私有/停止/关闭)就不起子进程了
    let fenced = false;
    try { fenced = resources.signalFor(context).aborted; } catch { /* 这个对话还没登记过资源:没被收回 */ }
    if (fenced) throw new SttToolError('这一轮对话的权限已被收回。', { code: 'run-resource-fenced', status: 403 });
    const child = spawnTree(runtime.pythonPath, pythonArgs(sub), { cwd, env: pythonEnv(cwd, extraEnv) }, { spawnImpl });
    const killer = () => killTree(child);
    killers.add(killer);
    const outcome = { code: null, events: [], stderr: '', timedOut: false, aborted: false };
    let buffer = '';
    const handleLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== 'object') return;
      outcome.events.push(event.event === 'segment' || event.event === 'log' ? { event: event.event } : event);
      if (outcome.events.length > 200) outcome.events.splice(0, outcome.events.length - 100);
      try { onEvent?.(event, killer); } catch { /* 回调出错不影响子进程的收尾 */ }
    };
    let end;
    try {
      // 登记失败(这一轮已经没有权限)时 superviseChild 已经杀掉整棵树并等它收干净,错误原样往上抛
      const run = await superviseChild(child, {
        resources, context, timeoutMs,
        onStdout: (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) handleLine(line);
        },
        onStderr: (chunk) => { outcome.stderr = (outcome.stderr + chunk.toString('utf8')).slice(-2000); },
      });
      end = await run.done;
    } finally {
      killers.delete(killer);
    }
    if (buffer.trim()) handleLine(buffer);
    if (end.spawnError) throw new SttToolError('语音识别的 Python 起不来。', { code: 'python-missing', status: 503 });
    outcome.code = end.code;
    outcome.timedOut = end.timedOut;
    outcome.aborted = end.aborted;
    return outcome;
  }

  /** `status` 子命令的结果(一行 JSON);跑不出来就抛 */
  async function probeStatus(context) {
    const ws = await wsOf(context);
    const out = await runPython(context, ws.dir(), ['status'], { timeoutMs: cfg.statusMs });
    const status = [...out.events].reverse().find((e) => e && typeof e === 'object' && e.engines);
    if (out.code !== 0 || !status) {
      throw new SttToolError('语音识别环境探测失败。', { code: 'status-failed', status: 503 });
    }
    return status;
  }

  /** 给模型看的状态:不带磁盘路径、解释器路径 */
  function publicStatus(raw) {
    const engines = {};
    for (const name of STT_ENGINES) {
      const info = raw.engines?.[name] ?? {};
      engines[name] = {
        installed: info.installed === true,
        version: typeof info.version === 'string' ? info.version : null,
        allowed: allowedEngines.includes(name),
        installableHere: Boolean(runtime.requirements?.[name]) && raw.pylibs?.writable === true,
        availableModels: Array.isArray(raw.available_models?.[name]) ? raw.available_models[name].filter((m) => STT_MODELS.includes(m)) : [],
      };
    }
    return {
      ok: true,
      cloud: true,
      python: typeof raw.python === 'string' ? raw.python : null,
      engines,
      cuda: raw.cuda === true,
      ffmpeg: Boolean(raw.ffmpeg),
      models: (Array.isArray(raw.models) ? raw.models : []).map((m) => ({ name: String(m?.name ?? ''), bytes: Number(m?.bytes) || 0 })),
      defaultEngine: cfg.defaultEngine,
      defaultModel: cfg.defaultModel,
      installRunning: installing !== null,
    };
  }

  /* ------------------------------------------------------------------ 作业记录 */

  /**
   * 开作业,同样的请求同样的输入只开一个;上一个已经失败/取消/中断的,允许重新发起(换一个请求号)。
   */
  async function startJob(context, kind, digest, base) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const started = await jobs.start(context, kind, digest, `${base}-${attempt}`);
      if (!BAD_JOB.has(started.state)) return started;
    }
    throw new SttToolError('同样的请求已经失败多次,换个参数或稍后再试。', { code: 'too-many-attempts', status: 429 });
  }

  /**
   * 改作业。运行中从「共有已读」变成「保留」时,作业表要先做一次检查点才肯再写(见 ToolJobs 的 checkpointRetained)。
   * @returns {Promise<void>} 失败(含权限被收回)抛出
   */
  async function patchJob(state, patch) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await jobs.update(state.context, state.jobId, state.revision, patch);
        state.revision += 1;
        return;
      } catch (error) {
        if (error?.code === 'job-scope-mismatch' && attempt === 0) {
          const checkpoint = await jobs.checkpointRetained(state.context, state.jobId, state.revision);
          state.revision = checkpoint.revision;
          continue;
        }
        throw error;
      }
    }
  }

  const track = (task) => {
    pending.add(task);
    const done = () => pending.delete(task);
    task.then(done, done);
    return task;
  };

  /* ------------------------------------------------------------------ stt_status */

  async function sttStatus(args, context) {
    rejectUnknown(args, []);
    await authorize(context, 'read');
    if (!pythonReady()) return unavailable('PYTHON_MISSING', '这台云节点没有配置语音识别用的 Python,云端 Agent 做不了语音转写。请告诉用户联系托管方,或在电脑上的 PromptCut 里转写。');
    let raw;
    try { raw = await probeStatus(context); } catch (error) {
      if (isProbeFailure(error)) return unavailable('STATUS_FAILED', '语音识别环境探测失败,这台节点的 Python 没能正常运行。请告诉用户联系托管方。');
      throw error;
    }
    return publicStatus(raw);
  }

  /* ------------------------------------------------------------------ stt_install */

  async function sttInstall(args, context) {
    rejectUnknown(args, ['engine']);
    const engine = args?.engine;
    if (!STT_ENGINES.includes(engine)) throw new SttToolError(`engine 必须是 ${STT_ENGINES.join(' 或 ')}。`, { code: 'bad-args' });
    await authorize(context, 'write');
    if (!allowedEngines.includes(engine)) return unavailable('ENGINE_NOT_ALLOWED', `这台云节点不开放 ${engine} 引擎。`, { engine });
    if (!pythonReady()) return unavailable('PYTHON_MISSING', '这台云节点没有配置语音识别用的 Python,装不了引擎。请告诉用户联系托管方。', { engine });
    const requirements = runtime.requirements?.[engine];
    let raw;
    try { raw = await probeStatus(context); } catch (error) {
      if (isProbeFailure(error)) return unavailable('STATUS_FAILED', '语音识别环境探测失败,这台节点的 Python 没能正常运行。', { engine });
      throw error;
    }
    if (raw.engines?.[engine]?.installed === true) return { ok: true, started: false, alreadyInstalled: true, engine, hint: '这个引擎已经装好了,不用再装。' };
    if (!requirements || !fs.existsSync(requirements)) {
      return unavailable('INSTALL_NOT_ENABLED', `这台云节点不开放自助安装 ${engine}(托管方没有配置锁定依赖)。请告诉用户联系托管方安装。`, { engine });
    }
    if (raw.pylibs?.writable !== true) return unavailable('INSTALL_NOT_ENABLED', '这台云节点的第三方库目录不可写,不开放自助安装。请告诉用户联系托管方。', { engine });
    if (installing) return { ok: true, started: false, alreadyRunning: true, engine, hint: '这台节点上已经有一个安装在进行,稍后用 stt_status 看 installed。不要重复启动。' };

    const controller = { engine };
    installing = controller;                                     // 同步占位:并发的第二个调用走上面那一行
    const release = () => { if (installing === controller) installing = null; };
    let started;
    try {
      const digest = sha256(JSON.stringify({ kind: 'install', engine }));
      started = await startJob(context, 'stt.install', digest, `stt-install-${engine}`);
    } catch (error) { release(); throw error; }
    if (started.state !== 'queued') {
      release();
      return { ok: true, started: false, jobId: started.jobId, state: started.state, engine, hint: '这一轮里已经发起过同样的安装,用 background_job_status 查这个 jobId。' };
    }
    const state = { context, jobId: started.jobId, revision: 0 };
    track(runInstall(state, engine, requirements, context).finally(release));
    return { ok: true, started: true, jobId: started.jobId, engine, hint: '安装已在后台开始。用 background_job_status 查这个 jobId,或用 stt_status 看该引擎的 installed 字段。不要重复启动。' };
  }

  async function runInstall(state, engine, requirements, context) {
    try {
      await patchJob(state, { state: 'running', stage: 'install', progress: 0.02 });
      const ws = await wsOf(context);
      let lines = 0;
      let last = 0;
      let inflight = Promise.resolve();
      let revoked = null;
      const out = await runPython(context, ws.dir(), ['install', '--engine', engine, '--requirements', requirements, ...(runtime.indexUrl ? ['--index-url', runtime.indexUrl] : [])], {
        timeoutMs: cfg.installMs,
        onEvent: (event, kill) => {
          if (event.event !== 'log') return;
          lines += 1;
          const t = now();
          if (t - last < cfg.progressMs) return;
          last = t;
          const progress = Math.min(0.9, 0.05 + lines * 0.01);
          inflight = inflight.then(() => patchJob(state, { progress })).catch((error) => { revoked = error; kill(); });
        },
      });
      await inflight;
      if (revoked || out.aborted || closing) return;
      if (out.timedOut) return await finishError(state, 'TIMEOUT');
      const done = out.events.some((e) => e.event === 'done');
      if (out.code === 0 && done) return await patchJob(state, { state: 'done', progress: 1, stage: 'install' });
      await finishError(state, 'INSTALL_FAILED');
    } catch { /* 权限被收回或登记器已关:作业状态由宿主的取消负责,这里不再写 */ }
  }

  async function finishError(state, code) {
    try { await patchJob(state, { state: 'error', errorCode: code }); } catch { /* 权限被收回:交给宿主取消 */ }
  }

  /* ------------------------------------------------------------------ transcribe_media */

  function parseTranscribeArgs(args) {
    rejectUnknown(args, ['mediaId', 'engine', 'model', 'language']);
    const mediaId = args?.mediaId;
    if (typeof mediaId !== 'string' || !MEDIA_ID_RE.test(mediaId)) throw new SttToolError('mediaId 必须是素材库里的素材 id。', { code: 'bad-args' });
    const engine = args.engine ?? cfg.defaultEngine;
    if (!STT_ENGINES.includes(engine)) throw new SttToolError(`engine 必须是 ${STT_ENGINES.join(' 或 ')}。`, { code: 'bad-args' });
    const model = args.model ?? cfg.defaultModel;
    if (!STT_MODELS.includes(model)) throw new SttToolError(`model 必须是 ${STT_MODELS.join('、')} 之一。`, { code: 'bad-args' });
    let language = args.language;
    if (language !== undefined && (typeof language !== 'string' || !(language === 'auto' || LANGUAGE_RE.test(language)))) {
      throw new SttToolError('language 必须是语言代码(如 zh、en),或不填让引擎自动检测。', { code: 'bad-args' });
    }
    if (language === '' || language === 'auto') language = undefined;
    return { mediaId, engine, model, language };
  }

  /** 开工前的环境检查:没装、没权重、没 ffmpeg 就当场如实回,不开作业 */
  async function preflight(context, input) {
    if (!allowedEngines.includes(input.engine)) return unavailable('ENGINE_NOT_ALLOWED', `这台云节点不开放 ${input.engine} 引擎。`);
    if (!pythonReady()) return unavailable('PYTHON_MISSING', '这台云节点没有配置语音识别用的 Python,云端 Agent 做不了语音转写。请告诉用户联系托管方,或在电脑上的 PromptCut 里转写。');
    let raw;
    try { raw = await probeStatus(context); } catch (error) {
      if (isProbeFailure(error)) return unavailable('STATUS_FAILED', '语音识别环境探测失败,这台节点的 Python 没能正常运行。请告诉用户联系托管方。');
      throw error;
    }
    const engine = raw.engines?.[input.engine];
    if (engine?.installed !== true) {
      const canInstall = Boolean(runtime.requirements?.[input.engine]) && raw.pylibs?.writable === true;
      return unavailable('ENGINE_NOT_INSTALLED', STT_ERROR_TEXT.ENGINE_NOT_INSTALLED, { engine: input.engine, canInstall });
    }
    const models = Array.isArray(raw.available_models?.[input.engine]) ? raw.available_models[input.engine] : [];
    if (!models.includes(input.model)) {
      return unavailable('MODEL_NOT_INSTALLED', STT_ERROR_TEXT.MODEL_NOT_INSTALLED, { engine: input.engine, model: input.model, availableModels: models.filter((m) => STT_MODELS.includes(m)) });
    }
    if (!raw.ffmpeg) return unavailable('FFMPEG_MISSING', STT_ERROR_TEXT.FFMPEG_MISSING);
    return null;
  }

  /** 用不上的素材读流:关掉并等它真的 close(不无限等) */
  async function discard(read) {
    try { read.stream.destroy(); } catch { /* 已经关了 */ }
    await Promise.race([Promise.resolve(read.closed).catch(() => {}), sleep(5_000)]);
  }

  async function transcribeMedia(args, context) {
    const input = parseTranscribeArgs(args);
    await authorize(context, 'write');
    const blocked = await preflight(context, input);
    if (blocked) return blocked;

    let read;
    try { read = await assets.openRead(context, input.mediaId); } catch (error) { throw assetFailure(error); }
    if (read.kind === 'image') {
      await discard(read);
      return unavailable('NO_AUDIO', STT_ERROR_TEXT.NO_AUDIO, { mediaId: input.mediaId });
    }
    if (!Number.isSafeInteger(read.assetRef?.size) || read.assetRef.size > cfg.maxMediaBytes) {
      await discard(read);
      return unavailable('MEDIA_TOO_LARGE', STT_ERROR_TEXT.MEDIA_TOO_LARGE, { mediaId: input.mediaId });
    }

    const digest = sha256(JSON.stringify({ kind: 'transcribe', mediaId: input.mediaId, mediaRev: read.mediaRev, engine: input.engine, model: input.model, language: input.language ?? null }));
    let started;
    try { started = await startJob(context, 'stt.transcribe', digest, `stt-${digest.slice(0, 32)}`); } catch (error) { await discard(read); throw error; }
    // 同一个作业在本进程里只开一份工:查到与登记之间没有 await(两个一模一样的调用并发时,jobs.start 对还在 queued 的同一个作业会两次都回 queued)
    if (started.state !== 'queued' || transcribing.has(started.jobId)) {
      await discard(read);
      return { ok: true, started: false, jobId: started.jobId, mediaId: input.mediaId, state: started.state,
        hint: '这一轮里已经发起过同样的转写,不要重复启动。用 get_transcript 取结果,或用 background_job_status 查这个 jobId。' };
    }
    transcribing.add(started.jobId);
    let revision = 0;
    try { revision = (await jobs.get(context, started.jobId)).revision; } catch (error) { transcribing.delete(started.jobId); await discard(read); throw error; }
    const state = { context, jobId: started.jobId, revision };
    track(runTranscription(state, input, read).catch(() => { /* 内部已处理 */ }).finally(() => transcribing.delete(started.jobId)));
    return { ok: true, started: true, jobId: started.jobId, mediaId: input.mediaId, engine: input.engine, model: input.model,
      hint: '转写已在后台开始,请用 get_transcript 轮询该 mediaId(出现 segments 即完成),或用 background_job_status 查这个 jobId。不要重复启动。' };
  }

  function normalizeSegments(raw) {
    if (!Array.isArray(raw)) return null;
    const segments = [];
    for (const item of raw) {
      const start = Number(item?.start);
      const end = Number(item?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || typeof item?.text !== 'string') continue;
      segments.push({ start, end, text: item.text.trim().slice(0, cfg.maxSegmentChars) });
    }
    return segments;
  }

  async function runTranscription(state, input, read) {
    const { context } = state;
    let rel = null;
    let ws = null;
    let release = null;
    let finalCode = null;
    try {
      ws = await wsOf(context);
      await patchJob(state, { state: 'running', stage: 'fetch', progress: 0 });

      /* 1. 取素材到工作区(边收边核哈希是 ProjectAssets 做的) */
      const ext = EXT_RE.test(String(read.assetRef?.ext ?? '')) ? read.assetRef.ext : 'bin';
      rel = `stt/${state.jobId}.${ext}`;
      const writer = ws.writer(rel);
      let received = 0;
      try {
        for await (const chunk of read.stream) {
          received += chunk.length;
          if (received > cfg.maxMediaBytes) throw new SttToolError(STT_ERROR_TEXT.MEDIA_TOO_LARGE, { code: 'MEDIA_TOO_LARGE' });
          writer.write(chunk);
        }
        await read.closed;
        writer.end();
      } catch (error) {
        writer.abort();
        throw error;
      }
      await patchJob(state, { stage: 'queue', progress: 0.08 });

      /* 2. 等转写名额(同时只跑一个) */
      const signal = resources.signalFor(context);
      release = await slot.acquire(signal);
      signal.throwIfAborted();
      await patchJob(state, { stage: 'transcribe', progress: 0.1 });

      /* 3. 转写 */
      let lastPatch = 0;
      let inflight = Promise.resolve();
      let revoked = null;
      const out = await runPython(context, ws.dir(), [
        'transcribe', '--input', ws.resolve(rel), '--engine', input.engine, '--model', input.model,
        '--language', input.language ?? 'auto', '--device', cfg.device, '--offline',
      ], {
        timeoutMs: cfg.transcribeMs,
        onEvent: (event, kill) => {
          if (event.event !== 'progress') return;
          const total = Number(event.total);
          const done = Number(event.done);
          if (!(total > 0) || !Number.isFinite(done)) return;
          const t = now();
          if (t - lastPatch < cfg.progressMs) return;
          lastPatch = t;
          const progress = Math.min(0.9, 0.1 + 0.8 * Math.max(0, Math.min(1, done / total)));
          // 写库失败(权限被收回、作业被取消)就把子进程停掉
          inflight = inflight.then(() => patchJob(state, { progress })).catch((error) => { revoked = error; kill(); });
        },
      });
      await inflight;
      release(); release = null;
      if (revoked || out.aborted || closing) return;           // 权限被收回或服务在关:作业状态交给宿主(取消/重启时标中断)
      if (out.timedOut) { finalCode = 'TIMEOUT'; return; }
      const done = [...out.events].reverse().find((e) => e.event === 'done');
      const errored = [...out.events].reverse().find((e) => e.event === 'error');
      if (out.code !== 0 || !done) {
        finalCode = ({ 'engine-missing': 'ENGINE_NOT_INSTALLED', 'model-missing': 'MODEL_NOT_INSTALLED', 'ffmpeg-missing': 'FFMPEG_MISSING', 'no-audio': 'NO_AUDIO' })[errored?.kind] ?? 'TRANSCRIBE_FAILED';
        return;
      }
      const segments = normalizeSegments(done.segments);
      if (!segments) { finalCode = 'TRANSCRIBE_FAILED'; return; }
      if (segments.length > cfg.maxSegments) { finalCode = 'TRANSCRIPT_TOO_LARGE'; return; }

      /* 4. 写回项目:提交前重核写权限,宿主的提交再核素材还在、还是同一份 */
      signal.throwIfAborted();
      await patchJob(state, { stage: 'commit', progress: 0.95 });
      await resources.authorize(context, 'write');
      const transcript = {
        engine: input.engine,
        model: input.model,
        ...(typeof done.language === 'string' && done.language ? { language: done.language } : (input.language ? { language: input.language } : {})),
        createdAt: new Date(now()).toISOString(),
        segments,
      };
      try {
        await commitTranscript(context, { mediaId: input.mediaId, mediaRev: read.mediaRev, assetHash: read.assetRef.hash, transcript, jobId: state.jobId });
      } catch (error) {
        if (error?.code === 'media-changed' || error?.code === 'media-missing') { finalCode = 'MEDIA_CHANGED'; return; }
        throw error;
      }
      await patchJob(state, {
        state: 'done', stage: 'commit', progress: 1,
        ...(OUTPUT_ID_RE.test(input.mediaId) ? { outputRefs: [{ kind: 'transcript', id: input.mediaId }] } : {}),
      });
    } catch (error) {
      finalCode = classify(error);
    } finally {
      if (release) release();
      if (rel && ws) { try { ws.remove(rel); } catch { /* 留给对话删除时清 */ } }
      await discard(read);
      if (finalCode) await finishError(state, finalCode);
    }
  }

  /** 异常 → 作业错误码;null 表示权限被收回/关闭这类「不是作业自己的失败」,状态交给宿主取消 */
  function classify(error) {
    const code = error?.code;
    if (code === 'MEDIA_TOO_LARGE' || code === 'quota' || code === 'too-large') return 'MEDIA_TOO_LARGE';
    if (code === 'python-missing') return 'TRANSCRIBE_FAILED';
    if (error?.name === 'AbortError' || code === 'ABORT_ERR') return null;
    if (typeof code === 'string' && /^(forbidden|fence-|authorization-|run-|tool-|stale-revision|terminal-job|job-)/.test(code)) return null;
    if (error?.status === 403 || error?.status === 404) return 'MEDIA_UNAVAILABLE';
    return 'TRANSCRIBE_FAILED';
  }

  function rejectUnknown(args, allowed) {
    if (args === undefined || args === null) return;
    if (typeof args !== 'object' || Array.isArray(args)) throw new SttToolError('参数必须是一个对象。', { code: 'bad-args' });
    const extra = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extra.length) throw new SttToolError(`不认识的参数:${extra.join('、')}。可用的参数:${allowed.length ? allowed.join('、') : '无'}。`, { code: 'bad-args' });
  }

  /* ------------------------------------------------------------------ 对外 */

  async function call(name, args, context) {
    if (!handles.has(name)) throw new SttToolError(`语音转写不处理 ${name}。`, { code: 'unknown-tool', status: 404 });
    if (name === 'stt_status') return sttStatus(args, context);
    if (name === 'stt_install') return sttInstall(args, context);
    return transcribeMedia(args, context);
  }

  /**
   * 关闭:不再接新调用,杀掉所有在跑的子进程树,等它们真的 exit + close、后台任务收尾。
   * @returns {Promise<{ childrenClosed: boolean, streamsClosed: boolean, workPending: number }>}
   */
  function close(_reason = 'close') {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const killer of [...killers]) killer();
      const all = Promise.allSettled([...pending]);
      const finished = await Promise.race([all.then(() => true), sleep(cfg.closeMs).then(() => false)]);
      return { childrenClosed: finished && killers.size === 0, streamsClosed: finished, workPending: pending.size };
    })();
    return closePromise;
  }

  return Object.freeze({ handles, call, close });
}
