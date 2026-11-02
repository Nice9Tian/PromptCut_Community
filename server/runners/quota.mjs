/**
 * Quota thresholds (circuit breaker) for CLI drivers.
 *
 * Both Claude Code and Codex are subscription-based, with 5-hour / weekly usage windows. When a
 * window is exhausted, the CLI rejects directly, and often midway through an arrangement: so when
 * usage **approaches** the limit (default 80%), this path is cut off, throwing a human-readable
 * error instead of letting the agent hit a wall.
 *
 * Where usage comes from (neither touches the TUI, with no popups and without occupying the foreground):
 *   - Claude Code: `claude -p "/usage" --output-format text`, print mode also accepts this slash command,
 *     with output shaped like "Current session: 18% used · resets Sep 8, 3pm (Asia/Tokyo)";
 *     API Key mode has no subscription window, so these lines are absent in the output
 *     → unsupported, do not block.
 *   - Codex: `codex app-server` (JSON-RPC over stdio); calls `account/rateLimits/read` after initialize,
 *     where primary is a 5-hour window and secondary is a weekly window, both with
 *     usedPercent + resetsAt (unix seconds).
 *     Uses PromptCut's own CODEX_HOME (consistent with runner); cannot be queried if not logged in
 *     → do not block.
 *
 * When to check (createQuotaGuard):
 *   - Before each chat starts gate(): if never checked, or the last checked result is too old (staleMs),
 *     check once before allowing passage;
 *   - After each chat ends note(bytes): accumulate newly added context bytes on this path (prompt + reply);
 *     if exceeding checkEveryBytes, check again in the background: if over the limit, the currently running
 *     chat on the same path is killed by the caller.
 *   If checking quota fails (not installed, not logged in, timed out), **never block**: the threshold
 *   is protection, and should not become a new point of failure.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cliCommand, cliEnv, resolveCli, setupRoot } from './cli-runtime.mjs';
import { codexAuthState, authRecovery } from './codex-auth-state.mjs';
import { tr } from '../i18n.mjs';

export const QUOTA_PROVIDERS = ['claude', 'codex'];

export const DEFAULT_QUOTA_CONFIG = Object.freeze({
  enabled: true,
  /** Circuit-break when any window reaches this percentage */
  thresholdPercent: 80,
  /** How many bytes of new context on this path before re-checking quota in the background */
  checkEveryBytes: 256 * 1024,
});

/** How long before a checked result is considered stale (re-checks at gate if exceeded) */
export const STALE_MS = 10 * 60 * 1000;

export class QuotaExceededError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'QuotaExceededError';
    this.quota = info;
  }
}

/* ---------------- Parsing (pure functions, unit-testable) ---------------- */

const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Text from claude -p "/usage":
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
  if (/session/i.test(label)) return tr("Current 5 hours");
  if (/all models/i.test(label)) return tr("This week (all models)");
  const m = /week\s*\(([^)]+)\)/i.exec(label);
  if (m) return tr("This week ({0})", m[1]);
  return label;
}

