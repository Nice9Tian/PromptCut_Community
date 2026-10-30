/**
 * 账号模式一轮事件与状态本地落盘的公开侧转接入口。
 *
 * 云端实现已迁至 `cloud/agent/account-run-events.mjs`，通过 `./extensions.mjs` 挂载；
 * 社区版（无 `cloud/` 目录）不加载任何 `server/account/` 或 `cloud/` 模块。
 */
import { findAgentExtension } from './extensions.mjs';

export function createAccountRunEvents(...args) {
  const ext = findAgentExtension('account-run-events');
  if (!ext?.createEvents) {
    throw Object.assign(new Error('account-run-events extension is not mounted'), {
      status: 503,
      code: 'run-unavailable',
    });
  }
  return ext.createEvents(...args);
}
