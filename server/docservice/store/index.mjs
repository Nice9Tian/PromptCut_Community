/**
 * Document service log store: append JSON lines per stream, read back full streams. See contract
 * `docs/plan/docservice-contract.md` section 3.
 *
 * Streams are relative names like `projects/<projectId>` or `content/<kind>`: `<namespace>/<name>`.
 * File store maps them to `<dir>/<namespace>/<name>.ndjson`:
 * - Characters in `[A-Za-z0-9._-]` are kept as is; every other UTF-8 byte is written as `%XX`
 *   (uppercase hex), and `%` itself is also encoded (contract section 10).
 *   Example: `a:b` → `a%3Ab.ndjson`;
 * - Names always end with `.ndjson`, so `.` and `..` are just normal file names; the mapped path
 *   is checked once more to ensure it falls inside `<dir>`.
 * Reads and writes use the same mapping.
 *
 * Windows file names are case-insensitive: two names differing only in case fall into the same file.
 * Therefore, each record carries its own key (`projectId`, `kind`), and modules filter by key upon
 * replay, not relying on "one stream per file".
 *
 * Writing uses `appendFileSync`: one sync write per record, in invocation order. If the process
 * crashes mid-write, the last line may be partial: upon read, discard unparseable lines and log them;
 * before this process appends to this file for the first time, check if the file ends with a
 * newline; if not, add a newline first so new records do not append to and corrupt a partial line.
 *
 * **Whole text** (project snapshot in M5b, `render-queue-contract.md` J.1): `writeBlob(name, text)` /
 * `readBlob(name)`. `name` is `<namespace>/<filename>`, where the caller encodes the filename
 * beforehand per above rules (`fileNameOf`); the storage layer does not re-encode, only verifying
 * that it contains only `[A-Za-z0-9._@%-]`, is not all dots, and mapped path falls inside `<dir>`;
 * throws TypeError if invalid. Example: project snapshot is
 * `projects/<fileNameOf(projectId)>@<projectRev>.json`.
 * Writes first write to a temp file in the same directory, flush to disk, then rename over the target;
 * readers never see half-written files.
 *
 * **Full stream rewrite** (project operation log truncation in C6.5): `rewrite(stream, records)`
 * replaces an entire stream with given records, likewise writing to temp file first then renaming;
 * readers see either the old full stream or the new full stream.
 *
 * Uses Node built-in modules only (D2 gatekeeper covers `server/docservice/`).
 */
import fs from 'node:fs';
import path from 'node:path';

const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_NAME_LENGTH = 512;
const SAFE_CHAR = /^[A-Za-z0-9._-]$/;
/** Filename for whole text: caller already encoded, only these characters allowed */
const BLOB_FILE_RE = /^[A-Za-z0-9._@%-]{1,512}$/;

/** Default log: one JSON line per entry, writes to stdout */
function jsonLog(event, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

const hex = (ch) => [...Buffer.from(ch, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

/**
 * Name → filename (without extension): `[A-Za-z0-9._-]` as is, each other UTF-8 byte written as
 * `%XX` (uppercase hex), `%` itself is also encoded.
 * Example: `a:b` → `a%3Ab`. Concatenating directly as `a:b.ndjson` causes Windows to write it into
 * alternate data streams of file `a` (invisible in folders, lost on copy).
 */
export function fileNameOf(name) {
  let out = '';
  for (const ch of name) out += SAFE_CHAR.test(ch) ? ch : hex(ch);
  return out;
}

/** Split stream: `<namespace>/<name>`; throws TypeError if invalid */
function parseStream(stream) {
  if (typeof stream !== 'string') throw new TypeError('stream must be a string');
  const i = stream.indexOf('/');
  const ns = i > 0 ? stream.slice(0, i) : '';
  const name = i > 0 ? stream.slice(i + 1) : '';
  if (!NAMESPACE_RE.test(ns)) throw new TypeError(`Invalid stream: ${JSON.stringify(stream)}`);
  if (name === '' || name.length > MAX_NAME_LENGTH || /[/\\\u0000]/.test(name)) {
    throw new TypeError(`Invalid stream: ${JSON.stringify(stream)}`);
  }
  return { ns, name };
}

/** Split whole text name: `<namespace>/<encodedFilename>`; throws TypeError if invalid */
function parseBlobName(name) {
  if (typeof name !== 'string') throw new TypeError('blob name must be a string');
  const i = name.indexOf('/');
  const ns = i > 0 ? name.slice(0, i) : '';
  const file = i > 0 ? name.slice(i + 1) : '';
  if (!NAMESPACE_RE.test(ns) || !BLOB_FILE_RE.test(file) || /^\.+$/.test(file)) {
    throw new TypeError(`Invalid blob name: ${JSON.stringify(name)}`);
  }
  return { ns, file };
}

function checkBlobText(text) {
  if (typeof text !== 'string') throw new TypeError('blob content must be a string');
}

let tmpSeq = 0;

/** Synchronous short wait (storage interface is synchronous, used only on rename retries, ~100ms at most) */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write temp file first, flush, rename over target. On Windows, rename may hit EPERM / EBUSY if read by others; retry briefly */
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
    try { fs.unlinkSync(tmp); } catch { /* Temp file might not have been created */ }
    throw err;
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Split file into records: skip empty lines, drop unparseable lines (typically crash trailing partial line) and log */
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
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('record must be an object');
  return JSON.stringify(record);
}

/**
 * File store: `<dir>/<namespace>/<name>.ndjson`, directories created on first write.
 * @param {object} options
 * @param {string} options.dir Root directory
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createFileStore({ dir, log = jsonLog } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createFileStore: dir must be a non-empty string');
  const root = path.resolve(dir);
  /** Files confirmed by this process to end with a newline */
  const checked = new Set();

  function fileOf(stream) {
    const { ns, name } = parseStream(stream);
    const file = path.join(root, ns, `${fileNameOf(name)}.ndjson`);
    if (!inside(file, root)) throw new TypeError(`Invalid stream: ${JSON.stringify(stream)}`);
    return file;
  }

  /** File exists and last byte is not a newline: returns true (must append a newline first) */
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
    if (!inside(file, root)) throw new TypeError(`Invalid blob name: ${JSON.stringify(name)}`);
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

    /** Replace whole stream with given records (atomic: temp file + flush + rename); leaves empty file when records are empty */
    rewrite(stream, records) {
      const file = fileOf(stream);
      if (!Array.isArray(records)) throw new TypeError('records must be an array');
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

    /** Write whole file (atomic: temp file + flush + rename) */
    writeBlob(name, text) {
      const file = blobFileOf(name);
      checkBlobText(text);
      writeAtomic(file, text);
    },

    /** Read back whole file; returns null if missing */
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

/** In-memory store: for tests and non-disk use. Records stored as JSON text; reading returns new objects, isolating caller mutations */
export function createMemoryStore() {
  /** stream → string[] */
  const streams = new Map();
  /** Blob name → text */
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
      if (!Array.isArray(records)) throw new TypeError('records must be an array');
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