/** account/rateLimits/read result from codex app-server */
export function parseCodexRateLimits(result) {
  const rl = result?.rateLimits;
  if (!rl || typeof rl !== 'object') return [];
  const windows = [];
  const push = (id, w) => {
    if (!w || typeof w.usedPercent !== 'number') return;
    const mins = Number(w.windowDurationMins) || 0;
    const label = id === 'primary'
      ? (mins >= 240 && mins <= 360 ? tr("Current 5 hours") : mins ? tr("{0}-hour window", Math.round(mins / 60)) : tr("Short-term window"))
      : (mins >= 10000 && mins <= 10100 ? tr("This week") : mins ? tr("{0}-day window", Math.round(mins / 1440)) : tr("Long-term window"));
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
 * Which windows should participate in the "block or not" verdict: **filtered by the currently running model**.
 *
 * claude's /usage reports multiple windows at the same time:
 *   Current session            current 5 hours, model-agnostic
 *   Current week (all models)  this week's total across all models
 *   Current week (Fable)       weekly quota **for the Fable model only**
 *
 * Previously, the highest value across all windows was compared against the threshold; thus, once
 * the Fable entry rose, chats running opus / sonnet were also circuit-broken: even though plenty of
 * quota remained on that path. When the user did not select Fable, how much Fable was used had
 * nothing to do with this chat.
 *
 * Rule: `session` and `week` (all models) always count; `week-<model-name>` counts only when
 * currently running that model.
 * Model name matching uses "contains", because the UI may specify the alias `fable` or the full
 * name `claude-fable-5-1`.
 * When no model is specified (falling back to driver default), do not count any model-specific
 * windows: in this case, evaluate against the all-models entry, preferring false negatives over
 * false positives.
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

/** The highest usage among a set of windows */
function worstOf(windows) {
  return (windows || []).reduce((a, w) => (!a || w.usedPercent > a.usedPercent ? w : a), null);
}

/**
 * Collapses the window list into a single result.
 *
 * `maxUsedPercent` / `worst` is the highest among **all windows**, used for UI display:
 * users want to see which entry is almost full, even if not running that model this time.
 * Whether to block is another matter, handled via decidingWindows; see verdict().
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

/* ---------------- Probe ---------------- */

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
      const reason = error ? tr("claude failed to run: {0}", error.message) : /api key|anthropic api/i.test(combined) ? tr("API Key mode has no subscription quota window") : tr("No usage line found in the output: {0}", combined.slice(0, 200));
      resolve({ ...summarize('claude', []), ok: false, error: reason });
    });
  });
}

function probeCodex({ timeoutMs = 20000 } = {}) {
  if (codexAuthState().snapshot().state !== 'normal') return Promise.resolve({ ...summarize('codex', []), ok: false, error: authRecovery() });
  return new Promise((resolve) => {
    const exe = resolveCli('codex');
    const { command, args } = cliCommand(exe, ['app-server']);
    let child;
    try {
      child = spawn(command, args, { cwd: probeDir(), env: cliEnv('codex'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ...summarize('codex', []), ok: false, error: tr("codex failed to run: {0}", e.message) });
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
    const timer = setTimeout(() => finish({ ...summarize('codex', []), ok: false, error: tr("codex app-server did not respond within 20 seconds") + (stderrText ? `:${stderrText.slice(0, 200)}` : '') }), timeoutMs);
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    child.on('error', (e) => finish({ ...summarize('codex', []), ok: false, error: tr("codex failed to run: {0}", e.message) }));
    child.on('exit', () => finish({ ...summarize('codex', []), ok: false, error: tr("codex app-server exited early") + (stderrText ? `:${stderrText.slice(0, 200)}` : '') }));
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
          if (msg.error) return finish({ ...summarize('codex', []), ok: false, error: tr("initialize failed: {0}", msg.error.message || JSON.stringify(msg.error)) });
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish({ ...summarize('codex', []), ok: false, error: tr("Cannot read quota: {0} (not logged in?)", msg.error.message || JSON.stringify(msg.error)) });
          const windows = parseCodexRateLimits(msg.result);
          const planType = msg.result?.rateLimits?.planType;
          if (!windows.length) return finish({ ...summarize('codex', []), ok: false, error: tr("The response has no quota window (not logged in?)") });
          return finish(summarize('codex', windows, { planType }));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'promptcut', title: 'PromptCut', version: '0.1.0' } } });
  });
}

/** Checks usage once. Returns supported:false for unsupported drivers (agy / api) */
export async function probeQuota(provider, opts = {}) {
  if (provider === 'claude') return probeClaude(opts);
  if (provider === 'codex') return probeCodex(opts);
  return { provider, label: provider, supported: false, ok: false, checkedAt: Date.now(), windows: [], maxUsedPercent: null, worst: null };
}

/* ---------------- Circuit breaker ---------------- */

