/*
 * 依赖方向的守门测试。
 *
 * 渲染引擎从 `scripts/export-frames.mjs` 搬进 `server/bakery/` 之前,`server/` 与 `scripts/`
 * 互相 import(`server/frame-pipeline.mjs` → `scripts/export-frames.mjs` → `server/export-compose.mjs`),
 * 而且 `export-frames.mjs` ↔ `export-unified.mjs` 之间还有一个运行时环。两条都修好了,这里把它钉住:
 *
 *   1. `server/**` 不再 import `scripts/**`(`scripts/` → `server/` 单向允许);
 *   2. `server/bakery/**` 内部的 import 图无环。
 *
 * 跑法:`node --test server/test/bakery-deps.test.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SERVER = path.join(ROOT, 'server');
const BAKERY = path.join(SERVER, 'bakery');

/**
 * 例外只有测 scripts/ 自己的测试,不是生产代码对 scripts/ 的依赖:
 *
 *   - `bake-protocol.test.mjs` 测 `scripts/verify-bake-protocol.mjs` 这个命令行校验脚本;
 *   - `dev-server-junction.test.mjs` 测 `scripts/lib/dev-server.mjs` 的 media junction 只拆链接
 *     (拆错了删的是用户素材,所以要常驻基线);
 *   - `probe-coord-mail.test.mjs` 测 `scripts/probes/probe-coord.mjs` 里两个 Agent 之间的 HTTP 信箱(鉴权与长轮询);
 *   - `m8-kit.test.mjs` 测 `scripts/probes/m8/` 里 M8 探针公共件的判据、KV 约定与代理控制命令(M8 的验收判据靠它们,要常驻基线)。
 *   - `m7-judge.test.mjs` 测 `scripts/probes/m7-judge.mjs` 里 M7 验收探针 D1-D2-D12 的判据（按出键分组、中途接手只作说明）。
 *   - `m8-scale.test.mjs` 测 `scripts/probes/m8-scale-probe.mjs` 的任务表、节点账本与 K1 / K2 / I1 / I2 判据(M8 规模复测的判据靠它们)。
 *   - `m8-no-lan.test.mjs` 测 `scripts/probes/m8/no-lan.mjs` 的 netstat 解析与计数(M8「异地接入」的「全程没有局域网连接」靠它判)。
 *   - `no-user-dirs.test.mjs` 测 `scripts/lib/user-dirs.mjs` 与 `dev-server.mjs` 的素材镜像,并扫描探针都先摘掉外部的
 *     `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`(测试与探针不写用户的 Videos\PromptCut,要常驻基线);
 *   - `global-setup.mjs`(`npm test` 的全局准备,不是生产代码)用 `scripts/lib/user-dirs.mjs` 摘掉同样两个变量,
 *     和探针共用一份判定。
 *   - `port-file.test.mjs` 测 `scripts/lib/user-dirs.mjs` 的 `markNoPortFile`，并扫描起编辑器的探针都带上 `PROMPTCUT_NO_PORT_FILE=1`
 *     (测试与探针不覆盖公共的 %TEMP%\promptcut\port.json,要常驻基线);
 *   - `asset-lan-discover.test.mjs` 测 `scripts/probes/asset-lan-discover.mjs`(`asset-lan-probe` 按局域网发现找放本机项目的素材服务地址);
 *   - `m8-judges.test.mjs` 测 `scripts/probes/m8/lib.mjs` 里 `cloud-untouched` 与 `real:tasks` 的判法。
 *   - `maint-3-claim-gate-judge.test.mjs` 测 `scripts/probes/claim-gate-judge.mjs`(认领闸端到端探针的判定:多认领、Agent 任务不排在预渲染后面)。
 *   - `reopen-installed-lib.test.mjs` 测 `scripts/probes/reopen-installed-lib.mjs`(真实安装验收探针里一次启动算不算数的判定、已装构建与清单的核对);
 *   - `reopen-installed-state.test.mjs` 测 `scripts/probes/reopen-installed-state.mjs`(安装状态的备份、比对、还原)与 `scripts/probes/reopen-sealed.mjs`(探针之间只传公钥与密文的口令交接)。
 *   - `test-suite-policy.test.mjs` 测 `scripts/test-suite-policy.mjs` 与 `scripts/test-event-reporter.mjs` 的测试进程异常重跑判定。
 *   - `probe-timings.test.mjs` 测 `scripts/probes/probe-timings.mjs`(探针共用的耗时记录件:耗时只记录,不当闸门)及它与验收运行器对 TIMINGS 行的解析一致。
 *
 * 多一条都要在这里显式写出来,加不进来就说明依赖方向真的破了。
 */
