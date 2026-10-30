/**
 * 把 PromptCut 的 MCP 服务登记到桌面 APP 的用户级配置(计划 `docs/plan/agent-workflow-plan.md` A4「登记」;风险第 2 条)。
 *
 * 两个目标:
 *   - `claude-code`:Claude Code 的用户级配置 `~/.claude.json` 里的 `mcpServers.promptcut`(Claude 桌面版的「Code」
 *     与命令行共用这一份);
 *   - `codex`:Codex 的 `~/.codex/config.toml` 里的 `[mcp_servers.promptcut]`(Codex 桌面版与命令行共用)。
 *
 * 约定:
 *   - **条目名固定 `promptcut`**,只写 `command` 与 `args`(本机的 node 与 `server/mcp-server.mjs`),**不写端口**:
 *     mcp-server 每次调用按 `%TEMP%\promptcut\port.json` 找用户正在用的那个实例,所以这一条不会把桌面 APP
 *     绑死在某个端口或某个项目上,用户换项目、重开 PromptCut 都不用重登;
 *   - **写之前备份**:整份配置先复制一份到 PromptCut 自己的状态目录(`<skillRoot>/mcp-register/`),
 *     登记记录(写了什么、原来那一条是什么)也放那里;
 *   - **能撤销**:撤销只动 `promptcut` 这一条 —— 原来就有同名条目的还原成原来那条,原来没有的删掉;配置里别的内容
 *     (用户在这期间的其它改动)一律不碰。用户自己改过这一条的,撤销拒绝并说明,不替用户做主;
 *   - **路径可覆盖**:`PROMPTCUT_CLAUDE_CONFIG`、`PROMPTCUT_CODEX_CONFIG`、`PROMPTCUT_SKILL_DIR` 或函数参数,
 *     测试和探针只在临时目录里写,绝不碰用户真实的配置。
 *
 * 写入一律「临时文件 + 改名」,不留下写了一半的配置。`~/.claude.json` 同时也被正在跑的 Claude Code 读写,
 * 两边恰好同一瞬间写会有一方的改动丢失 —— 这里改完立刻读回核对,核对不上就回错误,备份仍在。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillRoot } from './skill-gate.mjs';

export const ENTRY_NAME = 'promptcut';
export const TARGETS = Object.freeze(['claude-code', 'codex']);
const TARGET_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** 各目标的配置文件路径 */
export function configPathOf(target, { env = process.env, home = os.homedir() } = {}) {
  if (target === 'claude-code') return env.PROMPTCUT_CLAUDE_CONFIG || path.join(home, '.claude.json');
  if (target === 'codex') return env.PROMPTCUT_CODEX_CONFIG || path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  throw new Error(`不认识的登记目标:${target}(只有 ${TARGETS.join(' / ')})`);
}

