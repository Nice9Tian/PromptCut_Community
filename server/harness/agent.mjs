import { MessageHistory } from './history.mjs';
import { resolveCodeCacheRefs, CODE_CACHE_REF } from './code-cache.mjs';
import { salvageTruncation } from './truncation.mjs';

const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
/**
 * Stop reasons for providers when "truncated upon reaching per-output limit": OpenAI-compatible
 * endpoints `length`, Anthropic `max_tokens`, Gemini `MAX_TOKENS`
 */
const LENGTH_STOPS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);
/**
 * Stop reasons treated as truncation: reaching the limit, plus stream being interrupted before
 * normal finalization (`stream_cut`, determined by provider, see providers/base.mjs).
 * (user decision, 2026-10-22): "Midstream gateway cutoff is treated as truncation (preserve partial
 * parameters, resume writing via code cache)".
 */
const TRUNCATED = new Set([...LENGTH_STOPS, 'stream_cut']);
/**
 * If several consecutive truncations leave nothing that can be resumed, stop letting it continue
 * and explicitly state that it failed
 */
const MAX_TRUNCATIONS = 2;
/**
 * Maximum resume attempts in a round (where each truncation saved half-written content into a code
 * block, showing progress). [ruling: output-cache 2026-10-22]
 * If there is progress, let it keep writing, but do not burn quota through infinite retries (direction
 * per user decision, 2026-10-22): 6 per-output limits (Gemini 65536, Claude 128K) are sufficient to
 * write the source code of any card; anything more usually means the model writes too much each time
 * and is chasing truncation.
 */
const MAX_SALVAGED_TRUNCATIONS = 6;
const checkAbort = signal => { if (signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' }); };
/**
 * Progress report tool shown to the user (prefixes differ across providers; only recognizes names
 * ending with it, same rule as isReportTool in src/ai/progressReport.ts)
 */
const isReportTool = name => typeof name === 'string' && (name === 'report_progress' || /(?:__|[.:/])report_progress$/.test(name));
/**
 * The send_message variant for speaking to the user (`to: "user"`, (user decision, 2026-10-20):
 * "bubbles only show what is being done", "add send_message(user,xxx) usage"). Names have different
 * prefixes across providers, only recognizing those ending with send_message; recipient only
 * recognizes user. This variant does not go through the multi-Agent bulletin board, and is answered
 * locally by harness/tools/index.mjs; UI draws into bubbles based on text in tool_call events
 * (src/ai/userMessages.ts).
 */
export const isUserMessageCall = (name, input) => typeof name === 'string' && (name === 'send_message' || /(?:__|[.:/])send_message$/.test(name)) &&
  !!input && typeof input === 'object' && typeof input.to === 'string' && input.to.trim().toLowerCase() === 'user';

/** Limit on debug info passed to the model (characters); the whole payload is truncated to this length */
export const TOOL_DEBUG_CHARS = 2000;
/** For keys resembling keys, tokens, or tickets, always replace values with [redacted] */
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|ticket|credential|signature|api[-_]?key|private[-_]?key|^key$|bearer/i;
/** Values that resemble credentials: Bearer headers, sk- shaped keys, tickets (v1.xxx.yyy), JWTs */
const SECRET_VALUE = /Bearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{12,}|\bv1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_.-]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;
function redact(value, depth = 0) {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]');
  if (!value || typeof value !== 'object') return value;
  if (depth > 6) return '[too deep, omitted]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]));
}
/**
 * Result returned to the model when a tool throws an error: in addition to cause (message), error
 * code (code) and debug info (debug) attached to the tool are provided together.
 * product/agent.md "Stop when frame render times out" requires that the Agent can obtain debug info
 * (stuck on which card and which line, page errors reported...); originally only message was
 * provided, and debug was discarded (discovered in lead session, 2026-10-20). debug strips keys and
 * values resembling credentials, and the whole payload is truncated to TOOL_DEBUG_CHARS characters.
 */
export function toolErrorResult(err) {
  const result = { error: err?.message || String(err) };
  if (err && typeof err === 'object') {
    if (typeof err.code === 'string' && err.code) result.code = err.code;
    if (err.debug !== undefined && err.debug !== null) {
      let text;
      try { text = typeof err.debug === 'string' ? redact(err.debug) : JSON.stringify(redact(err.debug)); } catch { text = String(err.debug); }
      if (typeof text === 'string' && text) result.debug = text.length > TOOL_DEBUG_CHARS ? `${text.slice(0, TOOL_DEBUG_CHARS)}... (debug info is long, truncated)` : text;
    }
  }
  return result;
}

