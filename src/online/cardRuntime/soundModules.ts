/**
 * Modules that card code can import in sound thread (`docs/plan/online-card-exec-contract.md` 3.5).
 * **Sound thread only** (`soundWorker.ts`); relies on Vite's `import.meta.glob` and cannot be loaded
 * in Node unit tests (placeholder behavior is in `soundStub.ts`, which unit tests verify).
 *
 * - Packages: provide real implementations for `react`, `react/jsx-runtime`, `motion`,
 *   `motion/react`, `three` (provide placeholders if loading fails, so one package does not break
 *   the whole card); `react-dom`, `lottie-web`, `@tsparticles/*` require DOM upon loading, so
 *   provide placeholders: importing does not throw, and only using them throws "cannot use <name> in
 *   sound code".
 * - Built-in modules: provide real implementations for `src/kernel/` and
 *   `src/render/cards/graphValues.ts` (pure computation: recipes and value getters commonly used in
 *   sound code live here); non-JSX files under `src/cards/` and `src/parts/` (`.ts` / `.mjs`, e.g.
 *   `cards/native/sound-effects.ts`) are **loaded on demand**, falling back to placeholders on
 *   failure; component files with JSX (`.tsx`) always get placeholders: they are visuals, unneeded
 *   in sound code, and loading them would pull styles and the entire component tree into the thread.
 *
 * Matches the package list on the stage side (`hostModules.ts`) one-to-one, except a few are
 * placeholders.
 */
import type { HostModules } from "./loader.ts";
import { CARD_PACKAGES } from "./protocol.ts";
import { isBuiltinModulePath } from "./resolve.ts";
import { createSoundStub, realOrStub } from "./soundStub.ts";

const stub = (name: string) => () => createSoundStub(name);

const packages: Record<string, () => unknown | Promise<unknown>> = {
  "react": realOrStub("react", () => import("react")),
  "react/jsx-runtime": realOrStub("react/jsx-runtime", () => import("react/jsx-runtime")),
  "react-dom": stub("react-dom"),
  "motion": realOrStub("motion", () => import("motion")),
  "motion/react": realOrStub("motion/react", () => import("motion/react")),
  "three": realOrStub("three", () => import("three")),
  "lottie-web": stub("lottie-web"),
  "@tsparticles/engine": stub("@tsparticles/engine"),
  "@tsparticles/slim": stub("@tsparticles/slim"),
};

/** Purely computational built-in modules: loaded along with the thread */
const pure = import.meta.glob([
  "/src/kernel/**/*.{ts,mjs}", "/src/render/cards/graphValues.ts",
  "!/src/**/*.test.{ts,tsx,mjs,js}", "!/src/**/*.d.{ts,mts}",
], { eager: true });
/** Non-JSX files under cards and parts directories: loaded on demand */
const lazy = import.meta.glob([
  "/src/cards/**/*.{ts,mjs}", "/src/parts/**/*.{ts,mjs}",
  "!/src/cards/user/**", "!/src/**/*.test.{ts,tsx,mjs,js}", "!/src/**/*.d.{ts,mts}",
  // Barrel files import the entire component tree along with styles: in build output the thread is
  // bundled into a single file, and styles inject into `document` on thread startup (there is no
  // `document` in a thread, so the entire thread fails to start). They belong to the visual side,
  // so provide placeholders in the sound thread
  "!/src/cards/**/index.ts", "!/src/parts/**/index.ts", "!/src/cards/native/batch-*.ts", "!/src/cards/userOverlay.ts", "!/src/cards/_probe/**",
]);

const builtin = new Map<string, () => unknown | Promise<unknown>>();
for (const [file, mod] of Object.entries(pure)) {
  const path = file.replace(/^\//, "");
  if (isBuiltinModulePath(path)) builtin.set(path, () => mod);
}
for (const [file, load] of Object.entries(lazy)) {
  const path = file.replace(/^\//, "");
  if (isBuiltinModulePath(path) && !builtin.has(path)) builtin.set(path, realOrStub(path, load as () => Promise<unknown>));
}

export const SOUND_PACKAGE_NAMES: readonly string[] = Object.freeze(Object.keys(packages));
if (import.meta.env.DEV && (SOUND_PACKAGE_NAMES.length !== CARD_PACKAGES.length || CARD_PACKAGES.some((n) => !Object.hasOwn(packages, n)))) {
  console.error("[cardRuntime] Sound thread package table does not match the allowlist", SOUND_PACKAGE_NAMES, CARD_PACKAGES);
}

export const soundHostModules: HostModules = {
  packages,
  // Within scope but not in the table (component files `.tsx`, files with JSX in kernel): placeholders;
  // outside scope cannot be imported as before
  builtin: (path) => builtin.get(path) ?? (isBuiltinModulePath(path) ? stub(path) : null),
};
