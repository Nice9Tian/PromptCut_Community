/**
 * Register PromptCut's MCP service into the desktop app user-level config
 * (plan `docs/plan/agent-workflow-plan.md` A4 "Register"; risk item 2).
 *
 * Two targets:
 *   - `claude-code`: `mcpServers.promptcut` in Claude Code's user-level config `~/.claude.json`
 *     (Claude desktop app "Code" shares this with the CLI);
 *   - `codex`: `[mcp_servers.promptcut]` in Codex's `~/.codex/config.toml`
 *     (shared between Codex desktop app and CLI).
 *
 * Conventions:
 *   - **Entry name is fixed to `promptcut`**, writing only `command` and `args` (local node and
 *     `server/mcp-server.mjs`), **no port**: each invocation of mcp-server finds the instance
 *     currently in use via `%TEMP%\promptcut\port.json`, so this entry will not bind the desktop
 *     app to a specific port or project; switching projects or restarting PromptCut requires
 *     no re-registration;
 *   - **Back up before writing**: copy the entire config to PromptCut's own state directory
 *     (`<skillRoot>/mcp-register/`), and store registration records (what was written, what the
 *     original entry was) there as well;
 *   - **Reversible**: undo only touches the `promptcut` entry: restore original entry if one
 *     already existed, or delete it if none existed; other contents in the config (user changes
 *     made during this period) are left untouched. If the user modified this entry themselves,
 *     undo is rejected with an explanation rather than deciding for the user;
 *   - **Overridable paths**: `PROMPTCUT_CLAUDE_CONFIG`, `PROMPTCUT_CODEX_CONFIG`,
 *     `PROMPTCUT_SKILL_DIR`, or function parameters; tests and probes write only to temporary
 *     directories and never touch actual user configs.
 *
 * Writes always use "temp file + rename" without leaving partially written configs. `~/.claude.json`
 * is concurrently read and written by running Claude Code instances; writing at the exact same
 * instant could cause one side's changes to be lost: here we immediately read back to verify after
 * writing, returning an error if verification fails while keeping the backup intact.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillRoot } from './skill-gate.mjs';
import { tr } from './i18n.mjs';

export const ENTRY_NAME = 'promptcut';
export const TARGETS = Object.freeze(['claude-code', 'codex']);
const TARGET_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** Config file paths for each target */
export function configPathOf(target, { env = process.env, home = os.homedir() } = {}) {
  if (target === 'claude-code') return env.PROMPTCUT_CLAUDE_CONFIG || path.join(home, '.claude.json');
  if (target === 'codex') return env.PROMPTCUT_CODEX_CONFIG || path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  throw new Error(tr("Unknown registration target: {0} (only {1})", target, TARGETS.join(' / ')));
}

/** Where backups and registration records are stored */
export function stateDirOf({ stateDir } = {}) {
  return stateDir || path.join(skillRoot(), 'mcp-register');
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.promptcut-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');

/* ------------------------------------------------------------------ Claude Code:JSON */

function jsonEntry({ command, args }) {
  return { type: 'stdio', command, args: [...args], env: {} };
}

function readJsonConfig(file) {
  const text = readText(file);
  if (text === null) return { text: null, doc: {} };
  const trimmed = text.replace(/^﻿/, '');
  if (!trimmed.trim()) return { text, doc: {} };
  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(tr("{0} is not valid JSON ({1}); it was not modified. Fix the file first, then register again.", file, e.message));
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(tr("The content of {0} is not an object; it was not modified.", file));
  return { text, doc };
}

const claude = {
  read(file) {
    const { text, doc } = readJsonConfig(file);
    const servers = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {};
    return { text, entry: Object.hasOwn(servers, ENTRY_NAME) ? servers[ENTRY_NAME] : null };
  },
  /** Set entry to value (null = delete), returns new full text */
  write(file, value) {
    const { doc } = readJsonConfig(file);
    const servers = doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers) ? { ...doc.mcpServers } : {};
    if (value === null) delete servers[ENTRY_NAME];
    else servers[ENTRY_NAME] = value;
    return JSON.stringify({ ...doc, mcpServers: servers }, null, 2);
  },
  build: jsonEntry,
  same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
};

/* ------------------------------------------------------------------ Codex: TOML (only touches the promptcut table, leaves others intact) */

