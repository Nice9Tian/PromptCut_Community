// 对应 claude-quickstarts/agents/providers/openai.py
// 本家 API 要点: Chat Completions 接口，tool 变成 role=tool 的独立消息，工具定义为 function，增量流在 choices[0].delta 拼装。
import { readSse, assertOk, STREAM_CUT, isCutReadError, streamCutNotice } from './base.mjs';
import { toolToVendor } from '../schema.mjs';
import { createThinkSplitter } from '../think-tags.mjs';
import { resolveMaxOutput, usesMaxCompletionTokens, lowerOutputAfter400, swapOutputParamAfter400 } from '../model-limits.mjs';
import { noteOutputFallback, asRead } from './output-fallback.mjs';

/** 这条 400 是不是「工具 + reasoning_effort 不兼容」那一种 */
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
          // 图片只能挂在 role:"user" 上——role:"tool" 的 content 只收字符串
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
             // 没有图片时仍旧发纯字符串:多模态数组的形式不是每个兼容端点都吃
             const hasImage = parts.some(p => p.type === 'image_url');
             openaiMessages.push({ role: 'user', content: hasImage ? parts : textBuffer });
          } else {
             // 同一条消息里既有工具结果又有图片时：工具结果各自变成 role:"tool"，
             // 图片只能另起一条 role:"user" 跟在后面——role:"tool" 装不下图片块。
             // 顺序仍是 assistant(tool_calls) → tool(...) → user(图)，合法。
             for (const block of msg.content) {
               if (block.type === 'tool_result') {
                 openaiMessages.push({
                   role: 'tool',
                   tool_call_id: block.tool_use_id,
                   content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                 });
               }
             }
             // 工具结果全部发完之后，图片和随行文字合成一条 user 消息。
             // 图片必须和它的说明文字在一起，所以文字也一并挪到这里，而不是各发一条。
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
       * 单次输出上限按模型取(model-limits.mjs,A07 2026-10-22)。o 系、GPT-5 及以后的推理模型发 `max_completion_tokens`
       * (openlux 文档:推理模型主要认它,没设时才可能沿用 `max_tokens`;思考也算进输出),其余发 `max_tokens`;两个不同时带。
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
       * 思考强度。空字符串 = 用模型默认,这时**一个字段都不发** ——
       * 有些上游对不认识的参数是直接 400,而不是忽略。
       *
       * `reasoning_effort` 是 OpenAI 兼容口径里的标准字段(o 系列、GPT-5 系列),
       * 中转站也照这个收:openlux 的文档写「Inference model strength (such as low /
       * medium / high). It can also be automatically injected by the gateway through
       * the model name suffix.」—— 也就是说填 `xxx-thinking` 这类带后缀的模型名时,
       * 网关会自己注入,那种情况下用户不选档位也是对的,别硬塞一个覆盖掉它。
       *
       * 但有些模型**不接受 reasoning_effort 和 function tools 同时出现**,直接 400:
       *
       *   Function tools with reasoning_effort are not supported for gpt-5.6-terra in
       *   /v1/chat/completions. To use function tools, use /v1/responses or set
       *   reasoning_effort to 'none'.
       *
       * 而这个应用**每一次请求都带着三十来个工具**,所以只要落到不吃这个组合的上游,
       * 就是一发就 400 —— 表现像断线,其实是参数和路由撞上了。
       *
       * 通用重试层不管 400(那层是对的:参数错重发一百次也一样),但**这一个 400 是例外**,
       * 因为它取决于路由到哪个上游,不取决于请求内容。下面单独处理。
       */
      if (cfg.effort) body.reasoning_effort = cfg.effort;

      /** 最后一次真正发出请求的时刻(按速度设上限时算用时用,见 harness/output-speed.mjs) */
      let sentAt = Date.now();
      const post = (b) => { sentAt = Date.now(); return fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(b),
        signal
      }); };
      /** 最后一次发出去的请求体(思考档被去掉、输出字段换过之后,下一次重发以它为准) */
      let sentBody = body;
      let response = await post(body);

      if (response.status === 400 && cfg.effort && openaiTools.length > 0) {
        // 正文只能读一次:读出来判一判,不是这个原因的话包回去交给 assertOk 正常报错
        let text = '';
        try { text = await response.text(); } catch { /* 读不到就当不是 */ }
        if (!isEffortWithToolsRejection(text)) {
          response = asRead(response, text);
        } else {
          /*
           * **这是路由问题,不是模型能力问题** —— 中转站的账单页说得很清楚:
           *
           *   01:00:04  分组 Openai-Gpt-2  gpt-5.6-terra  错误  0 tokens  $0.000000
           *   01:00:43  分组 Codex-Gpt-1   gpt-5.6-terra  成功  18s       $0.001894
           *
           * 同一个模型名,两个不同的上游分组,一个不吃 function tools + reasoning_effort、
           * 另一个吃。落到哪一个是中转站路由决定的,和我们发什么无关。
           *
           * 所以正确做法是**原样重发去碰另一条路由**,而不是改请求。特别地:
           * 别去记「这个模型不支持」—— 那等于凭一次坏运气把思考档永久关掉,
           * 而它在对的上游上明明是好的。
           *
           * 重发很便宜:被拒那次账单是 0 tokens、$0.000000、1 秒返回,
           * 所以多试几次是划算的。都不成再退而求其次去掉参数 ——
           * 少一个思考档,总好过把整条对话红在那儿。
           */
          const ROUTE_RETRIES = 3;
          for (let i = 0; i < ROUTE_RETRIES && isEffortWithToolsRejection(text); i++) {
            response = await post(body);
            if (response.status !== 400) { text = ''; break; }
            try { text = await response.text(); } catch { text = ''; }
            if (!isEffortWithToolsRejection(text)) { response = asRead(response, text); break; }
          }
          // 几条路由都撞上不支持的上游:最后退一步,去掉思考档再发一次
          if (response.status === 400 && isEffortWithToolsRejection(text)) {
            const retryBody = { ...body };
            delete retryBody.reasoning_effort;
            sentBody = retryBody;
            response = await post(retryBody);
          }
        }
      }

      /*
       * 输出上限引起的 400(A07):字段名不对就换另一个字段重发一次;数太大就降一档重发一次。各至多一次,记日志。
       * 别的 400 原样交给 assertOk 报。
       */
      if (response.status === 400) {
        let text = '';
        try { text = await response.text(); } catch { /* 读不到就当不是 */ }
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
       * 有的中转站不把推理放进单独字段,而是**内联在 content 里**发 `<think>…</think>`。
       * 那样它会整段走 text_delta 进聊天气泡,用户看到一个赤裸的 `</think>` 卡在正文中间。
       * 这里在流的层面把它拆到思考那条通道 —— 下游(UI、历史)一行都不用改。
       * 拆分器要跨 chunk 记状态,所以建在循环外面。
       */
      const think = createThinkSplitter();
      let promptTokens = 0;
      let completionTokens = 0;
      let cacheRead = 0;
      /** 流已经出过数据(文字、思考、工具调用):之后再断就按截断收尾,不当错误(STREAM_CUT) */
      let started = false;
      /** 流在收尾之前断了:{ how, detail }(how 是 error-event / connection / no-finish) */
      let cut = null;

      /**
       * 把攒着的工具调用交出去。finishReason 是 `length`(写到上限)或 cutNow 为真(中途被掐断)时,参数 JSON 解不开的那一个
       * 交成 tool_use_partial(A07 / stream-cut);别的情况坏 JSON 照旧按参数错误报回模型。
       */
      function* emitToolCalls(finishReason, cutNow) {
        const sorted = Object.keys(partialToolCalls).map(Number).sort((a, b) => a - b);
        /*
         * 网关偶尔把一次调用拆成两条(不同 id):前一条有名字、参数是空的,后一条有参数、名字是空的。
         * 实跑见过 set_position 就这样拆开:前一条报「缺少 clipId」,后一条空名进了历史,
         * 下一次请求整个 400。条件卡得很窄 —— 只在「无名有参」紧跟「有名无参」时合并,
         * 正常的并行调用各自都有名字,碰不到这里。
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
          // 被掐断时参数还一个字没来的那一个:没写完,不能当 `{}` 执行
          if (cutNow && !String(pt.args || '').trim()) {
            yield { type: 'tool_use_partial', id: pt.id, name: pt.name, args: '' };
            continue;
          }
          let input = {};
          try {
            input = JSON.parse(pt.args || '{}');
          } catch (error) {
            /*
             * 写到输出上限(`length`)或中途被掐断时没写完的那一个:不执行,把已经收到的参数原文交给 agent.mjs,
             * 由它从半截 JSON 里取出写了一半的字段存进代码块,让模型接着写(A07,2026-10-22 用户定)。
             * 不是截断引起的坏 JSON 照旧按参数错误报回模型。
             */
            if (finishReason === 'length' || cutNow) {
              yield { type: 'tool_use_partial', id: pt.id, name: pt.name, args: pt.args || '' };
              continue;
            }
            yield { type: 'tool_use', id: pt.id, name: pt.name, input: {}, inputError: `工具参数 JSON 不完整：${error.message}。请缩小批量或提高输出长度后重试。` };
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
             * 网关自动做的提示词缓存,命中量在这里。prompt_tokens 本身已经**含着**它
             * (实测 openlux:prompt_tokens 34057、cached_tokens 27877),所以 input 不用再加,
             * 这个数只拿来看命中率。不报这个字段的兼容接口就是 0。
             */
            cacheRead = Number(parsed.usage.prompt_tokens_details?.cached_tokens) || 0;
          }

          if (parsed.error) {
            const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || 'API 流返回错误');
            /*
             * 流已经出过数据之后来的 error(2026-10-22 实测 openlux:约 300 秒时来一条
             * 「The upstream stream ended before the response was complete.」,HTTP 仍是 200,没有 finish_reason):
             * 按截断收尾,不把已经写出的东西扔掉。还没出过数据的照旧抛错。
             */
            if (stopReason) break; // 已经正常收尾,后面来的错不影响这次回复
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

            // 各家兼容接口给推理过程起的名字不一样,常见这三个,取到哪个算哪个
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
        // 连接在流中途被断(网关掐断、对端关了连接):出过数据、还没收尾的按截断收尾;别的照旧抛
        if (!isCutReadError(err, signal) || (!started && !stopReason)) throw err;
        if (!stopReason) cut = { how: 'connection', detail: err?.message || String(err) };
      }

      if (!stopReason && !cut && started && !signal?.aborted) {
        // 流读完了却没有 finish_reason:同样是没写完
        cut = { how: 'no-finish', detail: '流在 finish_reason 之前结束' };
      }
      if (cut) {
        yield streamCutNotice('openai', cut.how, cut.detail, { pendingToolCalls: Object.keys(partialToolCalls).length });
        yield* emitToolCalls(null, true);
        stopReason = STREAM_CUT;
      }

      if (!stopReason) throw new Error('API 响应流提前结束或未返回 SSE 数据，请检查接口协议。');
      // 写到长度上限时没写完的工具调用已在上面 finish_reason 那一支交成 tool_use_partial;照常报 `length` 收尾,
      // 由 `agent.mjs` 存代码块、让模型接着写,连续截断超限再明说没做成。中途被掐断的以 `stream_cut` 收尾,做法相同。
      yield { type: 'usage', input: promptTokens, output: completionTokens, cacheRead };
      // 收尾:扣住的尾巴要放出来(可能是半个标签,也可能就是正常正文)
      for (const ev of think.flush()) {
        yield ev.kind === 'think'
          ? { type: 'thinking_delta', text: ev.text }
          : { type: 'text_delta', text: ev.text };
      }
      yield { type: 'stop', reason: stopReason || 'stop' };
    }
  };
}
