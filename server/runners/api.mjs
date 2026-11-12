import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Agent } from '../harness/agent.mjs';
import { runReviewLoop, presentLoopEvent } from '../harness/loop.mjs';

/**
 * Persist review loop lessons across runs: lessons accepted by judger during rewriting are passed
 * to judger and worker at the start of the next run. Stored in the same directory as ai.json (not
 * %TEMP%, which gets cleaned up). Keep only the latest 30 entries; more will dilute attention.
 */
export function lessonsStore() {
  const dir = process.env.PROMPTCUT_AI_CONFIG
    ? path.dirname(process.env.PROMPTCUT_AI_CONFIG)
    : path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut');
  const file = path.join(dir, 'review-lessons.json');
  const read = () => {
    try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []; } catch { return []; }
  };
  return {
    read,
    add(list) {
      try {
        const merged = [...read().filter((s) => !list.includes(s)), ...list].slice(-30);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
      } catch (e) { console.error('[api] Failed to write the review lesson:', e?.message || e); }
    },
  };
}
import { MessageHistory } from '../harness/history.mjs';
import { buildTools } from '../agent/build-promptcut-tools.mjs';
import { resolveMaxOutput } from '../harness/model-limits.mjs';
import { createCodeCacheStore } from '../tools/code-cache.mjs';
import { modelToolName } from '../tools/ui-names.mjs';
import { createRetryingFetch } from '../harness/retry-fetch.mjs';
import { outputSpeedBookFor, withOutputSpeed } from '../harness/output-speed.mjs';
import { BUILTIN_SKILLS_DIR, loadSkillCatalog, skillCatalogPrompt } from '../tools/agent-skills.mjs';

/**
 * Where custom skills placed by the local user live (server/tools/agent-skills.mjs): skills/ in the
 * same directory as ai.json. Used when `opts.skillsDir` is 'local' (passed this way along the local
 * editor path); cloud hosts provide their own absolute paths; if neither is provided, only
 * built-in skills are available.
 */
export function localSkillsDir() {
  const dir = process.env.PROMPTCUT_AI_CONFIG
    ? path.dirname(process.env.PROMPTCUT_AI_CONFIG)
    : path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut');
  return path.join(dir, 'skills');
}

/**
 * Where local speed records are stored (sets per-output limit based on speed,
 * harness/output-speed.mjs): in the same directory as ai.json and review lessons. Used when
 * `opts.outputSpeedFile` is 'local' (passed this way along the local editor path); cloud hosts
 * provide their own absolute paths; if neither is provided, only recorded in memory.
 */
export function localOutputSpeedFile() {
  const dir = process.env.PROMPTCUT_AI_CONFIG
    ? path.dirname(process.env.PROMPTCUT_AI_CONFIG)
    : path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut');
  return path.join(dir, 'output-speed.json');
}

/**
 * Messages disconnected by the gateway before receiving any data (streams that already emitted data
 * are treated as truncated and do not reach here; see providers/base.mjs): can be resumed just like
 * timeouts: context is preserved in history, only no reply was received this time.
 */
const STREAM_DROPPED = /upstream stream ended|before the response was complete|response stream ended early|terminated|other side closed|socket hang up/i;
import { withIdleTimeout } from '../harness/idle-timeout.mjs';
import { tr } from '../i18n.mjs';

/**
 * Pad partial turns with "tool_use without matching tool_result" before persisting to disk.
 *
 * # Why it is needed
 *
 * agent.mjs first appends assistant messages with tool_use to history (:71), and only appends
 * tool_result after tool execution completes (:134). The section in between has three checkAbort
 * calls: if the user clicks stop while a tool is executing, a dangling tool_use is left in history.
 *
 * Previously this did not matter: the error path never persisted to disk. Now that "interruptions
 * also persist to history", this unmatched history gets written to
 * `%TEMP%/promptcut/harness-sessions/<sessionId>.json` and read back as is next time: outgoing
 * messages then contain "assistant with tool_calls followed directly by plain-text user, with no
 * role:\"tool\" in between", which both Anthropic and OpenAI reject according to spec. **From then
 * on, this sessionId hits 400 every time**, and the user has no idea such a file even exists to
 * delete.
 *
 * Appending an is_error tool_result instead of deleting tool_use lets the model see next time that
 * "that step was interrupted just now", rather than mysteriously missing a section.
 */
