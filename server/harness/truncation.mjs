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
const short = (value, max) => { const s = JSON.stringify(value); return s.length > max ? `${s.slice(0, max)}…(其余省略)` : s; };

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
  const cutWord = cause === 'cut' ? '被网关掐断' : '被截断';
  for (const p of partials || []) {
    const tool = String(p?.name || '') || '(没写出名字的工具)';
    const s = salvageToolCall(p?.args ?? '');
    if (!store) { lines.push(`你调用的 ${tool} 没写完,没有执行。`); continue; }
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
        lines.push(`你的 ${tool}(代码块 ${name})写到一半${cutWord};已经写出的 ${text.length} 字已经${tool === 'code_cache_write' ? '写进' : '接到'}代码块 ${name} 里(现在共 ${r.lines} 行),结尾是:\n${tail}\n用 code_cache_append 从断开的地方接着写,不要重复已经写过的内容;一次少写一点。`);
        continue;
      }
      if (s.key && s.text) {
        const block = store.freshName(`cut_${tool}`);
        const r = store.write(block, s.text);
        const rest = Object.keys(s.rest).length ? `,其它参数照原样:${short(s.rest, 1500)}` : '';
        saved.push({ tool, block, key: s.key, chars: s.text.length, lines: r.lines });
        lines.push(`你调用 ${tool} 时,参数 ${s.key} 写到第 ${r.lines} 行(${s.text.length} 字)${cutWord},这次调用没有执行。已经写出的 ${s.key} 存进了代码块 ${block},结尾是:\n${tailLines(s.text)}\n` +
          `接着写:用 code_cache_append(name 填 "${block}")从断开的地方接着写剩下的部分,不要重复已经写过的内容;一次追加不要太长(几百行以内),太长还会被截断。` +
          `全部写完后再调用 ${tool},参数 ${s.key} 写成 "${CODE_CACHE_REF}${block}"${rest}。写错了可以用 code_cache_read / code_cache_replace 看和改。`);
        continue;
      }
      lines.push(`你调用的 ${tool} 没写完,没有执行,也没有能留下来的内容。`);
    } catch (error) {
      lines.push(`你调用的 ${tool} 没写完,没有执行;写了一半的内容没能存进代码块:${error?.message || error}`);
    }
  }
  const progress = saved.some((x) => x.chars > 0);
  const head = cause === 'cut'
    ? '（系统）你上一条回复写到一半，连接被网关中途掐断了（网关对单次请求约有 300 秒的时长上限，和单次输出上限无关：一次写得越长越容易撞上）。'
    : '（系统）你上一条回复超过了单次输出上限，被截断了。';
  const general = store
    ? `要写大段代码或长文本时,先分几次写进代码块(code_cache_write 写开头、code_cache_append 接着写),最后在工具参数里整个写成 "${CODE_CACHE_REF}名字" 引用它。`
    : '要写大段代码或长文本时,拆成几次较小的工具调用。';
  const note = lines.length
    ? `${head}\n${lines.join('\n\n')}`
    : `${head}其中没写完的工具调用没有执行。不要重复已经写过的内容,直接接着做:${general}`;
  const what = cause === 'cut' ? '模型这次回复写到一半被网关中途掐断了（网关对单次请求有时长上限）' : '模型这次回复超过单次输出上限被截断了';
  const status = saved.length
    ? `${what}；写了一半的 ${saved.map((x) => `${x.tool}（${x.chars} 字）`).join('、')} 已存进代码块 ${saved.map((x) => x.block).join('、')}，已让它接着写。`
    : `${what}，没有执行任何操作；已让它接着做。`;
  return { progress, saved, note, status };
}
