/**
 * Shot detection for Cloud Agent (`detect_shots`, `list_shots`; the half of P1 in the breakdown
 * table `docs/plan/cloud-agent-tools-implementation.md` without asset collage).
 *
 * In desktop app, these two tools hit editor process's `/api/shots/*`
 * (`server/vite-plugin-shots.ts`), jobs are kept in RAM, and results are written back to project
 * by page. Cloud nodes have no editor process; here, following the same approach, ffmpeg and (when
 * dependencies and weights exist) the same Python package (`promptcut_shots`, spawned in isolated
 * mode) are spawned, following these rules:
 *
 *   - **Two tiers, labeled truthfully**: TransNetV2 is used only when dependencies and weights
 *     (`onnxruntime` + `transnetv2.onnx`) are present (recognizes both hard cuts and crossfades,
 *     providing spans for crossfades); if Python is not configured, dependencies/weights are
 *     incomplete, or asset is too long, use ffmpeg's `scdet` filter (recognizes only hard cuts,
 *     cannot recognize crossfades). Which tier was used is recorded in `engine`, and `scdet` tier
 *     includes an explanation of why the model was not used. When model tier fails midway (Python
 *     crashes, returned result format is invalid), fall back to `scdet` and rerun, recording
 *     `fellBackFrom: 'transnetv2'` and reason in job index; `list_shots` will report this, without
 *     falsely claiming model detection. If even ffmpeg is missing, truthfully return "unavailable"
 *     instead of starting a doomed job; when shot detection fails completely, point to see_frames
 *     in error to inspect actual frames and choose cut points manually;
 *   - **Context comes only from F0**: `context` passed to each call contains trusted eight fields
 *     emitted by `tool-context.mjs`; before reading assets, spawning processes, or writing
 *     projects, always re-verify doc's current grant / fence using `run-resources.mjs`'s
 *     `authorize` (`detect_shots` requires write, `list_shots` requires read), never trusting any
 *     project or path in tool arguments;
 *   - **Assets fetched only via `project-assets.mjs`'s `openRead`** (with hash verification) into
 *     this chat's workspace directory (`shots/<jobId>/`), deleted after run; ffprobe / ffmpeg /
 *     Python read only this local file, with `-protocol_whitelist file` prepended to inputs
 *     (playlists disguised as media cannot connect to network);
 *   - **Child processes spawned only via workspace restricted child processes**
 *     (`workspace.mjs`'s `spawn`: environment variable allowlist, no popups, spawned as a
 *     killable process tree), and registered with `run-resources.mjs` (kind `child`): when this
 *     round is stopped, made private, Agent shut down, or service shut down, process tree is
 *     actually killed, counting as closed only after both `exit` and `close` arrive (killing tree,
 *     waiting for cleanup, and registration use common implementation `runner.mjs`). ffmpeg
 *     spawned by Python frame extraction is a grandchild process and killed together;
 *   - **Python spawned in isolated mode** (`-I`, `runner.mjs`'s `isolatedPythonArgs`): Chat
 *     workspace contains files brought in by members and model; do not allow them into module
 *     search paths;
 *   - **Jobs recorded in `tool-jobs.mjs`'s persistent ledger** (`shots.detect`): `running` becomes
 *     `interrupted` after service restart, not "not found"; ledger stores only status and progress;
 *     Chinese failure reasons, tier used, etc. are placed in `shots/jobs.json` in chat workspace;
 *   - **Results written to current version of project asset**: `project.setMediaShots` passes
 *     `mediaRev` from byte retrieval as expected version; if asset was replaced midway, discard
 *     this result without writing; re-verify write permission before writing (read-only members are
 *     rejected before starting job);
 *   - **`list_shots` answers directly** (no longer borrows desktop app handler): clearly states
 *     whether job is running / interrupted / failed / canceled; collapses subject status for each
 *     shot following desktop app; "running / failed" on subject detection side reads
 *     `subject/jobs.json` and ledger written by `perception/subject.mjs` in same chat workspace.
 *
 * Thumbnails (mini images captured in desktop app for timeline markers) are not generated on
 * cloud: they belong to the editor and cloud projects have no corresponding storage; transitions
 * omit `thumbs`.
 *
 * Wiring for master tool table (`cloud-tools.mjs`) belongs to package G; this file does not touch
 * it. Pure Node, no browser imports; only lazily loads `src/kernel/project.ts` and
 * `src/kernel/layout.ts` (`kernel` is injectable) when collapsing subject status.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedPythonArgs, splitRoots, superviseChild } from './runner.mjs';

export const SHOTS_TOOL_NAMES = Object.freeze(['detect_shots', 'list_shots']);

export const SHOTS_DEFAULTS = Object.freeze({
  /** Timeout for `ffmpeg -version` / Python `status` (Python needs to import onnxruntime) */
  versionMs: 20_000,
  statusMs: 45_000,
  /** How long status results are cached */
  statusCacheMs: 15_000,
  /** Timeout for ffprobe */
  probeMs: 60_000,
  /**
   * Timeout for a detection job: perSecondMs per second of asset, minDetectMs floor, maxDetectMs
   * ceiling. Desktop app measured ~36s for 5 min asset with TransNetV2
   */
  perSecondMs: 2_000,
  minDetectMs: 120_000,
  maxDetectMs: 60 * 60_000,
  /** Fetch asset into workspace directory: size and timeout */
  maxFetchBytes: 1024 * 1024 * 1024,
  fetchMs: 5 * 60_000,
  /**
   * Model tier decodes entire video into 48x27 mini-frames in RAM (~4 KB per frame, two copies):
   * fall back to scdet if exceeding this many frames
   */
  maxModelFrames: 120_000,
  /** Detection jobs running concurrently across the entire process */
  maxRunning: 2,
  /** Minimum interval for writing progress to the ledger */
  progressMinMs: 400,
  /** How many jobs to keep in the workspace index */
  historyJobs: 20,
  /**
   * Threshold for scdet (same value as desktop app: lowering causes false positives on high-speed
   * motion within a single shot)
   */
  scdetThreshold: 10,
});

