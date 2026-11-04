import type { Control } from "./types";

/** Skipped controls: recognized key / label / type and reason (parameters panel explains which item) */
export interface SkippedControl {
  key?: string;
  label?: string;
  type?: string;
  reason: string;
}

/**
 * A card recognized in source code (`defaults` / `controls` / `description` only recognize
 * literals, see `cardSourceParse.mjs` file header)
 */
export interface ParsedCardSource {
  embeddedAudio?: boolean;
  id: string;
  name: string;
  description?: string;
  defaults: Record<string, unknown>;
  controls: Control[];
  /** Some controls were not recognized (or the entire `controls` is not a literal) */
  controlsIncomplete: boolean;
  /** Skipped controls, item by item */
  skippedControls: SkippedControl[];
}

export interface ParseCardSourceOptions {
  /**
   * Repository-relative path of this source code (`src/cards/user/x.tsx`), relative imports resolve
   * against it
   */
  key?: string;
  /**
   * Source code of other files (`card-source` synced from content store); returns null / undefined if
   * none
   */
  files?: (key: string) => string | null | undefined;
  /** Exports of a built-in module the page ships with (plain data, or a pure function registered via `pureCall`); returns null / undefined if there is none */
  builtins?: (key: string) => Record<string, unknown> | null | undefined;
}

/** The cards defined in one card source (the source is not executed); returns an empty array if none are recognized */
export function parseCardSource(source: string, opts?: ParseCardSourceOptions): ParsedCardSource[];
/** An evaluated control object → `Control`; returns null if it cannot be drawn */
export function controlOf(v: unknown): Control | null;
/** An evaluated control object → `{ control }`, or the reason it cannot be drawn `{ reason }` (filled in where it can be inferred) */
export function controlFix(v: unknown, opts?: { dropped?: string[]; defaultValue?: unknown }): { control?: Control; reason?: string };
/** Whether a card source key in the content store is the entry file of a user card (`src/cards/user/<name>.tsx`) */
export function isUserCardEntryKey(key: unknown): boolean;
/** Relative import → candidate repo-relative paths; returns null if it is not a relative path */
export function resolveSpecifier(fromKey: string, spec: string): string[] | null;
/** The specifiers of `import … from` / `export … from` in the source */
export function importSpecifiers(source: string): string[];
/** Repo-relative paths the source may reach through relative imports (all candidates) */
export function cardSourceImports(source: string, key: string): string[];
/** Pure function marker */
export const PURE_CALL: unique symbol;
/** Registers a pure function of the page itself into the built-in module table (evaluated when called with literal arguments) */
export function pureCall<A extends unknown[], R>(fn: (...args: A) => R): Readonly<Record<symbol, (...args: A) => R>>;
