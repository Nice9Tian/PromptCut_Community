import { execFileSync, spawn } from 'node:child_process';
import { probeAuth } from './auth.mjs';
import { getClaudeProvider, startRun as startClaude } from './claude.mjs';
import { getAgyProvider, startRun as startAgy } from './agy.mjs';
import { getCodexProvider, startRun as startCodex } from './codex.mjs';

import { resolveCli, cliCommand, cliEnv } from './cli-runtime.mjs';
import { codexAuthState } from './codex-auth-state.mjs';

export const resolveExe = resolveCli;

/**
 * Detect CLI version. Global npm installs produce .cmd wrappers, while Node due to security
 * restrictions does not allow execFile to execute .cmd/.bat directly (either shell: true, or invoke
 * cmd.exe manually): without this workaround, a CLI installed via the "Install" button would
 * constantly be deemed "not installed".
 * Returns version string; throws if it cannot run, recorded into note by the caller.
 */
export function probeVersion(exePath, args = ['--version']) {
  const opts = { timeout: 15000, encoding: 'utf8', windowsHide: true, env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] };
  const invocation = cliCommand(exePath, args);
  return execFileSync(invocation.command, invocation.args, opts);
}

let providersCache = null;
let providersCacheTime = 0;
let providersCacheKey = '';

export async function listProviders(opts = {}) {
  const now = Date.now();
  const cacheKey = JSON.stringify([cliEnv('codex').CODEX_HOME, codexAuthState().snapshot().revision]);
  if (!opts.refresh && providersCacheKey === cacheKey && providersCache && now - providersCacheTime < 5000) {
    return providersCache;
  }
  // Resolve paths afresh: installers can create launchers without updating this process's PATH.

  const baseProviders = await Promise.all([
    getClaudeProvider(),
    getAgyProvider(),
    getCodexProvider()
  ]);
  
  await Promise.all(baseProviders.map(async (p) => {
    p.auth = p.available ? await probeAuth(p.id, { refresh: !!opts.refresh }) : { loggedIn: false, detail: tr("Please install first") };
  }));

  const providers = [...baseProviders];

  try {
    const mod = await import('./api.mjs');
    const p = await mod.getApiProvider();
    providers.push({ label: tr("Direct API"), ...p, id: 'api' });
  } catch {
    providers.push({
      id: 'api',
      label: tr("Direct API"),
      available: false,
      note: 'api runner missing',
      auth: { loggedIn: false, detail: tr("api runner is not ready yet") }
    });
  }

  const apiEntry = providers.find(p => p.id === 'api');
  if (apiEntry && !apiEntry.auth) {
    try {
      const aiConfig = await import('../ai-config.mjs');
      const cfg = aiConfig.publicConfig();
      apiEntry.auth = {
        loggedIn: cfg.api.apiKey.set,
        detail: cfg.api.apiKey.set ? '' : tr("API key not set yet")
      };
    } catch {
      apiEntry.auth = { loggedIn: false, detail: tr("Failed to get config") };
    }
  }

  // Compose at return time too: invalidation can happen while providers are probing.
  const codex = providers.find(p => p.id === 'codex');
  if (cacheKey !== JSON.stringify([cliEnv('codex').CODEX_HOME, codexAuthState().snapshot().revision]) && codexAuthState().snapshot().state === 'normal') return listProviders({ refresh: true });
  if (codex) codex.auth = codexAuthState().effective(codex.auth);
  if (cacheKey === JSON.stringify([cliEnv('codex').CODEX_HOME, codexAuthState().snapshot().revision])) {
    providersCache = providers;
    providersCacheTime = now;
    providersCacheKey = cacheKey;
  }
  return providersCache;
}

import { startCliLoop } from './cli-loop.mjs';
import { tr } from '../i18n.mjs';

