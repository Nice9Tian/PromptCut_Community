/**
 * Subject detection for Cloud Agent (`subject_status`, `subject_install`, `detect_subjects`,
 * `list_subjects`; package breakdown table P4 in `docs/plan/cloud-agent-tools-implementation.md`).
 *
 * In the desktop app, these four tools call `/api/subject/*` on the editor process
 * (`server/vite-plugin-subject.ts`), jobs are stored in RAM, and results are written back to the
 * project by the page. There is no editor process on cloud nodes; here we launch the same Python
 * package (`promptcut_subject`, launched in isolated mode) following the same command-line and
 * JSONL conventions, with the rules:
 *
 *   - **Context comes only from F0**: each call carries `context` with the trusted eight fields
 *     issued by `tool-context.mjs`; before reading assets, spawning processes, or writing to
 *     projects each time, re-verify current doc grant / fence using `authorize` from
 *     `run-resources.mjs`, trusting no project or path in tool arguments;
 *   - **Assets are fetched only via `openRead` in `project-assets.mjs`** (with hash verification)
 *     into the working directory of this chat (`subject/<job id>/`), deleted after the run;
 *     Python reads only this local file and adds `--local-only`, ffmpeg / ffprobe are only
 *     allowed to read local files;
 *   - **Child processes are spawned only via workspace restricted child process** (`spawn` in
 *     `workspace.mjs`: environment variable allowlist, no popups, spawned as a killable process
 *     tree), and registered to `run-resources.mjs` (kind `child`): when stopped in this round,
 *     switched to private, Agent closed, or service closed, considered closed only after the
 *     process tree is truly killed and both `exit` and `close` have arrived (killing trees, waiting
 *     for cleanup, and registration use shared implementation `runner.mjs`);
 *   - **Python is launched in isolated mode** (`-I`, `isolatedPythonArgs` in `runner.mjs`): the
 *     working directory is the chat workspace, containing files brought in by members and the model,
 *     prevented from entering module search paths; package directories and controlled installation
 *     directories come only from deployment config, passed in via bootstrap code;
 *   - **Jobs are recorded in persistent ledger of `tool-jobs.mjs`** (`subject.detect` /
 *     `subject.install`): `running` becomes `interrupted` after service restart, not "not found";
 *     the ledger stores only status and progress, Chinese failure reasons and sample counts are
 *     placed in `subject/jobs.json` of the chat workspace;
 *   - **Results are written to current version of project asset**: `project.setMediaSubjects`
 *     carries `mediaRev` from byte retrieval as version expectation; if asset is swapped mid-way,
 *     discard this result without writing; re-verify write permissions before writing (read-only
 *     members are rejected before starting the job);
 *   - **No fallback tier**: if neither tier is usable (`engine` is null), report "unavailable"
 *     truthfully without starting a job doomed to fail; light tier does not falsely claim prompt
 *     takes effect, and full tier reports missing weights truthfully.
 *
 * **`subject_install` is restricted in the cloud**: installs only the locked manifest inside the
 * package (deployers can provide a locked-version `requirements`), accepts no pip arguments;
 * do not install if `pylibs` and `requirements` are not configured (returns "unavailable"). The full
 * tier (torch + 690 MB weights) never goes through online installation anyway, delivered only with
 * deployment.
 *
 * The four tool names listed for this package in the table are in `SUBJECT_TOOL_NAMES`. Wiring for
 * the master tool table (`cloud-tools.mjs`) belongs to package G, untouched by this file. Pure Node,
 * without referencing browser, nor directly importing `src/` (standalone entry points access frontend
 * code only through the loading seam in `server/agent/ssr-host.mjs`): Kernel functions needed to
 * obtain sample times and suggested positions are injected by the host via the `kernel` parameter;
 * if not injected, it is considered "incompletely configured", and the factory rejects directly.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedPythonArgs, splitRoots, superviseChild } from './runner.mjs';

export const SUBJECT_TOOL_NAMES = Object.freeze(['subject_status', 'subject_install', 'detect_subjects', 'list_subjects']);

export const SUBJECT_DEFAULTS = Object.freeze({
  /** Time limit for `status` child process (full tier imports torch, cold start is slow) */
  statusMs: 45_000,
  /** How long status results are cached (each status spawns a Python process) */
  statusCacheMs: 15_000,
  /** Time limit for a detection job: perFrameMs per frame, lower bound minDetectMs (same set of numbers as desktop app) */
  perFrameMs: 20_000,
  minDetectMs: 120_000,
  /** Time limit for online installation of light tier */
  installMs: 10 * 60_000,
  /** Fetch asset into workspace directory: size and timeout */
  maxFetchBytes: 1024 * 1024 * 1024,
  fetchMs: 5 * 60_000,
  /** Detection jobs running concurrently across the entire process */
  maxRunning: 2,
  /** Minimum interval for writing progress to the ledger */
  progressMinMs: 400,
  /** How many jobs to keep in the workspace index */
  historyJobs: 20,
  /** Maximum prompt length */
  maxPromptChars: 300,
});

