/**
 * 云端 Agent 的运动追踪四件套:`track_status`、`track_install`、`track_points`、`get_track`
 * (拆包表 P3 一行;`docs/plan/cloud-agent-tools-implementation.md`)。`attach_clip_motion` 在 `../hosted-motion.mjs`。
 *
 * 和桌面版(`server/vite-plugin-track.ts`)的差别,都来自「账号版云端」的几条硬规矩:
 *
 *   - 素材字节经项目素材服务(F0 的 `ProjectAssets.openRead`),先落到这个对话的工作区,再递给 Python;
 *     不收本机路径、不收地址。
 *   - 作业状态写在 F0 的持久作业表里(`ToolJobs`,SQLite):每次推进都重核 doc 的当前授权与 fence;
 *     服务重启后 `running` 的变成 `interrupted`,不会凭内存里的 Map 消失成 404。
 *   - 轨迹结果持久在本模块自己的表里,键是「项目 × 对话 × 素材 × 素材版本」,不是全局 `mediaId` 的 Map;
 *     只有作业表里是 `done` 的作业,它的结果才读得到(写结果之后作业推进失败,结果跟着删)。
 *   - Python 子进程只经工作区的受限 `spawn()` 起(环境变量白名单、不弹窗口、起成一棵杀得掉的进程树),再登记进 F0 的运行资源表:
 *     fence 变了(私有、停止、Agent 关闭、被踢……)由资源表杀掉整棵树(Python 再起的 ffmpeg 一起),`close()` 等到 close 事件才算收干净。
 *     杀树、等收尾、登记用公共实现 `runner.mjs`。
 *   - Python 用隔离模式起(`-I`,`runner.mjs` 的 `isolatedPythonArgs`):工作目录是对话工作区,不让它排进模块搜索路径;
 *     包目录只来自部署配置(`python.packageRoot`),经引导代码递进去。
 *   - 云端 `track_install` 只跑包里随发的(或部署者指定的锁定)依赖清单,模型给不了任何 pip 或 shell 参数;
 *     部署者没开安装时回明确的原因(节点上的拓展由托管方统一装)。
 *
 * 追踪分两档,由 Python 侧按 `status` 选:装了 torch 且权重在 → BootsTAPIR;否则 numpy 的模板匹配兜底。
 * 结果里的 `engine` 是真实跑的那一档,不在起作业时猜。
 *
 * 本文件只调用 F0(`tool-context`、`tool-jobs`、`project-assets`、`run-resources`),不改它们;
 * 不引用 `src/`,不碰渲染。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolatedPythonArgs, splitRoots, superviseChild } from './runner.mjs';

export const TRACK_TOOL_NAMES = Object.freeze(['track_status', 'track_install', 'track_points', 'get_track']);

export const TRACK_DEFAULTS = Object.freeze({
  /** 一次最多追几个点 */
  maxPoints: 32,
  /**
   * 视频超过这么多帧就拒绝(不截断:轨迹要盖住整段素材,`attach_clip_motion` 才对得上时间)。
   * 模板匹配把整段视频解成灰度放内存(720 长边约 0.3 MB 一帧),1800 帧约 0.5 GB;按节点内存由部署者调。
   */
  maxFrames: 1800,
  /** 取来的素材字节上限 */
  maxVideoBytes: 1024 * 1024 * 1024,
  /** 同时跑几个追踪作业(其余排队,作业状态是 queued) */
  maxConcurrentJobs: 2,
  /** 一次追踪的时限 */
  jobTimeoutMs: 10 * 60_000,
  /** 一次安装的时限 */
  installTimeoutMs: 30 * 60_000,
  /** `track_status` 起 Python 的时限 */
  statusTimeoutMs: 60_000,
  /** `track_status` 结果缓存多久(装完拓展会清) */
  statusTtlMs: 10_000,
  /** 进度写进作业表的最小间隔 */
  progressIntervalMs: 500,
});

