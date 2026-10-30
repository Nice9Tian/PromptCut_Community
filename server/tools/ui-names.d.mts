export const UI_TOOL_PREFIX: "user_interface_";
export const UI_TOOL_RENAMES: Readonly<Record<string, string>>;
export const UI_TOOL_LEGACY: Readonly<Record<string, string>>;
export function modelToolName(name: string): string;
export function pageToolName(name: string): string;
export function isUserInterfaceTool(name: string): boolean;
export const UI_TOOLS_PROMPT_LINE: string;
