import { setTimeout as delay } from 'node:timers/promises';
import { thinkTool } from './think.mjs';
import { createTextEditorTool } from './textEditor.mjs';
import { isUserMessageCall } from '../agent.mjs';
import { userMessageTool, answerUserMessage } from './userMessage.mjs';
import { codeCacheTools } from '../code-cache.mjs';
import { loadSkillTool } from '../skills.mjs';

function matchesFilter(only, name) {
  if (!only) return true;
  if (typeof only.has === 'function') return only.has(name);
  if (Array.isArray(only)) return only.includes(name);
  if (typeof only === 'function') return Boolean(only(name));
  return true;
}

function suffixForTool(jobWaiters, name) {
  let suffix = '';
  for (const w of jobWaiters || []) {
    if (!w?.descriptionSuffix || !w?.tools) continue;
    const matched = typeof w.tools.has === 'function' ? w.tools.has(name) : (Array.isArray(w.tools) && w.tools.includes(name));
    if (matched) suffix += w.descriptionSuffix;
  }
  return suffix;
}

/**
 * Assemble the complete executable tool manifest for an `Agent` run from:
 * - `tools`: host/application tool descriptors (`{ name, description, inputSchema, execute? }`)
 * - `jobWaiters`: optional background-job polling specs for asynchronous host tools
 * - `schemaDecorators`: optional async callbacks `(result, { callTool, onEvent }) => Promise<void>`
 *   that enrich tool parameter schemas at startup
 * - built-in harness tools: `send_message` (`to: "user"`), `think`, `text_editor` (when
 *   `localTools !== false`), `code_cache_*` (when `codeCache` is provided), and `load_skill`
 *   (when `skills.length > 0`).
 */
export async function buildTools({
  tools = [],
  schemaDecorators = [],
  jobWaiters = [],
  callTool,
  workspaceDir,
  onEvent = () => {},
  pollIntervalMs = 3000,
  jobTimeoutMs = 600000,
  only = null,
  localTools = true,
  codeCache = null,
  skills = [],
} = {}) {
  async function waitForJob(name, input, initial, context) {
    const waiter = (jobWaiters || []).find((w) => w?.match?.(name, input, initial));
    if (!waiter) return initial;
    const getJobId = waiter.jobId || ((_n, inp, init) => init?.jobId || inp?.jobId);
    const isDone = waiter.isDone || ((s) => Boolean(s?.done));
    const isFailed = waiter.isFailed || ((s) => s?.ok === false);
    const getError = waiter.errorMessage || ((s) => s?.error || 'Background task failed.');
    const resolveFinal = waiter.resolve || ((s) => s?.result ?? s);

    const jobId = getJobId(name, input, initial);
    const start = Date.now();
    while (Date.now() - start < jobTimeoutMs) {
      context.signal?.throwIfAborted();
      onEvent({
        type: 'progress',
        phase: 'waiting',
        round: context.round,
        callId: context.callId,
        jobId,
        text: `Background task in progress: ${name}, waited ${Math.floor((Date.now() - start) / 1000)} s; waiting automatically, no model rounds used.`,
      });
      await delay(pollIntervalMs, undefined, { signal: context.signal });
      const status = await waiter.poll(jobId, { name, input, initial, callTool, signal: context.signal });
      onEvent({ type: 'diagnostic', stage: 'job_poll', callId: context.callId, data: status });
      if (!isDone(status)) continue;
      if (isFailed(status)) throw new Error(getError(status, { name, jobId }));
      return resolveFinal(status, { name, input, initial, jobId, callTool });
    }
    throw new Error(`Timed out waiting for background task ${jobId}; it may still be running. Check its status first and do not start it again.`);
  }

  const offered = only ? tools.filter((t) => matchesFilter(only, t.name)) : tools;
  const result = offered.map((t) => {
    const invoke = typeof t.execute === 'function'
      ? (input, context) => t.execute(input, context)
      : (input, context) => {
          if (typeof callTool !== 'function') {
            throw new Error(`Tool ${t.name} has no execute handler and no callTool function was provided.`);
          }
          return callTool(t.name, input, { callId: context.callId });
        };
    return {
      name: t.name,
      description: (t.description || '') + suffixForTool(jobWaiters, t.name),
      // Deep clone: schema decorators may rewrite parameter definitions in place while `tools` may
      // be a shared process-wide constant
      inputSchema: t.inputSchema ? JSON.parse(JSON.stringify(t.inputSchema)) : { type: 'object', properties: {} },
      async execute(input, context = {}) {
        return waitForJob(t.name, input, await invoke(input, context), context);
      },
    };
  });

  /*
   * `to: "user"` for `send_message` is answered in place here without forwarding to multi-Agent
   * coordination. Other recipients are handed off to the underlying `send_message` tool as usual.
   * When `send_message` is absent from `offered`, attach a standalone `send_message` tool that only
   * addresses `"user"`.
   */
  const coord = result.find((t) => t.name === 'send_message');
  if (coord) {
    const forward = coord.execute;
    coord.execute = async (input, context = {}) => (isUserMessageCall(coord.name, input) ? answerUserMessage(input) : forward(input, context));
  } else {
    result.push(userMessageTool());
  }

  result.push(thinkTool);
  if (localTools) result.push(createTextEditorTool(workspaceDir));
  if (codeCache) result.push(...codeCacheTools(codeCache));
  if (skills.length) result.push(loadSkillTool(skills));

  for (const decorate of schemaDecorators || []) {
    if (typeof decorate === 'function') {
      await decorate(result, { callTool, onEvent });
    }
  }

  return result;
}
