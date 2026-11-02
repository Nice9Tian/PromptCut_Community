/**
 * Unified newlines for `?raw` source code (eol-eperm).
 *
 * Vite's built-in `?raw` loader (`vite:asset`) puts the file's raw content literally into
 * `export default "..."`. On Windows, autocrlf checkouts produce CRLF, so building the same commit
 * on a CRLF checkout versus an LF checkout yields different strings in embedded source tables
 * (`src/render/cardSourceFiles.mjs`, `src/cards/user/index.ts`, `src/ai/roles/index.ts`), causing
 * different chunk hashes in online builds; the card source version calculated from it on the page
 * side (a segment of the cost identity key) also differs. Server-side code versions
 * (`server/frame-code.mjs`) were unified to LF long ago; here we align the page side with the same
 * criteria: `?raw` under project `src/` always emits LF raw text.
 *
 * Placed at `enforce: 'pre'`, preceding `vite:asset`. The card overlay layer (`cardOverridesLoader`
 * in `vite-plugin-cards.ts`, also pre) precedes this plugin in the plugins array; modified files
 * are emitted by it (which also unifies newlines itself), and this plugin only handles the rest.
 */
import fs from 'node:fs';
import path from 'node:path';

export const normalizeEol = (text) => String(text).replace(/\r\n/g, '\n');

const RAW_QUERY = /[?&]raw(?:&|$)/;

/** Whether this module id should be emitted by this plugin: absolute paths with `?raw` located under `<root>/src/` */
export function rawEolTarget(root, id) {
  if (typeof id !== 'string' || !RAW_QUERY.test(id)) return null;
  const file = id.split('?')[0];
  if (!path.isAbsolute(file)) return null;
  const rel = path.relative(path.join(root, 'src'), file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

/** Code of the `?raw` module: LF raw text */
export const rawModuleCode = (text) => `export default ${JSON.stringify(normalizeEol(text))}`;

/** Vite plugin */
export function rawEolPlugin() {
  let root = process.cwd();
  return {
    name: 'promptcut-raw-eol',
    enforce: 'pre',
    configResolved(config) { root = config.root; },
    // Same applies to entry page index.html: in build outputs it copies newlines verbatim, so dist from CRLF checkout differs from LF
    // (when Vite removes entry <script>, it leaves a CR before </body>, so unify once more before output hits disk)
    transformIndexHtml: { order: 'post', handler: (html) => normalizeEol(html) },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const item of Object.values(bundle)) {
          if (item.type === 'asset' && item.fileName.endsWith('.html') && typeof item.source === 'string') item.source = normalizeEol(item.source);
        }
      },
    },
    load(id) {
      const file = rawEolTarget(root, id);
      if (!file) return null;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
      this.addWatchFile(file);
      return rawModuleCode(text);
    },
  };
}
