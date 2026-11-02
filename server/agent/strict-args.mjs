/**
 * Strict parameter checking at tool entry points: if these tools receive parameters not declared
 * in inputSchema, the entire call is rejected: not silently dropped, not passed through as-is.
 *
 * Currently only `set_project_meta`: its implementation merges arguments into the project; previously,
 * undeclared keys would be written into the project document as-is: the Agent could use this to modify
 * any project field, including creativity level (plan `agent-workflow-plan.md` A1 "plugging loopholes").
 * The implementation layer (`src/mcp/handlers/project.ts`, shared between page and Agent server) also
 * blocks the same keys; here an extra guard is placed at the `callToolInternal` entry point, identical
 * for both MCP and direct API paths, whether a project replica is bound or not.
 */
export const STRICT_ARG_TOOLS = new Set(['set_project_meta']);

/** Keys in arguments not declared in schema; tools not in STRICT_ARG_TOOLS always return empty */
export function undeclaredArgs(tool, toolDef, args) {
  if (!STRICT_ARG_TOOLS.has(tool)) return [];
  if (args === undefined || args === null) return [];
  if (typeof args !== 'object' || Array.isArray(args)) return ['(arguments are not an object)'];
  const declared = Object.keys(toolDef?.inputSchema?.properties ?? {});
  return Object.keys(args).filter((k) => !declared.includes(k));
}

/** Message returned to the Agent when rejected */
export function undeclaredArgsError(tool, toolDef, unknown) {
  const declared = Object.keys(toolDef?.inputSchema?.properties ?? {});
  const creativity = unknown.includes('creativity') ? 'Creativity level can only be changed by the user in project settings or the AI panel; the Agent cannot write it.' : '';
  return `${tool} does not accept these fields: ${unknown.join(', ')}. This call was not executed at all, and no field was written.` +
    ` It only accepts ${declared.join(', ')}. ${creativity}Use the matching tool to change other project content.`;
}