const ALLOWED_SCRIPT_IMPORTERS = new Set(['server/test/four-stage-acceptance.test.mjs', 'server/test/four-stage-acceptance-v18.test.mjs', 'server/test/probe-timings.test.mjs', 'server/test/wait-writes-quiet.test.mjs', 'server/test/bake-protocol.test.mjs', 'server/test/dev-server-junction.test.mjs', 'server/test/probe-coord-mail.test.mjs', 'server/test/m8-kit.test.mjs', 'server/test/m8-scale.test.mjs', 'server/test/m7-judge.test.mjs', 'server/test/m8-no-lan.test.mjs', 'server/test/no-user-dirs.test.mjs', 'server/test/global-setup.mjs', 'server/test/port-file.test.mjs', 'server/test/asset-lan-discover.test.mjs', 'server/test/m8-judges.test.mjs', 'server/test/maint-3-claim-gate-judge.test.mjs', 'server/test/reopen-installed-lib.test.mjs', 'server/test/reopen-installed-state.test.mjs', 'server/test/test-suite-policy.test.mjs',
  // 2026-10-26 顺手补:main 上这一条本来就判红(f66874c5 进来的测试引了 cloud/scripts/render-host.mjs,
  // 没进名单),不补上这个守门测试在 main 和任何分支上都过不去
  'cloud/server/test/render-host-sweep.test.mjs']);

const CODE = /\.(mjs|mts|ts|tsx)$/;

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file, out);
    else if (CODE.test(item.name)) out.push(file);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).replaceAll('\\', '/');

/** 一个文件里所有的模块说明符:静态 import / export ... from,以及 import("…") */
function specifiersOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const m of text.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gs)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
  return found;
}

test('server/** 不 import scripts/ 下的模块', () => {
  const offenders = [];
  for (const file of walk(SERVER)) {
    const name = rel(file);
    if (ALLOWED_SCRIPT_IMPORTERS.has(name)) continue;
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith('.')) continue;
      const target = rel(path.resolve(path.dirname(file), spec));
      if (target.startsWith('scripts/')) offenders.push(`${name} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], '依赖方向只能是 scripts/ → server/,不能反过来');
});

test('名单里允许 import scripts/ 的 server 文件确实还在', () => {
  // 社区版（公开仓库）不带闭源的 cloud/，也不带内部发版验收（scripts/acceptance/ 与测它的四个单测，
  // 见 docs/plan/community-boundary.md 第三节）；那几条在那边本来就不在，不算过期
  const INTERNAL_ACCEPTANCE = new Set(['server/test/four-stage-acceptance.test.mjs', 'server/test/four-stage-acceptance-v18.test.mjs', 'server/test/probe-timings.test.mjs', 'server/test/wait-writes-quiet.test.mjs']);
  const hasCloud = fs.existsSync(path.join(ROOT, 'cloud'));
  const hasAcceptance = fs.existsSync(path.join(ROOT, 'scripts', 'acceptance'));
  for (const name of ALLOWED_SCRIPT_IMPORTERS) {
    if ((!hasCloud && name.startsWith('cloud/')) || (!hasAcceptance && INTERNAL_ACCEPTANCE.has(name))) continue;
    assert.ok(fs.existsSync(path.join(ROOT, name)), `${name} 不在了,请把它从名单里删掉`);
  }
});

test('server/bakery/** 内部的 import 图无环', () => {
  /** 文件 → 它 import 的同目录(或子目录)模块 */
  const graph = new Map();
  for (const file of walk(BAKERY)) {
    const edges = [];
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (target.startsWith(BAKERY)) edges.push(rel(target));
    }
    graph.set(rel(file), edges);
  }
  assert.ok(graph.size > 0, 'server/bakery 里应当有模块');

  const state = new Map(); // 未访问 / 1 在栈上 / 2 已完成
  const cycles = [];
  const visit = (node, stack) => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      cycles.push([...stack.slice(stack.indexOf(node)), node].join(' → '));
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) visit(next, stack);
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) visit(node, []);
  assert.deepEqual(cycles, [], 'server/bakery 内部不允许有运行时 import 环');
});
