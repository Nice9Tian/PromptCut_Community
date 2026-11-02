/**
 * 工具入口对参数的严格检查:这些工具带了 inputSchema 没声明的参数就整次拒绝,不静默丢、不原样往下传。
 *
 * 现在只有 `set_project_meta`:它的实现把参数合进项目,以前未声明的键会原样写进项目文档 ——
 * Agent 能借它改项目的任意字段,包括创造力等级(计划 `agent-workflow-plan.md` A1「堵口子」)。
 * 实现那一层(`src/mcp/handlers/project.ts`,页面与 Agent 服务端共用)也拦同样的键;这里在 `callToolInternal`
 * 入口再拦一道,MCP 与 API 直连两条路、绑没绑项目副本都一样。
 */
export const STRICT_ARG_TOOLS = new Set(['set_project_meta']);

/** 参数里 schema 没声明的键;不在 STRICT_ARG_TOOLS 里的工具一律回空 */
export function undeclaredArgs(tool, toolDef, args) {
  if (!STRICT_ARG_TOOLS.has(tool)) return [];
  if (args === undefined || args === null) return [];
  if (typeof args !== 'object' || Array.isArray(args)) return ['(arguments are not an object)'];
  const declared = Object.keys(toolDef?.inputSchema?.properties ?? {});
  return Object.keys(args).filter((k) => !declared.includes(k));
}

/** 被拒时回给 Agent 的话 */
export function undeclaredArgsError(tool, toolDef, unknown) {
  const declared = Object.keys(toolDef?.inputSchema?.properties ?? {});
  const creativity = unknown.includes('creativity') ? 'Creativity level can only be changed by the user in project settings or the AI panel; the Agent cannot write it.' : '';
  return `${tool} does not accept these fields: ${unknown.join(', ')}. This call was not executed at all, and no field was written.` +
    `It only accepts ${declared.join(', ')}. ${creativity}Use the matching tool to change other project content.`;
}