export function startRun(opts) {
  if (opts.provider === 'claude') return startClaude(opts);
  // Review loop runs via agy: launch agy once per role turn (see cli-loop.mjs). Toggle rules are the
  // same as direct API
  if (opts.provider === 'agy' && (opts.reviewLoop ?? !!opts.deepAuto)) return startCliLoop(opts, startAgy);
  if (opts.provider === 'agy') return startAgy(opts);
  if (opts.provider === 'codex') return startCodex(opts);
  if (opts.provider === 'api') {
    let inner = null;
    let aborted = false;
    const done = (async () => {
      let mod;
      try {
        mod = await import('./api.mjs');
      } catch {
        try { opts.onEvent({ type: 'error', message: tr("Direct API is not ready: server/runners/api.mjs is missing or failed to load") }); } catch {}
        return;
      }
      if (aborted) return;
      try {
        inner = mod.startRun(opts);
      } catch (e) {
        try { opts.onEvent({ type: 'error', message: String(e.message) }); } catch {}
        return;
      }
      if (aborted) {
        try { inner.abort(); } catch {}
      }
      try {
        await inner.done;
      } catch (e) {
        try { opts.onEvent({ type: 'error', message: String(e.message) }); } catch {}
      }
    })();
    return {
      abort() {
        aborted = true;
        if (inner) {
          try { inner.abort(); } catch {}
        }
      },
      done
    };
  }
  throw new Error(`Unknown provider: ${opts.provider}`);
}

export function lineSplitter(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    let i = 0;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  };
}

export function truncate(s, maxLength) {
  if (typeof s !== 'string') return s;
  return s.length > maxLength ? s.slice(0, maxLength) + '...' : s;
}

export function spawnCli(exePath, args, opts, onEvent, providerName) {
  const safeOnEvent = (ev) => {
    try { onEvent(ev); } catch {}
  };

  const { command: actualCmd, args: actualArgs } = cliCommand(exePath, args);

  const child = spawn(actualCmd, actualArgs, {
    cwd: opts.cwd,
    env: cliEnv(undefined, opts.env || process.env),
    windowsHide: true,
    shell: false
  });

  safeOnEvent({ type: 'status', text: tr("Started {0}", providerName || 'CLI') });

  let stderrBuffer = '';
  let hasDone = false;
  let isAborted = false;
  let closed = false;
  let stopTimer;
  const stopChild = () => {
    if (closed || !child.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => { if (!closed) child.kill('SIGKILL'); });
      killer.on('exit', code => { if (code && !closed) child.kill('SIGKILL'); });
    } else child.kill('SIGKILL');
  };
  
  let resolveDone;
  const donePromise = new Promise(r => { resolveDone = r; });
  let debounceTimer = null;

  const flushStderr = () => {
    if (stderrBuffer) {
      safeOnEvent({ type: 'status', text: truncate(stderrBuffer, 2048) });
      stderrBuffer = '';
    }
  };

  const finish = (ev) => {
    if (hasDone) return;
    hasDone = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (ev?.authReason) stderrBuffer = '';
    else flushStderr();
    if (ev && !isAborted) safeOnEvent(ev);
    if (opts.stopOnFinish && !closed) {
      stopChild();
      // The turn event can precede process exit; done waits for actual cleanup.
      stopTimer = setTimeout(stopChild, 2000);
      stopTimer.unref();
    } else resolveDone();
  };

  child.stderr.on('data', (data) => {
    if (hasDone || isAborted) return;
    stderrBuffer += data.toString('utf8');
    if (stderrBuffer.length > 2048) {
       stderrBuffer = truncate(stderrBuffer, 2048);
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
       flushStderr();
    }, 200);
  });

  child.on('close', (code) => {
    closed = true;
    clearTimeout(stopTimer);
    if (hasDone) { resolveDone(); return; }
    if (isAborted) {
      finish();
      return;
    }
    if (code !== 0 && !hasDone) {
      finish({ type: 'error', message: `Process exited with code ${code}.` });
    } else {
      finish();
    }
  });

  child.on('error', (err) => {
      if (!child.pid) closed = true;
      if (!hasDone) finish({ type: 'error', message: `Spawn failed: ${err.message}` });
  });

  let abortTimer;

  const abort = () => {
    if (isAborted || hasDone) return;
    isAborted = true;
    safeOnEvent({ type: 'status', text: tr("Aborted") });
    
    try { stopChild(); } catch {}

    abortTimer = setTimeout(() => {
      if (!hasDone) {
         if (!opts.stopOnFinish) { hasDone = true; resolveDone(); }
         else stopChild();
      }
    }, 2000);
  };

  const cleanupAbortTimer = () => {
    if (abortTimer) clearTimeout(abortTimer);
  };
  
  child.on('close', cleanupAbortTimer);
  child.on('error', cleanupAbortTimer);

  return { child, safeOnEvent, finish, abort, donePromise };
}
