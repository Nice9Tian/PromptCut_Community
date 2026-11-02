/**
 * Cloud Agent motion tracking suite of four: `track_status`, `track_install`, `track_points`,
 * `get_track` (row P3 in breakdown table; `docs/plan/cloud-agent-tools-implementation.md`).
 * `attach_clip_motion` is in `../hosted-motion.mjs`.
 *
 * Differences from the desktop app (`server/vite-plugin-track.ts`) all stem from a few hard rules
 * of "account cloud":
 *
 *   - Asset bytes go through project asset service (F0 `ProjectAssets.openRead`), landing in this
 *     chat workspace first before passing to Python; does not accept local paths or addresses.
 *   - Job status is written to F0 persistent jobs table (`ToolJobs`, SQLite): each advancement
 *     re-verifies doc current authorization and fence; after service restarts, `running` becomes
 *     `interrupted`, rather than vanishing into 404 via an in-memory Map.
 *   - Tracking results persist in this module's own table, keyed by "project × chat × asset ×
 *     asset version", not a global `mediaId` Map; only jobs marked `done` in the jobs table have
 *     readable results (if job advancement fails after writing results, results are deleted too).
 *   - Python child processes are spawned only via workspace restricted `spawn()` (env var
 *     allowlist, no popups, spawned as a killable process tree), then registered into F0
 *     run-resources table: when fence changes (private, stopped, Agent closed, kicked...), the
 *     resource table kills the entire tree (including ffmpeg spawned by Python), and `close()`
 *     waits for close event before considering it cleanly finalized. Killing tree, waiting for
 *     cleanup, and registration use shared implementation `runner.mjs`.
 *   - Python is launched in isolated mode (`-I`, `isolatedPythonArgs` in `runner.mjs`): working
 *     directory is the chat workspace, prevented from entering module search path; package
 *     directory comes solely from deployment config (`python.packageRoot`), passed in via
 *     bootstrap code.
 *   - Cloud `track_install` only runs dependency manifests bundled with package (or pinned by
 *     deployer); model cannot pass any pip or shell arguments; returns a clear reason when
 *     deployer has not enabled installation (extensions on nodes are installed uniformly by host).
 *
 * Tracking has two tiers, selected by Python side via `status`: torch installed with weights
 * present → BootsTAPIR; otherwise numpy template matching fallback.
 * `engine` in results is the tier actually run, not guessed when starting the job.
 *
 * This file only calls F0 (`tool-context`, `tool-jobs`, `project-assets`, `run-resources`) and
 * does not modify them; does not import `src/`, does not touch rendering.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolatedPythonArgs, splitRoots, superviseChild } from './runner.mjs';

export const TRACK_TOOL_NAMES = Object.freeze(['track_status', 'track_install', 'track_points', 'get_track']);

export const TRACK_DEFAULTS = Object.freeze({
  /** Maximum number of points to track at once */
  maxPoints: 32,
  /**
   * Rejects if video exceeds this many frames (do not truncate: trajectory must cover entire asset
   * so `attach_clip_motion` can match timing).
   * Template matching decodes entire video into grayscale in memory (~0.3 MB per frame for 720 long
   * edge), 1800 frames is ~0.5 GB; tuned by deployer according to node memory.
   */
  maxFrames: 1800,
  /** Upper limit on fetched asset bytes */
  maxVideoBytes: 1024 * 1024 * 1024,
  /** Concurrently running tracking jobs (remainder queue up with job status queued) */
  maxConcurrentJobs: 2,
  /** Time limit for a single tracking run */
  jobTimeoutMs: 10 * 60_000,
  /** Timeout for single installation */
  installTimeoutMs: 30 * 60_000,
  /** Time limit for `track_status` to launch Python */
  statusTimeoutMs: 60_000,
  /** Cache duration for `track_status` results (cleared after installing extensions) */
  statusTtlMs: 10_000,
  /** Minimum interval for writing progress into jobs table */
  progressIntervalMs: 500,
});

