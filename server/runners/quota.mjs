/**
 * CLI 驱动的额度阈值(熔断)。
 *
 * Claude Code 和 Codex 都是订阅制,有 5 小时 / 每周的用量窗口。窗口用完 CLI 会直接拒绝,
 * 而且往往是在一段编排做到一半的时候 —— 所以在用量**逼近**上限(默认 80%)时就把这一路
 * 断掉,抛一条说人话的错误,而不是让 agent 撞墙。
 *
 * 用量从哪儿来(两家都不用碰 TUI,不弹窗、不占前台):
 *   - Claude Code:`claude -p "/usage" --output-format text`,打印模式也认这条斜杠命令,
 *     输出形如「Current session: 18% used · resets Sep 8, 3pm (Asia/Tokyo)」;
 *     API Key 模式没有订阅窗口,输出里没有这些行 → 不支持,不拦。
 *   - Codex:`codex app-server`(JSON-RPC over stdio),initialize 之后调 `account/rateLimits/read`,
 *     primary 是 5 小时窗口、secondary 是每周窗口,都是 usedPercent + resetsAt(unix 秒)。
 *     用的是 PromptCut 自己的 CODEX_HOME(和 runner 一致),没登录就查不到 → 不拦。
 *
 * 什么时候查(createQuotaGuard):
 *   - 每次对话开始前 gate():没查过、或上次查的结果太旧(staleMs)就先查一次再放行;
 *   - 每次对话结束 note(bytes):累计这条路新增的上下文字节数(提示词 + 回复),超过
 *     checkEveryBytes 就在后台再查一次 —— 查到超线,正在跑的同一路对话由调用方掐掉。
 *   查额度这一步失败(没装、没登录、超时)一律**不拦**:阈值是保护,不该变成新的故障点。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cliCommand, cliEnv, resolveCli, setupRoot } from './cli-runtime.mjs';
import { codexAuthState, AUTH_RECOVERY } from './codex-auth-state.mjs';

export const QUOTA_PROVIDERS = ['claude', 'codex'];

export const DEFAULT_QUOTA_CONFIG = Object.freeze({
  enabled: true,
  /** 任一窗口用到这个百分比就熔断 */
  thresholdPercent: 80,
  /** 这条路新增多少字节的上下文后,后台再查一次额度 */
  checkEveryBytes: 256 * 1024,
});

/** 查过的结果多久算旧(gate 时超过这个就重查) */
export const STALE_MS = 10 * 60 * 1000;

export class QuotaExceededError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'QuotaExceededError';
    this.quota = info;
  }
}

/* ---------------- 解析(纯函数,可单测) ---------------- */

const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex' };

/**
 * claude -p "/usage" 的文本:
 *   Current session: 18% used · resets Sep 8, 3pm (Asia/Tokyo)
 *   Current week (all models): 51% used · resets Sep 14, 10am (Asia/Tokyo)
 *   Current week (Fable): 75% used · resets Sep 14, 10am (Asia/Tokyo)
 */
export function parseClaudeUsage(text) {
  const windows = [];
  const re = /^\s*(Current session|Current week[^:\n]*|Current [^:\n]+):\s*(\d{1,3})%\s*used(?:\s*[·•]\s*resets\s+([^\n]+?))?\s*$/gim;
  let m;
  while ((m = re.exec(text || ''))) {
    const label = m[1].trim();
    const id = /session/i.test(label) ? 'session' : /all models/i.test(label) ? 'week' : 'week-' + label.replace(/^Current week\s*\(?|\)?$/gi, '').trim().toLowerCase();
    windows.push({ id, label: zhLabel(label), usedPercent: Math.min(100, Number(m[2])), resetsText: m[3] ? m[3].trim() : null, resetsAt: null });
  }
  return windows;
}

function zhLabel(label) {
  if (/session/i.test(label)) return '当前 5 小时';
  if (/all models/i.test(label)) return '本周(全部模型)';
  const m = /week\s*\(([^)]+)\)/i.exec(label);
  if (m) return `本周(${m[1]})`;
  return label;
}

