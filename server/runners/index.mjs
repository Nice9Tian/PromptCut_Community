import { execFileSync, spawn } from 'node:child_process';
import { probeAuth } from './auth.mjs';
import { getClaudeProvider, startRun as startClaude } from './claude.mjs';
import { getAgyProvider, startRun as startAgy } from './agy.mjs';
import { getCodexProvider, startRun as startCodex } from './codex.mjs';

import { resolveCli, cliCommand, cliEnv } from './cli-runtime.mjs';
import { codexAuthState } from './codex-auth-state.mjs';

export const resolveExe = resolveCli;

/**
 * 探测 CLI 版本。npm 全局装出来的是 .cmd 包装器,而 Node 出于安全限制不允许
 * execFile 直接执行 .cmd/.bat(要么 shell: true,要么自己走 cmd.exe)——
 * 不绕这一下的话,用「安装」按钮装好的 CLI 会一直被判成「未安装」。
 * 返回版本字符串;跑不起来就抛错,由调用方记进 note。
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
    p.auth = p.available ? await probeAuth(p.id, { refresh: !!opts.refresh }) : { loggedIn: false, detail: '请先安装' };
  }));

  const providers = [...baseProviders];

  try {
    const mod = await import('./api.mjs');
    const p = await mod.getApiProvider();
    providers.push({ label: 'API 直连', ...p, id: 'api' });
  } catch {
    providers.push({
      id: 'api',
      label: 'API 直连',
      available: false,
      note: 'api runner 缺失',
      auth: { loggedIn: false, detail: 'api runner 还没就绪' }
    });
  }

  const apiEntry = providers.find(p => p.id === 'api');
  if (apiEntry && !apiEntry.auth) {
    try {
      const aiConfig = await import('../ai-config.mjs');
      const cfg = aiConfig.publicConfig();
      apiEntry.auth = {
        loggedIn: cfg.api.apiKey.set,
        detail: cfg.api.apiKey.set ? '' : '还没填 API Key'
      };
    } catch {
      apiEntry.auth = { loggedIn: false, detail: '获取配置失败' };
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

export function startRun(opts) {
  if (opts.provider === 'claude') return startClaude(opts);
  // 审查环路走 agy:每个角色回合起一次 agy(见 cli-loop.mjs)。开关规则和 API 直连一样
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
        try { opts.onEvent({ type: 'error', message: 'API 直连还没就绪:server/runners/api.mjs 缺失或加载失败' }); } catch {}
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

  safeOnEvent({ type: 'status', text: `已启动 ${providerName || 'CLI'}` });

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
    safeOnEvent({ type: 'status', text: '已中止' });
    
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