function healDanglingToolUse(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = messages.slice();
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const ids = m.content.filter(b => b?.type === 'tool_use' && b.id).map(b => b.id);
    if (!ids.length) continue;
    // The matching tool_result can only be in the immediately following user message (that is how
    // agent.mjs constructs it)
    const next = out[i + 1];
    const done = new Set(
      next?.role === 'user' && Array.isArray(next.content)
        ? next.content.filter(b => b?.type === 'tool_result').map(b => b.tool_use_id)
        : [],
    );
    const missing = ids.filter(id => !done.has(id));
    if (!missing.length) continue;
    const patch = missing.map(id => ({
      type: 'tool_result', tool_use_id: id, is_error: true,
      content: tr("Interrupted, this call did not finish."),
    }));
    if (next?.role === 'user' && Array.isArray(next.content)) {
      out[i + 1] = { ...next, content: [...patch, ...next.content] };
    } else {
      out.splice(i + 1, 0, { role: 'user', content: patch });
    }
  }
  return out;
}

// Corresponds to 13.3 and the config retrieval endpoint
export async function getApiProvider() {
  let configModule;
  try {
    configModule = await import('../ai-config.mjs');
  } catch {
    return {
      id: 'api',
      label: tr("Direct API"),
      available: false,
      version: undefined,
      auth: {
        loggedIn: false,
        detail: tr("Config module is missing")
      },
      note: tr("Config module is missing")
    };
  }

  try {
    const cfg = configModule.readConfig()?.api || {};
    const available = typeof cfg.apiKey === 'string' && cfg.apiKey.trim() !== '';
    const version = cfg.vendor && cfg.model ? `${cfg.vendor}/${cfg.model}` : undefined;
    return {
      id: 'api',
      label: tr("Direct API"),
      available,
      version,
      auth: {
        loggedIn: available,
        detail: available ? undefined : tr("API key not set yet")
      },
      note: undefined
    };
  } catch (e) {
    let msg = e.message || String(e);
    return {
      id: 'api',
      label: tr("Direct API"),
      available: false,
      version: undefined,
      auth: {
        loggedIn: false,
        detail: tr("Failed to read config: {0}", msg)
      },
      note: tr("Failed to read config: {0}", msg)
    };
  }
}

