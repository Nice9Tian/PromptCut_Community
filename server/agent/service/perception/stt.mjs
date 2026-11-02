/**
 * Speech-to-text tools for Cloud Agent (`stt_status`, `stt_install`, `transcribe_media`; package
 * P2 of plan `docs/plan/cloud-agent-tools-implementation.md`).
 *
 * In desktop app, these three tools are executed by the page, calling editor process
 * `/api/stt/*` (`server/vite-plugin-stt.ts`) under the hood, with jobs stored in editor process
 * memory, and transcription completion relying on the page to write results back to project. On
 * cloud nodes, there is neither a page nor an editor process, so an alternative implementation is
 * provided on the Agent service side:
 *
 *   - **Every call carries a trusted ToolRunContext** (`tool-context.mjs` from F0, constructed from
 *     current run authorization after document service confirms message was read), and passes
 *     `authorize(read|write)` first: `stt_status` only requires read; `stt_install` and
 *     `transcribe_media` require write. Arguments provided by model contain no project,
 *     authorization, or path.
 *   - **Asset bytes only pass through ProjectAssets** (`project-assets.mjs` from F0): fetched into
 *     this chat's workspace by mediaId, verifying hash as received; assets from other projects
 *     cannot be fetched.
 *   - **Jobs are recorded in ToolJobs** (`tool-jobs.mjs` from F0, SQLite): identical requests
 *     within the same message open only one job; jobs halfway through on restart are marked
 *     interrupted; when cancelled/stopped, host calls `cancelForFence` to mark cancelled, and this
 *     module is responsible for making child processes actually exit.
 *   - **Python child processes only take fixed arguments**: runs `promptcut_stt <status|install|transcribe> ...`
 *     in isolated mode (`python -I …`, `isolatedPythonArgs` from `runner.mjs`), with all arguments
 *     assembled by this module; the model can only choose engine (enum), model name (enum), and
 *     language (language code); no pip arguments, index URLs, or shell. Environment variables are
 *     rebuilt from an allowlist, and working directory is this chat's workspace. Transcription
 *     always includes `--offline`: weights only use those pre-placed by deployer without
 *     downloading over network; ffmpeg only reads local files.
 *   - **Installation only installs locked dependencies**: `stt_install` uses the dependency file
 *     specified by deployer in node config (see `python/requirements-faster-whisper.lock.txt`);
 *     if not configured, faithfully returns "installation is not enabled on this node".
 *   - **Child processes are attached to run resources registry** (`run-resources.mjs` from F0):
 *     when cancelled, stopped, or Agent is closed, kills the entire process tree and waits for
 *     actual exit + close. Process spawning, tree killing, cleanup waiting, and registration share
 *     common implementation `runner.mjs` (same instance as subject detection, motion tracking,
 *     web collection).
 *   - **Writing results back to project only goes through host-provided `commitTranscript`**
 *     (project write seam, connected by Package G to document service mutate): this module
 *     re-verifies write permissions and asset revision before commit.
 *
 * This file does not reference `src/`. Python, engines, weights, and ffmpeg on the node must be
 * provided by deployer; if unavailable, respond faithfully rather than pretending they work.
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
  /** Engines allowed for model selection (deployer can narrow down) */
  engines: ['faster-whisper'],
  defaultEngine: 'faster-whisper',
  defaultModel: 'small',
  /** Timeout for `status` subcommand */
  statusMs: 20_000,
  /** Timeout for single transcription (including audio track extraction and decoding) */
  transcribeMs: 30 * 60_000,
  /** Timeout for single installation */
  installMs: 30 * 60_000,
  /**
   * Upper limit for fetching a single asset into workspace (further constrained by workspace's own
   * single-file limit).
   */
  maxMediaBytes: 1024 * 1024 * 1024,
  /**
   * Maximum segments and characters per segment for a transcript, to prevent an abnormal result from
   * bloating the project.
   */
  maxSegments: 20_000,
  maxSegmentChars: 4_000,
  /**
   * Minimum interval for writing job progress to DB (each DB write must pass multiple authorization
   * checks).
   */
  progressMs: 1_500,
  /** Timeout for `close()` waiting for child processes to actually exit */
  closeMs: 10_000,
  device: 'auto',
});

