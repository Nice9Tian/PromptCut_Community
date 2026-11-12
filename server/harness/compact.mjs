/**
 * Generic conversation & event-log compaction utilities for the Agent harness.
 *
 * Covers two complementary compaction layers:
 * 1. Event-stream delta compaction (`mergeDeltas`, `expandEntry`): merges adjacent character-by-
 *    character `text` and `thinking` deltas into compacted blocks (`fromSeq`, `seq`, `cuts`) while
 *    preserving lossless event-for-event replay.
 * 2. Conversation history compaction (`splitMessagesForCompact`, `buildCompactPrompt`,
 *    `buildCompactedMessages`, `compactHistory`): summarizes older `MessageHistory` turns via a
 *    model provider or custom summarizer while keeping recent turns intact and preserving all
 *    `tool_use` / `tool_result` pairing and role-alternation invariants.
 */

const MERGE_TYPES = new Set(['text', 'thinking']);

/** Whether two events are identical except for delta and sequence number (can merge into one) */
function sameShape(a, b) {
  const ka = Object.keys(a).filter((k) => k !== 'delta' && k !== 'seq' && k !== 'fromSeq' && k !== 'cuts');
  const kb = Object.keys(b).filter((k) => k !== 'delta' && k !== 'seq' && k !== 'fromSeq' && k !== 'cuts');
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** Unpack a compacted event log line back into individual events in the real-time stream */
export function* expandEntry(entry) {
  if (!Array.isArray(entry.cuts)) { yield entry; return; }
  const { cuts, fromSeq, delta, seq: _last, ...rest } = entry;
  let off = 0;
  for (let i = 0; i < cuts.length; i += 1) {
    yield { ...rest, delta: delta.slice(off, off + cuts[i]), seq: fromSeq + i };
    off += cuts[i];
  }
}

/**
 * Merge adjacent `text` / `thinking` deltas into full blocks (already merged blocks can be merged
 * further); returns a new array without mutating inputs.
 */
export function mergeDeltas(entries) {
  const out = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev && MERGE_TYPES.has(e.type) && prev.type === e.type && typeof e.delta === 'string' && typeof prev.delta === 'string' && sameShape(prev, e)) {
      const prevFrom = prev.fromSeq ?? prev.seq;
      const eFrom = e.fromSeq ?? e.seq;
      if (eFrom === prev.seq + 1) {
        out[out.length - 1] = {
          ...prev,
          delta: prev.delta + e.delta,
          fromSeq: prevFrom,
          seq: e.seq,
          cuts: [...(prev.cuts ?? [prev.delta.length]), ...(e.cuts ?? [e.delta.length])],
        };
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

export const COMPACT_SYSTEM_PROMPT =
  'You are compacting an ongoing Agent conversation so work can continue with a smaller context window. ' +
  'Write a concise, factual handoff summary covering: (1) user goals and constraints, (2) completed actions and verified tool results, ' +
  '(3) current state, identifiers, and key decisions, and (4) unfinished items or blockers. Do not call any tools.';

const hasBlockType = (msg, type) => Array.isArray(msg?.content) && msg.content.some((b) => b?.type === type);

function clipText(text, maxChars = 1200) {
  const s = String(text ?? '');
  return s.length > maxChars ? `${s.slice(0, maxChars)}…(truncated)` : s;
}

function formatMessageForSummary(msg, maxBlockChars = 1200) {
  const role = msg?.role === 'assistant' ? 'Assistant' : 'User';
  if (typeof msg?.content === 'string') return `[${role}] ${clipText(msg.content, maxBlockChars)}`;
  if (!Array.isArray(msg?.content)) return `[${role}]`;
  const parts = [];
  for (const b of msg.content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') parts.push(clipText(b.text, maxBlockChars));
    else if (b.type === 'tool_use') parts.push(`tool_use ${b.name}(${clipText(JSON.stringify(b.input ?? {}), 400)})`);
    else if (b.type === 'tool_result') parts.push(`tool_result${b.is_error ? ' [error]' : ''} (${b.tool_use_id}): ${clipText(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 600)}`);
    else if (b.type === 'image') parts.push('[image omitted]');
  }
  return `[${role}]\n${parts.join('\n')}`;
}

/**
 * Split a message array into `{ head, tail }` for compaction while preserving tool_use / tool_result
 * pairing and valid message boundaries:
 * - Never starts `tail` on a `user` message carrying `tool_result` (which would orphan it from the
 *   preceding `assistant` `tool_use` in `head`).
 * - Never ends `head` on an `assistant` message carrying `tool_use` whose `tool_result` is in `tail`.
 */
export function splitMessagesForCompact(messages, { keepRecent = 4 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const keep = Math.max(0, Math.floor(Number(keepRecent) || 0));
  if (list.length === 0) return { head: [], tail: [] };
  if (keep === 0) return { head: list.slice(), tail: [] };
  if (list.length <= keep) return { head: [], tail: list.slice() };

  const target = Math.max(1, list.length - keep);
  const canSplitAt = (idx) => {
    if (idx <= 0) return false;
    if (idx >= list.length) return true;
    const prev = list[idx - 1];
    const curr = list[idx];
    if (hasBlockType(curr, 'tool_result')) return false;
    if (prev?.role === 'assistant' && hasBlockType(prev, 'tool_use')) return false;
    return true;
  };

  // Prefer keeping at least `keepRecent` messages when possible by scanning backward slightly first,
  // otherwise scan forward toward the end.
  for (let idx = target; idx >= 1; idx -= 1) {
    if (canSplitAt(idx)) return { head: list.slice(0, idx), tail: list.slice(idx) };
  }
  for (let idx = target + 1; idx <= list.length; idx += 1) {
    if (canSplitAt(idx)) return { head: list.slice(0, idx), tail: list.slice(idx) };
  }
  return { head: [], tail: list.slice() };
}

/** Build the user prompt sent to the summarizer model for a batch of earlier messages */
export function buildCompactPrompt(messages, { instructions = '', maxBlockChars = 1200 } = {}) {
  const transcript = (messages || []).map((m) => formatMessageForSummary(m, maxBlockChars)).join('\n\n');
  const extra = String(instructions || '').trim();
  return [
    'Summarize the earlier conversation turns below so the Agent can continue seamlessly.',
    ...(extra ? [`Additional focus: ${extra}`] : []),
    '',
    '<conversation>',
    transcript,
    '</conversation>',
  ].join('\n');
}

/**
 * Construct the compacted message array from `summaryText` and kept `tail` messages while strictly
 * maintaining alternating `user` / `assistant` roles across all providers.
 */
export function buildCompactedMessages(summaryText, tail = [], { ackText = 'Understood. Continuing with the compacted context above.' } = {}) {
  const summaryMsg = {
    role: 'user',
    content: [{ type: 'text', text: `[Compacted conversation summary]\n${String(summaryText || '').trim()}` }],
  };
  if (!tail.length) {
    return [summaryMsg, { role: 'assistant', content: [{ type: 'text', text: ackText }] }];
  }
  if (tail[0]?.role === 'assistant') {
    return [summaryMsg, ...tail];
  }
  return [summaryMsg, { role: 'assistant', content: [{ type: 'text', text: ackText }] }, ...tail];
}

/**
 * Compact a `MessageHistory` instance (mutating it in place via `clear()` + `appendAll()`) or a
 * plain `messages` array. Summarizes `head` via `summarize` (custom async function) or `provider`.
 */
export async function compactHistory(target, {
  provider = null,
  summarize = null,
  keepRecent = 4,
  minMessages = 4,
  instructions = '',
  system = COMPACT_SYSTEM_PROMPT,
  signal,
} = {}) {
  const isHistory = Boolean(target && typeof target.get === 'function' && typeof target.clear === 'function' && typeof target.appendAll === 'function');
  const messages = isHistory ? target.get() : (Array.isArray(target) ? target.slice() : []);
  const usage = { input: 0, output: 0, cacheRead: 0 };

  if (messages.length < minMessages) {
    return { compacted: false, summarizedCount: 0, keptCount: messages.length, summary: '', messages, usage };
  }

  const { head, tail } = splitMessagesForCompact(messages, { keepRecent });
  if (!head.length) {
    return { compacted: false, summarizedCount: 0, keptCount: messages.length, summary: '', messages, usage };
  }

  const prompt = buildCompactPrompt(head, { instructions });
  let summary = '';
  if (typeof summarize === 'function') {
    summary = String(await summarize(head, { prompt, system, signal }) ?? '').trim();
  } else if (provider && typeof provider.stream === 'function') {
    const reqMessages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    for await (const ev of provider.stream(reqMessages, [], system, signal)) {
      if (ev.type === 'text_delta') summary += ev.text;
      else if (ev.type === 'usage') {
        usage.input += Number(ev.input) || 0;
        usage.output += Number(ev.output) || 0;
        usage.cacheRead += Number(ev.cacheRead) || 0;
      }
    }
    summary = summary.trim();
  } else {
    throw new Error('compactHistory requires either a provider with stream() or a summarize() callback.');
  }

  if (!summary) {
    throw new Error('Compaction summarizer returned an empty summary.');
  }

  const compactedMessages = buildCompactedMessages(summary, tail);
  if (isHistory) {
    target.clear();
    target.appendAll(compactedMessages);
  }
  return {
    compacted: true,
    summarizedCount: head.length,
    keptCount: tail.length,
    summary,
    messages: compactedMessages,
    usage,
  };
}
