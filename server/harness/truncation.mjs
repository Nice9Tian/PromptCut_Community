/**
 * 回复写到单次输出上限被截断时,把没写完的工具调用里已经写出来的内容存进代码块,并写好告诉模型怎么接着写的那段话
 * (A07,2026-10-22 用户定:「研究重试方法:是否可以把被截断的部分作为输入,让模型继续续写」)。
 *
 * 为什么不直接让模型「接着上一条回复往下写」:三家接口都不支持把一个**没写完的工具调用**交回去续写——
 * 历史里的 tool_use 必须是完整的 JSON 对象;Anthropic 的「预填 assistant」在 4.6 以后的型号上直接 400;
 * OpenAI 兼容口没有续写半截 tool_call 参数的写法。所以把写了一半的字段取出来放进代码块,让模型用 code_cache_append
 * 一段一段接着写,最后用 `@code_cache:名字` 交给原来那个工具。〔裁:output-cache 2026-10-22〕
 */
import { salvageToolCall, parsePartialObject } from './partial-json.mjs';

const fieldsOf = (args) => parsePartialObject(args ?? '').fields;
import { tailLines, validCodeCacheName, CODE_CACHE_REF } from '../tools/code-cache.mjs';

const DIRECT = new Set(['code_cache_append', 'code_cache_write']);
const short = (value, max) => { const s = JSON.stringify(value); return s.length > max ? `${s.slice(0, max)}…(rest omitted)` : s; };

/**
 * @param {Array<{ id?: string, name: string, args: string }>} partials 没写完的工具调用(provider 交的 tool_use_partial)
 * @param {ReturnType<import('../tools/code-cache.mjs').createCodeCacheStore> | null} store
 * @returns {{ progress: boolean, saved: Array<object>, note: string, status: string }}
 */
export function salvageTruncation(partials, store, { cause = 'length' } = {}) {
  const saved = [];
  const lines = [];
  /*
   * cause:'length' 写到单次输出上限;'cut' 流写到一半被网关中途掐断(stream_cut,2026-10-22 用户定按截断处理)。
   * 两种的做法相同,只是给模型和用户的话要说清是哪一种:被掐断不是写得太长超了上限,是这一次请求用的时间太长。
   */
  const cutWord = cause === 'cut' ? 'cut off by the gateway' : 'truncated';
  for (const p of partials || []) {
    const tool = String(p?.name || '') || '(tool with no name written)';
    const s = salvageToolCall(p?.args ?? '');
    if (!store) { lines.push(`Your call to ${tool} was not finished and was not executed.`); continue; }
    try {
      // 本来就在往代码块里写:写出来的那一截直接写进去
      // (按字段名取,不按「最长的字符串」取:块名可能比写出的那一截还长)
      const nameField = DIRECT.has(tool) ? fieldsOf(p?.args).find((f) => f.key === 'name' && f.complete) : null;
      const textField = nameField ? fieldsOf(p?.args).find((f) => f.key === 'text' && f.string) : null;
      if (nameField && validCodeCacheName(nameField.value) && textField?.value) {
        const name = nameField.value, text = textField.value;
        const r = tool === 'code_cache_write' ? store.write(name, text) : store.append(name, text);
        const tail = tailLines(store.read(name));
        saved.push({ tool, block: name, key: 'text', chars: text.length, direct: true });
        lines.push(`Your ${tool} (code block ${name}) was ${cutWord} partway through; the ${text.length} characters already written were ${tool === 'code_cache_write' ? 'saved into' : 'appended to'} code block ${name} (now ${r.lines} lines in total), ending with:\n${tail}\nUse code_cache_append to continue from where it broke off, do not repeat what was already written, and write less at a time.`);
        continue;
      }
      if (s.key && s.text) {
        const block = store.freshName(`cut_${tool}`);
        const r = store.write(block, s.text);
        const rest = Object.keys(s.rest).length ? `, other parameters unchanged: ${short(s.rest, 1500)}` : '';
        saved.push({ tool, block, key: s.key, chars: s.text.length, lines: r.lines });
        lines.push(`In your call to ${tool}, parameter ${s.key} was ${cutWord} at line ${r.lines} (${s.text.length} chars); this call was not executed. The ${s.key} already written was saved in code block ${block}, ending with:\n${tailLines(s.text)}\n` +
          `To continue: use code_cache_append (name set to "${block}") to write the remaining part from where it broke off, and do not repeat what was already written; keep each append short (within a few hundred lines), since anything too long will be truncated too.` +
          `After everything is written, call ${tool} again with parameter ${s.key} set to "${CODE_CACHE_REF}${block}"${rest}. If something is wrong, use code_cache_read / code_cache_replace to view and fix it.`);
        continue;
      }
      lines.push(`Your call to ${tool} was not finished, was not executed, and left no content that could be kept.`);
    } catch (error) {
      lines.push(`Your call to ${tool} was not finished and was not executed; the half-written content could not be saved into a code block: ${error?.message || error}`);
    }
  }
  const progress = saved.some((x) => x.chars > 0);
  const head = cause === 'cut'
    ? '(System) Your previous reply was cut off midway: the gateway closed the connection. (The gateway limits a single request to about 300 seconds, unrelated to the per-output limit: the longer you write at once, the more likely you hit it.)'
    : '(System) Your previous reply exceeded the per-output limit and was truncated.';
  const general = store
    ? `When writing a large block of code or long text, first write it into a code block in several steps (code_cache_write for the beginning, code_cache_append to continue), then reference it as a whole in the tool parameter by writing "${CODE_CACHE_REF}name".`
    : 'When writing a large block of code or long text, split it into several smaller tool calls.';
  const note = lines.length
    ? `${head}\n${lines.join('\n\n')}`
    : `${head}The tool call that was not finished was not executed. Do not repeat what was already written, just continue: ${general}`;
  const what = cause === 'cut' ? 'The model\'s reply was cut off midway by the gateway (the gateway limits the duration of a single request)' : 'The model\'s reply exceeded the per-output limit and was truncated';
  const status = saved.length
    ? `${what}; the half-written ${saved.map((x) => `${x.tool} (${x.chars} chars)`).join(', ')} was saved into code block ${saved.map((x) => x.block).join(', ')}, and the model has been told to continue.`
    : `${what}, and no action was executed; the model has been told to continue.`;
  return { progress, saved, note, status };
}
