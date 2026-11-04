/**
 * Page built-in modules that card code in the stage can import
 * (`docs/plan/online-card-exec-contract.md` Section 2).
 * **Stage only** (loaded on-demand by the stage side); relies on Vite's `import.meta.glob` and
 * cannot be loaded in Node unit tests.
 *
 * - Packages: Matches the desktop `create_card` allowlist, minus subpaths under `three/`. All use
 *   the exact instance the page itself uses (the same React, the same Motion: card components must
 *   mount into the page's React tree).
 * - Built-in modules: `src/cards/` (excluding user card directory), `src/parts/`, `src/kernel/`,
 *   and `src/render/cards/graphValues.ts`.
 *   The table is **loaded eagerly with this module** (`eager`), rather than loading each module
 *   on-demand: measurements showed on-demand loading caused the bundler to split the page main chunk
 *   into over a hundred small chunks (file count in online build: 26 → 134), adding over a hundred
 *   requests when opening the page; loading with this module only adds three or four files, while
 *   main chunk size remains unchanged. For modules already in the page main chunk, what is obtained
 *   here is that exact page instance. Heavy packages (`three`, etc.) are still loaded on-demand.
 */
import type { HostModules } from "./loader.ts";
import { CARD_PACKAGES } from "./protocol.ts";
import { isBuiltinModulePath } from "./resolve.ts";

const packages: Record<string, () => Promise<unknown>> = {
  "react": () => import("react"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "react-dom": () => import("react-dom"),
  "motion": () => import("motion"),
  "motion/react": () => import("motion/react"),
  "three": () => import("three"),
  "lottie-web": () => import("lottie-web"),
  "@tsparticles/engine": () => import("@tsparticles/engine"),
  "@tsparticles/slim": () => import("@tsparticles/slim"),
};

const globbed = import.meta.glob([
  "/src/cards/**/*.{ts,tsx,mjs}", "/src/parts/**/*.{ts,tsx,mjs}", "/src/kernel/**/*.{ts,tsx,mjs}", "/src/render/cards/graphValues.ts",
  "!/src/cards/user/**", "!/src/**/*.test.{ts,tsx,mjs,js}", "!/src/**/*.d.{ts,mts}",
], { eager: true });

const builtin = new Map<string, () => unknown>();
for (const [file, load] of Object.entries(globbed)) {
  const path = file.replace(/^\//, "");
  if (isBuiltinModulePath(path)) builtin.set(path, () => load);
}

/** Allowlist and this table must match one-to-one (unit test `cardRuntime.test.mjs` verifies text) */
export const HOST_PACKAGE_NAMES: readonly string[] = Object.freeze(Object.keys(packages));
if (import.meta.env.DEV && (HOST_PACKAGE_NAMES.length !== CARD_PACKAGES.length || CARD_PACKAGES.some((n) => !Object.hasOwn(packages, n)))) {
  console.error("[cardRuntime] Package table does not match the allowlist", HOST_PACKAGE_NAMES, CARD_PACKAGES);
}

export const stageHostModules: HostModules = {
  packages,
  builtin: (path) => builtin.get(path) ?? null,
};