/** TOML basic string: JSON string escaping is also valid in TOML (\\ \" \uXXXX) */
const tomlString = (s) => JSON.stringify(String(s));

function tomlBlock({ command, args }) {
  return [`[mcp_servers.${ENTRY_NAME}]`, `command = ${tomlString(command)}`, `args = [${args.map(tomlString).join(', ')}]`].join('\n');
}

const HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
/** Strip quotes and whitespace from table headers for easy comparison: `mcp_servers."promptcut"` → `mcp_servers.promptcut` */
const normHeader = (h) => h.split('.').map((p) => p.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')).join('.');

/**
 * Find the line range of the promptcut table (along with its subtables like
 * `[mcp_servers.promptcut.env]`) in the full text. Returns { start, end } (end exclusive),
 * or null if not found; throws an error if alternative syntax is used (such as writing
 * `promptcut = …` directly in `[mcp_servers]` or dotted keys), prompting the user to handle
 * it manually without guessing.
 */
function findTomlBlock(lines) {
  let start = -1;
  let end = lines.length;
  let current = '';
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER_RE.exec(lines[i]);
    if (m) {
      current = normHeader(m[1]);
      const mine = current === `mcp_servers.${ENTRY_NAME}` || current.startsWith(`mcp_servers.${ENTRY_NAME}.`);
      if (mine && start < 0) start = i;
      else if (!mine && start >= 0) { end = i; break; }
      continue;
    }
    const key = /^\s*("?)([A-Za-z0-9_-]+)\1\s*[.=]/.exec(lines[i]);
    if (current === 'mcp_servers' && key && key[2] === ENTRY_NAME) {
      throw new Error(tr("The [mcp_servers] table in config.toml defines {0} in another form (line {1}); to avoid corrupting it, nothing was modified. Delete that entry manually, then register again.", ENTRY_NAME, i + 1));
    }
    if (current === '' && /^\s*mcp_servers\s*\.\s*"?promptcut"?\s*[.=]/.test(lines[i])) {
      throw new Error(tr("config.toml defines mcp_servers.{0} at the top level with a dotted key (line {1}); to avoid corrupting it, nothing was modified. Delete that entry manually, then register again.", ENTRY_NAME, i + 1));
    }
  }
  if (start < 0) return null;
  // Leave blank line at the end of the block for the next table
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  return { start, end };
}

const codex = {
  read(file) {
    const text = readText(file);
    if (text === null) return { text: null, entry: null };
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const b = findTomlBlock(lines);
    return { text, entry: b ? lines.slice(b.start, b.end).join('\n') : null };
  },
  write(file, value) {
    const text = readText(file) ?? '';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const b = findTomlBlock(lines);
    let out;
    if (b) {
      const repl = value === null ? [] : value.split('\n');
      out = [...lines.slice(0, b.start), ...repl, ...lines.slice(b.end)];
      if (value === null) {
        // Do not leave consecutive blank lines after deletion
        const i = b.start;
        if (i > 0 && i < out.length && !out[i - 1].trim() && !out[i].trim()) out.splice(i, 1);
      }
    } else if (value !== null) {
      const body = lines.join('\n').replace(/\s+$/, '');
      out = (body ? `${body}\n\n${value}` : value).split('\n');
    } else {
      out = lines;
    }
    let joined = out.join('\n');
    if (joined && !joined.endsWith('\n')) joined += '\n';
    return joined.replace(/\n/g, eol);
  },
  build: tomlBlock,
  same: (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim(),
};

const IMPL = { 'claude-code': claude, codex };

/* ------------------------------------------------------------------ Public */

function recordPath(target, opts) {
  return path.join(stateDirOf(opts), `${target}.json`);
}

function readRecord(target, opts) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(target, opts), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Command that this MCP registration should write: local node and `server/mcp-server.mjs` in this codebase.
 * @param {string} root Repository root (packaged as runtime/app)
 */
export function mcpCommand(root, { execPath = process.execPath } = {}) {
  return { command: execPath, args: [path.join(root, 'server', 'mcp-server.mjs')] };
}

/**
 * Current status: where the config file is, whether the promptcut entry exists, whether it was
 * written by this PromptCut (command matches script), and whether a reversible registration
 * record exists.
 * @param {string} target
 * @param {{ command: string, args: string[] }} want Command that this PromptCut should write
 */
export function registrationStatus(target, want, opts = {}) {
  const impl = IMPL[target];
  if (!impl) throw new Error(tr("Unknown registration target: {0}", target));
  const file = opts.configPath || configPathOf(target, opts);
  const out = { target, label: TARGET_LABEL[target], file, exists: false, registered: false, current: false, undoable: false, error: null };
  try {
    const { text, entry } = impl.read(file);
    out.exists = text !== null;
    out.registered = entry !== null;
    out.current = entry !== null && impl.same(entry, impl.build(want));
  } catch (e) {
    out.error = e.message;
  }
  const rec = readRecord(target, opts);
  out.undoable = !!(rec && rec.file === file);
  if (rec) out.registeredAt = rec.registeredAt;
  return out;
}

/**
 * Register: back up the entire config first, then write the promptcut entry, and read back
 * to verify. If the entry is already identical, write nothing. If another promptcut entry
 * previously existed, record it to restore during undo.
 */
export function register(target, want, opts = {}) {
  const impl = IMPL[target];
  if (!impl) throw new Error(tr("Unknown registration target: {0}", target));
  const file = opts.configPath || configPathOf(target, opts);
  const value = impl.build(want);
  const { text, entry } = impl.read(file);
  if (entry !== null && impl.same(entry, value)) return { ok: true, unchanged: true, file, ...registrationStatus(target, want, opts) };

  const dir = stateDirOf(opts);
  fs.mkdirSync(dir, { recursive: true });
  let backup = null;
  if (text !== null) {
    backup = path.join(dir, `${target}-${stamp()}-${path.basename(file)}`);
    fs.writeFileSync(backup, text, 'utf8');
  }
  // Undo restores the entry from "before PromptCut's first registration": if a record already exists (re-registering, e.g. changed install location), keep the original one
  const prev = readRecord(target, opts);
  const previousEntry = prev && prev.file === file ? prev.previousEntry : entry;
  atomicWrite(file, impl.write(file, value));
  const check = impl.read(file);
  if (!impl.same(check.entry, value)) {
    return { ok: false, file, backup, error: tr("Read-back verification after writing failed (maybe {0} modified this file at the same time). The original file is backed up at {1}. Please try again later.", TARGET_LABEL[target], backup ?? tr("(the file did not exist before)")) };
  }
  const record = { target, file, backup, previousEntry, entry: value, registeredAt: new Date().toISOString() };
  atomicWrite(recordPath(target, opts), JSON.stringify(record, null, 2));
  return { ok: true, file, backup, ...registrationStatus(target, want, opts) };
}

/**
 * Unregister: restore the promptcut entry to its pre-registration state (delete if it did not
 * exist). Other contents in the config are left untouched. Rejected if the entry was modified by
 * the user (not the one originally written); if there is no registration record, only delete if
 * the entry matches the one this PromptCut should write.
 */
export function unregister(target, want, opts = {}) {
  const impl = IMPL[target];
  if (!impl) throw new Error(tr("Unknown registration target: {0}", target));
  const file = opts.configPath || configPathOf(target, opts);
  const rec = readRecord(target, opts);
  const { entry } = impl.read(file);
  const ours = rec && rec.file === file ? rec.entry : impl.build(want);
  if (entry === null) {
    try { fs.rmSync(recordPath(target, opts), { force: true }); } catch { /* Ignore if absent */ }
    return { ok: true, unchanged: true, file, ...registrationStatus(target, want, opts) };
  }
  if (!impl.same(entry, ours)) {
    return { ok: false, file, error: tr("The {1} entry in {0} has been modified and is not the one written by PromptCut; to avoid overwriting your changes, it was not undone. Edit or delete it manually if needed.", file, ENTRY_NAME) };
  }
  const restore = rec && rec.file === file ? rec.previousEntry ?? null : null;
  const dir = stateDirOf(opts);
  fs.mkdirSync(dir, { recursive: true });
  const text = readText(file);
  const backup = text !== null ? path.join(dir, `${target}-${stamp()}-before-undo-${path.basename(file)}`) : null;
  if (backup) fs.writeFileSync(backup, text, 'utf8');
  atomicWrite(file, impl.write(file, restore));
  try { fs.rmSync(recordPath(target, opts), { force: true }); } catch { /* Ignore if absent */ }
  return { ok: true, file, backup, restored: restore !== null, ...registrationStatus(target, want, opts) };
}