export class TrackToolError extends Error {
  /** @param {string} code 稳定的机器可读码(`TRACK_*`);message 是给模型看的中文 */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TrackToolError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const MEDIA_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const canonical = (value) => JSON.stringify(value);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 报错里不带服务器上的路径:盘符路径和 `/a/b` 形的路径都抹掉 */
export function scrubPaths(text, max = 400) {
  return String(text ?? '')
    .replace(/[A-Za-z]:[\\/][^\s'"<>|]*/g, '<路径>')
    .replace(/(?:^|[\s(=:])\/(?:[^\s'"<>|/]+\/)+[^\s'"<>|/]*/g, (m) => `${m[0] === '/' ? '' : m[0]}<路径>`)
    .slice(0, max);
}

/* ---------------------------------------------------------------- 结果表 */

/**
 * 追踪作业与结果的持久表(SQLite,WAL + FULL)。和 `ToolJobs` 的作业表是两个文件:作业表只收状态,
 * 这里收「作业对应哪个素材的哪个版本」和轨迹本体。读取一律带 `projectId`、`conversationId` 两个范围。
 */
export function createTrackResultStore({ databasePath, now = Date.now } = {}) {
  if (typeof databasePath !== 'string' || !databasePath.trim() || databasePath === ':memory:') {
    throw new TrackToolError('TRACK_UNCONFIGURED', '追踪结果表要一个磁盘路径');
  }
  const file = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  const db = new DatabaseSync(file);
  if (!existed && process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* 目录已是 0700 */ }
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_runs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('track','install')),
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      media_rev TEXT,
      media_hash TEXT,
      point_count INTEGER NOT NULL,
      engine TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL,
      seq INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS track_runs_lookup ON track_runs (project_id, conversation_id, kind, media_id, seq);
    CREATE TABLE IF NOT EXISTS track_results (
      job_id TEXT PRIMARY KEY REFERENCES track_runs(job_id) ON DELETE CASCADE,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      frames INTEGER NOT NULL,
      points_json TEXT NOT NULL
    );
  `);
  let closed = false;
  const live = () => { if (closed) throw new TrackToolError('TRACK_CLOSED', '追踪结果表已关闭'); return db; };
  const decodeRun = (row) => (row ? {
    jobId: row.job_id, kind: row.kind, projectId: row.project_id, conversationId: row.conversation_id,
    mediaId: row.media_id, mediaRev: row.media_rev, mediaHash: row.media_hash, pointCount: row.point_count,
    engine: row.engine, detail: row.detail, createdAt: row.created_at,
  } : null);
  return Object.freeze({
    /** 登记一个作业对应哪个素材;已登记过(幂等重试)回 false */
    registerRun({ jobId, kind, projectId, conversationId, mediaId = '', mediaRev = null, mediaHash = null, pointCount = 0 }) {
      const d = live();
      const seq = (d.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM track_runs').get()).n;
      const info = d.prepare(`INSERT OR IGNORE INTO track_runs
        (job_id, kind, project_id, conversation_id, media_id, media_rev, media_hash, point_count, created_at, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(jobId, kind, projectId, conversationId, mediaId, mediaRev, mediaHash, pointCount, Number(now()), seq);
      return Number(info.changes) === 1;
    },
    /** 取来素材之后补上它此刻的版本 */
    setMediaVersion(jobId, { mediaRev, mediaHash }) {
      live().prepare('UPDATE track_runs SET media_rev=?, media_hash=? WHERE job_id=?').run(mediaRev ?? null, mediaHash ?? null, jobId);
    },
    setEngine(jobId, engine) { live().prepare('UPDATE track_runs SET engine=? WHERE job_id=?').run(engine, jobId); },
    setDetail(jobId, detail) { live().prepare('UPDATE track_runs SET detail=? WHERE job_id=?').run(String(detail ?? '').slice(0, 2000), jobId); },
    saveResult(jobId, { width, height, frames, points }) {
      live().prepare('INSERT OR REPLACE INTO track_results (job_id, width, height, frames, points_json) VALUES (?, ?, ?, ?, ?)')
        .run(jobId, width, height, frames, JSON.stringify(points));
    },
    dropResult(jobId) { live().prepare('DELETE FROM track_results WHERE job_id=?').run(jobId); },
    run(jobId, projectId, conversationId) {
      return decodeRun(live().prepare('SELECT * FROM track_runs WHERE job_id=? AND project_id=? AND conversation_id=?').get(jobId, projectId, conversationId));
    },
    /** 这个对话里最近一次(某素材的追踪 / 安装) */
    latestRun({ projectId, conversationId, kind, mediaId = '' }) {
      return decodeRun(live().prepare(`SELECT * FROM track_runs WHERE project_id=? AND conversation_id=? AND kind=? AND media_id=?
        ORDER BY seq DESC LIMIT 1`).get(projectId, conversationId, kind, mediaId));
    },
    result(jobId) {
      const row = live().prepare('SELECT * FROM track_results WHERE job_id=?').get(jobId);
      return row ? { width: row.width, height: row.height, frames: row.frames, points: JSON.parse(row.points_json) } : null;
    },
    close() { if (!closed) { closed = true; db.close(); } },
  });
}

/* ---------------------------------------------------------------- 小工具 */

function createSlots(max) {
  let free = Math.max(1, max);
  const waiters = [];
  return {
    async acquire() {
      if (free > 0) { free -= 1; return; }
      await new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next(); else free += 1;
    },
  };
}

/** stderr 末尾有用的一行(Python 的栈最后一行就是异常本身) */
function lastLine(text, max = 300) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.at(-1) ?? '').slice(-max);
}

/** 对话里原样回给模型的追踪摘要(与桌面版同形:每个点的可见帧数、位移范围、起止坐标) */
export function summarizePoints(points) {
  return points.map((p, i) => {
    const xs = p.xy.map((q) => q[0]);
    const ys = p.xy.map((q) => q[1]);
    return {
      index: i,
      query: p.query,
      visibleFrames: p.visible.filter(Boolean).length,
      totalFrames: p.visible.length,
      movedX: Math.round(Math.max(...xs) - Math.min(...xs)),
      movedY: Math.round(Math.max(...ys) - Math.min(...ys)),
      from: p.xy[0]?.map((v) => Math.round(v)),
      to: p.xy[p.xy.length - 1]?.map((v) => Math.round(v)),
      ...(p.note ? { note: p.note } : {}),
    };
  });
}

const ENGINE_NOTE = {
  bootstapir: 'BootsTAPIR,任意点追踪,visible 为 false 表示该帧被遮挡或移出画面',
  template: '当前是模板匹配兜底(云节点没装运动追踪拓展,或权重不在)。刚体、纹理清晰、不转向的目标能追得很准,'
    + '但目标一旦转向、缩放或长时间被挡就会跟丢;某个点带 note 字段表示它压根没追成',
};

/** Python 侧的 error.code → 作业表里的稳定错误码 */
const PYTHON_ERROR_CODE = {
  'too-long': 'TRACK_TOO_LONG',
  'engine-unavailable': 'TRACK_ENGINE_UNAVAILABLE',
  'ffmpeg-missing': 'TRACK_ENGINE_UNAVAILABLE',
  'bad-points': 'TRACK_BAD_POINTS',
  'video-missing': 'TRACK_FAILED',
};

/** 这些错误码说明任务的授权或 fence 变了:作业记成「随任务取消」,不当成追踪自己失败 */
const CANCEL_CODES = new Set(['run-resource-fenced', 'run-resource-unauthorized', 'forbidden', 'fence-rejected', 'fence-changed', 'job-scope-mismatch']);

/** 作业错误码 → 给模型看的话。导出给「后台作业状态」(`hosted-workflow.mjs` 的 `errorTexts`)用,两处说的是同一句 */
export const TRACK_ERROR_TEXT = Object.freeze({
  TRACK_TIMEOUT: '这次追踪超过了时限,已被停掉。请减少点数或把素材剪短后再追。',
  TRACK_TOO_LONG: '素材太长,超出这台节点一次能追的帧数。请先把素材剪短再追。',
  TRACK_ENGINE_UNAVAILABLE: '这台节点上追踪用的 Python 运行环境不可用(缺 numpy 或 ffmpeg)。请告诉用户联系托管方。',
  TRACK_NOT_VIDEO: '这个素材不是视频,没有运动可追。',
  TRACK_MEDIA_MISSING: '素材字节取不到(素材服务上没有这份素材,或还没传完)。稍后再试或重新导入。',
  TRACK_BAD_POINTS: '追踪点不合法。',
  TRACK_FAILED: '追踪进程失败。',
  TRACK_SPOOL_FAILED: '素材放不进这个对话的工作目录(超过空间上限)。',
  TRACK_TOO_LARGE: '素材文件太大,这台节点不追。',
  INTERRUPTED_ON_RESTART: '服务重启,上一次追踪被中断了。',
  PROVIDER_CLOSED: '服务正在关闭,这次追踪被停掉了。',
  RUN_CANCELLED: '这次追踪随任务一起被取消了。',
  FENCE_CANCELLED: '这次追踪随任务一起被取消了。',
  TRACK_INSTALL_FAILED: '拓展安装失败。',
});
const JOB_ERROR_MESSAGE = TRACK_ERROR_TEXT;

const errorMessageOf = (code) => JOB_ERROR_MESSAGE[code] ?? `追踪失败(${code})。`;

/* ---------------------------------------------------------------- 提供者 */

/**
 * @param {object} d
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<object> }} d.contextAccess F0 `tool-context`
 * @param {{ register(context: object, o: { kind: string, resource: object }): Promise<{ signal: AbortSignal, closed: Promise<void> }> }} d.resources F0 `run-resources`
 * @param {object} d.jobs F0 `tool-jobs`
 * @param {{ openRead(context: object, mediaId: string, o?: object): Promise<{ stream: import('node:stream').Readable, assetRef: object, mediaRev: string, kind: string, closed: Promise<void> }> }} d.assets F0 `project-assets`
 * @param {(context: object) => Promise<object>} d.workspace 这个对话的工作区(`workspace.mjs` 的 `open()`)
 * @param {string} [d.databasePath] 结果表的磁盘路径(与 `results` 二选一)
 * @param {ReturnType<typeof createTrackResultStore>} [d.results] 现成的结果表(调用方持有,关闭也归调用方)
 * @param {{ executable: string, packageRoot: string, pylibs?: string, models?: string, ffmpeg?: string, requirements?: string } | null} d.python
 *   部署者配置的 Python 运行环境;`packageRoot` 是放着 `promptcut_*` 包的目录。null = 这台节点没配
 * @param {(context: object) => Promise<{ media: Array<{ id: string, kind?: string, hash?: string }> } | null>} [d.readProject]
 *   项目副本的只读视图;给了才能提前核「素材存在、是视频」和判轨迹是否过期
 * @param {{ enabled?: boolean, direct?: boolean, env?: Record<string, string> }} [d.install] 部署者开了才能装;没给 `egress` 时还要 `direct: true`(部署者声明节点层已管住这个进程的出网)才装
 * @param {{ startProxy(): Promise<{ url: string, close(): Promise<void> }> } | null} [d.egress] 出网闸(`egress.mjs`):安装时 pip 只经它起的回环代理连网
 * @param {object} [d.limits]
 */
export function createTrackTools({
  contextAccess, resources, jobs, assets, workspace, databasePath, results: resultsIn = null, python = null,
  readProject = null, install = {}, egress = null, limits: limitsIn = {}, now = Date.now,
} = {}) {
  for (const [name, dep, methods] of [
    ['contextAccess', contextAccess, ['authorize']], ['resources', resources, ['register']],
    ['jobs', jobs, ['start', 'update', 'get', 'checkpointRetained']], ['assets', assets, ['openRead']],
  ]) {
    if (!dep || methods.some((m) => typeof dep[m] !== 'function')) throw new TrackToolError('TRACK_UNCONFIGURED', `createTrackTools 缺 ${name}`);
  }
  if (typeof workspace !== 'function') throw new TrackToolError('TRACK_UNCONFIGURED', 'createTrackTools 缺 workspace');
  const limits = { ...TRACK_DEFAULTS, ...limitsIn };
  const store = resultsIn ?? createTrackResultStore({ databasePath, now });
  const ownsStore = resultsIn === null;

  const slots = createSlots(limits.maxConcurrentJobs);
  const runners = new Set();        // 还在跑的作业(含排队的)
  const children = new Set();       // 还没 close 的子进程(`{ kill }`,杀的是整棵树)
  const activeJobs = new Set();     // 本进程里有 runner 的 jobId
  let installing = null;            // 本进程里正在装的 jobId(进程级单例)
  let closing = false;
  let closeReceipt = null;
  let statusCache = null;

  /* ---- 起 Python ---- */

  const pythonFlags = () => {
    const flags = [];
    if (python?.pylibs) flags.push('--pylibs', python.pylibs);
    if (python?.models) flags.push('--models', python.models);
    if (python?.ffmpeg) flags.push('--ffmpeg', python.ffmpeg);
    return flags;
  };

  /**
   * 经工作区的受限 spawn 起 `promptcut_track …`(隔离模式),登记进运行资源表,逐行解析 stdout 的 JSON 事件。
   * 回 `{ code, signal, timedOut, aborted, events, stderrTail }`;子进程 exit + close 之后才返回。
   */
  async function runPython(context, ws, args, { timeoutMs, onEvent = () => {}, env = {}, preamble = [] } = {}) {
    if (!python?.executable) throw new TrackToolError('TRACK_UNCONFIGURED', '这台云节点没有配置运动追踪的 Python 运行环境。请告诉用户联系托管方。');
    if (closing) throw new TrackToolError('TRACK_CLOSED', '服务正在关闭');
    // PYTHON* 环境变量在隔离模式下不生效(包目录、UTF-8 都由命令行给),这里不设
    const argv = isolatedPythonArgs('promptcut_track', { roots: splitRoots(python.packageRoot), args: [...pythonFlags(), ...preamble, ...args] });
    const child = ws.spawn(python.executable, argv, { env: { ...env } });
    const entry = { kill: () => child.kill() };
    children.add(entry);
    child.once('close', () => children.delete(entry));
    const state = { events: [], stderrTail: '', buffer: '' };
    let run;
    try {
      run = await superviseChild(child, {
        resources, context, timeoutMs,
        onStdout: (chunk) => {
          state.buffer += chunk.toString('utf8');
          const lines = state.buffer.split(/\r?\n/);
          state.buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('{')) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            if (!isPlain(ev)) continue;
            state.events.push(ev.event === 'log' ? { event: 'log' } : ev);
            try { onEvent(ev); } catch { /* 回调出错不影响进程收尾 */ }
          }
        },
        onStderr: (chunk) => { state.stderrTail = (state.stderrTail + chunk.toString('utf8')).slice(-2000); },
      });
    } catch (error) {
      // 登记被拒:superviseChild 已经杀掉整棵树并等到它收干净
      children.delete(entry);
      throw error;
    }
    const end = await run.done;
    children.delete(entry);
    if (end.spawnError) {
      // 起都没起来(解释器路径不对):没有进程可登记
      throw Object.assign(new Error('python-spawn-failed'), { code: end.spawnError?.code ?? 'SPAWN_FAILED', jobCode: 'TRACK_ENGINE_UNAVAILABLE', detail: 'Python 解释器起不来' });
    }
    return { code: end.code, signal: end.signal, timedOut: end.timedOut, aborted: end.aborted, events: state.events, stderrTail: state.stderrTail };
  }

