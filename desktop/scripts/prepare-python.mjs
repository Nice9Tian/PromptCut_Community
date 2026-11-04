#!/usr/bin/env node
/**
 * prepare-python.mjs: Assembles the "embedded Python" distributed with the package.
 *
 * Source: Windows embeddable package from official python.org FTP
 *   https://www.python.org/ftp/python/<version>/python-<version>-embed-amd64.zip
 * pip bootstrap script source:
 *   https://bootstrap.pypa.io/get-pip.py
 *
 * Artifacts: desktop/src-tauri/runtime/python/
 *   python.exe / python311.zip / python311._pth / Lib/site-packages/{pip,promptcut_stt}
 *   PYTHON-VERSION.json  {version, pip, builtAt}
 * Cache: desktop/.cache/ (downloads; both directories are in .gitignore)
 *
 * Usage:
 *   node desktop/scripts/prepare-python.mjs
 *       Assembles (idempotent: if already prepared and versions match, skips download and
 *       extraction, refreshing only STT packages and the version file); automatically runs
 *       an isolation verification on completion.
 *   node desktop/scripts/prepare-python.mjs --force
 *       Ignores existing artifacts, forcing re-extraction and reinstalling pip.
 *   node desktop/scripts/prepare-python.mjs --check
 *       Verifies only, never downloads. Checks that python.exe exists, `-I -c "import sys,pip"`
 *       succeeds, and promptcut_stt can be imported. Exit code 0 if all pass, otherwise 1.
 *   node desktop/scripts/prepare-python.mjs --verify-isolation
 *       Runs isolation verification only: sys.path must not contain paths outside the embedded
 *       directory, and tests the actual effect of PYTHONPATH on the embedded interpreter
 *       (see python/README.md for conclusions).
 *   node desktop/scripts/prepare-python.mjs --verify-pip-install
 *       Runs online library installation verification only:
 *       pip install --target desktop/.cache/pylibs-test faster-whisper,
 *       deletes the temporary directory after verifying import. Connects to network and takes time.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- Constants

/** Version of the Windows embeddable package (latest in 3.11 series). */
const PYTHON_VERSION = '3.11.9';

/** Windows x64 embeddable zip from official python.org FTP. */
const PYTHON_ZIP_URL =
  `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const PYTHON_ZIP_NAME = `python-${PYTHON_VERSION}-embed-amd64.zip`;

/** pip bootstrap script (official pypa). */
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const GET_PIP_NAME = 'get-pip.py';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root: desktop/scripts → desktop → root */
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

// ---------------------------------------------------------------- Utilities

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
          /* File disappeared while gathering statistics, ignore */
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
 * Copies python/promptcut_* into site-packages. **Allowlist**, not blocklist.
 *
 * These directories go into the installer as-is to be shipped to all users, yet they also serve
 * as development directories: if anyone leaves a .env, model weights, or a large debug file
 * inside, it will be shipped along with them. Previously only __pycache__ and .pyc were blocked,
 * which was equivalent to "ship everything except these two". The allowlist hardcodes what the
 * package should contain: code, manifests, and licenses. If other types really need to be added
 * (such as in-package data files), add an explicit entry here; do not turn the gate back into
 * a blocklist.
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
  if (!res.ok) throw new Error(`Download failed ${res.status} ${res.statusText}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

// ---------------------------------------------------------------- zip extraction
// Windows has no unzip; here we use node's built-in zlib to parse the zip central directory
// and inflateRaw, without relying on PowerShell or any npm package.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** Parses zip central directory and returns entry list; throws error if zip is corrupted. */
function readZipEntries(buf) {
  let eocd = -1;
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid zip: EOCD record not found');

  const count = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (cenOffset === 0xffffffff || cenSize === 0xffffffff || count === 0xffff) {
    throw new Error('zip64 archives are not supported');
  }

  const entries = [];
  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`Bad signature in zip central directory entry ${i}`);
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
  if (p > cenOffset + cenSize + 4) throw new Error('zip central directory length does not match the EOCD record');
  return entries;
}

/** Extracts raw bytes of an entry (store / deflate). */
function readZipEntryData(buf, entry) {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) {
    throw new Error(`Bad zip local header signature: ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported zip compression method ${entry.method}: ${entry.name}`);
}

/** Verifies whether cached zip can be extracted properly (complete entries + matching CRC). */
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
      throw new Error(`Out-of-bounds path in zip: ${e.name}`);
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

// ---------------------------------------------------------------- Run embedded interpreter

