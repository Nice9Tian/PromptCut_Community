// 测试用的 provider(模拟模型提供方)。`ai.json` 或 `opts.apiConfig` 里 `vendor: 'mock'` 时启用,不需要 Key。
//
// 两种走法:
//   - 没有脚本:写死的两回合(调一次工具、说一句话),与原来相同;
//   - 有脚本:用户消息里出现一个 ```mock-script 代码块(JSON 数组)时,逐回合照它做
//     (契约 docs/plan/cloud-agent-contract.md 第 8.3 节)。每一项是下面四种之一:
//       { "tool": "<工具名>", "input": { … } }   这一回合调这个工具
//       { "say": "<文字>" }                       说这句话并结束这一轮
//       { "sleepMs": 300 }                        等这么久再做下一项(测停止与并发;认中止信号)
//       { "fail": "<原因>" }                      这一次模型请求报错
//       { "truncate": { "tool", "args", "say" } } 这一回合写到输出上限被截断(见下面那一支)
//       { "cut": { "tool", "args", "say" } }      这一回合写到一半被网关中途掐断(停止原因 stream_cut,其余同 truncate)
//     脚本走完还没有 say 的,补一句「完成。」结束。每个回合报一次 usage(按字符数算的确定值)。
//     一轮对话里有多个脚本块时用最近一条用户消息里的那个。

const SCRIPT_RE = /```mock-script\s*\n([\s\S]*?)```/g;

/** 从消息历史里找最近一条用户文字里的脚本;没有回 null */
export function mockScriptOf(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const texts = typeof m.content === 'string' ? [m.content] : (Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text) : []);
    for (let j = texts.length - 1; j >= 0; j -= 1) {
      const all = [...String(texts[j] ?? '').matchAll(SCRIPT_RE)];
      if (!all.length) continue;
      try {
        const steps = JSON.parse(all[all.length - 1][1]);
        return Array.isArray(steps) ? steps : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const sizeOf = (v) => { try { return JSON.stringify(v).length; } catch { return 0; } };

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function createProvider(cfg) {
  let turn = 0;
  /** 脚本模式:下一项的下标;脚本在第一次请求时定下 */
  let script;
  let at = 0;

  return {
    name: 'mock',
    async *stream(messages, _tools, _system, signal) {
      if (script === undefined) script = mockScriptOf(messages);
      if (script) {
        const usage = { type: 'usage', input: Math.ceil(sizeOf(messages) / 4), output: 0 };
        while (at < script.length) {
          const step = script[at] ?? {};
          at += 1;
          if (Number.isFinite(step.sleepMs)) { await sleep(Math.max(0, Math.min(60_000, step.sleepMs)), signal); continue; }
          // `{{apiKey}}`、`{{baseUrl}}` 换成配置里的值:测「模型接口的报错里带着 Key 与地址」时用,免得把它们写进提示词
          if (typeof step.fail === 'string') throw new Error(step.fail.replaceAll('{{apiKey}}', String(cfg?.apiKey ?? '')).replaceAll('{{baseUrl}}', String(cfg?.baseUrl ?? '')));
          if (typeof step.tool === 'string') {
            const input = step.input && typeof step.input === 'object' ? step.input : {};
            yield { type: 'tool_use', id: `mock_${at}`, name: step.tool, input };
            yield { ...usage, output: Math.ceil(sizeOf(input) / 4) + 8 };
            yield { type: 'stop', reason: 'tool_use' };
            return;
          }
          /*
           * 写到输出上限被截断(A07):`{ "truncate": { "tool": "create_card", "args": "{\"source\":\"写了一半" }, "say"?: "…" }`
           * 交一个没写完的工具调用(参数原文就是 args)、以 `length` 收尾;不给 tool 时只交 say 的文字、以 `length` 收尾。
           */
          const cutStep = step.truncate && typeof step.truncate === 'object' ? step.truncate : (step.cut && typeof step.cut === 'object' ? step.cut : null);
          if (cutStep) {
            if (typeof cutStep.say === 'string') yield { type: 'text_delta', text: cutStep.say };
            if (typeof cutStep.tool === 'string') yield { type: 'tool_use_partial', id: `mock_${at}`, name: cutStep.tool, args: String(cutStep.args ?? '') };
            yield { ...usage, output: Math.ceil(String(cutStep.args ?? '').length / 4) + 8 };
            // 被网关中途掐断(stream-cut,2026-10-22):停止原因 stream_cut,agent.mjs 按截断处理
            yield { type: 'stop', reason: cutStep === step.truncate ? 'length' : 'stream_cut' };
            return;
          }
          if (typeof step.say === 'string') {
            yield { type: 'text_delta', text: step.say };
            yield { ...usage, output: Math.ceil(step.say.length / 2) + 1 };
            yield { type: 'stop', reason: 'end_turn' };
            return;
          }
        }
        yield { type: 'text_delta', text: '完成。' };
        yield { ...usage, output: 2 };
        yield { type: 'stop', reason: 'end_turn' };
        return;
      }

      turn++;
      if (turn === 1) {
        yield { type: 'tool_use', id: 'call_1', name: cfg?.toolName || 'get_editor_state', input: {} };
        yield { type: 'stop', reason: 'tool_use' };
      } else if (turn === 2) {
        const text = cfg?.finalText || '时间轴上有 2 张卡。';
        const mid = Math.floor(text.length / 2);
        yield { type: 'text_delta', text: text.slice(0, mid) };
        yield { type: 'text_delta', text: text.slice(mid) };
        yield { type: 'usage', input: 10, output: 20 };
        yield { type: 'stop', reason: 'end_turn' };
      } else {
        yield { type: 'text_delta', text: '没别的事了。' };
        yield { type: 'stop', reason: 'end_turn' };
      }
    }
  };
}
