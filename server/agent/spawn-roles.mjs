/**
 * `spawn_agent` 能拉起的预设角色(计划 `docs/plan/agent-workflow-plan.md` A3)。只放常量,不引任何 Node 内置模块:
 * 工具表 `server/tools/agent.mjs` 引它,而工具表会被页面(`src/ai/mcpExecutor.ts` → `server/mcp-tools.mjs`)静态引入。
 * 读角色提示词(要读文件)在 `agent-roles.mjs`。
 */

/** 能被拉起的预设角色(`spawn_agent` 的 `role` 可选值),顺序即工具说明里的顺序 */
export const SPAWN_ROLE_IDS = Object.freeze(['director', 'fx-assistant', 'collector']);

/** 工具表里给模型看的一句话说明 */
export const SPAWN_ROLE_HINTS = Object.freeze({
  director: '剪辑导演:看齐素材,排顺序放上时间轴,编排剧本',
  'fx-assistant': '特效助理:给视频配字幕,按内容配动效卡',
  collector: '素材收集员:把网页链接里的视频抓进素材库',
});
