/*
 * Alias resolution for browser-side cloud extension packages (public side,
 * `docs/plan/community-boundary.md` section 2 "Invariants", item 2).
 *
 * Invariant 2 states: shared code knows no names of cloud modules, Node side gets tables from
 * callers, **the browser side uses aliases**. This plugin is that alias. Browser-side loading
 * points import the following specifiers; none of them write paths:
 *
 *   #promptcut-cloud-ai            → <cloud directory>/ai/manifest.ts
 *   #promptcut-cloud-account       → <cloud directory>/account/manifest.ts
 *   #promptcut-cloud-account-ui    → <cloud directory>/account/ui-manifest.tsx
 *   #promptcut-cloud-online        → <cloud directory>/online/manifest.ts
 *
 * If the target is not found, it resolves to `src/community/cloudSeamStub.ts`
 * (a module that exports nothing), so the loading point determines "extension not installed"
 * and falls back to the default implementation included on the public side.
 *
 * Why not write a `vite.config.ts` alias in each repository (as originally written in section 10
 * of the master plan): then each repository would need its own `vite.config.ts` with different
 * contents, whereas it is now a file in the shared tree. By making it a public plugin, both
 * repositories share the same `vite.config.ts`, and the cloud directory is found via
 * `PROMPTCUT_CLOUD_DIR`: the same convention as `server/docservice/extensions.mjs` and
 * `server/vite-plugin-hosted-gate.ts`.
 *
 * Why aliases are strictly necessary (these are three real pitfalls, not pedantry): the three
 * active browser-side loading points A, B, and E were originally written as dynamic imports using
 * `new URL("../../../<closed source directory>/…/manifest.ts", import.meta.url)` with
 * `@vite-ignore`. That pattern **fails to load at all** in production builds: `.ts` files do not
 * enter the build output, and `@vite-ignore` prevents Vite from analyzing them, so importing a
 * non-existent URL at runtime fails silently when swallowed by `catch`, while the private
 * repository has all files and appears fine.
 *
 * Additionally, write the product declaration (`product.config.json`, use the one in the closed
 * source directory if present, see `server/auth/product.mjs`) into `__PROMPTCUT_PRODUCT__`: this
 * plugin is the only one attached to every configuration, so passing the declaration through here
 * ensures no build is missed.
 *
 * Gatekeeper exception declaration: this file is the sole exception to "shared tree must not load
 * closed source directories" in browser builds, registered in `LOADER_WHITELIST` of
 * `server/test/community-ownership.mjs`. This file contains no concrete cloud business module
 * paths; it only concatenates `<cloud directory>/<subpath>` according to the table below.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Alias → subpath under cloud directory. Add a line here when adding a new browser-side seam. */
const SEAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "#promptcut-cloud-ai": ["ai", "manifest.ts"],
  "#promptcut-cloud-account": ["account", "manifest.ts"],
  "#promptcut-cloud-account-ui": ["account", "ui-manifest.tsx"],
  "#promptcut-cloud-online": ["online", "manifest.ts"],
});

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = existsSync(path.join(here, "..", "package.json")) ? path.resolve(here, "..") : process.cwd();

/**
 * Cloud directory: same convention as `server/docservice/extensions.mjs` (not under repository
 * root in submodule layout)
 */
function cloudDirOf(): string {
  const env = process.env.PROMPTCUT_CLOUD_DIR?.trim();
  return env ? path.resolve(env) : path.join(repoRoot, "cloud");
}

const STUB = path.join(repoRoot, "src", "community", "cloudSeamStub.ts");

/**
 * Product declaration: the copy in the closed source directory takes precedence; otherwise the
 * public edition copy
 */
function productDeclaration(): string {
  const closed = path.join(cloudDirOf(), "product.config.json");
  return readFileSync(existsSync(closed) ? closed : path.join(repoRoot, "product.config.json"), "utf8");
}

export function cloudSeamsPlugin(): Plugin {
  return {
    name: "promptcut-cloud-seams",
    enforce: "pre",
    config: () => ({ define: { __PROMPTCUT_PRODUCT__: JSON.stringify(JSON.parse(productDeclaration())) } }),
    resolveId(source) {
      const sub = SEAMS[source];
      if (!sub) return null;
      const target = path.join(cloudDirOf(), ...sub);
      return existsSync(target) ? target : STUB;
    },
  };
}

export default cloudSeamsPlugin;