  /* ---- 作业状态推进 ---- */

  /**
   * 作业修订号的游标。所有推进排成一条队(进度事件和终态不能抢同一个修订号);
   * `update` 遇到 active→retained 的合法变化时,走 F0 给的受控 checkpoint 再试一次。
   */
  function cursorFor(context, jobId) {
    let revision = 0;
    let lastProgressAt = 0;
    let chain = Promise.resolve();
    async function apply(patch) {
      try {
        await jobs.update(context, jobId, revision, patch);
      } catch (error) {
        if (error?.code !== 'job-scope-mismatch') throw error;
        const moved = await jobs.checkpointRetained(context, jobId, revision);
        revision = moved.revision;
        await jobs.update(context, jobId, revision, patch);
      }
      revision += 1;
    }
    return {
      update(patch, { throttle = false } = {}) {
        if (throttle) {
          const t = Number(now());
          if (t - lastProgressAt < limits.progressIntervalMs) return Promise.resolve(false);
          lastProgressAt = t;
        }
        const run = chain.then(() => apply(patch)).then(() => true);
        chain = run.catch(() => {});
        return run;
      },
    };
  }

  async function finishWith(cursor, jobId, patch) {
    try { await cursor.update(patch); return true; } catch { return false; }
  }

  function launch(task) {
    const running = task().finally(() => runners.delete(running));
    runners.add(running);
    running.catch(() => {});
    return running;
  }

