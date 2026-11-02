/**
 * Add automatic retry to direct API requests.
 *
 * # Background
 *
 * When upstreams are congested, relay services return directly:
 *
 *   openai HTTP 429: Current group upstream load is saturated, please try again later
 *
 * Such errors are **transient**; resending after a few seconds will mostly succeed. But currently,
 * hitting this immediately aborts the entire chat with an error, so the user sees red error text
 * instead of the result after waiting briefly.
 *
 * # Which status codes are worth retrying
 *
 * According to the HTTP Status Codes page in the openlux documentation
 * (doc.openlux.ai/en/tutorials/http-status-codes):
 *
 *   408 Timeout            "Shrink payload, retry, or use async APIs"
 *   429 Too Many Requests  "Back off; lower concurrency"
 *   500 Internal Error     "Retry later"
 *   502 / 503 / 504        "Exponential backoff; reduce concurrency at peak"
 *
 * Not retried: 400 (bad parameter), 401 (invalid key), 403 (no permission / model not in group /
 * IP not allowed), 404 (invalid path or task id). Sending these a hundred more times yields the same
 * result; retrying only delays the error, making the user see what actually needs fixing later.
 *
 * Network layer exceptions (connection reset, DNS glitch, TLS handshake failure) are also retried:
 * that is the same as 502. But **AbortError is not retried**: that is when the user clicked stop,
 * or upper layer timed out; retrying amounts to disobeying.
 *
 * # Why only wrap the "send request" step, not the stream
 *
 * These are all streaming requests. Retrying is safe **only before reading the stream begins**:
 * when receiving an error status code, not a single byte of body has been delivered to upper layers,
 * so resending is clean. But when a stream breaks midway, resending the entire request causes the model
 * to start over from the beginning, duplicating the portion already displayed: in that case it must
 * report an error, letting the user decide whether to retry.
 * Therefore, this wrapper only recognizes two cases: "response has not returned yet" and "response
 * returned but status code is retryable".
 */

import { createSseParser } from './providers/base.mjs';
import { createThinkSplitter } from './think-tags.mjs';

/** Status codes documented as retryable */
export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export const DEFAULT_RETRY = Object.freeze({
  /** Maximum retry attempts (excluding the first). User requested 10 */
  maxRetries: 10,
  /** How long to back off on the first attempt */
  baseDelayMs: 500,
  /** Upper bound for single backoff. Capped at this once exponential growth reaches it */
  maxDelayMs: 8000,
  /**
   * Total budget for the entire request (including all retries and waits).
   *
   * A single upstream timeout (such as openlux gateway returning SSE upstream timed out in 90~95s, or
   * local 120s idle timeout) is about 90~120 seconds; if only 5 minutes is given, 4 consecutive attempts
   * (initial + 3 retries, totaling ~380s) would be prematurely truncated by the total budget on retry 3/10.
   * Setting it to 20 minutes is sufficient to cover full backoff retries for maxRetries: 10,
   * throwing the last error once time expires.
   */
  maxTotalMs: 20 * 60 * 1000,
});

/** Sleep briefly, abortable in the meantime (do not keep waiting blindly if user clicked stop) */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Distinguish between "user actively clicked stop" and "single-attempt internal idle timeout (TimeoutError)".
 *
 * - As long as the caller passed an external signal (opts.signal or init.signal), only recognize
 *   outer signal.aborted as the single true proof: withIdleTimeout is wrapped inside createRetryingFetch;
 *   TimeoutError / AbortError thrown when a single attempt times out does not make external signal.aborted
 *   true, and should continue backoff retry as a retryable failure.
 * - When the caller did not pass an external signal (e.g. bare unit tests), TimeoutError is still
 *   retried as a timeout, and only non-timeout AbortError is treated as stop.
 */
function isUserAbort(e, externalSignal) {
  if (externalSignal) return Boolean(externalSignal.aborted);
  const msg = String(e?.message || '');
  if (e?.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(msg)) return false;
  return e?.name === 'AbortError' || /aborted|abort/i.test(msg);
}

/**
 * Extract error description from a single parsed SSE event; return null if not an error event.
 */
