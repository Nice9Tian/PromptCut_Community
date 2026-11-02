import type { ChatMessage, MessageRuntime, PublicAiConfig, RunEvent } from './types';
import { tr } from "../i18n/index.ts";

// Redact structured secrets and common pasted credentials; never include API
// headers, raw settings files, or provider reasoning channels in an export.
export function redactDebug(value: unknown): unknown {
  /*
   * Key matching **must not use start/end anchors**. Originally written as
   * /^(api[_-]?key|authorization|…)$/, so real request headers like `x-api-key`,
   * `anthropic-api-key`, `proxy-authorization` did not match at all: plaintext keys entered
   * the uploaded diagnostic report untouched.
   *
   * But we cannot loosen it to "mask if it contains token": `max_tokens` and `promptTokens` are the
   * most useful numbers during troubleshooting. So changed to "match full segment suffix on word
   * boundary (start or after - _ .)": `x-api-key` matches, `max_tokens` does not.
   */
  const secret = /(^|[-_.])(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|client[_-]?secret|secret|cookie|credential|ticket|delegation|delegate|grant)s?$/i;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
      // Key shapes from other vendors, plus delegation tickets and chat delegations on the hosted side
      // (v1.<segment>.<segment>, see server/auth/tickets.mjs). Reports for cloud chats have long scanned
      // for these shapes; local chat reports could also bring them in from tool results, error messages,
      // or user pastes, sharing the same baseline.
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
      .replace(/\bxai-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
      .replace(/\bgsk_[A-Za-z0-9]{16,}/g, '[REDACTED]')
      .replace(/\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[TICKET-REDACTED]')
      // The local identifier is the decryption passphrase for config distribution; the whole string
      // must not enter reports. The server side already intercepts it, but we add a fallback here:
      // it could also slip in via execution logs, error messages, or text pasted by the user.
      .replace(/\bPCM-[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}\b/gi, (m) => `${m.slice(0, 9)}-…`)
      // Credentials in query strings. Originally only four fixed names were listed, missing the most
      // common bare `token=`; changed to "mask if parameter name contains
      // key/token/secret/password/auth/sig": for diagnostic reports, better to over-mask than miss one.
      .replace(/([?&][\w.-]*(?:key|token|secret|password|passwd|auth|sig)[\w.-]*=)[^&\s"']+/gi, '$1[REDACTED]')
      // Usernames are PII, while local paths appear in almost every log. We only wipe the home directory
      // portion and keep the relative structure after it: troubleshooting relies on seeing which level
      // files reside in.
      .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/"'\s]+/gi, '$1[USER]')
      .replace(/(\/(?:home|Users)\/)[^/"'\s]+/g, '$1[USER]');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, secret.test(k) ? '[REDACTED]' : walk(x)]));
    return v;
  };
  return walk(value);
}

export function recordTrace(message: ChatMessage, event: RunEvent): ChatMessage {
  const trace = message.trace || [];
  if ((trace.length >= 2000 || (message.traceBytes || 0) >= 1500000) && event.type !== 'done' && event.type !== 'error') return { ...message, traceTruncated: true };
  // A tool result's full output (get_project returns the whole project) is never
  // shown by the chat, and redacting plus serialising it on every result was the
  // expensive part of tracing. The summary is kept; the output is marked omitted.
  const traced = event.type === 'tool_result' && 'output' in event
    ? { ...event, output: undefined, outputOmitted: true }
    : event;
  const serialized = JSON.stringify(redactDebug(traced));
  // Huge project/video results should not fill localStorage or freeze the UI.
  const safeEvent: RunEvent = serialized.length > 32000
    ? { type: 'diagnostic', stage: 'large_event_truncated', data: { originalType: event.type, chars: serialized.length, preview: serialized.slice(0, 32000) } }
    : JSON.parse(serialized);
  const last = trace.at(-1);
  if (safeEvent.type === 'text' && last?.event.type === 'text' && last.event.delta.length < 8000) {
    return { ...message, traceBytes: (message.traceBytes || 0) + serialized.length, trace: [...trace.slice(0, -1), { ...last, event: { type: 'text', delta: last.event.delta + safeEvent.delta } }] };
  }
  return { ...message, traceBytes: (message.traceBytes || 0) + Math.min(serialized.length, 32000), trace: [...trace, { at: new Date().toISOString(), event: safeEvent }], traceTruncated: message.traceTruncated || serialized.length > 32000 };
}

/** Compress the same settings into one line to count "how many configurations were used across this chat" */
function runtimeKey(r: MessageRuntime): string {
  return [r.provider, r.model || tr("(default)"), r.effort || tr("(default)"), r.fast ? 'fast' : '-', r.deepAuto ? 'deep' : '-', r.toolProtocol ? 'textproto' : '-'].join(' / ');
}

/**
 * Human-readable description of what this reply used, placed atop the report to avoid digging
 * through hundreds of lines of JSON.
 */
function describeRuntime(r: MessageRuntime): string {
  const bits = [r.provider, tr("model {0}", r.model || tr("default")), tr("thinking {0}", r.effort || tr("default"))];
  if (r.fast) bits.push(tr("fast"));
  // Specific rounds are in settings (deepAutoRounds); unrecorded in runtime, so only note it is on without guessing
  if (r.deepAuto) bits.push(tr("deep autonomy"));
  if (r.toolProtocol) bits.push(tr("text protocol mode"));
  return bits.join(tr(","));
}

export function conversationReport(messages: ChatMessage[], provider: string | null, config?: PublicAiConfig | null, environment?: unknown): string {
  /*
   * Each reply carries its own runtime. Reporting only "what is currently selected" misidentifies:
   * model, thinking tier, and acceleration tier are all read live at send time. If the user switches
   * mid-chat, adjacent messages come from different models; in split-work mode, other providers are
   * temporarily used per role. If changed midway, point it out directly here.
   */
  const used = new Map<string, MessageRuntime>();
  let unrecorded = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.runtime) used.set(runtimeKey(m.runtime), m.runtime);
    else unrecorded++;
  }
  const distinct = [...used.values()];

  return JSON.stringify(redactDebug({
    format: 'PromptCut conversation debug v2', exportedAt: new Date().toISOString(), provider,
    runtime: {
      switchedMidConversation: distinct.length > 1,
      summary: distinct.length === 0
        ? tr("No message in this chat recorded its runtime config (old history from before 0.2.9)")
        : distinct.length === 1
          ? tr("One config throughout: {0}", describeRuntime(distinct[0]))
          : tr("⚠ Config changed midway, {0} in total, see messages[].runtime for each message", distinct.length),
      used: distinct.map((r) => ({ ...r, note: describeRuntime(r) })),
      // Replies in older history lack this field; clarify that it was "unrecorded" rather than "never changed"
      unrecordedAssistantMessages: unrecorded,
      textProtocolEverUsed: distinct.some((r) => r.toolProtocol),
    },
    api: provider === 'api' ? { vendor: config?.api.vendor, model: config?.api.model, maxTokens: config?.api.maxTokens } : undefined,
    /*
     * State at time of failure: mode, project and media, backend session cabinet, Node process status.
     *
     * With chat alone, neither "product bug" nor "environment issue on this machine" can be ruled out.
     * This happens when users report "Agent can see media from other projects": the report shows the
     * model uttering a nonexistent filename, but cannot show whether the media library was empty or
     * where the project resided: leaving no choice but to ask back and forth.
     *
     * Collection failure does not block the report: missing a piece of context is better than failing
     * to export the whole thing, so what is gathered here is "what was obtained" rather than
     * "guaranteed to obtain", with upstream filling in an error on failure.
     */
    environment,
    note: tr("Contains the visible chat, execution events and a snapshot of the environment at the time; does not contain keys or the model's private thinking. Large outputs and overlong events are marked as truncated."), messages,
  }), null, 2);
}

/**
 * Lock "Copy" when exceeding this length, leaving only the save-to-file path.
 *
 * Choosing 100,000 characters is based on "can it still be pasted": with every execution event
 * included, reports easily reach hundreds of KB; pasting into chat is laggy and unreadable, so
 * offering a file for the user to send directly is better.
 */
export const DEBUG_INLINE_LIMIT = 100_000;

/** Save to local "diagnostic report" directory and open containing folder, returning path on disk */
export async function saveReportToFile(text: string, label: string): Promise<{ dir: string; file: string }> {
  const res = await fetch('/api/ai/diagnostics/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, label }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.error || tr("Save failed, HTTP {0}", res.status));
  return { dir: data.dir, file: data.file };
}

export async function copyDebugReport(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* WebView/permissions fallback. */ }
  const field = document.createElement('textarea');
  field.value = text; field.style.position = 'fixed'; field.style.opacity = '0';
  document.body.appendChild(field); field.select();
  try { if (!document.execCommand('copy')) throw new Error(tr("Automatic copy failed, please select the text and copy it manually")); }
  finally { field.remove(); }
}

/**
 * Save report as a file in browser (download a copy). Online pages have no editor process to write
 * to disk for them (and cannot request `/api/*`), so cloud chat diagnostic reports take this path;
 * returns a receipt message for the user.
 */
export function downloadReportFile(text: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const name = `${label.replace(/[\/:*?"<>|\s]+/g, '_') || tr("diagnostic reports")}-${stamp}.json`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return tr("Downloaded: {0}", name);
}