/** codex app-server 的 account/rateLimits/read 结果 */
export function parseCodexRateLimits(result) {
  const rl = result?.rateLimits;
  if (!rl || typeof rl !== 'object') return [];
  const windows = [];
  const push = (id, w) => {
    if (!w || typeof w.usedPercent !== 'number') return;
    const mins = Number(w.windowDurationMins) || 0;
    const label = id === 'primary'
      ? (mins >= 240 && mins <= 360 ? '当前 5 小时' : mins ? `${Math.round(mins / 60)} 小时窗口` : '短期窗口')
      : (mins >= 10000 && mins <= 10100 ? '本周' : mins ? `${Math.round(mins / 1440)} 天窗口` : '长期窗口');
    windows.push({
      id: id === 'primary' ? 'session' : 'week',
      label,
      usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
      resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
      resetsText: typeof w.resetsAt === 'number' ? formatReset(w.resetsAt * 1000) : null,
      windowMinutes: mins || null,
    });
  };
  push('primary', rl.primary);
  push('secondary', rl.secondary);
  return windows;
}

function formatReset(ms) {
  try {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return null;
  }
}

/**
 * 哪些窗口该参与「拦不拦」的判定 —— **按当前跑的模型筛**。
 *
 * claude 的 /usage 会同时报好几个窗口:
 *   Current session            当前 5 小时,跟模型无关
 *   Current week (all models)  本周全部模型合计
 *   Current week (Fable)       **只有 Fable 这一个模型的**本周额度
 *
 * 原来是拿所有窗口里最高的那个去比阈值,于是 Fable 那一栏一涨,跑 opus / sonnet 的对话
 * 也跟着被熔断 —— 明明那条路的额度还剩很多。用户没选 Fable 的时候,Fable 用了多少
 * 跟他这次对话没有任何关系。
 *
 * 规则:`session` 和 `week`(全部模型)任何时候都算;`week-<模型名>` 只有正在跑那个模型时才算。
 * 模型名匹配用「包含」,因为界面上填的可能是别名 `fable`,也可能是全名 `claude-fable-5-1`。
 * 没指定模型(走驱动默认)时不计入任何模型专属窗口 —— 这时候按全部模型那一栏判,
 * 宁可放过也不误伤。
 */
export function decidingWindows(windows, model) {
  const m = String(model || '').toLowerCase();
  return (windows || []).filter((w) => {
    const id = String(w?.id || '');
    if (!id.startsWith('week-')) return true;
    const name = id.slice(5).trim();
    return !!name && m.includes(name);
  });
}

/** 一组窗口里用量最高的那个 */
function worstOf(windows) {
  return (windows || []).reduce((a, w) => (!a || w.usedPercent > a.usedPercent ? w : a), null);
}

/**
 * 把窗口列表收成一份结果。
 *
 * `maxUsedPercent` / `worst` 是**所有窗口**里最高的那个,给界面显示用 ——
 * 用户想看到自己哪一栏快满了,哪怕这次不跑那个模型。
 * 拦不拦是另一回事,走 decidingWindows,见 verdict()。
 */