export function normalizeQuotaConfig(raw) {
  const cfg = { ...DEFAULT_QUOTA_CONFIG };
  if (raw && typeof raw === 'object') {
    if (typeof raw.enabled === 'boolean') cfg.enabled = raw.enabled;
    if (Number.isFinite(raw.thresholdPercent)) cfg.thresholdPercent = Math.min(100, Math.max(1, Math.round(raw.thresholdPercent)));
    if (Number.isFinite(raw.checkEveryBytes)) cfg.checkEveryBytes = Math.max(16 * 1024, Math.round(raw.checkEveryBytes));
  }
  return cfg;
}

/** `worst` passes the highest among **windows participating in the verdict**, not necessarily equal to info.worst (which is the highest across all windows) */
export function exceededMessage(info, thresholdPercent, worst = info.worst) {
  const w = worst;
  const reset = w?.resetsText ? tr(", {0} window resets {1}", w.label, w.resetsText) : '';
  return tr("{0} quota used {1}% ({2}), over the {3}% threshold, interrupted{4}. To continue, raise the threshold or turn off the circuit breaker in AI settings.", info.label, w?.usedPercent ?? '?', w?.label ?? tr("window"), thresholdPercent, reset);
}

/**
 * @param deps.probe  Function to check usage (mocked in tests)
 * @param deps.now    Clock
 */
export function createQuotaGuard(deps = {}) {
  const probe = deps.probe ?? probeQuota;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_MS;
  /** provider → latest result */
  const results = new Map();
  /** provider → ongoing probe, avoiding concurrent duplicate checks */
  const inflight = new Map();
  /** provider → newly added context bytes since the last check */
  const bytes = new Map();

  async function refresh(provider) {
    if (inflight.has(provider)) return inflight.get(provider);
    const p = (async () => {
      let info;
      try { info = await probe(provider); } catch (e) { info = { provider, label: PROVIDER_LABEL[provider] || provider, supported: true, ok: false, checkedAt: now(), windows: [], maxUsedPercent: null, worst: null, error: String(e?.message || e) }; }
      // The completion timestamp is based on the circuit breaker's own clock (the probe function may be
      // mocked / the clock may be replaced by tests)
      info.checkedAt = now();
      results.set(provider, info);
      bytes.set(provider, 0);
      return info;
    })().finally(() => inflight.delete(provider));
    inflight.set(provider, p);
    return p;
  }

  /** model: model run for this chat. Determines whether week-<model> windows count; see decidingWindows */
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
    /** Before chat starts: check if never checked or stale; throw QuotaExceededError if over the limit. model determines whether model-specific windows count */
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
     * Accounting after chat ends: how many bytes were added. If accumulated beyond checkEveryBytes,
     * re-checks in the background and returns Promise<verdict | null> (null = did not trigger a re-check
     * this time); if caller receives blocked, it terminates the running chat.
     */
    note(provider, n, rawCfg, model) {
      const cfg = normalizeQuotaConfig(rawCfg);
      if (!cfg.enabled || !QUOTA_PROVIDERS.includes(provider)) return null;
      const total = (bytes.get(provider) ?? 0) + Math.max(0, n | 0);
      bytes.set(provider, total);
      if (total < cfg.checkEveryBytes) return null;
      return refresh(provider).then(() => verdict(provider, cfg, model));
    },
    /** Current cache (for UI display); refresh=true forces a re-check */
    async get(provider, { refresh: force = false } = {}) {
      if (!QUOTA_PROVIDERS.includes(provider)) return { provider, supported: false, ok: false, windows: [], maxUsedPercent: null, worst: null };
      if (force || !results.has(provider)) await refresh(provider);
      return results.get(provider);
    },
    bytesSince(provider) { return bytes.get(provider) ?? 0; },
    verdict(provider, rawCfg, model) { return verdict(provider, normalizeQuotaConfig(rawCfg), model); },
  };
}
