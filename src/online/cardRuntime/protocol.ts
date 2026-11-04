/**
 * Online browser executing user cards and media effect cards: shape of data transferred between
 * editor page → stage / sound thread (`docs/plan/online-card-exec-contract.md` Sections 1, 2, and 8).
 * Only types and constants, importable by either side.
 *
 * Flow: editor page fetches card source from content store → transpiles and resolves each import
 * (`transpile.ts`) → one `CardBundle` per card → sent to stage via stage RPC → loader in stage
 * (`loader.ts`) executes, extracts card definitions, and reports back runtime status.
 * `CardModule.js` is never executed in the editor page origin.
 */
import type { CardRunState } from "../../kernel/registry.ts";

export type { CardRunState, CardRunStateName } from "../../kernel/registry.ts";

/** Packages cards can import (matches desktop `create_card` allowlist, minus `three/` subpaths; contract Section 2) */
export const CARD_PACKAGES: readonly string[] = Object.freeze([
  "react", "react/jsx-runtime", "react-dom", "motion", "motion/react", "three", "lottie-web", "@tsparticles/engine", "@tsparticles/slim",
]);

/** Where an import resolves to */
export type ResolvedImport =
  /** Page built-in package */
  | { kind: "package"; name: string }
  /** Source code synced from content store (another module in the same bundle) */
  | { kind: "synced"; key: string }
  /** Page built-in internal module (repository-relative path, e.g. `src/cards/native/hud.tsx`) */
  | { kind: "builtin"; path: string }
  /** Synced style file: not executed, text is in `CardBundle.styles` */
  | { kind: "style"; key: string };

/** A transpiled module */
export interface CardModule {
  /** Content store key (repository-relative path) */
  key: string;
  /** Content store content hash (module instances cached by "key + hash", not re-executed if hash unchanged) */
  hash: string;
  /** CommonJS text */
  js: string;
  /** Specifier written in source → resolution result (every `require("<specifier>")` in transpiled output is here) */
  imports: Record<string, ResolvedImport>;
}

/** A card's entry file along with its closure */
export interface CardBundle {
  /** Online card runtime version (`version.ts`); not loaded if different from the stage's own version */
  runtime: string;
  /** Entry file key (`src/cards/user/<name>.tsx`) */
  entry: string;
  /** Modules in the closure, entry is first */
  modules: CardModule[];
  /** Synced style files (key and text) */
  styles: { key: string; hash: string; css: string }[];
  /** Tailwind styles generated from class names in closure source (theme variables and utilities layers only); empty string if none */
  tailwind: string;
  /** Signature for this generation: runtime version + key and hash of each closure file. Switches generations only on change */
  generation: string;
}

/** Outcome of transpilation step for a card */
export type BundleResult =
  | { ok: true; entry: string; bundle: CardBundle }
  | { ok: false; entry: string; state: CardRunState };

/** Loader's outcome for a bundle */
export type LoadResult =
  | { ok: true; entry: string; generation: string; cardIds: string[] }
  | { ok: false; entry: string; generation: string; state: CardRunState };