// Corresponds to 4.1 and 14.3 Harness entry point
export function startRun(opts) {
  const sessionId = opts.sessionId || `api-${crypto.randomUUID().substring(0, 8)}`;
  let isAborted = false;
  let currentApiKey = '';

  const safeOnEvent = (ev) => {
    if (isAborted && ev.type !== 'status') return;
    try {
      const safe = currentApiKey ? JSON.parse(JSON.stringify(ev).split(currentApiKey).join('[REDACTED]')) : ev;
      opts.onEvent(safe);
    } catch {}
  };

  const abortController = new AbortController();

  const donePromise = (async () => {
    safeOnEvent({ type: 'session', sessionId });

    let cfg;
    if (opts.apiConfig && typeof opts.apiConfig === 'object') {
      cfg = opts.apiConfig;
      currentApiKey = cfg.apiKey || '';
    } else {
      let configModule;
      try {
        configModule = await import('../ai-config.mjs');
      } catch {
        safeOnEvent({ type: 'error', message: tr("Direct API unavailable: config module is missing") });
        return;
      }
      try {
        cfg = configModule.readConfig()?.api || {};
      } catch {
        cfg = {};
      }
      currentApiKey = cfg.apiKey || '';
    }

    if (cfg.vendor !== 'mock' && !currentApiKey) {
      safeOnEvent({ type: 'error', message: tr("Direct API unavailable: API key not set yet") });
      return;
    }

    // The model in config can be written as alternatives like `a|b|c` for users to pick on the panel.
    // Which one runs this time is determined by opts.model; if none is picked, use the first in the list.
    const modelList = String(cfg.model || '').split('|').map(s => s.trim()).filter(Boolean);
    const picked = opts.model && modelList.includes(opts.model) ? opts.model : modelList[0] || '';
    // Parameter compatibility mode: 'on' / 'off' is decided by the user (or locked by frontend based
    // on model name); 'auto' / omitted infers from provider and model name: Routers using
    // OpenAI-compatible endpoints may also connect to Gemini, so the provider field is unreliable;
    // enable if gemini is in the model name
    const schemaCompat = opts.schemaCompat === 'on' ? true
      : opts.schemaCompat === 'off' ? false
      : (cfg.vendor === 'gemini' || /gemini/i.test(picked));
    /*
     * Thinking effort. The three CLI paths each translate into command-line arguments (claude's
     * --effort, codex's -c model_reasoning_effort, agy's --effort), but the direct API path previously
     * **never read it at all**: tiers on the panel were inactive for API. Relays using
     * OpenAI-compatible conventions accept `reasoning_effort`, and how it is sent is left to each
     * provider to decide (field names differ across vendors). Empty values are not overridden: let the
     * model / gateway use its own default.
     */
    cfg = { ...cfg, model: picked, schemaCompat, effort: opts.effort || '' };

    /*
     * Where history files are stored: by default placed in the system temp directory by sessionId
     * (desktop: one user per machine). Use `opts.historyFile` if provided: Agent services on the hosted
     * tier determine paths by "project, owner, chat", ignoring sessionId in the request (contract
     * cloud-agent-contract.md section 3.2, item 32).
     */
    const historyDir = path.join(os.tmpdir(), 'promptcut', 'harness-sessions');
    const historyFile = typeof opts.historyFile === 'string' && opts.historyFile ? opts.historyFile : path.join(historyDir, `${sessionId}.json`);
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    
    let initialMessages = [];
    if (fs.existsSync(historyFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        if (Array.isArray(parsed)) initialMessages = parsed;
        // Valid JSON but not a message array (file modified externally). If silently dropped as empty, the
        // user sees "it forgot what was just said" without any clues: emit a notice so they at least know
        // where to investigate.
        else safeOnEvent({ type: 'status', text: tr("The history file of this session has a bad format, starting from empty.") });
      } catch {}
    }
    
    /*
     * Data read back must also be sanitized. The persist-to-disk step (saveHistory) already patches
     * dangling tool_use, but history written incorrectly **before that** may still reside on disk: at
     * that time, interruptions were not written to disk, which was later changed to persist them,
     * leaving behind files with dangling tool_use on dev machines. If we only handle writing and not
     * reading, such dirty sessions hit a 400 first, self-heal via saveHistory in catch, and only
     * recover on the next message.
     */
    // Disable character limit: truncation is handled by the Agent based on actual tokens per round
    // (see maxInputTokens below)
    const history = MessageHistory.fromJSON(healDanglingToolUse(initialMessages), { onEvent: safeOnEvent, maxChars: Infinity });

    let providerModule;
    if (cfg.vendor === 'anthropic') {
      providerModule = await import('../harness/providers/anthropic.mjs');
    } else if (cfg.vendor === 'openai') {
      providerModule = await import('../harness/providers/openai.mjs');
    } else if (cfg.vendor === 'gemini') {
      providerModule = await import('../harness/providers/gemini.mjs');
    } else if (cfg.vendor === 'mock') {
      providerModule = await import('../harness/providers/mock.mjs');
    } else {
      safeOnEvent({ type: 'error', message: tr("Unknown vendor") });
      return;
    }

    /*
     * Review loop: follows the "deep autonomy" toggle by default: enabling deep autonomy means asking
     * it to do the full job, which makes the extra overhead of reviewer / judger worthwhile. It can
     * also be toggled independently via opts.reviewLoop.
     */
    const useLoop = opts.reviewLoop ?? !!opts.deepAuto;
    const requestFetch = opts.fetchImpl || globalThis.fetch;
    /*
     * Three layers wrapped together, with a specific order (from outside in): retry → idle timeout →
     * actual fetch.
     *
     * Retry is outermost: each attempt must go through the idle timeout layer again to get a **new**
     * timer. Otherwise, the second attempt leaves with the signal already expired from the previous
     * attempt and aborts immediately.
     *
     * Stop uses abortController.signal (when the user clicks stop), which is also listened to during
     * backoff waiting, otherwise clicking stop would still wait over ten seconds for a reaction. Only
     * retry the "send request" step itself: requests cannot be resent once stream reading has started;
     * see description in retry-fetch.mjs for details.
     */
    const retryingFetch = createRetryingFetch(
      // Timeout is calculated by "how long no data has arrived", not "total runtime": previously it was
      // AbortSignal.timeout(120000), which was the wall-clock cap for the whole request (including stream
      // reading), abruptly cutting off a long round that streamed healthily for 121 seconds. The larger
      // the context and the more tools used, the easier it hits this cap, meaning the more work done, the
      // more likely it gets cut off. See harness/idle-timeout.mjs.
      withIdleTimeout(
        (url, options) => requestFetch(url, {
          ...options,
          /*
           * **Merge, do not overwrite.**
           *
           * Originally it had `signal: abortController.signal` here: a one-line difference that completely
           * overwrote the signal composed by withIdleTimeout, so nothing listened to the controller when the
           * idle timer aborted on expiration. If the upstream genuinely stalled, this round never ended,
           * reported no errors, and never triggered auto-resume, with only heartbeats increasing on the UI.
           * Before that change, AbortSignal.timeout was passed directly to the real fetch and actually cut
           * off: meaning that version was worse than before the change, a regression.
           *
           * options.signal already includes the user stop signal (composed by withIdleTimeout); merging
           * abortController.signal here once more guarantees that "even if the wrapper layer changes in the
           * future, clicking stop will definitely work" without relying on upstream implementation.
           */
          signal: options?.signal
            ? AbortSignal.any([abortController.signal, options.signal])
            : abortController.signal,
        }),
        // Threshold can be passed from opts for tests, otherwise an "upstream emits no tokens" test case
        // would actually wait two minutes. Omitted in production paths, defaulting to 120 seconds.
        /*
         * Relaxed to 300 seconds inside the loop. In practice, when a worker reaches over 40 round-trips,
         * over 80 history messages, and carries 10 screenshots in a single round, the model needs to think
         * for 90-110 seconds before emitting its first token; if slightly larger, it hits 120 seconds and
         * gets cut off. Retries carry the exact same request and still time out: stuck on the same turn
         * three times, invalidating the entire loop. That is not a dropped connection, but slow thinking.
         * Normal chat remains at 120 seconds: when genuinely stuck, it should still notify the user earlier.
         */
        { idleMs: Number(opts.idleMsForTest) > 0 ? Number(opts.idleMsForTest) : (useLoop || opts.checkpoint ? 300000 : 120000) },
      ),
      {
        ...(opts.retryForTest && typeof opts.retryForTest === 'object' ? opts.retryForTest : {}),
        signal: abortController.signal,
        onRetry: ({ attempt, of, reason, delayMs }) => {
          opts.retryForTest?.onRetry?.({ attempt, of, reason, delayMs });
          console.error(`[api] ${reason}, retrying in ${delayMs}ms (attempt ${attempt}/${of})`);
        },
      },
    );
    // Input budget is calculated using the output limit without speed caps (the speed cap can change
    // within this round; reserve headroom based on the maximum)
    const maxOutput = resolveMaxOutput(cfg);
    /*
     * Set per-output cap based on measured speed (user decision, 2026-10-22: "Set per-output cap based on
     * measured speed"): allow a single request to finish writing before the gateway cuts off around 300
     * seconds. Speed records are stored per model (harness/output-speed.mjs), recorded based on usage
     * after each request; mock providers do not count.
     */
    const speedFile = opts.outputSpeedFile === 'local' ? localOutputSpeedFile()
      : (typeof opts.outputSpeedFile === 'string' && path.isAbsolute(opts.outputSpeedFile) ? opts.outputSpeedFile : null);
    const speedBook = cfg.vendor === 'mock' ? null : outputSpeedBookFor(speedFile, { log: (m) => console.error(m) });
    if (speedBook) cfg = { ...cfg, outputCap: () => speedBook.capFor(cfg.model) };
    const rawProvider = providerModule.createProvider(cfg, { fetchImpl: retryingFetch });
    const provider = speedBook ? withOutputSpeed(rawProvider, speedBook, cfg.model) : rawProvider;
    /*
     * Round limit: standard 48 rounds (user decision, 2026-10-24, previously 24 rounds; writing code
     * alone for a complex custom card takes over a dozen rounds, and 24 rounds is not enough to reach
     * the card creation step); when "deep autonomy" is enabled, switch to "autonomous rounds"
     * (opts.maxRounds) from settings: a value of 0 means unlimited, which becomes Infinity here,
     * leaving no end point for the loop.
     */
    const maxIterations = opts.deepAuto
      ? (opts.maxRounds === 0 ? Infinity : Number(opts.maxRounds) || 300)
      : 48;
    // Per-output cap: maxTokens in config is the upper bound of the cap, the actual number sent is
    // determined by model (harness/model-limits.mjs, A07 2026-10-22); further clamped by measured speed
    // (speedBook above); see `output-speed` diagnostics for the actual number sent per request
    safeOnEvent({ type: 'diagnostic', stage: 'configuration', data: { vendor: cfg.vendor, model: cfg.model, effort: cfg.effort || '(default)', maxTokens: cfg.maxTokens, maxOutput, speedCap: speedBook ? speedBook.capFor(cfg.model) : null, protocol: 'native-tools', schemaCompat, maxRounds: Number.isFinite(maxIterations) ? maxIterations : null, deepAuto: !!opts.deepAuto } });
    /*
     * Code block workspace (server/tools/code-cache.mjs): directory is provided by the host
     * (`opts.codeCacheDir`, per project); if not provided, placed next to this chat's history file,
     * valid only within this chat. If it cannot be created (directory not writable), do not provide
     * this set of tools; the round continues as usual.
     */
    let codeCache = null;
    try {
      const dir = typeof opts.codeCacheDir === 'string' && opts.codeCacheDir ? opts.codeCacheDir
        : path.join(path.dirname(historyFile), `${path.basename(historyFile, '.json')}.code-cache`);
      codeCache = createCodeCacheStore({ dir, writer: String(opts.codeCacheWriter || sessionId) });
    } catch (e) {
      safeOnEvent({ type: 'status', text: tr("Code sandbox unavailable: {0}", e?.message || e) });
    }
    /*
     * Skills (issue 46): scan once at the start of each round; external roots precede built-in ones,
     * and external ones take precedence on name collision. The manifest is appended to the system
     * prompt; if there are no skills, the system prompt remains unchanged.
     */
    const skillsDir = opts.skillsDir === 'local' ? localSkillsDir()
      : (typeof opts.skillsDir === 'string' && path.isAbsolute(opts.skillsDir) ? opts.skillsDir : null);
    const { skills, skipped: skippedSkills } = loadSkillCatalog({ dirs: [...(skillsDir ? [skillsDir] : []), BUILTIN_SKILLS_DIR] });
    safeOnEvent({ type: 'diagnostic', stage: 'skills', data: { skills: skills.map((s) => s.name), skipped: skippedSkills } });
    const skillsNote = skillCatalogPrompt(skills);
    const systemPrompt = skillsNote ? `${opts.systemPrompt ?? ''}${skillsNote}` : opts.systemPrompt;
    // When localTools: false, do not provide text_editor for reading/writing local files; toolFilter
    // is the list of tools passed to the model (open manifest for the hosted tier)
    const tools = await buildTools({ callTool: opts.callTool, workspaceDir: opts.cwd, onEvent: safeOnEvent, localTools: opts.localTools !== false, only: opts.toolFilter ?? null, codeCache, skills });
    const agent = new Agent({ 
      provider, 
      system: systemPrompt,
      tools, 
      maxIterations,
      deepAuto: !!opts.deepAuto,
      /*
       * Max out context: gemini-3.8-flash has a 1 million token context (description in openlux gateway
       * /v1/models: "offers a million-token context window"). Budget = context - max output tokens this
       * round - 30,000 headroom. The gateway caches automatically, with tests showing about an 80% hit
       * rate on the second request for the same prefix, keeping long-context costs under control.
       */
      maxInputTokens: 1_000_000 - maxOutput - 30_000,
      onEvent: safeOnEvent,
      signal: abortController.signal,
      history,
      codeCache,
      toolNameMapper: modelToolName,
      /*
       * Callbacks before and after each model request (gate and usage records for the hosted tier). When
       * `opts.checkpoint` is true, history is persisted to disk before each request starting from the
       * second request: at this point the previous tool round-trip just finished: even if the process is
       * killed, only the one currently in progress is lost (contract cloud-agent-contract.md section 7.1).
       * Desktop passes neither, unchanged from before.
       */
      ...(typeof opts.onModelCall === 'function' || opts.checkpoint ? {
        onModelCall: async (phase, info) => {
          if (phase === 'before' && opts.checkpoint && info?.round > 1) saveHistory();
          if (typeof opts.onModelCall === 'function') return opts.onModelCall(phase, { ...info, vendor: cfg.vendor, model: cfg.model });
          return undefined;
        },
      } : {}),
    });

    /*
     * Record history. **Record both successes and failures**:
     *
     * Previously, it only wrote to disk on the success path, so as soon as a timeout or error
     * occurred, everything done in this turn (words spoken, tools called) was completely lost: next
     * time coming in with the same sessionId, it would still read the previous turn's history. When the
     * user manually typed "continue", it looked like it resumed, but it actually restarted from even
     * earlier: and they would not know. An interruption is precisely when "remembering where we left
     * off" is needed most.
     */
    const saveHistory = () => {
      try {
        let historyStr = JSON.stringify(healDanglingToolUse(history.toJSON()));
        // Maximum history file size (only provided by the hosted tier, `opts.historyMaxBytes`): if exceeded,
        // truncate existing history (deleting from the earliest complete message pair) before saving
        const maxBytes = Number(opts.historyMaxBytes) > 0 ? Number(opts.historyMaxBytes) : 0;
        for (let i = 0; maxBytes && i < 4 && Buffer.byteLength(historyStr, 'utf8') > maxBytes; i += 1) {
          const before = history.size();
          history.maxChars = Math.floor(before * (maxBytes / Buffer.byteLength(historyStr, 'utf8')) * 0.85);
          history.truncate();
          if (history.size() >= before) break; // Only the two messages that cannot be truncated remain
          historyStr = JSON.stringify(healDanglingToolUse(history.toJSON()));
        }
        // Confirm once more that there is no API Key in the history
        fs.writeFileSync(
          historyFile,
          currentApiKey && historyStr.includes(currentApiKey)
            ? historyStr.split(currentApiKey).join('***')
            : historyStr,
          'utf8',
        );
      } catch (e) {
        // Even if it cannot fit, do not overwrite this turn's results; recording one line is enough
        console.error('[api] failed to write session history:', e?.message || e);
      }
    };

    try {
      const result = useLoop
        ? await runReviewLoop({
            provider, tools, system: systemPrompt, userText: opts.prompt,
            maxIterations, deepAuto: !!opts.deepAuto, maxInputTokens: agent.maxInputTokens,
            signal: abortController.signal, history, lessonsStore: lessonsStore(), codeCache,
            toolNameMapper: modelToolName,
            onEvent: (ev) => { for (const e of presentLoopEvent(ev)) safeOnEvent(e); },
          })
        : await agent.run(opts.prompt);
      saveHistory();

      const rawUsage = result.usage || {};
      const usage = {
        input: typeof rawUsage.input === 'number' ? rawUsage.input : 0,
        output: typeof rawUsage.output === 'number' ? rawUsage.output : 0,
        // Gateway auto-cache hit count; input already contains it, this number is used to check hit rate
        cacheRead: typeof rawUsage.cacheRead === 'number' ? rawUsage.cacheRead : 0,
      };
      
      safeOnEvent({ type: 'done', sessionId, usage, outcome: result.outcome, completed: result.completed, failed: result.failed });
    } catch (err) {
      // Even if interrupted midway, record where it got to; otherwise "continue" will resume an even
      // earlier turn
      saveHistory();

      if (abortController.signal.aborted) {
        // The user clicked stop: this is their decision, do not report an error or automatically resume
        safeOnEvent({ type: 'status', text: tr("Aborted") });
      } else {
        let msg = err.message || String(err);
        if (currentApiKey && msg.includes(currentApiKey)) {
          msg = msg.split(currentApiKey).join('***');
        }
        /*
         * Timeouts are **resumable**: the context is all in the history (just saved above); the model
         * simply did not emit tokens within the allowed time this time. Let it continue speaking instead
         * of having the user manually type "continue".
         *
         * Note that AbortError cannot simply be treated as "user stopped": when `AbortSignal.timeout`
         * triggers it throws TimeoutError, but after being passed through AbortSignal.any the name may
         * be AbortError: the original `err.name === 'AbortError'` swallowed timeouts into an "aborted"
         * state without even showing red text, so the user only saw the chat stop silently. Therefore,
         * determining "whether the user stopped it" only accepts abortController.signal.aborted as the
         * single true indicator.
         */
        /*
         * Cases cut off by the gateway after the stream has already emitted data are handled as truncation
         * in harness to let the model continue writing (stream-cut, 2026-10-22), and will not reach here;
         * what reaches here is disconnected before receiving any data, which like timeouts can continue
         * speaking. The case where truncation count exceeded the limit is not included (that explicitly
         * states it failed).
         */
        const isTimeout = err.name === 'TimeoutError' || /timeout|timed out|aborted due to timeout/i.test(msg) || STREAM_DROPPED.test(msg);
        safeOnEvent(isTimeout ? {
          type: 'error',
          message: msg,
          retryable: true,
          retryPrompt: `Continue from above. The previous turn was cut off before finishing, because: ${msg}.\n`
            + `All earlier progress is still there, no need to start over, just continue from where you stopped.
`
            + `If the previous step was waiting on a background job, use the wait tool to wait a few seconds, then check its status again.`,
        } : { type: 'error', message: msg, ...(typeof err?.runErrorCode === 'string' ? { code: err.runErrorCode } : {}) });
      }
    }
  })();

  return {
    abort: () => {
      isAborted = true;
      abortController.abort();
    },
    done: donePromise
  };
}
