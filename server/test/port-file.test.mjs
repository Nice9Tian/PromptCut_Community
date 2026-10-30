/**
 * 守门：测试与探针起的编辑器不写公共的 `%TEMP%\promptcut\port.json`。
 *
 * 编辑器一起来就把端口写进这个文件（`server/vite-plugin-ai.ts`），用户会话里的 PromptCut MCP 服务
 * （`server/mcp-server.mjs`）按它找编辑器。探针起的编辑器写了它，会把用户的 MCP 工具调用引到探针那台上；
 * 2026-09-29 反方向出过一次：`ready-index-probe --port 5693` 把它写成 5693，之后 `c10-ui-probe` 的代理开在 5693，
 * 收到了本机 MCP 客户端的 `/api/mcp/call`，A7 误挂。
 *
 * 做法：`PROMPTCUT_NO_PORT_FILE=1` 时编辑器不写；探针的公共入口 `scripts/lib/no-user-dirs.mjs` 与
 * `npm test` 的全局准备设上它（`scripts/lib/user-dirs.mjs` 的 `markNoPortFile`）。这里守：
 *   1. `markNoPortFile` 本身，以及引入 `no-user-dirs.mjs` 的进程和它的子进程真的带上了这个变量；
 *   2. `npm test` 的全局准备设了它；
 *   3. `vite-plugin-ai.ts` 认它，而且在写文件之前就返回；
 *   4. `scripts/` 下每个起编辑器（默认配置的 vite dev server）的脚本都带上它：第一个 import 是
 *      `no-user-dirs.mjs`，或者起进程时显式设；产品入口另有办法（渲染主机）；
 *   5. 桌面版与 `npm run dev` 不设它，照旧写。
 * 只读仓库文件、起一个不连网的 node 子进程，不碰公共的 port.json。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_PORT_FILE_ENV, markNoPortFile } from '../../scripts/lib/user-dirs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('port-file:markNoPortFile 设成 1,返回原值', () => {
  assert.equal(NO_PORT_FILE_ENV, 'PROMPTCUT_NO_PORT_FILE');
  const env = { PATH: 'p' };
  assert.equal(markNoPortFile(env), undefined);
  assert.deepEqual(env, { PATH: 'p', PROMPTCUT_NO_PORT_FILE: '1' });
  const env2 = { PROMPTCUT_NO_PORT_FILE: '0' };
  assert.equal(markNoPortFile(env2), '0', '外面设成 0 也改成 1:探针不写公共的 port.json');
  assert.equal(env2.PROMPTCUT_NO_PORT_FILE, '1');
});

test('port-file:引入 no-user-dirs.mjs 的进程和它 { ...process.env } 起的子进程都带 PROMPTCUT_NO_PORT_FILE=1', () => {
  const lib = pathToFileURL(path.join(REPO, 'scripts', 'lib', 'no-user-dirs.mjs')).href;
  const script = [
    `await import(${JSON.stringify(lib)});`,
    `const { spawnSync } = await import('node:child_process');`,
    `const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.PROMPTCUT_NO_PORT_FILE))'], { env: { ...process.env }, encoding: 'utf8' });`,
    `process.stdout.write(JSON.stringify({ self: process.env.PROMPTCUT_NO_PORT_FILE, child: r.stdout }));`,
  ].join('\n');
  const env = { ...process.env };
  delete env.PROMPTCUT_NO_PORT_FILE;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { self: '1', child: '1' });
});

test('port-file:npm test 的全局准备设了 PROMPTCUT_NO_PORT_FILE=1', () => {
  const src = read('server/test/global-setup.mjs');
  const body = src.slice(src.indexOf('export async function globalSetup'));
  assert.match(body.slice(0, body.indexOf('\n}')), /markNoPortFile\(process\.env\)/, 'globalSetup 里要设本进程的环境');
  // 在全局准备之下运行时(它设的 PROMPTCUT_TEST_BAD_PORTS_HELD 在),本进程已经带上
  if (process.env.PROMPTCUT_TEST_BAD_PORTS_HELD !== undefined) {
    assert.equal(process.env.PROMPTCUT_NO_PORT_FILE, '1');
  }
});

test('port-file:vite-plugin-ai.ts 认 PROMPTCUT_NO_PORT_FILE=1,在写 port.json 之前返回', () => {
  const src = read('server/vite-plugin-ai.ts');
  const at = src.indexOf("httpServer?.on('listening'");
  assert.ok(at > 0, '找不到写 port.json 的 listening 回调');
  const write = src.indexOf("'port.json'", at);
  assert.ok(write > at, 'listening 回调里找不到写 port.json 的地方');
  const guard = src.slice(at, write);
  assert.match(guard, /process\.env\.PROMPTCUT_NO_PORT_FILE === '1'[^\n]*\)\s*return;/, '写文件之前要按 PROMPTCUT_NO_PORT_FILE 返回');
  assert.equal(src.split("'port.json'").length - 1, 1, 'vite-plugin-ai.ts 里只有一处写 port.json');
});

/** 起一台默认配置(vite.config.ts,带 vite-plugin-ai)的 dev server:`<vite 入口>, '--port'` */
const STARTS_EDITOR = /(?:viteBin\(\)|viteBin|vite\.js['"]|\bbin\b|['"]vite['"])\s*,\s*['"]--port['"]/;
/** 同进程 createServer 用了带 vite-plugin-ai 的配置(不是 configFile:false、不是 vite.prerender.config.ts) */
const IN_PROCESS_EDITOR = /createServer\(\{\s*configFile\s*:\s*(?!false\b)(?![^}\n]*prerender)/;

/** 产品入口:不引 no-user-dirs.mjs,用自己的办法不写公共的 port.json */
const PRODUCT_ENTRIES = new Map([
  ['cloud/scripts/render-host.mjs', /TEMP/],
]);

function listMjs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'archive' && e.name !== 'node_modules') listMjs(p, out); }
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('port-file:scripts/ 下起编辑器的脚本都带 PROMPTCUT_NO_PORT_FILE=1', () => {
  const offenders = [];
  const checked = [];
  for (const file of listMjs(path.join(REPO, 'scripts'))) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    if (!STARTS_EDITOR.test(src) && !IN_PROCESS_EDITOR.test(src)) continue;
    checked.push(rel);
    if (PRODUCT_ENTRIES.has(rel)) {
      if (!PRODUCT_ENTRIES.get(rel).test(src)) offenders.push(`${rel}:产品入口,却没看到它自己的不写办法`);
      continue;
    }
    const first = src.match(/^import[\s{*'"][^\n]*/m)?.[0] || '';
    const want = path.relative(path.dirname(file), path.join(REPO, 'scripts', 'lib', 'no-user-dirs.mjs')).split(path.sep).join('/');
    const spec = want.startsWith('.') ? want : `./${want}`;
    const viaEntry = first.startsWith(`import '${spec}'`);
    const explicit = /PROMPTCUT_NO_PORT_FILE:\s*'1'/.test(src);
    if (!viaEntry && !explicit) offenders.push(`${rel}:会起编辑器,第一个 import 不是 no-user-dirs.mjs,也没显式设 PROMPTCUT_NO_PORT_FILE: '1'`);
  }
  assert.ok(checked.length >= 25, `扫描到的脚本太少(${checked.length}),识别规则可能坏了:${checked.join(', ')}`);
  for (const must of ['scripts/lib/dev-server.mjs', 'scripts/probes/ready-index-probe.mjs', 'scripts/probes/cold-start-probe.mjs', 'scripts/probes/m8/procs.mjs']) {
    assert.ok(checked.includes(must), `${must} 起编辑器,识别规则却没认出来`);
  }
  assert.deepEqual(offenders, [], '这些脚本起的编辑器会覆盖公共的 %TEMP%\\promptcut\\port.json');
});

test('port-file:桌面版与 npm run dev 不设 PROMPTCUT_NO_PORT_FILE(照旧写 port.json)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.doesNotMatch(pkg.scripts.dev, /PROMPTCUT_NO_PORT_FILE/);
  assert.doesNotMatch(read('desktop/src-tauri/src/lib.rs'), /PROMPTCUT_NO_PORT_FILE/);
  assert.doesNotMatch(read('vite.config.ts'), /PROMPTCUT_NO_PORT_FILE/);
});
