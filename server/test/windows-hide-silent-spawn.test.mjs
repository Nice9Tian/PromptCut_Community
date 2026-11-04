// Gatekeeper: spawning child processes in product code, scripts, probes, and desktop build
// scripts must include windowsHide: true.
// How to run: node --test server/test/windows-hide-silent-spawn.test.mjs
//
// Rule: docs/semantics/guide_files/verification.md "Windows verification silent run".
// Why guard: when the parent process has no console (e.g. vite spawned detached from a console,
// and the render worker processes it spawns in turn), child processes without windowsHide
// will open a new visible console window on Windows; this is unnoticeable when the parent has
// a console, so each newly added process-spawning call could pop up a window on some detached chain.
//
// Scan scope: server/ (excluding server/test/), the entire scripts/ directory tree (including lib,
// acceptance, probes, archive, remote), desktop/scripts/, as well as the corresponding closed-source
// cloud/server/ (excluding cloud/server/test/) and cloud/scripts/ (A3 moved hosted services, accounts,
// and Cloud Agent over there; not scanning them means leaving that entire area unguarded; the public
// repository has no cloud/, so those two items are empty sets).
// Excluded: child processes spawned by tests themselves in server/test/.
// Recognition rules: see silent-spawn-scan.mjs header; unrecognized ones will be reported, so change
// them to write windowsHide explicitly, or add them to the exception list below with a reason.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanSource, listSources } from './silent-spawn-scan.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * Exception list. Each entry: file, regex to match the hit call text, reason.
 * If an entry in the list does not match anywhere in the scan (code changed but list was not
 * updated), the test will also turn red to prevent the list from rotting.
 */
const EXEMPT = [
  { file: 'server/vite-plugin-ai.ts', match: /\bopener\b/, why: '"Open containing folder" starts File Explorer (explorer.exe): the user is meant to see this window, and windowsHide would hide it' },
  { file: 'server/vite-plugin-export.ts', match: /\bopener\b/, why: '"Open containing folder" starts File Explorer: the user is meant to see this window' },
  { file: 'server/vite-plugin-exports-list.ts', match: /\bopener\b/, why: '"Open containing folder" starts File Explorer: the user is meant to see this window' },
  { file: 'cloud/server/hosted-render/deploy.mjs', match: /node:child_process/, why: 'node -e spliced into the deploy script text and executed on the remote Linux host, not run on this machine' },
  // node-pty (pty.spawn in server/runners/agy-login.mjs) was never node:child_process to begin with,
  // and the scan does not recognize it, so no entry is needed:
  // it spawns a pseudoterminal with no Windows console window to hide.
];

/** Scanned files: forward-slash paths relative to ROOT */
function targetFiles() {
  return [
    ...listSources(ROOT, 'server', { skip: (r) => r === 'server/test' || r.startsWith('server/test/') }),
    ...listSources(ROOT, 'scripts'),
    ...listSources(ROOT, 'desktop/scripts'),
    ...(fs.existsSync(path.join(ROOT, 'cloud')) ? [
      ...listSources(ROOT, 'cloud/server', { skip: (r) => r === 'cloud/server/test' || r.startsWith('cloud/server/test/') }),
      ...listSources(ROOT, 'cloud/scripts'),
    ] : []),
  ].filter((f) => fs.existsSync(path.join(ROOT, f)));
}

