#!/usr/bin/env node
/**
 * prepare-python.mjs — 组装随包分发的「内置 Python」。
 *
 * 来源:python.org 官方 FTP 的 Windows embeddable package
 *   https://www.python.org/ftp/python/<版本>/python-<版本>-embed-amd64.zip
 * pip 引导脚本来源:
 *   https://bootstrap.pypa.io/get-pip.py
 *
 * 产物:desktop/src-tauri/runtime/python/
 *   python.exe / python311.zip / python311._pth / Lib/site-packages/{pip,promptcut_stt}
 *   PYTHON-VERSION.json  {version, pip, builtAt}
 * 缓存:desktop/.cache/(下载物;两个目录都在 .gitignore 里)
 *
 * 用法:
 *   node desktop/scripts/prepare-python.mjs
 *       组装(幂等:已就绪且版本一致就跳过下载与解压,只刷新 STT 包和版本文件),
 *       结束时自动跑一次隔离验证。
 *   node desktop/scripts/prepare-python.mjs --force
 *       忽略已有产物,强制重新解压并重装 pip。
 *   node desktop/scripts/prepare-python.mjs --check
 *       只校验、绝不下载。校验 python.exe 存在、`-I -c "import sys,pip"` 成功、
 *       promptcut_stt 可 import。全过退出码 0,否则 1。
 *   node desktop/scripts/prepare-python.mjs --verify-isolation
 *       只跑隔离验证:sys.path 里不得出现内置目录以外的路径;
 *       并检测 PYTHONPATH 对内置解释器的实际作用(结论见 python/README.md)。
 *   node desktop/scripts/prepare-python.mjs --verify-pip-install
 *       只跑在线装库验证:pip install --target desktop/.cache/pylibs-test faster-whisper,
 *       import 校验后删除该临时目录。会联网,耗时较长。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 常量

/** Windows embeddable package 的版本(3.11 系列最新)。 */
const PYTHON_VERSION = '3.11.9';

