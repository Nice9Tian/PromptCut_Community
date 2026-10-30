import { cliCommand, cliEnv, resolveCli, setupRoot } from './cli-runtime.mjs';
import { execFile } from 'node:child_process';
import { codexAuthState } from './codex-auth-state.mjs';
const resolveExe = resolveCli;

const cache = new Map();

function runCommand(cmd, args, provider) {
  return new Promise((resolve) => {
    const { command: actualCmd, args: actualArgs } = cliCommand(cmd, args);
    execFile(actualCmd, actualArgs, {
      timeout: 15000,
      env: cliEnv(provider),
      windowsHide: true,
      shell: false
    }, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error
      });
    });
  });
}

export async function probeAuth(providerId, opts = {}) {
  const state = providerId === 'codex' ? codexAuthState() : null;
  const generation = state?.snapshot().revision;
  const key = `${setupRoot()}:${providerId}:${generation || ''}`;
  const now = Date.now();
  if (!opts.raw && !opts.refresh && cache.has(key)) {
    const cached = cache.get(key);
    if (now - cached.time < 10000) {
      return state ? state.effective(cached.result) : cached.result;
    }
  }

  let result = { loggedIn: null };

  if (providerId === 'claude') {
    const exe = resolveExe('claude');
    result.loginCommand = ['claude', 'auth', 'login'];
    const { stdout, stderr, error } = await runCommand(exe, ['auth', 'status'], providerId);
    
    let parsed = null;
    try {
      const match = stdout.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        parsed = JSON.parse(stdout);
      }
    } catch {}

    if (parsed && typeof parsed.loggedIn === 'boolean') {
      result.loggedIn = parsed.loggedIn;
      result.detail = `authMethod: ${parsed.authMethod || 'unknown'}, apiProvider: ${parsed.apiProvider || 'unknown'}`;
    } else {
      result.loggedIn = null;
      const combined = (stdout + '\n' + stderr).trim().substring(0, 300);
      result.detail = combined || (error ? `探测命令没跑起来:${error.message}` : 'No output');
    }
  } else if (providerId === 'codex') {
    const exe = resolveExe('codex');
    result.loginCommand = ['codex', 'login'];
    const { stdout, stderr, error } = await runCommand(exe, ['login', 'status'], providerId);
    const output = stdout + '\n' + stderr;

    if (output.includes('config.toml') && (output.includes('unknown variant') || output.includes('unknown field') || output.includes('Error loading configuration'))) {
      result.loggedIn = null;
      const lines = output.split('\n');
      const errorLine = lines.find(l => l.includes('config.toml')) || lines[0] || '';
      result.detail = errorLine.trim();
      
      result.fixHint = `请检查 PromptCut 独立配置目录 ${cliEnv('codex').CODEX_HOME} 中的 config.toml。`;
    } else if (output.includes('Not logged in')) {
      result.loggedIn = false;
    } else if (!error && output.includes('Logged in')) {
      result.loggedIn = true;
    } else {
      result.loggedIn = null;
      const combined = output.trim().substring(0, 300);
      result.detail = combined || (error ? `探测命令没跑起来:${error.message}` : 'No output');
    }
  } else if (providerId === 'agy') {
    const { stdout, stderr, error } = await runCommand(resolveExe('agy'), ['models'], providerId);
    const output = stdout + '\n' + stderr;
    result.loggedIn = !error && /^[\w.-]+\t\S/m.test(stdout) ? true
      : /authentication required|not (?:logged|signed) in|please (?:log|sign) in/i.test(output) ? false : null;
    result.detail = result.loggedIn === true ? '已连接，模型列表获取成功。'
      : result.loggedIn === false ? '请点击登录，在浏览器中完成授权。' : '暂时无法确认连接，请检查网络或重新登录。';
    result.loginCommand = ['agy', 'models'];
  }

  // A probe from before a login/invalidity transition must not seed the new cache.
  if (!state || generation === state.snapshot().revision) cache.set(key, { time: now, result });
  if (state && !opts.raw && generation !== state.snapshot().revision && state.snapshot().state === 'normal') return probeAuth(providerId, { refresh: true });
  return opts.raw ? result : state ? state.effective(generation === state.snapshot().revision ? result : { loggedIn: null }) : result;
}

export function loginCommandFor(providerId) {
  if (providerId === 'claude') return ['claude', 'auth', 'login'];
  if (providerId === 'codex') return ['codex', 'login'];
  if (providerId === 'agy') return ['agy', 'models'];
  return null;
}
