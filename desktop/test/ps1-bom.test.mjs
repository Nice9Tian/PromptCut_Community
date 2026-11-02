// 守门：含非 ASCII 字节的 .ps1 必须以 UTF-8 BOM（EF BB BF）开头。
//
// 为什么：Windows PowerShell 5.1 读「不带 BOM 的 .ps1」按系统 ANSI 代码页解码，不看 chcp。
// 中文 Windows 的 ANSI 代码页是 GBK，UTF-8 的中文字节被当成 GBK 读，碎成乱码，
// 字符串里的引号、括号会被吃掉，整份脚本解析失败（实测：apply-patch.ps1 报 5 个错，
// apply-extension.ps1 13 个，report.ps1 4 个；前面加上 BOM 后都是 0 个）。
// 这几份脚本随安装包 / 补丁 / 扩展包发给用户，不是只在开发机上跑。
//
// 带 BOM 的 .ps1 在 PowerShell 5.1 和 7 上都能正常读，所以规则一刀切：有非 ASCII 就要 BOM。
// 纯 ASCII 的不要求（加了也行，不加也不会出事）。
//
// 跑法：node --test desktop/test/ps1-bom.test.mjs
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
/** 违规：含非 ASCII，却没有 BOM */
const violates = (buf) => hasNonAscii(buf) && !hasBom(buf);

function listPs1() {
  const ls = (args) => spawnSync('git', ['ls-files', '-z', ...args, '--', '*.ps1'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tracked = ls([]);
  assert.equal(tracked.status, 0, tracked.stderr);
  // 还没 git add 的新脚本也要拦
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
