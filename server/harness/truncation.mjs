/**
 * When a reply is truncated upon hitting the single-output limit, save the content already written
 * in the incomplete tool call into the code cache, and prepare instructions telling the model how
 * to continue writing (A07, user decision, 2026-10-22: "Investigate retry methods: whether the
 * truncated part can be used as input for the model to continue writing").
 *
 * Why not directly let the model "continue writing from the previous reply": none of the three
 * provider APIs support sending back an **incomplete tool call** for continuation: `tool_use` in
 * history must be a complete JSON object; Anthropic's "assistant prefill" returns 400 directly
 * on models after 4.6; OpenAI-compatible endpoints have no syntax for continuing partial
 * `tool_call` arguments. Therefore, extract the half-written field into the code cache, let the
 * model use `code_cache_append` to continue writing piece by piece, and finally pass it to the
 * original tool via `@code_cache:name`. [ruling: output-cache 2026-10-22]
 */
import { salvageToolCall, parsePartialObject } from './partial-json.mjs';

const fieldsOf = (args) => parsePartialObject(args ?? '').fields;
import { tailLines, validCodeCacheName, CODE_CACHE_REF } from './code-cache.mjs';

const DIRECT = new Set(['code_cache_append', 'code_cache_write']);
const short = (value, max) => { const s = JSON.stringify(value); return s.length > max ? `${s.slice(0, max)}…(rest omitted)` : s; };

/**
 * @param {Array<{ id?: string, name: string, args: string }>} partials Incomplete tool calls (tool_use_partial delivered by the provider)
 * @param {ReturnType<import('./code-cache.mjs').createCodeCacheStore> | null} store
 * @returns {{ progress: boolean, saved: Array<object>, note: string, status: string }}
 */
export function salvageTruncation(partials, store, { cause = 'length' } = {}) {
  const saved = [];
  const lines = [];
  /*
   * cause: 'length' hit the single-output limit; 'cut' stream cut off halfway by the gateway
   * (stream_cut, handled as truncation, user decision, 2026-10-22).
   * Both approaches work the same way, but the message to the model and user must clarify which one
   * occurred: being cut off is not because the output exceeded the limit, but because this request
   * took too long.
   */
  const cutWord = cause === 'cut' ? 'cut off by the gateway' : 'truncated';
  for (const p of partials || []) {
    const tool = String(p?.name || '') || '(tool with no name written)';
    const s = salvageToolCall(p?.args ?? '');
    if (!store) { lines.push(`Your call to ${tool} was not finished and was not executed.`); continue; }
    try {
      // Already writing into the code cache: write the emitted segment directly into it
      // (fetch by field name, not by "longest string": the cache name might be longer than the emitted segment)
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
          ` After everything is written, call ${tool} again with parameter ${s.key} set to "${CODE_CACHE_REF}${block}"${rest}. If something is wrong, use code_cache_read / code_cache_replace to view and fix it.`);
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
