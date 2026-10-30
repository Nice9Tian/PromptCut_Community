// 对应 claude-quickstarts/agents/providers/anthropic.py
// 本家 API 要点: Messages API, role 为 user/assistant, content 是 block 数组 (text/tool_use/tool_result).
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

      // 单次输出上限按模型取(model-limits.mjs,A07 2026-10-22):当前各型号 128K;本来就是流式,大数不会撞 HTTP 超时
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

      /** 最后一次真正发出请求的时刻(按速度设上限时算用时用,见 harness/output-speed.mjs) */
      let sentAt = Date.now();
      const post = (b) => { sentAt = Date.now(); return fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(b), signal }); };
      let response = await post(body);

      // 数太大被拒(「max_tokens: 200000 > 128000 …」):降一档重发一次,记日志(A07)
      if (response.status === 400) {
        let text = '';
        try { text = await response.text(); } catch { /* 读不到就当不是 */ }
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
      /** 参数 JSON 解不开的工具调用,等收尾时按停止原因决定怎么交 */
      const broken = [];
      /** 流已经出过数据(内容块):之后再断就按截断收尾(STREAM_CUT),见 base.mjs */
      let started = false;
      /** 流在 message_stop 之前断了:{ how, detail } */
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
          const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message || parsed.message || 'API 流返回错误');
          if (receivedStop) break; // 已经正常收尾,后面来的错不影响这次回复
          // 流已经出过内容之后来的 error(网关中途掐断、上游 overloaded):按截断收尾,不扔掉已经写出的东西
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
               * 坏 JSON 先扣住:是不是写到上限被截断要等后面的 message_delta 才知道。是截断就交成 tool_use_partial
               * (agent.mjs 存代码块、让模型接着写,A07),不是就照旧按参数错误报回模型。
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
          // 连 content_block_stop 都没等到的那一个(截断时可能这样)也算没写完
          for (const tool of [...broken, ...Object.values(partialTools)]) {
            if (truncated) yield { type: 'tool_use_partial', id: tool.id, name: tool.name, args: tool.partialJson || '' };
            else yield { type: 'tool_use', id: tool.id, name: tool.name, input: {}, inputError: `工具参数 JSON 不完整：${tool.error || '没有收到结尾'}` };
          }
          broken.length = 0; partialTools = {};
          yield { type: 'usage', input: inputTokens, output: outputTokens };
          yield { type: 'stop', reason: stopReason || 'end_turn' };
        }
      }
      } catch (err) {
        // 连接在流中途被断:出过内容、还没收尾的按截断收尾;别的照旧抛
        if (!isCutReadError(err, signal) || (!started && !receivedStop)) throw err;
        if (!receivedStop) cut = { how: 'connection', detail: err?.message || String(err) };
      }

      if (!receivedStop && !cut && started && !signal?.aborted) cut = { how: 'no-finish', detail: '流在 message_stop 之前结束' };
      if (cut) {
        // 没写完的工具调用(参数解不开的、连 content_block_stop 都没等到的)交成 tool_use_partial,由 agent.mjs 存代码块、让模型接着写
        yield streamCutNotice('anthropic', cut.how, cut.detail, { pendingToolCalls: broken.length + Object.keys(partialTools).length });
        for (const tool of [...broken, ...Object.values(partialTools)]) yield { type: 'tool_use_partial', id: tool.id, name: tool.name, args: tool.partialJson || '' };
        broken.length = 0; partialTools = {};
        yield { type: 'usage', input: inputTokens, output: outputTokens };
        yield { type: 'stop', reason: STREAM_CUT };
        return;
      }

      if (!receivedStop && !signal?.aborted) {
        throw new Error('API 响应流提前结束或未返回 SSE 数据，请检查接口协议。');
      }
    }
  };
}
