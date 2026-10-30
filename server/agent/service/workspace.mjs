/**
 * 云端 Agent 的工作区:按「项目 × 对话」隔离的本地目录(任务书 `docs/plan/cloud-agent-task.md` J;
 * 契约 `docs/plan/cloud-agent-contract.md` 第 9.5 节)。
 *
 * 托管档里凡是读写本地文件的工具(附件、下载、感知类工具的中间文件、配音的产物等),一律落在
 *
 *   <数据目录>/work/<项目 id>/<主人键>/<对话 id>/
 *
 * 之下,由这里给路径、核路径:
 *
 *   - 工具给的相对路径先在字面上拒掉绝对路径、Windows 盘符、UNC、`..`、NUL 与设备名;再解析,核对落在对话目录之内;
 *     再对**已经存在的最深一层**取真实路径(跟符号链接、junction),核对仍在对话目录的真实路径之内——
 *     所以目录里若被放进一个指向外面的链接,经它读写同样被拒;
 *   - 写入计入对话与项目两级的总量上限,超了拒写;
 *   - 对话删除、项目删除时整棵删掉;
 *   - 子进程(Python、ffmpeg、下载器)只经 `spawn()` 起:工作目录是对话目录,环境变量是一张**白名单**重建的,
 *     不带 Agent 服务的私钥目录、数据目录、文档服务地址、委托与模型 Key(这些本来也只在内存里,这里连同名的环境变量一起不传)。
 *     起出来的是一棵杀得掉的进程树(`perception/runner.mjs` 的 `spawnTree`):非 Windows 上是新进程组的组长,
 *     `child.kill()` 与自带的超时杀的都是整棵树(Python 再起的 ffmpeg 一起死)。
 *
 * 这只是进程内的一道:节点上应当再用独立的非特权用户跑这些子进程(部署说明里写),本模块不假设它存在。
 * 纯 Node,不引用 `src/`。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killTree, spawnTree } from './perception/runner.mjs';

export { killTree };

export const WORKSPACE_DEFAULTS = Object.freeze({
  /** 一个对话的工作目录总量上限 */
  maxConversationBytes: 2 * 1024 * 1024 * 1024,
  /** 一个项目所有对话的工作目录总量上限 */
  maxProjectBytes: 8 * 1024 * 1024 * 1024,
  /** 单个文件上限 */
  maxFileBytes: 1024 * 1024 * 1024,
  /** 一个对话目录里最多多少个文件 */
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
/** Windows 的保留设备名(带不带扩展名都算) */
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;

/** 当目录名用:项目 id 里的冒号在 Windows 上不能进路径 */
const dirName = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

/** `child` 是不是在 `parent` 之内(或就是它);两者都要是已解析的绝对路径 */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 字面检查一个工具给的相对路径;回规范化后的各段。不合规矩就抛。
 * 拒:空、绝对路径(`/x`、`\x`)、盘符(`C:`、`C:\x`、`C:x`)、UNC 与设备路径(`\\server\share`、`\\?\`、`//x`)、
 * 任何一段是 `..`、带 NUL、段名是 Windows 设备名、段名以空格或点结尾(Windows 会悄悄去掉,能绕过别的比较)、带 `:`(NTFS 备用数据流)。
 */
export function splitRelative(input) {
  if (typeof input !== 'string' || !input) throw new WorkspaceError('bad-path', '路径是空的');
  if (input.length > 1024) throw new WorkspaceError('bad-path', '路径太长');
  if (input.includes('\0')) throw new WorkspaceError('bad-path', '路径里有非法字符');
  if (/^[\\/]/.test(input) || /^[A-Za-z]:/.test(input)) throw new WorkspaceError('bad-path', '只能用工作目录里的相对路径');
  const parts = input.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (!parts.length) throw new WorkspaceError('bad-path', '路径是空的');
  for (const p of parts) {
    if (p === '..') throw new WorkspaceError('bad-path', '路径不能往上走');
    if (p.includes(':')) throw new WorkspaceError('bad-path', '路径里有非法字符');
    if (/[. ]$/.test(p)) throw new WorkspaceError('bad-path', '文件名不能以点或空格结尾');
    if (DEVICE_RE.test(p)) throw new WorkspaceError('bad-path', '文件名是系统保留名');
  }
  return parts;
}

/** 已存在的最深一层的真实路径,加上还不存在的那几段 */
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
      // 链接本身不跟:不让一个指向外面的链接把外面的体积算进来,也不沿着它走出去
      if (e.isSymbolicLink()) { files += 1; continue; }
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files += 1; try { bytes += fs.statSync(p).size; } catch { /* 刚被删 */ } }
    }
  };
  walk(dir);
  return { bytes, files };
}

