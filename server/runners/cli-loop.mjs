/**
 * Review loop runs via the command-line CLI (currently agy).
 *
 * On the direct API path, the loop can execute tools for the model round by round (apiBackend in
 * harness/loop.mjs). CLI is different: in a single invocation, it runs through the entire loop
 * itself, with tools coming from globally registered PromptCut MCP. Therefore:
 *
 * - **One role turn = launch one CLI instance.** reviewer / judger each starts a new session;
 *   when judger is nudged once, it continues speaking in its own session (--conversation).
 * - **Submitting conclusions cannot rely on tools** (issue_plan / phase_done are not in MCP).
 *   Instead, output a separate code block at the end of the reply, with the conclusion name as the
 *   language tag and JSON as the content; parsed here. If not submitted or unparseable, the loop
 *   side will nudge once.
 * - **Read-only cannot rely on providing fewer tools** (MCP is registered globally and does not
 *   distinguish by turn). Instead, lock at the server-side tool execution entry point
 *   (setToolAccess, see callToolInternal in vite-plugin-ai.ts): reviewer / judger turns only permit
 *   the read-only list, reflection turns permit none, unlocked at the end of the turn.
 * - The done / session events emitted by CLI on each call **must not** forward to the frontend:
 *   the frontend treats seeing done as the whole process ending, and seeing session causes it to
 *   use a role's session to resume the next message.
 */
import { runReviewLoop, presentLoopEvent, SUBMIT_DEFS } from '../harness/loop.mjs';
import { READ_ONLY_TOOLS } from '../harness/loop-prompts.mjs';
import { lessonsStore } from './api.mjs';
import { tr } from '../i18n.mjs';

const RETRIES = 2;

function fieldDoc(schema, indent = '  ') {
  const req = new Set(schema.required || []);
  return Object.entries(schema.properties || {}).map(([k, v]) => {
    let type = v.type === 'array' ? `array${v.items?.type === 'object' ? ', each item is an object' : `, each item is ${v.items?.type || 'value'}`}` : v.type;
    if (v.enum) type += `, one of ${v.enum.join(' / ')}`;
    const line = `${indent}- ${k}(${type},${req.has(k) ? 'required' : 'optional'}):${v.description || ''}`;
    const sub = v.type === 'array' && v.items?.type === 'object' ? '\n' + fieldDoc(v.items, indent + '    ') : '';
    return line + sub;
  }).join('\n');
}

/** Appended to the end of the system prompt: how to submit conclusions required for this turn */
export function submitFormat(names) {
  const example = names[0] === 'need_user'
    ? '```need_user\n{"reason": "Please scan the QR code to log in in the pop-up window"}\n```'
    : `\`\`\`${names[0]}\n{ …fields below… }\n\`\`\``;
  return [
    '', '', '## How to submit conclusions (important)',
    `The ${names.join(' / ')} mentioned here are **not tools**; they are not in your tool list, so do not look for them and do not call them.`,
    'To submit a conclusion: at the **end** of your reply, output a single code block whose language tag is the conclusion name and whose content is a JSON object. For example:',
    example,
    'Conclusions and fields you can submit this turn:',
    ...names.map((n) => `- ${n}:${SUBMIT_DEFS[n].description}\n${fieldDoc(SUBMIT_DEFS[n].inputSchema)}`),
    'Submit only one conclusion block in the whole reply. Use double quotes for strings in JSON.',
  ].join('\n');
}

/**
 * Extract the last valid conclusion block from the reply; return null if none, JSON fails to
 * parse, or required fields are missing
 */
export function parseSubmission(text, names) {
  if (!text || !names.length) return null;
  const re = /```[ \t]*([A-Za-z_]+)[ \t]*\r?\n([\s\S]*?)```/g;
  let m, found = null;
  while ((m = re.exec(text))) {
    const name = m[1];
    if (!names.includes(name)) continue;
    try {
      const input = JSON.parse(m[2].trim());
      const ok = input && typeof input === 'object' && !Array.isArray(input)
        && (SUBMIT_DEFS[name].inputSchema.required || []).every((k) => input[k] !== undefined);
      if (ok) found = { name, input };
    } catch { /* This block is invalid, check the next one */ }
  }
  return found;
}

const accessNote = (access) => access === 'readonly'
  ? `\n\n## PromptCut tools you can use this turn\nOnly these read-only tools: ${READ_ONLY_TOOLS.filter((n) => n !== 'think').join(', ')}. All other PromptCut tools will be rejected this turn, do not call them.`
  : access === 'none'
    ? '\n\n## Do not call any tools this turn\nAnswer in text only. All PromptCut tools will be rejected this turn.'
    : '';

/**
 * Role turn for the CLI version. startProviderRun is that runner's startRun (such as agy.mjs's).
 * baseOpts are the parameters originally to be passed to it for this chat (cwd, mcp, model,
 * effort, toolProtocol…).
 */