  /* ---- 追踪作业 ---- */

  async function runTrackJob(context, jobId, { mediaId, points }) {
    const cursor = cursorFor(context, jobId);
    let spool = null;
    let ws = null;
    activeJobs.add(jobId);
    let slotHeld = false;
    try {
      await slots.acquire();
      slotHeld = true;
      if (closing) throw Object.assign(new Error('closing'), { jobCode: 'PROVIDER_CLOSED', terminal: 'interrupted' });
      await cursor.update({ state: 'running', stage: 'fetch', progress: 0 });

      /* 取素材字节 → 工作区 */
      let read;
      try {
        read = await assets.openRead(context, mediaId);
      } catch (error) {
        throw Object.assign(error, { jobCode: error?.code === 'asset-missing' || error?.status === 404 ? 'TRACK_MEDIA_MISSING' : undefined });
      }
      store.setMediaVersion(jobId, { mediaRev: read.mediaRev, mediaHash: read.assetRef?.hash ?? null });
      if (read.kind !== 'video') {
        read.stream.destroy();
        await read.closed.catch(() => {});
        throw Object.assign(new Error('not-video'), { jobCode: 'TRACK_NOT_VIDEO' });
      }
      if (Number(read.assetRef?.size) > limits.maxVideoBytes) {
        read.stream.destroy();
        await read.closed.catch(() => {});
        throw Object.assign(new Error('too-large'), { jobCode: 'TRACK_TOO_LARGE' });
      }
      ws = await workspace(context);
      spool = `.tmp/track-${jobId}.${/^[a-z0-9]{1,8}$/.test(read.assetRef?.ext ?? '') ? read.assetRef.ext : 'bin'}`;
      const writer = ws.writer(spool);
      try {
        for await (const piece of read.stream) {
          if (closing) throw Object.assign(new Error('closing'), { jobCode: 'PROVIDER_CLOSED', terminal: 'interrupted' });
          writer.write(piece);
        }
        writer.end();
      } catch (error) {
        writer.abort();
        read.stream.destroy();
        if (error?.workspace) throw Object.assign(error, { jobCode: 'TRACK_SPOOL_FAILED' });
        throw error;
      } finally {
        await read.closed.catch(() => {});
      }
      await cursor.update({ stage: 'decode', progress: 0.05 }, { throttle: true });

      /* 跑 Python */
      const abs = ws.resolve(spool);
      const outcome = await runPython(context, ws, [
        'track', '--video', abs, '--points', canonical(points), ...(limits.maxFrames ? ['--max-frames', String(limits.maxFrames)] : []),
      ], {
        timeoutMs: limits.jobTimeoutMs,
        onEvent: (ev) => {
          if (ev.event === 'progress') {
            const percent = ev.phase === 'decoded' ? 0 : Number(ev.percent);
            if (Number.isFinite(percent)) {
              void cursor.update({ stage: 'track', progress: Math.min(0.98, 0.1 + 0.88 * (percent / 100)) }, { throttle: true }).catch(() => {});
            }
          }
        },
      });

      if (outcome.timedOut) throw Object.assign(new Error('timeout'), { jobCode: 'TRACK_TIMEOUT' });
      if (outcome.aborted || closing) {
        throw Object.assign(new Error('cancelled'), { jobCode: closing ? 'PROVIDER_CLOSED' : 'RUN_CANCELLED', terminal: closing ? 'interrupted' : 'cancelled' });
      }
      const result = outcome.events.find((e) => e.event === 'result');
      const failure = outcome.events.find((e) => e.event === 'error');
      if (outcome.code !== 0 || !result) {
        const detail = scrubPaths(failure?.message ?? lastLine(outcome.stderrTail, 500));
        // 没有任何 JSON 事件、栈里是导入失败:不是追踪本身出错,是这台节点缺依赖
        const missingDependency = !failure && /ModuleNotFoundError|ImportError/.test(outcome.stderrTail);
        throw Object.assign(new Error('python-failed'), {
          jobCode: missingDependency ? 'TRACK_ENGINE_UNAVAILABLE' : (PYTHON_ERROR_CODE[failure?.code] ?? 'TRACK_FAILED'),
          detail: detail || `追踪进程异常退出(代码 ${outcome.code})`,
        });
      }
      if (!['bootstapir', 'template'].includes(result.engine) || !Array.isArray(result.points) || !result.points.length) {
        throw Object.assign(new Error('bad-result'), { jobCode: 'TRACK_FAILED', detail: '追踪进程没有给出合法的结果' });
      }

      /* 存结果,再把作业推到 done;推不过去(fence 变了)就把结果删掉,不留迟到的产物 */
      store.setEngine(jobId, result.engine);
      store.saveResult(jobId, { width: result.width, height: result.height, frames: result.frames, points: result.points });
      try {
        await cursor.update({ state: 'done', stage: 'done', progress: 1, outputRefs: [{ kind: 'track', id: jobId }] });
      } catch (error) {
        store.dropResult(jobId);
        throw error;
      }
    } catch (error) {
      const code = error?.jobCode ?? (CANCEL_CODES.has(error?.code) ? 'RUN_CANCELLED' : 'TRACK_FAILED');
      if (error?.detail) { try { store.setDetail(jobId, error.detail); } catch { /* 表已关 */ } }
      const terminal = error?.terminal ?? (code === 'RUN_CANCELLED' ? 'cancelled' : 'error');
      await finishWith(cursor, jobId, { state: terminal, stage: 'done', errorCode: code });
    } finally {
      if (ws && spool) { try { ws.remove(spool); } catch { /* 工作区已清 */ } }
      if (slotHeld) slots.release();
      activeJobs.delete(jobId);
    }
  }

