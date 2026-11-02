/**
 * Cloud Agent web media collection (`collect_status`, `collect_install`, `collect_search`,
 * `collect_probe`, `collect_download`, `collect_job`, `collect_logout`; section 9.4d of contract
 * `docs/plan/cloud-agent-contract.md`).
 *
 * In the desktop app, these tools hit editor process `/api/collect/*`, which spawns
 * `python -m promptcut_collect <subcommand>` (containing yt-dlp and ffmpeg).
 * Cloud nodes have no editor process; here we launch the same package following the same CLI
 * and JSONL conventions, with these rules:
 *
 *   - **External programs are spawned only via restricted workspace child processes**
 *     (`spawn` in `workspace.mjs`): working directory is this chat's working directory, environment
 *     variables are rebuilt from a whitelist without any `PROMPTCUT_*`, service private key
 *     directory, or data directory; spawns a killable process tree; on timeout, cancellation,
 *     or limit overrun, the entire tree is killed (downloader and ffmpeg spawned by Python alike),
 *     completing only after exit + close (common implementation in `perception/runner.mjs`);
 *   - **Python is spawned in isolated mode** (`-I`): working directory contains files brought in
 *     by members and models, kept out of the module search path; package directory comes solely
 *     from deployment configuration;
 *   - **Egress only through the egress gate proxy** (`startProxy` in `egress.mjs`): child process
 *     environment contains only `HTTP_PROXY` / `HTTPS_PROXY` pointing to this loopback proxy;
 *     the proxy performs the same checks as the egress gate for each target: loopback, internal
 *     network, cloud vendor metadata URLs, and co-located services are all unreachable. Starts
 *     a proxy for each call and closes it when done;
 *   - **Downloads land only in the chat working directory** (`collect/<job-id>/`), entering the
 *     media library via `import_media` (writing to asset service with member's own asset ticket,
 *     registering on project replica; read-only members are rejected before downloading); deleted
 *     after being stored;
 *   - **Job table is on the server side**, partitioned by instance (project × member) and persisted
 *     with chat to disk (`collect/jobs.json`): after service restart, queries return "interrupted"
 *     rather than "not found";
 *   - **Limits**: download size, duration, and wall-clock time for a single job; concurrent running
 *     jobs across the entire process and per member;
 *   - **Usage**: records one row per call (`service: 'collect'`, based on count and downloaded bytes).
 *
 * **`collect_install` installs nothing in the cloud**: whether collection tools exist on the node
 * is determined by deployment (`PROMPTCUT_AGENT_COLLECT_PYTHON`); the model cannot trigger
 * installation onto the node. Login state (`user_interface_collect_login`) requires users to scan QR
 * codes themselves, as it is a tool "requiring interaction with the initiator UI"; cloud does not
 * store cookies for any site, and downloads use unauthenticated video quality.
 *
 * **Sites requiring login (0.7.18, tool package C1; `collect-bridge.mjs`)**: when the host provides
 * `delegate` (delegation endpoint bound to the current round), `collect_download` queries it first:
 * if the link belongs to a site with login support, the initiator is online using the desktop app,
 * and login state exists on their computer, their computer downloads and uploads directly to this
 * project's media library, and cloud verifies and registers it (`route` of the job is `delegated`);
 * in all other cases, falls back to anonymous downloading in the cloud as usual (`route` is
 * `anonymous`), writing delegation failure reasons and quality differences into job `notes`.
 * `collect_login` and `collect_login_check` operate only on the user's own computer and also go
 * through this endpoint. When `delegate` is not provided, behavior in this file is completely
 * identical to before.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedPythonArgs, splitRoots, superviseChild } from './perception/runner.mjs';

export const COLLECT_DEFAULTS = Object.freeze({
  /** Timeout for status check, probe, and search */
  statusMs: 20_000,
  probeMs: 50_000,
  /** Wall-clock limit for a single download job */
  downloadMs: 15 * 60_000,
  /** Total download size limit for a single job (same number as importing media by URL) */
  maxDownloadBytes: 512 * 1024 * 1024,
  /** Maximum video duration (seconds): stops if probe detects longer */
  maxDurationSeconds: 2 * 3600,
  /** Maximum number of files stored per job (multi-part videos) */
  maxItems: 20,
  /** Concurrent downloads running across the entire process */
  maxRunning: 2,
  /** Concurrent downloads running per member in a project */
  maxRunningPerInstance: 1,
  /** Number of completed jobs retained in the job table */
  historyJobs: 20,
  /** Interval for measuring download directory size */
  watchMs: 1500,
});