/** python.org 官方 FTP 的 Windows x64 embeddable zip。 */
const PYTHON_ZIP_URL =
  `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const PYTHON_ZIP_NAME = `python-${PYTHON_VERSION}-embed-amd64.zip`;

/** pip 引导脚本(pypa 官方)。 */
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const GET_PIP_NAME = 'get-pip.py';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根:desktop/scripts → desktop → 根 */
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
const SOURCE_ARG = process.argv.indexOf('--source');
// Runtime/cache always belong to this desktop checkout.  --source changes only
// the Python source copied into it for a release worktree.
const ROOT = DEFAULT_ROOT;
const SOURCE_ROOT = SOURCE_ARG >= 0 ? path.resolve(process.argv[SOURCE_ARG + 1]) : ROOT;
const CACHE_DIR = path.join(ROOT, 'desktop', '.cache');
const RUNTIME_PY = path.join(ROOT, 'desktop', 'src-tauri', 'runtime', 'python');
const SITE_PACKAGES = path.join(RUNTIME_PY, 'Lib', 'site-packages');
const STT_SRC = path.join(SOURCE_ROOT, 'python', 'promptcut_stt');
const STT_DST = path.join(SITE_PACKAGES, 'promptcut_stt');
const VERSION_FILE = path.join(RUNTIME_PY, 'PYTHON-VERSION.json');
const PYTHON_EXE = path.join(RUNTIME_PY, 'python.exe');
const PYLIBS_TEST = path.join(CACHE_DIR, 'pylibs-test');
const ISOLATION_PROBE = path.join(CACHE_DIR, 'isolation-probe');

// ---------------------------------------------------------------- 小工具

const log = (msg) => process.stdout.write(`${msg}\n`);
const warn = (msg) => process.stdout.write(`[warn] ${msg}\n`);

function fail(msg) {
  process.stderr.write(`[error] ${msg}\n`);
  process.exit(1);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* 文件在统计期间消失,忽略 */
        }
      }
    }
  }
  return total;
}

function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/*
 * 拷 python/promptcut_* 进 site-packages。**白名单**,不是黑名单。
 *
 * 这些目录会原样进安装包发给所有用户,而它们同时是开发目录 —— 谁在里面放过一个
 * .env、一份模型权重、一个调试用的大文件,都会跟着发出去。原来只挡 __pycache__ 和 .pyc,
 * 等于「除了这两样,别的一律发」。放行清单写死成包该有的东西:代码、清单、许可证。
 * 真要新增别的类型(比如包内数据文件),在这里显式加一条,别把闸门改回黑名单。
 */
const PY_PACKAGE_FILES = [/\.py$/i, /\.pyi$/i, /\.txt$/i, /^LICENSE/i, /^py\.typed$/i];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      if (e.name === '__pycache__' || e.name.startsWith('.')) continue;
      copyDir(s, d);
    } else if (e.isFile()) {
      if (!PY_PACKAGE_FILES.some((re) => re.test(e.name))) continue;
      fs.copyFileSync(s, d);
    }
  }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

// ---------------------------------------------------------------- zip 解压
// Windows 上没有 unzip,这里用 node 自带的 zlib 解析 zip 中央目录并 inflateRaw,
// 不依赖 PowerShell、不依赖任何 npm 包。

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** 解析 zip 中央目录,返回条目清单;zip 损坏时抛错。 */
function readZipEntries(buf) {
  let eocd = -1;
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip:找不到 EOCD 记录');

  const count = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (cenOffset === 0xffffffff || cenSize === 0xffffffff || count === 0xffff) {
    throw new Error('不支持 zip64 格式的压缩包');
  }

  const entries = [];
  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`zip 中央目录第 ${i} 项签名错误`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, crc, compSize, rawSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p > cenOffset + cenSize + 4) throw new Error('zip 中央目录长度与 EOCD 记录不符');
  return entries;
}

/** 取出一个条目的原始字节(store / deflate)。 */
function readZipEntryData(buf, entry) {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) {
    throw new Error(`zip 局部头签名错误:${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的 zip 压缩方式 ${entry.method}:${entry.name}`);
}

/** 校验缓存里的 zip 能不能正常解压(条目完整 + CRC 对得上)。 */
function zipIsValid(file) {
  try {
    const buf = fs.readFileSync(file);
    const entries = readZipEntries(buf);
    if (entries.length === 0) return false;
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      const data = readZipEntryData(buf, e);
      if (data.length !== e.rawSize) return false;
      if (zlib.crc32(data) >>> 0 !== e.crc >>> 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractZip(file, destDir) {
  const buf = fs.readFileSync(file);
  const entries = readZipEntries(buf);
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    const rel = e.name.replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error(`zip 里有越界路径:${e.name}`);
    }
    const out = path.join(destDir, rel);
    if (rel.endsWith('/')) {
      fs.mkdirSync(out, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, readZipEntryData(buf, e));
  }
  return entries.length;
}

// ---------------------------------------------------------------- 跑内置解释器

/**
 * 跑内置解释器。env 只保留必要的系统变量,再叠加 extraEnv,
 * 这样验证结果不受当前 shell 里残留的 PYTHON* 变量影响。
 */
function runPython(args, extraEnv = {}, opts = {}) {
  const env = {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    COMSPEC: process.env.COMSPEC,
    PATH: process.env.PATH,
    PYTHONUTF8: '1',
    PYTHONNOUSERSITE: '1',
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync(PYTHON_EXE, args, { windowsHide: true,
    encoding: 'utf8',
    env,
    cwd: opts.cwd ?? ROOT,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

const PY_PRINT_PATH = 'import sys, json; print(json.dumps(sys.path))';

function pythonPathList(extraEnv = {}, args = ['-I']) {
  const r = runPython([...args, '-c', PY_PRINT_PATH], extraEnv);
  if (r.status !== 0) {
    throw new Error(`解释器启动失败(退出码 ${r.status}):${(r.stderr || '').trim()}`);
  }
  return JSON.parse(r.stdout.trim());
}

const underRuntime = (entry) => {
  if (!entry) return true; // 空串 = 当前目录,-I 下不会被加进来,保险起见放行
  const norm = path.resolve(entry).toLowerCase();
  return norm === RUNTIME_PY.toLowerCase() || norm.startsWith(RUNTIME_PY.toLowerCase() + path.sep);
};

// ---------------------------------------------------------------- 各步骤

async function ensureZip() {
  const zipPath = path.join(CACHE_DIR, PYTHON_ZIP_NAME);
  if (fs.existsSync(zipPath)) {
    if (zipIsValid(zipPath)) {
      log(`[1/6] 复用缓存的 embeddable 包 ${PYTHON_ZIP_NAME}(${mb(fs.statSync(zipPath).size)})`);
      return zipPath;
    }
    warn(`缓存里的 ${PYTHON_ZIP_NAME} 解压校验不通过,删掉重下`);
    fs.rmSync(zipPath, { force: true });
  }
  log(`[1/6] 下载 ${PYTHON_ZIP_URL}`);
  const size = await download(PYTHON_ZIP_URL, zipPath);
  if (!zipIsValid(zipPath)) {
    fs.rmSync(zipPath, { force: true });
    throw new Error('下载到的 zip 无法解压,已删除;请重试');
  }
  log(`      下载完成:${mb(size)}`);
  return zipPath;
}

function extractRuntime(zipPath) {
  // 幂等:重装前清掉旧的解释器,避免上一版残留文件
  rimraf(RUNTIME_PY);
  const n = extractZip(zipPath, RUNTIME_PY);
  if (!fs.existsSync(PYTHON_EXE)) throw new Error('解压后没找到 python.exe');
  const size = dirSize(RUNTIME_PY);
  log(`[2/6] 解压到 runtime/python(${n} 个条目,解压后 ${mb(size)})`);
  return size;
}

function pthFile() {
  const hits = fs.readdirSync(RUNTIME_PY).filter((f) => f.endsWith('._pth'));
  if (hits.length !== 1) throw new Error(`runtime/python 下应有且仅有一个 ._pth,实际 ${hits.length} 个`);
  return path.join(RUNTIME_PY, hits[0]);
}

/** 保留 pythonXY.zip 和 .,追加 Lib\site-packages,并放开 import site。幂等。 */
function patchPth() {
  const file = pthFile();
  const original = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  const push = (line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(line);
  };
  for (const raw of original) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue; // 注释(含 `#import site`)不参与路径,统一丢掉
    if (line === 'import site') continue; // 下面统一补上
    push(line);
  }
  push('Lib\\site-packages');
  out.push('');
  out.push('import site');
  const content = out.join('\r\n') + '\r\n';
  fs.writeFileSync(file, content, 'utf8');
  log(`[3/6] 改写 ${path.basename(file)}:${out.filter(Boolean).join(' | ')}`);
}

