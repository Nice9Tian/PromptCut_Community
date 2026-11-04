/*
 * Type contract for cloud extension package aliases on the browser side.
 *
 * These specifiers are resolved at build time by `server/vite-plugin-cloud-seams.ts`: pointing to the
 * loader table over there if the closed source directory exists, or to `./cloudSeamStub.ts` (exporting
 * nothing) if it does not. This file is verbatim identical in both repositories, so **it is the
 * interface agreed upon by both sides**: the loader table on the closed source side must export in the
 * shape declared here, and call sites on the open side call according to the shape here.
 *
 * Declaring all of them as optional (`?`) is intentional: the empty stub exports none of them, so
 * call sites must check presence before calling. The four gates in Section 7 do not govern shape (G4
 * only verifies that "the table can be synchronously required in, with a default or manifest export");
 * this declaration is currently the only place where the shape is written down: if the signature of
 * the loader table on the closed source side changes, this file must change too.
 */
declare module "#promptcut-cloud-ai" {
  /**
   * Loader table for cloud AI providers, passed to `applyAiManifest` in `src/ai/extensions.ts` to
   * normalize and register.
   */
  export const manifest: readonly unknown[] | undefined;
  const fallback: readonly unknown[] | undefined;
  export default fallback;
}

declare module "#promptcut-cloud-account" {
  /**
   * Registers website account extensions (`registerAccountExtensions`, etc.), exported by
   * `cloud/account/manifest.ts`.
   */
  export const register: (() => Promise<void> | void) | undefined;
}

declare module "#promptcut-cloud-account-ui" {
  /**
   * Registers account-related UI extensions (including JSX), exported by
   * `cloud/account/ui-manifest.tsx`.
   */
  export const registerUi: (() => Promise<void> | void) | undefined;
}

declare module "#promptcut-cloud-online" {
  /**
   * End-to-end seam table for online builds (buildInfo / apiGuard / updateCheck / UpdateNotice /
   * sync backend).
   */
  export const manifest: Record<string, unknown> | undefined;
  const fallback: Record<string, unknown> | undefined;
  export default fallback;
}
