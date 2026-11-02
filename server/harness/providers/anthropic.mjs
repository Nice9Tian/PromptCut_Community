// Corresponds to claude-quickstarts/agents/providers/anthropic.py
// Vendor API key points: Messages API, role is user/assistant, content is a block array
// (text/tool_use/tool_result).
import { readSse, assertOk, STREAM_CUT, isCutReadError, streamCutNotice } from './base.mjs';
import { toolToVendor } from '../schema.mjs';
import { resolveMaxOutput, lowerOutputAfter400 } from '../model-limits.mjs';
import { noteOutputFallback, asRead } from './output-fallback.mjs';

export function createProvider(cfg, { fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'anthropic',
    async *stream(messages, tools, system, signal) {
      let baseUrl = cfg.baseUrl || 'https://api.anthropic.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
      const url = `${baseUrl}/v1/messages`;

      const headers = {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      };

      const anthropicMessages = messages.map(msg => {
        const newMsg = { role: msg.role, content: [] };
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' || block.type === 'tool_use') {
              newMsg.content.push(block);
            } else if (block.type === 'image') {
              newMsg.content.push({ type: 'image', source: { type: 'base64', media_type: block.mime || 'image/png', data: block.data } });
            } else if (block.type === 'tool_result') {
              newMsg.content.push({
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                is_error: block.is_error
              });
            }
          }
        }
        return newMsg;
      });

      // Per-request output limit is fetched by model (model-limits.mjs, A07 2026-10-22): currently 128K
      // across models; it is streaming anyway, so large numbers will not hit HTTP timeouts
      let maxOutput = resolveMaxOutput(cfg);
      const body = {
        model: cfg.model,
        max_tokens: maxOutput,
        messages: anthropicMessages,
        stream: true
      };
      if (system) {
        body.system = system;
      }
      
      const anthropicTools = (tools || []).map(t => toolToVendor(t, 'anthropic', { compat: cfg.schemaCompat }));
      if (anthropicTools.length > 0) {
        body.tools = anthropicTools;
      }

      /** Timestamp of the last actual request (used for elapsed time when capping by speed, see harness/output-speed.mjs) */
      let sentAt = Date.now();
      const post = (b) => { sentAt = Date.now(); return fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(b), signal }); };
      let response = await post(body);

      // Rejected because the number is too large ("max_tokens: 200000 > 128000 …"): step down one tier,
      // resend once, and log it (A07)
      if (response.status === 400) {
        let text = '';
        try { text = await response.text(); } catch { /* If it cannot be read, assume it is not */ }
        response = asRead(response, text);
        const lower = lowerOutputAfter400(text, maxOutput);
        if (lower) {
          yield noteOutputFallback({ vendor: 'anthropic', model: cfg.model, action: 'lower', from: maxOutput, to: lower });
          maxOutput = lower;
          response = await post({ ...body, max_tokens: lower });
        }
      }

      await assertOk(response, 'anthropic');
      yield { type: 'response_open', sentAt };

      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = null;
      let receivedStop = false;
      let partialTools = {};
      /** Tool calls whose argument JSON cannot be parsed; decide how to deliver at finalization by stop reason */
      const broken = [];
      /** Stream has emitted data (content blocks): if disconnected later, finalize as truncated (STREAM_CUT), see base.mjs */
      let started = false;
      /** Stream disconnected before message_stop: { how, detail } */
      let cut = null;

      try {
      for await (const { event, data } of readSse(response, { signal })) {
        if (data === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        if (event === 'error' || parsed.type === 'error' || parsed.error) {
          const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message || parsed.message || 'API stream returned an error');
          if (receivedStop) break; // Already finalized normally; subsequent errors do not affect this reply
          // Errors arriving after the stream has already emitted content (gateway cut off midway, upstream
          // overloaded): finalize as truncated, do not discard what has already been written
          if (!started) throw new Error(message);
          cut = { how: 'error-event', detail: message };
          break;
        }
        if (event === 'content_block_start' || event === 'content_block_delta') started = true;
        if (event === 'message_start') {
          if (parsed.message?.usage?.input_tokens) {
            inputTokens = parsed.message.usage.input_tokens;
          }
        } else if (event === 'content_block_start') {
          if (parsed.content_block?.type === 'tool_use') {
            partialTools[parsed.index] = {
              id: parsed.content_block.id,
              name: parsed.content_block.name,
              partialJson: ''
            };
          }
        } else if (event === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta') {
            yield { type: 'text_delta', text: parsed.delta.text };
          } else if (parsed.delta?.type === 'thinking_delta') {
            yield { type: 'thinking_delta', text: parsed.delta.thinking };
          } else if (parsed.delta?.type === 'input_json_delta') {
            if (partialTools[parsed.index]) {
              partialTools[parsed.index].partialJson += parsed.delta.partial_json;
            }
          }
        } else if (event === 'content_block_stop') {
          if (partialTools[parsed.index]) {
            const tool = partialTools[parsed.index];
            let input = {};
            try {
              input = JSON.parse(tool.partialJson || '{}');
            } catch (error) {
              /*
               * Hold back invalid JSON for now: whether it was truncated by hitting the limit requires waiting
               * for the subsequent message_delta. If truncated, deliver as tool_use_partial (agent.mjs stores
               * the code block and lets the model continue writing, A07); otherwise, report back to the model
               * as an argument error as usual.
               */
              broken.push({ ...tool, error: error.message });
              delete partialTools[parsed.index];
              continue;
            }
            yield { type: 'tool_use', id: tool.id, name: tool.name, input };
            delete partialTools[parsed.index];
          }
        } else if (event === 'message_delta') {
          if (parsed.delta?.stop_reason) {
            stopReason = parsed.delta.stop_reason;
          }
          if (parsed.usage?.output_tokens) {
            outputTokens = parsed.usage.output_tokens;
          }
        } else if (event === 'message_stop' || parsed.type === 'message_stop') {
          receivedStop = true;
          const truncated = stopReason === 'max_tokens';
          // Any block that did not even wait for content_block_stop (which can happen upon truncation)
          // is also considered incomplete
          for (const tool of [...broken, ...Object.values(partialTools)]) {
            if (truncated) yield { type: 'tool_use_partial', id: tool.id, name: tool.name, args: tool.partialJson || '' };
            else yield { type: 'tool_use', id: tool.id, name: tool.name, input: {}, inputError: `Tool arguments JSON incomplete: ${tool.error || 'no end received'}` };
          }
          broken.length = 0; partialTools = {};
          yield { type: 'usage', input: inputTokens, output: outputTokens };
          yield { type: 'stop', reason: stopReason || 'end_turn' };
        }
      }
      } catch (err) {
        // Connection cut midway through the stream: if it emitted content and has not finalized, finalize
        // as truncated; otherwise rethrow as usual
        if (!isCutReadError(err, signal) || (!started && !receivedStop)) throw err;
        if (!receivedStop) cut = { how: 'connection', detail: err?.message || String(err) };
      }

      if (!receivedStop && !cut && started && !signal?.aborted) cut = { how: 'no-finish', detail: 'Stream ended before message_stop' };
      if (cut) {
        // Incomplete tool calls (unparseable arguments, or did not even receive content_block_stop) are
        // delivered as tool_use_partial; agent.mjs stores the code block and lets the model continue writing
        yield streamCutNotice('anthropic', cut.how, cut.detail, { pendingToolCalls: broken.length + Object.keys(partialTools).length });
        for (const tool of [...broken, ...Object.values(partialTools)]) yield { type: 'tool_use_partial', id: tool.id, name: tool.name, args: tool.partialJson || '' };
        broken.length = 0; partialTools = {};
        yield { type: 'usage', input: inputTokens, output: outputTokens };
        yield { type: 'stop', reason: STREAM_CUT };
        return;
      }

      if (!receivedStop && !signal?.aborted) {
        throw new Error('The API response stream ended early or returned no SSE data. Check the API protocol.');
      }
    }
  };
}