async function installPip() {
  const getPip = path.join(CACHE_DIR, GET_PIP_NAME);
  if (fs.existsSync(getPip) && fs.statSync(getPip).size > 100_000) {
    log(`[4/6] 复用缓存的 get-pip.py(${mb(fs.statSync(getPip).size)})`);
  } else {
    log(`[4/6] 下载 ${GET_PIP_URL}`);
    await download(GET_PIP_URL, getPip);
  }
  const r = runPython([getPip, '--no-warn-script-location']);
  if (r.status !== 0) {
    throw new Error(`get-pip.py 执行失败(退出码 ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  const v = pipVersion();
  installPylibsHook();
  log(`      pip 装好了:${v}(带 pip 后 ${mb(dirSize(RUNTIME_PY))})`);
  return v;
}

/**
 * 装 PROMPTCUT_PYLIBS 的 site 钩子。
 *
 * 为什么需要它:embeddable 包的 `._pth` 文件会完全接管路径计算,PYTHONPATH 被无视;
 * 而 `-I`(= `-E -s`)本身也会忽略包括 PYTHONPATH 在内的 PYTHON* 变量。
 * 所以「在线装的库目录」不能靠 PYTHONPATH 注入。
 * 好在 `._pth` 里放开了 `import site`,site-packages 下的 `.pth` 文件会被执行 ——
 * 用一行 `.pth` 在启动时读 PROMPTCUT_PYLIBS 并追加进 sys.path,
 * 对所有入口(`-m promptcut_stt`、`-m pip`、`-c ...`)一致生效,且不需要 STT 包配合。
 * 变量没设或目录不存在时什么也不做,安装目录保持只读。
 */
function installPylibsHook() {
  const file = path.join(SITE_PACKAGES, 'promptcut_pylibs.pth');
  fs.mkdirSync(SITE_PACKAGES, { recursive: true });
  const line =
    'import os,sys' +
    ";_v=os.environ.get('PROMPTCUT_PYLIBS') or ''" +
    ';_d=[os.path.abspath(p) for p in _v.split(os.pathsep) if p and os.path.isdir(p)]' +
    ';[sys.path.append(p) for p in _d if p not in sys.path]\n';
  fs.writeFileSync(file, line, 'utf8');
  log(`      site 钩子:${path.basename(file)}(PROMPTCUT_PYLIBS → sys.path)`);
}

function pipVersion() {
  const r = runPython(['-I', '-m', 'pip', '--version']);
  if (r.status !== 0) return null;
  const m = r.stdout.match(/^pip\s+(\S+)/);
  return m ? m[1] : r.stdout.trim();
}

/**
 * 把 python/requirements-<engine>.txt 复制到 runtime/python/。
 *
 * promptcut_stt 的 find_requirements() 按四个位置找:开发期是包目录的上一级(python/),
 * 装进 site-packages 之后上一级就不是 python/ 了,所以它会去 sys.prefix 找——
 * 打包后的 sys.prefix 正是 runtime/python。以前只复制了 promptcut_stt 包本身,
 * 这两个文件一直没进包,于是装好的软件里点「安装引擎」必然报「未找到 requirements 文件」。
 */
function copyRequirements() {
  const srcDir = path.join(SOURCE_ROOT, 'python');
  if (!fs.existsSync(srcDir)) return [];
  const files = fs.readdirSync(srcDir).filter((f) => /^requirements-.+.txt$/.test(f));
  for (const f of files) fs.copyFileSync(path.join(srcDir, f), path.join(RUNTIME_PY, f));
  if (files.length) log(`[5/6] 复制 ${files.join(', ')} → runtime/python`);
  else warn('[5/6] python/ 下没有 requirements-*.txt,STT 引擎将无法安装。');
  return files;
}

function copySttPackage() {
  if (!fs.existsSync(STT_SRC)) {
    warn(`[5/6] python/promptcut_stt/ 还不存在,跳过复制。`);
    warn(`      STT 包由另一处维护;它就位后重跑本脚本即可。--check 会把这种情况判为「未就绪」。`);
    return false;
  }
  rimraf(STT_DST);
  copyDir(STT_SRC, STT_DST);
  log(`[5/6] 复制 promptcut_stt → Lib/site-packages(${mb(dirSize(STT_DST))})`);
  return true;
}

/**
 * 把 python/ 下**所有** promptcut_* 包复制进 site-packages。
 *
 * 原来只复制 promptcut_stt。开发期看不出问题——vite 那边的 buildEnv 会把缺的包
 * 临时镜像到 pylibs 里——但**正式包里没有 python/ 源码目录**，那条镜像路径根本
 * 走不到，于是镜头识别和运动追踪在装好的软件里会直接 No module named。
 * 每加一个包都改一次这里太容易漏，所以按前缀扫。
 */
function copyPromptcutPackages() {
  const srcDir = path.join(SOURCE_ROOT, 'python');
  if (!fs.existsSync(srcDir)) return [];
  const pkgs = fs.readdirSync(srcDir).filter(
    (f) => f.startsWith('promptcut_')
      && f !== 'promptcut_stt'  // 上面单独处理过了
      && fs.statSync(path.join(srcDir, f)).isDirectory(),
  );
  for (const pkg of pkgs) {
    const dst = path.join(SITE_PACKAGES, pkg);
    rimraf(dst);
    copyDir(path.join(srcDir, pkg), dst);
    log(`[5/6] 复制 ${pkg} → Lib/site-packages(${mb(dirSize(dst))})`);
  }
  if (!pkgs.length) warn('[5/6] python/ 下没有别的 promptcut_* 包。');
  return pkgs;
}

/**
 * 基础运行时自带 numpy 和 Pillow，卡片像素算法可直接使用。
 *
 * 为什么 numpy 值得进基础包、torch 不值得：运动追踪的**兜底档**（模板匹配）
 * 只要 numpy 就能跑，而拓展包是 190 MB torch + 208 MB 权重。多数用户一开始
 * 不会装拓展，「追不了」和「追得糙」对他们是完全不同的两件事。numpy 大约
 * 15 MB，换来这个功能开箱可用，划算。
 *
 * 装进 site-packages 而不是 pylibs：pylibs 是拓展包的地盘，用户卸拓展时
 * 会被清掉，基础能力不能跟着一起没。
 */
const BASE_LIBS = ['numpy==2.2.6', 'Pillow==12.3.0'];
const BASE_LIB_PROBE = 'import numpy, PIL, sys; assert numpy.__version__ == "2.2.6"; assert PIL.__version__ == "12.3.0"; sys.stdout.write("numpy " + numpy.__version__ + ", Pillow " + PIL.__version__)';

function installBaseLibs() {
  const probe = runPython(['-I', '-c', BASE_LIB_PROBE]);
  if (probe.status === 0) {
    log(`[5/6] 基础库已就位:${probe.stdout.trim()}`);
    return true;
  }
  log(`[5/6] 安装基础库 ${BASE_LIBS.join(', ')} → Lib/site-packages`);
  const r = runPython(
    ['-I', '-m', 'pip', 'install', '--only-binary=:all:', '--upgrade', '--no-warn-script-location',
     '--target', SITE_PACKAGES, ...BASE_LIBS],
    {}, { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    throw new Error('基础卡片依赖安装失败，不能交付缺少 numpy/Pillow 的运行时。');
  }
  const after = runPython(['-I', '-c', BASE_LIB_PROBE]);
  if (after.status !== 0) {
    throw new Error('基础依赖安装后校验失败，检查 ._pth 的 site-packages 配置。');
  }
  log(`[5/6] ${after.stdout.trim()} 就位`);
  return true;
}

function writeVersionFile(pip) {
  const data = { version: PYTHON_VERSION, pip, builtAt: new Date().toISOString() };
  fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  log(`[6/6] 写 PYTHON-VERSION.json:${JSON.stringify(data)}`);
  return data;
}

function readVersionFile() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 验证

/** 隔离验证:sys.path 不得越界;并检测 PYTHONPATH 的实际作用。 */
function verifyIsolation() {
  if (!fs.existsSync(PYTHON_EXE)) fail('内置 Python 未就绪,先跑 node desktop/scripts/prepare-python.mjs');

  log('--- 隔离验证 ---');
  const base = pythonPathList();
  log(`sys.path (python.exe -I):`);
  for (const p of base) log(`  ${p || '(空串)'}`);
  const stray = base.filter((p) => !underRuntime(p));
  if (stray.length) {
    fail(`sys.path 里出现了内置目录以外的路径,隔离失败:\n  ${stray.join('\n  ')}`);
  }
  log(`OK:${base.length} 个条目全部位于 ${RUNTIME_PY} 之内,没有系统 Python 的目录。`);

  // 第二步:库目录探针。分别看 PROMPTCUT_PYLIBS(site 钩子)和 PYTHONPATH 谁真的生效。
  rimraf(ISOLATION_PROBE);
  fs.mkdirSync(ISOLATION_PROBE, { recursive: true });
  const hit = (list) =>
    list.some((p) => p && path.resolve(p).toLowerCase() === ISOLATION_PROBE.toLowerCase());
  try {
    const viaPylibs = pythonPathList({ PROMPTCUT_PYLIBS: ISOLATION_PROBE });
    const viaPythonPath = pythonPathList({ PYTHONPATH: ISOLATION_PROBE });
    const viaPythonPathNoI = pythonPathList({ PYTHONPATH: ISOLATION_PROBE }, []);

    log('');
    log(`sys.path (PROMPTCUT_PYLIBS=${ISOLATION_PROBE},带 -I):`);
    for (const p of viaPylibs) log(`  ${p || '(空串)'}`);
    log(`  → PROMPTCUT_PYLIBS 生效:${hit(viaPylibs) ? '是' : '否'}`);
    log(`  → PYTHONPATH 生效(带 -I):${hit(viaPythonPath) ? '是' : '否'}`);
    log(`  → PYTHONPATH 生效(不带 -I):${hit(viaPythonPathNoI) ? '是' : '否'}`);

    const strayEnv = [...viaPylibs, ...viaPythonPath, ...viaPythonPathNoI].filter(
      (p) => !underRuntime(p) && !hit([p]),
    );
    if (strayEnv.length) {
      fail(`带环境变量时 sys.path 仍不得引入其他路径,实际出现:\n  ${strayEnv.join('\n  ')}`);
    }

    if (!hit(viaPylibs)) {
      fail('PROMPTCUT_PYLIBS 没能进 sys.path;site 钩子 promptcut_pylibs.pth 可能缺失或写坏了。');
    }
    log('');
    log('结论:PROMPTCUT_PYLIBS 指向的目录会出现在 sys.path 末尾 —— 这就是在线装的库');
    log('      被找到的机制(靠 site-packages 里的 promptcut_pylibs.pth,不是靠 PYTHONPATH)。');
    if (!hit(viaPythonPath) && !hit(viaPythonPathNoI)) {
      log('      PYTHONPATH 对内置解释器无效:._pth 文件完全接管路径计算,而 -I(= -E -s)');
      log('      本身也会忽略 PYTHON* 变量。这一条与预期一致,不是故障。');
    }
    return { pylibs: hit(viaPylibs), pythonpath: hit(viaPythonPath) };
  } finally {
    rimraf(ISOLATION_PROBE);
  }
}

/** 在线装库验证:pip install --target 到临时目录,再 import。 */
function verifyPipInstall() {
  if (!fs.existsSync(PYTHON_EXE)) fail('内置 Python 未就绪,先跑 node desktop/scripts/prepare-python.mjs');

  log('--- 在线装库验证(faster-whisper) ---');
  rimraf(PYLIBS_TEST);
  fs.mkdirSync(PYLIBS_TEST, { recursive: true });
  try {
    const t0 = Date.now();
    const r = runPython(['-I', '-m', 'pip', 'install', '--target', PYLIBS_TEST, 'faster-whisper'], {
      PROMPTCUT_PYLIBS: PYLIBS_TEST,
    });
    const secs = (Date.now() - t0) / 1000;
    process.stdout.write(r.stdout);
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      fail(`pip install 失败(退出码 ${r.status})`);
    }
    const size = dirSize(PYLIBS_TEST);
    log(`安装耗时:${secs.toFixed(1)} 秒`);
    log(`目录体积:${mb(size)}(${PYLIBS_TEST})`);

    const tail = (r2) => (r2.stderr || '').trim().split('\n').pop();
    const IMPORT = 'import faster_whisper, sys; print(faster_whisper.__version__)';

    // 正路:PROMPTCUT_PYLIBS(site 钩子)
    const viaPylibs = runPython(['-I', '-c', IMPORT], { PROMPTCUT_PYLIBS: PYLIBS_TEST });
    log(`import(靠 PROMPTCUT_PYLIBS):${viaPylibs.status === 0 ? viaPylibs.stdout.trim() : '失败 — ' + tail(viaPylibs)}`);

    // 对照:PYTHONPATH(内置解释器上无效,记录下来备查)
    const viaEnv = runPython(['-I', '-c', IMPORT], { PYTHONPATH: PYLIBS_TEST });
    log(`import(靠 PYTHONPATH):${viaEnv.status === 0 ? viaEnv.stdout.trim() : '失败(预期如此) — ' + tail(viaEnv)}`);

    if (viaPylibs.status !== 0) fail('PROMPTCUT_PYLIBS 路径下 import 不到 faster_whisper');
    return { secs, size, version: viaPylibs.stdout.trim() };
  } finally {
    rimraf(PYLIBS_TEST); // 只是验证产物,用完就删
    log(`已删除临时目录 ${PYLIBS_TEST}`);
  }
}

/** --check:只校验,绝不下载。 */
function check() {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });

  const hasExe = fs.existsSync(PYTHON_EXE);
  add('python.exe 存在', hasExe, PYTHON_EXE);

  if (hasExe) {
    const base = runPython(['-I', '-c', BASE_LIB_PROBE]);
    add('numpy/Pillow 固定版本', base.status === 0, (base.stdout || base.stderr || '').trim());
    const r = runPython(['-I', '-c', 'import sys,pip;print(sys.version)']);
    add('import sys, pip', r.status === 0, r.status === 0 ? r.stdout.trim().replace(/\s+/g, ' ') : (r.stderr || '').trim().split('\n').pop());

    const s = runPython(['-I', '-c', 'import promptcut_stt;print(getattr(promptcut_stt,"__version__","(无 __version__)"))']);
    add(
      'import promptcut_stt',
      s.status === 0,
      s.status === 0 ? s.stdout.trim() : 'STT 包未就绪 — ' + (s.stderr || '').trim().split('\n').pop(),
    );
  } else {
    add('import sys, pip', false, '跳过(没有 python.exe)');
    add('import promptcut_stt', false, '跳过(没有 python.exe)');
  }

  const reqs = fs.existsSync(RUNTIME_PY)
    ? fs.readdirSync(RUNTIME_PY).filter((f) => /^requirements-.+.txt$/.test(f))
    : [];
  add(
    'requirements-*.txt 就位',
    reqs.length > 0,
    reqs.length ? reqs.join(', ') + ' @ ' + RUNTIME_PY : 'runtime/python 下没有,装好的软件将无法安装 STT 引擎',
  );

  const v = readVersionFile();
  add('PYTHON-VERSION.json', !!v && v.version === PYTHON_VERSION, v ? JSON.stringify(v) : '缺失');

  log('--- prepare-python --check ---');
  for (const r of results) log(`${r.ok ? '  OK ' : '  NG '} ${r.name}: ${r.detail}`);
  const allOk = results.every((r) => r.ok);
  log(allOk ? '内置 Python 已就绪。' : '内置 Python 未就绪,跑 node desktop/scripts/prepare-python.mjs 组装。');
  process.exit(allOk ? 0 : 1);
}

// ---------------------------------------------------------------- 主流程

async function build({ force }) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const existing = readVersionFile();
  const ready =
    !force &&
    existing?.version === PYTHON_VERSION &&
    fs.existsSync(PYTHON_EXE) &&
    runPython(['-I', '-c', 'import pip']).status === 0;

  let pip = existing?.pip ?? null;
  let zipSize = null;

  if (ready) {
    log(`[1/6] 已有 Python ${PYTHON_VERSION} + pip ${pip},跳过下载`);
    log('[2/6] 跳过解压(--force 可强制重装)');
    log('[3/6] 跳过 ._pth 改写');
    log('[4/6] 跳过 pip 安装');
    installPylibsHook(); // 便宜且自愈,每次都重新生成
  } else {
    const zipPath = await ensureZip();
    zipSize = fs.statSync(zipPath).size;
    extractRuntime(zipPath);
    patchPth();
    pip = await installPip();
  }

  copySttPackage();
  copyPromptcutPackages();
  installBaseLibs();
  copyRequirements();
  writeVersionFile(pip);

  log('');
  log('体积小结:');
  if (zipSize !== null) log(`  下载的 zip        ${mb(zipSize)}`);
  log(`  runtime/python    ${mb(dirSize(RUNTIME_PY))}`);
  log('');

  verifyIsolation();
  log('');
  log('内置 Python 组装完成。校验:node desktop/scripts/prepare-python.mjs --check');
}

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--check')) return check();
    if (args.includes('--verify-isolation')) return void verifyIsolation();
    if (args.includes('--verify-pip-install')) return void verifyPipInstall();
    await build({ force: args.includes('--force') });
  } catch (err) {
    fail(err?.stack || String(err));
  }
}

main();