/**
 * 子进程的环境变量:白名单重建。只留找可执行文件、临时目录、区域设置要的那几个,外加调用方点名要给的。
 * 任何 `PROMPTCUT_*`、代理、云厂商凭证的变量都不在白名单里。
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
    if (/^PROMPTCUT_/i.test(k)) continue; // 服务自己的配置一个都不传
    env[k] = v;
  }
  return env;
}

/**
 * @param {object} o
 * @param {string | null} o.dataDir Agent 服务的数据目录;null 时工作区不可用(只给不碰文件的测试)
 * @param {object} [o.limits] 覆盖 `WORKSPACE_DEFAULTS`
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export function createWorkspaces({ dataDir, limits: limitsIn = {}, log = () => {}, spawnImpl = nodeSpawn } = {}) {
  const limits = { ...WORKSPACE_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };
  const root = dataDir ? path.join(path.resolve(dataDir), 'work') : null;

  const projectDir = (projectId) => {
    if (!root) throw new WorkspaceError('not-found', '这个进程没有工作区');
    if (typeof projectId !== 'string' || !ID_RE.test(projectId)) throw new WorkspaceError('bad-path', '项目 id 不合法');
    return path.join(root, dirName(projectId));
  };

  /**
   * 一个对话的工作区。目录用到时才建。
   * @param {{ projectId: string, ownerKey: string, conversationId: string }} who 全部来自鉴权与服务端,不来自工具参数
   */
  function open({ projectId, ownerKey, conversationId }) {
    if (typeof ownerKey !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(ownerKey)) throw new WorkspaceError('bad-path', '主人键不合法');
    if (typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) throw new WorkspaceError('bad-path', '对话 id 不合法');
    const pdir = projectDir(projectId);
    const dir = path.join(pdir, ownerKey, conversationId);

    const ensure = () => {
      fs.mkdirSync(path.join(dir, '.tmp'), { recursive: true });
      return dir;
    };

    /** 工具给的相对路径 → 核过的绝对路径 */
    function resolve(rel) {
      const parts = splitRelative(rel);
      const abs = path.resolve(dir, ...parts);
      if (!isInside(dir, abs) || abs === dir) throw new WorkspaceError('outside', '路径不在这个对话的工作目录里');
      ensure();
      const realDir = fs.realpathSync.native(dir);
      const real = realOfDeepest(abs);
      if (!isInside(realDir, real) || real === realDir) {
        say('agent.workspace.refused', { projectId, reason: 'link' });
        throw new WorkspaceError('outside', '路径经链接指到了工作目录外面');
      }
      return abs;
    }

    function checkQuota(adding) {
      if (adding > limits.maxFileBytes) throw new WorkspaceError('too-large', `单个文件超过上限(${limits.maxFileBytes} 字节)`);
      const mine = treeSize(dir);
      if (mine.files + 1 > limits.maxFiles) throw new WorkspaceError('quota', '这个对话的工作目录里文件太多了');
      if (mine.bytes + adding > limits.maxConversationBytes) throw new WorkspaceError('quota', '这个对话的工作目录已满');
      if (treeSize(pdir).bytes + adding > limits.maxProjectBytes) throw new WorkspaceError('quota', '这个项目的工作目录已满');
    }

    return {
      projectId,
      conversationId,
      /** 对话目录(已建)。只交给 `spawn` 与本模块的使用方,不回给模型 */
      dir: ensure,
      resolve,
      exists(rel) {
        try { return fs.statSync(resolve(rel)).isFile(); } catch (err) { if (err?.workspace) throw err; return false; }
      },
      read(rel, { maxBytes = limits.maxFileBytes } = {}) {
        const abs = resolve(rel);
        let st;
        try { st = fs.statSync(abs); } catch { throw new WorkspaceError('not-found', '工作目录里没有这个文件'); }
        if (!st.isFile()) throw new WorkspaceError('not-found', '工作目录里没有这个文件');
        if (st.size > maxBytes) throw new WorkspaceError('too-large', '文件太大');
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
        // 建完父目录再核一次:父目录这一步也不能经链接出去
        resolve(rel);
        fs.writeFileSync(abs, buf);
        return { path: splitRelative(rel).join('/'), size: buf.length };
      },
      /** 逐块写(下载):回 `{ write(chunk), end(), abort() }`,边写边记体积,超了抛 */
      writer(rel) {
        const abs = resolve(rel);
        checkQuota(0);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        resolve(rel);
        const room = Math.min(limits.maxFileBytes, limits.maxConversationBytes - treeSize(dir).bytes, limits.maxProjectBytes - treeSize(pdir).bytes);
        const fd = fs.openSync(abs, 'w');
        let bytes = 0;
        let open = true;
        const close = () => { if (open) { open = false; try { fs.closeSync(fd); } catch { /* 已经关了 */ } } };
        return {
          write(chunk) {
            bytes += chunk.length;
            if (bytes > room) { close(); try { fs.rmSync(abs, { force: true }); } catch { /* 删不掉就留给清理 */ } throw new WorkspaceError('quota', '工作目录放不下这个文件'); }
            fs.writeSync(fd, chunk);
          },
          end() { close(); return { path: splitRelative(rel).join('/'), size: bytes }; },
          abort() { close(); try { fs.rmSync(abs, { force: true }); } catch { /* 删不掉就留给清理 */ } },
        };
      },
      remove(rel) {
        const abs = resolve(rel);
        try { fs.rmSync(abs, { force: true }); } catch { /* 没有就算了 */ }
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
            else if (e.isFile()) { try { out.push({ path: rel, size: fs.statSync(path.join(d, e.name)).size }); } catch { /* 刚被删 */ } }
          }
        };
        walk(dir, '');
        return out;
      },
      usage: () => treeSize(dir),
      /**
       * 不经 `write` / `writer` 往这个目录里落一个新文件之前问**一次**:还放得下多少字节(单文件上限、对话与项目的剩余额度,三者取小)。
       * 文件数到了上限抛 `quota`。这里各扫一遍对话目录和项目目录(同步的);调用方按回来的数自己累计,不要每写一块来问一次
       */
      room() {
        ensure();
        const mine = treeSize(dir);
        if (mine.files + 1 > limits.maxFiles) throw new WorkspaceError('quota', '这个对话的工作目录里文件太多了');
        return Math.max(0, Math.min(limits.maxFileBytes, limits.maxConversationBytes - mine.bytes, limits.maxProjectBytes - treeSize(pdir).bytes));
      },
      /**
       * 起子进程:工作目录是对话目录,环境变量按白名单重建,不弹窗口。`args` 里的路径由调用方用 `resolve()` 得到。
       * 回的 `child.kill()` 杀整棵进程树;`timeoutMs` 到点也杀整棵树。起 Python 时参数用 `isolatedPythonArgs()` 拼(隔离模式)。
       * @param {string} command
       * @param {string[]} args
       * @param {{ env?: Record<string, string>, stdio?: any, timeoutMs?: number }} [options]
       */
      spawn(command, args = [], options = {}) {
        const cwd = ensure();
        // 起成一棵杀得掉的树(`perception/runner.mjs`):非 Windows 上是新进程组的组长;回的 `child.kill()` 杀整棵树
        const child = spawnTree(command, args, { cwd, env: childEnv(cwd, options.env), stdio: options.stdio }, { spawnImpl });
        if (Number(options.timeoutMs) > 0) {
          const timer = setTimeout(() => { killTree(child); }, Number(options.timeoutMs));
          timer.unref?.();
          child.once('exit', () => clearTimeout(timer));
        }
        return child;
      },
      /** 删掉这个对话的整个工作目录 */
      destroy() {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (err) { say('agent.workspace.remove-failed', { projectId, message: String(err?.code ?? err).slice(0, 80) }); }
      },
    };
  }

  return {
    root,
    available: root !== null,
    open,
    /** 项目删除:整棵删掉 */
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
