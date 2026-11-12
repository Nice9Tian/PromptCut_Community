/**
 * PromptCut binding layer for `server/harness/tools/index.mjs`.
 *
 * Supplies PromptCut's MCP tool manifest (`mcp-tools.mjs`), background job polling rules
 * (`auto_workflow`, `stt_install`, `transcribe_media`), and dynamic `list_cards` / `list_parts`
 * parameter schema decorators (`card-params-schema.mjs`) to the generic harness `buildTools`.
 */
import { tools as mcpTools } from '../mcp-tools.mjs';
import { injectCardParams, injectPartParams } from '../card-params-schema.mjs';
import { buildTools as buildHarnessTools } from '../harness/tools/index.mjs';

export const PROMPTCUT_JOB_WAITER = {
  tools: ['auto_workflow', 'stt_install', 'transcribe_media'],
  descriptionSuffix: ' In API mode background jobs are awaited automatically; do not poll densely or restart them yourself.',
  match(name, _input, initial) {
    const workflow = (name === 'auto_workflow' && initial?.running === true)
      || (name === 'auto_workflow_status' && initial?.done === false);
    const background = (name === 'stt_install' || name === 'transcribe_media') && Boolean(initial?.jobId);
    return workflow || background;
  },
  poll(jobId, { name, initial, callTool }) {
    const workflow = (name === 'auto_workflow' && initial?.running === true)
      || (name === 'auto_workflow_status' && initial?.done === false);
    return callTool(workflow ? 'auto_workflow_status' : 'background_job_status', { jobId });
  },
  errorMessage(status) {
    return status?.error || 'Background task failed. Check the install or transcription log.';
  },
  async resolve(status, { name, input, callTool }) {
    if (name === 'transcribe_media') return callTool('get_transcript', { mediaId: input.mediaId });
    if (name === 'stt_install') return callTool('stt_status', {});
    return status.result ?? status;
  },
};

export const PROMPTCUT_SCHEMA_DECORATORS = [
  async (result, { callTool, onEvent }) => {
    try {
      const cards = await callTool('list_cards', { detail: 'full' });
      injectCardParams(result, cards);
    } catch (error) {
      onEvent({ type: 'status', text: `Could not fetch the card schema; add_clip parameter hints will be missing: ${error.message}` });
    }
  },
  async (result, { callTool, onEvent }) => {
    try {
      const parts = await callTool('list_parts', { detail: 'full' });
      injectPartParams(result, parts);
    } catch (error) {
      onEvent({ type: 'status', text: `Could not fetch the part schema; add_part parameter hints will be missing: ${error.message}` });
    }
  },
];

export async function buildTools(options = {}) {
  return buildHarnessTools({
    tools: mcpTools,
    jobWaiters: [PROMPTCUT_JOB_WAITER],
    schemaDecorators: PROMPTCUT_SCHEMA_DECORATORS,
    ...options,
  });
}
