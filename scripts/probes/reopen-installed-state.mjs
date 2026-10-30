/** Backup, compare and restore the directories a really installed desktop build uses.
 * For the laptop acceptance of the system default double click: the candidate is installed over
 * the existing copy and runs on the real data directory, so the previous state is copied first
 * and put back afterwards. Nothing is ever deleted: restoring renames the current directory
 * aside and copies the backup into its place; the user removes the leftovers.
 *
 *   node scripts/probes/reopen-installed-state.mjs backup  --out <new dir> --root <name>=<dir> [--root ...] [--exclude <name>:<relative dir>]
 *   node scripts/probes/reopen-installed-state.mjs compare --backup <dir>
 *   node scripts/probes/reopen-installed-state.mjs restore --backup <dir>
 * Excluded subtrees are not copied; only their file count, size and newest time are recorded,
 * and restore moves them back unchanged. Links inside a root are refused.
 * The application must not be running: a locked file fails the command before anything moves.
 * Run restore from an ordinary terminal. A shell started by a packaged desktop application
 * (one installed under WindowsApps) sees AppData as the real directory merged with a private
 * layer; renaming a directory there moves only the private layer and leaves the real one.
 * Exit codes: 0 done or identical, 2 compare found differences, 1 refused or failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIND = 'promptcut-installed-state-v1';
const slash = rel => rel.split(path.sep).join('/');
const stamp = (now = new Date()) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function sha256(file) {
  const hash = createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** Walk one root without following links. Excluded subtrees are only summarised. */
export function scanRoot(root, excludes = [], { hash = true } = {}) {
  const top = fs.lstatSync(root);
  if (!top.isDirectory() || top.isSymbolicLink()) throw new Error(`root must be a real directory: ${root}`);
  const excluded = new Set(excludes.map(slash)), files = {}, dirs = [], links = [], summary = {};
  const summarise = dir => {
    const total = { files: 0, bytes: 0, newestMtimeMs: 0 };
    const visit = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), s = fs.lstatSync(p);
      if (s.isDirectory() && !s.isSymbolicLink()) visit(p);
      else { total.files++; total.bytes += s.size; total.newestMtimeMs = Math.max(total.newestMtimeMs, Math.floor(s.mtimeMs)); }
    } };
    visit(dir); return total;
  };
  const visit = (dir, relDir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), rel = relDir ? `${relDir}/${entry.name}` : entry.name, stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) links.push(rel);
      else if (stat.isDirectory()) { if (excluded.has(rel)) summary[rel] = summarise(full); else { dirs.push(rel); visit(full, rel); } }
      else if (stat.isFile()) files[rel] = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), ...(hash ? { sha256: sha256(full) } : {}) };
      else links.push(rel);
    }
  };
  visit(root, '');
  for (const rel of excluded) if (!(rel in summary)) summary[rel] = null;
  return { files, dirs, links, excluded: summary };
}

function copyFile(from, to, expected) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.utimesSync(to, new Date(), new Date(expected.mtimeMs));
  if (sha256(to) !== expected.sha256) throw new Error(`copy differs from its source: ${to}`);
}

export function backup({ out, roots, now = new Date() }) {
  if (fs.existsSync(out)) throw new Error(`backup directory already exists: ${out}`);
  const names = new Set();
  for (const r of roots) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(r.name) || names.has(r.name)) throw new Error(`root names must be unique short identifiers: ${r.name}`);
    names.add(r.name); r.path = fs.realpathSync(r.path);
  }
  const scanned = roots.map(r => ({ name: r.name, path: r.path, excludes: (r.excludes ?? []).map(slash), ...scanRoot(r.path, r.excludes) }));
  const linked = scanned.filter(r => r.links.length);
  if (linked.length) throw new Error(`links are not supported: ${linked.map(r => `${r.name}:${r.links.slice(0, 5).join(',')}`).join(' ')}`);
  fs.mkdirSync(out, { recursive: true });
  for (const r of scanned) {
    const target = path.join(out, r.name); fs.mkdirSync(target);
    for (const dir of r.dirs) fs.mkdirSync(path.join(target, dir), { recursive: true });
    for (const [rel, info] of Object.entries(r.files)) copyFile(path.join(r.path, rel), path.join(target, rel), info);
  }
  const manifest = { kind: KIND, createdAt: now.toISOString(), roots: scanned.map(({ links: _links, ...r }) => r) };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  return summarise(manifest);
}

