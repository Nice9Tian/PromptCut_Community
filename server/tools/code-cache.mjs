/**
 * 代码块空间(A07,2026-10-22 用户定:「给项目一个代码块空间,让Agent可以对代码块进行操作比如read(code_cache)/replace(code_cache,xxx,yyy)」)。
 *
 * 按项目放的一组有名字的文本块。Agent 用 code_cache_write / append / read / replace / list / delete 操作它;
 * 任何工具的字符串参数整个写成 `@code_cache:名字` 时,harness 在调用那个工具之前把它换成代码块的内容(resolveCodeCacheRefs)。
 * 用途:大段源码分几次写进代码块,最后一次小调用交给 create_card / edit_card;回复写到输出上限被截断时,
 * 写了一半的参数由 harness/agent.mjs 存进代码块,模型接着追加。
 *
 * 存在哪〔裁:output-cache 2026-10-22〕:一个目录一个项目,一块一个文件 `<名字>.txt`,另有 `index.json` 记每块的
 * 更新时间与最后写它的对话。目录由宿主给:本机是编辑器工作目录下 `exports/ai-workspace/code-cache/<项目>`,
 * 云端账号模式是共用数据目录下 `tenants/<项目>/code-cache`(和这个项目的对话目录同级,各代任务进程都看得到);
 * 宿主没给时退回这个对话的历史文件旁边(只在这个对话里有效)。
 * 同一项目的几个对话共用一份:名字撞了会互相覆盖,截断时自动存的块名字带工具名和序号,不会撞。
 * 不进项目文档、不经文档服务:它是 Agent 的草稿,不是项目内容,不进撤销历史,也不同步给别的成员的页面。
 *
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';

export const CODE_CACHE_LIMITS = Object.freeze({
  /** 一块最大字节数 */
  blockBytes: 2 * 1024 * 1024,
  /** 一个项目最多几块 */
  blocks: 64,
  /** 一个项目所有块合计最大字节数 */
  totalBytes: 16 * 1024 * 1024,
  /** code_cache_read 一次最多交回的字数 */
  readChars: 60000,
});

export const CODE_CACHE_REF = '@code_cache:';
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const coded = (message, code) => Object.assign(new Error(message), { code });

export function validCodeCacheName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && name !== '.' && name !== '..' && !name.startsWith('.');
}

const lineCount = (text) => (text ? text.split('\n').length : 0);
const bytes = (text) => Buffer.byteLength(text, 'utf8');

/**
 * @param {{ dir: string, limits?: Partial<typeof CODE_CACHE_LIMITS>, now?: () => number, writer?: string }} o
 *   writer:记在 index.json 里「最后谁写的」(对话 id);不给就空
 */