export function cliBackend({ startProviderRun, baseOpts, setToolAccess, signal }) {
  // onRoleEvent is provided by the loop: it tags roles and counts worker tool calls, which
  // startCliLoop then translates into the chat panel format
  return (onRoleEvent) => {
    /**
     * Launch a CLI instance to collect this run's text, session id, usage, and errors; inner
     * done / session / error are not forwarded outward
     */
    const runOnce = ({ role, systemPrompt, prompt, sessionId }) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error(tr("Stopped")), { name: 'AbortError' }));
      let text = '', sid = null, usage = null, error = null;
      const run = startProviderRun({
        ...baseOpts, systemPrompt, prompt, sessionId,
        onEvent: (ev) => {
          if (ev.type === 'text' && typeof ev.delta === 'string') text += ev.delta;
          if (ev.type === 'session') { sid = ev.sessionId; return; }
          if (ev.type === 'done') { usage = ev.usage || null; if (ev.sessionId) sid = ev.sessionId; return; }
          if (ev.type === 'error') { error = ev; return; }
          onRoleEvent(role, ev);
        },
      });
      const onAbort = () => run.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      run.done.then(() => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return reject(Object.assign(new Error(tr("Stopped")), { name: 'AbortError' }));
        resolve({ text, sessionId: sid, usage: normalizeUsage(usage), error });
      }, reject);
    });

    return {
      async runRole(role, { system, prompt, access, submit = [], session }) {
        const systemPrompt = system + accessNote(access) + (submit.length ? submitFormat(submit) : '');
        setToolAccess?.(access === 'all' ? null : access === 'readonly' ? READ_ONLY_TOOLS : []);
        try {
          let sessionId = session || undefined;
          let ask = prompt;
          for (let attempt = 0; ; attempt++) {
            const r = await runOnce({ role, systemPrompt, prompt: ask, sessionId });
            sessionId = r.sessionId || sessionId;
            if (!r.error) return { text: r.text, submitted: parseSubmission(r.text, submit), session: sessionId, usage: r.usage };
            if (signal?.aborted || r.error.authReason || !r.error.retryable) throw Object.assign(new Error(r.error.message || tr("CLI error")), { runEvent: r.error });
            if (attempt >= RETRIES || !sessionId) {
              /*
               * A resumable interruption with retries exhausted: this turn cannot deliver anything, but **the
               * loop should not be invalidated along with it**. In practice: worker was rejected three times by
               * agy's built-in tools; if it throws here, judger's specified requirements and the project work
               * already touched by worker are all in vain, and the user only sees an error. Changed to
               * returning a result marked as interrupted, leaving loop.mjs to decide how to pick up.
               * Non-resumable errors (such as an invalid model name) and user clicking stop are thrown as usual.
               */
              return { text: r.text, submitted: parseSubmission(r.text, submit), session: sessionId, usage: r.usage, interrupted: r.error.message || tr("CLI error") };
            }
            onRoleEvent(role, { type: 'loop', stage: 'retry', role, attempt: attempt + 1, reason: r.error.message });
            ask = r.error.retryPrompt || 'The last run was interrupted. All earlier progress is still there, continue from where you stopped.';
          }
        } finally {
          setToolAccess?.(null);
        }
      },
    };
  };
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.input ?? u.input_tokens ?? u.prompt_tokens ?? u.inputTokens) || 0;
  const output = Number(u.output ?? u.output_tokens ?? u.completion_tokens ?? u.outputTokens) || 0;
  return { input, output, cacheRead: Number(u.cacheRead ?? u.cached_tokens) || 0 };
}

/**
 * Replaces that runner's startRun: returns { abort, done }, with the same event shape as other
 * runners.
 */
export function startCliLoop(opts, startProviderRun, deps = {}) {
  const ac = new AbortController();
  const emit = (ev) => { for (const e of presentLoopEvent(ev)) { try { opts.onEvent(e); } catch { /* Frontend disconnection does not affect the loop */ } } };
  const { onEvent: _drop, reviewLoop: _r, deepAuto: _d, ...baseOpts } = opts;
  const factory = cliBackend({ startProviderRun, baseOpts, setToolAccess: opts.setToolAccess, signal: ac.signal });

  const done = (async () => {
    try {
      const result = await runReviewLoop({
        backendFactory: factory,
        system: opts.systemPrompt, userText: opts.prompt,
        lessonsStore: deps.lessonsStore || lessonsStore(), onEvent: emit,
      });
      opts.onEvent({ type: 'done', usage: result.usage, outcome: result.outcome, completed: result.completed, failed: result.failed });
    } catch (err) {
      if (ac.signal.aborted) opts.onEvent({ type: 'status', text: tr("Aborted") });
      else opts.onEvent(err.runEvent || { type: 'error', message: String(err?.message || err) });
    } finally {
      opts.setToolAccess?.(null);
    }
  })();
  return { abort: () => ac.abort(), done };
}