  /* ---- 安装作业 ---- */

  async function runInstallJob(context, jobId) {
    const cursor = cursorFor(context, jobId);
    let proxy = null;
    activeJobs.add(jobId);
    try {
      await cursor.update({ state: 'running', stage: 'install', progress: 0.05 });
      const ws = await workspace(context);
      const tail = [];
      // 模型触发的下载只经出网闸:pip 子进程的代理指向闸起的回环代理,别的网络它出不去
      const env = { ...(install.env ?? {}) };
      if (egress) {
        proxy = await egress.startProxy();
        Object.assign(env, {
          HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, ALL_PROXY: proxy.url,
          http_proxy: proxy.url, https_proxy: proxy.url, all_proxy: proxy.url, NO_PROXY: '', no_proxy: '',
        });
      }
      const outcome = await runPython(context, ws, ['install'], {
        timeoutMs: limits.installTimeoutMs,
        env,
        preamble: python?.requirements ? ['--requirements', python.requirements] : [],
        onEvent: (ev) => {
          if (ev.event === 'log' && typeof ev.line === 'string') {
            tail.push(scrubPaths(ev.line, 200));
            if (tail.length > 20) tail.shift();
            void cursor.update({ progress: Math.min(0.95, 0.05 + tail.length * 0.04) }, { throttle: true }).catch(() => {});
          }
        },
      });
      statusCache = null;
      if (outcome.timedOut) throw Object.assign(new Error('timeout'), { jobCode: 'TRACK_TIMEOUT' });
      if (outcome.aborted || closing) {
        throw Object.assign(new Error('cancelled'), { jobCode: closing ? 'PROVIDER_CLOSED' : 'RUN_CANCELLED', terminal: closing ? 'interrupted' : 'cancelled' });
      }
      const installed = outcome.events.find((e) => e.event === 'installed');
      const failure = outcome.events.find((e) => e.event === 'error');
      if (outcome.code !== 0 || !installed) {
        throw Object.assign(new Error('install-failed'), {
          jobCode: 'TRACK_INSTALL_FAILED',
          detail: scrubPaths([failure?.message, ...tail.slice(-5)].filter(Boolean).join(' | ') || `安装进程异常退出(代码 ${outcome.code})`, 800),
        });
      }
      store.setDetail(jobId, canonical({ needsModel: installed.needsModel === true, ready: installed.ready === true, engine: installed.engine ?? null, tail: tail.slice(-8) }));
      await cursor.update({ state: 'done', stage: 'done', progress: 1 });
    } catch (error) {
      const code = error?.jobCode ?? (CANCEL_CODES.has(error?.code) ? 'RUN_CANCELLED' : 'TRACK_INSTALL_FAILED');
      if (error?.detail) { try { store.setDetail(jobId, error.detail); } catch { /* 表已关 */ } }
      await finishWith(cursor, jobId, { state: error?.terminal ?? (code === 'RUN_CANCELLED' ? 'cancelled' : 'error'), stage: 'done', errorCode: code });
    } finally {
      if (proxy) await proxy.close().catch(() => {});
      installing = null;
      activeJobs.delete(jobId);
    }
  }