export class SubjectToolError extends Error {
  constructor(message, code = 'subject-error') {
    super(message);
    this.name = 'SubjectToolError';
    this.code = code;
  }
}

const NOT_CONFIGURED = 'This cloud node has no subject detection configured (the Python interpreter and model weights are provided by the deployer, and the Cloud Agent cannot install them on the node).'
  + ' For position and occlusion judgments, fall back to see_frames and look at the real frames, and do not guess "the person is on the left"; or ask the user to contact the host, or to run detection in PromptCut on their computer.';
const NO_ENGINE = 'Neither subject detection tier works on this cloud node (dependencies or weights are not installed properly), and there is no fallback tier.'
  + ' For position and occlusion judgments, fall back to see_frames and look at the real frames, and do not pretend detection was run; ask the user to contact the host to install it.';
const INSTALL_OFF = 'The Cloud Agent cannot install subject detection on this node: the node has no "controlled install" configuration (a version-pinned dependency manifest and install directory), '
  + 'and the model cannot specify pip arguments itself. Tell the user to contact the host, or to install it in PromptCut on their computer.';

const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{8,128}$/;
const OUTPUT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const INDEX_FILE = 'subject/jobs.json';
const RESERVED = Symbol('reserved');
/** When process has not started, there is no registration and thus no abort signal: provide one that never fires */
const NEVER_ABORTED = Object.freeze({ aborted: false });
const sha = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Subject detection configuration on the node (deployment decision).
 *
 *   PROMPTCUT_AGENT_SUBJECT_PYTHON       Python interpreter with dependencies installed (absolute path). Subject detection is available only when configured
 *   PROMPTCUT_AGENT_SUBJECT_MODELS       Weights directory (absolute path; yunet.onnx, rtdetr_r18vd.onnx, grounding-dino-tiny/)
 *   PROMPTCUT_AGENT_SUBJECT_PYLIBS       Optional: target directory for controlled installation (also enters Python module search paths)
 *   PROMPTCUT_AGENT_SUBJECT_REQUIREMENTS Optional: locked version manifest for controlled installation (absolute path); `subject_install` is allowed only when both this and PYLIBS are provided
 *   PROMPTCUT_AGENT_SUBJECT_WHEELHOUSE   Optional: controlled installation installs only from this local wheel directory (`pip --no-index --find-links`), without network access
 *   PROMPTCUT_FFMPEG                     Absolute path to ffmpeg, its directory is prepended to PATH
 */
export function readSubjectConfig(env, { root }) {
  const python = env.PROMPTCUT_AGENT_SUBJECT_PYTHON;
  if (typeof python !== 'string' || !python) return null;
  if (!path.isAbsolute(python) || !fs.existsSync(python)) return { error: 'PROMPTCUT_AGENT_SUBJECT_PYTHON must be the absolute path of an existing interpreter' };
  const modelsDir = env.PROMPTCUT_AGENT_SUBJECT_MODELS;
  if (typeof modelsDir !== 'string' || !path.isAbsolute(modelsDir) || !fs.existsSync(modelsDir)) {
    return { error: 'PROMPTCUT_AGENT_SUBJECT_MODELS must be the absolute path of an existing weights directory' };
  }
  const pylibs = env.PROMPTCUT_AGENT_SUBJECT_PYLIBS;
  const requirements = env.PROMPTCUT_AGENT_SUBJECT_REQUIREMENTS;
  if (requirements && (!path.isAbsolute(requirements) || !fs.existsSync(requirements))) {
    return { error: 'PROMPTCUT_AGENT_SUBJECT_REQUIREMENTS must be the absolute path of an existing manifest file' };
  }
  if (pylibs && !path.isAbsolute(pylibs)) return { error: 'PROMPTCUT_AGENT_SUBJECT_PYLIBS must be an absolute path' };
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
      try { const ev = JSON.parse(line); if (ev && typeof ev === 'object') onEvent(ev); } catch { /* Discard non-JSON lines */ }
    }
  };
  feed.flush = () => { if (buf.trim()) feed('\n'); };
  return feed;
};