/** 备份与登记记录放哪 */
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
    throw new Error(`${file} 不是合法的 JSON(${e.message}),没有改动它。请先修好这个文件再登记。`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} 的内容不是一个对象,没有改动它。`);
  return { text, doc };
}

const claude = {
  read(file) {
    const { text, doc } = readJsonConfig(file);
    const servers = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {};
    return { text, entry: Object.hasOwn(servers, ENTRY_NAME) ? servers[ENTRY_NAME] : null };
  },
  /** 把条目设成 value(null = 删掉),回新全文 */
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

/* ------------------------------------------------------------------ Codex:TOML(只动 promptcut 这一张表,别的原样保留) */

/** TOML 基本字符串:JSON 的字符串写法在 TOML 里同样合法(\\ \" \uXXXX) */
const tomlString = (s) => JSON.stringify(String(s));

function tomlBlock({ command, args }) {
  return [`[mcp_servers.${ENTRY_NAME}]`, `command = ${tomlString(command)}`, `args = [${args.map(tomlString).join(', ')}]`].join('\n');
}

const HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
/** 表头名去掉引号、空白,好比较:`mcp_servers."promptcut"` → `mcp_servers.promptcut` */
const normHeader = (h) => h.split('.').map((p) => p.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')).join('.');

/**
 * 找 promptcut 这张表(连同它的子表 `[mcp_servers.promptcut.env]` 等)在全文里的行范围。
 * 回 { start, end }(end 不含),没有回 null;用了别的写法(`[mcp_servers]` 表里直接写 `promptcut = …` 或
 * 点号键)时抛错,让用户手动处理,不猜。
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
      throw new Error(`config.toml 的 [mcp_servers] 表里用别的写法定义了 ${ENTRY_NAME}(第 ${i + 1} 行),为了不写坏它,没有改动。请手动删掉那一条后再登记。`);
    }
    if (current === '' && /^\s*mcp_servers\s*\.\s*"?promptcut"?\s*[.=]/.test(lines[i])) {
      throw new Error(`config.toml 顶层用点号键定义了 mcp_servers.${ENTRY_NAME}(第 ${i + 1} 行),为了不写坏它,没有改动。请手动删掉那一条后再登记。`);
    }
  }
  if (start < 0) return null;
  // 块尾的空行留给下一张表
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
        // 删掉后别留两段连着的空行
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

/* ------------------------------------------------------------------ 对外 */

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
 * 这份 MCP 登记该写的命令:本机的 node 与这份代码里的 `server/mcp-server.mjs`。
 * @param {string} root 仓库根(打包后是 runtime/app)
 */
export function mcpCommand(root, { execPath = process.execPath } = {}) {
  return { command: execPath, args: [path.join(root, 'server', 'mcp-server.mjs')] };
}

/**
 * 现状:配置文件在哪、有没有 promptcut 条目、是不是这份 PromptCut 写的(命令与脚本一致)、有没有能撤销的登记记录。
 * @param {string} target
 * @param {{ command: string, args: string[] }} want 这份 PromptCut 该写的命令
 */
export function registrationStatus(target, want, opts = {}) {
  const impl = IMPL[target];
  if (!impl) throw new Error(`不认识的登记目标:${target}`);
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
 * 登记:先备份整份配置,再写 promptcut 条目,读回核对。
 * 已经是同样的条目就什么都不写。原来有别的 promptcut 条目,记下它以便撤销时还原。
 */
export function register(target, want, opts = {}) {
  const impl = IMPL[target];
  if (!impl) throw new Error(`不认识的登记目标:${target}`);
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
  // 撤销要还原的是「PromptCut 第一次登记之前」的那一条:已经有记录(重登,比如换了安装位置)就沿用原来那份
  const prev = readRecord(target, opts);
  const previousEntry = prev && prev.file === file ? prev.previousEntry : entry;
  atomicWrite(file, impl.write(file, value));
  const check = impl.read(file);
  if (!impl.same(check.entry, value)) {
    return { ok: false, file, backup, error: `写完读回核对不上(可能 ${TARGET_LABEL[target]} 同时改了这个文件)。原文件备份在 ${backup ?? '(原来没有这个文件)'},请稍后重试。` };
  }
  const record = { target, file, backup, previousEntry, entry: value, registeredAt: new Date().toISOString() };
  atomicWrite(recordPath(target, opts), JSON.stringify(record, null, 2));
  return { ok: true, file, backup, ...registrationStatus(target, want, opts) };
}

/**
 * 撤销登记:promptcut 条目还原成登记前的样子(原来没有就删掉)。配置里别的内容不碰。
 * 条目被用户改过(不是当初写的那一条)时拒绝;没有登记记录时,只在条目正是这份 PromptCut 该写的那一条时删掉。
 */
export function unregister(target, want, opts = {}) {
  const impl = IMPL[target];
  if (!impl) throw new Error(`不认识的登记目标:${target}`);
  const file = opts.configPath || configPathOf(target, opts);
  const rec = readRecord(target, opts);
  const { entry } = impl.read(file);
  const ours = rec && rec.file === file ? rec.entry : impl.build(want);
  if (entry === null) {
    try { fs.rmSync(recordPath(target, opts), { force: true }); } catch { /* 没有就算了 */ }
    return { ok: true, unchanged: true, file, ...registrationStatus(target, want, opts) };
  }
  if (!impl.same(entry, ours)) {
    return { ok: false, file, error: `${file} 里的 ${ENTRY_NAME} 条目已经被改过,不是 PromptCut 写的那一条;为了不覆盖你的改动,没有撤销。需要的话请手动删改。` };
  }
  const restore = rec && rec.file === file ? rec.previousEntry ?? null : null;
  const dir = stateDirOf(opts);
  fs.mkdirSync(dir, { recursive: true });
  const text = readText(file);
  const backup = text !== null ? path.join(dir, `${target}-${stamp()}-before-undo-${path.basename(file)}`) : null;
  if (backup) fs.writeFileSync(backup, text, 'utf8');
  atomicWrite(file, impl.write(file, restore));
  try { fs.rmSync(recordPath(target, opts), { force: true }); } catch { /* 没有就算了 */ }
  return { ok: true, file, backup, restored: restore !== null, ...registrationStatus(target, want, opts) };
}
