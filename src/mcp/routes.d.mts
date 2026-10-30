import type { EditorApi } from "../ai/mcpExecutor";

/** EditorApi 里**不收参数**的方法名(原分发链里写成 `api.play()` 的那些) */
export type NoArgMethod = { [K in keyof EditorApi]: Parameters<EditorApi[K]> extends [] ? K : never }[keyof EditorApi];
/** EditorApi 里**收一个参数**的方法名(原分发链里写成 `api.addClip(args)` 的那些,含可选参数) */
export type ArgMethod = { [K in keyof EditorApi]: Parameters<EditorApi[K]> extends [] ? never : K }[keyof EditorApi];

/**
 * 一条工具路由。字段含义见 routes.mjs 的头注释。
 * 按 passArgs 分成可辨识联合,是为了让分发处 `api[route.method](args)` 这一句
 * 不用任何强转就能过类型检查 —— 零参方法和一参方法的签名对不上。
 */
export type ToolRoute =
  | { method: NoArgMethod; passArgs: false; awaited: boolean }
  | { method: ArgMethod; passArgs: true; awaited: boolean };

export const TOOL_ROUTES: Readonly<Record<string, ToolRoute>>;
export const SPECIAL_TOOLS: readonly string[];
