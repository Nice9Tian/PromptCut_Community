// Corresponds to claude-quickstarts/agents/providers/openai.py
// Vendor API key points: Chat Completions endpoint, tool becomes a separate message with role=tool,
// tools are defined as function, delta stream is assembled at choices[0].delta.
import { readSse, assertOk, STREAM_CUT, isCutReadError, streamCutNotice } from './base.mjs';
import { toolToVendor } from '../schema.mjs';
import { createThinkSplitter } from '../think-tags.mjs';
import { resolveMaxOutput, usesMaxCompletionTokens, lowerOutputAfter400, swapOutputParamAfter400 } from '../model-limits.mjs';
import { noteOutputFallback, asRead } from './output-fallback.mjs';

/** Whether this 400 is the "tools + reasoning_effort incompatible" type */
function isEffortWithToolsRejection(text) {
  if (!text) return false;
  const s = String(text);
  return /reasoning_effort/i.test(s) && /not supported|unsupported|cannot|can't/i.test(s);
}

export function createProvider(cfg, { fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'openai',
    async *stream(messages, tools, system, signal) {
      let baseUrl = cfg.baseUrl || 'https://api.openai.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
      
      let url = '';
      if (baseUrl.endsWith('/v1')) {
        url = `${baseUrl}/chat/completions`;
      } else {
        url = `${baseUrl}/v1/chat/completions`;
      }

      const headers = {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json'
      };

      const openaiMessages = [];
      if (system) {
        openaiMessages.push({ role: 'system', content: system });
      }

      for (const msg of messages) {
        if (msg.role === 'user') {
          if (!Array.isArray(msg.content)) continue;
          
          let hasToolResult = false;
          let textBuffer = '';
          // Images can only be attached to role:"user": content of role:"tool" only accepts strings
          const parts = [];

          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              hasToolResult = true;
            } else if (block.type === 'text') {
              textBuffer += block.text;
              parts.push({ type: 'text', text: block.text });
            } else if (block.type === 'image') {
              parts.push({ type: 'image_url', image_url: { url: `data:${block.mime || 'image/png'};base64,${block.data}` } });
            }
          }

          if (!hasToolResult) {
             // When there are no images, still send plain strings: not all compatible endpoints support the
             // multimodal array format
             const hasImage = parts.some(p => p.type === 'image_url');
             openaiMessages.push({ role: 'user', content: hasImage ? parts : textBuffer });
          } else {
             // When the same message contains both tool results and images: tool results each become role:"tool",
             // images can only follow in a separate role:"user" message: role:"tool" cannot hold image blocks.
             // The order remains assistant(tool_calls) → tool(...) → user(image), which is valid.
             for (const block of msg.content) {
               if (block.type === 'tool_result') {
                 openaiMessages.push({
                   role: 'tool',
                   tool_call_id: block.tool_use_id,
                   content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                 });
               }
             }
             // After all tool results are sent, images and accompanying text are merged into a single user message.
             // Images must stay with their descriptive text, so the text is moved here together rather than
             // sending each separately.
             if (parts.length) {
               const hasImage = parts.some(p => p.type === 'image_url');
               openaiMessages.push({ role: 'user', content: hasImage ? parts : textBuffer });
             }
          }
        } else if (msg.role === 'assistant') {
          if (!Array.isArray(msg.content)) continue;
          
          let textBuffer = '';
          const toolCalls = [];
          
          for (const block of msg.content) {
            if (block.type === 'text') {
              textBuffer += block.text;
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input)
                }
              });
            }
          }
          
          const outMsg = { role: 'assistant', content: textBuffer || null };
          if (toolCalls.length > 0) {
            outMsg.tool_calls = toolCalls;
          }
          openaiMessages.push(outMsg);
        }
      }

      /*
       * Per-request output limit is fetched by model (model-limits.mjs, A07 2026-10-22). The o-series,
       * GPT-5, and subsequent reasoning models send `max_completion_tokens` (openlux docs: reasoning
       * models primarily recognize this, falling back to `max_tokens` only when unset; thinking also
       * counts toward output), while the rest send `max_tokens`; do not pass both at the same time.
       */
      let outputParam = usesMaxCompletionTokens(cfg.model) ? 'max_completion_tokens' : 'max_tokens';
      let maxOutput = resolveMaxOutput(cfg);
      const body = {
        model: cfg.model,
        messages: openaiMessages,
        stream: true,
        [outputParam]: maxOutput,
        stream_options: { include_usage: true }
      };

      const openaiTools = (tools || []).map(t => toolToVendor(t, 'openai', { compat: cfg.schemaCompat }));
      if (openaiTools.length > 0) {
        body.tools = openaiTools;
      }

      /*
       * Thinking effort. Empty string = use model default; in this case **do not send any field at all**:
       * some upstreams return 400 directly on unrecognized parameters instead of ignoring them.
       *
       * `reasoning_effort` is the standard field in OpenAI compatibility specs (o-series, GPT-5 series),
       * and relay services accept it as well: openlux documentation states "Inference model strength
       * (such as low / medium / high). It can also be automatically injected by the gateway through
       * the model name suffix." That is, when filling in model names with suffixes such as `xxx-thinking`,
       * the gateway injects it automatically; in that case, the user not selecting a tier is also valid,
       * so do not force one in to overwrite it.
       *
       * But some models **do not accept reasoning_effort and function tools appearing together**,
       * directly returning 400:
       *
       *   Function tools with reasoning_effort are not supported for gpt-5.6-terra in
       *   /v1/chat/completions. To use function tools, use /v1/responses or set
       *   reasoning_effort to 'none'.
       *
       * And this app **sends around thirty tools with every request**, so whenever it hits an upstream
       * that does not accept this combination, it returns 400 on the first send: it looks like
       * a disconnection, but in fact parameters conflicted with the routing.
       *
       * The general retry layer ignores 400 (that layer is right: if parameters are wrong, resending
       * a hundred times yields the same), but **this 400 is an exception**, because it depends on
       * which upstream it gets routed to, not on the request content. It is handled separately below.
       */
      if (cfg.effort) body.reasoning_effort = cfg.effort;

      /** Timestamp of the last actual request (used for elapsed time when capping by speed, see harness/output-speed.mjs) */
      let sentAt = Date.now();
      const post = (b) => { sentAt = Date.now(); return fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(b),
        signal
      }); };
      /** Last sent request body (next retry uses this after stripping thinking tier and swapping output field) */
      let sentBody = body;
      let response = await post(body);

      if (response.status === 400 && cfg.effort && openaiTools.length > 0) {
        // The body can only be read once: read to check; if not for this reason,
        // wrap back and pass to assertOk to report the error normally
        let text = '';
        try { text = await response.text(); } catch { /* If it cannot be read, assume it is not */ }
        if (!isEffortWithToolsRejection(text)) {
          response = asRead(response, text);
        } else {
          /*
           * **This is a routing issue, not a model capability issue**: the relay service billing page
           * makes it clear:
           *
           *   01:00:04  Group Openai-Gpt-2  gpt-5.6-terra  Error    0 tokens  $0.000000
           *   01:00:43  Group Codex-Gpt-1   gpt-5.6-terra  Success  18s       $0.001894
           *
           * The same model name, two different upstream groups: one does not take function tools + reasoning_effort,
           * while the other takes them. Which one it lands on is determined by the relay service routing,
           * independent of what we send.
           *
           * Therefore the correct approach is **resend as-is to hit another route**, rather than modifying
           * the request. In particular: do not record "this model is not supported": that amounts to
           * permanently turning off the thinking tier based on a single piece of bad luck, even though it
           * works fine on the right upstream.
           *
           * Resending is cheap: the rejected attempt was billed at 0 tokens, $0.000000, and returned in 1 second,
           * so trying a few more times is worth it. If none succeed, fall back as a second best to stripping
           * the parameter: missing a thinking tier is always better than leaving the entire chat red with an error.
           */
          const ROUTE_RETRIES = 3;
          for (let i = 0; i < ROUTE_RETRIES && isEffortWithToolsRejection(text); i++) {
            response = await post(body);
            if (response.status !== 400) { text = ''; break; }
            try { text = await response.text(); } catch { text = ''; }
            if (!isEffortWithToolsRejection(text)) { response = asRead(response, text); break; }
          }
          // Several routes all hit unsupported upstreams: as a final fallback, strip the thinking tier and retry once
          if (response.status === 400 && isEffortWithToolsRejection(text)) {
            const retryBody = { ...body };
            delete retryBody.reasoning_effort;
            sentBody = retryBody;
            response = await post(retryBody);
          }
        }
      }

      /*
       * 400 caused by output limit (A07): if the field name is wrong, swap to the other field and retry once;
       * if the number is too large, drop down one tier and retry once. At most once for each, write a log.
       * Other 400 errors are passed as-is to assertOk to report.
       */
      if (response.status === 400) {
        let text = '';
        try { text = await response.text(); } catch { /* If it cannot be read, assume it is not */ }
        response = asRead(response, text);
        const swapTo = swapOutputParamAfter400(text, outputParam);
        if (swapTo) {
          const next = { ...sentBody };
          delete next[outputParam];
          next[swapTo] = maxOutput;
          yield noteOutputFallback({ vendor: 'openai', model: cfg.model, action: 'swap-param', from: outputParam, to: swapTo });
          outputParam = swapTo; sentBody = next;
          response = await post(next);
          if (response.status === 400) { try { text = await response.text(); } catch { text = ''; } response = asRead(response, text); }
        }
        const lower = response.status === 400 ? lowerOutputAfter400(text, maxOutput) : null;
        if (lower) {
          yield noteOutputFallback({ vendor: 'openai', model: cfg.model, action: 'lower', from: maxOutput, to: lower });
          maxOutput = lower;
          sentBody = { ...sentBody, [outputParam]: lower };
          response = await post(sentBody);
        }
      }

      await assertOk(response, 'openai');
      yield { type: 'response_open', sentAt };

      let partialToolCalls = {}; // index -> {id, name, args}
      let stopReason = null;
      /*
       * Some relay services do not put reasoning into a separate field, but instead send `<think>…</think>`
       * **inlined in content**. In that case, the entire block goes through text_delta into the chat bubble,
       * and the user sees a bare `</think>` stuck in the middle of the text.
       * Here at the stream level it is split into the thinking channel: downstream (UI, history) does not
       * need a single line of changes.
       * The splitter needs to track state across chunks, so it is created outside the loop.
       */
      const think = createThinkSplitter();
      let promptTokens = 0;
      let completionTokens = 0;
      let cacheRead = 0;
      /** Stream has yielded data (text, thinking, tool calls): break afterwards finalizes as cut, not error (STREAM_CUT) */
      let started = false;
      /** Stream broke before finalizing: { how, detail } (how is error-event / connection / no-finish) */
      let cut = null;

      /**
       * Deliver accumulated tool calls. When finishReason is `length` (hit output limit) or cutNow is true
       * (interrupted mid-stream), the one whose argument JSON cannot be parsed is delivered as
       * tool_use_partial (A07 / stream-cut); in other cases, malformed JSON is reported back to the model
       * as parameter error as usual.
       */
      function* emitToolCalls(finishReason, cutNow) {
        const sorted = Object.keys(partialToolCalls).map(Number).sort((a, b) => a - b);
        /*
         * The gateway occasionally splits one call into two (different ids): the earlier one has a name
         * and empty arguments, while the later one has arguments and an empty name.
         * In actual runs, set_position was seen split like this: the earlier one reported "missing clipId",
         * and the later one with an empty name entered history, causing the entire next request to 400.
         * The condition is guarded very strictly: merge only when "nameless with arguments" immediately follows
         * "named with empty arguments"; normal parallel calls each have their own names and will never hit this.
         */
        for (let k = 1; k < sorted.length; k++) {
          const cur = partialToolCalls[sorted[k]], prev = partialToolCalls[sorted[k - 1]];
          if (cur && prev && !cur.name && cur.args && prev.name && !String(prev.args || '').replace(/[{}\s]/g, '')) {
            prev.args = cur.args;
            delete partialToolCalls[sorted[k]];
          }
        }
        const indices = sorted.filter((i) => partialToolCalls[i]);
        for (const idx of indices) {
          const pt = partialToolCalls[idx];
          // The one whose arguments had not arrived at all when cut off: incomplete, cannot be executed as `{}`
          if (cutNow && !String(pt.args || '').trim()) {
            yield { type: 'tool_use_partial', id: pt.id, name: pt.name, args: '' };
            continue;
          }
          let input = {};
          try {
            input = JSON.parse(pt.args || '{}');
          } catch (error) {
            /*
             * The one not finished when hitting the output limit (`length`) or interrupted mid-stream: do not execute;
             * pass the raw arguments already received to agent.mjs, which extracts half-written fields from the truncated
             * JSON and stores them in a code block so the model can continue writing (A07, user decision, 2026-10-22).
             * Malformed JSON not caused by truncation is reported back to the model as a parameter error as usual.
             */
            if (finishReason === 'length' || cutNow) {
              yield { type: 'tool_use_partial', id: pt.id, name: pt.name, args: pt.args || '' };
              continue;
            }
            yield { type: 'tool_use', id: pt.id, name: pt.name, input: {}, inputError: `Tool arguments JSON incomplete: ${error.message}. Reduce the batch size or raise the output length and retry.` };
            continue;
          }
          yield { type: 'tool_use', id: pt.id, name: pt.name, input };
        }
        partialToolCalls = {}; // clear
      }

      try {
        for await (const { data } of readSse(response, { signal })) {
          if (data === '[DONE]') {
            break; // break instead of continue for openai DONE
          }

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens || 0;
            completionTokens = parsed.usage.completion_tokens || 0;
            /*
             * Gateway-automated prompt cache hit count is here. prompt_tokens itself already **includes** it
             * (measured on openlux: prompt_tokens 34057, cached_tokens 27877), so input does not need to add it again;
             * this count is only used to observe the hit rate. Compatible endpoints that do not report this field are 0.
             */
            cacheRead = Number(parsed.usage.prompt_tokens_details?.cached_tokens) || 0;
          }

          if (parsed.error) {
            const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || 'API stream returned an error');
            /*
             * Error arriving after the stream has already yielded data (measured on openlux, 2026-10-22: at around 300s,
             * an error arrives: "The upstream stream ended before the response was complete.", HTTP is still 200,
             * no finish_reason): finalize as truncation instead of discarding what has already been written.
             * If data has not been yielded yet, throw the error as usual.
             */
            if (stopReason) break; // Already finalized normally; subsequent errors do not affect this reply
            if (!started) throw new Error(message);
            cut = { how: 'error-event', detail: message };
            break;
          }
          const choice = parsed.choices?.[0];
          if (choice) {
            if (choice.delta?.content) {
              started = true;
              for (const ev of think.push(choice.delta.content)) {
                yield ev.kind === 'think'
                  ? { type: 'thinking_delta', text: ev.text }
                  : { type: 'text_delta', text: ev.text };
              }
            }

            // Compatible endpoints name the reasoning process differently; these three are common, take whichever is found
            const reasoning =
              choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? choice.delta?.thinking;
            if (typeof reasoning === 'string' && reasoning) {
              started = true;
              yield { type: 'thinking_delta', text: reasoning };
            }

            if (Array.isArray(choice.delta?.tool_calls)) {
              started = true;
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index;
                if (!partialToolCalls[idx]) {
                  partialToolCalls[idx] = { id: '', name: '', args: '' };
                }
                if (tc.id) partialToolCalls[idx].id = tc.id;
                if (tc.function?.name) partialToolCalls[idx].name = tc.function.name;
                if (tc.function?.arguments) partialToolCalls[idx].args += tc.function.arguments;
              }
            }

            if (choice.finish_reason) {
              stopReason = choice.finish_reason;
              yield* emitToolCalls(choice.finish_reason, false);
            }
          }
        }
      } catch (err) {
        // Connection interrupted mid-stream (gateway cut off, remote closed connection): if data was yielded
        // and not yet finalized, finalize as truncation; otherwise throw as usual
        if (!isCutReadError(err, signal) || (!started && !stopReason)) throw err;
        if (!stopReason) cut = { how: 'connection', detail: err?.message || String(err) };
      }

      if (!stopReason && !cut && started && !signal?.aborted) {
        // Stream finished reading but has no finish_reason: likewise incomplete
        cut = { how: 'no-finish', detail: 'Stream ended before finish_reason' };
      }
      if (cut) {
        yield streamCutNotice('openai', cut.how, cut.detail, { pendingToolCalls: Object.keys(partialToolCalls).length });
        yield* emitToolCalls(null, true);
        stopReason = STREAM_CUT;
      }

      if (!stopReason) throw new Error('The API response stream ended early or returned no SSE data. Check the API protocol.');
      // Tool calls left incomplete when hitting length limit were already delivered as tool_use_partial in
      // the finish_reason branch above; finalize by reporting `length` as usual, letting `agent.mjs` save the
      // code block so the model can continue writing; if consecutive truncations exceed the limit, report failure
      // explicitly. Those interrupted mid-stream finalize with `stream_cut`, following the same approach.
      yield { type: 'usage', input: promptTokens, output: completionTokens, cacheRead };
      // Finalize: release the held-back tail (could be half a tag, or just normal body text)
      for (const ev of think.flush()) {
        yield ev.kind === 'think'
          ? { type: 'thinking_delta', text: ev.text }
          : { type: 'text_delta', text: ev.text };
      }
      yield { type: 'stop', reason: stopReason || 'stop' };
    }
  };
}
