/**
 * Streaming request timeouts should be calculated by "how long no data has arrived", not "how long it has run in total".
 *
 * # Cause
 *
 * Originally `AbortSignal.timeout(120000)`: that was **the wall-clock limit for the entire request**,
 * including time reading the stream.
 * Consequently, a long turn streaming healthily for 121 seconds was forcefully cut off, with
 * "The operation was aborted due to timeout" in the UI, stopping half-spoken text right there.
 * The larger the context and the more tools there are, the more likely a turn exceeds two minutes:
 * in other words, **the more work done, the more easily it gets cut off**.
 *
 * # Approach
 *
 * Reset the timer every time a chunk of data is received. Triggers only when genuinely stuck
 * (upstream stops emitting words); streaming normally never times out regardless of duration.
 * The connection phase is also governed by it: failing to receive response headers long after sending
 * also counts as "no data arrived".
 *
 * Wrapped at the fetch layer, requiring no changes to provider or agent: what they see is still a normal response.
 */

/** Create a timeout error with the same shape as `AbortSignal.timeout`, so upper layers can recognize it the old way */
function timeoutError(ms) {
  const e = new Error(`The operation was aborted due to timeout (no data received for ${Math.round(ms / 1000)} seconds)`);
  e.name = 'TimeoutError';
  return e;
}

function toBodyIterator(source) {
  if (typeof source?.[Symbol.asyncIterator] === 'function') {
    const it = source[Symbol.asyncIterator]();
    return {
      next: () => it.next(),
      close: async () => { try { await it.return?.(); } catch {} },
    };
  }
  if (typeof source?.getReader === 'function') {
    const reader = source.getReader();
    return {
      next: () => reader.read(),
      close: async () => {
        try { await reader.cancel?.(); } catch {}
        try { reader.releaseLock?.(); } catch {}
      },
    };
  }
  return null;
}

/**
 * Wrap fetch with an "idle timeout".
 *
 * @param fetchImpl Function that actually sends the request
 * @param idleMs    Duration without any data before considering it stuck
 */
export function withIdleTimeout(fetchImpl, { idleMs = 120000 } = {}) {
  return async function idleTimeoutFetch(url, init) {
    const ac = new AbortController();
    let timer = null;
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const bump = () => {
      stop();
      timer = setTimeout(() => ac.abort(timeoutError(idleMs)), idleMs);
      // This timer should not block process exit: the request itself has other ways to terminate
      timer.unref?.();
    };

    bump();
    const signal = init?.signal ? AbortSignal.any([init.signal, ac.signal]) : ac.signal;

    let res;
    try {
      res = await fetchImpl(url, { ...init, signal });
    } catch (e) {
      stop();
      throw e;
    }

    // Errored responses do not stream; body is read all at once by assertOk, so the timer can be stopped
    if (!res || !res.ok || !res.body) {
      stop();
      return res;
    }

    bump(); // Response headers arrived, restart timer: next is to see whether the first chunk of body arrives promptly

    const source = res.body;
    async function* watched() {
      const iter = toBodyIterator(source);
      if (!iter) {
        stop();
        return;
      }
      try {
        while (true) {
          const { done, value } = await iter.next();
          if (done) break;
          bump();
          yield value;
        }
      } finally {
        stop();
        await iter.close();
      }
    }

    /*
     * Only replace body, copy other fields as is.
     *
     * Neither use Proxy nor mutate the original object: downstream only uses ok / status / headers / text / body
     * (assertOk and readSse); writing them out explicitly is clearer than reflection, and avoids blowing up
     * after wrapping due to some Response getter bound to the prototype.
     */
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      text: () => res.text(),
      json: () => res.json(),
      body: watched(),
    };
  };
}