/**
 * Response from the two login tools when there is no delegation endpoint (unwired, or not
 * in account mode): truthfully states that operation is only possible on the user's own computer.
 */
const LOGIN_LOCAL_ONLY = (tool) => ({
  ok: false, initiatorOnly: true,
  error: `${tool} can only be used on the initiator's own computer: the login state of a site stays only on their machine, and the cloud neither stores nor can access it. Tell the user to log in in PromptCut on their computer; the cloud will keep collecting at logged-out quality.`,
});
const NOT_INSTALLED = 'This cloud node has no collection tool (yt-dlp) installed. The cloud does not let the Agent install anything on the node: tell the user to contact the host, or to collect on their computer in PromptCut and then import.';
const QUALITIES = new Set([2160, 1440, 1080, 720, 480, 360]);
const SITES = new Set(['auto', 'bilibili', 'generic']);
/** URL provided by model: accepts only http(s) URLs, or Bilibili BV / av IDs */
const URL_OK = /^(?:https?:\/\/[^\s]+|BV[0-9A-Za-z]{10}|av\d{1,12})$/i;

/** Job table for an instance (project × member) */
export const newCollectState = () => ({ jobs: new Map() });

/**
 * Process-level instance.
 * @param {object} o
 * @param {{ python: string, args?: string[], pythonPath?: string, ffmpegDir?: string } | null} o.config
 *   Collection tool on node (determined by deployment); null if not configured
 * @param {{ startProxy(): Promise<{ url: string, close(): Promise<void> }> }} o.egress Egress gate
 */
