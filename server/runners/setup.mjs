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

export function authUrlFrom(text, provider) {
  const hosts = provider === 'codex' ? ['auth.openai.com', 'chatgpt.com'] : provider === 'agy'
    ? ['accounts.google.com', 'antigravity.google', 'www.antigravity.google']
    // claude.com:Claude Code 2.1.x 起登录页在 claude.com/cai/oauth/authorize;少了它,「打开登录网页」的链接就不出现。
    : ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'];
  for (const candidate of text.match(/https:\/\/[^\s<>"\x1b]+/g) || []) {
    try {
      const url = new URL(candidate);
      if (hosts.includes(url.hostname) && !url.username && !url.password) return url.href;
    } catch {}
  }
}

// 授权码的形状:Claude Code 登录页给用户的那串码是 base64url 字符加 '#'(码与 state 之间)。
// 只放这些字符、16～512 长:空白、引号、控制字符、换行一律不收,免得把任意字符串管道给子进程。
// 出错信息里不带输入的任何内容。
const AUTH_CODE_SHAPE = /^[A-Za-z0-9._~+/=%#-]{16,512}$/;
const MAX_CODE_SUBMITS = 5;
export function normalizeAuthCode(input) {
  const code = typeof input === 'string' ? input.trim() : '';
  if (!AUTH_CODE_SHAPE.test(code)) throw new Error('授权码格式不对：应是登录网页上显示的那一整串，不含空格和换行。');
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

  // acceptCode:这条任务的标准输入接成管道,留给用户粘贴的授权码(只有 Claude 的登录用)。其余任务标准输入照旧不接。
  function run(job, command, args, { acceptCode = false, ...options } = {}) {
    return new Promise((resolve, reject) => {
      if (job.cancelRequested) { reject(new Error('已取消')); return; }
      let child;
      try { child = launch(command, args, { windowsHide: true, env: cliEnv(job.provider), stdio: [acceptCode ? 'pipe' : 'ignore', 'pipe', 'pipe'], ...options }); }
      catch (error) { reject(error); return; }
      children.add(child);
      if (acceptCode && child.stdin) {
        // 子进程先退出时往管道写会 EPIPE;吞掉,以任务自己的结果为准。
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
        // 任务一结束就关掉标准输入,不留着挂住进程。
        if (child.acceptsCode) { child.acceptsCode = false; job.acceptsCode = false; try { child.stdin?.destroy(); } catch {} }
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => { timeoutError = new Error('操作超时，请检查网络或代理后重试。'); stop(); }, timeoutMs);
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8');
        stream?.on('data', chunk => append(job, decoder.write(chunk)));
        stream?.on('end', () => append(job, decoder.end()));
      }
      child.once('error', error => finish(new Error(`无法启动：${error.message}`)));
      child.once('close', code => finish(timeoutError || (code === 0 ? null : new Error(job.kind === 'login'
        ? `登录未完成（退出码 ${code}）。请重试；浏览器回调失败时可尝试设备码登录。`
        : `安装程序退出（${code}）。${job.logs.join('\n').slice(-2500)}`))));
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
    job.message = '正在下载并安装官方 CLI…';
    const readableScript = `try { & { ${script} } *>&1 | Out-String -Stream | ForEach-Object { [Console]::WriteLine($_) }; if ($LASTEXITCODE) { exit $LASTEXITCODE } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    try {
      await run(job, 'powershell.exe', encodedPowerShell(readableScript), { env });
      if (job.provider === 'agy' && !verifyInstall) {
        const staged = path.join(agyStage, 'agy.exe');
        await verifyVersion(staged);
        if (job.cancelRequested) throw new Error('已取消');
        const target = path.join(setupRoot(), 'agy');
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(staged, path.join(target, 'agy.exe'));
      }
    } finally {
      try { fs.unlinkSync(file); } catch {}
      try { fs.unlinkSync(path.join(agyStage, 'agy.exe')); fs.rmdirSync(agyStage); } catch {}
    }
    job.message = '正在验证安装结果…';
    if (verifyInstall) await verifyInstall(job.provider);
    else {
      const exe = job.provider === 'claude' ? resolveCli('claude') : path.join(setupRoot(), job.provider, `${job.provider}.exe`);
      await verifyVersion(exe);
    }
    if (job.cancelRequested) throw new Error('已取消');
    job.state = 'succeeded';
    job.message = '安装完成，可以登录了。';
  }

  async function login(job) {
    const state = job.provider === 'codex' ? codexAuthState() : null;
    const generation = state?.beginLogin();
    const cmd = loginCommandFor(job.provider);
    if (!cmd) throw new Error('此服务没有 CLI 登录方式。');
    const exe = resolveCli(cmd[0]);
    await verifyVersion(exe);
    const args = [...cmd.slice(1), ...(job.deviceAuth && job.provider === 'codex' ? ['--device-auth'] : [])];
    const invocation = job.provider === 'agy'
      ? { command: process.execPath, args: [fileURLToPath(new URL('./agy-login.mjs', import.meta.url)), exe] }
      : cliCommand(exe, args);
    job.message = '请在浏览器中完成登录；若没有自动打开，可点击下方登录链接。';
    const cwd = path.join(setupRoot(), 'login');
    fs.mkdirSync(cwd, { recursive: true });
    // 浏览器拉不起来时,用户走登录链接授权后拿到一串码,要粘回命令行(「Paste code here if prompted」),所以 Claude 的登录接上标准输入。
    await run(job, invocation.command, invocation.args, { cwd, acceptCode: job.provider === 'claude' });
    const auth = await verifyAuth(job.provider, { refresh: true, raw: true });
    if (job.cancelRequested) throw new Error('已取消');
    if (auth.loggedIn !== true) throw new Error('登录程序已结束，但尚未确认登录成功。请重试。');
    if (state && !state.completeLogin(generation)) throw new Error('登录状态已更新，请重新确认当前登录。');
    job.state = 'succeeded';
    job.message = '登录成功。';
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
      job.message = '正在取消，请稍候…';
    },
    // 把用户粘贴的授权码写进这条登录任务的标准输入。码是凭证:不进日志、不进 job 字段、出错信息里也不带。
    submitCode(provider, code) {
      const job = jobs.get(provider);
      const child = job && job.kind === 'login' && job.state === 'running' && !job.cancelRequested
        ? [...children].find(c => c.setupJob === job && c.acceptsCode && c.stdin && !c.stdin.destroyed && c.stdin.writable)
        : undefined;
      if (!child) throw new Error('现在没有在等授权码的登录任务。请先点「登录」。');
      const clean = normalizeAuthCode(code);
      if ((job.codeSubmits || 0) >= MAX_CODE_SUBMITS) throw new Error('授权码提交次数太多，请取消后重新登录。');
      job.codeSubmits = (job.codeSubmits || 0) + 1;
      child.stdin.write(`${clean}\n`);
      job.message = '授权码已提交，正在确认登录…';
      return publicView(job);
    },
    start(provider, kind, { deviceAuth = false } = {}) {
      if (!['claude', 'codex', 'agy'].includes(provider) || !['install', 'login'].includes(kind)) throw new Error('未知的 CLI 操作。');
      const active = jobs.get(provider);
      if (active?.state === 'running') return publicView(active);
      const job = { id: randomUUID(), provider, kind, deviceAuth, state: 'running', message: '正在准备…', logs: [], output: '', startedAt: Date.now() };
      jobs.set(provider, job);
      (kind === 'install' ? install(job) : login(job)).catch(error => {
        job.state = 'failed'; job.message = job.cancelRequested ? '已取消，可以重新尝试。' : error.message; delete job.url; delete job.deviceCode; job.output = '';
      });
      return publicView(job);
    },
    dispose() { for (const child of children) child.stopSetup(); },
  };
}
