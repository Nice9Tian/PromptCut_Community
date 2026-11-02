import { tools as mcpTools } from '../../mcp-tools.mjs';
import { thinkTool } from './think.mjs';
import { createTextEditorTool } from './textEditor.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { injectCardParams, injectPartParams } from '../../card-params-schema.mjs';
import { isUserMessageCall } from '../agent.mjs';
import { userMessageTool, answerUserMessage } from './userMessage.mjs';
import { codeCacheTools } from '../../tools/code-cache.mjs';
import { loadSkillTool } from '../../tools/agent-skills.mjs';

/**
 * `only`: if provided, only passes tools in the list to the model (open manifest of the hosted
 * tier); `localTools: false` excludes `text_editor` which reads and writes local files.
 * When neither is provided, it behaves the same as before.
 */
export async function buildTools({ callTool, workspaceDir, onEvent = () => {}, pollIntervalMs = 3000, jobTimeoutMs = 600000, only = null, localTools = true, codeCache = null, skills = [] }) {
  async function waitForJob(name, input, initial, context) {
    const workflow = name === 'auto_workflow' && initial?.running === true || name === 'auto_workflow_status' && initial?.done === false;
    const background = ['stt_install', 'transcribe_media'].includes(name) && initial?.jobId;
    if (!workflow && !background) return initial;
    const jobId = initial.jobId || input.jobId;
    const start = Date.now();
    while (Date.now() - start < jobTimeoutMs) {
      context.signal?.throwIfAborted();
      onEvent({ type: 'progress', phase: 'waiting', round: context.round, callId: context.callId, jobId, text: `Background task in progress: ${name}, waited ${Math.floor((Date.now() - start) / 1000)} s; waiting automatically, no model rounds used.` });
      await delay(pollIntervalMs, undefined, { signal: context.signal });
      const status = await callTool(workflow ? 'auto_workflow_status' : 'background_job_status', { jobId });
      onEvent({ type: 'diagnostic', stage: 'job_poll', callId: context.callId, data: status });
      if (!status?.done) continue;
      if (status.ok === false) throw new Error(status.error || 'Background task failed. Check the install or transcription log.');
      if (name === 'transcribe_media') return await callTool('get_transcript', { mediaId: input.mediaId });
      if (name === 'stt_install') return await callTool('stt_status', {});
      return status.result ?? status;
    }
    throw new Error(`Timed out waiting for background task ${jobId}; it may still be running. Check its status first and do not start it again.`);
  }
  const offered = only ? mcpTools.filter((t) => only.has(t.name)) : mcpTools;
  const result = offered.map(t => ({
    name: t.name,
    description: t.description + (['auto_workflow', 'stt_install', 'transcribe_media'].includes(t.name) ? ' In API mode background jobs are awaited automatically; do not poll densely or restart them yourself.' : ''),
    // Deep clone: params will be rewritten in place below, while mcpTools is a module-level constant
    // shared across the entire process
    inputSchema: JSON.parse(JSON.stringify(t.inputSchema)),
    // context.callId is the id for this tool_use: passed to the editor into the tool call event,
    // used by the page AI panel to match chat history (c65-integ2)
    async execute(input, context = {}) { return waitForJob(t.name, input, await callTool(t.name, input, { callId: context.callId }), context); },
  }));
  /*
   * `to: "user"` for `send_message` (say a sentence or two to the user, rendered by the UI inside
   * bubbles, user decision, 2026-10-20) is answered in place here without going through the bulletin
   * board: both cloud and local go through this layer without opening separate routes. Other
   * recipients are handed off to `callTool` as usual (multi-Agent coordination).
   * When `send_message` is missing from the open manifest of the hosted tier, add a standalone one
   * that can only send to users.
   */
  const coord = result.find((t) => t.name === 'send_message');
  if (coord) {
    const forward = coord.execute;
    coord.execute = async (input, context = {}) => (isUserMessageCall(coord.name, input) ? answerUserMessage(input) : forward(input, context));
  } else result.push(userMessageTool());
  result.push(thinkTool);
  if (localTools) result.push(createTextEditorTool(workspaceDir));
  /*
   * Code cache space (A07, 2026-10-22): provided for both local and cloud, unrestricted by the hosted
   * tier open manifest (`only`): it only reads and writes this project's code cache directory,
   * without touching project, asset, or other files. The directory is determined by the host
   * (`codeCacheDir` in `runners/api.mjs`).
   */
  if (codeCache) result.push(...codeCacheTools(codeCache));
  // Skills (issue 46): likewise provided for both local and cloud, unrestricted by the open manifest:
  // it only reads instructions, without going through callTool
  if (skills.length) result.push(loadSkillTool(skills));

  // Replace add_clip / update_clip params with the actual schema branched by cardId.
  // Without this step, it is a free-form object, and the model sees "no fields", unable to pass any card parameters:
  // the MCP server path has always done this, but the direct API path previously missed it.
  try {
    const cards = await callTool('list_cards', { detail: 'full' });
    injectCardParams(result, cards);
  } catch (error) {
    // Fall back to a free-form object if the card list cannot be retrieved:
    // missing parameter hints is better than the tool being completely unusable
    onEvent({ type: 'status', text: `Could not fetch the card schema; add_clip parameter hints will be missing: ${error.message}` });
  }

  try {
    const parts = await callTool('list_parts', { detail: 'full' });
    injectPartParams(result, parts);
  } catch (error) {
    onEvent({ type: 'status', text: `Could not fetch the part schema; add_part parameter hints will be missing: ${error.message}` });
  }

  return result;
}
