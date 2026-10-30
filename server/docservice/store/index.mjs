/**
 * 文档服务的日志存储：按 stream 追加 JSON 行、整条读回。契约见 `docs/plan/docservice-contract.md` 第 3 节。
 *
 * stream 是 `projects/<projectId>`、`content/<kind>` 这样的相对名：`<命名空间>/<名字>`。
 * 文件存储把它映射成 `<dir>/<命名空间>/<名字>.ndjson`：
 * - 名字里 `[A-Za-z0-9._-]` 原样保留，其余每个 UTF-8 字节写成 `%XX`（大写十六进制），`%` 本身也编码
 *   （契约第 10 节）。例：`a:b` → `a%3Ab.ndjson`；
 * - 名字后面总接 `.ndjson`，所以 `.`、`..` 也只是普通文件名，映射后的路径还要再核一次落在 `<dir>` 里。
 * 读和写用同一个映射。
 *
 * Windows 的文件名不分大小写：只差大小写的两个名字会落进同一个文件。所以每条记录都带自己的键
 * （`projectId`、`kind`），模块回放时按键过滤，不依赖「一个 stream 一个文件」。
 *
 * 写用 `appendFileSync`：一条记录一次同步写，顺序与调用顺序相同。进程在写到一半时崩掉，最后一行可能是半行：
 * 读的时候丢掉解析不了的行并记日志；本进程第一次往这个文件追加前，先看文件是不是以换行结尾，不是就先补一个换行，
 * 免得新记录接在半行后面一起坏掉。
 *
 * **整份文本**（M5b 的项目快照，`render-queue-contract.md` J.1）：`writeBlob(name, text)` / `readBlob(name)`。
 * `name` 是 `<命名空间>/<文件名>`，文件名由调用方先按上面的规则编码好（`fileNameOf`），存储层不再编码，
 * 只核对它只含 `[A-Za-z0-9._@%-]`、不全是点、映射后的路径落在 `<dir>` 里；不合格抛 TypeError。
 * 例：项目快照是 `projects/<fileNameOf(projectId)>@<projectRev>.json`。
 * 写入先写同目录下的临时文件、刷盘，再改名盖过目标，读的一方不会看到写了一半的文件。
 *
 * **整条重写**（C6.5 的项目操作日志截断）：`rewrite(stream, records)` 把一条 stream 整个换成给定的记录，
 * 同样先写临时文件再改名，读的一方要么看到旧的整条、要么看到新的整条。
 *
 * 只用 Node 内置模块（D2 守门覆盖 `server/docservice/`）。
 */
import fs from 'node:fs';
import path from 'node:path';

const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_NAME_LENGTH = 512;
const SAFE_CHAR = /^[A-Za-z0-9._-]$/;
/** 整份文本的文件名：调用方已编码，只许这些字符 */
const BLOB_FILE_RE = /^[A-Za-z0-9._@%-]{1,512}$/;

/** 缺省日志：一行一条 JSON，写 stdout */
function jsonLog(event, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

const hex = (ch) => [...Buffer.from(ch, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

/**
 * 名字 → 文件名（不含扩展名）：`[A-Za-z0-9._-]` 原样，其余每个 UTF-8 字节写成 `%XX`（大写十六进制），`%` 本身也编码。
 * 例：`a:b` → `a%3Ab`。直接拼 `a:b.ndjson` 的话，Windows 会把它写进文件 `a` 的备用数据流（文件夹里看不见，拷贝时丢）。
 */
export function fileNameOf(name) {
  let out = '';
  for (const ch of name) out += SAFE_CHAR.test(ch) ? ch : hex(ch);
  return out;
}

/** 拆 stream：`<命名空间>/<名字>`；不合法就抛 TypeError */
function parseStream(stream) {
  if (typeof stream !== 'string') throw new TypeError('stream 必须是字符串');
  const i = stream.indexOf('/');
  const ns = i > 0 ? stream.slice(0, i) : '';
  const name = i > 0 ? stream.slice(i + 1) : '';
  if (!NAMESPACE_RE.test(ns)) throw new TypeError(`stream 不合法：${JSON.stringify(stream)}`);
  if (name === '' || name.length > MAX_NAME_LENGTH || /[/\\\u0000]/.test(name)) {
    throw new TypeError(`stream 不合法：${JSON.stringify(stream)}`);
  }
  return { ns, name };
}

/** 拆整份文本的名字：`<命名空间>/<已编码的文件名>`；不合法就抛 TypeError */
function parseBlobName(name) {
  if (typeof name !== 'string') throw new TypeError('blob 名必须是字符串');
  const i = name.indexOf('/');
  const ns = i > 0 ? name.slice(0, i) : '';
  const file = i > 0 ? name.slice(i + 1) : '';
  if (!NAMESPACE_RE.test(ns) || !BLOB_FILE_RE.test(file) || /^\.+$/.test(file)) {
    throw new TypeError(`blob 名不合法：${JSON.stringify(name)}`);
  }
  return { ns, file };
}

function checkBlobText(text) {
  if (typeof text !== 'string') throw new TypeError('blob 内容必须是字符串');
}

let tmpSeq = 0;

/** 同步短等（存储接口是同步的，只在改名重试时用，最多一百来毫秒） */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 先写临时文件、刷盘，再改名盖过目标。Windows 上目标正被别人读时改名可能 EPERM / EBUSY，短暂重试几次 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${(tmpSeq += 1)}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
        pause(20 * (attempt + 1));
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能没建成 */ }
    throw err;
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 把文件内容拆成记录：空行跳过，解析不了的行（通常是崩溃留下的最后半行）丢掉并记日志 */
function parseLines(text, onBad) {
  const out = [];
  const lines = text.split('\n');
  const last = lines.length - 1;
  lines.forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      onBad(i, i === last, line.length);
      return;
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      onBad(i, i === last, line.length);
      return;
    }
    out.push(rec);
  });
  return out;
}

