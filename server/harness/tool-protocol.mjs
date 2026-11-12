const FENCE_OPEN = '```promptcut-tool';
const FENCE_CLOSE = '```';

export const DEFAULT_PROTOCOL_TEMPLATE = [
  'You currently have no native tools available. When you need to call an editor tool, write in your reply a triple-backtick fence whose language marker is `promptcut-tool`, containing a JSON object in the following format:',
  '',
  '```promptcut-tool',
  '{',
  '  "name": "tool name",',
  '  "input": {',
  '    "parameter name": "parameter value"',
  '  }',
  '}',
  '```',
  '',
  '- You can write several such fences in one reply; they are executed in order of appearance.',
  '- Stop once you have written it and wait for the result; do not pretend you already know the result.',
  '- The result will be sent to you as the next user message.',
  '',
  'List of available tools:',
  '',
  '<!--TOOLS-->',
].join('\n');

/** Length of the longest suffix of s that is also a prefix of marker */
function pendingPrefixLen(s, marker) {
  const max = Math.min(s.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Streamingly strip ```promptcut-tool fences from the body text shown to the user.
 *
 * Why it is needed: under text protocol mode, the model writes tool calls **in the reply body**,
 * and body text streams character-by-character to the UI. Without filtering, users would see the
 * fence and bare JSON: markdown would also render the fence as a code block, namely that empty
 * dark bar in the chat box.
 *
 * Feed chunk-by-chunk, emitting only text "confirmed to be outside the fence":
 * - Hold back any short incomplete tail that might be forming the opening fence marker (up to 16
 *   characters) until the next chunk arrives to decide whether to release or swallow it.
 * - Never emit anything inside the fence.
 * - Ordinary ``` code blocks are unaffected: the opening marker contains promptcut-tool; if it
 *   cannot be formed, it will be released.
 *
 * Note that collectedText must still receive the **original text**, as parseToolBlocks relies on
 * the fence to locate tool calls.
 */
export function createFenceFilter() {
  let pending = '';
  let inside = false;

  return {
    push(delta) {
      pending += delta;
      let out = '';
      for (;;) {
        if (!inside) {
          const idx = pending.indexOf(FENCE_OPEN);
          if (idx >= 0) {
            out += pending.slice(0, idx);
            pending = pending.slice(idx + FENCE_OPEN.length);
            inside = true;
            continue;
          }
          const hold = pendingPrefixLen(pending, FENCE_OPEN);
          out += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
          return out;
        }
        const idx = pending.indexOf(FENCE_CLOSE);
        if (idx >= 0) {
          pending = pending.slice(idx + FENCE_CLOSE.length);
          inside = false;
          continue;
        }
        // Discard everything inside the fence, keeping only the one or two backticks that might be a closing marker
        pending = pending.slice(pending.length - pendingPrefixLen(pending, FENCE_CLOSE));
        return out;
      }
    },
    /** Release the buffered tail when the stream ends. An unclosed fence means this tool call is incomplete, so do not display it */
    flush() {
      if (inside) {
        pending = '';
        return '';
      }
      const rest = pending;
      pending = '';
      return rest;
    },
  };
}

export function parseToolBlocks(text) {
  const regex = /```promptcut-tool\s*([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const content = match[1].trim();
    try {
      const parsed = JSON.parse(content);
      blocks.push({
        name: parsed.name,
        input: parsed.input || {},
        raw,
      });
    } catch (e) {
      blocks.push({
        error: `JSON parse failed: ${e.message}`,
        raw,
      });
    }
  }
  return blocks;
}

export function hasToolBlocks(text) {
  return /```promptcut-tool\s*([\s\S]*?)```/.test(text);
}

/**
 * Execute parsed fenced tool blocks via `callTool`.
 * When `tools` is provided as an array of `{ name }` descriptors or tool name strings, unregistered
 * tool names are rejected before calling `callTool`.
 */
export async function executeToolBlocks(blocks, callTool, { tools = null } = {}) {
  const results = [];
  const allowedNames = Array.isArray(tools)
    ? new Set(tools.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean))
    : null;

  for (const block of blocks) {
    if (block.error) {
      results.push({ name: block.name || 'unknown', ok: false, error: block.error });
      continue;
    }

    if (!block.name || (allowedNames && !allowedNames.has(block.name))) {
      results.push({ name: block.name || 'unknown', ok: false, error: `Unregistered tool ${block.name}` });
      continue;
    }

    try {
      const result = await callTool(block.name, block.input);
      let text = '';
      let files = undefined;

      if (typeof result === 'object' && result !== null) {
        if (Array.isArray(result.files)) {
          files = result.files.map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);
        }
        text = JSON.stringify(result, null, 2);
      } else {
        text = String(result);
      }

      results.push({ name: block.name, ok: true, text, files });
    } catch (e) {
      results.push({ name: block.name, ok: false, error: String(e) });
    }
  }
  return results;
}

export function formatResultsAsUserMessage(results) {
  let output = 'Tool results:\n\n';
  for (const res of results) {
    if (res.ok) {
      const t = res.text ? res.text.substring(0, 4000) : '';
      output += `[Tool ${res.name} succeeded]\\n${t}\\n\\n`;
    } else {
      output += `[Tool ${res.name} failed]\\n${res.error}\\n\\n`;
    }
  }
  return output.trim();
}

export async function renderProtocolPrompt({ tools = [], template = DEFAULT_PROTOCOL_TEMPLATE } = {}) {
  let toolsDesc = '';
  for (const t of tools || []) {
    toolsDesc += `### ${t.name}\\n- Description: ${t.description}\\n- Parameters: ${JSON.stringify(t.inputSchema)}\\n\\n`;
  }
  return String(template).replace('<!--TOOLS-->', toolsDesc.trim());
}

export function runTextProtocolLoop({ startRun, opts, onEvent, tools = opts?.protocolTools ?? opts?.tools ?? null, template = DEFAULT_PROTOCOL_TEMPLATE }) {
  const currentOpts = { ...opts };

  currentOpts.mcp = undefined;
  /*
   * Round limit for the text protocol path. Usually 8 rounds; when "deep autonomy" is enabled,
   * replaced by "autonomous rounds" in settings (opts.maxRounds), where 0 means unlimited: here it
   * becomes Infinity with no loop termination, exiting only when the model stops issuing tool calls,
   * encounters an error, or the user clicks stop.
   */
  const maxLoops = opts.deepAuto
    ? (opts.maxRounds === 0 ? Infinity : Number(opts.maxRounds) || 300)
    : 8;
  let loopCount = 0;
  let finalAbort = () => {};
  let aborted = false;

  const donePromise = new Promise(async (resolve) => {
    try {
      const protocolPrompt = await renderProtocolPrompt({ tools: tools || [], template });
      currentOpts.systemPrompt = currentOpts.systemPrompt + '\n\n' + protocolPrompt;

      while (loopCount < maxLoops) {
        if (aborted) { resolve(); return; }
        loopCount++;
        let collectedText = '';
        // Each round is a new output stream; filters cannot be reused across rounds
        // (a partial marker from the previous round would bleed over)
        const fence = createFenceFilter();
        let lastSessionId = currentOpts.sessionId;
        let lastUsage = undefined;
        let runError = null;

        const run = startRun({
          ...currentOpts,
          onEvent: (ev) => {
            if (ev.type === 'text') {
              // Original text goes into collectedText for parseToolBlocks; the copy forwarded to the UI must have fences stripped.
              collectedText += ev.delta;
              const visible = fence.push(ev.delta);
              if (visible) onEvent({ ...ev, delta: visible });
              return;
            }
            if (ev.type === 'session' && ev.sessionId) {
              lastSessionId = ev.sessionId;
            }
            if (ev.type === 'done') {
              if (ev.sessionId) lastSessionId = ev.sessionId;
              if (ev.usage) lastUsage = ev.usage;
            } else if (ev.type === 'error') {
              runError = ev.message;
              onEvent(ev);
            } else {
              onEvent(ev);
            }
          },
        });

        finalAbort = run.abort;

        try {
          await run.done;
        } catch (e) {
          if (!runError) {
            runError = e.message || String(e);
            onEvent({ type: 'error', message: runError });
          }
        }

        // Stream broken, release the buffered tail (an unclosed fence will be dropped automatically here)
        if (aborted) { resolve(); return; }
        const tail = fence.flush();
        if (tail) onEvent({ type: 'text', delta: tail });

        if (runError) {
          resolve();
          return;
        }

        if (!hasToolBlocks(collectedText)) {
          onEvent({ type: 'done', sessionId: lastSessionId, usage: lastUsage });
          resolve();
          return;
        }

        const blocks = parseToolBlocks(collectedText);

        for (const b of blocks) {
          if (b.name) onEvent({ type: 'tool_call', name: b.name, input: b.input });
        }

        const results = await executeToolBlocks(blocks, opts.callTool, { tools });

        for (const res of results) {
          onEvent({ type: 'tool_result', name: res.name || 'unknown', ok: res.ok, summary: res.text || res.error, files: res.files });
        }

        const nextPrompt = formatResultsAsUserMessage(results);

        currentOpts.prompt = nextPrompt;
        currentOpts.sessionId = lastSessionId;
      }

      // Send this only to the UI, not into the model context: deep autonomy requires that "the model cannot see rounds",
      // not that "the user also cannot see why it stopped"
      onEvent({ type: 'status', text: `Text protocol reached the limit of ${maxLoops} rounds` });
      onEvent({ type: 'done', sessionId: currentOpts.sessionId });
      resolve();
    } catch (e) {
      /*
       * Reporting once is enough: error has already been sent to the UI here, and rejecting it again
       * causes callers awaiting `run.done` to emit a duplicate error event.
       */
      onEvent({ type: 'error', message: String(e) });
      resolve();
    }
  });

  return {
    abort: () => { aborted = true; finalAbort(); },
    done: donePromise,
  };
}
