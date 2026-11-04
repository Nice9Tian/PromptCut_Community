/**
 * First line in unit tests `import "../testing/registerTs.mjs"`: installs the resolve hook from
 * `resolveTs.mjs`, so that relative imports without extensions in subsequent `await import()`
 * `.ts` modules can also be resolved.
 *
 * Also provides a URL builder for files under `src/`, since `mock.module` expects resolved URLs.
 */
import { register } from "node:module";

register(new URL("./resolveTs.mjs", import.meta.url));

/** `srcUrl("store/project.ts")` → file URL of `src/store/project.ts` */
export const srcUrl = (relative) => new URL(`../${relative}`, import.meta.url).href;
