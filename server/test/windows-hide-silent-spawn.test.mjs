// 守门：产品代码、脚本、探针和桌面构建脚本里起子进程，必须带 windowsHide: true。
// 跑法：node --test server/test/windows-hide-silent-spawn.test.mjs
//
// 规则：docs/semantics/guide_files/verification.md「Windows 验证静默运行」。
// 为什么要守：父进程没有控制台时（vite 被脱离控制台起，它再起的渲染工作进程就是这样），
// 不带 windowsHide 的子进程会在 Windows 上新开一个可见的控制台窗口；父进程有控制台时看不出，
// 所以每新增一处起进程的调用都可能在某条脱离控制台的链上弹窗。
//
// 扫的范围：server/（不含 server/test/）、scripts/ 整个目录树（含 lib、acceptance、probes、archive、remote）、desktop/scripts/，
// 以及闭源侧对应的 cloud/server/（不含 cloud/server/test/）与 cloud/scripts/（A3 把托管、账号、云端 Agent 那几摊搬过去了，
// 不扫就等于整块不守；公开仓库里没有 cloud/，这两项是空集）。
// 其余不在其内：server/test/ 里的测试自己起的子进程。
// 认法见 silent-spawn-scan.mjs 文件头；认不出的会被报出来，改成显式写出 windowsHide，或加进下面的例外名单并写理由。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanSource, listSources } from './silent-spawn-scan.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * 例外名单。每条：文件、命中的调用文本要匹配的正则、理由。
 * 名单里的条目如果在扫描里一处也没命中（代码改了而名单没跟），测试也会红，免得名单烂掉。
 */
const EXEMPT = [
  { file: 'server/vite-plugin-ai.ts', match: /\bopener\b/, why: '「打开所在文件夹」起资源管理器（explorer.exe）：本来就要让用户看到这个窗口，windowsHide 会把它藏起来' },
  { file: 'server/vite-plugin-export.ts', match: /\bopener\b/, why: '「打开所在文件夹」起资源管理器：本来就要让用户看到这个窗口' },
  { file: 'server/vite-plugin-exports-list.ts', match: /\bopener\b/, why: '「打开所在文件夹」起资源管理器：本来就要让用户看到这个窗口' },
  { file: 'cloud/server/hosted-render/deploy.mjs', match: /node:child_process/, why: '拼进 deploy 脚本文本、在远端 Linux 上执行的 node -e，不在本机跑' },
  // node-pty（server/runners/agy-login.mjs 的 pty.spawn）本来就不是 node:child_process，扫描不认，所以不需要条目：
  // 它起的是伪终端，没有 Windows 控制台窗口可藏。
];

/** 扫的文件：相对 ROOT 的正斜杠路径 */
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

test('产品代码、脚本、探针与桌面构建脚本起子进程都带 windowsHide（或在例外名单里并写了理由）', () => {
  const { files, violations } = scanRepo();
  assert.ok(files.length > 100, `扫到的文件太少（${files.length}），目录没找对？`);
  assert.deepEqual(violations, [], `下面这些起进程的调用没带 windowsHide: true，Windows 上父进程没有控制台时会弹窗口：\n${violations.join('\n')}`);
});

test('例外名单里没有过期条目，且都写了理由', () => {
  // cloud/ 下的条目只在有 cloud/ 时才查得到命中；社区版没有这个目录，那几条不算过期
  const hasCloud = fs.existsSync(path.join(ROOT, 'cloud'));
  const stale = scanRepo().stale.filter((s) => hasCloud || !s.startsWith('cloud/'));
  assert.deepEqual(stale, [], `例外名单里这些条目在扫描里已无命中，请删掉：\n${stale.join('\n')}`);
  for (const e of EXEMPT) assert.ok(e.why && e.why.length > 8, `${e.file} 的例外没写理由`);
});

// ---- 扫描器自己：故意写没带的夹具，证明测试会红；也证明几种带了的写法不误报 ----

test('夹具：没带 windowsHide 的各种写法都被报出', () => {
  const red = [
    ["import { spawn } from 'node:child_process';\nspawn('a', ['b']);", 1],
    ["import { spawn } from 'node:child_process';\nspawn('a', ['b'], { stdio: 'ignore' });", 1],
    ["import cp from 'node:child_process';\ncp.execFileSync('a', ['b'], {\n  cwd: 'x',\n  stdio: 'inherit',\n});", 1],
    ["import * as cp from 'child_process';\ncp.fork('w.js', [], { cwd: 'x' });", 1],
    ["const { execSync } = require('node:child_process');\nexecSync('dir');", 1],
    ["const { spawnSync } = await import('node:child_process');\nspawnSync('a');", 1],
    ["import { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nconst run = promisify(execFile);\nawait run('a', ['b']);", 1],
    ["import { spawn as sp } from 'node:child_process';\nfunction go(opts) { return sp('a', [], opts); }", 1], // 选项来自参数：认不出，报
    ["import { spawn } from 'node:child_process';\nconst base = { stdio: 'ignore' };\nspawn('a', [], { ...base });", 1], // 展开的变量里没有
    ["import { spawn } from 'node:child_process';\nspawn('a', [], { windowsHide: false });", 1],
    ["const s = 'x=require(\"node:child_process\")';", 1], // 引号里拼的脚本文本：宁可报
  ];
  for (const [src, n] of red) assert.equal(scanSource(src, 'fixture.mjs').length, n, `应报 ${n} 处：\n${src}`);
  assert.equal(scanSource("import { spawn } from 'node:child_process';\nspawn('a', ['b']);", 'fixture.ts').length, 1);
  // 报出的行号对得上
  assert.equal(scanSource("import { spawn } from 'node:child_process';\n\n\nspawn('a');", 'f.mjs')[0].line, 4);
});

test('夹具：带了 windowsHide 的写法不误报（含选项写在后几行、经变量或展开传入）', () => {
  const green = [
    "import { spawn } from 'node:child_process';\nspawn('a', ['b'], { windowsHide: true });",
    "import { spawn } from 'node:child_process';\nspawn('a', ['b'], {\n  cwd: 'x',\n  stdio: ['ignore', 'pipe'],\n  windowsHide: true,\n});",
    "import { spawn } from 'node:child_process';\nconst opts = { cwd: 'x', windowsHide: true };\nspawn('a', [], opts);",
    "import { spawn } from 'node:child_process';\nconst base = { windowsHide: true };\nspawn('a', [], { ...base, stdio: 'ignore' });",
    "import { spawn } from 'node:child_process';\nspawn('a', [], { windowsHide: true, ...extra });",
    "import { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nconst run = promisify(execFile);\nawait run('a', [], { windowsHide: true });",
    "import cp from 'node:child_process';\ncp.spawnSync('a', [], { windowsHide: true });",
    "import pty from 'node-pty';\npty.spawn('a', []);", // 伪终端不是 child_process
    "import type { ChildProcess } from 'node:child_process';\nlet c: ChildProcess;",
    "const x = spawn('a');", // 没导入 child_process 的同名函数不管
    "// 说明里提到 child_process 不算\nconst a = 1;",
  ];
  for (const src of green) assert.deepEqual(scanSource(src, 'fixture.ts'), [], `不应报：\n${src}`);
});