/**
 * Runs the embedded interpreter. env retains only necessary system variables, overlaid with
 * extraEnv, so verification results are unaffected by leftover PYTHON* variables in the current
 * shell.
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
    throw new Error(`Interpreter failed to start (exit code ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return JSON.parse(r.stdout.trim());
}

const underRuntime = (entry) => {
  if (!entry) return true; // Empty string = current directory; not added under -I, allowed just to be safe
  const norm = path.resolve(entry).toLowerCase();
  return norm === RUNTIME_PY.toLowerCase() || norm.startsWith(RUNTIME_PY.toLowerCase() + path.sep);
};

// ---------------------------------------------------------------- Steps

async function ensureZip() {
  const zipPath = path.join(CACHE_DIR, PYTHON_ZIP_NAME);
  if (fs.existsSync(zipPath)) {
    if (zipIsValid(zipPath)) {
      log(`[1/6] Reusing cached embeddable package ${PYTHON_ZIP_NAME} (${mb(fs.statSync(zipPath).size)})`);
      return zipPath;
    }
    warn(`Extraction check failed for ${PYTHON_ZIP_NAME} in the cache, deleting and re-downloading`);
    fs.rmSync(zipPath, { force: true });
  }
  log(`[1/6] Downloading ${PYTHON_ZIP_URL}`);
  const size = await download(PYTHON_ZIP_URL, zipPath);
  if (!zipIsValid(zipPath)) {
    fs.rmSync(zipPath, { force: true });
    throw new Error('The downloaded zip cannot be extracted and was deleted; please retry');
  }
  log(`      Download complete: ${mb(size)}`);
  return zipPath;
}

function extractRuntime(zipPath) {
  // Idempotent: removes old interpreter before reinstalling to avoid leftover files from previous version
  rimraf(RUNTIME_PY);
  const n = extractZip(zipPath, RUNTIME_PY);
  if (!fs.existsSync(PYTHON_EXE)) throw new Error('python.exe not found after extraction');
  const size = dirSize(RUNTIME_PY);
  log(`[2/6] Extracting to runtime/python (${n} entries, ${mb(size)} after extraction)`);
  return size;
}

function pthFile() {
  const hits = fs.readdirSync(RUNTIME_PY).filter((f) => f.endsWith('._pth'));
  if (hits.length !== 1) throw new Error(`runtime/python should contain exactly one ._pth, found ${hits.length}`);
  return path.join(RUNTIME_PY, hits[0]);
}

/** Retains pythonXY.zip and ., appends Lib\site-packages, and enables import site. Idempotent. */
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
    if (line.startsWith('#')) continue; // Comments (including `#import site`) do not contribute to paths and are discarded uniformly
    if (line === 'import site') continue; // Added back uniformly below
    push(line);
  }
  push('Lib\\site-packages');
  out.push('');
  out.push('import site');
  const content = out.join('\r\n') + '\r\n';
  fs.writeFileSync(file, content, 'utf8');
  log(`[3/6] Rewriting ${path.basename(file)}: ${out.filter(Boolean).join(' | ')}`);
}

