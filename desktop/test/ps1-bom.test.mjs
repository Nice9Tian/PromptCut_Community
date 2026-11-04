// Gatekeeper: .ps1 containing non-ASCII bytes must begin with UTF-8 BOM (EF BB BF).
//
// Why: Windows PowerShell 5.1 reads ".ps1 without BOM" by decoding with system ANSI code page,
// ignoring chcp. On Chinese Windows, the ANSI code page is GBK; UTF-8 Chinese bytes are read
// as GBK and scrambled into mojibake, quotes and parentheses in strings are swallowed, and the
// entire script fails to parse (measured: apply-patch.ps1 reported 5 errors, apply-extension.ps1 13,
// report.ps1 4; after prepending BOM, all reported 0).
// These scripts are distributed to users with installer packages / patches / extension packages,
// not just run on dev machines.
//
// .ps1 with BOM reads cleanly on both PowerShell 5.1 and 7, so the rule is across the board:
// if non-ASCII, require BOM. Pure ASCII is not required (adding it is fine, omitting it will not
// cause issues).
//
// How to run: node --test desktop/test/ps1-bom.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOM = [0xef, 0xbb, 0xbf];

const hasBom = (buf) => buf.length >= 3 && BOM.every((b, i) => buf[i] === b);
const hasNonAscii = (buf) => buf.some((b) => b > 0x7f);
/** Violation: contains non-ASCII, but has no BOM */
const violates = (buf) => hasNonAscii(buf) && !hasBom(buf);

function listPs1() {
  const ls = (args) => spawnSync('git', ['ls-files', '-z', ...args, '--', '*.ps1'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tracked = ls([]);
  assert.equal(tracked.status, 0, tracked.stderr);
  // New scripts not yet added with git add must also be blocked
  const untracked = ls(['--others', '--exclude-standard']);
  assert.equal(untracked.status, 0, untracked.stderr);
  return [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))];
}

test('predicate function: Chinese without BOM is a violation; BOM or pure ASCII is not', () => {
  const zh = Buffer.from('Write-Host "补丁"\r\n', 'utf8');
  assert.equal(violates(zh), true);
  assert.equal(violates(Buffer.concat([Buffer.from(BOM), zh])), false);
  assert.equal(violates(Buffer.from('Write-Host "patch"\r\n', 'utf8')), false);
  assert.equal(violates(Buffer.alloc(0)), false);
});

test('the enumerated .ps1 files include at least the three shipped to users in the package (the enumeration itself still works)', () => {
  const files = listPs1();
  for (const must of ['desktop/scripts/apply-patch.ps1', 'desktop/scripts/apply-extension.ps1', 'desktop/src-tauri/nsis/report.ps1']) {
    assert.ok(files.includes(must), `cannot find ${must} in git (file moved? the gatekeeper test must be updated too)`);
  }
});

test('all .ps1 files containing non-ASCII bytes start with a UTF-8 BOM (EF BB BF)', () => {
  const bad = [];
  for (const rel of listPs1()) {
    const buf = readFileSync(join(ROOT, rel));
    if (violates(buf)) bad.push(rel);
  }
  assert.deepEqual(
    bad,
    [],
    `These .ps1 files contain Chinese or other non-ASCII bytes but have no UTF-8 BOM:\n  ${bad.join('\n  ')}\n` +
      'Why this fails: on Chinese Windows, Windows PowerShell 5.1 decodes scripts without a BOM as GBK (regardless of chcp), so the whole script fails to parse.\n' +
      'What to do: add EF BB BF at the start of the file and leave the other bytes untouched (for example in node: fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), fs.readFileSync(f)])));' +
      'or remove the non-ASCII characters from the script.',
  );
});
