/*
 * Online build pruning: replaces modules that **only make sense for the editor process** with
 * empty stubs (the "Online build pruning" section of `src/online/pageFlag.ts`, M8 legacy L24).
 * Only attached to the online configuration in `vite.config.ts`.
 *
 * -- Why this is necessary --
 *
 * In online browser mode, there is no editor process, so none of the `/api/*` routes work.
 * Section 2 of the contract requires these entry points to be **pruned along with their underlying
 * `/api` calls** in the online build, verified against build outputs by `C10A-API-03` in
 * `server/test/c10a-online-build.test.mjs` using the ratchet manifest.
 *
 * But compile-time constants cannot prune them. The `pageFlag.ts` section itself explains: rolldown
 * tree-shaking "only eliminates inlined function literals, not the modules they reference".
 * In practice, the code takes these two shapes:
 *
 *     src/StartPage.tsx:157        ONLINE_BUILD ? OnlineStartPage : DesktopStartPage
 *     src/editor/dock/DockPages.tsx:39  memo(ONLINE_BUILD ? OnlineAgentSwitch : AiPanel)
 *
 * After ternary folding, that branch is dead code, but the imported module still remains in the
 * graph. Consequently, on 2026-10-27 it was discovered that the online output contained 8
 * desktop-only endpoints (`/api/ai/` along with abort, auth-state, chat, config, config/clear-key,
 * providers, setup). There are zero `/api/ai*` entries in the ratchet manifest: meaning all 8
 * should not be there.
 *
 * Chunk splitting with `lazy()` does not work either: `C10A-API-03` scans **all** `.js` files in
 * the output directory, so an isolated chunk is still scanned. Moving path strings to other
 * modules is even worse: that just tricks the test while leaving dead code behind. So the only
 * path left is "this module does not enter the build output at all in the online build".
 *
 * -- Which ones to prune, and on what basis --
 *
 * Calculated from rolldown's own module graph (not human guesswork): those 8 paths originate from
 * only three leaf modules: `src/ai/providerState.ts`, `src/ai/useAiChat.ts`, and
 * `src/editor/right/AiSetupDialog.tsx`, and their importer closures terminate at the three roots
 * below, each **imported by name in only one place**:
 *
 *   src/editor/right/AiPanel.tsx    Desktop app AI panel      Online uses OnlineAgentPage (DockPages.tsx:39)
 *   src/start/DesktopStart.tsx      Desktop app start page    Online uses OnlineStart (StartPage.tsx:157)
 *   src/mobile/AgentChatLocal.tsx   Mobile connects to local Agent  In online, local is always false (AgentPage.tsx:38)
 *
 * All three are **dead at runtime** in the online build (the conditions above are all compile-time
 * constants), so replacing them with empty stubs is safe: this is not "hiding" them, but removing
 * branches from the output that could never be reached anyway. Cutting these three edges makes
 * `useVibeLocal` → `useAiChat` → `providerState` and `AiSetupDialog` all unreachable.
 *
 * -- When adding entries --
 *
 * This table only allows modules that are "unreachable at runtime in the online build", and the
 * comments must specify which line holds the condition. If the condition is not a compile-time
 * constant, it is not allowed in this table: in that case, the code structure should be changed,
 * not the pruning table.
 */
import path from "node:path";
import type { Plugin } from "vite";

/** Module (repository-relative path) → empty stub export name. Must match what real module exports. */
const PRUNED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "src/editor/right/AiPanel.tsx": ["AiPanel"],
  "src/start/DesktopStart.tsx": ["DesktopStart"],
  "src/mobile/AgentChatLocal.tsx": ["AgentChatLocal"],
});

function stubFor(rel: string, names: readonly string[]): string {
  const lines = [
    `/* Empty stub after online build pruning (server/vite-plugin-online-prune.ts). Real implementation: ${rel} */`,
    // If actually rendered, something is wrong: someone made this branch reachable in the online build,
    // invalidating the premise of the table above
    `function pruned(name) {`,
    `  if (typeof console !== "undefined") {`,
    `    console.error("[promptcut] desktop-only component " + name + " (${rel}) was rendered in the online build, it should be unreachable");`,
    `  }`,
    `  return null;`,
    `}`,
  ];
  for (const n of names) lines.push(`export function ${n}() { return pruned(${JSON.stringify(n)}); }`);
  return lines.join("\n") + "\n";
}

export function onlinePrunePlugin(): Plugin {
  let root = process.cwd();
  return {
    name: "promptcut-online-prune",
    enforce: "pre",
    configResolved(cfg) {
      root = cfg.root;
    },
    load(id) {
      const clean = id.split("?")[0];
      const rel = path.relative(root, clean).split(path.sep).join("/");
      const names = PRUNED[rel];
      return names ? stubFor(rel, names) : null;
    },
  };
}

/** For gatekeeper tests: which modules are in this table */
export const PRUNED_MODULES = Object.freeze(Object.keys(PRUNED));

export default onlinePrunePlugin;
