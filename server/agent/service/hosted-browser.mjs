/**
 * Web operation tools for Cloud Agent (`web_open`, `web_view`, `web_click`, `web_type`,
 * `web_scroll`, `web_read`, `web_close`; package W1 of plan
 * `docs/plan/cloud-agent-tools-implementation.md`). Tool names, parameters, and return shapes
 * match the desktop app (`server/tools/browser.mjs`).
 *
 * In the desktop app, these seven tools are forwarded by the page to `/api/web/*` on the editor
 * process; the entire process shares a single headed browser and a single login state.
 * On cloud nodes with many chats across many users, a separate implementation is provided on the
 * Agent service side:
 *
 *   - **Every call carries a trusted ToolRunContext** (`tool-context.mjs`, constructed from the
 *     current run authorization after the document service confirms messages have been read);
 *     it passes `authorize(read)` before taking action, and passes it once more before handing
 *     results back. If this round is revoked (chat set to private, stopped, Agent turned off)
 *     or has advanced to a new round, stale calls fail these two gates: the page cannot be
 *     manipulated and results cannot be retrieved. Web operations do not modify projects, so
 *     read-only members can also use them [ruling].
 *   - **One browser process, one user data directory, and one egress proxy per "project × chat"**
 *     (`server/web/hosted/session.mjs`): two chats opening the same site cannot see each other's
 *     cookies or login state. Keys are derived solely from trusted run contexts; tool parameters
 *     contain no project, chat, or path.
 *   - **Browser processes attach to the run resources registry** (`run-resources.mjs`): when this
 *     round is revoked, the registry kills the entire process tree; this module waits until
 *     process IDs can no longer be found before considering them closed.
 *   - **Egress goes only through the egress gate** (`egress.mjs`; see
 *     `server/web/hosted/network.mjs` for how proxies and bypass routes are blocked).
 *   - **Manifests are versioned**: indices from stale manifests or indices after the page has
 *     changed are strictly rejected, preventing clicks on unintended elements
 *     (`server/web/hosted/view.mjs`, `hit.mjs`).
 *   - **Never autofill passphrases, verification codes, or card numbers**: the desktop app relies
 *     on tool descriptions to constrain the model; with no human present in the cloud, `web_type`
 *     outright rejects such input fields [ruling].
 *   - **Report honestly when no browser is configured**: when the browser executable is missing
 *     from the node configuration, return "This node has no browser configured"; do not download
 *     or pretend it is available.
 *
 * Retention of user data directories [ruling]:
 *
 *   | When                                       | Browser process | User data directory |
 *   |--------------------------------------------|-----------------|---------------------|
 *   | `web_close`, idle timeout, swapped out to free capacity | Exit | Kept ("login state persists" as stated in tool descriptions) |
 *   | This round stopped, Agent turned off (reclaimed by registry) | Exit | Kept (chat still exists, reused in the next round) |
 *   | Chat set to private (host calls `closeConversation(…, { reason: 'private' })`) | Exit | **Deleted** (the audience allowed to view this chat changed, accumulated state must not carry over); keep only manifest version counter |
 *   | Chat deleted, project deleted (host calls `closeConversation` / `removeProject`) | Exit | Deleted |
 *   | Service shutdown (`close()`)               | Exit            | Kept; stale browsers do not revive on restart, opened pages and stale manifest indices are invalidated |
 *   | User data directory exceeds limit          | -               | Deleted entirely on close |
 *
 * This file does not import `src/`. The central tool table, instances, and wiring are not here
 * (belong to the final wiring package).
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { admitWebTarget } from '../../web/hosted/network.mjs';
import { launchHostedSession, HostedSessionError, reapOrphan, removeDirFully, removeSessionData, pidAlive, HOSTED_BROWSER_ARG_PREFIX } from '../../web/hosted/session.mjs';

export const WEB_TOOL_NAMES = Object.freeze(['web_open', 'web_view', 'web_click', 'web_type', 'web_scroll', 'web_read', 'web_close']);

/** All numbers are defaults of the three-tier mechanism [ruling]; deployers can override them in the node configuration */
export const HOSTED_BROWSER_DEFAULTS = Object.freeze({
  /** Number of concurrently open browsers across the entire Agent service process */
  maxBrowsers: 2,
  /** When capacity is full, browsers idle for this long can be swapped out (closed, directory kept) */
  evictIdleMs: 60_000,
  /** How long a browser can sit idle before closing automatically (directory kept) */
  idleCloseMs: 10 * 60_000,
  /** Maximum duration to wait for a page to load */
  navigationMs: 30_000,
  /** Overall timeout for a single tool call (including load, action, screenshot); must be under the 60 seconds given by the host to the tool */
  actionMs: 50_000,
  /** Maximum duration to wait for navigation to settle after clicks or enter presses */
  settleMs: 10_000,
  /** Timeout for launching the browser */
  launchMs: 30_000,
  /** Timeout for allowing the browser to exit gracefully on close (flushing cookies to disk) */
  gracefulCloseMs: 3_000,
  /** Timeout for waiting for the process tree to truly exit and directories to truly be deleted */
  closeMs: 10_000,
  /** Maximum characters typed per call and delay between keystrokes */
  maxTypeChars: 2_000,
  typeDelayMs: 5,
  /** Typing is chunked, verifying focus remains on the target input before each chunk. Defaults to one character per chunk: if the page moves focus mid-typing, at most one character goes elsewhere */
  typeChunkChars: 1,
  /** Maximum characters returned by `web_read` per call */
  maxReadChars: 20_000,
  /** Maximum page pixels to scroll per call */
  maxScrollPx: 20_000,
  /** Number of concurrently open egress tunnels per browser */
  maxTunnels: 64,
  /** Browser disk cache limit */
  diskCacheBytes: 64 * 1024 * 1024,
  /** User data directory size limit per chat; if exceeded, deleted entirely on close */
  maxProfileBytes: 512 * 1024 * 1024,
});

