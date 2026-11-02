/**
 * Extract inline `<think>…</think>` from the body text stream.
 *
 * # Why it is needed
 *
 * Each provider delivers "reasoning content" differently. Well-behaved APIs place it in a separate
 * field (`reasoning_content` / `reasoning` / `thinking`), and providers/openai.mjs recognizes these
 * three. However, many relay services send it **directly inlined inside `content`**:
 *
 *   <think>**Clarifying article link and scope**\n\n</think>\n\nI will first confirm the media collection environment;…
 *
 * In this case, the entire segment passes through text_delta and is rendered as body text: users
 * see a naked `</think>` in the chat bubble, interrupting their reading. This module separates it
 * at the **stream level**, routing it through the thinking channel so downstream UI can display it
 * normally without any changes.
 *
 * # Why build a state machine instead of using regex
 *
 * This is **streaming**: tags can be split across two chunks (`<thi` + `nk>`), or even one
 * character per chunk. Running regex against a single delta can never match those cases, and
 * accumulating the entire text before processing loses the streaming effect. Therefore, this only
 * holds back those few characters when "the tail of the current buffer might be half of a tag",
 * and releases everything else immediately: at most a few characters of latency, unnoticeable to
 * the human eye.
 *
 * # Known trade-offs
 *
 * If the literal `<think>` **actually** appears in the body text (such as when discussing the tag
 * itself, or inside a code block), it will be mistakenly swallowed as a tag. The cost is an
 * extremely low-frequency false positive, in exchange for avoiding pollution on every message.
 * If we ever encounter it, we can add a layer for "do not parse inside code blocks"; it is not
 * worth complicating the state machine for this right now.
 */

/** Which tag pairs are recognized. `<think>` is most common, and some relay services use `<thinking>` */
const TAG_PAIRS = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
];

/** Length of the longest suffix of s that is a proper prefix of tag. Used to decide how many characters to hold back */
function partialTailLength(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/**
 * Create a splitter.
 *
 * Both `push(chunk)` and `flush()` return an array of events: `{ kind: 'text' | 'think', text }`,
 * with no empty fragments emitted. The caller simply sends text as text_delta and think as
 * thinking_delta.
 */
export function createThinkSplitter() {
  let buf = '';
  /** null = inside body text; otherwise the closing tag pair currently being searched for */
  let openPair = null;

  function drain(out) {
    for (;;) {
      if (openPair) {
        const i = buf.indexOf(openPair.close);
        if (i >= 0) {
          if (i > 0) out.push({ kind: 'think', text: buf.slice(0, i) });
          buf = buf.slice(i + openPair.close.length);
          openPair = null;
          continue;
        }
        // Closing tag not reached: release the part that is definitely not the start of a tag,
        // keeping the tail for the next chunk
        const keep = partialTailLength(buf, openPair.close);
        if (buf.length > keep) {
          out.push({ kind: 'think', text: buf.slice(0, buf.length - keep) });
          buf = buf.slice(buf.length - keep);
        }
        return;
      }

      // Inside body text: find the earliest opening tag
      let best = -1;
      let bestPair = null;
      for (const pair of TAG_PAIRS) {
        const i = buf.indexOf(pair.open);
        if (i >= 0 && (best < 0 || i < best)) { best = i; bestPair = pair; }
      }
      if (best >= 0) {
        if (best > 0) out.push({ kind: 'text', text: buf.slice(0, best) });
        buf = buf.slice(best + bestPair.open.length);
        openPair = bestPair;
        continue;
      }

      // No opening tag: tail might be half of an opening tag, hold back the longest match
      let keep = 0;
      for (const pair of TAG_PAIRS) keep = Math.max(keep, partialTailLength(buf, pair.open));
      if (buf.length > keep) {
        out.push({ kind: 'text', text: buf.slice(0, buf.length - keep) });
        buf = buf.slice(buf.length - keep);
      }
      return;
    }
  }

  return {
    push(chunk) {
      if (!chunk) return [];
      buf += chunk;
      const out = [];
      drain(out);
      return out;
    },
    /**
     * Stream ended. Emit the buffered tail: it could be half a tag, or just normal body text
     * (e.g. the reply happens to end with `<`). Thinking content that did not reach a closing tag is
     * also yielded: it is better to display extra thinking content than to swallow the user's body text.
     */
    flush() {
      const out = [];
      if (buf) out.push({ kind: openPair ? 'think' : 'text', text: buf });
      buf = '';
      openPair = null;
      return out;
    },
    /** Whether currently inside think (used by callers to check state) */
    get inThink() { return openPair !== null; },
  };
}

/**
 * Split the entire text in one shot (used in non-streaming contexts, such as cleaning up text
 * already saved in history). Returns `{ text, think }` as two assembled strings.
 */
export function splitThinkTags(s) {
  const sp = createThinkSplitter();
  const events = [...sp.push(String(s ?? '')), ...sp.flush()];
  let text = '';
  let think = '';
  for (const e of events) {
    if (e.kind === 'text') text += e.text;
    else think += e.text;
  }
  return { text, think };
}
