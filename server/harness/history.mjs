// Corresponds to claude-quickstarts/agents/utils/history.py

/**
 * Measure how long history is.
 *
 * Image base64 is not counted: a 768px screenshot is hundreds of thousands of characters; calculating
 * by literal length, viewing an image even once inevitably exceeds maxChars, and truncation would shave
 * off the entire conversation. On the model side, images are billed by dimensions, so byte count is not
 * its cost at all. Thus, only a constant placeholder commensurate with its token magnitude is used here
 * (approx. 1200 tokens × 3 characters).
 */
function sizeOf(messages) {
  return JSON.stringify(messages, (key, v) => (key === 'data' && typeof v === 'string' && v.length > 4096 ? 'x'.repeat(3600) : v)).length;
}

export class MessageHistory {
  constructor({ maxChars = 120000, onEvent } = {}) {
    this.maxChars = maxChars;
    this.onEvent = onEvent || (() => {});
    this.messages = [];
  }

  append(msg) {
    this.messages.push(msg);
  }

  appendAll(msgs) {
    this.messages.push(...msgs);
  }

  /**
   * Add a user message; when the end is already a user message, **merge into that one**.
   *
   * Two consecutive user messages in history is a real shape, not a theoretical problem: when continuing
   * from the previous section, the end might be the backfilled message persisted upon interruption
   * (the user message holding tool_result), or the closing message used when hitting the round limit
   * in the previous round. Anthropic rejects consecutive same-role messages, and none of the three
   * providers' conversions include merge logic: so intercept it here, rather than counting on each caller
   * to remember.
   *
   * Placed on MessageHistory because this is **history's own invariant**: letting callers mutate the last
   * message via get()'s return value relies on the coincidence that "get returns a shallow copy and the
   * inner objects are still the same batch"; if get changes to a deep copy someday, it silently breaks.
   */
  appendUserText(text) {
    const last = this.messages[this.messages.length - 1];
    if (last?.role !== 'user') { this.messages.push({ role: 'user', content: [{ type: 'text', text }] }); return; }
    /*
     * The end is a user message, but content is a string (legacy format, or the file on disk was modified
     * externally: api.mjs only runs JSON.parse on read-back without schema validation). Originally this fell
     * back to "starting a new message", but the end was already user, so starting a new one assembled
     * the exact shape this method aims to eliminate.
     * Normalize in-place into an array of blocks before merging in.
     */
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    if (Array.isArray(last.content)) last.content.push({ type: 'text', text });
    else this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  get() {
    return [...this.messages];
  }

  clear() {
    this.messages = [];
  }

  estimateTokens() {
    return Math.ceil(sizeOf(this.messages) / 3);
  }

  /**
   * Retain only the most recent keep screenshots, replacing earlier ones with an explanation.
   *
   * Images are billed by dimensions rather than bytes, but each is still hundreds of tokens, and base64
   * itself must traverse the network. A single task might inspect images dozens of times; keeping them all
   * is both expensive and useless: the model needs to judge "what it looks like now right after changes",
   * and having the old appearance from three rounds ago in context can mislead it into treating old visuals
   * as the current state.
   */
  pruneImages(keep = 10) {
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (!Array.isArray(msg.content)) continue;
      for (let j = msg.content.length - 1; j >= 0; j--) {
        if (msg.content[j].type !== 'image') continue;
        if (++seen > keep) msg.content[j] = { type: 'text', text: '(An earlier screenshot was removed from the context; take another screenshot if you need to look again)' };
      }
    }
  }

  size() {
    return sizeOf(this.messages);
  }

  /**
   * Truncate by actual token count reported by the API.
   *
   * Dividing character count by 3 to estimate tokens is roughly accurate for English and JSON, but Chinese
   * is about one character per token, underestimating by up to a factor of three.
   * So stop guessing the conversion ratio: calculate the ratio from this round's actual input token count
   * and the character count of current history, setting maxChars to "the character count corresponding to
   * the budget" before truncating. 0.9 leaves headroom for new content in the next round.
   * reported also includes system prompt and tool definitions (not in history); calculating proportionally
   * truncates slightly more, which leans safe.
   */
  fitTokens(reported, budget) {
    if (!(reported > budget) || !(budget > 0)) return;
    this.maxChars = Math.floor(this.size() * (budget / reported) * 0.9);
    this.truncate();
  }

  truncate() {
    let currentChars = sizeOf(this.messages);
    if (currentChars <= this.maxChars) return;
    let truncated = false;

    while (this.messages.length > 2 && sizeOf(this.messages) > this.maxChars) {
      // Check whether at least 2 messages remain if the first message and associated records are deleted
      let nextMessages = JSON.parse(JSON.stringify(this.messages));
      // Keep the latest actual user request while removing complete old tool pairs.
      const pinned = this.messages.findLastIndex(m => m.role === 'user' && m.content?.some(b => b.type === 'text') && !m.content?.some(b => b.type === 'tool_result'));
      const removeIndex = pinned === 0 ? 1 : 0;
      const [msg] = nextMessages.splice(removeIndex, 1);
      
      if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
        const toolUseIds = new Set();
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIds.add(block.id);
          }
        }
        
        if (toolUseIds.size > 0 && nextMessages.length > 0) {
           for (let i = 0; i < nextMessages.length; i++) {
             const m = nextMessages[i];
             if (m.role === 'user' && Array.isArray(m.content)) {
                m.content = m.content.filter(block => 
                  !(block.type === 'tool_result' && toolUseIds.has(block.tool_use_id))
                );
             }
           }
           nextMessages = nextMessages.filter(m => m.content && m.content.length > 0);
        }
      }
      
      if (nextMessages.length < 2) {
         break;
      }
      
      this.messages = nextMessages;
      truncated = true;
    }
    
    if (truncated) {
      this.onEvent({ type: 'status', text: 'Chat history too long, earlier messages truncated' });
    }
  }

  toJSON() {
    return this.messages;
  }

  static fromJSON(arr, opts) {
    const history = new MessageHistory(opts);
    if (Array.isArray(arr)) {
      history.messages = [...arr];
    }
    return history;
  }
}