function scanRepo() {
  const violations = [];
  const used = new Set();
  const files = targetFiles();
  for (const f of files) {
    const hits = scanSource(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
    for (const h of hits) {
      const idx = EXEMPT.findIndex((e) => e.file === f && e.match.test(h.fullText));
      if (idx >= 0) { used.add(idx); continue; }
      violations.push(`${f}:${h.line}  ${h.callee}  [${h.reason}]  ${h.text.replace(/\s+/g, ' ')}`);
    }
  }
  const stale = EXEMPT.filter((_e, i) => !used.has(i)).map((e) => `${e.file}  ${e.match}`);
  return { files, violations, stale };
}

test('Product code, scripts, probes and desktop build scripts all spawn child processes with windowsHide (or are on the exemption list with a reason given)', () => {
  const { files, violations } = scanRepo();
  assert.ok(files.length > 100, `Too few files scanned (${files.length}), wrong directory?`);
  assert.deepEqual(violations, [], `These process-spawning calls lack windowsHide: true, so on Windows a window pops up when the parent process has no console:\n${violations.join('\n')}`);
});

test('The exemption list has no stale entries, and every entry gives a reason', () => {
  // Entries under cloud/ only find hits when cloud/ exists; the community edition does not have this
  // directory, so those entries are not considered expired
  const hasCloud = fs.existsSync(path.join(ROOT, 'cloud'));
  const stale = scanRepo().stale.filter((s) => hasCloud || !s.startsWith('cloud/'));
  assert.deepEqual(stale, [], `These exemption list entries no longer match anything in the scan, please remove them:\n${stale.join('\n')}`);
  for (const e of EXEMPT) assert.ok(e.why && e.why.length > 8, `The exemption for ${e.file} has no reason`);
});

// ---- The scanner itself: intentionally wrote fixtures without it to prove the test turns red;
// also proves several ways of writing it with it do not false-positive ----

test('Fixture: every form that lacks windowsHide is reported', () => {
  const red = [
    ["import { spawn } from 'node:child_process';\nspawn('a', ['b']);", 1],
    ["import { spawn } from 'node:child_process';\nspawn('a', ['b'], { stdio: 'ignore' });", 1],
    ["import cp from 'node:child_process';\ncp.execFileSync('a', ['b'], {\n  cwd: 'x',\n  stdio: 'inherit',\n});", 1],
    ["import * as cp from 'child_process';\ncp.fork('w.js', [], { cwd: 'x' });", 1],
    ["const { execSync } = require('node:child_process');\nexecSync('dir');", 1],
    ["const { spawnSync } = await import('node:child_process');\nspawnSync('a');", 1],
    ["import { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nconst run = promisify(execFile);\nawait run('a', ['b']);", 1],
    ["import { spawn as sp } from 'node:child_process';\nfunction go(opts) { return sp('a', [], opts); }", 1], // Options come from parameters: unrecognized, report
    ["import { spawn } from 'node:child_process';\nconst base = { stdio: 'ignore' };\nspawn('a', [], { ...base });", 1], // Not in the spread variable
    ["import { spawn } from 'node:child_process';\nspawn('a', [], { windowsHide: false });", 1],
    ["const s = 'x=require(\"node:child_process\")';", 1], // Script text concatenated in quotes: prefer to report
  ];
  for (const [src, n] of red) assert.equal(scanSource(src, 'fixture.mjs').length, n, `Should report ${n} place(s):\n${src}`);
  assert.equal(scanSource("import { spawn } from 'node:child_process';\nspawn('a', ['b']);", 'fixture.ts').length, 1);
  // Reported line numbers match
  assert.equal(scanSource("import { spawn } from 'node:child_process';\n\n\nspawn('a');", 'f.mjs')[0].line, 4);
});

test('Fixture: forms that carry windowsHide are not falsely reported (including options written on later lines, or passed via a variable or spread)', () => {
  const green = [
    "import { spawn } from 'node:child_process';\nspawn('a', ['b'], { windowsHide: true });",
    "import { spawn } from 'node:child_process';\nspawn('a', ['b'], {\n  cwd: 'x',\n  stdio: ['ignore', 'pipe'],\n  windowsHide: true,\n});",
    "import { spawn } from 'node:child_process';\nconst opts = { cwd: 'x', windowsHide: true };\nspawn('a', [], opts);",
    "import { spawn } from 'node:child_process';\nconst base = { windowsHide: true };\nspawn('a', [], { ...base, stdio: 'ignore' });",
    "import { spawn } from 'node:child_process';\nspawn('a', [], { windowsHide: true, ...extra });",
    "import { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nconst run = promisify(execFile);\nawait run('a', [], { windowsHide: true });",
    "import cp from 'node:child_process';\ncp.spawnSync('a', [], { windowsHide: true });",
    "import pty from 'node-pty';\npty.spawn('a', []);", // Pseudoterminal is not child_process
    "import type { ChildProcess } from 'node:child_process';\nlet c: ChildProcess;",
    "const x = spawn('a');", // Ignore same-named functions if child_process is not imported
    "// Mentioning child_process in a comment does not count\nconst a = 1;",
  ];
  for (const src of green) assert.deepEqual(scanSource(src, 'fixture.ts'), [], `Should not report:\n${src}`);
});