export function extractSseError(event, parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (event !== 'error' && parsed.type !== 'error' && !parsed.error) return null;
  const raw = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const message = typeof parsed.error === 'string'
    ? parsed.error
    : (raw.message || parsed.message || 'API stream returned an error');
  const type = String(raw.type || parsed.type || '');
  const code = raw.code ?? parsed.code ?? null;
  const statusNum = Number(raw.status ?? raw.http_status ?? parsed.status ?? (typeof code === 'number' ? code : NaN));
  return {
    message: String(message),
    type,
    code,
    status: Number.isFinite(statusNum) ? statusNum : null,
  };
}

const NON_RETRYABLE_SSE_ERROR_RE =
  /invalid[_ -]?api[_ -]?key|incorrect[_ -]?api[_ -]?key|authentication[_ -]?error|unauthenticated|unauthorized|permission[_ -]?error|permission[_ -]?denied|forbidden|access denied|invalid[_ -]?argument|invalid[_ -]?request|bad[_ -]?request|unknown name|model[_ -]?not[_ -]?found|not[_ -]?found[_ -]?error|context[_ -]?length[_ -]?exceeded|maximum context length|insufficient[_ -]?quota|exceeded your current quota|credit balance is too low|out of credits|payment required|insufficient balance|quota exhausted/i;

const RETRYABLE_SSE_ERROR_RE =
  /timed?\s*out|timeout|overloaded|saturated|rate[_ -]?limit|too many requests|\b(408|429|500|502|503|504|529)\b|bad gateway|service unavailable|gateway timeout|internal[_ -]?(server[_ -]?)?error|server[_ -]?error|api[_ -]?error|upstream|try again( later)?|temporarily unavailable|connection reset|socket hang up|econnreset|etimedout|busy/i;

/**
 * Determine whether an error event before the first packet in the SSE stream is a retryable
 * transient failure.
 * Explicit parameter errors, auth errors, nonexistent models, and exhausted account quotas are
 * never retried.
 */
export function isRetryableSseError(info) {
  if (!info) return false;
  const status = typeof info.status === 'number' ? info.status : null;
  if (status !== null && (status === 400 || status === 401 || status === 402 || status === 403 || status === 404 || status === 422)) {
    return false;
  }
  const combined = `${info.type || ''} ${info.code ?? ''} ${info.message || ''}`;
  if (NON_RETRYABLE_SSE_ERROR_RE.test(combined)) return false;
  if (status !== null && (RETRYABLE_STATUS.has(status) || status === 529)) return true;
  return RETRYABLE_SSE_ERROR_RE.test(combined);
}

function isSseStreamResponse(response) {
  if (!response?.ok || !response?.body) return false;
  if (typeof response.body[Symbol.asyncIterator] !== 'function' && typeof response.body.getReader !== 'function') {
    return false;
  }
  const ct = response.headers?.get?.('content-type') || '';
  if (!ct) return true;
  return /text\/event-stream/i.test(ct);
}

function toAsyncIterator(body) {
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const it = body[Symbol.asyncIterator]();
    return {
      next: () => it.next(),
      close: async () => { try { await it.return?.(); } catch {} },
    };
  }
  const reader = body.getReader();
  return {
    next: () => reader.read(),
    close: async () => {
      try { await reader.cancel?.(); } catch {}
      try { reader.releaseLock?.(); } catch {}
    },
  };
}

