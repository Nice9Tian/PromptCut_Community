/**
 * 给 API 直连的请求加自动重试。
 *
 * # 起因
 *
 * 中转站在上游拥挤时会直接回:
 *
 *   openai HTTP 429: Current group upstream load is saturated, please try again later
 *
 * 这类错误是**临时的**,过几秒再发一次多半就成了。而现在一撞上就整条对话报错中断,
 * 用户看到的是一条红字,而不是稍等一下的结果。
 *
 * # 哪些码值得重试
 *
 * 照 openlux 文档的 HTTP Status Codes 那一页(doc.openlux.ai/en/tutorials/http-status-codes):
 *
 *   408 Timeout            "Shrink payload, retry, or use async APIs"
 *   429 Too Many Requests  "Back off; lower concurrency"
 *   500 Internal Error     "Retry later"
 *   502 / 503 / 504        "Exponential backoff; reduce concurrency at peak"
 *
 * 不重试的:400(参数错)、401(密钥错)、403(没权限 / 模型不在组里 / IP 不允许)、
 * 404(路径或任务 id 错)。这几个再发一百次也是同一个结果,重试只会拖慢报错、
 * 让用户更晚看到真正该改的东西。
 *
 * 网络层的异常(连接被重置、DNS 抽风、TLS 握手失败)也重试 —— 那和 502 是一回事。
 * 但 **AbortError 不重试**:那是用户点了停止、或者上层超时,重试等于不听话。
 *
 * # 为什么只包住「发请求」这一下,不包流
 *
 * 这些都是流式请求。重试**只在还没开始读流之前**是安全的:
 * 拿到错误状态码时一个字节的正文都还没交给上层,重发是干净的。
 * 而流读到一半断掉时再重发整个请求,模型会从头再说一遍,已经显示出去的那半段
 * 就重复了 —— 那种情况必须让它报错,由用户决定要不要重来。
 * 所以这个包装器只认「响应还没返回」和「响应返回了但状态码是可重试的」这两种。
 */

import { createSseParser } from './providers/base.mjs';
import { createThinkSplitter } from './think-tags.mjs';

/** 文档里写明可以重试的状态码 */
export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export const DEFAULT_RETRY = Object.freeze({
  /** 最多重试几次(不含第一次)。用户要求 10 */
  maxRetries: 10,
  /** 第一次退避多久 */
  baseDelayMs: 500,
  /** 单次退避的上限。指数涨上去之后就按这个走 */
  maxDelayMs: 8000,
  /**
   * 整个请求(含所有重试和等待)的总预算。
   *
   * 单次上游超时(如 openlux 网关 90~95s 返回 SSE upstream timed out,或本地 120s 闲置超时)
   * 约 90~120 秒;若只给 5 分钟,连续 4 次尝试(首次 + 3 次重试,累计约 380s)就会在第 3/10 次重试时
   * 被总预算提前截断。设为 20 分钟足以覆盖 maxRetries: 10 的完整退避重试,到点再把最后一次错误抛出去。
   */
  maxTotalMs: 20 * 60 * 1000,
});

/** 睡一会儿,期间可以被 abort 打断(用户点停止时不该还在傻等) */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * 区分「用户主动点停止」与「单次尝试内部闲置超时(TimeoutError)」。
 *
 * - 只要调用方传了外部 signal(opts.signal 或 init.signal),就只认外层 signal.aborted 这一个真凭据:
 *   withIdleTimeout 包在 createRetryingFetch 里面,单次尝试到点抛出的 TimeoutError / AbortError
 *   并不会让外部 signal.aborted 变真,应当作为可重试故障继续退避重试。
 * - 调用方没传外部 signal 时(如裸单测),TimeoutError 仍按超时重试,仅把非超时的 AbortError 当停止。
 */
function isUserAbort(e, externalSignal) {
  if (externalSignal) return Boolean(externalSignal.aborted);
  const msg = String(e?.message || '');
  if (e?.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(msg)) return false;
  return e?.name === 'AbortError' || /aborted|abort/i.test(msg);
}

/**
 * 从单条已解析的 SSE 事件里提取错误描述;不是错误事件就返回 null。
 */