export class ShotsToolError extends Error {
  constructor(message, code = 'shots-error') {
    super(message);
    this.name = 'ShotsToolError';
    this.code = code;
  }
}

const FALLBACK_HINT = 'Fallback: use see_frames to look at the real footage and judge the cut points yourself; do not invent shots. Or ask the user to run detection in PromptCut on their computer.';
const NOT_CONFIGURED = `Shot detection is not configured on this cloud node (ffmpeg and the optional TransNetV2 are provided by the deployer; the Cloud Agent cannot install anything on the node). ${FALLBACK_HINT}`;
const NO_FFMPEG = `ffmpeg cannot start on this cloud node, so neither shot detection tier works (hard-cut detection relies on ffmpeg, and the model tier needs it for decoding). ${FALLBACK_HINT}`;

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
 * Shot detection configuration on the node (determined by deployment).
 *
 *   PROMPTCUT_FFMPEG                    Absolute path to ffmpeg. Required for shot detection (`scdet` tier only needs this)
 *   PROMPTCUT_FFPROBE                   Optional: absolute path to ffprobe; defaults to ffprobe in same dir as ffmpeg
 *   PROMPTCUT_AGENT_SHOTS_PYTHON        Optional: Python interpreter with onnxruntime (absolute path); required for TransNetV2 tier
 *   PROMPTCUT_AGENT_SHOTS_MODELS        Required if Python is set: weights dir (absolute path; contains transnetv2.onnx)
 *   PROMPTCUT_AGENT_SHOTS_PYLIBS        Optional: onnxruntime etc. installed in this dir (enters Python module search path)
 */
export function readShotsConfig(env, { root }) {
  const ffmpeg = env.PROMPTCUT_FFMPEG;
  if (typeof ffmpeg !== 'string' || !ffmpeg) return null;
  if (!path.isAbsolute(ffmpeg) || !fs.existsSync(ffmpeg)) return { error: 'PROMPTCUT_FFMPEG must be the absolute path of an existing ffmpeg' };
  const ffmpegDir = path.dirname(ffmpeg);
  const ext = path.extname(ffmpeg);
  let ffprobe = env.PROMPTCUT_FFPROBE;
  if (typeof ffprobe === 'string' && ffprobe) {
    if (!path.isAbsolute(ffprobe) || !fs.existsSync(ffprobe)) return { error: 'PROMPTCUT_FFPROBE must be the absolute path of an existing ffprobe' };
  } else {
    ffprobe = path.join(ffmpegDir, `ffprobe${ext}`);
    if (!fs.existsSync(ffprobe)) return { error: 'ffprobe not found: put it in the same directory as ffmpeg, or set PROMPTCUT_FFPROBE' };
  }
  const base = { ffmpeg, ffprobe, ffmpegDir };
  const python = env.PROMPTCUT_AGENT_SHOTS_PYTHON;
  if (typeof python !== 'string' || !python) return base;
  if (!path.isAbsolute(python) || !fs.existsSync(python)) return { error: 'PROMPTCUT_AGENT_SHOTS_PYTHON must be the absolute path of an existing interpreter' };
  const modelsDir = env.PROMPTCUT_AGENT_SHOTS_MODELS;
  if (typeof modelsDir !== 'string' || !path.isAbsolute(modelsDir) || !fs.existsSync(modelsDir)) {
    return { error: 'PROMPTCUT_AGENT_SHOTS_MODELS must be the absolute path of an existing weights directory' };
  }
  const pylibs = env.PROMPTCUT_AGENT_SHOTS_PYLIBS;
  if (pylibs && !path.isAbsolute(pylibs)) return { error: 'PROMPTCUT_AGENT_SHOTS_PYLIBS must be an absolute path' };
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
      try { const ev = JSON.parse(line); if (ev && typeof ev === 'object') onEvent(ev); } catch { /* Discard non-JSON lines */ }
    }
  };
  feed.flush = () => { if (buf.trim()) feed('\n'); };
  return feed;
};

/** Split text stream by line (ffmpeg stderr / `-progress` output); callback receives a full line */
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

/** Take top boxes by area and round to integers (same standard as desktop app `topBoxes`) */
function topBoxes(boxes, limit = 4) {
  return [...boxes].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, limit).map((b) => ({
    label: b.label, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), conf: Math.round(b.conf * 100) / 100,
  }));
}