function serialize(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('record 必须是对象');
  return JSON.stringify(record);
}

/**
 * 文件存储：`<dir>/<命名空间>/<名字>.ndjson`，目录在第一次写时才建。
 * @param {object} options
 * @param {string} options.dir 根目录
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createFileStore({ dir, log = jsonLog } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createFileStore: dir 必须是非空字符串');
  const root = path.resolve(dir);
  /** 本进程已经确认过「以换行结尾」的文件 */
  const checked = new Set();

  function fileOf(stream) {
    const { ns, name } = parseStream(stream);
    const file = path.join(root, ns, `${fileNameOf(name)}.ndjson`);
    if (!inside(file, root)) throw new TypeError(`stream 不合法：${JSON.stringify(stream)}`);
    return file;
  }

  /** 文件存在且最后一个字节不是换行：返回 true（要先补换行） */
  function needsNewline(file) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
    try {
      const { size } = fs.fstatSync(fd);
      if (size === 0) return false;
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      return buf[0] !== 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  }

  function blobFileOf(name) {
    const { ns, file: base } = parseBlobName(name);
    const file = path.join(root, ns, base);
    if (!inside(file, root)) throw new TypeError(`blob 名不合法：${JSON.stringify(name)}`);
    return file;
  }

  return {
    append(stream, record) {
      const file = fileOf(stream);
      const line = serialize(record);
      let prefix = '';
      if (!checked.has(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (needsNewline(file)) {
          prefix = '\n';
          log('store.repair', { stream, reason: 'no-trailing-newline' });
        }
      }
      fs.appendFileSync(file, `${prefix}${line}\n`, 'utf8');
      checked.add(file);
    },

    /** 整条换成给定的记录（原子：临时文件 + 刷盘 + 改名）；记录为空时留一个空文件 */
    rewrite(stream, records) {
      const file = fileOf(stream);
      if (!Array.isArray(records)) throw new TypeError('records 必须是数组');
      const text = records.map((r) => `${serialize(r)}
`).join('');
      writeAtomic(file, text);
      checked.add(file);
    },

    read(stream) {
      const file = fileOf(stream);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return [];
        throw err;
      }
      return parseLines(text, (line, isLast, length) => {
        log('store.bad-line', { stream, line: line + 1, last: isLast, length });
      });
    },

    /** 整份写入（原子：临时文件 + 刷盘 + 改名） */
    writeBlob(name, text) {
      const file = blobFileOf(name);
      checkBlobText(text);
      writeAtomic(file, text);
    },

    /** 整份读回；没有就回 null */
    readBlob(name) {
      const file = blobFileOf(name);
      try {
        return fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

/** 内存存储：测试与不落盘的场合用。记录存成 JSON 文本，读回的是新对象，调用方改了也不影响存储 */
export function createMemoryStore() {
  /** stream → string[] */
  const streams = new Map();
  /** blob 名 → 文本 */
  const blobs = new Map();
  return {
    append(stream, record) {
      parseStream(stream);
      const line = serialize(record);
      let list = streams.get(stream);
      if (!list) streams.set(stream, (list = []));
      list.push(line);
    },
    read(stream) {
      parseStream(stream);
      return (streams.get(stream) ?? []).map((line) => JSON.parse(line));
    },
    rewrite(stream, records) {
      parseStream(stream);
      if (!Array.isArray(records)) throw new TypeError('records 必须是数组');
      streams.set(stream, records.map(serialize));
    },
    writeBlob(name, text) {
      parseBlobName(name);
      checkBlobText(text);
      blobs.set(name, text);
    },
    readBlob(name) {
      parseBlobName(name);
      return blobs.has(name) ? blobs.get(name) : null;
    },
  };
}