export function extractSseError(event, parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (event !== 'error' && parsed.type !== 'error' && !parsed.error) return null;
  const raw = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const message = typeof parsed.error === 'string'
    ? parsed.error
    : (raw.message || parsed.message || 'API 流返回错误');
  const type = String(raw.type || parsed.type || '');
  const code = raw.code ?? parsed.code ?? null;
  const statusNum = Number(raw.status ?? raw.http_status ?? parsed.status ?? (typeof code === 'number' ? code : NaN));
  return {
    message: String(message),
    type,
    code,
    status: Number.isFinite(statusNum) ? statusNum : null,
  };
}

const NON_RETRYABLE_SSE_ERROR_RE =
  /invalid[_ -]?api[_ -]?key|incorrect[_ -]?api[_ -]?key|authentication[_ -]?error|unauthenticated|unauthorized|permission[_ -]?error|permission[_ -]?denied|forbidden|access denied|invalid[_ -]?argument|invalid[_ -]?request|bad[_ -]?request|unknown name|model[_ -]?not[_ -]?found|not[_ -]?found[_ -]?error|context[_ -]?length[_ -]?exceeded|maximum context length|insufficient[_ -]?quota|exceeded your current quota|credit balance is too low|out of credits|payment required|余额不足|配额已用尽/i;

const RETRYABLE_SSE_ERROR_RE =
  /timed?\s*out|timeout|overloaded|saturated|rate[_ -]?limit|too many requests|\b(408|429|500|502|503|504|529)\b|bad gateway|service unavailable|gateway timeout|internal[_ -]?(server[_ -]?)?error|server[_ -]?error|api[_ -]?error|upstream|try again( later)?|temporarily unavailable|connection reset|socket hang up|econnreset|etimedout|busy/i;

/**
 * 判断 SSE 流内首包之前的 error 事件是否属于可自动重试的临时故障。
 * 明确的参数错、鉴权错、模型不存在、账户配额耗尽一律不重试。
 */
export function isRetryableSseError(info) {
  if (!info) return false;
  const status = typeof info.status === 'number' ? info.status : null;
  if (status !== null && (status === 400 || status === 401 || status === 402 || status === 403 || status === 404 || status === 422)) {
    return false;
  }
  const combined = `${info.type || ''} ${info.code ?? ''} ${info.message || ''}`;
  if (NON_RETRYABLE_SSE_ERROR_RE.test(combined)) return false;
  if (status !== null && (RETRYABLE_STATUS.has(status) || status === 529)) return true;
  return RETRYABLE_SSE_ERROR_RE.test(combined);
}

function isSseStreamResponse(response) {
  if (!response?.ok || !response?.body) return false;
  if (typeof response.body[Symbol.asyncIterator] !== 'function' && typeof response.body.getReader !== 'function') {
    return false;
  }
  const ct = response.headers?.get?.('content-type') || '';
  if (!ct) return true;
  return /text\/event-stream/i.test(ct);
}

function toAsyncIterator(body) {
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const it = body[Symbol.asyncIterator]();
    return {
      next: () => it.next(),
      close: async () => { try { await it.return?.(); } catch {} },
    };
  }
  const reader = body.getReader();
  return {
    next: () => reader.read(),
    close: async () => {
      try { await reader.cancel?.(); } catch {}
      try { reader.releaseLock?.(); } catch {}
    },
  };
}

