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
  if (typeof dir !== 'string' || !dir) throw new Error('代码块空间没有目录');
  const lim = { ...CODE_CACHE_LIMITS, ...limits };
  const fileOf = (name) => {
    if (!validCodeCacheName(name)) throw coded(`代码块名字不合法:${JSON.stringify(name)}。只能用字母、数字、下划线、点和连字符,1～64 个字符,不能以点开头。`, 'code-cache-bad-name');
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
    try { return fs.readFileSync(file, 'utf8'); } catch { throw coded(`代码块 ${name} 不存在。先用 code_cache_list 看有哪些。`, 'code-cache-missing'); }
  };
  const totalBytes = (except = '') => names().filter((n) => n !== except).reduce((sum, n) => { try { return sum + fs.statSync(fileOf(n)).size; } catch { return sum; } }, 0);
  const checkRoom = (name, nextText) => {
    const size = bytes(nextText);
    if (size > lim.blockBytes) throw coded(`代码块 ${name} 会有 ${size} 字节,超过一块的上限 ${lim.blockBytes} 字节。拆成几块,或者删掉不用的内容。`, 'code-cache-too-large');
    if (!has(name) && names().length >= lim.blocks) throw coded(`代码块已经有 ${lim.blocks} 块,到上限了。先用 code_cache_delete 删掉不用的。`, 'code-cache-full');
    if (totalBytes(name) + size > lim.totalBytes) throw coded(`这个项目的代码块合计会超过 ${lim.totalBytes} 字节。先删掉不用的块。`, 'code-cache-full');
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
    if (!fs.existsSync(file)) throw coded(`代码块 ${name} 不存在。`, 'code-cache-missing');
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
    throw coded('起不出新的代码块名字', 'code-cache-full');
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
      description: `新建一个代码块,或者把已有的整个换掉。代码块是这个项目的草稿区:写很长的源码或文本时,先分几次写进代码块(这个工具写开头,code_cache_append 接着写),最后在任何工具的字符串参数里整个写成 "${CODE_CACHE_REF}名字",调用前会被换成代码块的内容(比如 create_card 的 source 写 "${CODE_CACHE_REF}my_card")。一块最多 ${lim.blockBytes} 字节。`,
      inputSchema: { type: 'object', properties: { name: str('代码块名字:字母、数字、下划线、点、连字符,1～64 个字符'), text: str('内容') }, required: ['name', 'text'] },
      async execute(input) { return { ok: true, ...store.write(input.name, input.text) }; },
    },
    {
      name: 'code_cache_append',
      description: '把一段文本接在代码块末尾(代码块不存在就新建)。分几次写长源码、或者回复被截断后接着写时用;从断开的地方接着写,不要重复已经写过的内容,也不要自己补换行以外的东西。',
      inputSchema: { type: 'object', properties: { name: str('代码块名字'), text: str('要接上的内容') }, required: ['name', 'text'] },
      async execute(input) {
        const r = store.append(input.name, input.text);
        return { ok: true, ...r, tail: tailLines(store.read(input.name)) };
      },
    },
    {
      name: 'code_cache_read',
      description: `读代码块。可以按行(startLine、endLine,从 1 数,含两端)或按字符(start、end,从 0 数,不含 end)读一段;都不给就从头读,一次最多交回 ${lim.readChars} 字,没读完会告诉你下一段从哪开始。`,
      inputSchema: { type: 'object', properties: { name: str('代码块名字'), startLine: int('从第几行开始(从 1 数)'), endLine: int('读到第几行(含)'), start: int('从第几个字符开始(从 0 数)'), end: int('读到第几个字符(不含)') }, required: ['name'] },
      async execute(input) {
        const text = store.read(input.name);
        const total = { chars: text.length, lines: lineCount(text) };
        if (input.startLine !== undefined || input.endLine !== undefined) {
          const lines = text.split('\n');
          const from = Math.max(1, Number(input.startLine) || 1);
          const to = Math.min(lines.length, Number(input.endLine) || lines.length);
          let body = lines.slice(from - 1, to).join('\n');
          let more = null;
          if (body.length > lim.readChars) { body = body.slice(0, lim.readChars); more = '这一段太长,只交回了前面一部分;缩小行范围再读。'; }
          return { ok: true, name: input.name, ...total, startLine: from, endLine: to, text: body, ...(more ? { more } : {}) };
        }
        const from = Math.max(0, Number(input.start) || 0);
        const wanted = input.end !== undefined ? Math.min(text.length, Number(input.end)) : text.length;
        const to = Math.min(wanted, from + lim.readChars);
        return { ok: true, name: input.name, ...total, start: from, end: to, text: text.slice(from, to), ...(to < wanted ? { more: `没读完,下一段从 start=${to} 开始` } : {}) };
      },
    },
    {
      name: 'code_cache_replace',
      description: '在代码块里把一段文字换成另一段。old 要和代码块里的原文逐字相同;只出现一次才换,出现多次时要么把 old 写长一点让它唯一,要么给 all: true 全部换。',
      inputSchema: { type: 'object', properties: { name: str('代码块名字'), old: str('原文(逐字相同)'), new: str('换成什么'), all: { type: 'boolean', description: '出现多次时全部换' } }, required: ['name', 'old', 'new'] },
      async execute(input) {
        const text = store.read(input.name);
        const oldStr = String(input.old ?? '');
        if (!oldStr) throw coded('old 不能是空的。', 'code-cache-bad-replace');
        const count = text.split(oldStr).length - 1;
        if (count === 0) throw coded(`代码块 ${input.name} 里没有找到 old 这段原文。先用 code_cache_read 看一下原文,注意空格和换行要一致。`, 'code-cache-not-found');
        if (count > 1 && input.all !== true) throw coded(`old 在代码块 ${input.name} 里出现了 ${count} 次。把 old 写长一点让它唯一,或者给 all: true 全部换。`, 'code-cache-ambiguous');
        const r = store.write(input.name, text.split(oldStr).join(String(input.new ?? '')));
        return { ok: true, ...r, replaced: input.all === true ? count : 1 };
      },
    },
    {
      name: 'code_cache_list',
      description: '列出这个项目里所有代码块:名字、字数、行数、最后更新时间和最后写它的对话。',
      inputSchema: { type: 'object', properties: {} },
      async execute() { return { ok: true, blocks: store.list(), ref: `在工具参数里整个写成 "${CODE_CACHE_REF}名字" 就能用代码块的内容` }; },
    },
    {
      name: 'code_cache_delete',
      description: '删掉一个代码块(用完了、不再需要时)。',
      inputSchema: { type: 'object', properties: { name: str('代码块名字') }, required: ['name'] },
      async execute(input) { return { ok: true, ...store.remove(input.name) }; },
    },
  ];
}

export const CODE_CACHE_TOOL_NAMES = Object.freeze(['code_cache_write', 'code_cache_append', 'code_cache_read', 'code_cache_replace', 'code_cache_list', 'code_cache_delete']);
