/**
 * Resolve hook for `node --test`: when a relative path has no extension, try `.ts` / `.tsx` /
 * `/index.ts` in order.
 *
 * Many editor modules follow Vite conventions like `import … from "../store/project"`, which
 * Node's ESM resolver does not recognize, throwing `ERR_MODULE_NOT_FOUND` on import. Install this
 * in unit tests via `import "../testing/registerTs.mjs"`, and use `mock.module` to replace heavy
 * dependencies that cannot be loaded into Node (stores, card registry).
 *
 * Only adds resolution, does not transpile: `.tsx` can be resolved, but Node's type stripping does
 * not support JSX; if execution actually reaches `.tsx`, it still needs to be mocked.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HAS_EXT = /\.(?:[cm]?[jt]sx?|json|css)$/;

export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && !HAS_EXT.test(specifier) && context.parentURL?.startsWith("file:")) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
  }
  return next(specifier, context);
}