/** Take top boxes by area and round to integers (same standard as desktop app `topBoxes`) */
function topBoxes(boxes, limit = 4) {
  return [...boxes].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, limit).map((b) => ({
    label: b.label, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), conf: Math.round(b.conf * 100) / 100,
  }));
}

/**
 * @param {object} d
 * @param {object | null} d.config Result of `readSubjectConfig`; null if missing (tools report "not configured" truthfully)
 * @param {object} d.resources `createRunResources` in `run-resources.mjs` (register / signalFor / authorize / verifyFence)
 * @param {object} d.assets `createProjectAssets` in `project-assets.mjs` (uses only `openRead`)
 * @param {object} d.jobs `createToolJobs` in `tool-jobs.mjs` (its authorize / verifyFence are wired by host to the same `resources`)
 * @param {(context: object) => (object | Promise<object>)} d.workspace Workspace for this chat (result of `open()` in `workspace.mjs`)
 * @param {object} d.project Narrow interface on project side (package G wires version expectation and operation fence to doc):
 *   `getMedia(context, mediaId)` -> asset record in the current replica of the project, or null (better with `mediaRev`);
 *   `setMediaSubjects(context, { mediaId, expectedMediaRev, subjects, jobId })` -> `{ projectRev? }`, throws error with `code: 'media-changed'` on version mismatch
 * @param {{ startProxy(): Promise<{ url: string, close(): Promise<void> }> } | null} [d.egress] Required only when controlled installation connects to network
 * @param {object} d.kernel Injected by host via ssr-host loading seam: `{ MAX_SUBJECT_TIMES, subjectSampleTimes, suggestPosition }` (required)
 */
