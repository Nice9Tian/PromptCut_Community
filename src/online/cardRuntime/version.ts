/**
 * Online card runtime version (`docs/plan/online-card-exec-contract.md` section 5): loading rule
 * version + transpiler and Tailwind version.
 *
 * Where it goes: transpilation cache key, generation of loaded modules on the stage, device string
 * in cost records, environment fingerprint for browser-only nodes executing user card and media
 * effect card tasks.
 * Sound output keys omit it (lead session ruling 2026-10-06: shared with desktop outputs).
 *
 * - `CARD_RUNTIME_ABI`: increment by one when module resolution rules, syntax pre-check rules,
 *   sound thread module table, or transpilation options change.
 * - Transpiler and Tailwind versions are injected by the online build via
 *   `__PC_CARD_RUNTIME_DEPS__` (`vite.config.ts`, taken from the version actually installed);
 *   dev server, desktop build, and Node unit tests do not have it and use `dev` (these
 *   environments do not execute synced cards, nor do they act as browser-only nodes).
 */
declare const __PC_CARD_RUNTIME_DEPS__: { sucrase?: string; tailwindcss?: string } | undefined;

export const CARD_RUNTIME_ABI = "ocr2";

const deps = typeof __PC_CARD_RUNTIME_DEPS__ === "object" && __PC_CARD_RUNTIME_DEPS__ ? __PC_CARD_RUNTIME_DEPS__ : null;

export function cardRuntimeVersionOf(abi: string, d: { sucrase?: string; tailwindcss?: string } | null): string {
  return `${abi}:sucrase@${d?.sucrase || "dev"}:tailwindcss@${d?.tailwindcss || "dev"}`;
}

/** Formatted like `ocr2:sucrase@3.35.1:tailwindcss@4.3.3` */
export const CARD_RUNTIME_VERSION: string = cardRuntimeVersionOf(CARD_RUNTIME_ABI, deps);