/**
 * Error descriptions shown to the model; job records only store codes (errorCode in ToolJobs),
 * while here are the corresponding human-readable messages.
 */
export const STT_ERROR_TEXT = Object.freeze({
  ENGINE_NOT_INSTALLED: 'The selected speech-to-text engine is not installed on this cloud node. First use stt_status to see which engines are installed; if one can be installed, use stt_install.',
  MODEL_NOT_INSTALLED: 'This cloud node does not have the weights of the selected model (the cloud does not download weights over the network; the host places them in advance). First use stt_status to see availableModels and switch to a model that is available.',
  FFMPEG_MISSING: 'This cloud node does not have ffmpeg installed, so it cannot extract the audio track and cannot transcribe. Tell the user to contact the host.',
  NO_AUDIO: 'This media has no audio track (or is an image), so there is no sound to transcribe.',
  MEDIA_UNAVAILABLE: 'The media cannot be fetched: it is not in this project, or you do not have permission to read it right now.',
  MEDIA_TOO_LARGE: 'The media is too large for the cloud to hold this file, so it was not transcribed.',
  MEDIA_CHANGED: 'This media was replaced or deleted in the project during transcription, so the result was not written to the project.',
  TIMEOUT: 'Transcription exceeded the time limit allowed by the cloud and was stopped. You can switch to a smaller model, or transcribe only shorter media.',
  TRANSCRIBE_FAILED: 'Transcription failed. You can try again with a different model; if it keeps failing, tell the user.',
  TRANSCRIPT_TOO_LARGE: 'The transcription produced an abnormally large number of segments, so it was not written to the project.',
  INSTALL_FAILED: 'Installation failed (dependencies were not fully installed). Tell the user to contact the host to check the node.',
  FENCE_CANCELLED: 'Permission for this chat turn was revoked (set to private, stopped, or the Agent was turned off); the job was cancelled.',
  INTERRUPTED_ON_RESTART: 'This job was running when the Agent service restarted and was interrupted; you can start it again.',
  FORBIDDEN: 'No permission: you cannot modify this project right now.',
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

/**
 * Environment probe failed (Python fails to run): faithfully return "unavailable"; other errors
 * like revoked permissions are thrown upward as usual.
 */
const isProbeFailure = (error) => error instanceof SttToolError && (error.code === 'status-failed' || error.code === 'python-missing');

/**
 * Phrasing when fetching asset fails: both 404/403 are reported as "cannot fetch", without
 * disclosing whether the asset exists in another project.
 */
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
 *   F0 run resource registry (`createRunResources`)
 * @param {{ openRead(context: object, mediaId: string): Promise<{ stream: import('node:stream').Readable, assetRef: object, mediaRev: string, kind: string, closed: Promise<void> }> }} d.assets
 *   F0 `createProjectAssets`
 * @param {{ start: Function, update: Function, get: Function, checkpointRetained: Function }} d.jobs  F0 `createToolJobs`
 * @param {(context: object) => object | Promise<object>} d.workspace Workspace for this chat (`open()` in `workspace.mjs`)
 * @param {(context: object, input: { mediaId: string, mediaRev: string, assetHash: string, transcript: object, jobId: string }) => Promise<{ committed: true }>} d.commitTranscript
 *   Project write seam: writes transcript to the asset for `mediaId` in the project. Host
 *   implements this in document service mutate; on commit, verifies asset still exists and is the
 *   same copy (assetHash)
 * @param {object} [d.runtime] Node config provided by deployer
 * @param {string} [d.runtime.pythonPath] Interpreter (must be an executable, not via shell)
 * @param {string} [d.runtime.sourceRoot] Package source directory (for development/testing; production nodes install package into site-packages)
 * @param {string} [d.runtime.pylibs] Third-party library directory (PROMPTCUT_PYLIBS)
 * @param {string} [d.runtime.modelsDir] Model weights directory (PROMPTCUT_MODELS)
 * @param {string} [d.runtime.ffmpegDir] ffmpeg directory, prepended to child process PATH
 * @param {Record<string, string>} [d.runtime.requirements] Engine name → locked requirements file; engines without this entry do not allow installation
 * @param {string} [d.runtime.indexUrl] Package index specified by deployer (only from node config)
 * @param {object} [d.limits] Overrides `STT_DEFAULTS`
 */
export function createSttTools({ resources, assets, jobs, workspace, commitTranscript, runtime = {}, limits = {}, spawnImpl = nodeSpawn, now = Date.now } = {}) {
  if (typeof resources?.authorize !== 'function' || typeof resources?.register !== 'function' || typeof resources?.signalFor !== 'function' ||
      typeof assets?.openRead !== 'function' ||
      !['start', 'update', 'get', 'checkpointRetained'].every((k) => typeof jobs?.[k] === 'function') ||
      typeof workspace !== 'function' || typeof commitTranscript !== 'function') {
    throw new SttToolError('Cloud speech-to-text is not fully configured (missing the run-resource registrar, media, job table, workspace, or project write entry).', { code: 'stt-unconfigured', status: 503 });
  }
  const cfg = { ...STT_DEFAULTS, ...limits };
  const allowedEngines = (cfg.engines ?? []).filter((e) => STT_ENGINES.includes(e));
  const handles = new Set(STT_TOOL_NAMES);
  /** Running background tasks (transcription, installation) */
  const pending = new Set();
  /** Transcription job ids currently running in this process (prevents two concurrent calls from each starting work for the same job) */
  const transcribing = new Set();
  /** Only one installation is allowed at a time on the node; only one transcription runs at a time (CPU work) */
  let installing = null;
  const slot = createSlot();
  const killers = new Set();
  let closing = false;
  let closePromise = null;

  const authorize = async (context, action) => {
    if (closing) throw new SttToolError('Cloud speech-to-text is shutting down.', { code: 'stt-closed', status: 503 });
    await resources.authorize(context, action);
  };

  const wsOf = async (context) => workspace(context);

  /* ------------------------------------------------------------------ Start Python */

  const pythonReady = () => {
    if (typeof runtime.pythonPath !== 'string' || !runtime.pythonPath) return false;
    try { return fs.statSync(runtime.pythonPath).isFile(); } catch { return false; }
  };

  /** Isolated mode: workspace (current directory) is not added to module search paths; package source directory comes only from node config, passed in via bootstrap code */
  function pythonArgs(sub) {
    return isolatedPythonArgs('promptcut_stt', { roots: runtime.sourceRoot ? [runtime.sourceRoot] : [], args: sub });
  }

  function pythonEnv(cwd, extra = {}) {
    // PYTHON* environment variables have no effect in isolated mode (UTF-8 and ignoring user site
    // are both provided by CLI switches), not set here
    const env = childEnv(cwd, { PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', ...extra });
    if (runtime.ffmpegDir) {
      // Windows environment variable names are case-insensitive; PATH/Path may both be in allowlist: add to each
      const sep = process.platform === 'win32' ? ';' : ':';
      const keys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
      if (!keys.length) env.PATH = runtime.ffmpegDir;
      for (const k of keys) env[k] = `${runtime.ffmpegDir}${sep}${env[k]}`;
    }
    // The following two items are node configs, not provided by model; childEnv in the workspace
    // drops all PROMPTCUT_* variables, so add after it
    if (runtime.pylibs) env.PROMPTCUT_PYLIBS = runtime.pylibs;
    if (runtime.modelsDir) env.PROMPTCUT_MODELS = runtime.modelsDir;
    return env;
  }

  /**
   * Runs a Python subcommand once. Returns `{ code, events, stderr, timedOut, aborted }`, only
   * returning **after the child process has truly exited + closed**.
   * The child process is first attached to the run resource registry: the registry kills it on
   * revoke/stop/close (we replace its kill with killing the entire tree).
   */
  async function runPython(context, cwd, sub, { timeoutMs, onEvent, extraEnv } = {}) {
    if (!pythonReady()) throw new SttToolError('This cloud node has no Python configured for speech recognition.', { code: 'python-missing', status: 503 });
    // If authorization for this round has been revoked (private/stop/close), do not spawn child processes
    let fenced = false;
    try { fenced = resources.signalFor(context).aborted; } catch { /* This chat has not registered resources yet: not revoked */ }
    if (fenced) throw new SttToolError('The permissions for this round of chat have been revoked.', { code: 'run-resource-fenced', status: 403 });
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
      try { onEvent?.(event, killer); } catch { /* Callback errors do not affect child process cleanup */ }
    };
    let end;
    try {
      // When registration fails (no permissions left in this round), superviseChild has already
      // killed the entire tree and waited for it to clean up fully; rethrow error as is
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
    if (end.spawnError) throw new SttToolError('The Python for speech recognition cannot start.', { code: 'python-missing', status: 503 });
    outcome.code = end.code;
    outcome.timedOut = end.timedOut;
    outcome.aborted = end.aborted;
    return outcome;
  }

  /** Result of `status` subcommand (single-line JSON); throws if it fails to run */
  async function probeStatus(context) {
    const ws = await wsOf(context);
    const out = await runPython(context, ws.dir(), ['status'], { timeoutMs: cfg.statusMs });
    const status = [...out.events].reverse().find((e) => e && typeof e === 'object' && e.engines);
    if (out.code !== 0 || !status) {
      throw new SttToolError('The speech recognition environment probe failed.', { code: 'status-failed', status: 503 });
    }
    return status;
  }

  /** Status visible to model: without disk paths or interpreter paths */
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

  /* ------------------------------------------------------------------ Job records */

  /**
   * Starts a job, starting only one for the same request and same input; if the previous one has
   * failed/cancelled/interrupted, allow re-initiating (with a different request id).
   */
  async function startJob(context, kind, digest, base) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const started = await jobs.start(context, kind, digest, `${base}-${attempt}`);
      if (!BAD_JOB.has(started.state)) return started;
    }
    throw new SttToolError('The same request has already failed several times; change the parameters or try again later.', { code: 'too-many-attempts', status: 429 });
  }

  /**
   * Updates a job. When transitioning from "shared read" to "retained" during execution, the job
   * table must perform a checkpoint before allowing further writes (see checkpointRetained in ToolJobs).
   * @returns {Promise<void>} Throws on failure (including revoked permissions)
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
    if (!pythonReady()) return unavailable('PYTHON_MISSING', 'This cloud node has no Python configured for speech recognition, so the Cloud Agent cannot do speech-to-text. Tell the user to contact the host, or transcribe in PromptCut on their computer.');
    let raw;
    try { raw = await probeStatus(context); } catch (error) {
      if (isProbeFailure(error)) return unavailable('STATUS_FAILED', 'The speech recognition environment probe failed, and Python on this node could not run properly. Tell the user to contact the host.');
      throw error;
    }
    return publicStatus(raw);
  }

  /* ------------------------------------------------------------------ stt_install */

  async function sttInstall(args, context) {
    rejectUnknown(args, ['engine']);
    const engine = args?.engine;
    if (!STT_ENGINES.includes(engine)) throw new SttToolError(`engine must be ${STT_ENGINES.join(' or ')}.`, { code: 'bad-args' });
    await authorize(context, 'write');
    if (!allowedEngines.includes(engine)) return unavailable('ENGINE_NOT_ALLOWED', `This cloud node does not offer the ${engine} engine.`, { engine });
    if (!pythonReady()) return unavailable('PYTHON_MISSING', 'This cloud node has no Python configured for speech recognition, so the engine cannot be installed. Tell the user to contact the host.', { engine });
    const requirements = runtime.requirements?.[engine];
    let raw;
    try { raw = await probeStatus(context); } catch (error) {
      if (isProbeFailure(error)) return unavailable('STATUS_FAILED', 'Speech recognition environment probe failed: Python on this node did not run properly.', { engine });
      throw error;
    }
    if (raw.engines?.[engine]?.installed === true) return { ok: true, started: false, alreadyInstalled: true, engine, hint: 'This engine is already installed, no need to install it again.' };
    if (!requirements || !fs.existsSync(requirements)) {
      return unavailable('INSTALL_NOT_ENABLED', `This cloud node does not allow self-service installation of ${engine} (the host has not configured pinned dependencies). Tell the user to contact the host to install it.`, { engine });
    }
    if (raw.pylibs?.writable !== true) return unavailable('INSTALL_NOT_ENABLED', 'The third-party library directory on this cloud node is not writable, so self-service installation is disabled. Tell the user to contact the host.', { engine });
    if (installing) return { ok: true, started: false, alreadyRunning: true, engine, hint: 'An install is already running on this node. Check installed with stt_status later. Do not start it again.' };

    const controller = { engine };
    installing = controller;                                     // Synchronous placeholder: concurrent second call takes the line above
    const release = () => { if (installing === controller) installing = null; };
    let started;
    try {
      const digest = sha256(JSON.stringify({ kind: 'install', engine }));
      started = await startJob(context, 'stt.install', digest, `stt-install-${engine}`);
    } catch (error) { release(); throw error; }
    if (started.state !== 'queued') {
      release();
      return { ok: true, started: false, jobId: started.jobId, state: started.state, engine, hint: 'The same install was already started in this turn. Check this jobId with background_job_status.' };
    }
    const state = { context, jobId: started.jobId, revision: 0 };
    track(runInstall(state, engine, requirements, context).finally(release));
    return { ok: true, started: true, jobId: started.jobId, engine, hint: 'The install has started in the background. Check this jobId with background_job_status, or check the installed field of the engine with stt_status. Do not start it again.' };
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
    } catch { /* Permissions revoked or registry closed: job status is handled by host cancellation, no more writes here */ }
  }

  async function finishError(state, code) {
    try { await patchJob(state, { state: 'error', errorCode: code }); } catch { /* Permissions revoked: leave cancellation to the host */ }
  }

  /* ------------------------------------------------------------------ transcribe_media */

  function parseTranscribeArgs(args) {
    rejectUnknown(args, ['mediaId', 'engine', 'model', 'language']);
    const mediaId = args?.mediaId;
    if (typeof mediaId !== 'string' || !MEDIA_ID_RE.test(mediaId)) throw new SttToolError('mediaId must be the id of an asset in the media library.', { code: 'bad-args' });
    const engine = args.engine ?? cfg.defaultEngine;
    if (!STT_ENGINES.includes(engine)) throw new SttToolError(`engine must be ${STT_ENGINES.join(' or ')}.`, { code: 'bad-args' });
    const model = args.model ?? cfg.defaultModel;
    if (!STT_MODELS.includes(model)) throw new SttToolError(`model must be one of ${STT_MODELS.join(', ')}.`, { code: 'bad-args' });
    let language = args.language;
    if (language !== undefined && (typeof language !== 'string' || !(language === 'auto' || LANGUAGE_RE.test(language)))) {
      throw new SttToolError('language must be a language code (such as zh, en), or omitted to let the engine detect it automatically.', { code: 'bad-args' });
    }
    if (language === '' || language === 'auto') language = undefined;
    return { mediaId, engine, model, language };
  }

  /** Environment check before starting work: report truthfully on the spot if not installed, missing weights, or missing ffmpeg; do not start a job */
  async function preflight(context, input) {
    if (!allowedEngines.includes(input.engine)) return unavailable('ENGINE_NOT_ALLOWED', `This cloud node does not offer the ${input.engine} engine.`);
    if (!pythonReady()) return unavailable('PYTHON_MISSING', 'This cloud node has no Python configured for speech recognition, so the Cloud Agent cannot do speech-to-text. Tell the user to contact the host, or transcribe in PromptCut on their computer.');
    let raw;
    try { raw = await probeStatus(context); } catch (error) {
      if (isProbeFailure(error)) return unavailable('STATUS_FAILED', 'The speech recognition environment probe failed, and Python on this node could not run properly. Tell the user to contact the host.');
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

  /** Unused asset read stream: close it and wait for it to truly close (without waiting indefinitely) */
  async function discard(read) {
    try { read.stream.destroy(); } catch { /* Already closed */ }
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
    // Start work only once for the same job in this process: no await between query and register
    // (when two identical calls run concurrently, jobs.start returns queued both times for the same
    // job that is still queued)
    if (started.state !== 'queued' || transcribing.has(started.jobId)) {
      await discard(read);
      return { ok: true, started: false, jobId: started.jobId, mediaId: input.mediaId, state: started.state,
        hint: 'The same transcription was already started in this turn, do not start it again. Get the result with get_transcript, or check this jobId with background_job_status.' };
    }
    transcribing.add(started.jobId);
    let revision = 0;
    try { revision = (await jobs.get(context, started.jobId)).revision; } catch (error) { transcribing.delete(started.jobId); await discard(read); throw error; }
    const state = { context, jobId: started.jobId, revision };
    track(runTranscription(state, input, read).catch(() => { /* Handled internally */ }).finally(() => transcribing.delete(started.jobId)));
    return { ok: true, started: true, jobId: started.jobId, mediaId: input.mediaId, engine: input.engine, model: input.model,
      hint: 'Transcription has started in the background. Poll get_transcript for this mediaId (it is done when segments appear), or check this jobId with background_job_status. Do not start it again.' };
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

      /* 1. Fetch asset into workspace (verifying hash while receiving is done by ProjectAssets) */
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

      /* 2. Wait for transcription slot (only one runs at a time) */
      const signal = resources.signalFor(context);
      release = await slot.acquire(signal);
      signal.throwIfAborted();
      await patchJob(state, { stage: 'transcribe', progress: 0.1 });

      /* 3. Transcribe */
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
          // Stop child process if writing to the store fails (permissions revoked, job cancelled)
          inflight = inflight.then(() => patchJob(state, { progress })).catch((error) => { revoked = error; kill(); });
        },
      });
      await inflight;
      release(); release = null;
      if (revoked || out.aborted || closing) return;           // Permissions revoked or service is closing: leave job status to the host (mark interrupted on cancel/restart)
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

      /* 4. Write back to project: re-verify write permissions before commit; host commit verifies again that asset still exists and is the same copy */
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
      if (rel && ws) { try { ws.remove(rel); } catch { /* Left to be cleaned up when chat is deleted */ } }
      await discard(read);
      if (finalCode) await finishError(state, finalCode);
    }
  }

  /** Exception → job error code; null indicates "not the job's own failure" such as revoked permissions/closing, status is left to host cancellation */
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
    if (typeof args !== 'object' || Array.isArray(args)) throw new SttToolError('Arguments must be an object.', { code: 'bad-args' });
    const extra = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extra.length) throw new SttToolError(`Unknown parameters: ${extra.join(', ')}. Available parameters: ${allowed.length ? allowed.join(', ') : 'none'}.`, { code: 'bad-args' });
  }

  /* ------------------------------------------------------------------ Public */

  async function call(name, args, context) {
    if (!handles.has(name)) throw new SttToolError(`Speech-to-text does not handle ${name}.`, { code: 'unknown-tool', status: 404 });
    if (name === 'stt_status') return sttStatus(args, context);
    if (name === 'stt_install') return sttInstall(args, context);
    return transcribeMedia(args, context);
  }

  /**
   * Close: accept no new calls, kill all running child process trees, wait for them to truly
   * exit + close and background tasks to clean up.
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
