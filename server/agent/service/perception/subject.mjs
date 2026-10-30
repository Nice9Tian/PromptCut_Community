/**
 * 云端 Agent 的主体识别(`subject_status`、`subject_install`、`detect_subjects`、`list_subjects`;
 * 拆包表 `docs/plan/cloud-agent-tools-implementation.md` 的 P4)。
 *
 * 桌面版里这四个工具打编辑器进程的 `/api/subject/*`(`server/vite-plugin-subject.ts`),作业放在 RAM 里,结果由页面写回项目。
 * 云节点上没有编辑器进程,这里照同一份命令行与 JSONL 约定起同一个 Python 包(`promptcut_subject`,隔离模式起),规矩是:
 *
 *   - **上下文只来自 F0**:每个调用带的 `context` 是 `tool-context.mjs` 发的可信八字段;每次读素材、起进程、写项目之前,
 *     都用 `run-resources.mjs` 的 `authorize` 重验 doc 的当前 grant / fence,不信工具参数里的任何项目或路径;
 *   - **素材只经 `project-assets.mjs` 的 `openRead`**(带哈希核对)取到这个对话的工作目录(`subject/<作业号>/`),
 *     跑完删;Python 只读这份本地文件,并且加 `--local-only`,ffmpeg / ffprobe 只准读本地文件;
 *   - **子进程只经工作区的受限子进程起**(`workspace.mjs` 的 `spawn`:环境变量白名单、不弹窗口、起成一棵杀得掉的进程树),并登记到
 *     `run-resources.mjs`(kind `child`):这一轮被停、转私有、Agent 关闭、服务关闭时,进程树真被杀掉、`exit` 与 `close` 都到了才算关
 *     (杀树、等收尾、登记用公共实现 `runner.mjs`);
 *   - **Python 用隔离模式起**(`-I`,`runner.mjs` 的 `isolatedPythonArgs`):工作目录是对话工作区,里面是成员和模型弄进来的文件,
 *     不让它排进模块搜索路径;包目录与受控安装的目录只来自部署配置,经引导代码递进去;
 *   - **作业记在 `tool-jobs.mjs` 的持久账本里**(`subject.detect` / `subject.install`):服务重启后 `running` 变 `interrupted`,
 *     不是「找不到」;账本只存状态与进度,中文的失败原因与采样点数等放在对话工作区的 `subject/jobs.json`;
 *   - **结果写项目素材的当前版本**:`project.setMediaSubjects` 带上取字节时的 `mediaRev` 做版本预期,素材中途被换掉就丢弃这次结果,
 *     不写;写之前再验一次 write 权限(只读成员在起作业之前就被拒);
 *   - **没有兜底档**:两档都用不了(`engine` 为 null)就如实回「用不了」,不起一个注定失败的作业;
 *     light 档不假称提示词生效,full 档缺权重如实报告。
 *
 * **`subject_install` 在云端受限**:只装包内锁定的清单(部署者可给一份锁版本的 `requirements`),不收任何 pip 参数;
 * 没有配 `pylibs` 与 `requirements` 就不装(回「用不了」)。full 档(torch + 690 MB 权重)本来就不走在线装,只随部署送达。
 *
 * 表里本包列的四个工具名在 `SUBJECT_TOOL_NAMES`。工具总表(`cloud-tools.mjs`)的接线归 G 包,本文件不碰它。
 * 纯 Node,不引用浏览器,也不直接 import `src/`(独立入口对前端代码只经 `server/agent/ssr-host.mjs` 的载入缝):
 * 取采样时刻与建议位置要的内核函数由宿主经 `kernel` 参数注入,没注入就是「没配置全」,工厂直接拒绝。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedPythonArgs, splitRoots, superviseChild } from './runner.mjs';

export const SUBJECT_TOOL_NAMES = Object.freeze(['subject_status', 'subject_install', 'detect_subjects', 'list_subjects']);

export const SUBJECT_DEFAULTS = Object.freeze({
  /** `status` 子进程的时限(full 档要 import torch,冷启动慢) */
  statusMs: 45_000,
  /** 状态结果缓存多久(每次 status 都要起一个 Python) */
  statusCacheMs: 15_000,
  /** 一个检测作业的时限:每帧 perFrameMs、下限 minDetectMs(与桌面版同一组数) */
  perFrameMs: 20_000,
  minDetectMs: 120_000,
  /** 在线安装 light 档的时限 */
  installMs: 10 * 60_000,
  /** 把素材取到工作目录:大小与时限 */
  maxFetchBytes: 1024 * 1024 * 1024,
  fetchMs: 5 * 60_000,
  /** 整个进程同时在跑的检测作业 */
  maxRunning: 2,
  /** 进度写账本的最小间隔 */
  progressMinMs: 400,
  /** 工作区索引里留多少条作业 */
  historyJobs: 20,
  /** 提示词最长 */
  maxPromptChars: 300,
});

export class SubjectToolError extends Error {
  constructor(message, code = 'subject-error') {
    super(message);
    this.name = 'SubjectToolError';
    this.code = code;
  }
}

const NOT_CONFIGURED = '这台云节点没有配置主体识别(Python 解释器与模型权重由部署者提供,云端 Agent 不能往节点上装)。'
  + '位置和遮挡的判断请退回 see_frames 看真实画面,不要凭空猜「人在左边」;或请用户联系托管方,或在电脑上的 PromptCut 里检测。';
const NO_ENGINE = '这台云节点上主体识别两档都用不了(依赖或权重没装好),没有兜底档。'
  + '位置和遮挡的判断请退回 see_frames 看真实画面,不要假装检测过;请用户联系托管方补装。';
const INSTALL_OFF = '云端 Agent 在这台节点上不能安装主体识别:节点没有给「受控安装」配置(锁定版本的依赖清单与安装目录),'
  + '模型也不能自己指定 pip 参数。请告诉用户联系托管方,或在电脑上的 PromptCut 里安装。';