export class TrackToolError extends Error {
  /** @param {string} code Stable machine-readable code (`TRACK_*`); message is Chinese for model */
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

/** Error messages omit server paths: drive-letter paths and `/a/b`-style paths are stripped */
export function scrubPaths(text, max = 400) {
  return String(text ?? '')
    .replace(/[A-Za-z]:[\\/][^\s'"<>|]*/g, '<path>')
    .replace(/(?:^|[\s(=:])\/(?:[^\s'"<>|/]+\/)+[^\s'"<>|/]*/g, (m) => `${m[0] === '/' ? '' : m[0]}<path>`)
    .slice(0, max);
}

/* ---------------------------------------------------------------- Results table */

/**
 * Persistent table for tracking jobs and results (SQLite, WAL + FULL). Separate file from
 * `ToolJobs` jobs table: jobs table only holds status; here it stores "which version of which
 * asset the job corresponds to" and trajectory itself. Reads always include both `projectId` and
 * `conversationId` scopes.
 */
export function createTrackResultStore({ databasePath, now = Date.now } = {}) {
  if (typeof databasePath !== 'string' || !databasePath.trim() || databasePath === ':memory:') {
    throw new TrackToolError('TRACK_UNCONFIGURED', 'The tracking result table needs a disk path');
  }
  const file = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  const db = new DatabaseSync(file);
  if (!existed && process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* Directory is already 0700 */ }
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
  const live = () => { if (closed) throw new TrackToolError('TRACK_CLOSED', 'The tracking result table is closed'); return db; };
  const decodeRun = (row) => (row ? {
    jobId: row.job_id, kind: row.kind, projectId: row.project_id, conversationId: row.conversation_id,
    mediaId: row.media_id, mediaRev: row.media_rev, mediaHash: row.media_hash, pointCount: row.point_count,
    engine: row.engine, detail: row.detail, createdAt: row.created_at,
  } : null);
  return Object.freeze({
    /** Registers which asset a job maps to; returns false if already registered (idempotent retry) */
    registerRun({ jobId, kind, projectId, conversationId, mediaId = '', mediaRev = null, mediaHash = null, pointCount = 0 }) {
      const d = live();
      const seq = (d.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM track_runs').get()).n;
      const info = d.prepare(`INSERT OR IGNORE INTO track_runs
        (job_id, kind, project_id, conversation_id, media_id, media_rev, media_hash, point_count, created_at, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(jobId, kind, projectId, conversationId, mediaId, mediaRev, mediaHash, pointCount, Number(now()), seq);
      return Number(info.changes) === 1;
    },
    /** Supplements its current version after fetching asset */
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
    /** Most recent in this chat (tracking / install for an asset) */
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

/* ---------------------------------------------------------------- Utilities */

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

/** Useful line at end of stderr (last line of Python stack trace is the exception itself) */
function lastLine(text, max = 300) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.at(-1) ?? '').slice(-max);
}

/**
 * Tracking summary returned as-is to model in chat (same shape as desktop app: visible frames,
 * displacement range, start/end coordinates per point)
 */
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
  bootstapir: 'BootsTAPIR, arbitrary point tracking; visible being false means the point is occluded or out of frame in that frame',
  template: 'Currently using the template matching fallback (the cloud node has no motion tracking extension installed, or the weights are missing). Rigid targets with clear texture that do not turn can be tracked very accurately,'
    + 'but once the target turns, scales or is occluded for a long time, tracking is lost; a point with a note field means it could not be tracked at all',
};

/** Python error.code → stable error code in jobs table */
const PYTHON_ERROR_CODE = {
  'too-long': 'TRACK_TOO_LONG',
  'engine-unavailable': 'TRACK_ENGINE_UNAVAILABLE',
  'ffmpeg-missing': 'TRACK_ENGINE_UNAVAILABLE',
  'bad-points': 'TRACK_BAD_POINTS',
  'video-missing': 'TRACK_FAILED',
};

/**
 * These error codes indicate task authorization or fence changed: job recorded as
 * "cancelled with task", not treated as tracking failure itself
 */
const CANCEL_CODES = new Set(['run-resource-fenced', 'run-resource-unauthorized', 'forbidden', 'fence-rejected', 'fence-changed', 'job-scope-mismatch']);

/**
 * Job error code → message for model. Exported for background job status
 * (`errorTexts` in `hosted-workflow.mjs`), both use identical phrasing
 */
export const TRACK_ERROR_TEXT = Object.freeze({
  TRACK_TIMEOUT: 'This tracking run exceeded the time limit and was stopped. Reduce the number of points or trim the media shorter, then track again.',
  TRACK_TOO_LONG: 'The media is too long and exceeds the number of frames this node can track at once. Trim the media shorter first, then track.',
  TRACK_ENGINE_UNAVAILABLE: 'The Python runtime used for tracking on this node is unavailable (numpy or ffmpeg is missing). Tell the user to contact the host.',
  TRACK_NOT_VIDEO: 'This media is not a video, so there is no motion to track.',
  TRACK_MEDIA_MISSING: 'Cannot fetch the media bytes (the asset service does not have this media, or the upload has not finished). Try again later or re-import it.',
  TRACK_BAD_POINTS: 'Invalid tracking points.',
  TRACK_FAILED: 'The tracking process failed.',
  TRACK_SPOOL_FAILED: 'The media does not fit in this chat\'s working directory (over the space limit).',
  TRACK_TOO_LARGE: 'The media file is too large; this node will not track it.',
  INTERRUPTED_ON_RESTART: 'The service restarted and the previous tracking run was interrupted.',
  PROVIDER_CLOSED: 'The service is shutting down and this tracking run was stopped.',
  RUN_CANCELLED: 'This tracking run was cancelled along with the task.',
  FENCE_CANCELLED: 'This tracking run was cancelled along with the task.',
  TRACK_INSTALL_FAILED: 'Extension install failed.',
});
const JOB_ERROR_MESSAGE = TRACK_ERROR_TEXT;

const errorMessageOf = (code) => JOB_ERROR_MESSAGE[code] ?? `Tracking failed (${code}).`;

/* ---------------------------------------------------------------- Provider */

/**
 * @param {object} d
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<object> }} d.contextAccess F0 `tool-context`
 * @param {{ register(context: object, o: { kind: string, resource: object }): Promise<{ signal: AbortSignal, closed: Promise<void> }> }} d.resources F0 `run-resources`
 * @param {object} d.jobs F0 `tool-jobs`
 * @param {{ openRead(context: object, mediaId: string, o?: object): Promise<{ stream: import('node:stream').Readable, assetRef: object, mediaRev: string, kind: string, closed: Promise<void> }> }} d.assets F0 `project-assets`
 * @param {(context: object) => Promise<object>} d.workspace Workspace for this chat (`open()` in
 *   `workspace.mjs`)
 * @param {string} [d.databasePath] Disk path for results table (mutually exclusive with `results`)
 * @param {ReturnType<typeof createTrackResultStore>} [d.results] Existing results table (held by
 *   caller, closed by caller too)
 * @param {{ executable: string, packageRoot: string, pylibs?: string, models?: string, ffmpeg?: string, requirements?: string } | null} d.python
 *   Python runtime configured by deployer; `packageRoot` is directory containing `promptcut_*`
 *   packages. null = not configured on this node
 * @param {(context: object) => Promise<{ media: Array<{ id: string, kind?: string, hash?: string }> } | null>} [d.readProject]
 *   Read-only view of project replica; provided to verify upfront that "asset exists, is video"
 *   and determine if trajectory is expired
 * @param {{ enabled?: boolean, direct?: boolean, env?: Record<string, string> }} [d.install]
 *   Deployer must enable to install; without `egress`, requires `direct: true` (deployer declared
 *   node level already controls process egress) to install
 * @param {{ startProxy(): Promise<{ url: string, close(): Promise<void> }> } | null} [d.egress]
 *   Egress gate (`egress.mjs`): during installation pip connects only via loopback proxy it starts
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
    if (!dep || methods.some((m) => typeof dep[m] !== 'function')) throw new TrackToolError('TRACK_UNCONFIGURED', `createTrackTools is missing ${name}`);
  }
  if (typeof workspace !== 'function') throw new TrackToolError('TRACK_UNCONFIGURED', 'createTrackTools is missing workspace');
  const limits = { ...TRACK_DEFAULTS, ...limitsIn };
  const store = resultsIn ?? createTrackResultStore({ databasePath, now });
  const ownsStore = resultsIn === null;

  const slots = createSlots(limits.maxConcurrentJobs);
  const runners = new Set();        // Jobs still running (including queued ones)
  const children = new Set();       // Child processes not yet closed (`{ kill }`, kills entire tree)
  const activeJobs = new Set();     // jobIds with runners in this process
  let installing = null;            // jobId currently installing in this process (process-level singleton)
  let closing = false;
  let closeReceipt = null;
  let statusCache = null;

  /* ---- Spawn Python ---- */

  const pythonFlags = () => {
    const flags = [];
    if (python?.pylibs) flags.push('--pylibs', python.pylibs);
    if (python?.models) flags.push('--models', python.models);
    if (python?.ffmpeg) flags.push('--ffmpeg', python.ffmpeg);
    return flags;
  };

  /**
   * Spawns `promptcut_track …` (isolated mode) via workspace restricted spawn, registers into
   * run-resources table, and parses stdout JSON events line by line.
   * Returns `{ code, signal, timedOut, aborted, events, stderrTail }`; returns only after child
   * process exit + close.
   */
  async function runPython(context, ws, args, { timeoutMs, onEvent = () => {}, env = {}, preamble = [] } = {}) {
    if (!python?.executable) throw new TrackToolError('TRACK_UNCONFIGURED', 'This cloud node has no Python runtime configured for motion tracking. Tell the user to contact the host.');
    if (closing) throw new TrackToolError('TRACK_CLOSED', 'Service is shutting down');
    // PYTHON* env vars take no effect in isolated mode (package dir and UTF-8 passed via CLI),
    // not set here
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
            try { onEvent(ev); } catch { /* Callback errors do not affect process cleanup */ }
          }
        },
        onStderr: (chunk) => { state.stderrTail = (state.stderrTail + chunk.toString('utf8')).slice(-2000); },
      });
    } catch (error) {
      // Registration rejected: superviseChild already killed entire tree and waited for clean exit
      children.delete(entry);
      throw error;
    }
    const end = await run.done;
    children.delete(entry);
    if (end.spawnError) {
      // Failed to even launch (interpreter path incorrect): no process to register
      throw Object.assign(new Error('python-spawn-failed'), { code: end.spawnError?.code ?? 'SPAWN_FAILED', jobCode: 'TRACK_ENGINE_UNAVAILABLE', detail: 'The Python interpreter failed to start' });
    }
    return { code: end.code, signal: end.signal, timedOut: end.timedOut, aborted: end.aborted, events: state.events, stderrTail: state.stderrTail };
  }

  /* ---- Job status advancement ---- */

  /**
   * Cursor for job revision number. All advancements queue in a single line (progress events and
   * terminal state cannot race for the same revision number); when `update` encounters a legitimate
   * active→retained transition, retry via controlled checkpoint provided by F0.
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

  /* ---- Tracking job ---- */

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

      /* Fetch asset bytes → workspace */
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

      /* Run Python */
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
        // No JSON events at all and stack trace shows import failure: not tracking error itself, this node
        // is missing dependencies
        const missingDependency = !failure && /ModuleNotFoundError|ImportError/.test(outcome.stderrTail);
        throw Object.assign(new Error('python-failed'), {
          jobCode: missingDependency ? 'TRACK_ENGINE_UNAVAILABLE' : (PYTHON_ERROR_CODE[failure?.code] ?? 'TRACK_FAILED'),
          detail: detail || `The tracking process exited abnormally (code ${outcome.code})`,
        });
      }
      if (!['bootstapir', 'template'].includes(result.engine) || !Array.isArray(result.points) || !result.points.length) {
        throw Object.assign(new Error('bad-result'), { jobCode: 'TRACK_FAILED', detail: 'The tracking process did not return a valid result' });
      }

      /* Save results, advance job to done; if update fails (fence changed), delete results, leaving no late artifacts */
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
      if (error?.detail) { try { store.setDetail(jobId, error.detail); } catch { /* Table already closed */ } }
      const terminal = error?.terminal ?? (code === 'RUN_CANCELLED' ? 'cancelled' : 'error');
      await finishWith(cursor, jobId, { state: terminal, stage: 'done', errorCode: code });
    } finally {
      if (ws && spool) { try { ws.remove(spool); } catch { /* Workspace already cleared */ } }
      if (slotHeld) slots.release();
      activeJobs.delete(jobId);
    }
  }

  /* ---- Installation job ---- */

  async function runInstallJob(context, jobId) {
    const cursor = cursorFor(context, jobId);
    let proxy = null;
    activeJobs.add(jobId);
    try {
      await cursor.update({ state: 'running', stage: 'install', progress: 0.05 });
      const ws = await workspace(context);
      const tail = [];
      // Downloads triggered by model only go through egress gate: pip child process proxy points to
      // loopback proxy started by gate; cannot access any other network
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
          detail: scrubPaths([failure?.message, ...tail.slice(-5)].filter(Boolean).join(' | ') || `Install process exited abnormally (code ${outcome.code})`, 800),
        });
      }
      store.setDetail(jobId, canonical({ needsModel: installed.needsModel === true, ready: installed.ready === true, engine: installed.engine ?? null, tail: tail.slice(-8) }));
      await cursor.update({ state: 'done', stage: 'done', progress: 1 });
    } catch (error) {
      const code = error?.jobCode ?? (CANCEL_CODES.has(error?.code) ? 'RUN_CANCELLED' : 'TRACK_INSTALL_FAILED');
      if (error?.detail) { try { store.setDetail(jobId, error.detail); } catch { /* Table already closed */ } }
      await finishWith(cursor, jobId, { state: error?.terminal ?? (code === 'RUN_CANCELLED' ? 'cancelled' : 'error'), stage: 'done', errorCode: code });
    } finally {
      if (proxy) await proxy.close().catch(() => {});
      installing = null;
      activeJobs.delete(jobId);
    }
  }

  /* ---- Tools ---- */

  const MODEL_HINTS = {
    bootstapir: 'Extension installed, using BootsTAPIR.',
    template: 'Extension not installed (or weights missing), falling back to template matching. It can track, but loses the target when it turns, deforms or is occluded for a long time. For more stable results, the host must install the motion tracking extension on the node (track_install).',
    none: 'Neither tier is usable (this node\'s Python lacks numpy or ffmpeg), so tracking is not possible here. Tell the user to contact the host, or to track in PromptCut on their computer.',
  };

  async function trackStatus(context) {
    await contextAccess.authorize(context, 'read');
    const installRun = store.latestRun({ projectId: context.projectId, conversationId: context.conversationId, kind: 'install' });
    const installInfo = installRun ? await installStatusOf(context, installRun) : null;
    const base = { ok: true, installAllowed: install.enabled === true, limits: { maxPoints: limits.maxPoints, maxFrames: limits.maxFrames }, ...(installInfo ? { install: installInfo } : {}) };
    if (!python?.executable) {
      return { ...base, ready: false, engine: null, reason: 'This cloud node has no Python environment configured for motion tracking', hint: MODEL_HINTS.none };
    }
    if (statusCache && Number(now()) - statusCache.at < limits.statusTtlMs) return { ...base, ...statusCache.value };
    const ws = await workspace(context);
    let outcome;
    try {
      outcome = await runPython(context, ws, ['status'], { timeoutMs: limits.statusTimeoutMs });
    } catch (error) {
      if (error instanceof TrackToolError && error.code === 'TRACK_UNCONFIGURED') throw error;
      if (error?.code === 'ENOENT') {
        return { ...base, ready: false, engine: null, reason: 'Interpreter failed to start', hint: MODEL_HINTS.none };
      }
      throw error;
    }
    const info = outcome.events.find((e) => e.event === 'status');
    let value;
    if (!info) {
      const why = scrubPaths(lastLine(outcome.stderrTail), 200);
      value = { ready: false, engine: null, reason: `${outcome.timedOut ? 'Status check timed out' : 'The interpreter returned no parseable status'}${why ? `:${why}` : ''}`, hint: MODEL_HINTS.none };
    } else {
      value = {
        ready: !!info.ready,
        engine: info.engine ?? null,
        version: info.version,
        // Never return paths: model does not need them and should not know node directories
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
    try { job = await jobs.get(context, run.jobId); } catch { /* If unreadable, only report what was registered */ }
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
        error: 'The cloud motion tracking extension is installed centrally on the node by the host and cannot be installed by the Agent (the model cannot supply pip arguments, and downloads do not go through you).'
          + ' Fallback tracking with template matching already works; for the more stable BootsTAPIR, tell the user to contact the host. Use track_status to see which tier the node is on now.',
      };
    }
    if (!python?.executable) throw new TrackToolError('TRACK_UNCONFIGURED', 'This cloud node has no Python runtime configured for motion tracking. Tell the user to contact the host.');
    if (!egress && install.direct !== true) {
      return {
        ok: false, cloudUnavailable: true, code: 'TRACK_INSTALL_NO_EGRESS', started: false,
        error: 'This cloud node has no network gate configured for installs, so the Agent cannot trigger the motion tracking extension download. Tell the user to contact the host to install it on the node.',
      };
    }
    if (installing) {
      return { ok: true, started: false, alreadyRunning: true, jobId: installing, hint: 'The extension is being installed, do not start it again; use track_status to check progress.' };
    }
    const digest = sha256(canonical({ kind: 'track.install', requirements: python.requirements ? 'pinned' : 'bundled' }));
    const started = await jobs.start(context, 'track.install', digest, `trkinst-${digest.slice(0, 40)}`);
    const fresh = store.registerRun({ jobId: started.jobId, kind: 'install', projectId: context.projectId, conversationId: context.conversationId });
    if (!fresh || started.state !== 'queued' || closing) {
      return { ok: true, started: false, jobId: started.jobId, state: started.state, hint: 'An install was already started this round, use track_status to see the result.' };
    }
    installing = started.jobId;
    launch(() => runInstallJob(context, started.jobId));
    return {
      ok: true, started: true, jobId: started.jobId,
      hint: 'The motion tracking extension is being installed in the background (torch, takes a few minutes). Use track_status to see whether it has become bootstapir; do not start it again. After installing, weight files may still be missing; the host puts those on the node.',
    };
  }

  function validatePoints(raw) {
    if (!Array.isArray(raw) || raw.length === 0) throw new TrackToolError('TRACK_BAD_POINTS', 'points needs at least one point, written as [[frameNumber, x, y], ...]');
    if (raw.length > limits.maxPoints) throw new TrackToolError('TRACK_BAD_POINTS', `At most ${limits.maxPoints} points can be tracked at a time, received ${raw.length}. Track them in several batches.`);
    return raw.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        throw new TrackToolError('TRACK_BAD_POINTS', `Point ${i} must be written as [frameNumber, x, y], three finite numbers`);
      }
      if (p[0] < 0 || p[1] < 0 || p[2] < 0) throw new TrackToolError('TRACK_BAD_POINTS', `The frame number and coordinates of point ${i} cannot be negative (coordinates are original pixels of the media)`);
      return [p[0], p[1], p[2]];
    });
  }

  function checkMediaId(value) {
    if (typeof value !== 'string' || !MEDIA_ID_RE.test(value)) throw new TrackToolError('TRACK_BAD_ARGS', 'mediaId is required (get it from list_media)');
    return value;
  }

  async function mediaFromProject(context, mediaId) {
    if (typeof readProject !== 'function') return null;
    const project = await readProject(context);
    if (!project) return null;
    const media = (project.media ?? []).find((m) => m?.id === mediaId);
    if (!media) {
      throw new TrackToolError('TRACK_MEDIA_NOT_FOUND', `Media ${mediaId} not found. Existing media: ${(project.media ?? []).map((m) => m.id).slice(0, 20).join(', ') || '(none)'}`);
    }
    if (media.kind && media.kind !== 'video') throw new TrackToolError('TRACK_NOT_VIDEO', `${media.name ?? mediaId} is not a video, there is no motion to track`);
    return media;
  }

  async function trackPoints(context, args) {
    const mediaId = checkMediaId(args?.mediaId);
    const points = validatePoints(args?.points);
    await contextAccess.authorize(context, 'write');
    await mediaFromProject(context, mediaId);
    if (!python?.executable) throw new TrackToolError('TRACK_UNCONFIGURED', 'This cloud node has no Python environment configured for motion tracking, so tracking is not possible. Tell the user to contact the host.');
    if (closing) throw new TrackToolError('TRACK_CLOSED', 'Service is shutting down, try again later');
    const digest = sha256(canonical({ mediaId, points }));
    const requestId = `trk-${digest.slice(0, 32)}${args?.force === true ? `-${randomUUID().slice(0, 8)}` : ''}`;
    const started = await jobs.start(context, 'track.points', digest, requestId);
    const fresh = store.registerRun({ jobId: started.jobId, kind: 'track', projectId: context.projectId, conversationId: context.conversationId, mediaId, pointCount: points.length });
    if (!fresh) {
      // Retrying the same request: do not start second job. If previous process is gone while job remains
      // queued, mark as interrupted so model can force re-track
      if (started.state === 'queued' && !activeJobs.has(started.jobId)) {
        const cursor = cursorFor(context, started.jobId);
        await finishWith(cursor, started.jobId, { state: 'interrupted', stage: 'done', errorCode: 'INTERRUPTED_ON_RESTART' });
        return { ok: true, started: false, jobId: started.jobId, state: 'interrupted', mediaId, hint: `${errorMessageOf('INTERRUPTED_ON_RESTART')} To re-track, call again with force:true.` };
      }
      return {
        ok: true, started: false, jobId: started.jobId, state: started.state, mediaId, points: points.length,
        hint: `The same tracking was already started this round (${started.state}), use get_track to fetch the result. To re-track for a different result, pass force:true.`,
      };
    }
    launch(() => runTrackJob(context, started.jobId, { mediaId, points }));
    return {
      ok: true, jobId: started.jobId, started: true, mediaId, points: points.length,
      hint: 'Motion tracking has started in the background, poll this mediaId with get_track',
      engineHint: 'Which tier is running is only known once the result is out, see engine returned by get_track',
    };
  }

  /** Read method for most recent track of an asset in chat: `{ run, job, result? }`; returns null if never tracked */
  /**
   * Jobs under this instance still marked queued or running, but with no runner executing them
   * (previous-generation process gone, or crashed after registration before starting runner).
   * Jobs table only converts `running` to `interrupted` at startup, not `queued`; here they are
   * treated as interrupted according to "read view", without writing to jobs table.
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
      ? 'To redo the same tracking, pass force:true in track_points.' : '';
    return new TrackToolError(code.startsWith('TRACK_') ? code : `TRACK_${job.state.toUpperCase()}`,
      `${errorMessageOf(code)}${run.detail ? `Details: ${run.detail}.` : ''}${retry}`, { jobId: job.jobId, state: job.state, errorCode: code });
  }

  /** Does current version of this asset in project match tracking time (not evaluated if no project view) */
  async function staleness(context, run) {
    if (typeof readProject !== 'function') return { checked: false };
    let project;
    try { project = await readProject(context); } catch { return { checked: false }; }
    const media = (project?.media ?? []).find((m) => m?.id === run.mediaId);
    if (!media) return { checked: true, stale: true, reason: 'The media is no longer in the project' };
    if (run.mediaHash && media.hash && media.hash !== run.mediaHash) return { checked: true, stale: true, reason: 'The media was replaced, this track was tracked on an older version of the footage' };
    return { checked: true, stale: false };
  }

  async function getTrack(context, args) {
    const mediaId = checkMediaId(args?.mediaId);
    await contextAccess.authorize(context, 'read');
    const found = await lookup(context, mediaId);
    if (!found) return { ok: true, found: false, mediaId, hint: `${mediaId} has not been tracked yet, call track_points first` };
    const { run, job, result } = found;
    if (job.state === 'queued' || job.state === 'running') {
      return { ok: true, running: true, jobId: job.jobId, stage: job.stage, percent: Math.round(job.progress * 100), ...(run.engine ? { engine: run.engine } : {}) };
    }
    if (job.state !== 'done') throw failureOf(job, run);
    if (!result) throw new TrackToolError('TRACK_RESULT_MISSING', 'The tracking job was marked complete, but the result table has no track for it. Re-track with force:true.', { jobId: job.jobId });
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
      hint: 'Only a summary was returned. To make a card follow a point, call attach_clip_motion (no need to read out the coordinates); if you really need per-frame coordinates, pass full:true, but that will be a very long list of numbers.',
    };
  }

  /**
   * For `attach_clip_motion`: the full result of the most recent completed tracking run for this
   * asset in this chat.
   * Reads also re-verify doc authorization (`jobs.get` read gate); throws an error with code if
   * never tracked, not finished running, or failed, returning no placeholder.
   */
  async function readResult(context, { mediaId: mediaIdIn }) {
    const mediaId = checkMediaId(mediaIdIn);
    await contextAccess.authorize(context, 'read');
    const found = await lookup(context, mediaId);
    if (!found) throw new TrackToolError('TRACK_NONE', `${mediaId} has not been tracked yet, call track_points first`);
    const { run, job, result } = found;
    if (job.state === 'queued' || job.state === 'running') throw new TrackToolError('TRACK_RUNNING', `Tracking for ${mediaId} has not finished, use get_track to wait for its result first`);
    if (job.state !== 'done') throw failureOf(job, run);
    if (!result) throw new TrackToolError('TRACK_RESULT_MISSING', 'The tracking job was marked complete, but the result table has no track for it. Re-track with force:true.');
    return { jobId: job.jobId, engine: run.engine, createdAt: run.createdAt, mediaId, mediaRev: run.mediaRev, mediaHash: run.mediaHash, ...result };
  }

  const TOOLS = { track_status: trackStatus, track_install: trackInstall, track_points: trackPoints, get_track: getTrack };

  return {
    handles: new Set(TRACK_TOOL_NAMES),
    /** @param {string} name @param {object} args @param {object} context F0 trusted `ToolRunContext` */
    async call(name, args, context) {
      if (!Object.hasOwn(TOOLS, name)) throw new TrackToolError('TRACK_UNKNOWN_TOOL', `The track provider does not handle ${name}`);
      if (closing) throw new TrackToolError('TRACK_CLOSED', 'Service is shutting down, try again later');
      return TOOLS[name](context, isPlain(args) ? args : {});
    },
    readResult,
    results: store,
    /**
     * Shutdown: kill child processes held by this provider, and wait for each close event and each job
     * to finalize.
     * The returned `childrenClosed` is true only after every child process has actually closed.
     */
    async close(reason = 'close') {
      if (closeReceipt) return closeReceipt;
      closing = true;
      closeReceipt = (async () => {
        for (const child of [...children]) { try { child.kill(); } catch { /* Already exited */ } } // Each kills the entire tree
        await Promise.allSettled([...runners]);
        const receipt = { childrenClosed: children.size === 0, streamsClosed: true, workPending: runners.size, reason };
        if (ownsStore) store.close();
        return receipt;
      })();
      return closeReceipt;
    },
  };
}
