/**
 * 账号模式节点工具集的公开侧转接入口。
 *
 * 云端实现已迁至 `cloud/agent/account-tools.mjs`，通过 `./extensions.mjs` 在调用时惰性挂载；
 * 模块求值阶段不触发任何云端扩展加载，避免循环依赖。社区版（无 `cloud/` 目录）不加载任何 `server/account/` 或 `cloud/` 模块。
 */
import { findAgentExtension } from './extensions.mjs';

function requireExt(fnName) {
  const current = findAgentExtension('account-tools');
  if (!current || typeof current[fnName] !== 'function') {
    throw Object.assign(new Error(`account-tools extension (${fnName}) is not mounted`), {
      status: 503,
      code: 'run-unavailable',
    });
  }
  return current[fnName];
}

export const ACCOUNT_TOOL_DEFAULTS = Object.freeze({
  totalJobMs: 15 * 60_000,
  stepTimeoutMs: 60_000,
  perConversationRunningJobs: 1,
  perNodeHeavyJobs: 2,
  perConversationScratchBytes: 1024 * 1024 * 1024,
  perNodeScratchBytes: 8 * 1024 * 1024 * 1024,
  perConversationBrowsers: 1,
  perNodeBrowsers: 2,
  browserSessionMs: 10 * 60_000,
  browserIdleMs: 3 * 60_000,
  handoffWaitMs: 5 * 60_000,
  frameMaxBytes: 512 * 1024,
  sttMaxDurationSec: 2 * 3600,
  trackMaxFrames: 900,
  subjectMaxFrames: 300,
  shotsMaxDurationSec: 2 * 3600,
  separateMaxDurationSec: 30 * 60,
});

export const LOGIN_WITHOUT_DELEGATE_TEXT =
  '当前这一轮未关联在线页面，无法打开远程登录窗口。请回到发起对话的浏览器页面重试，或直接使用免登录公开素材。';

export const TOOL_JOBS_BROKEN_TEXT =
  '云端节点的后台任务记录文件已损坏，拒绝继续启动或查询后台任务；请联系管理员修复或清理该对话的节点工作区。';

export const ACCOUNT_TOOL_SETTING_KEYS = Object.freeze([
  'PROMPTCUT_FFMPEG',
  'PROMPTCUT_FFPROBE',
  'PROMPTCUT_AGENT_SHOTS_PYTHON',
  'PROMPTCUT_AGENT_SHOTS_MODELS',
  'PROMPTCUT_AGENT_SHOTS_PYLIBS',
  'PROMPTCUT_AGENT_SUBJECT_PYTHON',
  'PROMPTCUT_AGENT_SUBJECT_MODELS',
  'PROMPTCUT_AGENT_SUBJECT_PYLIBS',
  'PROMPTCUT_AGENT_SUBJECT_REQUIREMENTS',
  'PROMPTCUT_AGENT_SUBJECT_WHEELHOUSE',
  'PROMPTCUT_AGENT_STT_PYTHON',
  'PROMPTCUT_AGENT_STT_MODELS',
  'PROMPTCUT_AGENT_STT_PYLIBS',
  'PROMPTCUT_AGENT_STT_REQUIREMENTS',
  'PROMPTCUT_AGENT_STT_INDEX_URL',
  'PROMPTCUT_AGENT_TRACK_PYTHON',
  'PROMPTCUT_AGENT_TRACK_MODELS',
  'PROMPTCUT_AGENT_TRACK_PYLIBS',
  'PROMPTCUT_AGENT_BROWSER',
  'PROMPTCUT_AGENT_BROWSER_ARGS',
  'PROMPTCUT_AGENT_COLLECT_PYTHON',
  'PROMPTCUT_AGENT_COLLECT_DELEGATE',
  'PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES',
]);

export const BROWSER_PURGE_MARK = '.purge-pending.json';

export const CONVERSATION_PURGE_DIR = '_conversation-purges';

export const validateAccountToolSettings = (...args) => requireExt('validateAccountToolSettings')(...args);
export const readAccountToolConfig = (...args) => requireExt('readAccountToolConfig')(...args);
export const accountToolStateDir = (...args) => requireExt('accountToolStateDir')(...args);
export const writeBrowserPurgeMark = (...args) => requireExt('writeBrowserPurgeMark')(...args);
export const readBrowserPurgeMarkIn = (...args) => requireExt('readBrowserPurgeMarkIn')(...args);
export const readBrowserPurgeMark = (...args) => requireExt('readBrowserPurgeMark')(...args);
export const removeMarkedBrowserData = (...args) => requireExt('removeMarkedBrowserData')(...args);
export const queueConversationPurge = (...args) => requireExt('queueConversationPurge')(...args);
export const listConversationPurges = (...args) => requireExt('listConversationPurges')(...args);
export const purgeConversationData = (...args) => requireExt('purgeConversationData')(...args);
export const conversationPurgeState = (...args) => requireExt('conversationPurgeState')(...args);
export const createAccountToolset = (...args) => requireExt('createAccountToolset')(...args);