export function createSubjectTools({
  config = null, resources, assets, jobs, workspace, project, egress = null,
  kernel = null, limits: limitsIn = {}, now = Date.now, log = () => {},
} = {}) {
  for (const [name, dep, methods] of [['resources', resources, ['register', 'authorize']], ['assets', assets, ['openRead']],
    ['jobs', jobs, ['start', 'update', 'get', 'checkpointRetained']], ['project', project, ['getMedia', 'setMediaSubjects']]]) {
    if (!dep || methods.some((m) => typeof dep[m] !== 'function')) throw new SubjectToolError(`Subject detection is missing a dependency: ${name}`, 'subject-unconfigured');
  }
  if (typeof workspace !== 'function') throw new SubjectToolError('Subject detection is missing a dependency: workspace', 'subject-unconfigured');
  for (const [name, type] of [['MAX_SUBJECT_TIMES', 'number'], ['subjectSampleTimes', 'function'], ['suggestPosition', 'function']]) {
    if (typeof kernel?.[name] !== type) throw new SubjectToolError(`Subject detection is not fully configured: missing kernel item ${name} (the host must inject the kernel via the ssr-host loading seam)`, 'subject-unconfigured');
  }
  const limits = { ...SUBJECT_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect tools */ } };
  /**
   * `config.args` is only for unit tests and probes (replaces interpreter entirely with a stub
   * script); production always uses isolated mode, package directory comes from deployment config.
   */
  const stubArgs = config && Array.isArray(config.args) && config.args.length ? config.args : null;
  const globalArgs = config ? ['--models-dir', config.modelsDir, '--local-only'] : [];
  const pythonArgv = (subArgs) => (stubArgs
    ? [...stubArgs, ...globalArgs, ...subArgs]
    : isolatedPythonArgs('promptcut_subject', { roots: splitRoots(config.pythonPath), args: [...globalArgs, ...subArgs] }));
  const loadKernel = async () => kernel;

  /** Running jobs (this process): jobId -> status. close must wait for child processes to actually close */
  const live = new Map();
  /** Only one detection job per asset at a time: `project\0media` -> jobId */
  const byMedia = new Map();
  let installLive = null;
  /**
   * Number of detection jobs registering in ledger and not yet live (two concurrent calls cannot
   * bypass the limit check at the same time).
   */
  let reserving = 0;
  let installSummary = null;
  let statusCache = null;
  let closing = false;
  const settled = new Set();
  /** Python child processes spawned by this process and not yet closed (including status): close must kill all of them and wait for them to truly close */
  const children = new Set();

  const authorize = async (context, action) => {
    if (closing) throw new SubjectToolError('The Cloud Agent service is shutting down and subject detection no longer accepts new work.', 'subject-closing');
    try { return await resources.authorize(context, action); }
    catch (error) {
      if (error instanceof SubjectToolError) throw error;
      // Cannot reach document service: fail closed, but clarify it is "upstream unavailable" (503),
      // not "no permission" (403)
      if (['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable'].includes(error?.code)) {
        throw Object.assign(new SubjectToolError('The document service is temporarily unreachable, so permissions for this turn could not be confirmed and subject detection did not start. Try again later.', 'authority-unavailable'), { status: 503 });
      }
      throw Object.assign(new SubjectToolError(action === 'write' ? 'This turn has no permission to write to the project (read-only member, stopped, or switched to private), so subject detection did not start.' : 'This turn has no permission to read the project, so subject detection did not start.', 'subject-forbidden'), { status: 403 });
    }
  };

  const workspaceKey = (context) => `${context.projectId}\0${context.conversationId}`;

  /* ---------------------------------------------------------------- Workspace index (things not stored in the ledger such as Chinese reasons and sample counts) */

  function readIndex(ws) {
    try {
      if (!ws.exists(INDEX_FILE)) return [];
      const rows = JSON.parse(ws.read(INDEX_FILE, { maxBytes: 1024 * 1024 }).toString('utf8'));
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    } catch { return []; }
  }
  /** Read-modify-write is completed in a synchronous block; will not interleave within same process */
  function mutateIndex(ws, mutate) {
    try {
      const rows = readIndex(ws);
      mutate(rows);
      ws.write(INDEX_FILE, JSON.stringify(rows.slice(-limits.historyJobs)));
    } catch (err) { say('agent.subject.index-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
  }

  /* ---------------------------------------------------------------- Start Python */

  /**
   * Spawns `promptcut_subject <subcommand>` once (isolated mode). Registers with run-resources
   * (only considered closed once the entire process tree is truly closed), and reads JSONL line by
   * line. Returns `{ done, kill, signal, closed }`: `done` resolves to
   * `{ code, events, stderrTail, timedOut }`.
   */
  async function runPython(context, ws, subArgs, { timeoutMs, env: extraEnv = {}, onEvent = () => {} } = {}) {
    if (!config) throw new SubjectToolError(NOT_CONFIGURED, 'subject-unavailable');
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH';
    // PYTHON* environment variables have no effect in isolated mode (unbuffered, UTF-8, no bytecode,
    // and package directory are all supplied via command line), so they are not set here
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
      // Registration rejected: superviseChild already killed the entire tree and waited for cleanup
      throw new SubjectToolError('This turn no longer has permission to continue (stopped, switched to private, or the Agent was shut down), so the subject detection process was not started.', 'subject-forbidden');
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

  /** Paths and drive letters are not returned to the model */
  const scrub = (text, ws) => {
    let out = String(text ?? '');
    let workDir = null;
    try { workDir = ws?.dir?.() ?? null; } catch { workDir = null; }
    if (workDir) out = out.split(workDir).join('<working directory>');
    for (const secret of [config?.modelsDir, config?.python, ...(config?.pythonPath ?? '').split(path.delimiter), config?.install?.pylibs, config?.install?.requirements, config?.install?.wheelhouse].filter(Boolean)) {
      out = out.split(secret).join('<node directory>');
    }
    return out.replace(/[A-Za-z]:\\[^\s'",)]+/g, '<node directory>');
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
      ? 'full tier: YuNet + RT-DETR + Grounding DINO, can find targets from any text prompt (prompt takes effect).'
      : engine === 'light'
        ? 'light tier: YuNet (faces) + RT-DETR (bodies), recognizes only person and face, prompt has no effect. To find targets by arbitrary words (cat, phone, red car) you need the full tier.'
        : 'Neither tier is usable, so subjects cannot be detected on this machine. For position and occlusion, fall back to viewing images with see_frames; do not guess "the person is on the left" without evidence.';
  }

  /** Check tier once (cached a few seconds). Returns `{ ok, ready, engine, detail?, reason? }`, never throws */
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
      value = { ok: true, ready: false, engine: null, reason: result.timedOut ? 'Subject detection status check timed out' : scrub(tail || 'The interpreter returned no parseable status', ws) };
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
    if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) throw new SubjectToolError('mediaId is required, it is the id of the media (see list_media)', 'bad-args');
    return id;
  };

  const notFound = (id) => new SubjectToolError(`Media ${String(id).slice(0, 80)} not found (no such id, or it is not in the current project)`, 'media-not-found');

  async function detectSubjects(context, args, options = {}) {
    await authorize(context, 'write');
    const mediaId = mediaIdOf(args);
    const k = await loadKernel();
    const ws = await workspace(context);
    const media = await project.getMedia(context, mediaId);
    if (!media) throw notFound(mediaId);
    if (media.kind === 'audio') throw new SubjectToolError(`${media.name} is audio, there is no picture to view`, 'media-kind');
    if (media.pending) throw new SubjectToolError(`${media.name} is not in the asset service yet (upload incomplete or failed), try again later or re-import`, 'media-pending');

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
          ? { engineNote: 'The existing result was produced with the light tier, and its labels are only person / face, so it cannot answer other nouns in the prompt; this machine can currently only run light, so no re-detection was done. Once the full tier is available, pass force:true to re-detect.' }
          : null),
        hint: 'This media has already been detected. Use list_subjects to get the result, or list_shots to see each shot\'s suggestedPosition; to re-detect, pass force:true',
      };
    }
    if (status.engine === null) return { ok: false, cloudUnavailable: true, error: NO_ENGINE, detail: status.detail ?? undefined, reason: status.reason };

    const max = k.MAX_SUBJECT_TIMES;
    const autoRaw = k.subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length;
    let times;
    if (Array.isArray(args?.times) && args.times.length > 0) {
      if (args.times.length > max) throw new SubjectToolError(`At most ${max} sample times per call (received ${args.times.length}), please split into batches`, 'bad-args');
      times = args.times.map(Number).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
    } else times = k.subjectSampleTimes(media);
    if (times.length === 0) throw new SubjectToolError('Cannot compute sample times, the media may have no duration info; you can pass times yourself', 'bad-args');
    const sampledNote = !args?.times && autoRaw > times.length
      ? `The media is long or its shots are fragmented, so sampling was reduced from ${autoRaw} points to ${times.length} points (limit ${max}); shot-level conclusions will be coarser and more shots will have approximate set to true.`
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
        return { jobId: already, started: false, alreadyRunning: true, mediaId, samples: times.length, engine, hint: 'The same subject detection is already running, poll with list_subjects, do not start it again.' };
      }
      throw new SubjectToolError('This media is running another subject detection; wait for it to finish (poll with list_subjects) before re-detecting with different parameters.', 'subject-busy');
    }
    if (live.size + reserving >= limits.maxRunning) throw new SubjectToolError('Too many subject detection jobs are running on the node, try again in a moment.', 'subject-busy');

    const requestId = REQUEST_RE.test(options.requestId ?? '') ? options.requestId : `sd_${randomUUID().replace(/-/g, '')}`;
    // Place placeholder before await: of two concurrent calls on same asset,
    // second sees placeholder and returns busy
    byMedia.set(mediaKey, RESERVED);
    reserving += 1;
    let started;
    try { started = await jobs.start(context, 'subject.detect', digest, requestId); }
    catch (error) {
      byMedia.delete(mediaKey);
      throw new SubjectToolError(`Subject detection could not register the job (${error?.code ?? 'ledger unavailable'})`, 'subject-job');
    } finally { reserving -= 1; }
    if (closing) {
      byMedia.delete(mediaKey);
      void tracker(context, started.jobId).patch({ state: 'interrupted', errorCode: 'SERVICE_CLOSING' });
      throw new SubjectToolError('The Cloud Agent service is shutting down and subject detection no longer accepts new work.', 'subject-closing');
    }
    const result = {
      jobId: started.jobId, started: true, mediaId,
      samples: times.length,
      sampledFrom: media.shots ? 'By shot (20%/50%/80% of each shot)' : 'One point every 2 seconds (shot detection has not been run on this media)',
      ...(sampledNote ? { sampledNote } : null),
      engine, etaSeconds,
      ...(staleEngine ? { staleEngine: true, engineNote: 'The previous batch of results was produced with the light tier and cannot answer the prompt, so this run re-detected (not reused)' } : null),
      hint: 'Subject detection has started in background mode, poll that mediaId with list_subjects; '
        + `Estimated about ${etaSeconds} seconds (engine=${engine}, measured: light about 0.5 s/frame, full about 3 s/frame).`
        + `${engine === 'full' ? 'the full tier is slow, asking once every 10 seconds is enough' : 'asking once every 3 seconds is enough'}, do not ask every second.`
        + ' After it finishes, each shot from list_shots will carry subject and suggestedPosition.',
    };
    if (started.state !== 'queued' || live.has(started.jobId)) {
      // Retry with same requestId: job is already started, do not start a second one
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

  async function runDetectJob(job, ws) {
    const { context, mediaId, times, prompt } = job;
    const track = tracker(context, job.jobId);
    const rel = `subject/${job.jobId}/media`;
    let mediaFile = null;
    const abortedBySignal = () => job.cancelRequested || closing;
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
      const fetchTimer = setTimeout(() => { fetchError = new SubjectToolError('Media fetch timed out', 'fetch-timeout'); read.stream.destroy(); }, limits.fetchMs);
      fetchTimer.unref?.();
      try {
        for await (const piece of read.stream) {
          if (abortedBySignal()) throw new SubjectToolError('Cancelled', 'cancelled');
          fetched += piece.length;
          if (fetched > limits.maxFetchBytes) throw new SubjectToolError('Media is too large, cloud subject detection cannot fetch it', 'too-large');
          writer.write(piece);
        }
        if (fetchError) throw fetchError;
        writer.end();
      } catch (error) {
        writer.abort();
        read.stream.destroy();
        await read.closed.catch(() => {});
        if (abortedBySignal()) return await finishJob(job, ws, track, { state: job.cancelRequested === 'close' || closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SUBJECT_CANCELLED', message: 'Subject detection was cancelled.' });
        const message = error?.code === 'too-large' ? 'Media is too large, cloud subject detection cannot fetch it.' : error?.code === 'fetch-timeout' ? 'Fetching media timed out.' : `Failed to fetch media (${scrub(error?.code ?? error?.message ?? error).slice(0, 80)}).`;
        return await finishJob(job, ws, track, { state: 'error', errorCode: error?.code === 'cancelled' ? 'SUBJECT_CANCELLED' : 'MEDIA_FETCH_FAILED', message });
      } finally { clearTimeout(fetchTimer); job.abortFetch = null; }
      await read.closed.catch(() => {});
      if (abortedBySignal()) return await finishJob(job, ws, track, { state: closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SUBJECT_CANCELLED', message: 'Subject detection was cancelled.' });

      // 2) Spawn Python for frame-extraction detection
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
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SUBJECT_FAILED', message: scrub(error?.message ?? 'The subject detection process failed to start', ws) });
      }
      job.kill = run.kill;
      if (abortedBySignal()) run.kill();
      const outcome = await run.done;
      await run.closed;
      job.kill = null;

      if (abortedBySignal() || run.signal.aborted) {
        return await finishJob(job, ws, track, { state: closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SUBJECT_CANCELLED', message: closing ? 'Subject detection was interrupted by service shutdown and has no result. You can call detect_subjects(force:true) again.' : 'Subject detection was cancelled.' });
      }
      if (outcome.timedOut) {
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SUBJECT_TIMEOUT', message: `Subject detection timed out (over ${Math.round(limitMs / 1000)} seconds) and was force-stopped. You can reduce the number of times, or first confirm the tier with subject_status (the full tier is very slow).` });
      }
      if (!resultEvent) {
        const message = scrub(errorEvent?.message || outcome.stderrTail.join('\n').trim() || (outcome.code === 0 ? 'Subject detection returned no result' : `The subject detection process exited abnormally (code ${outcome.code})`), ws).slice(0, 400);
        return await finishJob(job, ws, track, { state: 'error', errorCode: 'SUBJECT_FAILED', message });
      }
      let subjects;
      try { subjects = toSubjects(resultEvent, prompt, now()); }
      catch (error) { return await finishJob(job, ws, track, { state: 'error', errorCode: 'SUBJECT_FAILED', message: error.message }); }

      // 3) Write current version of project asset (with mediaRev when fetching bytes as expected version)
      const committing = await track.patch({ stage: 'commit', progress: 0.97 });
      if (!committing.ok) {
        // If ledger was cancelled by fence (terminal state), or permissions revoked and ledger
        // cannot be written: do not write to project
        return await finishJob(job, ws, track, { state: 'cancelled', errorCode: 'FENCE_CANCELLED', message: 'This round can no longer write to the project (it was stopped, made private, or permissions changed); the detection result was not written.' });
      }
      try { await authorize(context, 'write'); }
      catch { return await finishJob(job, ws, track, { state: 'cancelled', errorCode: 'FENCE_CANCELLED', message: 'This round can no longer write to the project (it was stopped, made private, or permissions changed); the detection result was not written.' }); }
      if (abortedBySignal()) return await finishJob(job, ws, track, { state: closing ? 'interrupted' : 'cancelled', errorCode: closing ? 'SERVICE_CLOSING' : 'SUBJECT_CANCELLED', message: 'Subject detection was cancelled, the result was not written.' });
      try { await project.setMediaSubjects(context, { mediaId, expectedMediaRev: mediaRev, subjects, jobId: job.jobId }); }
      catch (error) {
        const changed = error?.code === 'media-changed';
        return await finishJob(job, ws, track, {
          state: 'error', errorCode: changed ? 'MEDIA_CHANGED' : 'COMMIT_REJECTED',
          message: changed ? 'This media was replaced or re-imported during detection, so the result no longer matches the new media and was discarded. Please call detect_subjects again.' : `The detection result could not be written to the project (${scrub(error?.code ?? error?.message ?? 'rejected', ws).slice(0, 80)}).`,
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
      if (mediaFile) { try { ws.remove(mediaFile); } catch { /* Left to be cleaned up when chat is deleted */ } try { fs.rmSync(path.dirname(ws.resolve(mediaFile)), { recursive: true, force: true }); } catch { /* Same as above */ } }
    }
  }

  /** Python result event -> shape of `MediaAsset.subjects` in project (aligned with `waitForSubjects` in `src/ai/subject.ts`) */
  function toSubjects(ev, prompt, at) {
    const samples = Array.isArray(ev.samples) ? ev.samples : null;
    const sampleOk = (s) => s && typeof s === 'object' && Number.isFinite(s.t) && Array.isArray(s.boxes)
      && (s.failed === true || (['left', 'right', 'top', 'bottom'].includes(s.safeSide) && s.occupancy && typeof s.occupancy === 'object'));
    if (!samples || samples.length === 0 || !samples.every(sampleOk)) throw new SubjectToolError('The result returned by subject detection has an invalid format and was discarded.', 'bad-result');
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

  const INTERRUPTED = 'The previous subject detection was interrupted by a service restart or shutdown and has no result. You can call detect_subjects again (pass force:true).';

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
      // Ledger is primary; but if job has finalized and ledger was not written (permissions revoked,
      // host fences such as ledger cancelled), final state in workspace index prevails
      const finished = ['done', 'error', 'cancelled', 'interrupted'];
      const state = !ledger
        ? (row.status === 'queued' || row.status === 'running' ? 'interrupted' : row.status)
        : (finished.includes(row.status) && !finished.includes(ledger.state) && !live.has(row.jobId) ? row.status : ledger.state);
      if (state === 'queued' || state === 'running') {
        const percent = Math.max(0, Math.min(99, Math.round((ledger?.progress ?? 0) * 100)));
        return {
          running: true, percent, engine: row.engine,
          ...(media.subjects ? { stale: true, staleNote: 'The previous batch of results is still there, but a new detection is running, so no samples are given here; call this tool again after it finishes' } : null),
        };
      }
      if (state === 'error' || state === 'cancelled' || state === 'interrupted') {
        const message = row.message || (state === 'interrupted' ? INTERRUPTED : 'The previous subject detection did not succeed.');
        throw new SubjectToolError(media.subjects ? `${message} (an earlier successful batch of results is still kept in the project; it is not from this run.)` : message, `job-${state}`);
      }
    }
    if (!media.subjects) return null;
    const s = media.subjects;
    return {
      running: false,
      engine: s.engine,
      engineNote: s.engine === 'full'
        ? 'Grounding DINO. The label is the noun in the prompt; when the prompt is empty it searches for person . face .'
        : 'The light tier of YuNet + RT-DETR. It only recognizes person and face; the prompt has no effect (it is echoed back unchanged in prompt)',
      ...(s.fellBackFrom
        ? { fellBackFrom: s.fellBackFrom, fallbackNote: `Was supposed to run the full tier but fell back to light midway: ${s.fallbackReason ?? 'unknown reason'}. So prompt had no effect, and label can only be person / face.` }
        : null),
      prompt: s.prompt,
      width: s.width,
      height: s.height,
      failedCount: s.failedCount ?? s.samples.filter((sm) => sm.failed).length,
      samples: s.samples.map((sm) => ({
        t: sm.t,
        ...(sm.failed
          ? { failed: true, reason: sm.reason ?? 'This frame could not be extracted', boxes: [], boxCount: 0 }
          : { safeSide: sm.safeSide, ...k.suggestPosition(sm.safeSide, sm.occupancy), occupancy: sm.occupancy, boxes: topBoxes(sm.boxes), boxCount: sm.boxes.length }),
      })),
      hint: 'Coordinates are in original video pixels (the same system as width/height). To arrange cards by shot, look at list_shots directly; there each shot already has these samples grouped by shot.'
        + 'suggestedPosition can be filled directly into a card\'s params.position (it is only ever left / right / bottom, never center); null means all four tiers are occupied by people,'
        + 'check suggestedOccupancy and warning: at that moment there is no position that avoids covering people. A sample with failed set to true means frame extraction failed, not "there is no person in this frame"; do not draw conclusions from it.',
    };
  }

  /* ---------------------------------------------------------------- subject_install */

  async function subjectInstall(context, _args, options = {}) {
    await authorize(context, 'write');
    if (!config) return { ok: false, cloudUnavailable: true, error: NOT_CONFIGURED };
    if (!config.install) return { ok: false, cloudUnavailable: true, error: INSTALL_OFF };
    if (installLive) return { jobId: installLive.jobId ?? null, started: false, alreadyRunning: true, hint: 'Subject recognition is being installed; use subject_status to see whether engine has changed. Do not start it again.' };
    const ws = await workspace(context);
    const status = await readStatus(context, ws, { fresh: true });
    if (status.engine) return { ok: true, ready: true, alreadyInstalled: true, engine: status.engine, hint: `This cloud node already has the ${status.engine} tier; no need to install.` };
    if (installLive) return { jobId: installLive.jobId ?? null, started: false, alreadyRunning: true, hint: 'Subject recognition is being installed; use subject_status to see whether engine has changed. Do not start it again.' };

    const requestId = REQUEST_RE.test(options.requestId ?? '') ? options.requestId : `si_${randomUUID().replace(/-/g, '')}`;
    let started;
    installLive = { jobId: null }; // Placeholder: only one of two concurrent subject_install calls can proceed
    try { started = await jobs.start(context, 'subject.install', sha('subject.install:light'), requestId); }
    catch (error) { installLive = null; throw new SubjectToolError(`Subject recognition install could not register a job (${error?.code ?? 'ledger unavailable'})`, 'subject-job'); }
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
      hint: 'The subject detection light tier is being installed in controlled mode (it only installs the onnxruntime manifest locked by the deployer and accepts no pip arguments). Use subject_status to see whether engine has become light; do not start it again.'
        + ' After installing, weight files (yunet.onnx / rtdetr_r18vd.onnx) may still be missing; the deployer puts them in the node\'s weights directory, and the response will say so.',
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
        installSummary = { state: 'error', finishedAt: now(), message: `Install timed out (over ${Math.round(limits.installMs / 1000)} seconds) and was forcibly terminated.` };
        await track.patch({ state: 'error', errorCode: 'SUBJECT_TIMEOUT' });
        return;
      }
      if (!installed) {
        const pipTail = logTail.filter((l) => /error|no matching|could not/i.test(l)).slice(-2).join(' ');
        const message = scrub([errorEvent?.message || `Install process exit code ${outcome.code}`, pipTail].filter(Boolean).join(' '), ws).slice(0, 500);
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

  /* ---------------------------------------------------------------- External */

  const handlers = {
    subject_status: (context) => subjectStatus(context),
    subject_install: (context, args, options) => subjectInstall(context, args, options),
    detect_subjects: (context, args, options) => detectSubjects(context, args, options),
    list_subjects: (context, args) => listSubjects(context, args),
  };

  return Object.freeze({
    handles: new Set(SUBJECT_TOOL_NAMES),
    /**
     * @param {string} name Tool name
     * @param {object} args Arguments from model (accepts only mediaId / times / prompt / force)
     * @param {object} context Trusted 8 fields issued by F0
     * @param {{ requestId?: string }} [options] Idempotency key from host (tool call id); retrying
     *   with the same id will not start a second job
     */
    call(name, args, context, options = {}) {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
      if (!handler) return Promise.reject(new SubjectToolError(`Subject recognition does not handle ${String(name).slice(0, 60)}`, 'unknown-tool'));
      return Promise.resolve().then(() => handler(context, args ?? {}, options));
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