async function installPip() {
  const getPip = path.join(CACHE_DIR, GET_PIP_NAME);
  if (fs.existsSync(getPip) && fs.statSync(getPip).size > 100_000) {
    log(`[4/6] Reusing cached get-pip.py (${mb(fs.statSync(getPip).size)})`);
  } else {
    log(`[4/6] Downloading ${GET_PIP_URL}`);
    await download(GET_PIP_URL, getPip);
  }
  const r = runPython([getPip, '--no-warn-script-location']);
  if (r.status !== 0) {
    throw new Error(`get-pip.py failed (exit code ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  const v = pipVersion();
  installPylibsHook();
  log(`      pip installed: ${v} (after adding pip: ${mb(dirSize(RUNTIME_PY))})`);
  return v;
}

/**
 * Installs the site hook for PROMPTCUT_PYLIBS.
 *
 * Why it is needed: the `._pth` file in the embeddable package completely takes over path
 * calculation, ignoring PYTHONPATH; and `-I` (= `-E -s`) itself also ignores PYTHON* variables
 * including PYTHONPATH. Therefore, "online installed library directories" cannot be injected via
 * PYTHONPATH. Fortunately, `import site` is enabled in `._pth`, so `.pth` files under
 * site-packages get executed: using a single-line `.pth` at startup to read PROMPTCUT_PYLIBS and
 * append it to sys.path takes effect consistently across all entry points (`-m promptcut_stt`,
 * `-m pip`, `-c ...`) without requiring coordination from the STT package. Does nothing if the
 * variable is unset or the directory does not exist, keeping the installation directory read-only.
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
  log(`      site hook: ${path.basename(file)} (PROMPTCUT_PYLIBS → sys.path)`);
}

function pipVersion() {
  const r = runPython(['-I', '-m', 'pip', '--version']);
  if (r.status !== 0) return null;
  const m = r.stdout.match(/^pip\s+(\S+)/);
  return m ? m[1] : r.stdout.trim();
}

/**
 * Copies python/requirements-<engine>.txt to runtime/python/.
 *
 * find_requirements() in promptcut_stt searches across four locations: during development it is
 * the parent directory of the package (python/); once installed in site-packages, the parent is
 * no longer python/, so it searches sys.prefix: after packaging, sys.prefix is precisely
 * runtime/python. Previously, only the promptcut_stt package itself was copied, so these two files
 * were never included in the package, causing clicks on "Install engine" in the installed app to
 * inevitably fail with "requirements file not found".
 */
function copyRequirements() {
  const srcDir = path.join(SOURCE_ROOT, 'python');
  if (!fs.existsSync(srcDir)) return [];
  const files = fs.readdirSync(srcDir).filter((f) => /^requirements-.+.txt$/.test(f));
  for (const f of files) fs.copyFileSync(path.join(srcDir, f), path.join(RUNTIME_PY, f));
  if (files.length) log(`[5/6] Copying ${files.join(', ')} → runtime/python`);
  else warn('[5/6] No requirements-*.txt under python/, the speech-to-text engine cannot be installed.');
  return files;
}

function copySttPackage() {
  if (!fs.existsSync(STT_SRC)) {
    warn(`[5/6] python/promptcut_stt/ does not exist yet, skipping copy.`);
    warn(`      The STT package is maintained elsewhere; rerun this script once it is in place. --check treats this case as "not ready".`);
    return false;
  }
  rimraf(STT_DST);
  copyDir(STT_SRC, STT_DST);
  log(`[5/6] Copying promptcut_stt → Lib/site-packages (${mb(dirSize(STT_DST))})`);
  return true;
}

/**
 * Copies **all** promptcut_* packages under python/ into site-packages.
 *
 * Previously only promptcut_stt was copied. No issues were visible during development: buildEnv
 * on the vite side temporarily mirrored missing packages into pylibs, but **the release package
 * has no python/ source directory**, making that mirrored path completely unreachable, so shot
 * detection and motion tracking in the installed app failed directly with No module named. Having
 * to edit here every time a package is added was too error-prone, so we scan by prefix instead.
 */
function copyPromptcutPackages() {
  const srcDir = path.join(SOURCE_ROOT, 'python');
  if (!fs.existsSync(srcDir)) return [];
  const pkgs = fs.readdirSync(srcDir).filter(
    (f) => f.startsWith('promptcut_')
      && f !== 'promptcut_stt'  // Already handled separately above
      && fs.statSync(path.join(srcDir, f)).isDirectory(),
  );
  for (const pkg of pkgs) {
    const dst = path.join(SITE_PACKAGES, pkg);
    rimraf(dst);
    copyDir(path.join(srcDir, pkg), dst);
    log(`[5/6] Copying ${pkg} → Lib/site-packages (${mb(dirSize(dst))})`);
  }
  if (!pkgs.length) warn('[5/6] No other promptcut_* packages under python/.');
  return pkgs;
}

/**
 * The base runtime bundles numpy and Pillow, directly usable by card pixel algorithms.
 *
 * Why numpy is worth including in the base package while torch is not: the **fallback tier** of
 * motion tracking (template matching) runs on numpy alone, whereas the extension package is
 * 190 MB torch + 208 MB weights. Most users will not install extensions at first, and "cannot
 * track" versus "tracking roughly" are two completely different things to them. numpy is around
 * 15 MB; getting this feature out of the box in exchange is well worth it.
 *
 * Installed into site-packages instead of pylibs: pylibs is the domain of extension packages and
 * gets cleared when users uninstall extensions; basic capabilities must not disappear with it.
 */
const BASE_LIBS = ['numpy==2.2.6', 'Pillow==12.3.0'];
const BASE_LIB_PROBE = 'import numpy, PIL, sys; assert numpy.__version__ == "2.2.6"; assert PIL.__version__ == "12.3.0"; sys.stdout.write("numpy " + numpy.__version__ + ", Pillow " + PIL.__version__)';

function installBaseLibs() {
  const probe = runPython(['-I', '-c', BASE_LIB_PROBE]);
  if (probe.status === 0) {
    log(`[5/6] Base libraries already in place: ${probe.stdout.trim()}`);
    return true;
  }
  log(`[5/6] Installing base libraries ${BASE_LIBS.join(', ')} → Lib/site-packages`);
  const r = runPython(
    ['-I', '-m', 'pip', 'install', '--only-binary=:all:', '--upgrade', '--no-warn-script-location',
     '--target', SITE_PACKAGES, ...BASE_LIBS],
    {}, { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    throw new Error('Base card dependency installation failed; cannot ship a runtime without numpy/Pillow.');
  }
  const after = runPython(['-I', '-c', BASE_LIB_PROBE]);
  if (after.status !== 0) {
    throw new Error('Verification failed after installing base dependencies; check the site-packages setting in ._pth.');
  }
  log(`[5/6] ${after.stdout.trim()} in place`);
  return true;
}

function writeVersionFile(pip) {
  const data = { version: PYTHON_VERSION, pip, builtAt: new Date().toISOString() };
  fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  log(`[6/6] Writing PYTHON-VERSION.json: ${JSON.stringify(data)}`);
  return data;
}

function readVersionFile() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Verification

/** Isolation verification: sys.path must not go out of bounds, and tests the actual effect of PYTHONPATH. */
function verifyIsolation() {
  if (!fs.existsSync(PYTHON_EXE)) fail('Bundled Python is not ready, run node desktop/scripts/prepare-python.mjs first');

  log('--- Isolation check ---');
  const base = pythonPathList();
  log(`sys.path (python.exe -I):`);
  for (const p of base) log(`  ${p || '(empty string)'}`);
  const stray = base.filter((p) => !underRuntime(p));
  if (stray.length) {
    fail(`sys.path contains paths outside the bundled directory, isolation failed:\n  ${stray.join('\n  ')}`);
  }
  log(`OK: all ${base.length} entries are inside ${RUNTIME_PY}, no system Python directories.`);

  // Step 2: Library directory probe. Check whether PROMPTCUT_PYLIBS (site hook) or PYTHONPATH
  // actually takes effect.
  rimraf(ISOLATION_PROBE);
  fs.mkdirSync(ISOLATION_PROBE, { recursive: true });
  const hit = (list) =>
    list.some((p) => p && path.resolve(p).toLowerCase() === ISOLATION_PROBE.toLowerCase());
  try {
    const viaPylibs = pythonPathList({ PROMPTCUT_PYLIBS: ISOLATION_PROBE });
    const viaPythonPath = pythonPathList({ PYTHONPATH: ISOLATION_PROBE });
    const viaPythonPathNoI = pythonPathList({ PYTHONPATH: ISOLATION_PROBE }, []);

    log('');
    log(`sys.path (PROMPTCUT_PYLIBS=${ISOLATION_PROBE}, with -I):`);
    for (const p of viaPylibs) log(`  ${p || '(empty string)'}`);
    log(`  → PROMPTCUT_PYLIBS effective: ${hit(viaPylibs) ? 'yes' : 'no'}`);
    log(`  → PYTHONPATH effective (with -I): ${hit(viaPythonPath) ? 'yes' : 'no'}`);
    log(`  → PYTHONPATH effective (without -I): ${hit(viaPythonPathNoI) ? 'yes' : 'no'}`);

    const strayEnv = [...viaPylibs, ...viaPythonPath, ...viaPythonPathNoI].filter(
      (p) => !underRuntime(p) && !hit([p]),
    );
    if (strayEnv.length) {
      fail(`With the environment variable set, sys.path must still not gain other paths, but found:\n  ${strayEnv.join('\n  ')}`);
    }

    if (!hit(viaPylibs)) {
      fail('PROMPTCUT_PYLIBS did not make it into sys.path; the site hook promptcut_pylibs.pth may be missing or corrupted.');
    }
    log('');
    log('Conclusion: the directory PROMPTCUT_PYLIBS points to appears at the end of sys.path, which is where libraries installed online go');
    log('      How it gets found: via promptcut_pylibs.pth in site-packages, not via PYTHONPATH.');
    if (!hit(viaPythonPath) && !hit(viaPythonPathNoI)) {
      log('      PYTHONPATH has no effect on the bundled interpreter: the ._pth file takes over path computation entirely, and -I (= -E -s)');
      log('      also ignores PYTHON* variables. This is expected, not a fault.');
    }
    return { pylibs: hit(viaPylibs), pythonpath: hit(viaPythonPath) };
  } finally {
    rimraf(ISOLATION_PROBE);
  }
}

/** Online library installation verification: pip install --target to a temporary directory, then import. */
function verifyPipInstall() {
  if (!fs.existsSync(PYTHON_EXE)) fail('Bundled Python is not ready, run node desktop/scripts/prepare-python.mjs first');

  log('--- Online library install check (faster-whisper) ---');
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
      fail(`pip install failed (exit code ${r.status})`);
    }
    const size = dirSize(PYLIBS_TEST);
    log(`Install took: ${secs.toFixed(1)} s`);
    log(`Directory size: ${mb(size)} (${PYLIBS_TEST})`);

    const tail = (r2) => (r2.stderr || '').trim().split('\n').pop();
    const IMPORT = 'import faster_whisper, sys; print(faster_whisper.__version__)';

    // Normal path: PROMPTCUT_PYLIBS (site hook)
    const viaPylibs = runPython(['-I', '-c', IMPORT], { PROMPTCUT_PYLIBS: PYLIBS_TEST });
    log(`import (via PROMPTCUT_PYLIBS): ${viaPylibs.status === 0 ? viaPylibs.stdout.trim() : 'failed: ' + tail(viaPylibs)}`);

    // Control: PYTHONPATH (ineffective on embedded interpreter, recorded for reference)
    const viaEnv = runPython(['-I', '-c', IMPORT], { PYTHONPATH: PYLIBS_TEST });
    log(`import (via PYTHONPATH): ${viaEnv.status === 0 ? viaEnv.stdout.trim() : 'failed (expected): ' + tail(viaEnv)}`);

    if (viaPylibs.status !== 0) fail('Cannot import faster_whisper under the PROMPTCUT_PYLIBS path');
    return { secs, size, version: viaPylibs.stdout.trim() };
  } finally {
    rimraf(PYLIBS_TEST); // Only a verification artifact, deleted after use
    log(`Deleted temp directory ${PYLIBS_TEST}`);
  }
}

/** --check: verify only, never download. */
function check() {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });

  const hasExe = fs.existsSync(PYTHON_EXE);
  add('python.exe exists', hasExe, PYTHON_EXE);

  if (hasExe) {
    const base = runPython(['-I', '-c', BASE_LIB_PROBE]);
    add('numpy/Pillow pinned versions', base.status === 0, (base.stdout || base.stderr || '').trim());
    const r = runPython(['-I', '-c', 'import sys,pip;print(sys.version)']);
    add('import sys, pip', r.status === 0, r.status === 0 ? r.stdout.trim().replace(/\s+/g, ' ') : (r.stderr || '').trim().split('\n').pop());

    const s = runPython(['-I', '-c', 'import promptcut_stt;print(getattr(promptcut_stt,"__version__","(no __version__)"))']);
    add(
      'import promptcut_stt',
      s.status === 0,
      s.status === 0 ? s.stdout.trim() : 'STT package not ready: ' + (s.stderr || '').trim().split('\n').pop(),
    );
  } else {
    add('import sys, pip', false, 'skipped (no python.exe)');
    add('import promptcut_stt', false, 'skipped (no python.exe)');
  }

  const reqs = fs.existsSync(RUNTIME_PY)
    ? fs.readdirSync(RUNTIME_PY).filter((f) => /^requirements-.+.txt$/.test(f))
    : [];
  add(
    'requirements-*.txt in place',
    reqs.length > 0,
    reqs.length ? reqs.join(', ') + ' @ ' + RUNTIME_PY : 'not found under runtime/python, so the installed app will be unable to install the STT engine',
  );

  const v = readVersionFile();
  add('PYTHON-VERSION.json', !!v && v.version === PYTHON_VERSION, v ? JSON.stringify(v) : 'missing');

  log('--- prepare-python --check ---');
  for (const r of results) log(`${r.ok ? '  OK ' : '  NG '} ${r.name}: ${r.detail}`);
  const allOk = results.every((r) => r.ok);
  log(allOk ? 'Bundled Python is ready.' : 'Bundled Python is not ready, run node desktop/scripts/prepare-python.mjs to assemble it.');
  process.exit(allOk ? 0 : 1);
}

// ---------------------------------------------------------------- Main flow

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
    log(`[1/6] Python ${PYTHON_VERSION} + pip ${pip} already present, skipping download`);
    log('[2/6] Skipping extraction (--force to force a reinstall)');
    log('[3/6] Skipping ._pth rewrite');
    log('[4/6] Skipping pip install');
    installPylibsHook(); // Cheap and self-healing, regenerate every time
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
  log('Size summary:');
  if (zipSize !== null) log(`  downloaded zip    ${mb(zipSize)}`);
  log(`  runtime/python    ${mb(dirSize(RUNTIME_PY))}`);
  log('');

  verifyIsolation();
  log('');
  log('Bundled Python assembled. Verify with: node desktop/scripts/prepare-python.mjs --check');
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