export function summarize(provider, windows, extra = {}) {
  const worst = worstOf(windows);
  return {
    provider,
    label: PROVIDER_LABEL[provider] || provider,
    supported: true,
    ok: windows.length > 0,
    checkedAt: extra.checkedAt ?? Date.now(),
    windows,
    maxUsedPercent: worst ? worst.usedPercent : null,
    worst,
    ...(extra.planType ? { planType: extra.planType } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  };
}

/* ---------------- 探测 ---------------- */

function probeDir() {
  const dir = path.join(setupRoot(), 'quota-probe');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function probeClaude({ timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const exe = resolveCli('claude');
    const { command, args } = cliCommand(exe, ['-p', '/usage', '--output-format', 'text']);
    execFile(command, args, { cwd: probeDir(), env: cliEnv('claude'), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const text = (stdout || '').toString();
      const windows = parseClaudeUsage(text);
      if (windows.length) return resolve(summarize('claude', windows));
      const combined = (text + '\n' + (stderr || '')).trim();
      const reason = error ? `claude 没跑起来:${error.message}` : /api key|anthropic api/i.test(combined) ? 'API Key 模式没有订阅额度窗口' : `没在输出里找到用量行:${combined.slice(0, 200)}`;
      resolve({ ...summarize('claude', []), ok: false, error: reason });
    });
  });
}

function probeCodex({ timeoutMs = 20000 } = {}) {
  if (codexAuthState().snapshot().state !== 'normal') return Promise.resolve({ ...summarize('codex', []), ok: false, error: AUTH_RECOVERY });
  return new Promise((resolve) => {
    const exe = resolveCli('codex');
    const { command, args } = cliCommand(exe, ['app-server']);
    let child;
    try {
      child = spawn(command, args, { cwd: probeDir(), env: cliEnv('codex'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ...summarize('codex', []), ok: false, error: `codex 没跑起来:${e.message}` });
    }
    let buf = '';
    let done = false;
    let stderrText = '';
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ...summarize('codex', []), ok: false, error: 'codex app-server 20 秒没回应' + (stderrText ? `:${stderrText.slice(0, 200)}` : '') }), timeoutMs);
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    child.on('error', (e) => finish({ ...summarize('codex', []), ok: false, error: `codex 没跑起来:${e.message}` }));
    child.on('exit', () => finish({ ...summarize('codex', []), ok: false, error: 'codex app-server 提前退出' + (stderrText ? `:${stderrText.slice(0, 200)}` : '') }));
    child.stderr.on('data', (d) => { stderrText += d.toString('utf8'); });
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish({ ...summarize('codex', []), ok: false, error: `initialize 失败:${msg.error.message || JSON.stringify(msg.error)}` });
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish({ ...summarize('codex', []), ok: false, error: `读不到额度:${msg.error.message || JSON.stringify(msg.error)}(没登录?)` });
          const windows = parseCodexRateLimits(msg.result);
          const planType = msg.result?.rateLimits?.planType;
          if (!windows.length) return finish({ ...summarize('codex', []), ok: false, error: '返回里没有额度窗口(没登录?)' });
          return finish(summarize('codex', windows, { planType }));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'promptcut', title: 'PromptCut', version: '0.1.0' } } });
  });
}

/** 查一次用量。不支持的驱动(agy / api)返回 supported:false */
export async function probeQuota(provider, opts = {}) {
  if (provider === 'claude') return probeClaude(opts);
  if (provider === 'codex') return probeCodex(opts);
  return { provider, label: provider, supported: false, ok: false, checkedAt: Date.now(), windows: [], maxUsedPercent: null, worst: null };
}

/* ---------------- 熔断器 ---------------- */

export function normalizeQuotaConfig(raw) {
  const cfg = { ...DEFAULT_QUOTA_CONFIG };
  if (raw && typeof raw === 'object') {
    if (typeof raw.enabled === 'boolean') cfg.enabled = raw.enabled;
    if (Number.isFinite(raw.thresholdPercent)) cfg.thresholdPercent = Math.min(100, Math.max(1, Math.round(raw.thresholdPercent)));
    if (Number.isFinite(raw.checkEveryBytes)) cfg.checkEveryBytes = Math.max(16 * 1024, Math.round(raw.checkEveryBytes));
  }
  return cfg;
}

/** `worst` 传的是**参与判定的那些窗口**里最高的那个,不一定等于 info.worst(那是所有窗口的最高) */
export function exceededMessage(info, thresholdPercent, worst = info.worst) {
  const w = worst;
  const reset = w?.resetsText ? `,${w.label}窗口 ${w.resetsText} 重置` : '';
  return `${info.label} 额度已用 ${w?.usedPercent ?? '?'}%(${w?.label ?? '窗口'}),超过阈值 ${thresholdPercent}%,已中断${reset}。要继续可以在 AI 设置里调高阈值或关掉熔断。`;
}