const loadManifest = dir => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.kind !== KIND) throw new Error('not an installed-state backup');
  return manifest;
};
const summarise = manifest => ({ kind: manifest.kind, createdAt: manifest.createdAt, roots: manifest.roots.map(r => ({
  name: r.name, path: r.path, files: Object.keys(r.files).length, bytes: Object.values(r.files).reduce((n, f) => n + f.size, 0), excluded: r.excluded })) });

function differences(recorded, current) {
  const added = [], removed = [], changed = [];
  for (const [rel, info] of Object.entries(current.files)) {
    const before = recorded.files[rel];
    if (!before) added.push(rel); else if (before.size !== info.size || before.sha256 !== info.sha256) changed.push(rel);
  }
  for (const rel of Object.keys(recorded.files)) if (!(rel in current.files)) removed.push(rel);
  const excludedChanged = Object.keys(recorded.excluded).filter(rel => JSON.stringify(recorded.excluded[rel]) !== JSON.stringify(current.excluded[rel] ?? null));
  return { added, removed, changed, excludedChanged, links: current.links };
}

/** Read-only: what differs between the recorded state and the directories as they are now. */
export function compare({ backup: dir, sample = 40 }) {
  const manifest = loadManifest(dir);
  const roots = manifest.roots.map(r => {
    if (!fs.existsSync(r.path)) return { name: r.name, path: r.path, missing: true };
    const d = differences(r, scanRoot(r.path, r.excludes));
    return { name: r.name, path: r.path, added: d.added.length, removed: d.removed.length, changed: d.changed.length, excludedChanged: d.excludedChanged, links: d.links.length,
      sample: { added: d.added.slice(0, sample), removed: d.removed.slice(0, sample), changed: d.changed.slice(0, sample) } };
  });
  const identical = roots.every(r => !r.missing && !r.added && !r.removed && !r.changed && !r.excludedChanged.length && !r.links);
  return { identical, roots };
}

/** The executable of the nearest ancestor process that is a packaged application, or null. Windows only. */
export function packagedAncestor() {
  if (process.platform !== 'win32') return null;
  const script = String.raw`$id = ${process.pid}; for ($i = 0; $i -lt 12 -and $id; $i++) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); if (-not $p) { break }; if ($p.ExecutablePath -and $p.ExecutablePath.Contains('\WindowsApps\')) { $p.ExecutablePath; break }; $id = $p.ParentProcessId }`;
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }).trim() || null; } catch { return null; }
}
/** Roots a packaged application's child processes do not see as they really are. */
export function layeredRoots(manifest, env = process.env) {
  const inside = (dir, root) => { const rel = path.relative(dir, root); return !!dir && !rel.startsWith('..') && !path.isAbsolute(rel); };
  return manifest.roots.filter(r => (inside(env.LOCALAPPDATA, r.path) && !inside(path.join(env.LOCALAPPDATA, 'Temp'), r.path)) || inside(env.APPDATA, r.path)).map(r => r.name);
}

/** Put the recorded state back. The current directory is renamed aside, never deleted.
 * `afterRename` exists for the undo test: it runs once per root right after that root moved aside. */
