/**
 * 400 tier downgrade / field swap for output limit: record a log line, and return a `notice` event
 * (harness/agent.mjs converts it into a diagnostic event, which goes into the run log and diagnostic
 * report). Log name is `harness.max-output-fallback`. The log contains only vendor, model, action, and
 * numbers; no body text, no Key.
 */
export function noteOutputFallback({ vendor, model, action, from, to, status = 400 }) {
  const data = { vendor, model, action, from, to, status };
  try { console.error(`[harness.max-output-fallback] ${JSON.stringify(data)}`); } catch { /* Failing to write log does not affect this round */ }
  return { type: 'notice', stage: 'max-output-fallback', data };
}

/** Wrap error response whose body was read back into a shell so assertOk reports that message as usual */
export const asRead = (r, text) => ({ ok: false, status: r.status, headers: r.headers, text: async () => text });
