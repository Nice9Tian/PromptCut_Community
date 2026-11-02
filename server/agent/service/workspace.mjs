/**
 * Cloud Agent workspace: local directory isolated by "project × chat" (task brief
 * `docs/plan/cloud-agent-task.md` J; contract Section 9.5 in `docs/plan/cloud-agent-contract.md`).
 *
 * In hosted tier, all tools that read or write local files (attachments, downloads, intermediate
 * files for perception tools, voiceover outputs, etc.) fall strictly under:
 *
 *   <data directory>/work/<project id>/<owner key>/<chat id>/
 *
 * and paths are provided and verified here:
 *
 *   - Relative paths provided by tools literally reject absolute paths, Windows drive letters,
 *     UNC, `..`, NUL, and device names first; then resolve and verify they fall within the chat
 *     directory; then take the realpath of the **deepest existing layer** (following symlinks and
 *     junctions), verifying it remains within the realpath of the chat directory: so if a link
 *     pointing outside is placed inside the directory, reading and writing through it is likewise
 *     rejected;
 *   - Writes count toward total size limits at both chat and project levels; writes exceeding the
 *     limit are rejected;
 *   - When a chat or project is deleted, the entire tree is deleted;
 *   - Subprocesses (Python, ffmpeg, downloaders) are spawned only via `spawn()`: working
 *     directory is the chat directory; environment variables are rebuilt from a **whitelist**,
 *     excluding the Agent service's private key directory, data directory, document service
 *     address, delegation, and model Keys (these are originally in-memory only, and even
 *     environment variables of the same name are not passed here). What is spawned is a killable
 *     process tree (`spawnTree` in `perception/runner.mjs`): on non-Windows it is the leader of a
 *     new process group, and both `child.kill()` and the built-in timeout kill the entire tree
 *     (ffmpeg spawned by Python also dies).
 *
 * This is only an in-process defense: the node should run these subprocesses under an independent
 * unprivileged user (as documented in deployment notes); this module does not assume its presence.
 * Pure Node, does not import `src/`.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killTree, spawnTree } from './perception/runner.mjs';

export { killTree };

export const WORKSPACE_DEFAULTS = Object.freeze({
  /** Total size limit for a chat's working directory */
  maxConversationBytes: 2 * 1024 * 1024 * 1024,
  /** Total size limit of working directories for all chats in a project */
  maxProjectBytes: 8 * 1024 * 1024 * 1024,
  /** Single file size limit */
  maxFileBytes: 1024 * 1024 * 1024,
  /** Maximum number of files in a chat directory */
  maxFiles: 2000,
});

export class WorkspaceError extends Error {
  /** @param {string} code `bad-path` / `outside` / `quota` / `not-found` / `too-large` */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.workspace = true;
  }
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Windows reserved device names (with or without extension) */
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;

/** Used as directory name: colons in project ids cannot appear in Windows paths */
const dirName = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

/** Whether `child` is inside `parent` (or identical to it); both must be resolved absolute paths */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Literally inspect a relative path provided by a tool; returns normalized segments. Throws if invalid.
 * Rejects: empty, absolute paths (`/x`, `\x`), drive letters (`C:`, `C:\x`, `C:x`), UNC and device
 * paths (`\\server\share`, `\\?\`, `//x`), any segment that is `..`, contains NUL, segment name is
 * a Windows device name, segment name ends with a space or dot (Windows silently strips them,
 * which can bypass other checks), contains `:` (NTFS alternate data streams).
 */
export function splitRelative(input) {
  if (typeof input !== 'string' || !input) throw new WorkspaceError('bad-path', 'Path is empty');
  if (input.length > 1024) throw new WorkspaceError('bad-path', 'Path is too long');
  if (input.includes('\0')) throw new WorkspaceError('bad-path', 'Path contains invalid characters');
  if (/^[\\/]/.test(input) || /^[A-Za-z]:/.test(input)) throw new WorkspaceError('bad-path', 'Only relative paths inside the working directory are allowed');
  const parts = input.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (!parts.length) throw new WorkspaceError('bad-path', 'Path is empty');
  for (const p of parts) {
    if (p === '..') throw new WorkspaceError('bad-path', 'Path cannot go up');
    if (p.includes(':')) throw new WorkspaceError('bad-path', 'Path contains invalid characters');
    if (/[. ]$/.test(p)) throw new WorkspaceError('bad-path', 'File name cannot end with a dot or a space');
    if (DEVICE_RE.test(p)) throw new WorkspaceError('bad-path', 'File name is a reserved system name');
  }
  return parts;
}

/** Realpath of the deepest existing level, plus segments that do not yet exist */
function realOfDeepest(abs) {
  const pending = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return pending.length ? path.join(real, ...pending.reverse()) : real;
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      pending.push(path.basename(cur));
      cur = parent;
    }
  }
}

function treeSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      // Do not follow the link itself: prevent an outbound link from counting outside size,
      // and do not traverse out along it.
      if (e.isSymbolicLink()) { files += 1; continue; }
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files += 1; try { bytes += fs.statSync(p).size; } catch { /* Just deleted */ } }
    }
  };
  walk(dir);
  return { bytes, files };
}

/**
 * Subprocess environment variables: rebuilt from whitelist. Keeps only those needed to find
 * executables, temporary directories, and locale settings, plus those explicitly requested by
 * the caller. Any `PROMPTCUT_*`, proxy, or cloud provider credential variables are not in the
 * whitelist.
 */
const ENV_ALLOW = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
export function childEnv(cwd, extra = {}, base = process.env) {
  const env = {};
  for (const k of ENV_ALLOW) if (typeof base[k] === 'string') env[k] = base[k];
  const tmp = path.join(cwd, '.tmp');
  env.TMPDIR = tmp; env.TEMP = tmp; env.TMP = tmp;
  env.HOME = cwd; env.USERPROFILE = cwd;
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (typeof v !== 'string') continue;
    if (/^PROMPTCUT_/i.test(k)) continue; // None of the service's own configuration is passed
    env[k] = v;
  }
  return env;
}

/**
 * @param {object} o
 * @param {string | null} o.dataDir Agent service data directory; when null, workspace is
 *   unavailable (for tests that do not touch files only)
 * @param {object} [o.limits] overrides `WORKSPACE_DEFAULTS`
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export function createWorkspaces({ dataDir, limits: limitsIn = {}, log = () => {}, spawnImpl = nodeSpawn } = {}) {
  const limits = { ...WORKSPACE_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect tools */ } };
  const root = dataDir ? path.join(path.resolve(dataDir), 'work') : null;

  const projectDir = (projectId) => {
    if (!root) throw new WorkspaceError('not-found', 'This process has no workspace');
    if (typeof projectId !== 'string' || !ID_RE.test(projectId)) throw new WorkspaceError('bad-path', 'Project id is invalid');
    return path.join(root, dirName(projectId));
  };

  /**
   * Workspace for a chat. Directory is created only when used.
   * @param {{ projectId: string, ownerKey: string, conversationId: string }} who all from
   *   authentication and server side, not from tool arguments
   */
  function open({ projectId, ownerKey, conversationId }) {
    if (typeof ownerKey !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(ownerKey)) throw new WorkspaceError('bad-path', 'Owner key is invalid');
    if (typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) throw new WorkspaceError('bad-path', 'Invalid chat id');
    const pdir = projectDir(projectId);
    const dir = path.join(pdir, ownerKey, conversationId);

    const ensure = () => {
      fs.mkdirSync(path.join(dir, '.tmp'), { recursive: true });
      return dir;
    };

    /** Relative path from tool → verified absolute path */
    function resolve(rel) {
      const parts = splitRelative(rel);
      const abs = path.resolve(dir, ...parts);
      if (!isInside(dir, abs) || abs === dir) throw new WorkspaceError('outside', 'Path is not inside this chat\'s working directory');
      ensure();
      const realDir = fs.realpathSync.native(dir);
      const real = realOfDeepest(abs);
      if (!isInside(realDir, real) || real === realDir) {
        say('agent.workspace.refused', { projectId, reason: 'link' });
        throw new WorkspaceError('outside', 'Path points outside the working directory through a link');
      }
      return abs;
    }

    function checkQuota(adding) {
      if (adding > limits.maxFileBytes) throw new WorkspaceError('too-large', `Single file exceeds the limit (${limits.maxFileBytes} bytes)`);
      const mine = treeSize(dir);
      if (mine.files + 1 > limits.maxFiles) throw new WorkspaceError('quota', 'Too many files in this chat\'s working directory');
      if (mine.bytes + adding > limits.maxConversationBytes) throw new WorkspaceError('quota', 'This chat\'s working directory is full');
      if (treeSize(pdir).bytes + adding > limits.maxProjectBytes) throw new WorkspaceError('quota', 'This project\'s working directory is full');
    }

    return {
      projectId,
      conversationId,
      /**
       * Chat directory (created). Given only to `spawn` and callers of this module, not returned
       * to the model.
       */
      dir: ensure,
      resolve,
      exists(rel) {
        try { return fs.statSync(resolve(rel)).isFile(); } catch (err) { if (err?.workspace) throw err; return false; }
      },
      read(rel, { maxBytes = limits.maxFileBytes } = {}) {
        const abs = resolve(rel);
        let st;
        try { st = fs.statSync(abs); } catch { throw new WorkspaceError('not-found', 'No such file in the working directory'); }
        if (!st.isFile()) throw new WorkspaceError('not-found', 'No such file in the working directory');
        if (st.size > maxBytes) throw new WorkspaceError('too-large', 'File is too large');
        return fs.readFileSync(abs);
      },
      stat(rel) {
        const abs = resolve(rel);
        try { const st = fs.statSync(abs); return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null; } catch { return null; }
      },
      write(rel, data) {
        const abs = resolve(rel);
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        checkQuota(buf.length);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // Verify again after creating parent directory: parent directory must not escape via link either
        resolve(rel);
        fs.writeFileSync(abs, buf);
        return { path: splitRelative(rel).join('/'), size: buf.length };
      },
      /**
       * Write chunk by chunk (download): returns `{ write(chunk), end(), abort() }`, tracking size
       * while writing, throws if exceeded.
       */
      writer(rel) {
        const abs = resolve(rel);
        checkQuota(0);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        resolve(rel);
        const room = Math.min(limits.maxFileBytes, limits.maxConversationBytes - treeSize(dir).bytes, limits.maxProjectBytes - treeSize(pdir).bytes);
        const fd = fs.openSync(abs, 'w');
        let bytes = 0;
        let open = true;
        const close = () => { if (open) { open = false; try { fs.closeSync(fd); } catch { /* Already closed */ } } };
        return {
          write(chunk) {
            bytes += chunk.length;
            if (bytes > room) { close(); try { fs.rmSync(abs, { force: true }); } catch { /* If deletion fails, leave it for cleanup */ } throw new WorkspaceError('quota', 'The working directory cannot hold this file'); }
            fs.writeSync(fd, chunk);
          },
          end() { close(); return { path: splitRelative(rel).join('/'), size: bytes }; },
          abort() { close(); try { fs.rmSync(abs, { force: true }); } catch { /* If deletion fails, leave it for cleanup */ } },
        };
      },
      remove(rel) {
        const abs = resolve(rel);
        try { fs.rmSync(abs, { force: true }); } catch { /* Ignore if absent */ }
      },
      list() {
        const out = [];
        const walk = (d, prefix) => {
          let entries;
          try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (prefix === '' && e.name === '.tmp') continue;
            if (e.isSymbolicLink()) continue;
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), rel);
            else if (e.isFile()) { try { out.push({ path: rel, size: fs.statSync(path.join(d, e.name)).size }); } catch { /* Just deleted */ } }
          }
        };
        walk(dir, '');
        return out;
      },
      usage: () => treeSize(dir),
      /**
       * Before placing a new file into this directory without going through `write` / `writer`, ask
       * **once**: how many bytes can still fit (minimum of single-file limit, remaining quota for chat,
       * and remaining quota for project).
       * Throws `quota` if file count reaches the limit. Here it scans the chat directory and project
       * directory once each (synchronously); caller should accumulate using the returned count itself,
       * rather than asking each time a chunk is written.
       */
      room() {
        ensure();
        const mine = treeSize(dir);
        if (mine.files + 1 > limits.maxFiles) throw new WorkspaceError('quota', 'Too many files in this chat\'s working directory');
        return Math.max(0, Math.min(limits.maxFileBytes, limits.maxConversationBytes - mine.bytes, limits.maxProjectBytes - treeSize(pdir).bytes));
      },
      /**
       * Spawn subprocess: working directory is the chat directory, environment variables are rebuilt
       * from whitelist, no window pops up. Paths in `args` are obtained by caller using `resolve()`.
       * Returned `child.kill()` kills the entire process tree; when `timeoutMs` expires, it also kills
       * the entire tree. When starting Python, assemble arguments using `isolatedPythonArgs()`
       * (isolated mode).
       * @param {string} command
       * @param {string[]} args
       * @param {{ env?: Record<string, string>, stdio?: any, timeoutMs?: number }} [options]
       */
      spawn(command, args = [], options = {}) {
        const cwd = ensure();
        // Spawn as a killable tree (`perception/runner.mjs`): on non-Windows it is the leader of a new
        // process group; returned `child.kill()` kills the entire tree
        const child = spawnTree(command, args, { cwd, env: childEnv(cwd, options.env), stdio: options.stdio }, { spawnImpl });
        if (Number(options.timeoutMs) > 0) {
          const timer = setTimeout(() => { killTree(child); }, Number(options.timeoutMs));
          timer.unref?.();
          child.once('exit', () => clearTimeout(timer));
        }
        return child;
      },
      /** Delete the entire working directory for this chat */
      destroy() {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (err) { say('agent.workspace.remove-failed', { projectId, message: String(err?.code ?? err).slice(0, 80) }); }
      },
    };
  }

  return {
    root,
    available: root !== null,
    open,
    /** Project deletion: delete the entire tree */
    removeProject(projectId) {
      if (!root) return;
      try { fs.rmSync(projectDir(projectId), { recursive: true, force: true, maxRetries: 3 }); } catch (err) { say('agent.workspace.remove-failed', { projectId, message: String(err?.code ?? err).slice(0, 80) }); }
    },
    projectUsage(projectId) {
      if (!root) return { bytes: 0, files: 0 };
      return treeSize(projectDir(projectId));
    },
    limits,
  };
}
