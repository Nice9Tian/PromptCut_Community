// 对应 claude-quickstarts/agents/providers/base.py

/**
 * Provider 契约:
 * createProvider(cfg, { fetchImpl = globalThis.fetch } = {})
 * 返回 { name: string, stream: async function*(messages, tools, system, signal) }
 * 
 * stream 产出以下事件之一:
 * - { type: 'text_delta', text: string }
 * - { type: 'tool_use', id: string, name: string, input: object }
 * - { type: 'usage', input: number, output: number, cacheRead?: number }
 *   input 是这一轮完整的输入长度(含命中缓存的部分);cacheRead 是其中命中缓存的量,报得出来的家才有
 * - { type: 'stop', reason: string }
 * - { type: 'tool_use_partial', id, name, args: string }  写到输出上限时没写完的工具调用,args 是收到的参数原文(A07)
 * - { type: 'notice', stage: string, data: object }       给运行日志的提示(输出上限 400 降档、换字段、流被中途掐断)
 * - { type: 'response_open', sentAt: number }             响应头到了;sentAt 是最后一次真正发出请求的时刻(按速度设上限时算用时用)
 *
 * 停止原因 `stream_cut`(STREAM_CUT):流已经开始出数据之后、正常收尾之前断了 —— 流里来了 error 事件、连接被断、
 * 或者流读完却没有收尾标志。三家都按截断收尾:已经收到的文字照常交出,没写完的工具调用交成 tool_use_partial,
 * 由 agent.mjs 存代码块、让模型接着写(2026-10-22 用户定:「中途被网关掐断按截断处理(保住半截参数、走代码块续写)」)。
 * 还没收到任何数据就断的,照旧抛错。
 */

/** 停止原因:流在正常收尾之前被断了(多半是网关单次请求约 300 秒的上限,2026-10-22 实测) */
export const STREAM_CUT = 'stream_cut';

/**
 * 读流时抛的这个错,能不能当「中途被掐断」:用户点停止(signal 已中止)和我们自己的闲置超时(TimeoutError / AbortError)不算,
 * 照旧抛 —— 闲置超时是上游 120 秒不出字,有现成的续跑(runners/api.mjs 的 retryable),这次不改〔裁:stream-cut 2026-10-22〕。
 */
export function isCutReadError(err, signal) {
  if (signal?.aborted) return false;
  const name = err?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') return false;
  return true;
}

/** 掐断时交给运行日志的那条提示 */
export function streamCutNotice(vendor, how, detail, extra = {}) {
  return { type: 'notice', stage: 'stream-cut', data: { vendor, how, detail: String(detail || '').slice(0, 300), ...extra } };
}

/**
 * 创建 SSE 解析器。返回一个函数 feed(chunkString)，返回本次解析出的事件数组，元素形如 {event, data}。
 */
export function createSseParser() {
  let buffer = '';
  let currentEvent = null;
  let currentData = [];

  return function feed(chunkString) {
    const events = [];
    buffer += chunkString;
    
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      
      buffer = buffer.slice(lineEnd + 1);
      
      if (line === '') {
        if (currentEvent !== null || currentData.length > 0) {
           events.push({
             event: currentEvent || 'message',
             data: currentData.join('\n')
           });
           currentEvent = null;
           currentData = [];
        }
      } else if (line.startsWith(':')) {
        // 注释行，忽略
      } else {
        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
          const field = line.slice(0, colonIndex);
          let value = line.slice(colonIndex + 1);
          if (value.startsWith(' ')) {
            value = value.slice(1);
          }
          
          if (field === 'event') {
            currentEvent = value;
          } else if (field === 'data') {
            currentData.push(value);
          }
        }
      }
      
      lineEnd = buffer.indexOf('\n');
    }
    
    return events;
  };
}

/**
 * 增量解码 response.body，逐个 yield {event, data}
 */
export async function* readSse(response, { signal } = {}) {
  const parser = createSseParser();
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      if (signal?.aborted) break;
      const str = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      const evs = parser(str);
      for (const ev of evs) {
        yield ev;
      }
    }
    const finalEvs = parser(decoder.decode() + '\n\n');
    for (const ev of finalEvs) {
       yield ev;
    }
  } else if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        const evs = parser(decoder.decode(value, { stream: true }));
        for (const ev of evs) {
          yield ev;
        }
      }
      const finalEvs = parser(decoder.decode() + '\n\n');
      for (const ev of finalEvs) {
         yield ev;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * 断言 HTTP 响应为 2xx，否则抛出截断后的异常
 */
export async function assertOk(response, vendor) {
  if (response.ok) return;
  
  let text = '';
  try {
    text = await response.text();
  } catch {
    // ignore
  }
  
  let msg = '无 message 字段';
  if (text) {
    try {
      const body = JSON.parse(text);
      if (body?.error?.message) {
        msg = body.error.message;
      } else if (body?.message) {
        msg = body.message;
      } else if (Array.isArray(body) && body[0]?.error?.message) {
        msg = body[0].error.message;
      }
    } catch {
      // not json
    }
  }
  
  if (msg.length > 300) {
    msg = msg.substring(0, 300);
  }
  
  throw new Error(`${vendor} HTTP ${response.status}: ${msg}`);
}
