// Where the dev server looks for a Python interpreter and for that interpreter's site-packages
// (`findPython`, `pythonCandidates`, `sitePackagesDirs`, `buildEnv` in server/vite-plugin-stt.ts).
// Run: node --test server/test/find-python.test.mjs
//
//   PY-1  Candidates per platform: Windows looks at the bundled interpreter, then the venv's
//         Scripts\python.exe; Linux / macOS look at the venv's bin/python3, then bin/python
//   PY-2  findPython: PROMPTCUT_PYTHON wins when the file exists and is ignored when it does not;
//         each platform finds its own venv layout and not the other's; nothing there gives null
//   PY-3  site-packages: Lib\site-packages next to the interpreter on Windows,
//         lib/python3.X/site-packages beside bin/ elsewhere
//   PY-4  buildEnv: packages already in site-packages leave PYTHONPATH at the pylibs directory;
//         a missing one adds the source directory python/
//   PY-5  A real venv made by `python3 -m venv` is found and runs (skipped on Windows and where
//         python3 or its venv module is missing)
//
// The plugin is .ts and is transpiled to a temp directory first, the same pattern as
// collect-plugin.test.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-find-python-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

let src = fs.readFileSync(path.join(ROOT, 'server', 'vite-plugin-stt.ts'), 'utf8');
src = src.replace(/from (['"])(?:\.\.?\/)+i18n\.mjs\1/g, (_m, q) => `from ${q}${pathToFileURL(path.join(ROOT, 'server', 'i18n.mjs')).href}${q}`);
fs.writeFileSync(path.join(OUT, 'stt.mjs'), ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText);
const { findPython, pythonCandidates, sitePackagesDirs, buildEnv, spawnPython } = await import(pathToFileURL(path.join(OUT, 'stt.mjs')).href);

const PACKAGES = ['promptcut_stt', 'promptcut_shots', 'promptcut_track', 'promptcut_subject', 'promptcut_collect'];
let seq = 0;
const newRoot = () => { const dir = path.join(OUT, `root-${++seq}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const touch = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); return file; };

/** Run with the PROMPTCUT_* variables these functions read set as given (undefined = unset), restored afterwards */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (set) => { for (const [k, v] of Object.entries(set)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  put(vars);
  try { return await fn(); } finally { put(saved); }
}
const NO_OVERRIDES = { PROMPTCUT_PYTHON: undefined, PROMPTCUT_PYLIBS: undefined, PROMPTCUT_MODELS: undefined };

test('PY-1 candidates per platform', () => {
  const root = path.join(OUT, 'anywhere');
  assert.deepEqual(pythonCandidates(root, 'win32'), [
    path.join(root, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'),
    path.join(root, 'python', '.venv', 'Scripts', 'python.exe'),
  ]);
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(pythonCandidates(root, platform), [
      path.join(root, 'python', '.venv', 'bin', 'python3'),
      path.join(root, 'python', '.venv', 'bin', 'python'),
    ]);
  }
});

test('PY-2 findPython: the override, each platform\'s venv layout, and nothing there', async () => {
  await withEnv(NO_OVERRIDES, () => {
    assert.equal(findPython(newRoot(), 'linux'), null);
    assert.equal(findPython(newRoot(), 'win32'), null);

    // A venv as Linux / macOS lay it out
    const posix = newRoot();
    const python = touch(path.join(posix, 'python', '.venv', 'bin', 'python'));
    assert.equal(findPython(posix, 'linux'), python, 'bin/python alone is enough');
    const python3 = touch(path.join(posix, 'python', '.venv', 'bin', 'python3'));
    assert.equal(findPython(posix, 'linux'), python3, 'bin/python3 is preferred');
    assert.equal(findPython(posix, 'darwin'), python3);
    assert.equal(findPython(posix, 'win32'), null, 'Windows does not look in bin/');

    // A venv and the bundled interpreter as Windows lays them out
    const win = newRoot();
    const venvExe = touch(path.join(win, 'python', '.venv', 'Scripts', 'python.exe'));
    assert.equal(findPython(win, 'win32'), venvExe);
    assert.equal(findPython(win, 'linux'), null, 'Linux does not look in Scripts\\');
    const bundled = touch(path.join(win, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'));
    assert.equal(findPython(win, 'win32'), bundled, 'the bundled interpreter comes first');
  });

  const root = newRoot();
  const venv = touch(path.join(root, 'python', '.venv', 'bin', 'python3'));
  const chosen = touch(path.join(root, 'elsewhere', 'python'));
  await withEnv({ PROMPTCUT_PYTHON: chosen }, () => assert.equal(findPython(root, 'linux'), chosen, 'PROMPTCUT_PYTHON wins'));
  await withEnv({ PROMPTCUT_PYTHON: path.join(root, 'gone', 'python') }, () => assert.equal(findPython(root, 'linux'), venv, 'an override that does not exist is skipped'));
});

test('PY-3 where an interpreter\'s site-packages are', () => {
  const win = newRoot();
  assert.deepEqual(sitePackagesDirs(path.join(win, 'python.exe'), 'win32'), [path.join(win, 'Lib', 'site-packages')]);

  const prefix = newRoot();
  const python = touch(path.join(prefix, 'bin', 'python3'));
  assert.deepEqual(sitePackagesDirs(python, 'linux'), [], 'no lib/ beside bin/');
  fs.mkdirSync(path.join(prefix, 'lib', 'python3.12', 'site-packages'), { recursive: true });
  fs.mkdirSync(path.join(prefix, 'lib', 'pkgconfig'), { recursive: true });
  assert.deepEqual(sitePackagesDirs(python, 'linux'), [path.join(prefix, 'bin', '..', 'lib', 'python3.12', 'site-packages')].map((p) => path.normalize(p)));
  assert.deepEqual(sitePackagesDirs(python, 'darwin'), sitePackagesDirs(python, 'linux'));
});

test('PY-4 buildEnv: PYTHONPATH gets the source directory only when a package is not in site-packages', async () => {
  // Laid out for the platform the test runs on, since buildEnv reads the real one
  const root = newRoot();
  // (Windows: the bundled interpreter; elsewhere: a venv)
  const python = process.platform === 'win32'
    ? touch(path.join(root, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'))
    : touch(path.join(root, 'python', '.venv', 'bin', 'python3'));
  const site = process.platform === 'win32'
    ? path.join(root, 'desktop', 'src-tauri', 'runtime', 'python', 'Lib', 'site-packages')
    : path.join(root, 'python', '.venv', 'lib', 'python3.12', 'site-packages');
  for (const pkg of PACKAGES) fs.mkdirSync(path.join(site, pkg), { recursive: true });
  assert.deepEqual(sitePackagesDirs(python).map((p) => path.normalize(p)), [site]);

  await withEnv(NO_OVERRIDES, async () => {
    const pyLibs = path.join(root, 'out', 'pylibs');
    const all = await buildEnv(root, python);
    assert.equal(all.PYTHONPATH, pyLibs, 'everything is installed: only the pylibs directory');
    assert.equal(all.PROMPTCUT_PYLIBS, pyLibs);
    assert.equal(all.PROMPTCUT_MODELS, path.join(root, 'out', 'models'));

    fs.rmSync(path.join(site, 'promptcut_collect'), { recursive: true });
    const partial = await buildEnv(root, python);
    assert.equal(partial.PYTHONPATH, pyLibs + path.delimiter + path.join(root, 'python'), 'one is missing: the source directory is added');
  });
});

/** python3 with a working venv module, or the reason there is none */
function venvUnavailable() {
  if (process.platform === 'win32') return 'checks the bin/ layout, which Windows does not use';
  const r = spawnSync('python3', ['-c', 'import venv, ensurepip'], { encoding: 'utf8' });
  if (r.error) return 'python3 is not on PATH';
  if (r.status !== 0) return 'python3 has no venv module (on Debian / Ubuntu: the python3-venv package)';
  return false;
}

test('PY-5 a venv made by `python3 -m venv python/.venv` is found and runs', { skip: venvUnavailable() }, async () => {
  const root = newRoot();
  fs.mkdirSync(path.join(root, 'python'), { recursive: true });
  // --without-pip: the layout is what is being checked, and seeding pip takes several seconds
  const made = spawnSync('python3', ['-m', 'venv', '--without-pip', path.join(root, 'python', '.venv')], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);

  await withEnv(NO_OVERRIDES, async () => {
    const python = findPython(root);
    assert.equal(python, path.join(root, 'python', '.venv', 'bin', 'python3'));
    const [site] = sitePackagesDirs(python);
    assert.ok(site && fs.statSync(site).isDirectory(), `site-packages of the venv: ${site}`);

    // Started the way the plugins start it; the source directory is importable through PYTHONPATH
    fs.mkdirSync(path.join(root, 'python', 'promptcut_probe'));
    fs.writeFileSync(path.join(root, 'python', 'promptcut_probe', '__init__.py'), 'VALUE = 42\n');
    const env = await buildEnv(root, python);
    const child = spawnPython(python, ['-c', 'import sys, promptcut_probe; print(promptcut_probe.VALUE, sys.prefix != sys.base_prefix)'], env);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, err);
    assert.equal(out.trim(), '42 True', 'runs inside the venv and sees python/ on its path');
  });
});