/**
 * The "identity" of a failure: same tool and same defect count as the same. If it occurs
 * repeatedly, switch approaches rather than trying again.
 *
 * Prioritize `code` (the code provided by the tool itself, most stable); if there is no code, take
 * the first 60 characters of error text as the code: error text for the same defect is usually
 * identical, whereas error messages containing specific parameters ("missing required parameter x")
 * should inherently count as different defects.
 */
export function failureKey(name, result) {
  const of = (v) => `${name}\u0000${v}`;
  if (typeof result === 'string') return of(result.slice(0, 60));
  if (!result || typeof result !== 'object') return of('unknown');
  if (typeof result.code === 'string' && result.code) return of(result.code);
  if (typeof result.error === 'string' && result.error) return of(result.error.slice(0, 60));
  return of('unknown');
}

export class Agent {
  /**
   * maxIterations allows Infinity (deep autonomy + 0 entered for autonomous rounds). In this case
   * the loop has no end point, and stopping relies solely on three things: user clicks stop (signal),
   * model stops calling tools on its own, and duplicate operation detection.
   *
   * When deepAuto is true, **give the model no wording regarding rounds**: do not write round count
   * in the wrap-up message upon hitting the cap, lest the model sees "round X / limit Y" and starts
   * budgeting for itself and wrapping up early.
   *
   * maxInputTokens: input token budget for a single request. When provided, truncate according to
   * actual token count reported by API in each round (see history.fitTokens); when omitted, fall back
   * to legacy character-count truncation.
   */
  constructor({ provider, system, tools, maxIterations = 24, deepAuto = false, maxInputTokens = 0, onEvent, signal, history, onModelCall = null, codeCache = null, toolNameMapper = null }) {
    Object.assign(this, { provider, system, tools, maxIterations, deepAuto, maxInputTokens, signal });
    this.toolNameMapper = typeof toolNameMapper === 'function' ? toolNameMapper : (name) => name;
    /*
     * Code cache space (./code-cache.mjs, A07 2026-10-22): when provided, (1) strings
     * written entirely as `@code_cache:name` in tool arguments are replaced with content prior
     * to invocation; (2) when a response is truncated, unfinished tool arguments are stored into
     * the code cache, allowing the model to continue writing. When omitted, behavior remains
     * identical to before.
     */
    this.codeCache = codeCache;
    /*
     * Whether there is a "speak to user" tool (to: "user" in send_message). If present, execution rules
     * instruct the model to use it to explain what it is doing;
     * The "submit a text reply on behalf if no wrap-up report was submitted" behavior from 2026-10-19
     * has been removed (2026-10-20): user decided that bubbles show what the Agent says; when the model
     * only replies with text without calling send_message, the UI renders that text into the bubble as
     * a "what it is doing" entry instead of submitting another report on its behalf, avoiding having the
     * same text appear once in the bubble and once in the report.
     */
    this.canSpeak = (tools || []).some(t => t?.name === 'send_message' || /(?:__|[.:/])send_message$/.test(t?.name ?? ''));
    /*
     * Called once before and once after each request to the model (optional; Cloud Agent quota checks
     * and usage tracking hook in here, contract cloud-agent-contract.md section 6.2):
     *   onModelCall('before', { round })  : if it throws, do not send this request and end the entire
     *     round with this error;
     *   onModelCall('after', { round, ok, ms, input, output, cacheRead })  : usage for this request;
     *     errors it throws do not affect this round.
     * When omitted, behavior is identical to before.
     */
    this.onModelCall = typeof onModelCall === 'function' ? onModelCall : null;
    this.onEvent = onEvent || (() => {});
    this.history = history || new MessageHistory({ onEvent: this.onEvent });
  }

