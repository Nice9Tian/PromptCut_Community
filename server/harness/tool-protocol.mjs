import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FENCE_OPEN = '```promptcut-tool';
const FENCE_CLOSE = '```';

/** s 的后缀里最长的、同时又是 marker 前缀的那一段有多长 */
function pendingPrefixLen(s, marker) {
  const max = Math.min(s.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

/**
 * 流式地把 ```promptcut-tool 围栏从要显示给用户的正文里摘掉。
 *
 * 为什么需要它:文本协议下模型是把工具调用**写在回复正文里**的,而正文是一个字
 * 一个字流给界面的。不过滤的话用户会看到围栏和裸 JSON —— markdown 还会把围栏
 * 渲成一个代码块,也就是聊天框里那条空的深色横条。
 *
 * 逐块喂进来,只吐「确定在围栏外面」的文字:
 * - 还没凑够、可能正在拼出围栏起始标记的那一小截先扣住(最多 16 个字符),
 *   等下一块到了再决定是放行还是吞掉。
 * - 围栏里面的一律不吐。
 * - 普通的 ``` 代码块不受影响:起始标记带 promptcut-tool,拼不出来就会被放行。
 *
 * 注意 collectedText 那边仍然要收**原文**,parseToolBlocks 靠围栏找工具调用。
 */
export function createFenceFilter() {
  let pending = '';
  let inside = false;

  return {
    push(delta) {
      pending += delta;
      let out = '';
      for (;;) {
        if (!inside) {
          const idx = pending.indexOf(FENCE_OPEN);
          if (idx >= 0) {
            out += pending.slice(0, idx);
            pending = pending.slice(idx + FENCE_OPEN.length);
            inside = true;
            continue;
          }
          const hold = pendingPrefixLen(pending, FENCE_OPEN);
          out += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
          return out;
        }
        const idx = pending.indexOf(FENCE_CLOSE);
        if (idx >= 0) {
          pending = pending.slice(idx + FENCE_CLOSE.length);
          inside = false;
          continue;
        }
        // 围栏里面的全丢,只留可能是收尾标记的那一两个反引号
        pending = pending.slice(pending.length - pendingPrefixLen(pending, FENCE_CLOSE));
        return out;
      }
    },
    /** 流结束时把扣住的尾巴放出来。围栏没收尾说明这块工具调用是残的,不显示 */
    flush() {
      if (inside) {
        pending = '';
        return '';
      }
      const rest = pending;
      pending = '';
      return rest;
    },
  };
}

export function parseToolBlocks(text) {
  const regex = /```promptcut-tool\s*([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const content = match[1].trim();
    try {
      const parsed = JSON.parse(content);
      blocks.push({
        name: parsed.name,
        input: parsed.input || {},
        raw
      });
    } catch (e) {
      blocks.push({
        error: `JSON 解析失败: ${e.message}`,
        raw
      });
    }
  }
  return blocks;
}

export function hasToolBlocks(text) {
  return /```promptcut-tool\s*([\s\S]*?)```/.test(text);
}

export async function executeToolBlocks(blocks, callTool) {
  const results = [];
  const { tools } = await import(new URL('../mcp-tools.mjs', import.meta.url).href);
  const toolNames = tools.map(t => t.name);

  for (const block of blocks) {
    if (block.error) {
      results.push({ name: block.name || 'unknown', ok: false, error: block.error });
      continue;
    }
    
    if (!toolNames.includes(block.name)) {
      results.push({ name: block.name, ok: false, error: `未注册的工具 ${block.name}` });
      continue;
    }
    
    try {
      const result = await callTool(block.name, block.input);
      let text = '';
      let files = undefined;
      
      if (typeof result === 'object' && result !== null) {
        if (Array.isArray(result.files)) {
          files = result.files.map(f => (typeof f === 'string' ? f : f.path)).filter(Boolean);
        }
        text = JSON.stringify(result, null, 2);
      } else {
        text = String(result);
      }
      
      results.push({ name: block.name, ok: true, text, files });
    } catch (e) {
      results.push({ name: block.name, ok: false, error: String(e) });
    }
  }
  return results;
}

export function formatResultsAsUserMessage(results) {
  let output = '工具执行结果：\n\n';
  for (const res of results) {
    if (res.ok) {
      const t = res.text ? res.text.substring(0, 4000) : '';
      output += `[工具 ${res.name} 执行成功]\n${t}\n\n`;
    } else {
      output += `[工具 ${res.name} 执行失败]\n${res.error}\n\n`;
    }
  }
  return output.trim();
}

export async function renderProtocolPrompt() {
  const mdPath = fileURLToPath(new URL('../ai-tool-protocol.md', import.meta.url));
  let md = fs.readFileSync(mdPath, 'utf-8');
  
  const { tools } = await import(new URL('../mcp-tools.mjs', import.meta.url).href);
  
  let toolsDesc = '';
  for (const t of tools) {
    toolsDesc += `### ${t.name}\n- 描述：${t.description}\n- 参数：${JSON.stringify(t.inputSchema)}\n\n`;
  }
  
  return md.replace('<!--TOOLS-->', toolsDesc.trim());
}

export function runTextProtocolLoop({ startRun, opts, onEvent }) {
  let currentOpts = { ...opts };
  
  currentOpts.mcp = undefined;
  /*
   * 文本协议这条路的轮次上限。常规 8 轮;「深度自主」开着时换成设置里的「自主轮次」
   * (opts.maxRounds),那个值为 0 就是不限 —— 这里变成 Infinity,循环没有终点,
   * 只有模型自己不再下达工具调用、出错、或者用户点停止才会出来。
   */
  const maxLoops = opts.deepAuto
    ? (opts.maxRounds === 0 ? Infinity : Number(opts.maxRounds) || 300)
    : 8;
  let loopCount = 0;
  let finalAbort = () => {};
  let aborted = false;
  
  const donePromise = new Promise(async (resolve, reject) => {
    try {
      const protocolPrompt = await renderProtocolPrompt();
      currentOpts.systemPrompt = currentOpts.systemPrompt + '\n\n' + protocolPrompt;
      
      while (loopCount < maxLoops) {
        if (aborted) { resolve(); return; }
        loopCount++;
        let collectedText = '';
        // 每一轮都是一条新的输出流,过滤器不能跨轮复用(上一轮的半截标记会串味)
        const fence = createFenceFilter();
        let lastSessionId = currentOpts.sessionId;
        let lastUsage = undefined;
        let runError = null;
        
        const run = startRun({
          ...currentOpts,
          onEvent: (ev) => {
            if (ev.type === 'text') {
              // 原文进 collectedText 供 parseToolBlocks 用;转发给界面的那份要把围栏摘掉。
              // 这里必须 return —— 以前漏了,text 又落进下面的 else 被原样转发出去,
              // 用户就在回复里看到了围栏和裸 JSON(markdown 还把它渲成一条空的深色代码块)。
              collectedText += ev.delta;
              const visible = fence.push(ev.delta);
              if (visible) onEvent({ ...ev, delta: visible });
              return;
            }
            if (ev.type === 'session' && ev.sessionId) {
              lastSessionId = ev.sessionId;
            }
            if (ev.type === 'done') {
              if (ev.sessionId) lastSessionId = ev.sessionId;
              if (ev.usage) lastUsage = ev.usage;
            } else if (ev.type === 'error') {
              runError = ev.message;
              onEvent(ev);
            } else {
              onEvent(ev);
            }
          }
        });
        
        finalAbort = run.abort;
        
        try {
          await run.done;
        } catch (e) {
          if (!runError) {
            runError = e.message || String(e);
            onEvent({ type: 'error', message: runError });
          }
        }

        // 流断了,把扣住的尾巴放出来(围栏没收尾的话这里会自己丢掉)
        if (aborted) { resolve(); return; }
        const tail = fence.flush();
        if (tail) onEvent({ type: 'text', delta: tail });
        
        if (runError) {
           resolve();
           return;
        }
        
        if (!hasToolBlocks(collectedText)) {
          onEvent({ type: 'done', sessionId: lastSessionId, usage: lastUsage });
          resolve();
          return;
        }
        
        const blocks = parseToolBlocks(collectedText);
        
        for (const b of blocks) {
           if (b.name) onEvent({ type: 'tool_call', name: b.name, input: b.input });
        }
        
        const results = await executeToolBlocks(blocks, opts.callTool);
        
        for (const res of results) {
           onEvent({ type: 'tool_result', name: res.name || 'unknown', ok: res.ok, summary: res.text || res.error, files: res.files });
        }
        
        const nextPrompt = formatResultsAsUserMessage(results);
        
        currentOpts.prompt = nextPrompt;
        currentOpts.sessionId = lastSessionId;
      }
      
      // 这句只发给界面,不进模型上下文 —— 深度自主要的是「模型看不见轮次」,
      // 不是「用户也看不见为什么停了」
      onEvent({ type: 'status', text: `文本协议已达 ${maxLoops} 轮上限` });
      onEvent({ type: 'done', sessionId: currentOpts.sessionId });
      resolve();
    } catch (e) {
      /*
       * 报一次就够了:这里已经把 error 发给界面了,再 reject 出去,
       * /api/ai/chat 那头 `await run.done` 的 catch 会把同一句话原样再写一条 SSE,
       * 用户看到的是一模一样的两行报错(诊断报告里就是这样)。
       * 发过了就当收尾处理,别让调用方以为还没人管。
       */
      onEvent({ type: 'error', message: String(e) });
      resolve();
    }
  });
  
  return {
    abort: () => { aborted = true; finalAbort(); },
    done: donePromise
  };
}