  /* ---- 工具 ---- */

  const MODEL_HINTS = {
    bootstapir: '已装拓展,走 BootsTAPIR。',
    template: '没装拓展(或权重不在),走模板匹配兜底 —— 能追,但目标转向、形变或长时间被挡时会跟丢。要更稳的结果得由托管方在节点上装运动追踪拓展(track_install)。',
    none: '两档都用不了(这台节点的 Python 缺 numpy 或 ffmpeg),这里追不了。请告诉用户联系托管方,或在电脑上的 PromptCut 里追。',
  };

  async function trackStatus(context) {
    await contextAccess.authorize(context, 'read');
    const installRun = store.latestRun({ projectId: context.projectId, conversationId: context.conversationId, kind: 'install' });
    const installInfo = installRun ? await installStatusOf(context, installRun) : null;
    const base = { ok: true, installAllowed: install.enabled === true, limits: { maxPoints: limits.maxPoints, maxFrames: limits.maxFrames }, ...(installInfo ? { install: installInfo } : {}) };
    if (!python?.executable) {
      return { ...base, ready: false, engine: null, reason: '这台云节点没有配置运动追踪的 Python 运行环境', hint: MODEL_HINTS.none };
    }
    if (statusCache && Number(now()) - statusCache.at < limits.statusTtlMs) return { ...base, ...statusCache.value };
    const ws = await workspace(context);
    let outcome;
    try {
      outcome = await runPython(context, ws, ['status'], { timeoutMs: limits.statusTimeoutMs });
    } catch (error) {
      if (error instanceof TrackToolError && error.code === 'TRACK_UNCONFIGURED') throw error;
      if (error?.code === 'ENOENT') {
        return { ...base, ready: false, engine: null, reason: '解释器启动失败', hint: MODEL_HINTS.none };
      }
      throw error;
    }
    const info = outcome.events.find((e) => e.event === 'status');
    let value;
    if (!info) {
      const why = scrubPaths(lastLine(outcome.stderrTail), 200);
      value = { ready: false, engine: null, reason: `${outcome.timedOut ? '查状态超时' : '解释器没有返回可解析的状态'}${why ? `:${why}` : ''}`, hint: MODEL_HINTS.none };
    } else {
      value = {
        ready: !!info.ready,
        engine: info.engine ?? null,
        version: info.version,
        // 路径一概不回:模型用不着,也不该知道节点的目录
        runtime: { installed: !!info.runtime?.installed, ...(info.runtime?.version ? { version: String(info.runtime.version) } : {}), ...(info.runtime?.error ? { error: scrubPaths(info.runtime.error, 200) } : {}) },
        model: { exists: !!info.model?.exists, ...(Number.isFinite(info.model?.bytes) ? { bytes: info.model.bytes } : {}) },
        fallback: { available: !!info.fallback?.available, ...(info.fallback?.numpy ? { numpy: String(info.fallback.numpy) } : {}), ...(info.fallback?.error ? { error: scrubPaths(info.fallback.error, 200) } : {}) },
        hint: MODEL_HINTS[info.engine ?? 'none'],
      };
    }
    statusCache = { at: Number(now()), value };
    return { ...base, ...value };
  }

  async function installStatusOf(context, run) {
    let job = null;
    try { job = await jobs.get(context, run.jobId); } catch { /* 读不到就只报登记的 */ }
    let extra = {};
    if (job?.state === 'done' && run.detail) { try { extra = JSON.parse(run.detail); } catch { extra = {}; } }
    return {
      jobId: run.jobId, state: job?.state ?? 'unknown', percent: Math.round((job?.progress ?? 0) * 100),
      ...(job?.errorCode ? { errorCode: job.errorCode, reason: errorMessageOf(job.errorCode), ...(run.detail ? { detail: run.detail.slice(0, 500) } : {}) } : {}),
      ...(extra.needsModel !== undefined ? { needsModel: extra.needsModel } : {}),
    };
  }

  async function trackInstall(context) {
    if (install.enabled !== true) {
      await contextAccess.authorize(context, 'read');
      return {
        ok: false, cloudUnavailable: true, code: 'TRACK_INSTALL_DISABLED', started: false,
        error: '云端的运动追踪拓展由托管方在节点上统一安装,不能由 Agent 安装(模型给不了 pip 参数,下载也不经你)。'
          + '现在已经能用模板匹配兜底追踪;要更稳的 BootsTAPIR,请告诉用户联系托管方。可以用 track_status 看节点上现在是哪一档。',
      };
    }
    if (!python?.executable) throw new TrackToolError('TRACK_UNCONFIGURED', '这台云节点没有配置运动追踪的 Python 运行环境。请告诉用户联系托管方。');
    if (!egress && install.direct !== true) {
      return {
        ok: false, cloudUnavailable: true, code: 'TRACK_INSTALL_NO_EGRESS', started: false,
        error: '这台云节点没有给安装配出网闸,运动追踪拓展不能由 Agent 触发下载。请告诉用户联系托管方在节点上装。',
      };
    }
    if (installing) {
      return { ok: true, started: false, alreadyRunning: true, jobId: installing, hint: '拓展正在安装,不要重复启动;用 track_status 看进度。' };
    }
    const digest = sha256(canonical({ kind: 'track.install', requirements: python.requirements ? 'pinned' : 'bundled' }));
    const started = await jobs.start(context, 'track.install', digest, `trkinst-${digest.slice(0, 40)}`);
    const fresh = store.registerRun({ jobId: started.jobId, kind: 'install', projectId: context.projectId, conversationId: context.conversationId });
    if (!fresh || started.state !== 'queued' || closing) {
      return { ok: true, started: false, jobId: started.jobId, state: started.state, hint: '这一轮已经起过安装,用 track_status 看结果。' };
    }
    installing = started.jobId;
    launch(() => runInstallJob(context, started.jobId));
    return {
      ok: true, started: true, jobId: started.jobId,
      hint: '运动追踪拓展正在后台安装(torch,要几分钟)。用 track_status 看有没有变成 bootstapir;不要重复启动。装完还可能缺权重文件,那由托管方放到节点上。',
    };
  }