export function createCodeCacheStore({ dir, limits = {}, now = () => Date.now(), writer = '' } = {}) {
  if (typeof dir !== 'string' || !dir) throw new Error('The code block space has no directory');
  const lim = { ...CODE_CACHE_LIMITS, ...limits };
  const fileOf = (name) => {
    if (!validCodeCacheName(name)) throw coded(`Invalid code block name: ${JSON.stringify(name)}. Only letters, digits, underscores, dots and hyphens are allowed, 1~64 characters, and it cannot start with a dot.`, 'code-cache-bad-name');
    return path.join(dir, `${name}.txt`);
  };
  const indexFile = path.join(dir, 'index.json');
  const ensure = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const readIndex = () => { try { const j = JSON.parse(fs.readFileSync(indexFile, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
  const touch = (name, removed = false) => {
    const index = readIndex();
    if (removed) delete index[name]; else index[name] = { updatedAt: new Date(now()).toISOString(), by: writer || '' };
    const tmp = `${indexFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(index), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, indexFile);
  };
  const names = () => {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).filter(validCodeCacheName).sort(); } catch { return []; }
  };
  const has = (name) => fs.existsSync(fileOf(name));
  const read = (name) => {
    const file = fileOf(name);
    try { return fs.readFileSync(file, 'utf8'); } catch { throw coded(`Code block ${name} does not exist. Use code_cache_list first to see which ones exist.`, 'code-cache-missing'); }
  };
  const totalBytes = (except = '') => names().filter((n) => n !== except).reduce((sum, n) => { try { return sum + fs.statSync(fileOf(n)).size; } catch { return sum; } }, 0);
  const checkRoom = (name, nextText) => {
    const size = bytes(nextText);
    if (size > lim.blockBytes) throw coded(`Code block ${name} would be ${size} bytes, over the per-block limit of ${lim.blockBytes} bytes. Split it into several blocks, or delete content you do not need.`, 'code-cache-too-large');
    if (!has(name) && names().length >= lim.blocks) throw coded(`There are already ${lim.blocks} code blocks, which is the limit. Use code_cache_delete first to delete unused ones.`, 'code-cache-full');
    if (totalBytes(name) + size > lim.totalBytes) throw coded(`The code blocks of this project would total more than ${lim.totalBytes} bytes. Delete unused blocks first.`, 'code-cache-full');
  };
  const write = (name, text) => {
    const file = fileOf(name);
    const value = String(text ?? '');
    checkRoom(name, value);
    ensure();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    touch(name);
    return info(name, value);
  };
  const append = (name, text) => {
    const before = has(name) ? read(name) : '';
    return write(name, before + String(text ?? ''));
  };
  const remove = (name) => {
    const file = fileOf(name);
    if (!fs.existsSync(file)) throw coded(`Code block ${name} does not exist.`, 'code-cache-missing');
    fs.rmSync(file, { force: true });
    touch(name, true);
    return { name, deleted: true };
  };
  const info = (name, text) => ({ name, chars: text.length, lines: lineCount(text), bytes: bytes(text) });
  const list = () => {
    const index = readIndex();
    return names().map((n) => { let text = ''; try { text = read(n); } catch { /* 刚被删 */ } return { ...info(n, text), updatedAt: index[n]?.updatedAt ?? null, by: index[n]?.by ?? '' }; });
  };
  /** 起一个还没用过的名字:`<prefix>_1`、`<prefix>_2`…… */
  const freshName = (prefix) => {
    const base = String(prefix || 'block').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '').slice(0, 56) || 'block';
    for (let n = 1; n < 10000; n += 1) { const name = `${base}_${n}`; if (!has(name)) return name; }
    throw coded('Cannot come up with a new code block name', 'code-cache-full');
  };
  return { dir, limits: lim, has, read, write, append, remove, list, info, freshName, withWriter: (w) => createCodeCacheStore({ dir, limits, now, writer: w }) };
}

/** 尾巴几行(告诉模型写到哪了) */
export function tailLines(text, n = 3, maxChars = 400) {
  const lines = String(text ?? '').split('\n');
  const tail = lines.slice(-n).join('\n');
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/**
 * 工具参数里所有整个写成 `@code_cache:名字` 的字符串换成那块的内容(在调用工具之前,harness 做)。
 * 只认「整个字符串就是这个写法」,源码里顺带出现的这几个字不受影响。返回新对象,不改原来的;没有引用时原样返回。
 * 引用的块不存在时抛错(工具不执行,模型看得到原因)。
 */
export function resolveCodeCacheRefs(input, store) {
  if (!store) return input;
  let used = false;
  const walk = (v, depth) => {
    if (typeof v === 'string') {
      if (!v.startsWith(CODE_CACHE_REF)) return v;
      const name = v.slice(CODE_CACHE_REF.length).trim();
      if (!validCodeCacheName(name)) return v;
      used = true;
      return store.read(name);
    }
    if (!v || typeof v !== 'object' || depth > 8) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  const out = walk(input, 0);
  return used ? out : input;
}

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

/** 交给模型的六个工具(harness 工具的形状:name、description、inputSchema、execute) */
export function codeCacheTools(store) {
  const lim = store.limits;
  return [
    {
      name: 'code_cache_write',
      description: `Create a new code block, or replace an existing one entirely. Code blocks are this project's scratch area: when writing very long source code or text, first write it into a code block in several passes (this tool writes the beginning, code_cache_append continues), then in the string argument of any tool write the whole thing as "${CODE_CACHE_REF}name"; it is replaced with the code block content before the call (for example, write "${CODE_CACHE_REF}my_card" for the source of create_card). At most ${lim.blockBytes} bytes per block.`,
      inputSchema: { type: 'object', properties: { name: str('Code block name: letters, digits, underscores, dots, hyphens, 1~64 characters'), text: str('Content') }, required: ['name', 'text'] },
      async execute(input) { return { ok: true, ...store.write(input.name, input.text) }; },
    },
    {
      name: 'code_cache_append',
      description: 'Append a piece of text to the end of a code block (creates the block if it does not exist). Use it to write long source code in several passes, or to continue after a reply was truncated; continue from where it broke off, do not repeat what has already been written, and do not add anything other than newlines yourself.',
      inputSchema: { type: 'object', properties: { name: str('Code block name'), text: str('Content to append') }, required: ['name', 'text'] },
      async execute(input) {
        const r = store.append(input.name, input.text);
        return { ok: true, ...r, tail: tailLines(store.read(input.name)) };
      },
    },
    {
      name: 'code_cache_read',
      description: `Read a code block. You can read a range by line (startLine, endLine, counted from 1, both inclusive) or by character (start, end, counted from 0, end exclusive); if you give neither, it reads from the beginning and returns at most ${lim.readChars} characters at a time. If it is not finished, it tells you where the next range starts.`,
      inputSchema: { type: 'object', properties: { name: str('Code block name'), startLine: int('Line to start from (counted from 1)'), endLine: int('Line to read up to (inclusive)'), start: int('Character to start from (counted from 0)'), end: int('Character to read up to (exclusive)') }, required: ['name'] },
      async execute(input) {
        const text = store.read(input.name);
        const total = { chars: text.length, lines: lineCount(text) };
        if (input.startLine !== undefined || input.endLine !== undefined) {
          const lines = text.split('\n');
          const from = Math.max(1, Number(input.startLine) || 1);
          const to = Math.min(lines.length, Number(input.endLine) || lines.length);
          let body = lines.slice(from - 1, to).join('\n');
          let more = null;
          if (body.length > lim.readChars) { body = body.slice(0, lim.readChars); more = 'This range is too long, so only the first part was returned; narrow the line range and read again.'; }
          return { ok: true, name: input.name, ...total, startLine: from, endLine: to, text: body, ...(more ? { more } : {}) };
        }
        const from = Math.max(0, Number(input.start) || 0);
        const wanted = input.end !== undefined ? Math.min(text.length, Number(input.end)) : text.length;
        const to = Math.min(wanted, from + lim.readChars);
        return { ok: true, name: input.name, ...total, start: from, end: to, text: text.slice(from, to), ...(to < wanted ? { more: `Not finished, next range starts at start=${to}` } : {}) };
      },
    },
    {
      name: 'code_cache_replace',
      description: 'Replace one piece of text with another in a code block. old must match the original text in the code block exactly; it is replaced only if it occurs once. If it occurs multiple times, either make old longer so it is unique, or pass all: true to replace all of them.',
      inputSchema: { type: 'object', properties: { name: str('Code block name'), old: str('Original text (exact match)'), new: str('What to replace it with'), all: { type: 'boolean', description: 'Replace all when it occurs multiple times' } }, required: ['name', 'old', 'new'] },
      async execute(input) {
        const text = store.read(input.name);
        const oldStr = String(input.old ?? '');
        if (!oldStr) throw coded('old cannot be empty.', 'code-cache-bad-replace');
        const count = text.split(oldStr).length - 1;
        if (count === 0) throw coded(`Could not find the original text old in code block ${input.name}. Use code_cache_read to look at the original text first, and make sure spaces and line breaks match.`, 'code-cache-not-found');
        if (count > 1 && input.all !== true) throw coded(`old occurs ${count} times in code block ${input.name}. Make old longer so it is unique, or pass all: true to replace all of them.`, 'code-cache-ambiguous');
        const r = store.write(input.name, text.split(oldStr).join(String(input.new ?? '')));
        return { ok: true, ...r, replaced: input.all === true ? count : 1 };
      },
    },
    {
      name: 'code_cache_list',
      description: 'List all code blocks in this project: name, character count, line count, last update time, and the chat that last wrote it.',
      inputSchema: { type: 'object', properties: {} },
      async execute() { return { ok: true, blocks: store.list(), ref: `Write the whole value in tool arguments as "${CODE_CACHE_REF}name" to use the content of a code block` }; },
    },
    {
      name: 'code_cache_delete',
      description: 'Delete a code block (when it is used up and no longer needed).',
      inputSchema: { type: 'object', properties: { name: str('Code block name') }, required: ['name'] },
      async execute(input) { return { ok: true, ...store.remove(input.name) }; },
    },
  ];
}

export const CODE_CACHE_TOOL_NAMES = Object.freeze(['code_cache_write', 'code_cache_append', 'code_cache_read', 'code_cache_replace', 'code_cache_list', 'code_cache_delete']);
