import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { installPlanFor, manualHintFor } from './install.mjs';
import { cliCommand, cliEnv, resolveCli, setupRoot, psLiteral, encodedPowerShell } from './cli-runtime.mjs';
import { probeAuth, loginCommandFor } from './auth.mjs';
import { codexAuthState } from './codex-auth-state.mjs';
import { tr } from '../i18n.mjs';

export function authUrlFrom(text, provider) {
  const hosts = provider === 'codex' ? ['auth.openai.com', 'chatgpt.com'] : provider === 'agy'
    ? ['accounts.google.com', 'antigravity.google', 'www.antigravity.google']
    // claude.com: From Claude Code 2.1.x onward, the login page is at claude.com/cai/oauth/authorize;
    // without it, the "Open login page" link will not appear.
    : ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'];
  for (const candidate of text.match(/https:\/\/[^\s<>"\x1b]+/g) || []) {
    try {
      const url = new URL(candidate);
      if (hosts.includes(url.hostname) && !url.username && !url.password) return url.href;
    } catch {}
  }
}

// Shape of authorization code: the string given to the user by the Claude Code login page is
// base64url characters plus '#' (between code and state).
// Only allow these characters, length 16-512: whitespace, quotes, control characters, and newlines
// are rejected, avoiding piping arbitrary strings to the child process.
// Error messages do not include any user input.
const AUTH_CODE_SHAPE = /^[A-Za-z0-9._~+/=%#-]{16,512}$/;
const MAX_CODE_SUBMITS = 5;
export function normalizeAuthCode(input) {
  const code = typeof input === 'string' ? input.trim() : '';
  if (!AUTH_CODE_SHAPE.test(code)) throw new Error(tr("Invalid authorization code format: it should be the whole string shown on the login page, with no spaces or line breaks."));
  return code;
}

// One tracked job per provider. Duplicate clicks attach to the existing job.
export function createSetupService({ launch = spawn, verifyAuth = probeAuth, verifyInstall, verifyVersion = async exe => (await import('./index.mjs')).probeVersion(exe), timeoutMs = 600000 } = {}) {
  const jobs = new Map();
  const children = new Set();
  const append = (job, text) => {
    const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (!clean) return;
    if (job.kind === 'login') {
      job.output = (job.output + clean).slice(-16000);
      job.url = authUrlFrom(job.output, job.provider) || job.url;
      const code = job.output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/);
      if (job.deviceAuth && code) job.deviceCode = code[0];
      // Login output may contain tokens; never expose or persist raw output.
    } else {
      job.logs.push(clean.slice(-2000));
      job.logs = job.logs.slice(-30);
    }
  };
  const publicView = job => { const { output, ...result } = job; return { ...result, logs: [...result.logs] }; };

  // acceptCode: pipes stdin for this task, reserved for the authorization code pasted by the user
  // (used only for Claude login). Other tasks leave stdin disconnected as before.
  function run(job, command, args, { acceptCode = false, ...options } = {}) {
    return new Promise((resolve, reject) => {
      if (job.cancelRequested) { reject(new Error('Cancelled')); return; }
      let child;
      try { child = launch(command, args, { windowsHide: true, env: cliEnv(job.provider), stdio: [acceptCode ? 'pipe' : 'ignore', 'pipe', 'pipe'], ...options }); }
      catch (error) { reject(error); return; }
      children.add(child);
      if (acceptCode && child.stdin) {
        // Writing to the pipe when the child process has already exited causes EPIPE; swallow it and rely
        // on the task's own result.
        child.stdin.on('error', () => {});
        child.acceptsCode = true;
        job.acceptsCode = true;
      }
      let settled = false;
      let timeoutError;
      const stop = () => {
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          killer.on('error', () => { if (!settled) child.kill(); });
          killer.on('exit', code => { if (code && !settled) child.kill(); });
        } else child.kill();
      };
      child.stopSetup = stop;
      child.setupJob = job;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        // Close stdin as soon as the task finishes, rather than keeping it open and hanging the process.
        if (child.acceptsCode) { child.acceptsCode = false; job.acceptsCode = false; try { child.stdin?.destroy(); } catch {} }
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => { timeoutError = new Error(tr("Operation timed out. Check your network or proxy and try again.")); stop(); }, timeoutMs);
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8');
        stream?.on('data', chunk => append(job, decoder.write(chunk)));
        stream?.on('end', () => append(job, decoder.end()));
      }
      child.once('error', error => finish(new Error(tr("Cannot start: {0}", error.message))));
      child.once('close', code => finish(timeoutError || (code === 0 ? null : new Error(job.kind === 'login'
        ? tr("Login did not complete (exit code {0}). Please retry; if the browser callback fails, try device code login.", code)
        : tr("Installer exited ({0}). {1}", code, job.logs.join('\n').slice(-2500))))));
    });
  }

  async function install(job) {
    const plan = installPlanFor(job.provider);
    if (!plan) throw new Error(manualHintFor(job.provider));
    const dir = path.join(setupRoot(), 'installers');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${job.provider}-${job.id}.ps1`);
    const env = cliEnv(job.provider);
    if (job.provider === 'codex') {
      env.CODEX_NON_INTERACTIVE = '1';
      env.CODEX_INSTALL_DIR = path.join(setupRoot(), 'codex');
    }
    // agy's installer skips an existing binary, even if it is broken. Stage a
    // fresh binary and verify it before replacing the managed installation.
    const agyStage = path.join(dir, `agy-${job.id}`);
    const extra = job.provider === 'agy' ? ` --dir ${psLiteral(agyStage)} --skip-path --skip-aliases` : '';
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ` +
      `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ` +
      `for ($attempt=0; $attempt -lt 3; $attempt++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri ${psLiteral(plan.url)} -OutFile ${psLiteral(file)}; break } catch { if ($attempt -eq 2) { throw }; Start-Sleep -Seconds 2 } }; ` +
      `& ${psLiteral(file)}${extra}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`;
    job.message = tr("Downloading and installing the official CLI…");
    const readableScript = `try { & { ${script} } *>&1 | Out-String -Stream | ForEach-Object { [Console]::WriteLine($_) }; if ($LASTEXITCODE) { exit $LASTEXITCODE } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    try {
      await run(job, 'powershell.exe', encodedPowerShell(readableScript), { env });
      if (job.provider === 'agy' && !verifyInstall) {
        const staged = path.join(agyStage, 'agy.exe');
        await verifyVersion(staged);
        if (job.cancelRequested) throw new Error('Cancelled');
        const target = path.join(setupRoot(), 'agy');
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(staged, path.join(target, 'agy.exe'));
      }
    } finally {
      try { fs.unlinkSync(file); } catch {}
      try { fs.unlinkSync(path.join(agyStage, 'agy.exe')); fs.rmdirSync(agyStage); } catch {}
    }
    job.message = tr("Verifying the installation…");
    if (verifyInstall) await verifyInstall(job.provider);
    else {
      const exe = job.provider === 'claude' ? resolveCli('claude') : path.join(setupRoot(), job.provider, `${job.provider}.exe`);
      await verifyVersion(exe);
    }
    if (job.cancelRequested) throw new Error('Cancelled');
    job.state = 'succeeded';
    job.message = tr("Installation complete. You can log in now.");
  }

  async function login(job) {
    const state = job.provider === 'codex' ? codexAuthState() : null;
    const generation = state?.beginLogin();
    const cmd = loginCommandFor(job.provider);
    if (!cmd) throw new Error(tr("This service has no CLI login method."));
    const exe = resolveCli(cmd[0]);
    await verifyVersion(exe);
    const args = [...cmd.slice(1), ...(job.deviceAuth && job.provider === 'codex' ? ['--device-auth'] : [])];
    const invocation = job.provider === 'agy'
      ? { command: process.execPath, args: [fileURLToPath(new URL('./agy-login.mjs', import.meta.url)), exe] }
      : cliCommand(exe, args);
    job.message = tr("Complete the login in your browser; if it does not open automatically, click the login link below.");
    const cwd = path.join(setupRoot(), 'login');
    fs.mkdirSync(cwd, { recursive: true });
    // When the browser fails to launch, the user authorizes via the login link and receives a code to
    // paste back into the command line ("Paste code here if prompted"), so Claude login connects to stdin.
    await run(job, invocation.command, invocation.args, { cwd, acceptCode: job.provider === 'claude' });
    const auth = await verifyAuth(job.provider, { refresh: true, raw: true });
    if (job.cancelRequested) throw new Error('Cancelled');
    if (auth.loggedIn !== true) throw new Error(tr("The login program has ended, but login success is not yet confirmed. Please retry."));
    if (state && !state.completeLogin(generation)) throw new Error(tr("The login state has changed. Please re-confirm the current login."));
    job.state = 'succeeded';
    job.message = tr("Login successful.");
    delete job.url;
    delete job.deviceCode;
    job.output = '';
  }

  return {
    list() { return [...jobs.values()].map(publicView); },
    cancel(provider) {
      const job = jobs.get(provider);
      if (!job || job.state !== 'running') return;
      job.cancelRequested = true;
      for (const child of children) if (child.setupJob === job) child.stopSetup();
      // Don't mark terminal until the process exits: a retry must not race the
      // previous installer or a login callback listener still owning its port.
      job.message = tr("Canceling, please wait…");
    },
    // Writes the authorization code pasted by the user to stdin of this login task. The code is a
    // credential: it is not logged, not included in job fields, and omitted from error messages.
    submitCode(provider, code) {
      const job = jobs.get(provider);
      const child = job && job.kind === 'login' && job.state === 'running' && !job.cancelRequested
        ? [...children].find(c => c.setupJob === job && c.acceptsCode && c.stdin && !c.stdin.destroyed && c.stdin.writable)
        : undefined;
      if (!child) throw new Error(tr("No login task is currently waiting for an authorization code. Click \"Log in\" first."));
      const clean = normalizeAuthCode(code);
      if ((job.codeSubmits || 0) >= MAX_CODE_SUBMITS) throw new Error(tr("Too many authorization code submissions. Cancel and log in again."));
      job.codeSubmits = (job.codeSubmits || 0) + 1;
      child.stdin.write(`${clean}\n`);
      job.message = tr("Authorization code submitted, confirming login…");
      return publicView(job);
    },
    start(provider, kind, { deviceAuth = false } = {}) {
      if (!['claude', 'codex', 'agy'].includes(provider) || !['install', 'login'].includes(kind)) throw new Error(tr("Unknown CLI operation."));
      const active = jobs.get(provider);
      if (active?.state === 'running') return publicView(active);
      const job = { id: randomUUID(), provider, kind, deviceAuth, state: 'running', message: tr("Preparing…"), logs: [], output: '', startedAt: Date.now() };
      jobs.set(provider, job);
      (kind === 'install' ? install(job) : login(job)).catch(error => {
        job.state = 'failed'; job.message = job.cancelRequested ? tr("Canceled. You can try again.") : error.message; delete job.url; delete job.deviceCode; job.output = '';
      });
      return publicView(job);
    },
    dispose() { for (const child of children) child.stopSetup(); },
  };
}