const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{8,128}$/;
const OUTPUT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const INDEX_FILE = 'subject/jobs.json';
const RESERVED = Symbol('reserved');
/** 进程没起来时没有登记,也就没有取消信号:给一个永远不响的 */
const NEVER_ABORTED = Object.freeze({ aborted: false });
const sha = (text) => createHash('sha256').update(text).digest('hex');

/**
 * 节点上的主体识别配置(部署决定)。
 *
 *   PROMPTCUT_AGENT_SUBJECT_PYTHON       装了依赖的 Python 解释器(绝对路径)。配了主体识别才可用
 *   PROMPTCUT_AGENT_SUBJECT_MODELS       权重目录(绝对路径;yunet.onnx、rtdetr_r18vd.onnx、grounding-dino-tiny/)
 *   PROMPTCUT_AGENT_SUBJECT_PYLIBS       可选:受控安装的目标目录(同时进 Python 的模块搜索路径)
 *   PROMPTCUT_AGENT_SUBJECT_REQUIREMENTS 可选:受控安装用的锁定版本清单(绝对路径);与 PYLIBS 都给了才允许 `subject_install`
 *   PROMPTCUT_AGENT_SUBJECT_WHEELHOUSE   可选:受控安装只从这个本地轮子目录装(`pip --no-index --find-links`),不连网
 *   PROMPTCUT_FFMPEG                     ffmpeg 的绝对路径,取它所在目录进 PATH
 */
export function readSubjectConfig(env, { root }) {
  const python = env.PROMPTCUT_AGENT_SUBJECT_PYTHON;
  if (typeof python !== 'string' || !python) return null;
  if (!path.isAbsolute(python) || !fs.existsSync(python)) return { error: 'PROMPTCUT_AGENT_SUBJECT_PYTHON 要是存在的解释器的绝对路径' };
  const modelsDir = env.PROMPTCUT_AGENT_SUBJECT_MODELS;
  if (typeof modelsDir !== 'string' || !path.isAbsolute(modelsDir) || !fs.existsSync(modelsDir)) {
    return { error: 'PROMPTCUT_AGENT_SUBJECT_MODELS 要是存在的权重目录的绝对路径' };
  }
  const pylibs = env.PROMPTCUT_AGENT_SUBJECT_PYLIBS;
  const requirements = env.PROMPTCUT_AGENT_SUBJECT_REQUIREMENTS;
  if (requirements && (!path.isAbsolute(requirements) || !fs.existsSync(requirements))) {
    return { error: 'PROMPTCUT_AGENT_SUBJECT_REQUIREMENTS 要是存在的清单文件的绝对路径' };
  }
  if (pylibs && !path.isAbsolute(pylibs)) return { error: 'PROMPTCUT_AGENT_SUBJECT_PYLIBS 要是绝对路径' };
  const ffmpegDir = env.PROMPTCUT_FFMPEG && path.isAbsolute(env.PROMPTCUT_FFMPEG) ? path.dirname(env.PROMPTCUT_FFMPEG) : null;
  return {
    python, modelsDir,
    pythonPath: [path.join(root, 'python'), ...(pylibs ? [pylibs] : [])].join(path.delimiter),
    ...(ffmpegDir ? { ffmpegDir } : {}),
    ...(pylibs && requirements ? { install: { pylibs, requirements, ...(env.PROMPTCUT_AGENT_SUBJECT_WHEELHOUSE ? { wheelhouse: env.PROMPTCUT_AGENT_SUBJECT_WHEELHOUSE } : {}) } } : {}),
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

/** 框按面积取前几个并取整(与桌面版 `topBoxes` 同一口径) */
function topBoxes(boxes, limit = 4) {
  return [...boxes].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, limit).map((b) => ({
    label: b.label, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), conf: Math.round(b.conf * 100) / 100,
  }));
}

/**
 * @param {object} d
 * @param {object | null} d.config `readSubjectConfig` 的结果;没有就是 null(工具如实回「没配」)
 * @param {object} d.resources `run-resources.mjs` 的 `createRunResources`(register / signalFor / authorize / verifyFence)
 * @param {object} d.assets `project-assets.mjs` 的 `createProjectAssets`(只用 `openRead`)
 * @param {object} d.jobs `tool-jobs.mjs` 的 `createToolJobs`(它的 authorize / verifyFence 由宿主接到同一个 `resources`)
 * @param {(context: object) => (object | Promise<object>)} d.workspace 这个对话的工作区(`workspace.mjs` 的 `open()` 的结果)
 * @param {object} d.project 项目一侧的窄接口(G 包接到 doc 的版本预期与操作栅栏):
 *   `getMedia(context, mediaId)` -> 项目当前副本里的素材记录或 null(带 `mediaRev` 更好);
 *   `setMediaSubjects(context, { mediaId, expectedMediaRev, subjects, jobId })` -> `{ projectRev? }`,版本对不上抛带 `code: 'media-changed'` 的错
 * @param {{ startProxy(): Promise<{ url: string, close(): Promise<void> }> } | null} [d.egress] 受控安装连网时才要
 * @param {object} d.kernel 宿主经 ssr-host 载入缝取来注入:`{ MAX_SUBJECT_TIMES, subjectSampleTimes, suggestPosition }`(必需)
 */
