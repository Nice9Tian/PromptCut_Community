// Test provider (simulates a model provider). Enabled when `vendor: 'mock'` in `ai.json` or
// `opts.apiConfig`, requires no Key.
//
// Two paths:
//   - Without script: hardcoded two turns (call a tool once, say one sentence), same as before;
//   - With script: when a ```mock-script code block (JSON array) appears in a user message, follow it
//     turn by turn (contract docs/plan/cloud-agent-contract.md section 8.3). Each item is one of
//     the four types below:
//       { "tool": "<tool_name>", "input": { … } }   Call this tool in this turn
//       { "say": "<text>" }                         Say this text and end this turn
//       { "sleepMs": 300 }                          Wait this long before doing next item (test
//                                                   stop and concurrency; honors abort signal)
//       { "fail": "<reason>" }                      Error out on this model request
//       { "truncate": { "tool", "args", "say" } }   Truncated by hitting output limit in this
//                                                   turn (see the branch below)
//       { "cut": { "tool", "args", "say" } }        Cut off midway by gateway in this turn (stop
//                                                   reason stream_cut, otherwise same as truncate)
//     If the script finishes without say, append "Done." to end. Report usage once per turn
//     (deterministic value calculated by character count).
//     When multiple script blocks exist in a chat turn, use the one in the most recent user message.

const SCRIPT_RE = /```mock-script\s*\n([\s\S]*?)```/g;

/** Find script from the most recent user text in message history; returns null if none */
export function mockScriptOf(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const texts = typeof m.content === 'string' ? [m.content] : (Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text) : []);
    for (let j = texts.length - 1; j >= 0; j -= 1) {
      const all = [...String(texts[j] ?? '').matchAll(SCRIPT_RE)];
      if (!all.length) continue;
      try {
        const steps = JSON.parse(all[all.length - 1][1]);
        return Array.isArray(steps) ? steps : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const sizeOf = (v) => { try { return JSON.stringify(v).length; } catch { return 0; } };

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function createProvider(cfg) {
  let turn = 0;
  /** Script mode: index of the next item; script is determined on the first request */
  let script;
  let at = 0;

  return {
    name: 'mock',
    async *stream(messages, _tools, _system, signal) {
      if (script === undefined) script = mockScriptOf(messages);
      if (script) {
        const usage = { type: 'usage', input: Math.ceil(sizeOf(messages) / 4), output: 0 };
        while (at < script.length) {
          const step = script[at] ?? {};
          at += 1;
          if (Number.isFinite(step.sleepMs)) { await sleep(Math.max(0, Math.min(60_000, step.sleepMs)), signal); continue; }
          // Replace `{{apiKey}}` and `{{baseUrl}}` with config values: used when testing "model API errors
          // containing Key and address" to avoid writing them into prompts
          if (typeof step.fail === 'string') throw new Error(step.fail.replaceAll('{{apiKey}}', String(cfg?.apiKey ?? '')).replaceAll('{{baseUrl}}', String(cfg?.baseUrl ?? '')));
          if (typeof step.tool === 'string') {
            const input = step.input && typeof step.input === 'object' ? step.input : {};
            yield { type: 'tool_use', id: `mock_${at}`, name: step.tool, input };
            yield { ...usage, output: Math.ceil(sizeOf(input) / 4) + 8 };
            yield { type: 'stop', reason: 'tool_use' };
            return;
          }
          /*
           * Truncated by hitting output limit (A07):
           * `{ "truncate": { "tool": "create_card", "args": "{\"source\":\"half-written" }, "say"?: "…" }`
           * Deliver an incomplete tool call (raw arguments are args) and finalize with `length`; if tool is
           * not provided, deliver only the text in say and finalize with `length`.
           */
          const cutStep = step.truncate && typeof step.truncate === 'object' ? step.truncate : (step.cut && typeof step.cut === 'object' ? step.cut : null);
          if (cutStep) {
            if (typeof cutStep.say === 'string') yield { type: 'text_delta', text: cutStep.say };
            if (typeof cutStep.tool === 'string') yield { type: 'tool_use_partial', id: `mock_${at}`, name: cutStep.tool, args: String(cutStep.args ?? '') };
            yield { ...usage, output: Math.ceil(String(cutStep.args ?? '').length / 4) + 8 };
            // Cut off midway by gateway (stream-cut, 2026-10-22): stop reason stream_cut, agent.mjs handles as truncation
            yield { type: 'stop', reason: cutStep === step.truncate ? 'length' : 'stream_cut' };
            return;
          }
          if (typeof step.say === 'string') {
            yield { type: 'text_delta', text: step.say };
            yield { ...usage, output: Math.ceil(step.say.length / 2) + 1 };
            yield { type: 'stop', reason: 'end_turn' };
            return;
          }
        }
        yield { type: 'text_delta', text: 'Done.' };
        yield { ...usage, output: 2 };
        yield { type: 'stop', reason: 'end_turn' };
        return;
      }

      turn++;
      if (turn === 1) {
        yield { type: 'tool_use', id: 'call_1', name: cfg?.toolName || 'get_editor_state', input: {} };
        yield { type: 'stop', reason: 'tool_use' };
      } else if (turn === 2) {
        const text = cfg?.finalText || 'There are 2 cards on the timeline.';
        const mid = Math.floor(text.length / 2);
        yield { type: 'text_delta', text: text.slice(0, mid) };
        yield { type: 'text_delta', text: text.slice(mid) };
        yield { type: 'usage', input: 10, output: 20 };
        yield { type: 'stop', reason: 'end_turn' };
      } else {
        yield { type: 'text_delta', text: 'Nothing else to do.' };
        yield { type: 'stop', reason: 'end_turn' };
      }
    }
  };
}