  async run(userText) {
    // When the end is already a user message, merge into it instead of creating a new one:
    // see history.appendUserText for the rationale
    this.history.appendUserText(userText);
    const usage = { input: 0, output: 0, cacheRead: 0 };
    const recent = [];
    let completed = 0, failed = 0, outcome = 'completed', lastText = '', lastRound = 0;
    const started = Date.now();
    const progress = (round, phase, text) => this.onEvent({ type: 'progress', round, maxRounds: this.maxIterations, phase, completed, failed, elapsedMs: Date.now() - started, text });
    const speak = this.canSpeak
      ? 'Before each group of operations, call send_message (set `to` to "user") with one or two sentences telling the user what you are about to do, and after each group use it again to say what was done. Put it in the same reply as that group\'s tool calls; do not spend a separate turn on it. Still finish by calling report_progress with final set to true'
      : 'Before each group of operations, say in one short sentence what you will do';
    const cacheRule = this.codeCache
      ? `A single reply has an output limit: when you need to write very long source code or text (several hundred lines or more), first write it in several parts into code blocks (code_cache_write for the start, code_cache_append to continue), then pass the whole thing to the tool as "${CODE_CACHE_REF}name" in the tool arguments. When a reply is truncated, continue as the system message instructs.`
      : '';
    const system = this.system + `\n\nExecution rules: ${speak}. When you need to do several things, return multiple tool calls in the same reply; they run in order within the same round. Leave operations that depend on a previous result for the next round. Background jobs are awaited automatically by the tools, so do not restart them repeatedly or poll them tightly. On repeated errors, change your approach or explain the blocker. If a capability is unavailable this time (the tool says it cannot be used and retrying will not help) and it is a hard prerequisite of what the user asked for, explain the blocker and stop; do not carry on as if it did not exist. After a tool returns success, verify once; when done, summarize the result for the user.${cacheRule}`;
    // truncations: consecutive truncations with no content retained; salvaged: truncations in this round
    // that retained content; truncTotal: total truncations in this round; cutBlocks: code blocks saved
    // during truncation
    // cutCount: how many times in truncTotal were cut off midway by the gateway (the rest hit output
    // limit); stopping message is phrased according to it
    let summaryReason = '', truncations = 0, salvaged = 0, truncTotal = 0, cutCount = 0;
    const cutBlocks = new Set();
    // Whether a wrap-up report was submitted in this round, or send_message was used to speak to the
    // user: what was said counts as an explanation to the user, so a final empty reply is not an error
    let reported = false, spoke = false;
    /*
     * Round budget prompt (user decision, 2026-10-24).
     *
     * The on-screen "Round N/M" does not enter model context (see comment on progress line below), so
     * the model works as if "time is infinite": in an actual run, it polished a heavy card's source
     * code for 18 rounds without calling `create_card` even once before hitting the limit, leaving the
     * timeline empty. Remind it once when halfway through and once when only a quarter remains,
     * prompting it to commit the minimum deliverable version first. Under deepAuto, do not send any:
     * the whole point of that switch is not to talk about rounds with the model.
     */
    const budgetSent = new Set();
    /*
     * The same tool chained with the same error: give a hard prompt on the 2nd time, stop directly on the 3rd time.
     *
     * The existing duplicate operation detection (below `repeats >= 3`) is calculated per **whole-round**
     * fingerprint; as long as there are other calls in a round, the fingerprint differs, failing to
     * catch "repeatedly requesting the same capability". In that actual run, see_frames received the same
     * error code for two consecutive rounds, neither gate triggered, and the model kept going blindly.
     */
    const failStreak = new Map();

    // The budget counts model/tool round trips, not individual calls.
    for (let round = 1; round <= this.maxIterations + 1; round++) {
      checkAbort(this.signal);
      lastRound = round;
      const summarizing = !!summaryReason;
      // The previous round just placed tool_result (which is a user message); appending directly here
      // would result in two consecutive user messages
      if (summarizing) this.history.appendUserText(`Execution paused: ${summaryReason}. Do not call any more tools; in the user's language, describe what is done, what is not done, the blockers and the next steps. Never describe an unfinished task as successful.`);
      // This progress line is only for the screen and does not enter model context. Do not write the
      // denominator when rounds are unlimited, avoiding things like "Round 3/Infinity"
      const roundText = Number.isFinite(this.maxIterations) ? `Round ${round}/${this.maxIterations}` : `Round ${round}`;
      progress(round, summarizing ? 'summarizing' : 'requesting', summarizing ? 'Summarizing results and unfinished items…' : `${roundText}: waiting for the model response…`);
      this.onEvent({ type: 'diagnostic', stage: 'request', data: { round, summaryOnly: summarizing, messages: this.history.get().length, tools: summarizing ? 0 : this.tools.length } });
      const content = [], calls = [], partials = [];
      let text = '', current = '', lastInput = 0, stopReason = null;
      const flush = () => { if (current) { content.push({ type: 'text', text: current }); current = ''; } };
      if (this.onModelCall) {
        await this.onModelCall('before', { round });
        checkAbort(this.signal);
      }
      const callStarted = Date.now();
      const callUsage = { input: 0, output: 0, cacheRead: 0 };
      let callOk = false;
      const heartbeat = setInterval(() => progress(round, summarizing ? 'summarizing' : 'requesting', `Still waiting for the model response, ${Math.floor((Date.now() - started) / 1000)} s elapsed; you can stop at any time.`), 10000);
      try {
        for await (const ev of this.provider.stream(this.history.get(), summarizing ? [] : this.tools, system, this.signal)) {
          checkAbort(this.signal);
          if (ev.type === 'text_delta') {
            current += ev.text; text += ev.text;
            this.onEvent({ type: 'text', delta: ev.text });
          } else if (ev.type === 'thinking_delta') {
            // Only forward to the UI, do not merge into the assistant body: thinking should not be mixed into
            // replies, nor fed back to the model
            this.onEvent({ type: 'thinking', delta: ev.text, round });
          } else if (ev.type === 'tool_use') {
            if (summarizing) continue; // Never execute tools once the safety stop fired.
            flush();
            /*
             * Tool name is empty or contains illegal characters: replace with a legal placeholder name in history.
             *
             * In actual runs, the model was seen emitting calls where name is an empty string. Written as-is into
             * history, the next request to Gemini (via OpenAI-compatible endpoint) fails entirely with 400
             * "Request contains an invalid argument": this session will fail with 400 on every round from then on.
             * The placeholder name still pairs with an is_error tool_result (the "unknown tool" branch below),
             * so the model can see that it called an invalid tool.
             */
            const validName = typeof ev.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ev.name);
            const call = { ...ev, name: validName ? ev.name : 'invalid_tool_name', id: ev.id || `round-${round}-call-${calls.length + 1}` };
            if (!validName) call.inputError = `Tool name ${JSON.stringify(ev.name ?? '')} is invalid (empty or contains illegal characters); this call was not executed. Call again using a name from the tool manifest.`;
            if (calls.some(c => c.id === call.id)) throw new Error('The API returned a duplicate tool call ID; stopped to avoid running it twice.');
            calls.push(call);
            content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
          } else if (ev.type === 'tool_use_partial') {
            // Tool calls left incomplete when hitting output limit: do not enter history, do not execute, save
            // into code blocks after wrap-up (see the truncation branch below)
            if (!summarizing) partials.push(ev);
          } else if (ev.type === 'notice') {
            // Provider notices (output limit 400 downgrade, field swap): enter runtime logs and diagnostics
            this.onEvent({ type: 'diagnostic', stage: ev.stage || 'provider', data: { round, ...(ev.data || {}) } });
          } else if (ev.type === 'stop') {
            stopReason = ev.reason;
            this.onEvent({ type: 'diagnostic', stage: 'response', data: { round, stopReason: ev.reason, toolCalls: calls.length } });
          } else if (ev.type === 'usage') {
            usage.input += Number(ev.input) || 0; usage.output += Number(ev.output) || 0;
            usage.cacheRead += Number(ev.cacheRead) || 0;
            lastInput = Number(ev.input) || 0;
            callUsage.input += Number(ev.input) || 0; callUsage.output += Number(ev.output) || 0;
            callUsage.cacheRead += Number(ev.cacheRead) || 0;
          }
        }
        callOk = true;
      } catch (err) {
        if (!summarizing || this.signal?.aborted) throw err;
        this.onEvent({ type: 'status', text: `Result summary request failed: ${err.message}` });
      } finally {
        clearInterval(heartbeat);
        if (this.onModelCall) {
          try { await this.onModelCall('after', { round, ok: callOk, ms: Date.now() - callStarted, ...callUsage }); } catch { /* Billing failure does not affect this round */ }
        }
      }
      flush();
      lastText = text;
      if (summarizing) {
        const note = `\n\nThis run was paused: ${summaryReason}. ${completed} operations succeeded and ${failed} failed. Changes already made are kept; you can add requirements and continue, or copy this chat to investigate.`;
        this.onEvent({ type: 'text', delta: note });
        /*
         * This closing sentence must be **merged into the current round's assistant message**, not started as a new one.
         *
         * Above, an assistant message was already going to be appended (the model's summary text); appending
         * another one here would produce two consecutive assistant messages: the other half of the same
         * illness that appendUserText cures. This shape would be written as-is by saveHistory into that file
         * in harness-sessions, and no subsequent step would merge it back: **this session will fail with 400
         * every time from then on without self-healing**, and the user has no idea such a file exists to delete.
         */
        content.push({ type: 'text', text: note });
        if (content.length) this.history.append({ role: 'assistant', content });
        lastText += note;
        break;
      }
      if (content.length) this.history.append({ role: 'assistant', content });
      /** Message to follow this round's tool results upon truncation (with both finished and unfinished tool calls) */
      let truncationNote = '';
      if (TRUNCATED.has(stopReason) && (partials.length || !calls.length)) {
        /*
         * Response truncated upon hitting the single-output limit: cannot be treated as "done speaking"
         * and wrapped up (2026-10-17 actual run: the model spent all 4096 tokens drafting and writing a
         * giant tool argument, completely discarding incomplete tool calls, so this round "completed" with
         * 0 operations and the user saw nothing).
         * A07 (user decision, 2026-10-22): save already-written content from incomplete tool calls into code
         * blocks, telling the model where it is stored, how far it got, and how to continue writing.
         * If there is progress (content was saved), let it continue writing, up to MAX_SALVAGED_TRUNCATIONS
         * times per round; if nothing is retained for MAX_TRUNCATIONS consecutive times, or the round limit
         * is reached, state clearly that it failed and end this round.
         */
        truncTotal++;
        const cause = stopReason === 'stream_cut' ? 'cut' : 'length';
        if (cause === 'cut') cutCount++;
        const s = salvageTruncation(partials, this.codeCache, { cause });
        for (const x of s.saved) cutBlocks.add(x.block);
        if (s.progress) { salvaged++; truncations = 0; } else truncations++;
        this.onEvent({ type: 'diagnostic', stage: 'truncated', data: { round, stopReason, cause, partials: partials.map((p) => p.name), saved: s.saved, salvaged, stalled: truncations } });
        if (truncations > MAX_TRUNCATIONS || salvaged > MAX_SALVAGED_TRUNCATIONS || round >= this.maxIterations) {
          const kept = cutBlocks.size ? `The part already written is stored in code block ${[...cutBlocks].join(', ')}; the next message can ask it to continue.` : '';
          const times = truncTotal > 1 ? ` ${truncTotal} times in a row` : '';
          // When all are cut off by the gateway, do not suggest "increasing the single-output limit": that is
          // not an output limit issue, and increasing it only makes it easier to hit the gateway duration limit
          if (cutCount === truncTotal) throw new Error(`The model's reply was cut off midway by the gateway${times} (the gateway has a time limit per request), so this round could not finish. ${kept}Try splitting the request into smaller ones.`);
          if (cutCount === 0) throw new Error(`The model's reply exceeded the single-output limit and was truncated${times}, so this round could not finish. ${kept}Try splitting the request into smaller ones, or ask the administrator to raise the single-output limit.`);
          throw new Error(`The model's reply was truncated${times} (it exceeded the single-output limit or was cut off midway by the gateway), so this round could not finish. ${kept}Try splitting the request into smaller ones.`);
        }
        this.onEvent({ type: 'status', text: s.status });
        if (!calls.length) {
          this.history.appendUserText(s.note);
          continue;
        }
        truncationNote = s.note;
      }
      if (!calls.length) {
        // If a wrap-up report was already submitted, or send_message was used to speak to the user, not
        // speaking this last time still counts as finished
        if (!text.trim() && !reported && !spoke) throw new Error('The API returned no text or tool calls; check the model and API protocol settings.');
        break;
      }
      if (!truncationNote) { truncations = 0; truncTotal = 0; cutCount = 0; }
      progress(round, 'executing', `Received ${calls.length} tool calls this round, executing…`);
      const results = [];
      // Images returned by tools are not kept in tool_result; instead, they are attached to the end of
      // the same user message. The reason is portability: Anthropic's tool_result can hold image blocks,
      // but OpenAI's role:"tool" only accepts strings and cannot hold them. To make the same history valid
      // across all three APIs, images can only appear as regular content blocks following tool results
      // (the append section below explains why not to start a new message).
      const images = [];
      // The "identity" of this round's failure → the sentence shown to the model. Chaining determination is done after the loop
      const roundFails = new Map();
      // Preserve declared order for edits: two mutations must not race in the store.
      // Multiple calls still share one model round trip.
      for (const call of calls) {
        checkAbort(this.signal);
        // Allow host-configured alias mapping (e.g. legacy tool names in saved session history)
        const tool = this.tools.find(t => t.name === call.name) ?? this.tools.find(t => t.name === this.toolNameMapper(call.name));
        const begin = Date.now();
        this.onEvent({ type: 'tool_call', callId: call.id, round, name: call.name, input: call.input });
        const toolHeartbeat = setInterval(() => progress(round, 'executing', `Running ${call.name}, waited ${Math.floor((Date.now() - begin) / 1000)} s…`), 5000);
        let result, ok = true;
        try {
          // Report issues with parameters/names themselves first: placeholder names substituted for empty tool
          // names are always "unknown tool", and that sentence would overwrite the real cause
          if (call.inputError) throw new Error(call.inputError);
          if (!tool) throw new Error(`Unknown tool ${call.name}; use one of the provided tool names.`);
          if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) throw new Error('Tool arguments must be a JSON object.');
          for (const key of tool.inputSchema?.required || []) if (call.input[key] === undefined) throw new Error(`Missing required argument ${key}.`);
          // Strings in arguments entirely written as `@code_cache:name` are replaced with code block contents
          // before passing to the tool; history and events keep references without bloating
          const input = this.codeCache ? resolveCodeCacheRefs(call.input, this.codeCache) : call.input;
          result = await tool.execute(input, { signal: this.signal, callId: call.id, round });
          if (result?.ok === false || result?.isError === true) ok = false;
          checkAbort(this.signal);
        } catch (err) {
          checkAbort(this.signal);
          ok = false; result = toolErrorResult(err);
        } finally { clearInterval(toolHeartbeat); }
        // Extract images from tool results. If left in JSON, base64 would be poured into history as plain
        // text: the model cannot see the image, and hundreds of thousands of characters would instantly blow
        // up context and trigger truncation. Another benefit of extraction is that tool_result events
        // forwarded to the UI no longer carry base64, keeping archives from bloating.
        if (ok && result && typeof result === 'object' && result.__image?.base64) {
          images.push({ ...result.__image, name: call.name });
          const { __image, ...rest } = result;
          result = { ...rest, image: 'See the image at the end of this message for the frame' };
        }
        // see_frames media mode (source: "media") with multiple images per page: label each with shot index
        // so the model can correlate images with scenes
        if (ok && result && typeof result === 'object' && Array.isArray(result.__images)) {
          // If an image carries a label (e.g. "t=3.2s" for multi-frame times), use it; otherwise use shot index
          for (const im of result.__images) if (im?.base64) images.push({ ...im, name: `${call.name} ${im.label ?? `Shot ${im.sceneIndex ?? '?'}`}` });
          const { __images, ...rest } = result;
          result = { ...rest, images: `${result.__images.length} images are at the end of this message, in order` };
        }
        const output = typeof result === 'string' ? result : JSON.stringify(result ?? null);
        ok ? completed++ : failed++;
        if (!ok) roundFails.set(failureKey(call.name, result), { tool: call.name, text: output.slice(0, 200) });
        if (ok && isReportTool(call.name) && call.input?.final === true) reported = true;
        if (ok && isUserMessageCall(call.name, call.input)) spoke = true;
        this.onEvent({ type: 'tool_result', callId: call.id, round, name: call.name, ok, summary: output.slice(0, 1000), output: result, durationMs: Date.now() - begin });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: output, is_error: !ok });
      }
      /*
       * The same tool + the same issue chained together. Reset those that no longer appeared this round:
       * succeeding once in between means it is no longer considered "consecutive".
       */
      for (const key of [...failStreak.keys()]) if (!roundFails.has(key)) failStreak.delete(key);
      const streaked = [];
      for (const [key, info] of roundFails) {
        const n = (failStreak.get(key) ?? 0) + 1;
        failStreak.set(key, n);
        if (n >= 2) streaked.push({ ...info, n });
      }
      const worstStreak = streaked.reduce((max, s) => Math.max(max, s.n), 0);
      // 2nd time: a hard prompt calling out that this capability is unavailable this time, and pointing
      // back to the decision table in the prompt. 3rd time stops directly below
      const streakNote = worstStreak === 2
        ? `${streaked.filter(s => s.n === 2).map(s => s.tool).join(', ')} failed 2 times in a row with the same error: ${streaked.find(s => s.n === 2).text}\n`
          + 'Do not call it a 3rd time with the same arguments. This capability is unavailable this time: either take another route and state in the closing report that this step was not completed, '
          + 'or, if it is a hard prerequisite of what the user asked for this time, call report_progress with final set to true right now, write the blocker into problems and what the user can do into todo, then stop.'
        : '';
      this.onEvent({ type: 'diagnostic', stage: 'fail-streak', data: { round, streaks: streaked.map(s => ({ tool: s.tool, times: s.n })) } });
      /*
       * Round budget: remind once when halfway through and once when only a quarter remains. Do not mention
       * on the final round (left is 0): that round was going to wrap up anyway, and the "Reached N-round limit"
       * message below will explain why it stopped. Also omit if this round is already judged to stop.
       */
      let budgetNote = '';
      if (!this.deepAuto && Number.isFinite(this.maxIterations) && worstStreak < 3) {
        const left = this.maxIterations - round;
        const mark = left <= Math.floor(this.maxIterations / 4) ? 'quarter' : left <= Math.floor(this.maxIterations / 2) ? 'half' : null;
        if (mark && left > 0 && !budgetSent.has(mark)) {
          budgetSent.add(mark);
          // Also backfill the flag for the halfway mark, preventing receiving two when crossing both lines in a single step
          if (mark === 'quarter') budgetSent.add('half');
          budgetNote = mark === 'half'
            ? `${left} model round trips left (one round = one reply from you, no matter how many tools it calls).`
              + ' From now on, first land the smallest deliverable version in the project (create the card → add_clip onto the timeline → take a look), then come back to polish; '
              + 'Anything written in a code block and not yet handed to a tool does not count as delivered. Write what you run out of time for into the todo of report_progress.'
            : `Only ${left} model round trips left. Immediately submit what you have already written (card source in a code block → create_card → add_clip), `
              + 'Do not start any new large piece of work; after submitting, call report_progress with final set to true to wrap up, and list everything unfinished one by one in todo.';
        }
      }
      // Place images in the same user message as tool results, after all tool_result blocks.
      // Reason for not starting a new message: that would create two consecutive user messages, and the
      // three APIs have different tolerances for consecutive same-role messages. Attaching to the same
      // message is a shape explicitly supported by all three.
      this.history.append({ role: 'user', content: [
        ...results,
        ...(images.length ? [
          ...images.map(im => ({ type: 'image', mime: im.mime || 'image/png', data: im.base64 })),
          { type: 'text', text: `Above are the frames captured from ${images.map(i => i.name).join(', ')}. Judge by the frames, do not imagine the result from the source code.` },
        ] : []),
        // This reply still has incomplete tool calls (truncated): instructions on how to continue writing
        // follow tool results in the same message
        ...(truncationNote ? [{ type: 'text', text: truncationNote }] : []),
        ...(streakNote ? [{ type: 'text', text: streakNote }] : []),
        ...(budgetNote ? [{ type: 'text', text: budgetNote }] : []),
      ] });
      const fingerprint = canonical(calls.map((c, index) => ({ name: c.name, input: c.input, result: results[index].content })));
      recent.push(fingerprint);
      if (recent.length > 6) recent.shift();
      const repeats = recent.filter(f => f === fingerprint).length;
      if (worstStreak >= 3) {
        const worst = streaked.find(s => s.n === worstStreak);
        outcome = 'stalled';
        summaryReason = `${worst.tool} failed ${worstStreak} times in a row with the same error; stopped useless retries`;
      } else if (repeats >= 3) {
        outcome = 'stalled'; summaryReason = 'Repeated actions with no change in results; stopped the useless loop';
      } else if (round === this.maxIterations) {
        // Do not report round count under deep autonomy: this line enters model context as a user message
        // (see summarizing branch at start of loop)
        outcome = 'round_limit';
        summaryReason = this.deepAuto ? 'This run has reached its limit' : `Reached the limit of ${this.maxIterations} model round trips`;
      }
      this.history.pruneImages();
      if (this.maxInputTokens > 0 && lastInput > 0) this.history.fitTokens(lastInput, this.maxInputTokens);
      else this.history.truncate();
    }
    progress(lastRound, outcome === 'completed' ? 'completed' : 'paused', outcome === 'completed' ? `Done this time: ${completed} succeeded, ${failed} failed.` : summaryReason);
    return { text: lastText, history: this.history, usage, outcome, completed, failed };
  }
}