export function restore({ backup: dir, now = new Date(), afterRename }) {
  const manifest = loadManifest(dir), suffix = `.reopen-candidate-${stamp(now)}`;
  // Check everything that can be checked before the first rename.
  for (const r of manifest.roots) {
    const copy = scanRoot(path.join(dir, r.name));
    const d = differences({ files: r.files, excluded: {} }, { ...copy, excluded: {} });
    if (d.added.length || d.removed.length || d.changed.length || copy.links.length) throw new Error(`backup copy of ${r.name} no longer matches its manifest`);
    if (!fs.existsSync(r.path)) throw new Error(`current directory is missing: ${r.path}`);
    if (fs.existsSync(r.path + suffix)) throw new Error(`aside directory already exists: ${r.path + suffix}`);
  }
  const moved = [], done = [];
  try {
    for (const r of manifest.roots) {
      const aside = r.path + suffix, source = path.join(dir, r.name);
      fs.renameSync(r.path, aside);
      // In a layered view the rename succeeds and the directory is still there. Nothing can be undone from here.
      if (fs.existsSync(r.path)) throw Object.assign(new Error(`${r.path} is still there after it was renamed to ${aside}: this process sees more than the real directory. Run the restore from an ordinary terminal`), { layered: true });
      moved.push({ root: r, aside });
      afterRename?.(r);
      fs.mkdirSync(r.path);
      for (const sub of r.dirs) fs.mkdirSync(path.join(r.path, sub), { recursive: true });
      for (const [rel, info] of Object.entries(r.files)) copyFile(path.join(source, rel), path.join(r.path, rel), info);
      for (const rel of r.excludes) {
        const kept = path.join(aside, rel);
        if (fs.existsSync(kept)) { fs.mkdirSync(path.dirname(path.join(r.path, rel)), { recursive: true }); fs.renameSync(kept, path.join(r.path, rel)); }
      }
      done.push({ name: r.name, path: r.path, aside });
    }
  } catch (error) {
    // Undo by renaming only: the partial copy is kept beside the original for inspection.
    const undone = [];
    for (const { root: r, aside } of moved.reverse()) {
      try {
        for (const rel of r.excludes) {
          const back = path.join(r.path, rel);
          if (fs.existsSync(back) && !fs.existsSync(path.join(aside, rel))) fs.renameSync(back, path.join(aside, rel));
        }
        if (fs.existsSync(r.path)) fs.renameSync(r.path, `${r.path}.reopen-failed-${stamp(now)}`);
        fs.renameSync(aside, r.path); undone.push(r.name);
      } catch (inner) { error.message += `; could not undo ${r.name}: ${inner.message}`; }
    }
    error.message += `; undone: ${undone.join(',') || 'nothing'}`;
    throw error;
  }
  // Excluded subtrees were moved back as they are; a change inside them is reported, not an error.
  const verified = compare({ backup: dir });
  const differing = verified.roots.filter(r => r.missing || r.added || r.removed || r.changed || r.links);
  if (differing.length) throw new Error(`restored state differs from the backup manifest: ${JSON.stringify(differing.map(r => ({ name: r.name, added: r.added, removed: r.removed, changed: r.changed })))}`);
  return { restored: done, identical: true, excludedChanged: verified.roots.flatMap(r => r.excludedChanged.map(rel => `${r.name}:${rel}`)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = name => process.argv.flatMap((a, i) => (a === name ? [process.argv[i + 1]] : []));
  const one = name => all(name)[0];
  try {
    const command = process.argv[2];
    if (command === 'backup') {
      const excludes = all('--exclude').map(x => { const at = x.indexOf(':'); return { name: x.slice(0, at), rel: x.slice(at + 1) }; });
      const roots = all('--root').map(x => { const at = x.indexOf('='); const name = x.slice(0, at); return { name, path: x.slice(at + 1), excludes: excludes.filter(e => e.name === name).map(e => e.rel) }; });
      if (!one('--out') || !roots.length) throw new Error('backup needs --out <new directory> and at least one --root <name>=<directory>');
      console.log(JSON.stringify({ ok: true, backup: path.resolve(one('--out')), ...backup({ out: path.resolve(one('--out')), roots }) }));
    } else if (command === 'compare') {
      const result = compare({ backup: path.resolve(one('--backup')) });
      console.log(JSON.stringify({ ok: true, ...result })); process.exitCode = result.identical ? 0 : 2;
    } else if (command === 'restore') {
      const dir = path.resolve(one('--backup')), layered = layeredRoots(loadManifest(dir)), ancestor = layered.length ? packagedAncestor() : null;
      if (ancestor) throw new Error(`this shell was started by a packaged application (${path.basename(ancestor)}), which sees ${layered.join(', ')} through a layered view of AppData; run the same command from an ordinary terminal`);
      console.log(JSON.stringify({ ok: true, ...restore({ backup: dir }) }));
    } else throw new Error('usage: reopen-installed-state.mjs backup|compare|restore');
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