function rebuildResponse(response, bufferedChunks, remainingIter) {
  async function* replayedBody() {
    try {
      for (const chunk of bufferedChunks) {
        yield chunk;
      }
      if (remainingIter) {
        while (true) {
          const { done, value } = await remainingIter.next();
          if (done) break;
          yield value;
        }
      }
    } finally {
      if (remainingIter) {
        await remainingIter.close();
      }
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    text: typeof response.text === 'function' ? () => response.text() : async () => '',
    json: typeof response.json === 'function' ? () => response.json() : async () => ({}),
    body: replayedBody(),
  };
}

/**
 * 预读 HTTP 200 的 SSE 流,直到确认产出首个可向下游交付的内容块(text_delta / thinking_delta / tool_use)
 * 或正常收尾事件为止。
 *
 * - 若在产出任何内容块之前收到可重试的 SSE error 事件(如 openlux 网关 90s 后发的
 *   `The upstream service timed out. Please try again later.`)或空流意外结束,返回 `{ ok: false }` 触发重试;
 * - 若收到不可重试的 SSE error(如 invalid api key / invalid argument),返回 `{ ok: true }` 原样放行给下游立即报错;
 * - 一旦见到首个有效内容块,把已读到的原始 chunk 原样回放并拼接后续流,此后流中任何错误绝不重发。
 */
async function preflightSseResponse(response, userSignal) {
  const iter = toAsyncIterator(response.body);
  const bufferedChunks = [];
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const think = createThinkSplitter();
  const partialAnthropicTools = new Set();

  const inspectEvents = (evs) => {
    for (const { event, data } of evs) {
      if (!data || data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        // 非 JSON 的自定义流数据直接放行
        return { kind: 'content' };
      }
      const errInfo = extractSseError(event, parsed);
      if (errInfo) {
        if (isRetryableSseError(errInfo)) {
          return {
            kind: 'retryable_error',
            message: errInfo.message,
            reason: `SSE error: ${errInfo.message}`,
          };
        }
        return { kind: 'non_retryable_error' };
      }

      // Anthropic SSE 事件判定
      const anthType = event && event !== 'message' ? event : parsed?.type;
      if (
        anthType === 'ping' ||
        anthType === 'message_start' ||
        anthType === 'content_block_start' ||
        anthType === 'content_block_delta' ||
        anthType === 'content_block_stop' ||
        anthType === 'message_delta' ||
        anthType === 'message_stop'
      ) {
        if (anthType === 'content_block_start') {
          if (parsed?.content_block?.type === 'tool_use') {
            partialAnthropicTools.add(parsed.index);
          }
          continue;
        }
        if (anthType === 'content_block_delta') {
          if (
            (parsed?.delta?.type === 'text_delta' && parsed.delta.text) ||
            (parsed?.delta?.type === 'thinking_delta' && parsed.delta.thinking)
          ) {
            return { kind: 'content' };
          }
          continue;
        }
        if (anthType === 'content_block_stop') {
          if (partialAnthropicTools.has(parsed?.index)) {
            return { kind: 'content' };
          }
          continue;
        }
        if (anthType === 'message_stop' || (anthType === 'message_delta' && parsed?.delta?.stop_reason)) {
          return { kind: 'content' };
        }
        continue;
      }

      // OpenAI 兼容 SSE 事件判定
      if (Array.isArray(parsed?.choices)) {
        const choice = parsed.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (think.push(delta.content).length > 0) {
            return { kind: 'content' };
          }
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          return { kind: 'content' };
        }
        if (choice.finish_reason) {
          return { kind: 'content' };
        }
        continue;
      }
      if (parsed && typeof parsed === 'object' && 'usage' in parsed && !('choices' in parsed) && !('candidates' in parsed)) {
        continue;
      }

      // Gemini SSE 事件判定
      if (Array.isArray(parsed?.candidates)) {
        const cand = parsed.candidates[0];
        if (!cand) continue;
        const parts = cand.content?.parts;
        if (Array.isArray(parts) && parts.some((p) => p && (p.thought === true || p.text || p.functionCall))) {
          return { kind: 'content' };
        }
        if (cand.finishReason) {
          return { kind: 'content' };
        }
        continue;
      }
      if (parsed && typeof parsed === 'object' && 'usageMetadata' in parsed && !('candidates' in parsed)) {
        continue;
      }

      // 其它非空 JSON 事件按有效内容放行
      return { kind: 'content' };
    }
    return { kind: 'preamble' };
  };

  try {
    while (true) {
      if (userSignal?.aborted) {
        await iter.close();
        throw userSignal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      const { done, value } = await iter.next();
      if (done) {
        const tailEvs = parser(decoder.decode() + '\n\n');
        const tail = inspectEvents(tailEvs);
        await iter.close();
        if (tail.kind === 'content' || tail.kind === 'non_retryable_error') {
          return { ok: true, response: rebuildResponse(response, bufferedChunks, null) };
        }
        if (tail.kind === 'retryable_error') {
          return {
            ok: false,
            reason: tail.reason,
            error: new Error(tail.message),
            fallbackResponse: rebuildResponse(response, bufferedChunks, null),
          };
        }
        return {
          ok: false,
          reason: 'SSE stream ended before first content block',
          error: new Error('API 响应流提前结束或未返回 SSE 数据，请检查接口协议。'),
          fallbackResponse: rebuildResponse(response, bufferedChunks, null),
        };
      }

      bufferedChunks.push(value);
      const str = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      const step = inspectEvents(parser(str));
      if (step.kind === 'content' || step.kind === 'non_retryable_error') {
        return { ok: true, response: rebuildResponse(response, bufferedChunks, iter) };
      }
      if (step.kind === 'retryable_error') {
        await iter.close();
        return {
          ok: false,
          reason: step.reason,
          error: new Error(step.message),
          fallbackResponse: rebuildResponse(response, bufferedChunks, null),
        };
      }
    }
  } catch (e) {
    await iter.close();
    throw e;
  }
}

/**
 * 服务端说了「多久之后再来」就听它的。
 * `Retry-After` 可以是秒数,也可以是 HTTP 日期。给个上限,免得对方甩一个很大的值过来把我们挂死。
 */
function retryAfterMs(response, capMs) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, capMs);
}