export class HostedBrowserError extends Error {
  constructor(message, { code = 'web-error', status = 400 } = {}) {
    super(message);
    this.name = 'HostedBrowserError';
    this.code = code;
    this.status = status;
  }
}

const CONTEXT_KEYS = ['projectId', 'conversationId', 'runId', 'runGrantId', 'instanceId', 'instanceGeneration', 'senderAccountId', 'messageId'];
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
const unavailable = (code, error, extra = {}) => ({ ok: false, cloudUnavailable: true, code, error, ...extra });

const NO_BROWSER = 'This node has no browser configured, so the Cloud Agent cannot operate web pages. Tell the user to contact the host, or do this step in PromptCut on their computer.';
const NOT_OPEN = 'The cloud browser is not open right now (no page has been opened yet, or it was closed: idle too long, this turn was stopped, or the service restarted). Open a link with web_open first; all numbers in the earlier manifest are void.';

/** Using id as directory name: strip illegal path characters, then append a hash of the original text (keeping different ids distinct even if sanitized names collide) */
function dirName(id) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 48);
  return `${safe}-${createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;
}

/** Root of browser directories: `<dataDir>/web/` */
export const hostedBrowserRoot = (dataDir) => path.join(path.resolve(dataDir), 'web');

/** Browser directory for a "project × chat": `<dataDir>/web/<project>/<chat>/` (user data directory is `profile/` beneath it) */
export function hostedBrowserDir(dataDir, { projectId, conversationId }) {
  if (typeof projectId !== 'string' || !ID_RE.test(projectId) || typeof conversationId !== 'string' || !ID_RE.test(conversationId)) {
    throw new HostedBrowserError('Invalid project or chat id.', { code: 'bad-scope', status: 400 });
  }
  return path.join(hostedBrowserRoot(dataDir), dirName(projectId), dirName(conversationId));
}

/** Determine whether to retain the user data directory based on reason (see table at file header) */
function removeProfileFor(reason) {
  return reason === 'private' || reason === 'conversation-deleted' || reason === 'project-deleted';
}
/** Chat or project removed: delete manifest version counter as well. Only set to private: retain counter (the model still holds stale manifests; the new browser's version numbers must not collide with them) */
const removeAllFor = (reason) => reason === 'conversation-deleted' || reason === 'project-deleted';

/**
 * @param {object} d
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<{ fenceRevision: number, grantState: string }>, register(context: object, o: { kind: string, resource: object }): Promise<{ signal: AbortSignal, closed: Promise<void> }> }} d.resources
 *   Run resources registry (`createRunResources`)
 * @param {{ admit: Function, admitUrl: Function }} d.egress Egress gate (`createEgressGate`)
 * @param {string} d.dataDir Data directory for the Agent service; browser directories are located under `web/` within it
 * @param {object} [d.runtime] Node configuration provided by the deployer (not from the model)
 * @param {string} [d.runtime.executablePath] Absolute path to browser executable; absence means "no browser configured"
 * @param {'new'|'shell'} [d.runtime.headless] Which headless flavor; defaults to filename detection
 * @param {string[]} [d.runtime.extraArgs] Additional startup arguments (sandbox flags on Linux, etc.); flags modifying proxies or exposing debug ports are dropped
 * @param {string[]} [d.runtime.argPrefix] Leading startup arguments
 * @param {object} [d.limits] Overrides for `HOSTED_BROWSER_DEFAULTS`
 * @param {(event: string, fields?: object) => void} [d.log]
 * @param {typeof launchHostedSession} [d.launchSession] Function to launch session, replaced only for unit tests
 */
export function createHostedBrowserTools({ resources, egress, dataDir, runtime = {}, limits = {}, log = () => {}, puppeteer, now = Date.now, launchSession = launchHostedSession } = {}) {
  if (typeof resources?.authorize !== 'function' || typeof resources?.register !== 'function'
    || typeof egress?.admit !== 'function' || typeof egress?.admitUrl !== 'function'
    || typeof dataDir !== 'string' || !dataDir) {
    throw new HostedBrowserError('Cloud web operation is not fully configured (missing run-resource registrar, egress gate or data directory).', { code: 'web-unconfigured', status: 503 });
  }
  const cfg = { ...HOSTED_BROWSER_DEFAULTS, ...limits };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect tools */ } };
  const root = hostedBrowserRoot(dataDir);
  const handles = new Set(WEB_TOOL_NAMES);
  /** "project\0chat" → session record `{ key, projectId, conversationId, dir, session, bound: Map<contextKey, registration>, timer }` */
  const sessions = new Map();
  /** Launching: concurrent web_open calls in the same chat share a single launch */
  const launching = new Map();
  /** Closing (including registry-triggered ones): `close()` must wait for them */
  const closings = new Set();
  /** "project×chat" → promise for this chat's latest close (including directory deletion). The next launch or `closeConversation` for the same chat waits for it first */
  const closingByKey = new Map();
  /** Closed sessions (removed from `sessions`): those still closing or closed without an exit receipt remain here; `treeClosed` and `closeConversation` report based on this */
  const retired = new Set();
  let closing = false;
  let closePromise = null;

  function noteKeyClosing(key, promise) {
    closingByKey.set(key, promise);
    const done = () => { if (closingByKey.get(key) === promise) closingByKey.delete(key); };
    promise.then(done, done);
    return promise;
  }

  /** Whether a closed session currently has no surviving processes (rechecks processes not confirmed at closing time) */
  function settled(entry) {
    if (entry.lastClose?.exited === true) return true;
    if (!entry.lastClose) return false;
    const left = entry.session.leftovers?.();
    if (left && left.exited && left.alivePids.length === 0 && left.groupLive !== true) { entry.lastClose = { ...entry.lastClose, exited: true, alivePids: [] }; return true; }
    return false;
  }

  const keyOf = (scope) => `${scope.projectId}\0${scope.conversationId}`;
  const contextKey = (context) => JSON.stringify(CONTEXT_KEYS.map((k) => context?.[k]));

  const browserReady = () => {
    if (typeof runtime.executablePath !== 'string' || !runtime.executablePath) return false;
    try { return fs.statSync(runtime.executablePath).isFile(); } catch { return false; }
  };

  /* ------------------------------------------------------------------ Clean up orphans at startup */

  /** Browsers left behind by previous service processes (normally none: browser exits when pipe breaks). Inspect directory by directory and kill any still occupying */
  const swept = (async () => {
    let reaped = 0;
    try {
      for (const project of fs.readdirSync(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        for (const conversation of fs.readdirSync(path.join(root, project.name), { withFileTypes: true })) {
          if (!conversation.isDirectory()) continue;
          // Leave untouched if the service process that spawned it is still alive: during rolling restarts, the old process may still be using it (see reapOrphan)
          const result = await reapOrphan(path.join(root, project.name, conversation.name), { timeoutMs: cfg.closeMs, respectLiveOwner: true });
          if (result.found) reaped += 1;
        }
      }
    } catch { /* Directory does not exist yet: no orphans */ }
    if (reaped) say('agent.web.orphans-swept', { count: reaped });
    return reaped;
  })();

  /* ------------------------------------------------------------------ Session lifecycle */

  /** Number of times closed but PID was still found: even once prevents `close()` from claiming "all child processes closed" */
  let leaked = 0;
  function track(promise) {
    closings.add(promise);
    promise.then((result) => { if (!result?.exited) leaked += 1; closings.delete(promise); }, () => { leaked += 1; closings.delete(promise); });
    return promise;
  }

  /** Close a session and wait for the outcome. Detach from table first: subsequent calls will see it as "not open" */
  function retire(entry, { reason, graceful = true, removeProfile = removeProfileFor(reason), removeAll = removeProfile && removeAllFor(reason) } = {}) {
    if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    entry.retired ??= reason;
    retired.add(entry);
    const closed = track(entry.session.close({ graceful, removeProfile, removeAll, reason }));
    entry.closed = closed;
    closed.then((result) => {
      entry.lastClose = result ?? { exited: false };
      // Those with exit receipts need not be tracked further; those without are kept until recheck passes
      if (entry.closed === closed && settled(entry)) retired.delete(entry);
    }, () => { entry.lastClose = { exited: false, alivePids: [] }; });
    noteKeyClosing(entry.key, closed);
    return closed;
  }

  function touch(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    if (!(cfg.idleCloseMs > 0) || entry.retired) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (sessions.get(entry.key) !== entry) return;
      if (entry.session.busy) { touch(entry); return; }
      void retire(entry, { reason: 'idle' }).catch(() => {});
    }, cfg.idleCloseMs);
    entry.timer.unref?.();
  }

  /** Free up a slot: evict the one idle the longest that has idled long enough; returns false if unable to free */
  async function makeRoom() {
    // The caller has already recorded it in launching, so it is "does not exceed"
    if (sessions.size + launching.size <= cfg.maxBrowsers) return true;
    const idle = [...sessions.values()]
      .filter((e) => !e.session.busy && now() - e.session.lastUsedAt >= cfg.evictIdleMs)
      .sort((a, b) => a.session.lastUsedAt - b.session.lastUsedAt)[0];
    if (!idle) return false;
    await retire(idle, { reason: 'evicted' });
    return sessions.size + launching.size <= cfg.maxBrowsers;
  }

  async function launch(scope) {
    const key = keyOf(scope);
    const existing = launching.get(key);
    if (existing) return existing;
    const task = (async () => {
      await swept;
      // Previous browser for this chat is still closing (including directory deletion when set to private): wait for it. Without waiting, the new browser could read stale cookies being deleted
      while (closingByKey.has(key)) { try { await closingByKey.get(key); } catch { /* Closing records the result itself */ } }
      if (!await makeRoom()) {
        throw new HostedBrowserError('The number of browsers open in the cloud at once has reached its limit; this one was not opened. Try again later; if you are done with a browser in another chat, call web_close.', { code: 'web-busy', status: 429 });
      }
      const dir = hostedBrowserDir(dataDir, scope);
      const session = await launchSession({
        sessionDir: dir,
        executablePath: runtime.executablePath,
        headless: runtime.headless,
        gate: egress,
        limits: cfg,
        argPrefix: Array.isArray(runtime.argPrefix) ? runtime.argPrefix : HOSTED_BROWSER_ARG_PREFIX,
        extraArgs: runtime.extraArgs,
        puppeteer,
        log,
        now,
      });
      const entry = { key, projectId: scope.projectId, conversationId: scope.conversationId, dir, session, bound: new Map(), contexts: new Set(), pendingHandles: new Set(), timer: null, retired: null, closed: null, lastClose: null };
      if (closing) { await track(session.close({ graceful: false, reason: 'host-close' })); throw new HostedBrowserError('Cloud web operation is shutting down.', { code: 'web-closed', status: 503 }); }
      sessions.set(key, entry);
      // Browser terminated on its own (crashed, killed by system): detach from table and verify processes
      session.processGone().then(() => {
        // Processes truly gone: notify the registry (it waits for exit and close events), and detach all attached resources
        for (const ck of [...entry.bound.keys()]) release(entry, ck);
        for (const handle of entry.pendingHandles) { handle.emit('exit'); handle.emit('close'); }
        if (sessions.get(key) === entry) void retire(entry, { reason: 'exited', graceful: false }).catch(() => {});
      });
      return entry;
    })();
    launching.set(key, task);
    try { return await task; } finally { launching.delete(key); }
  }

  /** Detach a run context from this browser: registry treats it as closed (emitting exit and close), and this module stops listening to signals from that round */
  function release(entry, ck) {
    const bound = entry.bound.get(ck);
    if (!bound) return;
    entry.bound.delete(ck);
    bound.registration.signal.removeEventListener('abort', bound.onAbort);
    bound.handle.emit('exit');
    bound.handle.emit('close');
    bound.handle.removeAllListeners();
  }

  /**
   * Attach the browser to the run resources of this round. When this round is revoked, the
   * registry calls `kill()` (killing the whole tree) and signals; receiving the signal here reclaims
   * the session and waits for the process to truly exit.
   *
   * What is handed to the registry is not the browser process itself, but a lightweight handle per
   * round: a browser for a chat spans many rounds, and attaching listeners directly to the process
   * object on every round would only grow unbounded.
   * For any chat, only one round is current at a time (once a new round starts, stale contexts fail
   * authorization), so attaching a new round detaches the old one.
   */
  async function bind(entry, context) {
    const ck = contextKey(context);
    const had = entry.bound.get(ck);
    if (had) return had.registration;
    const handle = new EventEmitter();
    handle.kill = () => entry.session.kill();
    // When registration is rejected (this round already revoked), registry calls kill() and waits for exit and close: so record the handle first to notify it as soon as the process terminates
    entry.pendingHandles.add(handle);
    let registration;
    try { registration = await resources.register(context, { kind: 'child', resource: handle }); }
    catch (error) {
      // Registry has already killed the browser: tear down this session
      void retire(entry, { reason: 'fence', graceful: false, removeProfile: false }).catch(() => {});
      throw error;
    }
    finally { entry.pendingHandles.delete(handle); }
    const onAbort = () => { void retire(entry, { reason: 'fence', graceful: false, removeProfile: false }).catch(() => {}); };
    for (const other of [...entry.bound.keys()]) release(entry, other);
    entry.bound.set(ck, { registration, handle, onAbort });
    entry.contexts.add(ck);
    if (entry.session.processExited) release(entry, ck);
    if (registration.signal.aborted) onAbort();
    else registration.signal.addEventListener('abort', onAbort, { once: true });
    return registration;
  }

  /* ------------------------------------------------------------------ Tools */

  const failure = (error) => {
    if (error instanceof HostedBrowserError) return error;
    if (error instanceof HostedSessionError) {
      if (error.code === 'browser-missing') return null;
      const status = error.code === 'timeout' ? 504 : 503;
      return new HostedBrowserError(error.message, { code: `web-${error.code}`, status });
    }
    return error;
  };

  async function call(name, args, context) {
    if (!handles.has(name)) throw new HostedBrowserError(`Web operation does not handle ${name}.`, { code: 'unknown-tool', status: 404 });
    if (closing) throw new HostedBrowserError('Cloud web operation is shutting down.', { code: 'web-closed', status: 503 });
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      throw new HostedBrowserError('Arguments must be an object.', { code: 'bad-args' });
    }
    const input = args ?? {};
    // First gate: whether this round is still valid right now. Forged, tampered, or contexts from other processes throw here, never touching the browser
    const before = await resources.authorize(context, 'read');
    const scope = { projectId: context.projectId, conversationId: context.conversationId };
    const key = keyOf(scope);

    if (name === 'web_close') {
      const entry = sessions.get(key);
      if (!entry) return { ok: true, closed: true, wasOpen: false };
      const result = await retire(entry, { reason: 'web_close' });
      if (!result.exited) throw new HostedBrowserError('The browser process did not exit within the time limit; the host needs to check the node.', { code: 'web-close-pending', status: 503 });
      return { ok: true, closed: true, wasOpen: true };
    }

    if (!browserReady()) return unavailable('BROWSER_MISSING', NO_BROWSER);

    let entry = sessions.get(key);
    if (entry && (entry.session.closed || entry.session.processExited)) {
      await retire(entry, { reason: 'exited', graceful: false });
      entry = null;
    }
    if (!entry) {
      if (name !== 'web_open') return { ok: false, error: NOT_OPEN, notOpen: true };
      if (typeof input.url !== 'string' || !input.url.trim()) return { ok: false, error: 'url is required' };
      // Disallowed addresses (non-http(s), intranet, metadata…): rejected immediately without launching a browser
      const admitted = await admitWebTarget(egress, input.url);
      if (!admitted.ok) return admitted.result;
      try { entry = await launch(scope); } catch (error) {
        const mapped = failure(error);
        if (mapped === null) return unavailable('BROWSER_MISSING', NO_BROWSER);
        if (mapped instanceof HostedBrowserError && mapped.code === 'web-busy') return { ok: false, code: 'BROWSER_BUSY', error: mapped.message };
        if (mapped instanceof HostedBrowserError && mapped.code === 'web-profile-busy') return { ok: false, code: 'PROFILE_BUSY', error: mapped.message };
        if (mapped instanceof HostedBrowserError && mapped.code === 'web-launch-failed') return unavailable('BROWSER_LAUNCH_FAILED', mapped.message);
        throw mapped;
      }
    }

    const registration = await bind(entry, context);
    // Gate before manipulating the page: if this round was revoked (registry signaled) or this session is already tearing down, do nothing
    const guard = () => {
      if (registration.signal.aborted || entry.retired || closing) {
        throw new HostedBrowserError('Permission for this chat turn has been revoked; the web page was not operated.', { code: 'run-resource-fenced', status: 403 });
      }
    };
    guard();
    touch(entry);
    const session = entry.session;
    let result;
    try {
      if (name === 'web_open') result = await session.open(input.url, { guard });
      else if (name === 'web_view') result = await session.view();
      else if (name === 'web_click') result = await session.click(input, { guard });
      else if (name === 'web_type') result = await session.type(input, { guard });
      else if (name === 'web_scroll') result = await session.scroll(input, { guard });
      else result = await session.read(input);
    } catch (error) {
      // Revoked mid-action: browser already killed, reporting "permissions revoked" rather than internal errors like connection closed
      if (registration.signal.aborted || entry.retired === 'fence') {
        throw new HostedBrowserError('Permission for this chat turn has been revoked; web operation has stopped.', { code: 'run-resource-fenced', status: 403 });
      }
      // Error responses also use fixed sentences: original exception may contain text from the page and is omitted (logs only record the exception class name).
      // Do not return here: error results must equally pass the subsequent authorization recheck before returning results
      const mapped = failure(error);
      if (mapped instanceof HostedBrowserError && mapped.code === 'web-timeout') {
        result = { ok: false, code: 'ACTION_TIMEOUT', error: `This step did not finish within ${Math.round(cfg.actionMs / 1000)} seconds and was stopped. Use web_view to see how the page looks now, or try another address.` };
      } else if ((mapped instanceof HostedBrowserError && mapped.code === 'web-closed') || entry.session.closed) {
        result = { ok: false, error: NOT_OPEN, notOpen: true };
      } else if (mapped instanceof HostedBrowserError) {
        throw mapped;
      } else {
        say('agent.web.action-failed', { tool: name, kind: String(error?.name ?? 'Error').slice(0, 40) });
        result = { ok: false, code: 'ACTION_FAILED', error: 'This step failed (the browser reported an error). Use web_view to see how the page looks now, then decide the next step.' };
      }
    } finally {
      touch(entry);
    }
    // Second gate: before returning page data, this round must still be current and the fence unchanged
    const after = await resources.authorize(context, 'read');
    if (after.fenceRevision !== before.fenceRevision || registration.signal.aborted) {
      throw new HostedBrowserError('Permission for this chat turn changed during the operation; the result was not returned.', { code: 'run-resource-fenced', status: 403 });
    }
    return result;
  }

  /* ------------------------------------------------------------------ Host entrypoints */

  /**
   * Close a chat's browser and wait until processes truly exit. Called by host when chat is set to private or deleted.
   * @param {{ projectId: string, conversationId: string }} scope From authentication and server
   * @param {{ reason?: 'private'|'stop'|'agent-off'|'conversation-deleted'|'project-deleted'|string, removeProfile?: boolean }} [o]
   * @returns {Promise<{ wasOpen: boolean, exited: boolean, alivePids: number[], profileRemoved: boolean }>}
   */
  async function closeConversation(scope, { reason = 'stop', removeProfile = removeProfileFor(reason) } = {}) {
    const dir = hostedBrowserDir(dataDir, scope);
    const key = keyOf(scope);
    const pendingLaunch = launching.get(key);
    if (pendingLaunch) { try { await pendingLaunch; } catch { /* Never launched, nothing to close */ } }
    const prior = closingByKey.get(key);
    const task = (async () => {
      let result = { exited: true, alivePids: [], profileRemoved: false };
      const live = sessions.get(key);
      // Already detached (reclaimed by registry, closed on idle, swapped out): that closing may still be in progress, or it may not have obtained an exit receipt: defer to its result rather than filling in defaults
      const last = live ? null : [...retired].filter((e) => e.key === key).pop() ?? null;
      if (live) result = await retire(live, { reason, graceful: false, removeProfile });
      else if (last) {
        try { result = await retire(last, { reason, graceful: false, removeProfile }); } catch { result = { exited: false, alivePids: [], profileRemoved: false }; }
        result = { ...result, exited: settled(last), alivePids: last.lastClose?.alivePids ?? result.alivePids ?? [] };
      } else if (prior) { try { await prior; } catch { /* That close recorded its own result */ } }
      let profileRemoved = result.profileRemoved === true;
      if (removeProfile && !profileRemoved) {
        // Browser not open, directory left from earlier: verify no lingering processes are occupying it before deleting
        await reapOrphan(dir, { timeoutMs: cfg.closeMs });
        profileRemoved = await removeSessionData(dir, { keepRev: !removeAllFor(reason), timeoutMs: cfg.closeMs });
      }
      return { wasOpen: Boolean(live), exited: result.exited === true, alivePids: result.alivePids ?? [], profileRemoved };
    })();
    noteKeyClosing(key, task);
    return task;
  }

  /** Project deleted: close browsers and delete directories for all chats under it */
  async function removeProject(projectId) {
    if (typeof projectId !== 'string' || !ID_RE.test(projectId)) throw new HostedBrowserError('Invalid project id.', { code: 'bad-scope' });
    const mine = [...sessions.values()].filter((e) => e.projectId === projectId);
    const results = await Promise.all(mine.map((e) => retire(e, { reason: 'project-deleted', graceful: false, removeProfile: true })));
    const dir = path.join(root, dirName(projectId));
    try {
      for (const conversation of fs.readdirSync(dir, { withFileTypes: true })) {
        if (conversation.isDirectory()) await reapOrphan(path.join(dir, conversation.name), { timeoutMs: cfg.closeMs });
      }
    } catch { /* Directory does not exist */ }
    const removed = await removeDirFully(dir, { timeoutMs: cfg.closeMs });
    return { closed: results.length, exited: results.every((r) => r.exited), removed };
  }

  /**
   * Whether the browser process tree under this execution context is indeed gone (used by
   * the runtime resource registry's `childTreeWitness`).
   * Returns false if still open or close did not obtain exit proof (recorded PIDs are still alive,
   * or living processes remain in the process group); returns true only when every close verified
   * that "all have exited".
   */
  async function treeClosed(context) {
    const ck = contextKey(context);
    for (const entry of sessions.values()) if (entry.bound.has(ck)) return false;
    for (const entry of [...retired]) {
      if (!entry.contexts.has(ck)) continue;
      try { await entry.closed; } catch { /* Result recorded in lastClose */ }
      // Closed but failed to verify "all have exited": re-verify once; if still unverified, return false
      // (the registry receipt remains incomplete)
      if (!settled(entry)) return false;
      retired.delete(entry);
    }
    return true;
  }

  /**
   * The web page URL currently open in this chat's cloud browser (used exclusively by
   * `web_handoff` in `hosted-handoff.mjs`).
   * First checks authorization for this round; returns null if no page is open or the browser has
   * already exited. Returns only the URL, not page content.
   */
  async function handoffTarget(context) {
    await resources.authorize(context, 'read');
    const entry = sessions.get(keyOf({ projectId: context.projectId, conversationId: context.conversationId }));
    if (!entry || entry.retired || entry.session.closed || entry.session.processExited) return null;
    const url = typeof entry.session.currentUrl === 'function' ? entry.session.currentUrl() : null;
    return url && /^https?:///i.test(url) ? { url } : null;
  }

  /**
   * Browser egress log for a chat (whether each target is allowed or denied; for probes, tests,
   * and troubleshooting forensics. Hostnames stay here only and do not enter service logs).
   */
  function egressJournal(scope) {
    const entry = sessions.get(keyOf(scope));
    return entry ? entry.session.proxy.journal() : [];
  }

  function describe() {
    return {
      configured: browserReady(),
      open: sessions.size,
      launching: launching.size,
      closing: closings.size,
      limits: { maxBrowsers: cfg.maxBrowsers, idleCloseMs: cfg.idleCloseMs, navigationMs: cfg.navigationMs, actionMs: cfg.actionMs },
      sessions: [...sessions.values()].map((e) => ({
        projectId: e.projectId, conversationId: e.conversationId, browserPid: e.session.browserPid,
        pids: e.session.pids(), alive: e.session.pids().filter(pidAlive).length, proxyPort: e.session.proxy.port,
        mode: e.session.mode, egress: e.session.proxy.stats(),
      })),
    };
  }

  /**
   * Close: accepts no new calls, kills the entire process tree of all browsers, waits until PIDs
   * can no longer be found, and closes proxies. Keeps user data directories.
   * @returns {Promise<{ childrenClosed: boolean, streamsClosed: boolean, workPending: number }>}
   */
  function close(reason = 'close') {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await Promise.allSettled([...launching.values()]);
      const results = await Promise.allSettled([...sessions.values()].map((e) => retire(e, { reason: `host-${reason}`.slice(0, 40), graceful: false, removeProfile: false })));
      const finished = await Promise.race([Promise.allSettled([...closings]).then(() => true), sleep(cfg.closeMs * 2).then(() => false)]);
      const ok = results.every((r) => r.status === 'fulfilled' && r.value.exited);
      const proxies = results.every((r) => r.status === 'fulfilled' && r.value.proxyClosed);
      return { childrenClosed: finished && ok && leaked === 0, streamsClosed: finished && proxies, workPending: closings.size + sessions.size };
    })();
    return closePromise;
  }

  return Object.freeze({ handles, call, close, closeConversation, removeProject, treeClosed, describe, egressJournal, handoffTarget, ready: swept });
}