function rebuildResponse(response, bufferedChunks, remainingIter) {
  async function* replayedBody() {
    try {
      for (const chunk of bufferedChunks) {
        yield chunk;
      }
      if (remainingIter) {
        while (true) {
          const { done, value } = await remainingIter.next();
          if (done) break;
          yield value;
        }
      }
    } finally {
      if (remainingIter) {
        await remainingIter.close();
      }
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    text: typeof response.text === 'function' ? () => response.text() : async () => '',
    json: typeof response.json === 'function' ? () => response.json() : async () => ({}),
    body: replayedBody(),
  };
}

/**
 * Preread HTTP 200 SSE stream until confirming output of the first deliverable downstream content
 * block (text_delta / thinking_delta / tool_use) or normal finalization event.
 *
 * - If receiving a retryable SSE error event before yielding any content block (e.g. openlux gateway
 *   sending `The upstream service timed out. Please try again later.` after 90s) or empty stream ends
 *   unexpectedly, return `{ ok: false }` to trigger retry;
 * - If receiving a non-retryable SSE error (such as invalid api key / invalid argument), return
 *   `{ ok: true }` to pass through as-is to downstream to report error immediately;
 * - Once the first valid content block is seen, replay already-read raw chunks as-is and concatenate
 *   subsequent stream; any subsequent stream error is never resent.
 */
async function preflightSseResponse(response, userSignal) {
  const iter = toAsyncIterator(response.body);
  const bufferedChunks = [];
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const think = createThinkSplitter();
  const partialAnthropicTools = new Set();

  const inspectEvents = (evs) => {
    for (const { event, data } of evs) {
      if (!data || data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Pass custom non-JSON stream data through directly
        return { kind: 'content' };
      }
      const errInfo = extractSseError(event, parsed);
      if (errInfo) {
        if (isRetryableSseError(errInfo)) {
          return {
            kind: 'retryable_error',
            message: errInfo.message,
            reason: `SSE error: ${errInfo.message}`,
          };
        }
        return { kind: 'non_retryable_error' };
      }

      // Anthropic SSE event determination
      const anthType = event && event !== 'message' ? event : parsed?.type;
      if (
        anthType === 'ping' ||
        anthType === 'message_start' ||
        anthType === 'content_block_start' ||
        anthType === 'content_block_delta' ||
        anthType === 'content_block_stop' ||
        anthType === 'message_delta' ||
        anthType === 'message_stop'
      ) {
        if (anthType === 'content_block_start') {
          if (parsed?.content_block?.type === 'tool_use') {
            partialAnthropicTools.add(parsed.index);
          }
          continue;
        }
        if (anthType === 'content_block_delta') {
          if (
            (parsed?.delta?.type === 'text_delta' && parsed.delta.text) ||
            (parsed?.delta?.type === 'thinking_delta' && parsed.delta.thinking)
          ) {
            return { kind: 'content' };
          }
          continue;
        }
        if (anthType === 'content_block_stop') {
          if (partialAnthropicTools.has(parsed?.index)) {
            return { kind: 'content' };
          }
          continue;
        }
        if (anthType === 'message_stop' || (anthType === 'message_delta' && parsed?.delta?.stop_reason)) {
          return { kind: 'content' };
        }
        continue;
      }

      // OpenAI-compatible SSE event determination
      if (Array.isArray(parsed?.choices)) {
        const choice = parsed.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (think.push(delta.content).length > 0) {
            return { kind: 'content' };
          }
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          return { kind: 'content' };
        }
        if (choice.finish_reason) {
          return { kind: 'content' };
        }
        continue;
      }
      if (parsed && typeof parsed === 'object' && 'usage' in parsed && !('choices' in parsed) && !('candidates' in parsed)) {
        continue;
      }

      // Gemini SSE event determination
      if (Array.isArray(parsed?.candidates)) {
        const cand = parsed.candidates[0];
        if (!cand) continue;
        const parts = cand.content?.parts;
        if (Array.isArray(parts) && parts.some((p) => p && (p.thought === true || p.text || p.functionCall))) {
          return { kind: 'content' };
        }
        if (cand.finishReason) {
          return { kind: 'content' };
        }
        continue;
      }
      if (parsed && typeof parsed === 'object' && 'usageMetadata' in parsed && !('candidates' in parsed)) {
        continue;
      }

      // Pass through other non-empty JSON events as valid content
      return { kind: 'content' };
    }
    return { kind: 'preamble' };
  };

  try {
    while (true) {
      if (userSignal?.aborted) {
        await iter.close();
        throw userSignal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      const { done, value } = await iter.next();
      if (done) {
        const tailEvs = parser(decoder.decode() + '\n\n');
        const tail = inspectEvents(tailEvs);
        await iter.close();
        if (tail.kind === 'content' || tail.kind === 'non_retryable_error') {
          return { ok: true, response: rebuildResponse(response, bufferedChunks, null) };
        }
        if (tail.kind === 'retryable_error') {
          return {
            ok: false,
            reason: tail.reason,
            error: new Error(tail.message),
            fallbackResponse: rebuildResponse(response, bufferedChunks, null),
          };
        }
        return {
          ok: false,
          reason: 'SSE stream ended before first content block',
          error: new Error('The API response stream ended early or returned no SSE data. Check the API protocol.'),
          fallbackResponse: rebuildResponse(response, bufferedChunks, null),
        };
      }

      bufferedChunks.push(value);
      const str = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      const step = inspectEvents(parser(str));
      if (step.kind === 'content' || step.kind === 'non_retryable_error') {
        return { ok: true, response: rebuildResponse(response, bufferedChunks, iter) };
      }
      if (step.kind === 'retryable_error') {
        await iter.close();
        return {
          ok: false,
          reason: step.reason,
          error: new Error(step.message),
          fallbackResponse: rebuildResponse(response, bufferedChunks, null),
        };
      }
    }
  } catch (e) {
    await iter.close();
    throw e;
  }
}

/**
 * If the server specifies "how long to wait before coming back", respect it.
 * `Retry-After` can be seconds or an HTTP date. Impose an upper limit to prevent the peer from
 * throwing a massive value that hangs us indefinitely.
 */
function retryAfterMs(response, capMs) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, capMs);
}