/** 第 n 次重试等多久:指数退避 + 抖动。抖动是为了别让并发的几条请求在同一刻一起回来再撞一次 */
export function backoffMs(attempt, { baseDelayMs, maxDelayMs }, rand = Math.random) {
  const raw = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return Math.round(raw * (0.5 + rand() * 0.5));
}

/**
 * 把一个 fetch 包成会自动重试的。
 *
 * @param fetchImpl 真正发请求的那个(每次尝试都会重新调它 —— 里面通常会新建
 *                  per-attempt 的超时 signal,不能复用上一次那个已经烧掉的)
 * @param opts.signal   用户的停止信号。退避等待期间也听它
 * @param opts.onRetry  每次决定重试时回调 `{ attempt, status, delayMs, reason }`,用来打日志
 */
export function createRetryingFetch(fetchImpl, opts = {}) {
  const cfg = { ...DEFAULT_RETRY, ...opts };
  const { signal, onRetry, rand } = opts;

  return async function retryingFetch(url, init) {
    const startedAt = cfg.now ? cfg.now() : Date.now();
    const now = () => (cfg.now ? cfg.now() : Date.now());
    const userSignal = signal && init?.signal
      ? AbortSignal.any([signal, init.signal])
      : (signal || init?.signal);
    let lastError = null;

    for (let attempt = 0; ; attempt++) {
      let response = null;
      let sseFailure = null;
      try {
        response = await fetchImpl(url, init);
        if (response && !RETRYABLE_STATUS.has(response.status)) {
          if (isSseStreamResponse(response)) {
            const preflight = await preflightSseResponse(response, userSignal);
            if (preflight.ok) return preflight.response;
            sseFailure = preflight;
            lastError = preflight.error;
          } else {
            return response;
          }
        }
      } catch (e) {
        if (isUserAbort(e, userSignal)) throw e; // 用户主动喊停,不重试
        lastError = e;
        response = null;
      }

      const canRetry = attempt < cfg.maxRetries;
      const overBudget = now() - startedAt >= cfg.maxTotalMs;
      if (!canRetry || overBudget) {
        // 退不动了:有 SSE 预读失败的回放壳就交上去让 provider 照原样抛错;有 HTTP 错误响应就交 assertOk;否则抛最后那个异常
        if (sseFailure?.fallbackResponse) return sseFailure.fallbackResponse;
        if (response) return response;
        throw lastError;
      }

      const delay = (!sseFailure && response ? retryAfterMs(response, cfg.maxDelayMs) : null)
        ?? backoffMs(attempt, cfg, rand);

      // 错误响应的正文要消费掉,不然连接可能一直挂着不还给连接池
      if (response && !sseFailure) { try { await response.text(); } catch { /* 无所谓 */ } }

      onRetry?.({
        attempt: attempt + 1,
        of: cfg.maxRetries,
        status: response ? response.status : null,
        delayMs: delay,
        reason: sseFailure
          ? sseFailure.reason
          : (response ? `HTTP ${response.status}` : String(lastError?.message || lastError)),
      });

      await sleep(delay, userSignal);
    }
  };
}