  function validatePoints(raw) {
    if (!Array.isArray(raw) || raw.length === 0) throw new TrackToolError('TRACK_BAD_POINTS', 'points 至少要有一个点,写成 [[帧号, x, y], ...]');
    if (raw.length > limits.maxPoints) throw new TrackToolError('TRACK_BAD_POINTS', `一次最多追 ${limits.maxPoints} 个点,收到 ${raw.length} 个。分几次追。`);
    return raw.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        throw new TrackToolError('TRACK_BAD_POINTS', `第 ${i} 个点要写成 [帧号, x, y] 三个有限的数字`);
      }
      if (p[0] < 0 || p[1] < 0 || p[2] < 0) throw new TrackToolError('TRACK_BAD_POINTS', `第 ${i} 个点的帧号和坐标不能是负数(坐标是素材的原始像素)`);
      return [p[0], p[1], p[2]];
    });
  }

  function checkMediaId(value) {
    if (typeof value !== 'string' || !MEDIA_ID_RE.test(value)) throw new TrackToolError('TRACK_BAD_ARGS', 'mediaId 必填(list_media 里拿)');
    return value;
  }

  async function mediaFromProject(context, mediaId) {
    if (typeof readProject !== 'function') return null;
    const project = await readProject(context);
    if (!project) return null;
    const media = (project.media ?? []).find((m) => m?.id === mediaId);
    if (!media) {
      throw new TrackToolError('TRACK_MEDIA_NOT_FOUND', `找不到素材 ${mediaId}。现有素材:${(project.media ?? []).map((m) => m.id).slice(0, 20).join('、') || '(没有)'}`);
    }
    if (media.kind && media.kind !== 'video') throw new TrackToolError('TRACK_NOT_VIDEO', `${media.name ?? mediaId} 不是视频,没有运动可追`);
    return media;
  }

  async function trackPoints(context, args) {
    const mediaId = checkMediaId(args?.mediaId);
    const points = validatePoints(args?.points);
    await contextAccess.authorize(context, 'write');
    await mediaFromProject(context, mediaId);
    if (!python?.executable) throw new TrackToolError('TRACK_UNCONFIGURED', '这台云节点没有配置运动追踪的 Python 运行环境,追不了。请告诉用户联系托管方。');
    if (closing) throw new TrackToolError('TRACK_CLOSED', '服务正在关闭,稍后再试');
    const digest = sha256(canonical({ mediaId, points }));
    const requestId = `trk-${digest.slice(0, 32)}${args?.force === true ? `-${randomUUID().slice(0, 8)}` : ''}`;
    const started = await jobs.start(context, 'track.points', digest, requestId);
    const fresh = store.registerRun({ jobId: started.jobId, kind: 'track', projectId: context.projectId, conversationId: context.conversationId, mediaId, pointCount: points.length });
    if (!fresh) {
      // 同一请求的重试:不开第二个作业。上次进程没了而作业还停在排队的,标成中断,让模型 force 重追
      if (started.state === 'queued' && !activeJobs.has(started.jobId)) {
        const cursor = cursorFor(context, started.jobId);
        await finishWith(cursor, started.jobId, { state: 'interrupted', stage: 'done', errorCode: 'INTERRUPTED_ON_RESTART' });
        return { ok: true, started: false, jobId: started.jobId, state: 'interrupted', mediaId, hint: `${errorMessageOf('INTERRUPTED_ON_RESTART')}要重追就带 force:true 再调一次。` };
      }
      return {
        ok: true, started: false, jobId: started.jobId, state: started.state, mediaId, points: points.length,
        hint: `同样的追踪这一轮已经起过(${started.state}),用 get_track 取结果。要换个结果重追就带 force:true。`,
      };
    }
    launch(() => runTrackJob(context, started.jobId, { mediaId, points }));
    return {
      ok: true, jobId: started.jobId, started: true, mediaId, points: points.length,
      hint: '运动追踪已在后台开始,请用 get_track 轮询该 mediaId',
      engineHint: '哪一档在跑要等结果出来才知道,看 get_track 返回的 engine',
    };
  }

  /** 这个对话里某素材最近一次追踪的读法:`{ run, job, result? }`;没追过回 null */
  /**
   * 本实例名下、还标着排队或进行中,却没有 runner 在跑它(上一代进程没了、或登记完还没来得及起 runner 就崩了)的作业。
   * 作业表只在启动时把 `running` 转成 `interrupted`,`queued` 不会;这里按「读到的视图」把它们当中断,不写作业表。
   */
  function orphaned(job, context) {
    return (job.state === 'queued' || job.state === 'running') && job.instanceId === context.instanceId
      && (job.instanceGeneration < context.instanceGeneration || !activeJobs.has(job.jobId));
  }

  async function lookup(context, mediaId) {
    const run = store.latestRun({ projectId: context.projectId, conversationId: context.conversationId, kind: 'track', mediaId });
    if (!run) return null;
    let job = await jobs.get(context, run.jobId);
    if (orphaned(job, context)) job = { ...job, state: 'interrupted', errorCode: 'INTERRUPTED_ON_RESTART' };
    if (job.state === 'done') {
      const result = store.result(run.jobId);
      if (!result) return { run, job, result: null };
      return { run, job, result };
    }
    return { run, job, result: null };
  }

  function failureOf(job, run) {
    const code = job.errorCode ?? 'TRACK_FAILED';
    const retry = ['INTERRUPTED_ON_RESTART', 'PROVIDER_CLOSED', 'RUN_CANCELLED', 'FENCE_CANCELLED', 'TRACK_TIMEOUT'].includes(code)
      ? '同样的追踪要重来,在 track_points 里带 force:true。' : '';
    return new TrackToolError(code.startsWith('TRACK_') ? code : `TRACK_${job.state.toUpperCase()}`,
      `${errorMessageOf(code)}${run.detail ? `详情:${run.detail}。` : ''}${retry}`, { jobId: job.jobId, state: job.state, errorCode: code });
  }

  /** 项目里这段素材现在的版本和追踪时的对得上吗(没有项目视图就不判) */
  async function staleness(context, run) {
    if (typeof readProject !== 'function') return { checked: false };
    let project;
    try { project = await readProject(context); } catch { return { checked: false }; }
    const media = (project?.media ?? []).find((m) => m?.id === run.mediaId);
    if (!media) return { checked: true, stale: true, reason: '素材已不在项目里' };
    if (run.mediaHash && media.hash && media.hash !== run.mediaHash) return { checked: true, stale: true, reason: '素材换过了,这条轨迹是旧版本画面追的' };
    return { checked: true, stale: false };
  }

  async function getTrack(context, args) {
    const mediaId = checkMediaId(args?.mediaId);
    await contextAccess.authorize(context, 'read');
    const found = await lookup(context, mediaId);
    if (!found) return { ok: true, found: false, mediaId, hint: `${mediaId} 还没追过,先调 track_points` };
    const { run, job, result } = found;
    if (job.state === 'queued' || job.state === 'running') {
      return { ok: true, running: true, jobId: job.jobId, stage: job.stage, percent: Math.round(job.progress * 100), ...(run.engine ? { engine: run.engine } : {}) };
    }
    if (job.state !== 'done') throw failureOf(job, run);
    if (!result) throw new TrackToolError('TRACK_RESULT_MISSING', '追踪作业标成完成了,但结果表里没有它的轨迹。请用 force:true 重追。', { jobId: job.jobId });
    const stale = await staleness(context, run);
    const head = {
      ok: true, running: false, jobId: job.jobId, mediaId,
      engine: run.engine, engineNote: ENGINE_NOTE[run.engine] ?? '',
      width: result.width, height: result.height, frames: result.frames,
      mediaRev: run.mediaRev,
      ...(stale.stale ? { stale: true, staleReason: stale.reason } : {}),
    };
    if (args?.full === true) return { ...head, points: result.points };
    return {
      ...head,
      points: summarizePoints(result.points),
      hint: '只给了摘要。要让卡片跟着某个点走就调 attach_clip_motion(不用把坐标读出来);确实需要逐帧坐标时传 full:true,但那会是很长一串数字。',
    };
  }

  /**
   * 给 `attach_clip_motion` 用:这段素材在这个对话里最近一次追踪完成的完整结果。
   * 读取同样重核 doc 授权(`jobs.get` 的读闸);没追过、没跑完、失败了都抛带 code 的错,不回占位。
   */
  async function readResult(context, { mediaId: mediaIdIn }) {
    const mediaId = checkMediaId(mediaIdIn);
    await contextAccess.authorize(context, 'read');
    const found = await lookup(context, mediaId);
    if (!found) throw new TrackToolError('TRACK_NONE', `${mediaId} 还没追过,先调 track_points`);
    const { run, job, result } = found;
    if (job.state === 'queued' || job.state === 'running') throw new TrackToolError('TRACK_RUNNING', `${mediaId} 的追踪还没跑完,先用 get_track 等它出结果`);
    if (job.state !== 'done') throw failureOf(job, run);
    if (!result) throw new TrackToolError('TRACK_RESULT_MISSING', '追踪作业标成完成了,但结果表里没有它的轨迹。请用 force:true 重追。');
    return { jobId: job.jobId, engine: run.engine, createdAt: run.createdAt, mediaId, mediaRev: run.mediaRev, mediaHash: run.mediaHash, ...result };
  }

  const TOOLS = { track_status: trackStatus, track_install: trackInstall, track_points: trackPoints, get_track: getTrack };

  return {
    handles: new Set(TRACK_TOOL_NAMES),
    /** @param {string} name @param {object} args @param {object} context F0 的可信 `ToolRunContext` */
    async call(name, args, context) {
      if (!Object.hasOwn(TOOLS, name)) throw new TrackToolError('TRACK_UNKNOWN_TOOL', `track 提供者不处理 ${name}`);
      if (closing) throw new TrackToolError('TRACK_CLOSED', '服务正在关闭,稍后再试');
      return TOOLS[name](context, isPlain(args) ? args : {});
    },
    readResult,
    results: store,
    /**
     * 关停:杀掉本提供者持有的子进程,等每个 close 事件和每个作业收尾。
     * 回的 `childrenClosed` 只在每个子进程都真的 close 之后才是 true。
     */
    async close(reason = 'close') {
      if (closeReceipt) return closeReceipt;
      closing = true;
      closeReceipt = (async () => {
        for (const child of [...children]) { try { child.kill(); } catch { /* 已经退了 */ } } // 每个都是杀整棵树
        await Promise.allSettled([...runners]);
        const receipt = { childrenClosed: children.size === 0, streamsClosed: true, workPending: runners.size, reason };
        if (ownsStore) store.close();
        return receipt;
      })();
      return closeReceipt;
    },
  };
}
