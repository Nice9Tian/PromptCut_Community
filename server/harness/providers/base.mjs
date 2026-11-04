// Corresponds to claude-quickstarts/agents/providers/base.py

/**
 * Provider contract:
 * createProvider(cfg, { fetchImpl = globalThis.fetch } = {})
 * Returns { name: string, stream: async function*(messages, tools, system, signal) }
 * 
 * stream yields one of the following events:
 * - { type: 'text_delta', text: string }
 * - { type: 'tool_use', id: string, name: string, input: object }
 * - { type: 'usage', input: number, output: number, cacheRead?: number }
 *   input is the full input length for this turn (including cached parts); cacheRead is the cached
 *   amount among them, present only for providers that report it
 * - { type: 'stop', reason: string }
 * - { type: 'tool_use_partial', id, name, args: string }  Incomplete tool call when hitting the output
 *   limit; args is the raw arguments received (A07)
 * - { type: 'notice', stage: string, data: object }       Notice for the run log (output limit 400 tier
 *   stepdown, field replacement, stream cut midway)
 * - { type: 'response_open', sentAt: number }             Response headers arrived; sentAt is the
 *   timestamp of the last actual request (used for elapsed time when capping by speed)
 *
 * Stop reason `stream_cut` (STREAM_CUT): stream disconnected after it started emitting data and before
 * normal finalization: an error event arrived in the stream, connection was severed, or stream ended
 * without a finalization flag. All three providers finalize as truncated: already received text is
 * delivered as usual, incomplete tool calls are delivered as tool_use_partial, and agent.mjs stores
 * the code block and lets the model continue writing (user decision, 2026-10-22: "Treat midway gateway
 * disconnection as truncation (preserve partial arguments, continue via code blocks)").
 * If disconnected before receiving any data, throw an error as usual.
 */

/** Stop reason: stream disconnected before normal finalization (mostly gateway ~300s limit, verified 2026-10-22) */
export const STREAM_CUT = 'stream_cut';

/**
 * Whether this error thrown while reading the stream can be treated as "cut off midway": user
 * clicking stop (signal aborted) and our own idle timeouts (TimeoutError / AbortError) do not count,
 * throw as usual. An idle timeout means upstream produced no text for 120 seconds and has existing
 * retry logic (retryable in runners/api.mjs); leave unchanged this time [ruling:stream-cut 2026-10-22].
 */
export function isCutReadError(err, signal) {
  if (signal?.aborted) return false;
  const name = err?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') return false;
  return true;
}

/** Notice passed to the run log upon disconnection */
export function streamCutNotice(vendor, how, detail, extra = {}) {
  return { type: 'notice', stage: 'stream-cut', data: { vendor, how, detail: String(detail || '').slice(0, 300), ...extra } };
}

/**
 * Creates an SSE parser. Returns a function feed(chunkString) that returns an array of events
 * parsed in this call, with elements of the form {event, data}.
 */
export function createSseParser() {
  let buffer = '';
  let currentEvent = null;
  let currentData = [];

  return function feed(chunkString) {
    const events = [];
    buffer += chunkString;
    
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      
      buffer = buffer.slice(lineEnd + 1);
      
      if (line === '') {
        if (currentEvent !== null || currentData.length > 0) {
           events.push({
             event: currentEvent || 'message',
             data: currentData.join('\n')
           });
           currentEvent = null;
           currentData = [];
        }
      } else if (line.startsWith(':')) {
        // Comment line, ignore
      } else {
        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
          const field = line.slice(0, colonIndex);
          let value = line.slice(colonIndex + 1);
          if (value.startsWith(' ')) {
            value = value.slice(1);
          }
          
          if (field === 'event') {
            currentEvent = value;
          } else if (field === 'data') {
            currentData.push(value);
          }
        }
      }
      
      lineEnd = buffer.indexOf('\n');
    }
    
    return events;
  };
}

/**
 * Incrementally decodes response.body, yielding {event, data} one by one
 */
export async function* readSse(response, { signal } = {}) {
  const parser = createSseParser();
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      if (signal?.aborted) break;
      const str = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      const evs = parser(str);
      for (const ev of evs) {
        yield ev;
      }
    }
    const finalEvs = parser(decoder.decode() + '\n\n');
    for (const ev of finalEvs) {
       yield ev;
    }
  } else if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        const evs = parser(decoder.decode(value, { stream: true }));
        for (const ev of evs) {
          yield ev;
        }
      }
      const finalEvs = parser(decoder.decode() + '\n\n');
      for (const ev of finalEvs) {
         yield ev;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Asserts that the HTTP response is 2xx, otherwise throws a truncated exception
 */
export async function assertOk(response, vendor) {
  if (response.ok) return;
  
  let text = '';
  try {
    text = await response.text();
  } catch {
    // ignore
  }
  
  let msg = 'no message field';
  if (text) {
    try {
      const body = JSON.parse(text);
      if (body?.error?.message) {
        msg = body.error.message;
      } else if (body?.message) {
        msg = body.message;
      } else if (Array.isArray(body) && body[0]?.error?.message) {
        msg = body[0].error.message;
      }
    } catch {
      // not json
    }
  }
  
  if (msg.length > 300) {
    msg = msg.substring(0, 300);
  }
  
  throw new Error(`${vendor} HTTP ${response.status}: ${msg}`);
}
