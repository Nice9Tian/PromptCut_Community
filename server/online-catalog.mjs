/**
 * Motion graphics asset catalog in online builds (dedicated to `vite build --mode online`).
 *
 * On desktop, `/catalog/<kind>/<name>.json` is served by dev server middleware (the `/catalog`
 * route in `server/vite-plugin-cards.ts`), allowing only names registered in
 * `server/catalog/<kind>/index.json`. Card parameters store same-origin absolute paths (e.g.
 * `/catalog/lottie/bodymovin.json`); the same project must open on both desktop and online, so the
 * address remains unchanged; since online pages have no local process, the build outputs the same
 * batch of files verbatim to `dist-online/catalog/<kind>/<name>.json`, deployed with the online
 * build to `<deploy directory>/editor/catalog/`, served by nginx on the hosted side under `/catalog/`
 * (needed by both the editor page origin and the two stage origins: fetch inside stage iframes
 * resolves to the stage's own origin).
 *
 * Outputs only registered entries, matching the set allowed by the middleware: kinds recognize only
 * lottie and particles, names recognize only `[A-Za-z0-9-]+`. The page does not read index.json at
 * runtime (`src/cards/catalogAssets.ts` imports it at build time), so index.json itself is not output.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CATALOG_KINDS = ['lottie', 'particles'];
const NAME = /^[A-Za-z0-9-]+$/;

/** Entries registered in `server/catalog/<kind>/index.json`: `{ kind, name, fileName: 'catalog/<kind>/<name>.json', source: absolute path }` */
export function catalogEntries(root) {
  const out = [];
  for (const kind of CATALOG_KINDS) {
    const dir = path.join(root, 'server', 'catalog', kind);
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    for (const item of index.items ?? []) {
      const name = String(item?.name ?? '');
      if (!NAME.test(name)) throw new Error(`[online-catalog] The name "${name}" in ${kind}/index.json does not match [A-Za-z0-9-]+ (the desktop app's /catalog route cannot fetch it either)`);
      const source = path.join(dir, `${name}.json`);
      if (!fs.existsSync(source)) throw new Error(`[online-catalog] ${kind}/index.json registers "${name}", but ${source} does not exist`);
      out.push({ kind, name, fileName: `catalog/${kind}/${name}.json`, source });
    }
  }
  return out;
}

/** Vite plugin: outputs registered entries byte-for-byte to `catalog/<kind>/<name>.json` in the output directory during build */
export function onlineCatalogPlugin(root = process.cwd()) {
  return {
    name: 'promptcut-online-catalog',
    apply: 'build',
    generateBundle() {
      for (const e of catalogEntries(root)) this.emitFile({ type: 'asset', fileName: e.fileName, source: fs.readFileSync(e.source) });
    },
  };
}
