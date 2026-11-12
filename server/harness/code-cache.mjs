/**
 * Code cache (A07): a set of named text chunks stored in a host-provided directory.
 *
 * The Agent operates on chunks via `code_cache_write`, `code_cache_append`, `code_cache_read`,
 * `code_cache_replace`, `code_cache_list`, and `code_cache_delete`. When any string argument of a
 * tool call is written entirely as `@code_cache:name`, the harness replaces it with that chunk's
 * content before invoking the tool (`resolveCodeCacheRefs`). When a model response hits the single-
 * output limit and is truncated, half-written tool arguments are salvaged into code blocks so the
 * model can continue appending on the next round.
 *
 * Storage layout: one `<name>.txt` file per chunk plus `index.json` recording each chunk's last
 * update timestamp and writer identifier.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CODE_CACHE_LIMITS = Object.freeze({
  /** Maximum bytes per chunk */
  blockBytes: 2 * 1024 * 1024,
  /** Maximum chunks per store */
  blocks: 64,
  /** Maximum total bytes across all chunks in a store */
  totalBytes: 16 * 1024 * 1024,
  /** Maximum characters returned by code_cache_read in a single call */
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
 *   writer: recorded in index.json as "who wrote it last" (chat id); empty if omitted
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
    return names().map((n) => { let text = ''; try { text = read(n); } catch { /* Just deleted */ } return { ...info(n, text), updatedAt: index[n]?.updatedAt ?? null, by: index[n]?.by ?? '' }; });
  };
  /** Generate an unused name: `<prefix>_1`, `<prefix>_2`… */
  const freshName = (prefix) => {
    const base = String(prefix || 'block').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '').slice(0, 56) || 'block';
    for (let n = 1; n < 10000; n += 1) { const name = `${base}_${n}`; if (!has(name)) return name; }
    throw coded('Cannot come up with a new code block name', 'code-cache-full');
  };
  return { dir, limits: lim, has, read, write, append, remove, list, info, freshName, withWriter: (w) => createCodeCacheStore({ dir, limits, now, writer: w }) };
}

/** Trailing lines (tells the model where writing left off) */
export function tailLines(text, n = 3, maxChars = 400) {
  const lines = String(text ?? '').split('\n');
  const tail = lines.slice(-n).join('\n');
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/**
 * Replaces all strings in tool arguments written entirely as `@code_cache:name` with that chunk's
 * content (performed by the harness before calling the tool).
 * Only recognizes "the entire string matches this pattern"; incidental occurrences in source code
 * are unaffected. Returns a new object without mutating original; returns as is if no references.
 * Throws an error if referenced chunk does not exist (tool is not executed, model sees the reason).
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

/** Six tools provided to the model (harness tool shape: name, description, inputSchema, execute) */
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
