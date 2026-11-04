import type { EditorApi } from "../ai/mcpExecutor";

/**
 * Method names in EditorApi that **take no arguments** (those written as `api.play()` in the
 * original dispatch chain)
 */
export type NoArgMethod = { [K in keyof EditorApi]: Parameters<EditorApi[K]> extends [] ? K : never }[keyof EditorApi];
/**
 * Method names in EditorApi that **take one argument** (those written as `api.addClip(args)` in the
 * original dispatch chain, including optional parameters)
 */
export type ArgMethod = { [K in keyof EditorApi]: Parameters<EditorApi[K]> extends [] ? never : K }[keyof EditorApi];

/**
 * A tool route. For field semantics, see the header comment in routes.mjs.
 * Split into a discriminated union by passArgs so that the dispatch line `api[route.method](args)`
 * passes type checking without any type casting: the signatures of zero-arg and single-arg methods
 * do not match.
 */
export type ToolRoute =
  | { method: NoArgMethod; passArgs: false; awaited: boolean }
  | { method: ArgMethod; passArgs: true; awaited: boolean };

export const TOOL_ROUTES: Readonly<Record<string, ToolRoute>>;
export const SPECIAL_TOOLS: readonly string[];