/** Frame rate text `25/1` / `30000/1001` / `25` -> number */
function parseRate(raw) {
  if (typeof raw !== 'string') return 0;
  const [n, d] = raw.split('/').map(Number);
  const v = d === undefined ? n : (d ? n / d : 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * @param {object} d
 * @param {object | null} d.config Result of `readShotsConfig`; null if absent (tool faithfully
 *   returns "not configured")
 * @param {object} d.resources `createRunResources` from `run-resources.mjs` (register / authorize /
 *   verifyFence)
 * @param {object} d.assets `createProjectAssets` from `project-assets.mjs` (only uses `openRead`)
 * @param {object} d.jobs `createToolJobs` from `tool-jobs.mjs`
 * @param {(context: object) => (object | Promise<object>)} d.workspace Workspace for this chat
 *   (result of `open()` in `workspace.mjs`)
 * @param {object} d.project Narrow interface on project side (Package G connects to doc's version
 *   expectation and operation fence):
 *   `getMedia(context, mediaId)` -> asset record in project's current replica or null (with `mediaRev`);
 *   `setMediaShots(context, { mediaId, expectedMediaRev, shots, jobId })` -> `{ projectRev? }`,
 *   throws error with `code: 'media-changed'` if versions do not match;
 *   `getStage(context)` -> `{ width, height }` (optional; used for suggestedRect when folding
 *   subject status, omitted if absent)
 * @param {object} d.kernel Injected by host via ssr-host loading seam:
 *   `{ subjectForRange, suggestPosition, rectForSafeSide }` (required)
 */
export function createShotsTools({
  config = null, resources, assets, jobs, workspace, project,
  kernel = null, limits: limitsIn = {}, now = Date.now, log = () => {},
} = {}) {
  for (const [name, dep, methods] of [['resources', resources, ['register', 'authorize']], ['assets', assets, ['openRead']],
    ['jobs', jobs, ['start', 'update', 'get', 'checkpointRetained']], ['project', project, ['getMedia', 'setMediaShots']]]) {
    if (!dep || methods.some((m) => typeof dep[m] !== 'function')) throw new ShotsToolError(`Shot detection is missing a dependency: ${name}`, 'shots-unconfigured');
  }
  if (typeof workspace !== 'function') throw new ShotsToolError('Shot detection is missing a dependency: workspace', 'shots-unconfigured');
  for (const fn of ['subjectForRange', 'suggestPosition', 'rectForSafeSide']) {
    if (typeof kernel?.[fn] !== 'function') throw new ShotsToolError(`Shot detection is not fully configured: missing kernel function ${fn} (the host must fetch it through the ssr-host loading seam and inject it into kernel)`, 'shots-unconfigured');
  }
  const limits = { ...SHOTS_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect tools */ } };
  /**
   * `config.args` is only for unit tests and probes (replaces interpreter entirely with a stub
   * script); production always uses isolated mode, package directory comes from deployment config.
   */
  const stubArgs = config && Array.isArray(config.args) && config.args.length ? config.args : null;
  const pythonGlobals = config?.python ? ['--models-dir', config.modelsDir, ...(config.pylibs ? ['--pylibs', config.pylibs] : []), '--local-only'] : [];
  const pythonArgv = (subArgs) => (stubArgs
    ? [...stubArgs, ...pythonGlobals, ...subArgs]
    : isolatedPythonArgs('promptcut_shots', { roots: splitRoots(config.pythonPath), args: [...pythonGlobals, ...subArgs] }));
  /**
   * `config.ffmpegArgs` / `config.ffprobeArgs` are likewise only for unit tests and probes
   * (replaces executables with stub scripts).
   */
  const ffmpegArgv = (args) => [...(Array.isArray(config?.ffmpegArgs) ? config.ffmpegArgs : []), ...args];
  const ffprobeArgv = (args) => [...(Array.isArray(config?.ffprobeArgs) ? config.ffprobeArgs : []), ...args];
  const loadKernel = async () => kernel;

  /** Running jobs (this process): jobId -> status. close must wait for child processes to actually close */
  const live = new Map();
  /** Only one detection job per asset at a time: `project\0media` -> jobId */
  const byMedia = new Map();
  /**
   * Number of detection jobs registering in ledger and not yet live (two concurrent calls cannot
   * bypass the limit check at the same time).
   */
  let reserving = 0;
  let statusCache = null;
  let ffmpegCache = null;
  let closing = false;
  const settled = new Set();
  /**
   * Child processes spawned by this process and not yet closed (including version / status /
   * ffprobe): close must kill all of them and wait for them to actually close.
   */
  const children = new Set();

  const authorize = async (context, action) => {
    if (closing) throw new ShotsToolError('The Cloud Agent service is shutting down; shot detection no longer accepts new jobs.', 'shots-closing');
    try { return await resources.authorize(context, action); }
    catch (error) {
      if (error instanceof ShotsToolError) throw error;
      // Cannot reach document service: fail closed, but clarify it is "upstream unavailable" (503),
      // not "no permission" (403)
      if (['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable'].includes(error?.code)) {
        throw Object.assign(new ShotsToolError('The document service is temporarily unreachable, so permissions for this turn could not be confirmed and shot detection did not start. Try again later.', 'authority-unavailable'), { status: 503 });
      }
      throw Object.assign(new ShotsToolError(action === 'write' ? 'This turn has no permission to write to the project (read-only member, stopped, or moved to private), so shot detection did not start.' : 'This turn has no permission to read the project, so shot detection did not start.', 'shots-forbidden'), { status: 403 });
    }
  };

  /* ---------------------------------------------------------------- Workspace index (items not stored in ledger, e.g. Chinese reason, tier used) */

  function readIndexFile(ws, file) {
    try {
      if (!ws.exists(file)) return [];
      const rows = JSON.parse(ws.read(file, { maxBytes: 1024 * 1024 }).toString('utf8'));
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    } catch { return []; }
  }
  const readIndex = (ws) => readIndexFile(ws, INDEX_FILE);
  /** Read-modify-write is completed in a synchronous block; will not interleave within same process */
  function mutateIndex(ws, mutate) {
    try {
      const rows = readIndex(ws);
      mutate(rows);
      ws.write(INDEX_FILE, JSON.stringify(rows.slice(-limits.historyJobs)));
    } catch (err) { say('agent.shots.index-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
  }

  /* ---------------------------------------------------------------- Spawn child process */

  /** Paths and drive letters are not returned to the model */
  const scrub = (text, ws) => {
    let out = String(text ?? '');
    let workDir = null;
    try { workDir = ws?.dir?.() ?? null; } catch { workDir = null; }
    if (workDir) out = out.split(workDir).join('<working directory>');
    out = out.replace(/(?:<working directory>[/\x5c])?shots[/\x5c]job_[^/\x5c\s]+[/\x5c]media\.[A-Za-z0-9]+/g, '<media file>');
    for (const secret of [config?.modelsDir, config?.python, config?.pylibs, config?.ffmpeg, config?.ffprobe, ...(config?.pythonPath ?? '').split(path.delimiter)].filter(Boolean)) {
      out = out.split(secret).join('<node directory>');
    }
    return out.replace(/[A-Za-z]:\\[^\s'",)]+/g, '<node directory>');
  };

  const pathEnv = () => {
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH';
    return config?.ffmpegDir ? { [pathKey]: `${config.ffmpegDir}${path.delimiter}${process.env[pathKey] ?? ''}` } : {};
  };

  /**
   * Spawns a child process (ffmpeg / ffprobe / Python) and registers it with run-resources
   * (considered closed only when the entire process tree has actually closed).
   * Returns `{ done, kill, signal, closed }`: `done` resolves to
   * `{ code, timedOut, stderrTail, spawnError }`.
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
      // Registration rejected: superviseChild already killed the entire tree and waited for cleanup
      throw new ShotsToolError('This turn no longer has permission to continue (stopped, moved to private, or the Agent was shut down), so the shot detection process did not start.', 'shots-forbidden');
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

  /**
   * Checks if ffmpeg starts (`-version`). Cache successes briefly, do not cache failures too long.
   * Returns `{ ok, reason? }`.
   */
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


  /**
   * Is model tier ready: Python's `status` (requires both onnxruntime and weight files).
   * Returns `{ ready, why?, reason?, detail? }`; only throws if permissions are revoked.
   */
  async function modelStatus(context, ws, { fresh = false } = {}) {
    if (!config?.python) {
      return { ready: false, why: 'no-python', reason: 'TransNetV2 is not configured on the node (no Python interpreter or weights).' };
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
      value = { ready: false, why: 'not-ready', reason: end.timedOut ? 'Checking TransNetV2 status timed out.' : scrub(tail || 'The interpreter returned no parseable status', ws) };
    } else {
      const runtimeOk = ev.runtime?.installed === true;
      const modelOk = ev.model?.exists === true;
      const missing = [
        !runtimeOk && `onnxruntime is not installed${ev.runtime?.error ? `(${scrub(ev.runtime.error, ws).slice(0, 120)})` : ''}`,
        !modelOk && 'The weights file transnetv2.onnx is not in the node\'s weights directory',
      ].filter(Boolean);
      value = {
        ready: ev.ready === true && runtimeOk && modelOk,
        why: 'not-ready',
        ...(missing.length ? { reason: `TransNetV2 is unavailable: ${missing.join(';')}.` } : null),
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

  /** Selects which tier to use this time. Neither tier is available if ffmpeg fails to start */
  async function chooseEngine(context, ws) {
    const ff = await ffmpegStatus(context, ws);
    if (!ff.ok) return { unavailable: true, reason: ff.reason };
    const model = await modelStatus(context, ws);
    if (model.ready) return { engine: 'transnetv2', model };
    return { engine: 'scdet', scdetWhy: model.reason, model };
  }

  /* ---------------------------------------------------------------- Ledger update */

  /**
   * A job's ledger handle: updates are serialized (exact revision); automatically adds a checkpoint
   * once shared read tasks enter retained.
   * Returns `{ terminal: true }` when the job is already in a terminal state (cancelled by fence),
   * signaling caller to stop.
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
    if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) throw new ShotsToolError('mediaId is required, it is the id of the media (see list_media)', 'bad-args');
    return id;
  };
  const notFound = (id) => new ShotsToolError(`Media ${String(id).slice(0, 80)} not found (no such id, or it is not in the current project)`, 'media-not-found');
  const KIND_NAME = { image: 'Image', audio: 'audio', video: 'Video' };

  async function detectShots(context, args, options = {}) {
    await authorize(context, 'write');
    const mediaId = mediaIdOf(args);
    const ws = await workspace(context);
    const media = await project.getMedia(context, mediaId);
    if (!media) throw notFound(mediaId);
    if (media.kind !== 'video') {
      throw new ShotsToolError(`${media.name} is not a video${KIND_NAME[media.kind] ? `(is ${KIND_NAME[media.kind]})` : ''}, so there are no shots to split`, 'media-kind');
    }
    if (media.pending) throw new ShotsToolError(`${media.name} is not in the asset service yet (upload incomplete or failed), try again later or re-import`, 'media-pending');
    if (!config) return { ok: false, cloudUnavailable: true, error: NOT_CONFIGURED };

    if (media.shots && args?.force !== true) {
      return {
        reused: true, mediaId, engine: media.shots.engine,
        shots: media.shots.shots.length, transitions: media.shots.transitions.length,
        hint: 'This media has already been analyzed; use list_shots to get the result, or pass force:true to re-run',
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
        return { jobId: already, started: false, alreadyRunning: true, mediaId, engine, hint: 'The same shot detection is already running; poll with list_shots and do not start it again.' };
      }
      throw new ShotsToolError('Shot detection is already running on this media; wait for it to finish (poll with list_shots) before re-running.', 'shots-busy');
    }
    if (live.size + reserving >= limits.maxRunning) throw new ShotsToolError('Too many shot detection jobs are running on the node; try again in a moment.', 'shots-busy');

    const requestId = REQUEST_RE.test(options.requestId ?? '') ? options.requestId : `sh_${randomUUID().replace(/-/g, '')}`;
    // Place placeholder before await: of two concurrent calls on same asset,
    // second sees placeholder and returns busy
    byMedia.set(mediaKey, RESERVED);
    reserving += 1;
    let started;
    try { started = await jobs.start(context, 'shots.detect', digest, requestId); }
    catch (error) {
      byMedia.delete(mediaKey);
      throw new ShotsToolError(`Shot detection could not register the job (${error?.code ?? 'ledger unavailable'})`, 'shots-job');
    } finally { reserving -= 1; }
    if (closing) {
      byMedia.delete(mediaKey);
      void tracker(context, started.jobId).patch({ state: 'interrupted', errorCode: 'SERVICE_CLOSING' });
      throw new ShotsToolError('The Cloud Agent service is shutting down; shot detection no longer accepts new jobs.', 'shots-closing');
    }
    const seconds = Number(media.duration);
    const etaSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * (engine === 'transnetv2' ? 0.15 : 0.05)) + 5 : undefined;
    const result = {
      jobId: started.jobId, started: true, mediaId, engine,
      ...(engine === 'scdet' ? { engineNote: `ffmpeg scdet fallback: detects hard cuts only, cannot detect dissolves. ${choice.scdetWhy ?? ''}`.trim() } : null),
      ...(etaSeconds ? { etaSeconds } : null),
      hint: 'Shot detection has started in the background; poll that mediaId with list_shots; '
        + `${engine === 'transnetv2' ? 'measured: about 36 seconds for 5 minutes of media' : 'scdet is faster than the model tier'}; wait between polls with the wait tool, do not ask every second.`
        + ' For long media or if the model fails midway, it switches to scdet; the tier finally used is whatever engine list_shots returns.',
    };
    if (started.state !== 'queued' || live.has(started.jobId)) {
      // Retry with same requestId: job is already started, do not start a second one
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

  /**
   * Finalizing the job: one entry in ledger, one in workspace index. Does not throw even if ledger
   * cannot be written (permissions revoked): fence cancellation is supplemented by host's
   * `cancelForFence`.
   */
  async function finishJob(job, ws, track, { state, errorCode, message, extra = {} }) {
    const patch = { state, ...(errorCode ? { errorCode } : {}), ...(state === 'done' ? { progress: 1 } : {}), ...(extra.outputRefs ? { outputRefs: extra.outputRefs } : {}) };
    const applied = await track.patch(patch);
    mutateIndex(ws, (rows) => {
      const row = rows.find((r) => r.jobId === job.jobId);
      if (row) Object.assign(row, { status: state, finishedAt: now(), ...(errorCode ? { errorCode } : {}), ...(message ? { message } : {}), ...(extra.index ?? {}) });
    });
    return applied;
  }

  /** ffprobe fetches frame rate and duration. Returns `{ ok, fps, duration }` or `{ ok:false, message, ... }` */
  async function probeVideo(job, ws, file) {
    const { context } = job;
    let out = '';
    let run;
    try {
      run = await runChild(context, ws, config.ffprobe, ffprobeArgv([
        '-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0',
        '-show_entries', 'stream=r_frame_rate,avg_frame_rate:format=duration', '-of', 'json', ws.resolve(file),
      ]), { timeoutMs: limits.probeMs, onStdout: (t) => { if (out.length < 64 * 1024) out += t; } });
    } catch (error) { return { ok: false, message: scrub(error?.message ?? 'ffprobe failed to start', ws), forbidden: true }; }
    job.kill = run.kill;
    if (job.cancelRequested || closing) run.kill();
    const end = await run.done;
    await run.closed;
    job.kill = null;
    if (job.cancelRequested || closing || run.signal.aborted) return { ok: false, cancelled: true };
    if (end.timedOut) return { ok: false, message: `Reading media info timed out (over ${Math.round(limits.probeMs / 1000)} seconds), forcibly terminated.` };
    if (end.code !== 0) {
      const tail = scrub(end.stderrTail.join(' ').trim(), ws).slice(0, 300);
      return { ok: false, message: `ffprobe could not read video info from this file${tail ? `(${tail})` : ''}. The file may be corrupt or not a video.` };
    }
    let info;
    try { info = JSON.parse(out); } catch { return { ok: false, message: 'Failed to parse ffprobe output.' }; }
    const stream = info?.streams?.[0];
    if (!stream) return { ok: false, message: 'This file has no video track, so there are no shots to split.' };
    const fps = parseRate(stream.r_frame_rate) || parseRate(stream.avg_frame_rate);
    if (!fps) return { ok: false, message: 'Could not read the frame rate of this video.' };
    const duration = Number(info?.format?.duration);
    return { ok: true, fps, duration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
  }

  /**
   * Validates Python's result event and folds into project's `MediaAsset.shots` shape;
   * throws `bad-result` if format is invalid.
   */
  function shotsFromPython(ev, at) {
    const finite = (v) => typeof v === 'number' && Number.isFinite(v);
    const transitions = Array.isArray(ev.transitions) ? ev.transitions : null;
    const shots = Array.isArray(ev.shots) ? ev.shots : null;
    const okTransition = (t) => t && typeof t === 'object' && KINDS.has(t.kind) && finite(t.start) && finite(t.end) && finite(t.time) && finite(t.confidence) && t.end >= t.start && t.start >= 0;
    const okShot = (s) => s && typeof s === 'object' && finite(s.start) && finite(s.end) && s.end > s.start && s.start >= 0
      && (s.inTransition === null || KINDS.has(s.inTransition)) && (s.outTransition === null || KINDS.has(s.outTransition));
    if (!transitions || !shots || shots.length === 0 || !transitions.every(okTransition) || !shots.every(okShot)) {
      throw new ShotsToolError('The shot detection model returned a result in the wrong format, discarded.', 'bad-result');
    }
    return {
      engine: 'transnetv2',
      createdAt: new Date(at).toISOString(),
      transitions: transitions.map((t) => ({ kind: t.kind, start: t.start, end: t.end, time: t.time, confidence: t.confidence })),
      shots: shots.map((s) => ({ start: s.start, end: s.end, inTransition: s.inTransition, outTransition: s.outTransition })),
    };
  }

  /**
   * scdet hit points -> project's `MediaAsset.shots` shape (always hard cuts: scdet only provides
   * a timestamp, no span; same standard as desktop app).
   */
  function shotsFromScdet(hits, duration, at) {
    const times = [...new Set(hits.map((h) => round3(h.t)))].sort((a, b) => a - b);
    const transitions = times.map((t) => {
      const hit = hits.find((h) => round3(h.t) === t);
      // scdet score is 0-100 visual difference; map to 0-1 as confidence (desktop app always writes 1)
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
    if (shots.length === 0) throw new ShotsToolError('Cannot compute shots: the media has no duration info.', 'bad-result');
    return { engine: 'scdet', createdAt: new Date(at).toISOString(), transitions, shots };
  }

  /** Runs ffmpeg scdet. Returns `{ ok, shots }` or `{ ok:false, cancelled | timedOut | message }` */
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
    } catch (error) { return { ok: false, message: scrub(error?.message ?? 'ffmpeg failed to start', ws), forbidden: true }; }
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
      return { ok: false, message: `ffmpeg exit code ${end.code}${tail ? `:${tail}` : ''}` };
    }
    try { return { ok: true, shots: shotsFromScdet(hits, meta.duration > 0 ? meta.duration : lastOut, now()) }; }
    catch (error) { return { ok: false, message: error.message }; }
  }

  /** Runs TransNetV2 (Python). Returns `{ ok, shots }` or `{ ok:false, cancelled | timedOut | message }` */
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
    } catch (error) { return { ok: false, message: scrub(error?.message ?? 'Python failed to start', ws), forbidden: true }; }
    job.kill = run.kill;
    if (job.cancelRequested || closing) run.kill();
    const end = await run.done;
    await run.closed;
    job.kill = null;
    feed.flush();
    if (job.cancelRequested || closing || run.signal.aborted) return { ok: false, cancelled: true };
    if (end.timedOut) return { ok: false, timedOut: true };
    if (!resultEvent) {
      const message = scrub(errorEvent?.message || end.stderrTail.join('\n').trim() || (end.code === 0 ? 'The shot detection model returned no result' : `Shot detection process exited abnormally (code ${end.code})`), ws).slice(0, 400);
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
      message: closing ? `Shot detection was interrupted by service shutdown, no result. You can call detect_shots(force:true) again.${suffix}` : `Shot detection was cancelled.${suffix}`,
    });
    try {
      const first = await track.patch({ state: 'running', stage: 'fetch', progress: 0 });
      if (!first.ok) return;

      // 1) Fetch asset bytes (with hash verification) to working directory
      let read;
      try { read = await assets.openRead(context, mediaId); }
      catch (error) {
        const message = error?.status === 404 || error?.message === 'asset-missing' ? 'The media bytes were not found on the asset service (upload did not finish or was cleaned up).' : `Failed to fetch media (${scrub(error?.code ?? error?.message ?? error).slice(0, 80)}).`;
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'MEDIA_FETCH_FAILED', message });
      }
      const mediaRev = read.mediaRev;
      const ext = typeof read.assetRef?.ext === 'string' && /^[a-z0-9]{1,8}$/.test(read.assetRef.ext) ? read.assetRef.ext : 'bin';
      mediaFile = `${rel}.${ext}`;
      let fetchError = null;
      job.abortFetch = () => read.stream.destroy();
      const writer = ws.writer(mediaFile);
      let fetched = 0;
      const fetchTimer = setTimeout(() => { fetchError = new ShotsToolError('Media fetch timed out', 'fetch-timeout'); read.stream.destroy(); }, limits.fetchMs);
      fetchTimer.unref?.();
      try {
        for await (const piece of read.stream) {
          if (stopped()) throw new ShotsToolError('Cancelled', 'cancelled');
          fetched += piece.length;
          if (fetched > limits.maxFetchBytes) throw new ShotsToolError('The media is too large for cloud shot detection to fetch', 'too-large');
          writer.write(piece);
        }
        if (fetchError) throw fetchError;
        writer.end();
      } catch (error) {
        writer.abort();
        read.stream.destroy();
        await read.closed.catch(() => {});
        if (stopped()) return await finishJob(job, ws, track, cancelledNote());
        const message = error?.code === 'too-large' ? 'The media is too large for cloud shot detection to fetch.' : error?.code === 'fetch-timeout' ? 'Fetching media timed out.' : `Failed to fetch media (${scrub(error?.code ?? error?.message ?? error).slice(0, 80)}).`;
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'MEDIA_FETCH_FAILED', message });
      } finally { clearTimeout(fetchTimer); job.abortFetch = null; }
      await read.closed.catch(() => {});
      if (stopped()) return await finishJob(job, ws, track, cancelledNote());

      // 2) ffprobe: frame rate and duration
      await track.patch({ stage: 'probe', progress: 0.05 });
      mutateIndex(ws, (rows) => { const row = rows.find((r) => r.jobId === job.jobId); if (row) row.status = 'running'; });
      const meta = await probeVideo(job, ws, mediaFile);
      if (meta.cancelled || stopped()) return await finishJob(job, ws, track, cancelledNote());
      if (!meta.ok) {
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SHOTS_FAILED', message: `Shot detection failed: ${meta.message}${FALLBACK_HINT}` });
      }

      // 3) Select tier and detect. If model tier has too many frames it will exhaust memory,
      // switch to scdet; if model tier fails midway, also switch to scdet (and faithfully record it).
      let engine = job.engine;
      let scdetWhy = job.scdetWhy;
      if (engine === 'transnetv2' && meta.duration * meta.fps > limits.maxModelFrames) {
        engine = 'scdet';
        scdetWhy = `The media is too long (about ${Math.round(meta.duration / 60)} minutes); the model tier has to decode the whole video into small frames in memory, so it falls back to ffmpeg's scdet.`;
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
          fallbackReason = String(outcome.message ?? 'unknown reason').slice(0, 300);
          engine = 'scdet';
          scdetWhy = `TransNetV2 was supposed to run, but it errored midway and fell back to scdet: ${fallbackReason}`;
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
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SHOTS_TIMEOUT', message: `Shot detection timed out (over ${limitMs < 10_000 ? Number((limitMs / 1000).toFixed(1)) : Math.round(limitMs / 1000)} seconds), forcibly terminated. The media may be too long.${FALLBACK_HINT}` });
      }
      if (!outcome.ok) {
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SHOTS_FAILED', message: `Shot detection failed: ${outcome.message}. ${FALLBACK_HINT}` });
      }
      const shots = outcome.shots;

      // 4) Write current version of project asset (using mediaRev from byte fetch as version expectation)
      const committing = await track.patch({ stage: 'commit', progress: 0.97 });
      if (!committing.ok) {
        // If ledger was cancelled by fence (terminal state), or permissions revoked and ledger
        // cannot be written: do not write to project
        return await finishJob(job, ws, track, { state: 'cancelled', errorCode: 'FENCE_CANCELLED', message: 'This round can no longer write to the project (it was stopped, made private, or permissions changed); the detection result was not written.' });
      }
      try { await authorize(context, 'write'); }
      catch { return await finishJob(job, ws, track, { state: 'cancelled', errorCode: 'FENCE_CANCELLED', message: 'This round can no longer write to the project (it was stopped, made private, or permissions changed); the detection result was not written.' }); }
      if (stopped()) return await finishJob(job, ws, track, cancelledNote('The result was not written.'));
      try { await project.setMediaShots(context, { mediaId, expectedMediaRev: mediaRev, shots, jobId: job.jobId }); }
      catch (error) {
        const changed = error?.code === 'media-changed';
        return await finishJob(job, ws, track, {
          state: 'error', errorCode: changed ? 'MEDIA_CHANGED' : 'COMMIT_REJECTED',
          message: changed ? 'This media was replaced or re-imported during detection, so this result does not match the new media and was discarded. Please call detect_shots again.' : `The detection result could not be written to the project (${scrub(error?.code ?? error?.message ?? 'rejected', ws).slice(0, 80)}).`,
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
      if (mediaFile) { try { ws.remove(mediaFile); } catch { /* Left to be cleaned up when chat is deleted */ } try { fs.rmSync(path.dirname(ws.resolve(mediaFile)), { recursive: true, force: true }); } catch { /* Same as above */ } }
    }
  }

  /* ---------------------------------------------------------------- list_shots */

  const INTERRUPTED = 'The previous shot detection was interrupted by a service restart or shutdown, no result. You can call detect_shots again (pass force:true).';
  const FINISHED = ['done', 'error', 'cancelled', 'interrupted'];

  /**
   * Current status of a job in workspace index: ledger is primary; if job has finalized but ledger
   * write failed (permissions revoked), the terminal state in the index prevails.
   */
  async function stateOf(context, row, isLive) {
    let ledger = null;
    try { ledger = await jobs.get(context, row.jobId); } catch { ledger = null; }
    const state = !ledger
      ? (row.status === 'queued' || row.status === 'running' ? 'interrupted' : row.status)
      : (FINISHED.includes(row.status) && !FINISHED.includes(ledger.state) && !isLive ? row.status : ledger.state);
    return { state, ledger };
  }

  /**
   * "Running / failed" from subject detection side (reads index and ledger written by
   * `perception/subject.mjs` in the same chat workspace).
   */
  async function subjectJobState(context, ws, mediaId) {
    const row = [...readIndexFile(ws, SUBJECT_INDEX_FILE)].reverse().find((r) => r.kind === 'detect' && r.mediaId === mediaId);
    if (!row) return null;
    const { state, ledger } = await stateOf(context, row, false);
    if (state === 'queued' || state === 'running') return { pending: { percent: Math.max(0, Math.min(99, Math.round((ledger?.progress ?? 0) * 100))) } };
    if (state === 'error' || state === 'cancelled' || state === 'interrupted') {
      return { error: row.message || (state === 'interrupted' ? 'Subject detection was interrupted by a service restart or shutdown, no result' : 'Did not succeed') };
    }
    return null;
  }

  /** Same standard as desktop app `subjectDigest` (omits suggestedRect when `stage` is unknown) */
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
      ...(info.approximate ? { approximate: true, note: 'There are no sample points in this range; the numbers come from the nearest sample in time and are only approximate' } : null),
    };
  }

  async function listShots(context, args) {
    await authorize(context, 'read');
    const mediaId = mediaIdOf(args);
    const media = await project.getMedia(context, mediaId);
    if (!media) throw notFound(mediaId);
    const ws = await workspace(context);
    const row = [...readIndex(ws)].reverse().find((r) => r.kind === 'detect' && r.mediaId === mediaId);
    const older = media.shots ? '(The project still holds an earlier successful batch of results, not from this run.)' : '';
    if (row) {
      const { state, ledger } = await stateOf(context, row, live.has(row.jobId));
      if (state === 'queued' || state === 'running') {
        const percent = Math.max(0, Math.min(99, Math.round((ledger?.progress ?? 0) * 100)));
        return {
          running: true, percent, engine: row.engine,
          ...(media.shots ? { stale: true, staleNote: 'The previous batch of results is still there, but a new detection is running, so no shots are given here; call this tool again once it finishes' } : null),
        };
      }
      if (state === 'error' || state === 'cancelled' || state === 'interrupted') {
        const message = row.message || (state === 'interrupted' ? INTERRUPTED : 'The previous shot detection did not succeed.');
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
    // Which tier this batch of results is and why: include reason if found in job index
    // (if not found, e.g. run by another chat, only report tier)
    const doneRow = row && row.status === 'done' && row.engine === media.shots.engine ? row : null;
    const engineNote = media.shots.engine === 'scdet'
      ? `Currently using the ffmpeg scdet fallback, which only detects hard cuts and cannot detect gradual transitions such as dissolves${doneRow?.scdetWhy ? `. ${doneRow.scdetWhy}` : ''}`
      : 'TransNetV2, recognizes both hard cuts and dissolves';
    const result = {
      running: false,
      engine: media.shots.engine,
      engineNote,
      ...(doneRow?.fellBackFrom ? { fellBackFrom: doneRow.fellBackFrom, fallbackNote: `Was supposed to run TransNetV2 but hit an error midway and fell back to scdet: ${doneRow.fallbackReason ?? 'unknown reason'}. So this batch of results contains hard cuts only.` } : null),
      shots: media.shots.shots.map((s) => ({ ...s, subject: subjectDigest(k, k.subjectForRange(media.subjects, s.start, s.end), stage) })),
      transitions: media.shots.transitions.map(({ thumbs: _thumbs, ...rest }) => rest),
    };
    // Order matters (consistent with desktop app): 1. Subject detection failed last time 2. Running
    // 3. Never detected 4. Entire batch sampling failed 5. Has results
    if (subjectJob?.error) {
      return {
        ...result,
        subjectHint: `Last subject detection failed: ${subjectJob.error}.`
          + (media.subjects ? 'The subject of each shot below comes from an earlier successful batch, not this one.' : '')
          + 'First call subject_status and check engine: null means neither tier works on this machine (there is no fallback tier), '
          + "fall back to see_frames({ source: 'timeline', t }) and judge from the real frames where the person is, **do not keep polling this tool**; "
          + 'Only when engine is not null is it worth calling detect_subjects with force:true to retry.',
      };
    }
    if (subjectJob?.pending) {
      return {
        ...result,
        subjectHint: `Subject detection is running (${subjectJob.pending.percent}%). Call this tool again when it finishes to see the person positions in each shot${media.subjects ? '; the subject below is from the previous batch and will be replaced when the new batch finishes' : ''}`,
      };
    }
    if (!media.subjects) {
      return { ...result, subjectHint: 'Subject detection has not been run on these shots, so every subject is null. To decide which side to put the card on and avoid covering people\'s faces, first call detect_subjects to get person positions.' };
    }
    if (result.shots.every((s) => s.subject === null)) {
      return {
        ...result,
        subjectEngine: media.subjects.engine,
        subjectFailedCount: media.subjects.failedCount ?? 0,
        subjectHint: `Subject detection finished, but none of the ${media.subjects.samples.length} samples in this batch is usable`
          + ' (all frame extractions failed, see subjectFailedCount), so every subject is null. This does not mean "there is nobody in the frame".'
          + " Re-measure with detect_subjects by passing different times, or fall back to see_frames({ source: 'timeline', t }) and look at the image.",
      };
    }
    return {
      ...result,
      subjectEngine: media.subjects.engine,
      ...(media.subjects.failedCount ? { subjectFailedCount: media.subjects.failedCount } : null),
      ...(media.subjects.fellBackFrom
        ? {
          subjectFellBackFrom: media.subjects.fellBackFrom,
          subjectFallbackNote: `Was supposed to run the full tier but fell back to light midway: ${media.subjects.fallbackReason ?? 'unknown reason'}. So prompt had no effect, and label can only be person / face.`,
        }
        : null),
      subjectHint: 'Each shot\'s subject.suggestedPosition can be filled directly into the card\'s params.position (it is only ever left / right / bottom, never center); boxes are person boxes in original video pixels.'
        + 'suggestedPosition being null means all four tiers are occupied by people (see suggestedOccupancy and warning); that shot has no position that avoids people, so do not force one.'
        + ' Whether it can be filled is determined by the controls of list_cards({cardId}); if the card does not support the value, switch to another card, and do not fall back to the default center, which is exactly where the face is.',
    };
  }

  /* ---------------------------------------------------------------- External */

  const handlers = {
    detect_shots: (context, args, options) => detectShots(context, args, options),
    list_shots: (context, args) => listShots(context, args),
  };

  return Object.freeze({
    handles: new Set(SHOTS_TOOL_NAMES),
    /**
     * @param {string} name Tool name
     * @param {object} args Arguments provided by model (only accepts mediaId / force)
     * @param {object} context Trusted eight fields sent by F0
     * @param {{ requestId?: string }} [options] Idempotency id provided by host (tool call id);
     *   retries with same id will not start a second job
     */
    call(name, args, context, options = {}) {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
      if (!handler) return Promise.reject(new ShotsToolError(`Shot detection does not handle ${String(name).slice(0, 60)}`, 'unknown-tool'));
      return Promise.resolve().then(() => handler(context, args ?? {}, options));
    },
    /**
     * Which tier shot detection can run on this node (for host and probe use, not a tool callable by
     * model). Requires read permission.
     */
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
    /**
     * Cancels a detection job for this chat (for host control path and unit tests; not a tool
     * callable by model). Returns receipt that child process has closed.
     */
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