export function createCollect({ config = null, egress, limits: limitsIn = {}, log = () => {} } = {}) {
  const limits = { ...COLLECT_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect tools */ } };
  let running = 0;
  /**
   * `config.args` is only for probes and unit tests (replaces interpreter with mock script,
   * see `readCollectConfig`); production always uses isolated mode, with package directory
   * from deployment configuration.
   */
  const stubArgs = config && Array.isArray(config.args) && config.args.length ? config.args : null;
  const pythonArgv = (sub, args) => (stubArgs
    ? [...stubArgs, sub, ...args]
    : isolatedPythonArgs('promptcut_collect', { roots: splitRoots(config.pythonPath), args: [sub, ...args] }));

  /**
   * Spawns a collection child process: runs via workspace (working directory, environment whitelist,
   * process tree), providing only the egress gate proxy. Reads JSONL line by line.
   * Returns `{ child, done, kill }`: `done` resolves to `{ code, events, stderrTail }` after
   * the entire process tree has exit + close and proxy is closed; `kill` kills the entire tree.
   */
  async function runCollect(ws, sub, args, { timeoutMs, onEvent = () => {}, signal } = {}) {
    if (!config) throw Object.assign(new Error(NOT_INSTALLED), { notInstalled: true });
    const proxy = await egress.startProxy();
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH';
    // PYTHON* environment variables have no effect in isolated mode (unbuffered, UTF-8, no bytecode,
    // and package directory are all supplied via command line), so they are not set here
    const env = {
      HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, ALL_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url, all_proxy: proxy.url,
      NO_PROXY: '', no_proxy: '',
      ...(config.ffmpegDir ? { [pathKey]: `${config.ffmpegDir}${path.delimiter}${process.env[pathKey] ?? ''}` } : {}),
    };
    let child;
    try {
      child = ws.spawn(config.python, pythonArgv(sub, args), { env });
    } catch (err) {
      await proxy.close().catch(() => {});
      throw err;
    }
    const events = [];
    const stderrTail = [];
    let buf = '';
    const feed = (text) => {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const lineText = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!lineText) continue;
        try { const ev = JSON.parse(lineText); if (ev && typeof ev === 'object') { events.push(ev); onEvent(ev); } } catch { /* Discard non-JSON lines */ }
        if (events.length > 5000) events.splice(0, 1000);
      }
    };
    // Collection is not yet wired to runtime resource registry (it cannot obtain this round's
    // trusted context; wiring belongs to final wiring bundle): cancellation uses caller's signal,
    // timeout handled here
    const run = await superviseChild(child, {
      timeoutMs, signal,
      onStdout: (d) => feed(d.toString('utf8')),
      onStderr: (d) => { for (const l of d.toString('utf8').split(/\r?\n/)) if (l.trim()) { stderrTail.push(l.trim().slice(0, 300)); if (stderrTail.length > 20) stderrTail.shift(); } },
    });
    const done = run.done.then(async (end) => {
      if (buf.trim()) feed('\n');
      if (end.spawnError) stderrTail.push(String(end.spawnError?.message ?? end.spawnError).slice(0, 300));
      await proxy.close().catch(() => {});
      return { code: end.spawnError ? -1 : (end.code ?? -1), events, stderrTail };
    });
    return { child, done, kill: run.kill };
  }

  const pickError = (events, stderrTail, code) => {
    const ev = [...events].reverse().find((e) => e.event === 'error');
    if (typeof ev?.message === 'string' && ev.message) return ev.message.slice(0, 300);
    const useful = [...stderrTail].reverse().find((l) => /error|失败|找不到|failed|cannot find|not found|refused|forbidden/i.test(l)); // i18n-allow
    return (useful || `Collection process exit code ${code}`).slice(0, 300);
  };

  /**
   * Tools for a single chat.
   * @param {object} d
   * @param {ReturnType<typeof newCollectState>} d.state Job table for this instance
   * @param {() => object} d.workspace
   * @param {() => Promise<void>} d.ensureCanWrite
   * @param {(rel: string, name: string) => Promise<{ mediaId: string, kind: string, clipId?: string, duration?: number, width?: number, height?: number, bytes?: number }>} d.importFile
   *   Imports a file from workspace into media library (the `import_media` path)
   * @param {(row: object) => void} d.record
   * @param {null | (() => (null | { download?: Function, login: Function, loginCheck: Function }))} [d.delegate]
   *   Delegation endpoint for current round (`forRun(context)` in `collect-bridge.mjs`); fetched
   *   on demand per call, returns null if unavailable (falling back to cloud anonymous download as usual)
   */
  function forConversation({ state, workspace, ensureCanWrite, importFile, record = () => {}, ToolError = Error, conversationId = '', delegate = null }) {
    const currentDelegate = () => {
      try { const d = typeof delegate === 'function' ? delegate() : null; return d && typeof d.download === 'function' ? d : null; } catch { return null; }
    };
    /**
     * Endpoint used by the two login tools. The host may provide login only without delegated
     * download (when delegated download is not enabled): then `collect_download` falls back to
     * anonymous download in the cloud as usual.
     */
    const currentLogin = () => {
      try { const d = typeof delegate === 'function' ? delegate() : null; return d && typeof d.login === 'function' && typeof d.loginCheck === 'function' ? d : null; } catch { return null; }
    };
    const usage = (model, { bytes = 0, ok = true, ms = 0 } = {}) => {
      try { record({ service: 'collect', vendor: 'yt-dlp', model, units: bytes, unit: 'bytes', ok, ms }); } catch { /* Failure to record usage does not affect the result */ }
    };
    const viewOf = (job) => ({
      jobId: job.id, status: job.status, stage: job.stage, percent: job.percent, speed: job.speed ?? null, eta: job.eta ?? null,
      url: job.url, quality: job.quality, site: job.site, ...(job.route ? { route: job.route } : {}),
      ...(job.info ? { info: job.info } : {}), ...(job.notes.length ? { notes: job.notes.slice(-8) } : {}),
      ...(job.status === 'done' ? { items: job.items, mediaIds: job.items.map((it) => it.mediaId) } : {}),
      ...(job.message ? { message: job.message } : {}),
      startedAt: job.startedAt, finishedAt: job.finishedAt ?? null,
    });

    /**
     * Job table is persisted to disk with chat (only serializable fields); write failure does
     * not affect the job.
     */
    const JOBS_FILE = 'collect/jobs.json';
    function persist() {
      try {
        const mine = [...state.jobs.values()].filter((j) => j.conversationId === conversationId).map((j) => {
          const { child: _c, abort: _a, ...rest } = j;
          return rest;
        });
        workspace().write(JOBS_FILE, JSON.stringify(mine));
      } catch (err) { say('agent.collect.persist-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
    }
    /**
     * Job ID not found in memory: inspect the copy persisted to disk for this chat (service
     * was restarted). Jobs still running last time are now "interrupted".
     */
    function fromDisk(id) {
      try {
        const ws = workspace();
        if (!ws.exists(JOBS_FILE)) return null;
        const saved = JSON.parse(ws.read(JOBS_FILE, { maxBytes: 2 * 1024 * 1024 }).toString('utf8'));
        const job = Array.isArray(saved) ? saved.find((j) => j?.id === id) : null;
        if (!job) return null;
        if (job.status === 'running') { job.status = 'error'; job.message = 'The Cloud Agent service restarted and this download was interrupted. Run collect_download again.'; job.finishedAt ??= Date.now(); }
        return { ...job, notes: Array.isArray(job.notes) ? job.notes : [], items: Array.isArray(job.items) ? job.items : [] };
      } catch { return null; }
    }
    function trim() {
      const done = [...state.jobs.values()].filter((j) => j.status !== 'running');
      for (const old of done.slice(0, Math.max(0, done.length - limits.historyJobs))) state.jobs.delete(old.id);
    }

    const checkUrl = (raw) => {
      const url = typeof raw === 'string' ? raw.trim() : '';
      if (!url || url.length > 2000 || !URL_OK.test(url)) throw new ToolError('url must be a web link starting with http(s), or a Bilibili BV or av number.');
      return url;
    };
    const siteArgs = (site) => (typeof site === 'string' && SITES.has(site) && site !== 'auto' ? ['--site', site] : []);

    async function status() {
      if (!config) {
        return { ok: true, ready: false, cloud: true, ytdlp: { installed: false, version: null }, ffmpeg: null, presets: [], cookies: {}, hint: NOT_INSTALLED };
      }
      const t0 = Date.now();
      const run = await runCollect(workspace(), 'status', [], { timeoutMs: limits.statusMs });
      const out = await run.done;
      const st = out.events.find((e) => e.event === 'status');
      usage('status', { ok: !!st, ms: Date.now() - t0 });
      if (!st) return { ok: true, ready: false, cloud: true, ytdlp: { installed: false, version: null }, ffmpeg: null, presets: [], cookies: {}, hint: `The collection tool cannot start: ${pickError(out.events, out.stderrTail, out.code)}. Tell the user to contact the host.` };
      const { event: _e, pylibs: _p, ffmpeg, ...rest } = st;
      return {
        ok: true, ...rest, ffmpeg: !!ffmpeg, cloud: true, cookies: {},
        hint: rest.ready
          ? 'Cloud collection goes out through the host\'s egress and carries no site login state (logged-out quality); downloads are added to this project\'s media library.'
          : (rest.ytdlp?.installed === false ? NOT_INSTALLED : 'The collection tool is not ready (ffmpeg or another dependency is missing). The tool cannot fix this, so tell the user to contact the host.'),
      };
    }

    async function install() {
      const st = await status();
      if (st.ready) return { ok: true, ready: true, alreadyInstalled: true, hint: 'This cloud node already has the collection tool installed, no need to install it.' };
      return { ok: false, cloudUnavailable: true, error: NOT_INSTALLED };
    }

    async function search(args) {
      const query = typeof args?.query === 'string' ? args.query.trim().slice(0, 200) : '';
      if (!query) throw new ToolError('query cannot be empty');
      const limit = Math.min(10, Math.max(1, Math.round(Number(args.limit) || 5)));
      const site = args.site === 'generic' ? 'generic' : 'bilibili';
      const t0 = Date.now();
      const run = await runCollect(workspace(), 'search', ['--query', query, '--site', site, '--limit', String(limit)], { timeoutMs: limits.probeMs * 2 });
      const out = await run.done;
      const done = out.events.find((e) => e.event === 'done');
      usage('search', { ok: !!done, ms: Date.now() - t0 });
      if (!done) throw new ToolError(`Search failed: ${pickError(out.events, out.stderrTail, out.code)}`);
      const { event: _e, ...rest } = done;
      return { ok: true, ...rest };
    }

    async function probe(args) {
      const url = checkUrl(args?.url);
      const quality = QUALITIES.has(Number(args.quality)) ? ['--quality', String(Number(args.quality))] : [];
      const notes = [];
      const t0 = Date.now();
      const run = await runCollect(workspace(), 'probe', ['--url', url, ...siteArgs(args.site), ...quality], {
        timeoutMs: limits.probeMs,
        onEvent: (ev) => { if (ev.event === 'retry') notes.push(`Temporary error on attempt ${ev.attempt}, retrying in ${ev.wait}s: ${String(ev.message ?? '').slice(0, 160)}`); },
      });
      const out = await run.done;
      const done = out.events.find((e) => e.event === 'done');
      usage('probe', { ok: !!done, ms: Date.now() - t0 });
      if (!done) throw new ToolError(`Probe failed: ${pickError(out.events, out.stderrTail, out.code)}`);
      const { event: _e, formats: _f, ...rest } = done;
      const tooLong = Number(rest.duration) > limits.maxDurationSeconds;
      return { ok: true, ...rest, ...(notes.length ? { notes } : {}), ...(tooLong ? { tooLong: true, hint: `This video is longer than ${Math.round(limits.maxDurationSeconds / 3600)} hours, and the cloud does not download anything that long.` } : {}) };
    }

    async function runDownload(job, args) {
      const ws = workspace();
      const rel = `collect/${job.id}`;
      const outDir = path.dirname(ws.resolve(`${rel}/x`));
      fs.mkdirSync(outDir, { recursive: true });
      const t0 = Date.now();
      let bytes = 0;
      let overLimit = null;
      const staged = [];
      let sawDone = false;
      const dirBytes = () => { let n = 0; try { for (const f of fs.readdirSync(outDir, { withFileTypes: true })) if (f.isFile()) n += fs.statSync(path.join(outDir, f.name)).size; } catch { /* Writing */ } return n; };
      const argv = ['--url', job.url, '--out-dir', outDir, '--quality', String(job.quality), ...siteArgs(job.site),
        ...(args.audioOnly === true ? ['--audio-only'] : []), ...(args.allParts === true ? ['--all-parts'] : []), ...(args.keepCodec === true ? ['--keep-codec'] : [])];
      let run = null;
      let watch = null;
      try {
        run = await runCollect(ws, 'download', argv, {
          timeoutMs: limits.downloadMs, signal: job.abort.signal,
          onEvent: (ev) => {
            if (ev.event === 'info') {
              job.info = { id: ev.id, title: ev.title, duration: ev.duration, uploader: ev.uploader, webpage_url: ev.webpage_url };
              if (Number(ev.duration) > limits.maxDurationSeconds) { overLimit = `This video is longer than ${Math.round(limits.maxDurationSeconds / 3600)} hours, and the cloud does not download anything that long`; run?.kill(); }
            } else if (ev.event === 'retry') {
              job.notes.push(`Temporary error on attempt ${ev.attempt}, retrying in ${ev.wait}s: ${String(ev.message ?? '').slice(0, 160)}`);
            } else if (ev.event === 'progress') {
              const p = typeof ev.percent === 'number' ? ev.percent : undefined;
              job.stage = String(ev.stage ?? 'video');
              job.speed = typeof ev.speed === 'number' ? ev.speed : null;
              job.eta = typeof ev.eta === 'number' ? ev.eta : null;
              if (job.stage === 'transcode') job.percent = Math.round(97 + (p ?? 0) * 0.03);
              else if (job.stage === 'merge') job.percent = p && p >= 100 ? 99 : 97;
              else if (typeof ev.overall === 'number') job.percent = Math.round(ev.overall);
              else if (p != null) job.percent = Math.round(p * 0.9);
            } else if (ev.event === 'item') {
              if (staged.length < limits.maxItems) staged.push(ev);
            } else if (ev.event === 'done') {
              sawDone = true;
            }
          },
        });
        job.child = run.child;
        // Download size: measured while downloading, stopped if exceeded (proxy only routes
        // destinations, does not track download volume)
        watch = setInterval(() => {
          bytes = dirBytes();
          if (bytes > limits.maxDownloadBytes && !overLimit) { overLimit = `The download exceeds the ${Math.round(limits.maxDownloadBytes / (1024 * 1024))} MB limit`; run.kill(); }
        }, limits.watchMs);
        watch.unref?.();
        const out = await run.done;
        clearInterval(watch); watch = null;
        bytes = Math.max(bytes, dirBytes());
        job.child = null;
        if (job.abort.signal.aborted) { job.status = 'error'; job.message = 'Cancelled'; return; }
        if (overLimit || bytes > limits.maxDownloadBytes) { job.status = 'error'; job.message = `${overLimit ?? 'The download exceeds the limit'}, stopped and not added to the library.`; return; }
        if (!sawDone) {
          const timedOut = Date.now() - t0 >= limits.downloadMs - 500;
          job.status = 'error';
          job.message = timedOut ? `The download exceeded the ${Math.round(limits.downloadMs / 60_000)} minute time limit and was stopped.` : pickError(out.events, out.stderrTail, out.code);
          if (out.events.some((e) => e.notInstalled)) job.message = NOT_INSTALLED;
          return;
        }
        // Store into library: only accepts files at this level in job directory (takes last segment
        // of reported filename); paths elsewhere are rejected unconditionally
        job.stage = 'ingest';
        for (const ev of staged) {
          const filename = path.basename(String(ev.filename ?? '') || String(ev.path ?? ''));
          // Downloader-generated filename may contain characters rejected by workspace: rename to a safe
          // name in job directory first, then verify via workspace (links pointing outside are still rejected)
          const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1] ?? '').toLowerCase();
          const fileRel = `${rel}/item-${job.items.length}${ext ? `.${ext}` : ''}`;
          let exists = false;
          try {
            const from = path.join(outDir, filename);
            if (filename && fs.lstatSync(from).isFile()) { fs.renameSync(from, path.join(outDir, path.basename(fileRel))); exists = ws.exists(fileRel); }
          } catch { exists = false; }
          if (!exists) { job.status = 'error'; job.message = `The collection process reported the file "${filename || '(no file name)'}", but it is not in the job directory`; return; }
          try {
            const media = await importFile(fileRel, filename);
            job.items.push({
              title: typeof ev.title === 'string' ? ev.title.slice(0, 200) : undefined, filename,
              mediaId: media.mediaId, kind: media.kind, ...(media.clipId ? { clipId: media.clipId } : {}),
              duration: media.duration ?? (Number.isFinite(ev.duration) ? ev.duration : undefined), width: media.width ?? ev.width, height: media.height ?? ev.height,
              vcodec: typeof ev.vcodec === 'string' ? ev.vcodec : undefined, bytes: media.bytes,
            });
          } catch (err) {
            job.status = 'error';
            job.message = `Download finished but could not be added to the media library: ${String(err?.message ?? err).slice(0, 200)}`;
            return;
          }
        }
        if (!job.items.length) { job.status = 'error'; job.message = 'The collection process said it finished, but reported no files.'; return; }
        job.status = 'done'; job.stage = 'done'; job.percent = 100;
      } catch (err) {
        job.status = 'error';
        job.message = String(err?.message ?? err).slice(0, 300);
      } finally {
        if (watch) clearInterval(watch);
        job.child = null;
        job.finishedAt = Date.now();
        running = Math.max(0, running - 1);
        usage('download', { bytes, ok: job.status === 'done', ms: Date.now() - t0 });
        // Job directory is deleted after use (stored files are in asset service; unstored files
        // are discarded)
        try { fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Left to be cleaned up when chat is deleted */ }
        trim();
        persist();
        say('agent.collect.job', { status: job.status, bytes, items: job.items.length, ms: Date.now() - t0 });
      }
    }

    /**
     * End-to-end download job: queries delegation endpoint first if available; if delegation
     * succeeds, the job is complete; if it fails (or delegation was not needed), proceeds with
     * anonymous download in the cloud.
     * When delegation endpoint says "this round can no longer write", does not proceed with
     * anonymous download.
     */
    async function runJob(job, args, delegated) {
      if (delegated) {
        const t0 = Date.now();
        let out;
        try {
          out = await delegated.download({ id: job.id, url: job.url, quality: job.quality, site: job.site }, args, {
            signal: job.abort.signal,
            onProgress: (p) => {
              if (job.route !== 'delegated') { job.route = 'delegated'; persist(); }
              if (typeof p?.stage === 'string') job.stage = p.stage;
              if (typeof p?.percent === 'number') job.percent = Math.max(0, Math.min(99, Math.round(p.percent)));
            },
          });
        } catch (err) {
          say('agent.collect.delegate-failed', { code: String(err?.code ?? 'error').slice(0, 60) });
          out = { delegated: false, why: 'failed', note: 'Download on the delegator\'s computer failed; switched to a cloud download at logged-out quality, which may be lower than logged-in quality.' };
        }
        if (out?.delegated === true || out?.stop === true) {
          const ok = out.delegated === true && Array.isArray(out.items) && out.items.length > 0;
          job.route = 'delegated';
          if (ok) { job.items = out.items; job.status = 'done'; job.stage = 'done'; job.percent = 100; job.notes.push('This link was downloaded by the initiator\'s own computer using the login state on their machine, and the file was uploaded straight from their computer to this project\'s media library; the login information never left their computer.'); }
          else { job.status = 'error'; job.message = job.abort.signal.aborted ? 'Cancelled' : String(out.message ?? 'Download on the delegator\'s computer failed.').slice(0, 300); }
          job.finishedAt = Date.now();
          running = Math.max(0, running - 1);
          usage('delegate', { bytes: ok ? job.items.reduce((sum, it) => sum + (Number(it.bytes) || 0), 0) : 0, ok, ms: Date.now() - t0 });
          trim();
          persist();
          say('agent.collect.job', { status: job.status, route: 'delegated', items: job.items.length, ms: Date.now() - t0 });
          return;
        }
        if (typeof out?.note === 'string' && out.note) job.notes.push(out.note.slice(0, 300));
      }
      job.route = 'anonymous';
      job.stage = 'starting'; job.percent = 0;
      if (!config) {
        job.status = 'error'; job.message = NOT_INSTALLED; job.finishedAt = Date.now();
        running = Math.max(0, running - 1);
        trim(); persist();
        return;
      }
      if (job.abort.signal.aborted) {
        job.status = 'error'; job.message = 'Cancelled'; job.finishedAt = Date.now();
        running = Math.max(0, running - 1);
        trim(); persist();
        return;
      }
      persist();
      await runDownload(job, args);
    }

    async function download(args) {
      const url = checkUrl(args?.url);
      const delegated = currentDelegate();
      if (!config && !delegated) return { ok: false, cloudUnavailable: true, error: NOT_INSTALLED };
      // Downloads go to media library: read-only members are rejected before downloading
      // (avoids wasting bandwidth)
      await ensureCanWrite();
      const mine = [...state.jobs.values()].filter((j) => j.status === 'running').length;
      if (mine >= limits.maxRunningPerInstance) throw new ToolError(`${mine} downloads are already running. Wait for one to finish (check progress with collect_job) before starting the next.`);
      if (running >= limits.maxRunning) throw new ToolError('The cloud is already running its maximum number of concurrent downloads. Try again in a moment.');
      const job = {
        id: `collect-${randomBytes(6).toString('hex')}`, conversationId, url,
        quality: QUALITIES.has(Number(args.quality)) ? Number(args.quality) : 1080,
        site: typeof args.site === 'string' && SITES.has(args.site) ? args.site : 'auto',
        status: 'running', stage: 'starting', percent: 0, speed: null, eta: null, info: null, notes: [], items: [], message: null, route: null,
        startedAt: Date.now(), finishedAt: null, abort: new AbortController(), child: null,
      };
      if (typeof args.cookies === 'string' && args.cookies) job.notes.push('The cloud stores no login state for any site, so the cookies parameter was not used (downloaded at logged-out quality).');
      state.jobs.set(job.id, job);
      running += 1;
      persist();
      void runJob(job, args ?? {}, delegated);
      return { ok: true, jobId: job.id, status: 'running', hint: 'The download runs in the background in the cloud. Check progress with collect_job, and wait 3 seconds between checks; it is in the media library only when status is done and mediaIds is present.' };
    }

    async function jobOf(args) {
      const id = String(args?.jobId ?? '');
      const job = state.jobs.get(id) ?? fromDisk(id);
      if (!job) throw new ToolError('This download job was not found.');
      return { ok: job.status !== 'error', ...viewOf(job) };
    }

    return {
      collect_status: status,
      collect_install: install,
      collect_search: search,
      collect_probe: probe,
      collect_download: download,
      collect_job: jobOf,
      collect_logout: async () => ({ ok: true, loggedOut: false, note: 'The cloud stores no login state for any site, so there is nothing to log out of.' }),
      /**
       * Login is operated only on the user's own computer: if delegation endpoint exists, instructs
       * initiator page via reverse channel to open local login window (returns offline if user is
       * not online); otherwise states truthfully.
       */
      collect_login: async (args) => { const d = currentLogin(); return d ? d.login(args ?? {}) : LOGIN_LOCAL_ONLY('user_interface_collect_login'); },
      collect_login_check: async (args) => { const d = currentLogin(); return d ? d.loginCheck(args ?? {}) : LOGIN_LOCAL_ONLY('collect_login_check'); },
      /** Called when this chat ends or is deleted: stops its running downloads */
      stopAll() { for (const j of state.jobs.values()) if (j.conversationId === conversationId && j.status === 'running') j.abort.abort(); },
    };
  }

  return { available: !!config, forConversation, limits, describe: () => ({ installed: !!config, running }) };
}