/**
 * @param deps.probe  查用量的函数(测试里换成假的)
 * @param deps.now    时钟
 */
export function createQuotaGuard(deps = {}) {
  const probe = deps.probe ?? probeQuota;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_MS;
  /** provider → 最近一次结果 */
  const results = new Map();
  /** provider → 正在进行的探测,避免并发重复查 */
  const inflight = new Map();
  /** provider → 上次查过之后新增的上下文字节数 */
  const bytes = new Map();

  async function refresh(provider) {
    if (inflight.has(provider)) return inflight.get(provider);
    const p = (async () => {
      let info;
      try { info = await probe(provider); } catch (e) { info = { provider, label: PROVIDER_LABEL[provider] || provider, supported: true, ok: false, checkedAt: now(), windows: [], maxUsedPercent: null, worst: null, error: String(e?.message || e) }; }
      // 查完的时刻以熔断器自己的时钟为准(探测函数可能是假的 / 时钟可能被测试换掉)
      info.checkedAt = now();
      results.set(provider, info);
      bytes.set(provider, 0);
      return info;
    })().finally(() => inflight.delete(provider));
    inflight.set(provider, p);
    return p;
  }

  /** model:这次对话跑的模型。决定 week-<模型> 那类窗口算不算,见 decidingWindows */
  function verdict(provider, cfg, model) {
    const info = results.get(provider);
    if (!info || !info.ok || !cfg.enabled) return { blocked: false, info };
    const worst = worstOf(decidingWindows(info.windows, model));
    if (worst && typeof worst.usedPercent === 'number' && worst.usedPercent >= cfg.thresholdPercent) {
      return { blocked: true, info, worst, message: exceededMessage(info, cfg.thresholdPercent, worst) };
    }
    return { blocked: false, info, worst };
  }

  return {
    /** 对话开始前:没查过或太旧就查,超线就抛 QuotaExceededError。model 决定模型专属窗口算不算 */
    async gate(provider, rawCfg, model) {
      const cfg = normalizeQuotaConfig(rawCfg);
      if (!cfg.enabled || !QUOTA_PROVIDERS.includes(provider)) return null;
      const cached = results.get(provider);
      if (!cached || now() - cached.checkedAt > staleMs) await refresh(provider);
      const v = verdict(provider, cfg, model);
      if (v.blocked) throw new QuotaExceededError(v.message, v.info);
      return v.info;
    },
    /**
     * 对话结束后记账:新增了多少字节。累计超过 checkEveryBytes 就后台重查,
     * 返回 Promise<verdict | null>(null = 这次没触发重查),调用方拿到 blocked 就去掐正在跑的对话。
     */
    note(provider, n, rawCfg, model) {
      const cfg = normalizeQuotaConfig(rawCfg);
      if (!cfg.enabled || !QUOTA_PROVIDERS.includes(provider)) return null;
      const total = (bytes.get(provider) ?? 0) + Math.max(0, n | 0);
      bytes.set(provider, total);
      if (total < cfg.checkEveryBytes) return null;
      return refresh(provider).then(() => verdict(provider, cfg, model));
    },
    /** 当前缓存(给界面显示);refresh=true 强制重查 */
    async get(provider, { refresh: force = false } = {}) {
      if (!QUOTA_PROVIDERS.includes(provider)) return { provider, supported: false, ok: false, windows: [], maxUsedPercent: null, worst: null };
      if (force || !results.has(provider)) await refresh(provider);
      return results.get(provider);
    },
    bytesSince(provider) { return bytes.get(provider) ?? 0; },
    verdict(provider, rawCfg, model) { return verdict(provider, normalizeQuotaConfig(rawCfg), model); },
  };
}
