/** 隔离的资源管理器环境自举：只按参数启动（--standalone-smoke 用）。
 * 原先这里还有一套「临时改写 .proc 打开命令、等人真双击」的交接（explorerNativeLaunch）：
 * 那条路 19 轮没拿到回执，用户 2026-10-05 改定不再改写关联，改为在笔记本真实安装候选包后真双击
 * （docs/plan/collaboration-reopen-installed-acceptance.md，探针 reopen-installed.mjs）。
 * 2026-10-23 的探针总审把它和 reopen-association-lease.mjs / .ps1、reopen-native-process-watch.ps1 一并删除
 * （报告 docs/reports/AGENT-claude-probe-audit.md）。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadNativeFixture, nativeTestEnv } from './reopen-native-fixture.mjs';

const environmentKeys=['PC_REOPEN_NATIVE_ROOT','PC_REOPEN_NATIVE_BROWSER_DIR','PROMPTCUT_AI_CONFIG','PROMPTCUT_CLI_HOME',
  'PROMPTCUT_AGY_SETTINGS','PROMPTCUT_CLAUDE_CONFIG','PROMPTCUT_CODEX_CONFIG','PROMPTCUT_SKILL_DIR',
  'PROMPTCUT_PROJECTS_DIR','PROMPTCUT_RUNTIME_DIR','PROMPTCUT_AGENT_CDP','PROMPTCUT_NO_PORT_FILE',
  'PROMPTCUT_AUTO_RENDER_NODE','PROMPTCUT_PUSH','PROMPTCUT_QUEUE_NODE','PROMPTCUT_LAN_HOST'];
export function prepareStandaloneLaunch(fixtureFile, entry, file, env) {
  const f=loadNativeFixture(fixtureFile);assert(f.standaloneLaunch);
  const root=fs.realpathSync(env.PC_REOPEN_NATIVE_ROOT), rel=path.relative(f.root,root);
  assert(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
  assert.equal(fs.realpathSync(file),file);
  assert(path.relative(root,file)&&!path.relative(root,file).startsWith('..'));
  const launchId=randomBytes(16).toString('hex');
  const privateEnv=Object.fromEntries(environmentKeys.filter(k=>env[k]!==undefined).map(k=>[k,env[k]]));
  fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify({kind:'promptcut-fixture-launch-v1',launchId,env:privateEnv}));
  return {f,root,launchId};
}
