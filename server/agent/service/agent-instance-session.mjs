/**
 * 实例内一轮会话的公开侧转接入口。
 *
 * 云端实现已迁至 `cloud/agent/agent-instance-session.mjs`，通过 `./extensions.mjs` 挂载；
 * 社区版（无 `cloud/` 目录）不加载任何 `server/account/` 或 `cloud/` 模块。
 */
import { findAgentExtension } from './extensions.mjs';

export function createAgentInstanceSession(...args) {
  const ext = findAgentExtension('agent-instance-session');
  if (!ext?.createSession) {
    throw Object.assign(new Error('agent-instance-session extension is not mounted'), {
      status: 503,
      code: 'run-unavailable',
    });
  }
  return ext.createSession(...args);
}