/**
 * How long to wait for retry n: exponential backoff + jitter. Jitter prevents concurrent
 * requests from returning at the exact same moment and colliding again.
 */
export function backoffMs(attempt, { baseDelayMs, maxDelayMs }, rand = Math.random) {
  const raw = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return Math.round(raw * (0.5 + rand() * 0.5));
}

/**
 * Wrap a fetch to automatically retry.
 *
 * @param fetchImpl The actual request sender (called anew on every attempt: usually creates a new
 *                  per-attempt timeout signal inside, and cannot reuse the already-burned one from
 *                  the previous attempt)
 * @param opts.signal   User stop signal. Respected during backoff wait as well
 * @param opts.onRetry  Callback on each retry decision `{ attempt, status, delayMs, reason }`, used for logging
 */
export function createRetryingFetch(fetchImpl, opts = {}) {
  const cfg = { ...DEFAULT_RETRY, ...opts };
  const { signal, onRetry, rand } = opts;

  return async function retryingFetch(url, init) {
    const startedAt = cfg.now ? cfg.now() : Date.now();
    const now = () => (cfg.now ? cfg.now() : Date.now());
    const userSignal = signal && init?.signal
      ? AbortSignal.any([signal, init.signal])
      : (signal || init?.signal);
    let lastError = null;

    for (let attempt = 0; ; attempt++) {
      let response = null;
      let sseFailure = null;
      try {
        response = await fetchImpl(url, init);
        if (response && !RETRYABLE_STATUS.has(response.status)) {
          if (isSseStreamResponse(response)) {
            const preflight = await preflightSseResponse(response, userSignal);
            if (preflight.ok) return preflight.response;
            sseFailure = preflight;
            lastError = preflight.error;
          } else {
            return response;
          }
        }
      } catch (e) {
        if (isUserAbort(e, userSignal)) throw e; // User actively stopped; do not retry
        lastError = e;
        response = null;
      }

      const canRetry = attempt < cfg.maxRetries;
      const overBudget = now() - startedAt >= cfg.maxTotalMs;
      if (!canRetry || overBudget) {
        // Retries exhausted: if an SSE preread failure replay shell exists, pass it up for the provider to
        // throw as-is; if an HTTP error response exists, pass to assertOk; otherwise throw the last exception
        if (sseFailure?.fallbackResponse) return sseFailure.fallbackResponse;
        if (response) return response;
        throw lastError;
      }

      const delay = (!sseFailure && response ? retryAfterMs(response, cfg.maxDelayMs) : null)
        ?? backoffMs(attempt, cfg, rand);

      // Error response body must be consumed, otherwise connection may hang without returning to the pool
      if (response && !sseFailure) { try { await response.text(); } catch { /* Doesn't matter */ } }

      onRetry?.({
        attempt: attempt + 1,
        of: cfg.maxRetries,
        status: response ? response.status : null,
        delayMs: delay,
        reason: sseFailure
          ? sseFailure.reason
          : (response ? `HTTP ${response.status}` : String(lastError?.message || lastError)),
      });

      await sleep(delay, userSignal);
    }
  };
}