/**
 * Reads collection tool on node from environment variables (determined by deployment).
 * Returns null if not configured.
 *   PROMPTCUT_AGENT_COLLECT_PYTHON     Python interpreter with yt-dlp installed (absolute path;
 *                                      spawns `promptcut_collect` in isolated mode, package
 *                                      directory is `python/` in checkout. Isolated mode ignores
 *                                      user site: yt-dlp must be installed in this interpreter's
 *                                      own site-packages or virtualenv)
 *   PROMPTCUT_AGENT_COLLECT_TEST_ARGS  **Only for probes and unit tests**: JSON array replacing
 *                                      isolated mode flags and package name (replacing interpreter
 *                                      with a mock script). Unset in production; if set, logs
 *                                      contain `agent.collect.test-runner`
 */
export function readCollectConfig(env, { root }) {
  const python = env.PROMPTCUT_AGENT_COLLECT_PYTHON;
  if (typeof python !== 'string' || !python) return null;
  if (!path.isAbsolute(python) || !fs.existsSync(python)) return { error: 'PROMPTCUT_AGENT_COLLECT_PYTHON must be the absolute path of an existing interpreter' };
  let args = null;
  if (env.PROMPTCUT_AGENT_COLLECT_TEST_ARGS) {
    try { const a = JSON.parse(env.PROMPTCUT_AGENT_COLLECT_TEST_ARGS); if (Array.isArray(a) && a.every((x) => typeof x === 'string')) args = a; } catch { /* Error below */ }
    if (!args) return { error: 'PROMPTCUT_AGENT_COLLECT_TEST_ARGS must be a JSON array of strings' };
  }
  const ffmpeg = env.PROMPTCUT_FFMPEG && path.isAbsolute(env.PROMPTCUT_FFMPEG) ? path.dirname(env.PROMPTCUT_FFMPEG) : null;
  return { python, ...(args ? { args, testRunner: true } : {}), pythonPath: path.join(root, 'python'), ...(ffmpeg ? { ffmpegDir: ffmpeg } : {}) };
}
