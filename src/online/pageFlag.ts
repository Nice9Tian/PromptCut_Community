/**
 * **Runtime** flag for online browser mode (C10a integration rework).
 *
 * `ONLINE` in `mode.ts` is a compile-time constant, but it reads `import.meta.env`, so modules loaded
 * by Node unit tests cannot statically import it (gatekeeper `src/online/modeImportGuard.test.mjs`).
 * To stop editor process `/api/*` calls in online pages (contract section 2: either hide/grey out or
 * use online alternatives), these modules read this flag: `boot.ts` sets it when `ONLINE` is true,
 * before other modules evaluate. It is always false in desktop runtime environments and Node unit
 * tests.
 *
 * **Online build pruning** (M8 leftover L24): this flag is runtime, so the online build will not prune
 * any code because of it; the same applies when importing `ONLINE` from `mode.ts` from other modules:
 * testing showed rolldown tree-shaking does not recognize imported constants (imported constants are
 * only replaced with literals during subsequent inlining and minification, at which point only locally
 * written function literals can be pruned, but not the modules they import). To let the online build
 * prune both the code and the underlying `/api` calls, write a line in-place in **modules that use
 * it**:
 *
 *     const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
 *
 * The value is identical to `ONLINE` (Vite replaces `import.meta.env.VITE_PC_ONLINE` with a literal in
 * both build and dev server), and in Node unit tests `import.meta.env` does not exist and is false,
 * avoiding immediate throws like statically importing `mode.ts`. Gatekeeper:
 * `src/online/onlinePrune.test.mjs` checks that this line is identical verbatim, and
 * `server/test/c10a-online-build.test.mjs` checks that the `/api` ratchet manifest matches build
 * artifacts.
 */

const KEY = "__pcOnlinePage";

export function onlinePage(): boolean {
  return (globalThis as Record<string, unknown>)[KEY] === true;
}

export function markOnlinePage(): void {
  (globalThis as Record<string, unknown>)[KEY] = true;
}