export function createSubjectTools({
  config = null, resources, assets, jobs, workspace, project, egress = null,
  kernel = null, limits: limitsIn = {}, now = Date.now, log = () => {},
} = {}) {
  for (const [name, dep, methods] of [['resources', resources, ['register', 'authorize']], ['assets', assets, ['openRead']],
    ['jobs', jobs, ['start', 'update', 'get', 'checkpointRetained']], ['project', project, ['getMedia', 'setMediaSubjects']]]) {
    if (!dep || methods.some((m) => typeof dep[m] !== 'function')) throw new SubjectToolError(`主体识别缺少依赖:${name}`, 'subject-unconfigured');
  }
  if (typeof workspace !== 'function') throw new SubjectToolError('主体识别缺少依赖:workspace', 'subject-unconfigured');
  for (const [name, type] of [['MAX_SUBJECT_TIMES', 'number'], ['subjectSampleTimes', 'function'], ['suggestPosition', 'function']]) {
    if (typeof kernel?.[name] !== type) throw new SubjectToolError(`主体识别没配置全:缺内核项 ${name}(宿主要经 ssr-host 载入缝取来注入 kernel)`, 'subject-unconfigured');
  }
  const limits = { ...SUBJECT_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };
  /** `config.args` 只给单测与探针(把解释器整个换成替身脚本);正式的一律隔离模式,包目录来自部署配置 */
  const stubArgs = config && Array.isArray(config.args) && config.args.length ? config.args : null;
  const globalArgs = config ? ['--models-dir', config.modelsDir, '--local-only'] : [];
  const pythonArgv = (subArgs) => (stubArgs
    ? [...stubArgs, ...globalArgs, ...subArgs]
    : isolatedPythonArgs('promptcut_subject', { roots: splitRoots(config.pythonPath), args: [...globalArgs, ...subArgs] }));
  const loadKernel = async () => kernel;

  /** 正在跑的作业(本进程):jobId -> 状态。close 要等它们的子进程真关 */
  const live = new Map();
  /** 同一素材同一时刻只一个检测作业:`项目\0素材` -> jobId */
  const byMedia = new Map();
  let installLive = null;
  /** 正在登记账本、还没进 live 的检测作业数(两个并发调用不能同时越过上限检查) */
  let reserving = 0;
  let installSummary = null;
  let statusCache = null;
  let closing = false;
  const settled = new Set();
  /** 本进程起的、还没关的 Python 子进程(含 status):close 要全部杀掉并等它们真关 */
  const children = new Set();

  const authorize = async (context, action) => {
    if (closing) throw new SubjectToolError('云端 Agent 服务正在关闭,主体识别不再接新活。', 'subject-closing');
    try { return await resources.authorize(context, action); }
    catch (error) {
      if (error instanceof SubjectToolError) throw error;
      // 文档服务联系不上:fail closed,但说清是「上游不可用」(503),不是「没权限」(403)
      if (['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable'].includes(error?.code)) {
        throw Object.assign(new SubjectToolError('文档服务暂时联系不上,没法确认这一轮的权限,主体识别没有开始。稍后再试。', 'authority-unavailable'), { status: 503 });
      }
      throw Object.assign(new SubjectToolError(action === 'write' ? '这一轮没有写项目的权限(只读成员、被停止或已转私有),主体识别没有开始。' : '这一轮没有读项目的权限,主体识别没有开始。', 'subject-forbidden'), { status: 403 });
    }
  };

  const workspaceKey = (context) => `${context.projectId}\0${context.conversationId}`;

  /* ---------------------------------------------------------------- 工作区索引(中文原因、采样点数等账本不存的东西) */

  function readIndex(ws) {
    try {
      if (!ws.exists(INDEX_FILE)) return [];
      const rows = JSON.parse(ws.read(INDEX_FILE, { maxBytes: 1024 * 1024 }).toString('utf8'));
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    } catch { return []; }
  }
  /** 读-改-写在一个同步段里完成,同一进程内不会交错 */
  function mutateIndex(ws, mutate) {
    try {
      const rows = readIndex(ws);
      mutate(rows);
      ws.write(INDEX_FILE, JSON.stringify(rows.slice(-limits.historyJobs)));
    } catch (err) { say('agent.subject.index-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
  }

  /* ---------------------------------------------------------------- 起 Python */

  /**
   * 起一次 `promptcut_subject <子命令>`(隔离模式)。登记到 run-resources(整棵进程树真关了才算关),
   * 逐行读 JSONL。回 `{ done, kill, signal, closed }`:`done` 解析成 `{ code, events, stderrTail, timedOut }`。
   */
  async function runPython(context, ws, subArgs, { timeoutMs, env: extraEnv = {}, onEvent = () => {} } = {}) {
    if (!config) throw new SubjectToolError(NOT_CONFIGURED, 'subject-unavailable');
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH';
    // PYTHON* 环境变量在隔离模式下不生效(无缓冲、UTF-8、不写字节码、包目录都由命令行给),这里不设
    const env = {
      ...(config.ffmpegDir ? { [pathKey]: `${config.ffmpegDir}${path.delimiter}${process.env[pathKey] ?? ''}` } : {}),
      ...extraEnv,
    };
    const child = ws.spawn(config.python, pythonArgv(subArgs), { env });
    const events = [];
    const stderrTail = [];
    const feed = jsonLines((ev) => { events.push(ev); if (events.length > 2000) events.splice(0, 500); onEvent(ev); });
    let run;
    try {
      run = await superviseChild(child, {
        resources, context, timeoutMs,
        onStdout: (d) => feed(d.toString('utf8')),
        onStderr: (d) => {
          for (const l of d.toString('utf8').split(/\r?\n/)) if (l.trim()) { stderrTail.push(l.trim().slice(0, 300)); if (stderrTail.length > 20) stderrTail.shift(); }
        },
      });
    } catch {
      // 登记被拒:superviseChild 已经杀掉整棵树并等它收干净
      throw new SubjectToolError('这一轮已经没有权限继续(被停止、转私有或 Agent 关闭),主体识别进程没有启动。', 'subject-forbidden');
    }
    const done = run.done.then((end) => {
      feed.flush();
      if (end.spawnError) stderrTail.push(String(end.spawnError?.message ?? end.spawnError).slice(0, 300));
      return { code: end.spawnError ? -1 : (end.code ?? -1), events, stderrTail, timedOut: end.timedOut };
    });
    const entry = { kill: run.kill, closed: done.then(() => undefined) };
    children.add(entry);
    void entry.closed.then(() => children.delete(entry));
    if (closing) entry.kill();
    return { done, kill: entry.kill, signal: run.signal ?? NEVER_ABORTED, closed: entry.closed };
  }

  /** 路径与盘符不回给模型 */
  const scrub = (text, ws) => {
    let out = String(text ?? '');
    let workDir = null;
    try { workDir = ws?.dir?.() ?? null; } catch { workDir = null; }
    if (workDir) out = out.split(workDir).join('<工作目录>');
    for (const secret of [config?.modelsDir, config?.python, ...(config?.pythonPath ?? '').split(path.delimiter), config?.install?.pylibs, config?.install?.requirements, config?.install?.wheelhouse].filter(Boolean)) {
      out = out.split(secret).join('<节点目录>');
    }
    return out.replace(/[A-Za-z]:\\[^\s'",)]+/g, '<节点目录>');
  };

  /* ---------------------------------------------------------------- subject_status */

  function trimDetail(info, ws) {
    const tier = (t) => ({
      ready: t?.ready === true,
      runtime: { installed: t?.runtime?.installed === true, version: t?.runtime?.version ?? null, ...(t?.runtime?.error ? { error: scrub(t.runtime.error, ws).slice(0, 200) } : {}) },
      models: Object.fromEntries(Object.entries(t?.models ?? {}).map(([name, m]) => [name, { exists: m?.exists === true, ...(Number.isFinite(m?.bytes) ? { bytes: m.bytes } : {}) }])),
    });
    return { engine: info.engine ?? null, light: tier(info.light), full: tier(info.full), ffmpeg: Boolean(info.ffmpeg) };
  }

  function statusHint(engine) {
    return engine === 'full'
      ? 'full 档:YuNet + RT-DETR + Grounding DINO,能按任意文字提示找目标(prompt 生效)。'
      : engine === 'light'
        ? 'light 档:YuNet(人脸) + RT-DETR(人体),只认 person 和 face,prompt 不生效。要按任意词找目标(猫、手机、红色的车)得有 full 档。'
        : '两档都用不了,这台机器上检测不了主体。位置和遮挡的判断退回 see_frames 看图,不要凭空猜「人在左边」。';
  }

  /** 查一次档位(缓存几秒)。回 `{ ok, ready, engine, detail?, reason? }`,不抛 */
  async function readStatus(context, ws, { fresh = false } = {}) {
    if (!config) return { ok: true, ready: false, engine: null, reason: NOT_CONFIGURED };
    if (!fresh && statusCache && now() - statusCache.at < limits.statusCacheMs) return statusCache.value;
    let run;
    try { run = await runPython(context, ws, ['status'], { timeoutMs: limits.statusMs }); }
    catch (error) { if (error?.code === 'subject-forbidden') throw error; return { ok: true, ready: false, engine: null, reason: scrub(error?.message, ws) }; }
    const result = await run.done;
    await run.closed;
    const ev = result.events.find((e) => e.event === 'status');
    let value;
    if (!ev) {
      const tail = result.stderrTail.slice(-2).join(' ');
      value = { ok: true, ready: false, engine: null, reason: result.timedOut ? '查主体识别状态超时' : scrub(tail || '解释器没有返回可解析的状态', ws) };
    } else {
      const detail = trimDetail(ev, ws);
      value = { ok: true, ready: detail.engine !== null, engine: detail.engine, detail, version: ev.version };
    }
    if (value.ready) statusCache = { at: now(), value }; else statusCache = null;
    return value;
  }

  async function subjectStatus(context) {
    await authorize(context, 'read');
    const ws = await workspace(context);
    const s = await readStatus(context, ws, { fresh: true });
    await authorize(context, 'read');
    return {
      ...s,
      hint: config ? statusHint(s.engine) : NOT_CONFIGURED,
      installable: Boolean(config?.install),
      ...(installSummary ? { install: { ...installSummary } } : {}),
    };
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
          return { ok: false, error: error };
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

  /* ---------------------------------------------------------------- detect_subjects */

  function cleanPrompt(raw) {
    if (typeof raw !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, limits.maxPromptChars);
  }

  const mediaIdOf = (args) => {
    const id = args?.mediaId;
    if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) throw new SubjectToolError('mediaId 必填,是素材的 id(可用 list_media 查看)', 'bad-args');
    return id;
  };

  const notFound = (id) => new SubjectToolError(`找不到素材 ${String(id).slice(0, 80)}(没有这个 id,或它不在当前项目里)`, 'media-not-found');

  async function detectSubjects(context, args, options = {}) {
    await authorize(context, 'write');
    const mediaId = mediaIdOf(args);
    const k = await loadKernel();
    const ws = await workspace(context);
    const media = await project.getMedia(context, mediaId);
    if (!media) throw notFound(mediaId);
    if (media.kind === 'audio') throw new SubjectToolError(`${media.name} 是音频,没有画面可看`, 'media-kind');
    if (media.pending) throw new SubjectToolError(`${media.name} 还没进素材服务(上传没完成或失败),稍后再试或重新导入`, 'media-pending');

    const prompt = cleanPrompt(args?.prompt);
    const promptChanged = !!media.subjects && prompt !== (media.subjects.prompt ?? '');
    if (!config) return { ok: false, cloudUnavailable: true, error: NOT_CONFIGURED };
    const status = await readStatus(context, ws);
    const staleEngine = !!media.subjects && !!prompt && media.subjects.engine !== 'full' && status.engine === 'full';
    if (media.subjects && args?.force !== true && !promptChanged && !staleEngine) {
      const cannotAnswerPrompt = !!prompt && media.subjects.engine !== 'full';
      return {
        reused: true, mediaId, engine: media.subjects.engine,
        samples: media.subjects.samples.length,
        failedCount: media.subjects.failedCount ?? 0,
        prompt: media.subjects.prompt,
        ...(cannotAnswerPrompt
          ? { engineNote: '已有结果是 light 档跑的,label 只有 person / face,答不了提示词里别的名词;这台机器现在也只能跑 light,所以没有重测。有 full 档之后再传 force:true 重测。' }
          : null),
        hint: '这个素材已经检测过了,直接用 list_subjects 取结果,或用 list_shots 看每个镜头的 suggestedPosition;要重测传 force:true',
      };
    }
    if (status.engine === null) return { ok: false, cloudUnavailable: true, error: NO_ENGINE, detail: status.detail ?? undefined, reason: status.reason };

    const max = k.MAX_SUBJECT_TIMES;
    const autoRaw = k.subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length;
    let times;
    if (Array.isArray(args?.times) && args.times.length > 0) {
      if (args.times.length > max) throw new SubjectToolError(`一次最多 ${max} 个采样时刻(收到 ${args.times.length} 个),请分批`, 'bad-args');
      times = args.times.map(Number).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
    } else times = k.subjectSampleTimes(media);
    if (times.length === 0) throw new SubjectToolError('算不出采样时刻,素材可能没有时长信息;可以自己传 times', 'bad-args');
    const sampledNote = !args?.times && autoRaw > times.length
      ? `素材偏长或镜头偏碎,采样已从 ${autoRaw} 点降到 ${times.length} 点(上限 ${max});镜头级的结论会更粗,approximate 为 true 的镜头会变多。`
      : undefined;
    const engine = status.engine;
    const msPerFrame = engine === 'full' ? 3000 : 500;
    const etaSeconds = Math.ceil((times.length * msPerFrame) / 1000) + 5;

    const mediaKey = `${context.projectId}\0${mediaId}`;
    const digest = sha(JSON.stringify({ v: 1, mediaId, times, prompt }));
    const already = byMedia.get(mediaKey);
    if (already) {
      const liveJob = live.get(already);
      if (liveJob && liveJob.digest === digest && liveJob.conversationId === context.conversationId) {
        return { jobId: already, started: false, alreadyRunning: true, mediaId, samples: times.length, engine, hint: '同样的主体检测已经在跑,用 list_subjects 轮询,不要重复启动。' };
      }
      throw new SubjectToolError('这个素材正在做另一次主体检测,等它跑完(用 list_subjects 轮询)再换参数重测。', 'subject-busy');
    }
    if (live.size + reserving >= limits.maxRunning) throw new SubjectToolError('节点上主体检测正在跑的作业太多了,过一会儿再试。', 'subject-busy');

    const requestId = REQUEST_RE.test(options.requestId ?? '') ? options.requestId : `sd_${randomUUID().replace(/-/g, '')}`;
    // 先占位再 await:同一素材的两个并发调用,第二个看到占位就回 busy
    byMedia.set(mediaKey, RESERVED);
    reserving += 1;
    let started;
    try { started = await jobs.start(context, 'subject.detect', digest, requestId); }
    catch (error) {
      byMedia.delete(mediaKey);
      throw new SubjectToolError(`主体检测没能登记作业(${error?.code ?? '账本不可用'})`, 'subject-job');
    } finally { reserving -= 1; }
    if (closing) {
      byMedia.delete(mediaKey);
      void tracker(context, started.jobId).patch({ state: 'interrupted', errorCode: 'SERVICE_CLOSING' });
      throw new SubjectToolError('云端 Agent 服务正在关闭,主体识别不再接新活。', 'subject-closing');
    }
    const result = {
      jobId: started.jobId, started: true, mediaId,
      samples: times.length,
      sampledFrom: media.shots ? '按镜头(每个镜头 20%/50%/80%)' : '每 2 秒一点(这段素材还没做镜头识别)',
      ...(sampledNote ? { sampledNote } : null),
      engine, etaSeconds,
      ...(staleEngine ? { staleEngine: true, engineNote: '上一批结果是 light 档跑的,答不了提示词,所以这次重测(不是复用)' } : null),
      hint: '主体检测已在后台开始,用 list_subjects 轮询该 mediaId;'
        + `预计 ${etaSeconds} 秒左右(engine=${engine},实测 light 约 0.5 秒/帧、full 约 3 秒/帧)。`
        + `${engine === 'full' ? 'full 档慢,隔 10 秒问一次就够' : '隔 3 秒问一次就够'},别每秒都问。`
        + '跑完之后 list_shots 的每个镜头会带上 subject 和 suggestedPosition。',
    };
    if (started.state !== 'queued' || live.has(started.jobId)) {
      // 同一 requestId 的重试:作业已经开了,不再开第二个
      if (byMedia.get(mediaKey) === RESERVED) byMedia.delete(mediaKey);
      return { ...result, started: false, alreadyRunning: started.state === 'queued' || started.state === 'running', state: started.state };
    }

    const job = {
      jobId: started.jobId, context, mediaId, mediaKey, digest, times, prompt, engine,
      conversationId: context.conversationId, cancelRequested: null, kill: null, done: null,
    };
    live.set(job.jobId, job);
    byMedia.set(mediaKey, job.jobId);
    mutateIndex(ws, (rows) => {
      rows.push({ jobId: job.jobId, kind: 'detect', mediaId, digest, prompt, samples: times.length, engine, status: 'queued', startedAt: now() });
    });
    job.done = runDetectJob(job, ws).catch((error) => say('agent.subject.worker-crashed', { message: String(error?.message ?? error).slice(0, 160) }))
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

  async function runDetectJob(job, ws) {
    const { context, mediaId, times, prompt } = job;
    const track = tracker(context, job.jobId);
    const rel = `subject/${job.jobId}/media`;
    let mediaFile = null;
    const abortedBySignal = () => job.cancelRequested || closing;
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
      const fetchTimer = setTimeout(() => { fetchError = new SubjectToolError('取素材超时', 'fetch-timeout'); read.stream.destroy(); }, limits.fetchMs);
      fetchTimer.unref?.();
      try {
        for await (const piece of read.stream) {
          if (abortedBySignal()) throw new SubjectToolError('已取消', 'cancelled');
          fetched += piece.length;
          if (fetched > limits.maxFetchBytes) throw new SubjectToolError('素材太大,云端主体检测取不下来', 'too-large');
          writer.write(piece);
        }
        if (fetchError) throw fetchError;
        writer.end();
      } catch (error) {
        writer.abort();
        read.stream.destroy();
        await read.closed.catch(() => {});
        if (abortedBySignal()) return await finishJob(job, ws, track, { state: job.cancelRequested === 'close' || closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SUBJECT_CANCELLED', message: '主体检测已被取消。' });
        const message = error?.code === 'too-large' ? '素材太大,云端主体检测取不下来。' : error?.code === 'fetch-timeout' ? '取素材超时。' : `取素材失败(${scrub(error?.code ?? error?.message ?? error).slice(0, 80)})。`;
        return await finishJob(job, ws, track, { state: 'error', errorCode: error?.code === 'cancelled' ? 'SUBJECT_CANCELLED' : 'MEDIA_FETCH_FAILED', message });
      } finally { clearTimeout(fetchTimer); job.abortFetch = null; }
      await read.closed.catch(() => {});
      if (abortedBySignal()) return await finishJob(job, ws, track, { state: closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SUBJECT_CANCELLED', message: '主体检测已被取消。' });

      // 2) 起 Python 抽帧检测
      await track.patch({ stage: 'detect', progress: 0.1 });
      mutateIndex(ws, (rows) => { const row = rows.find((r) => r.jobId === job.jobId); if (row) row.status = 'running'; });
      const limitMs = Math.max(limits.minDetectMs, times.length * limits.perFrameMs);
      let resultEvent = null;
      let errorEvent = null;
      let lastSent = 0;
      let lastPct = -1;
      let run;
      try {
        const args = ['detect', ws.resolve(mediaFile), '--times', times.join(','), ...(prompt ? [`--prompt=${prompt}`] : [])];
        run = await runPython(context, ws, args, {
          timeoutMs: limitMs,
          onEvent: (ev) => {
            if (ev.event === 'progress') {
              const total = Number(ev.total) || times.length;
              const pct = Math.max(0, Math.min(99, Math.round((Number(ev.done) / total) * 100)));
              const t = now();
              if (pct !== lastPct && t - lastSent >= limits.progressMinMs) {
                lastSent = t; lastPct = pct;
                void track.patch({ progress: Math.max(0.1, Math.min(0.95, 0.1 + 0.85 * (pct / 100))) });
              }
            } else if (ev.event === 'result') resultEvent = ev;
            else if (ev.event === 'error') errorEvent = ev;
          },
        });
      } catch (error) {
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SUBJECT_FAILED', message: scrub(error?.message ?? '主体检测进程没能启动', ws) });
      }
      job.kill = run.kill;
      if (abortedBySignal()) run.kill();
      const outcome = await run.done;
      await run.closed;
      job.kill = null;

      if (abortedBySignal() || run.signal.aborted) {
        return await finishJob(job, ws, track, { state: closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SUBJECT_CANCELLED', message: closing ? '主体检测被服务关闭中断,没有结果。可以重新调 detect_subjects(force:true)。' : '主体检测已被取消。' });
      }
      if (outcome.timedOut) {
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SUBJECT_TIMEOUT', message: `主体检测超时(超过 ${Math.round(limitMs / 1000)} 秒),已强制结束。可以减少 times 的个数,或先用 subject_status 确认档位(full 档很慢)。` });
      }
      if (!resultEvent) {
        const message = scrub(errorEvent?.message || outcome.stderrTail.join('\n').trim() || (outcome.code === 0 ? '主体检测没有返回结果' : `主体检测进程异常退出(代码 ${outcome.code})`), ws).slice(0, 400);
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SUBJECT_FAILED', message });
      }
      let subjects;
      try { subjects = toSubjects(resultEvent, prompt, now()); }
      catch (error) { return await finishJob(job, ws, track, { state: 'error', errorCode: 'SUBJECT_FAILED', message: error.message }); }

      // 3) 写项目素材的当前版本(带取字节时的 mediaRev 做版本预期)
      const committing = await track.patch({ stage: 'commit', progress: 0.97 });
      if (!committing.ok) {
        // 账本已被栅栏取消(终态),或权限已撤、账本写不了:都不写项目
        return await finishJob(job, ws, track, { state: 'cancelled', errorCode: 'FENCE_CANCELLED', message: '这一轮已不能写项目(被停止、转私有或权限变了),检测结果没有写入。' });
      }
      try { await authorize(context, 'write'); }
      catch { return await finishJob(job, ws, track, { state: 'cancelled', errorCode: 'FENCE_CANCELLED', message: '这一轮已不能写项目(被停止、转私有或权限变了),检测结果没有写入。' }); }
      if (abortedBySignal()) return await finishJob(job, ws, track, { state: closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SUBJECT_CANCELLED', message: '主体检测已被取消,结果没有写入。' });
      try { await project.setMediaSubjects(context, { mediaId, expectedMediaRev: mediaRev, subjects, jobId: job.jobId }); }
      catch (error) {
        const changed = error?.code === 'media-changed';
        return await finishJob(job, ws, track, {
          state: 'error', errorCode: changed ? 'MEDIA_CHANGED' : 'COMMIT_REJECTED',
          message: changed ? '检测期间这个素材被换掉或重新导入了,这次结果对不上新素材,已丢弃。请重新调 detect_subjects。' : `检测结果没能写进项目(${scrub(error?.code ?? error?.message ?? '被拒绝', ws).slice(0, 80)})。`,
        });
      }
      const ref = OUTPUT_ID_RE.test(mediaId) ? mediaId : sha(mediaId).slice(0, 32);
      await finishJob(job, ws, track, {
        state: 'done', extra: {
          outputRefs: [{ kind: 'subjects', id: ref }],
          index: { engine: subjects.engine, failedCount: subjects.failedCount, ...(subjects.fellBackFrom ? { fellBackFrom: subjects.fellBackFrom } : {}) },
        },
      });
    } finally {
      if (mediaFile) { try { ws.remove(mediaFile); } catch { /* 留给对话删除时清 */ } try { fs.rmSync(path.dirname(ws.resolve(mediaFile)), { recursive: true, force: true }); } catch { /* 同上 */ } }
    }
  }

  /** Python 的 result 事件 -> 项目里 `MediaAsset.subjects` 的形状(与 `src/ai/subject.ts` 的 `waitForSubjects` 同一口径) */
  function toSubjects(ev, prompt, at) {
    const samples = Array.isArray(ev.samples) ? ev.samples : null;
    const sampleOk = (s) => s && typeof s === 'object' && Number.isFinite(s.t) && Array.isArray(s.boxes)
      && (s.failed === true || (['left', 'right', 'top', 'bottom'].includes(s.safeSide) && s.occupancy && typeof s.occupancy === 'object'));
    if (!samples || samples.length === 0 || !samples.every(sampleOk)) throw new SubjectToolError('主体检测返回的结果格式不对,已丢弃。', 'bad-result');
    const failedCount = Number.isFinite(Number(ev.failedCount)) ? Number(ev.failedCount) : samples.filter((s) => s.failed).length;
    return {
      engine: ev.engine === 'full' ? 'full' : 'light',
      createdAt: new Date(at).toISOString(),
      prompt: typeof ev.prompt === 'string' ? ev.prompt : prompt,
      width: Number(ev.width) || 0,
      height: Number(ev.height) || 0,
      samples,
      failedCount,
      ...(ev.fellBackFrom === 'full' ? { fellBackFrom: 'full', fallbackReason: typeof ev.fallbackReason === 'string' ? scrub(ev.fallbackReason).slice(0, 400) : undefined } : null),
    };
  }

  /* ---------------------------------------------------------------- list_subjects */

  const INTERRUPTED = '上一次主体检测被服务重启或关闭中断了,没有结果。可以重新调 detect_subjects(传 force:true)。';

  async function listSubjects(context, args) {
    await authorize(context, 'read');
    const mediaId = mediaIdOf(args);
    const k = await loadKernel();
    const media = await project.getMedia(context, mediaId);
    if (!media) throw notFound(mediaId);
    const ws = await workspace(context);
    const row = [...readIndex(ws)].reverse().find((r) => r.kind === 'detect' && r.mediaId === mediaId);
    if (row) {
      let ledger = null;
      try { ledger = await jobs.get(context, row.jobId); } catch { ledger = null; }
      // 账本是主;但作业已经收尾而账本没写成(权限已撤,账本等宿主的栅栏取消)时,以工作区索引里的终态为准
      const finished = ['done', 'error', 'cancelled', 'interrupted'];
      const state = !ledger
        ? (row.status === 'queued' || row.status === 'running' ? 'interrupted' : row.status)
        : (finished.includes(row.status) && !finished.includes(ledger.state) && !live.has(row.jobId) ? row.status : ledger.state);
      if (state === 'queued' || state === 'running') {
        const percent = Math.max(0, Math.min(99, Math.round((ledger?.progress ?? 0) * 100)));
        return {
          running: true, percent, engine: row.engine,
          ...(media.subjects ? { stale: true, staleNote: '上一批结果还在,但新一次检测正在跑,这里不给样本;跑完再调一次本工具' } : null),
        };
      }
      if (state === 'error' || state === 'cancelled' || state === 'interrupted') {
        const message = row.message || (state === 'interrupted' ? INTERRUPTED : '上一次主体检测没有成功。');
        throw new SubjectToolError(media.subjects ? `${message}(项目里还留着更早成功的一批结果,不是这次的。)` : message, `job-${state}`);
      }
    }
    if (!media.subjects) return null;
    const s = media.subjects;
    return {
      running: false,
      engine: s.engine,
      engineNote: s.engine === 'full'
        ? 'Grounding DINO,label 是提示词里的名词;prompt 为空时按 person . face . 找'
        : 'YuNet + RT-DETR 的 light 档,只认 person 和 face,提示词不生效(原样回显在 prompt 里)',
      ...(s.fellBackFrom
        ? { fellBackFrom: s.fellBackFrom, fallbackNote: `本来要跑 full 档,中途退回了 light:${s.fallbackReason ?? '原因未知'}。所以 prompt 没生效,label 只可能是 person / face。` }
        : null),
      prompt: s.prompt,
      width: s.width,
      height: s.height,
      failedCount: s.failedCount ?? s.samples.filter((sm) => sm.failed).length,
      samples: s.samples.map((sm) => ({
        t: sm.t,
        ...(sm.failed
          ? { failed: true, reason: sm.reason ?? '这一帧没抽出来', boxes: [], boxCount: 0 }
          : { safeSide: sm.safeSide, ...k.suggestPosition(sm.safeSide, sm.occupancy), occupancy: sm.occupancy, boxes: topBoxes(sm.boxes), boxCount: sm.boxes.length }),
      })),
      hint: '坐标是原始视频像素(和 width/height 同一套)。要按镜头排卡片就直接看 list_shots,那边每个镜头已经把这些采样按镜头折好了。'
        + 'suggestedPosition 可直接填进卡片的 params.position(只会是 left / right / bottom,不会返回 center);为 null 表示四档都被人物占住,'
        + '看 suggestedOccupancy 和 warning,那一刻没有不遮人的位置。failed 为 true 的采样是抽帧失败,不是「这一帧没有人」,不要拿它下结论。',
    };
  }

  /* ---------------------------------------------------------------- subject_install */

  async function subjectInstall(context, _args, options = {}) {
    await authorize(context, 'write');
    if (!config) return { ok: false, cloudUnavailable: true, error: NOT_CONFIGURED };
    if (!config.install) return { ok: false, cloudUnavailable: true, error: INSTALL_OFF };
    if (installLive) return { jobId: installLive.jobId ?? null, started: false, alreadyRunning: true, hint: '主体识别正在安装,用 subject_status 看 engine 有没有变。不要重复启动。' };
    const ws = await workspace(context);
    const status = await readStatus(context, ws, { fresh: true });
    if (status.engine) return { ok: true, ready: true, alreadyInstalled: true, engine: status.engine, hint: `这台云节点已经有 ${status.engine} 档,不用装。` };
    if (installLive) return { jobId: installLive.jobId ?? null, started: false, alreadyRunning: true, hint: '主体识别正在安装,用 subject_status 看 engine 有没有变。不要重复启动。' };

    const requestId = REQUEST_RE.test(options.requestId ?? '') ? options.requestId : `si_${randomUUID().replace(/-/g, '')}`;
    let started;
    installLive = { jobId: null }; // 占位:两个并发的 subject_install 只有一个能往下走
    try { started = await jobs.start(context, 'subject.install', sha('subject.install:light'), requestId); }
    catch (error) { installLive = null; throw new SubjectToolError(`主体识别安装没能登记作业(${error?.code ?? '账本不可用'})`, 'subject-job'); }
    if (started.state !== 'queued' || closing) {
      installLive = null;
      return { jobId: started.jobId, started: false, state: started.state };
    }
    const job = { jobId: started.jobId, context, cancelRequested: null, kill: null, done: null };
    installLive = job;
    live.set(job.jobId, job);
    installSummary = { state: 'running', startedAt: now() };
    job.done = runInstallJob(job).catch((error) => say('agent.subject.install-crashed', { message: String(error?.message ?? error).slice(0, 160) }))
      .finally(() => { live.delete(job.jobId); if (installLive === job) installLive = null; settled.delete(job.done); });
    settled.add(job.done);
    return {
      jobId: started.jobId, started: true,
      hint: '主体检测 light 档正在受控安装(只装部署者锁定的 onnxruntime 清单,不收任何 pip 参数)。用 subject_status 看 engine 有没有变成 light;不要重复启动。'
        + '装完还可能缺权重文件(yunet.onnx / rtdetr_r18vd.onnx),那由部署者放进节点的权重目录,返回里会说。',
    };
  }

  async function runInstallJob(job) {
    const { context } = job;
    const ws = await workspace(context);
    const track = tracker(context, job.jobId);
    const logTail = [];
    let proxy = null;
    try {
      if (!(await track.patch({ state: 'running', stage: 'install', progress: 0.05 })).ok) return;
      const env = { PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1' };
      if (egress) {
        proxy = await egress.startProxy();
        Object.assign(env, { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, ALL_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url, all_proxy: proxy.url, NO_PROXY: '', no_proxy: '' });
      } else Object.assign(env, { PIP_NO_INDEX: '1' });
      if (config.install.wheelhouse) Object.assign(env, { PIP_NO_INDEX: '1', PIP_FIND_LINKS: config.install.wheelhouse });
      let installed = null;
      let errorEvent = null;
      let run;
      try {
        run = await runPython(context, ws, ['--pylibs', config.install.pylibs, 'install', '--tier', 'light', '--requirements', config.install.requirements], {
          timeoutMs: limits.installMs, env,
          onEvent: (ev) => {
            if (ev.event === 'log' && typeof ev.line === 'string') { logTail.push(scrub(ev.line, ws).slice(0, 300)); if (logTail.length > 20) logTail.shift(); }
            else if (ev.event === 'installed') installed = ev;
            else if (ev.event === 'error') errorEvent = ev;
          },
        });
      } catch (error) {
        installSummary = { state: 'error', finishedAt: now(), message: scrub(error?.message, ws).slice(0, 300) };
        await track.patch({ state: 'error', errorCode: 'SUBJECT_INSTALL_FAILED' });
        return;
      }
      job.kill = run.kill;
      if (closing || job.cancelRequested) run.kill();
      const outcome = await run.done;
      await run.closed;
      job.kill = null;
      statusCache = null;
      if (closing || job.cancelRequested || run.signal.aborted) {
        installSummary = { state: 'cancelled', finishedAt: now() };
        await track.patch({ state: closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SUBJECT_CANCELLED' });
        return;
      }
      if (outcome.timedOut) {
        installSummary = { state: 'error', finishedAt: now(), message: `安装超时(超过 ${Math.round(limits.installMs / 1000)} 秒),已强制结束。` };
        await track.patch({ state: 'error', errorCode: 'SUBJECT_TIMEOUT' });
        return;
      }
      if (!installed) {
        const pipTail = logTail.filter((l) => /error|no matching|could not/i.test(l)).slice(-2).join(' ');
        const message = scrub([errorEvent?.message || `安装进程退出码 ${outcome.code}`, pipTail].filter(Boolean).join(' '), ws).slice(0, 500);
        installSummary = { state: 'error', finishedAt: now(), message };
        await track.patch({ state: 'error', errorCode: 'SUBJECT_INSTALL_FAILED' });
        return;
      }
      installSummary = { state: 'done', finishedAt: now(), needsModel: installed.needsModel === true, engine: installed.engine ?? null };
      await track.patch({ state: 'done', progress: 1 });
    } finally {
      if (proxy) await proxy.close().catch(() => {});
    }
  }

  /* ---------------------------------------------------------------- 对外 */

  const handlers = {
    subject_status: (context) => subjectStatus(context),
    subject_install: (context, args, options) => subjectInstall(context, args, options),
    detect_subjects: (context, args, options) => detectSubjects(context, args, options),
    list_subjects: (context, args) => listSubjects(context, args),
  };

  return Object.freeze({
    handles: new Set(SUBJECT_TOOL_NAMES),
    /**
     * @param {string} name 工具名
     * @param {object} args 模型给的参数(只收 mediaId / times / prompt / force)
     * @param {object} context F0 发的可信八字段
     * @param {{ requestId?: string }} [options] 宿主给的幂等号(工具调用 id);同一号重试不会开第二个作业
     */
    call(name, args, context, options = {}) {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
      if (!handler) return Promise.reject(new SubjectToolError(`主体识别不处理 ${String(name).slice(0, 60)}`, 'unknown-tool'));
      return Promise.resolve().then(() => handler(context, args ?? {}, options));
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
