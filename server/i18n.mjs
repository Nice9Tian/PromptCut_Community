/**
 * Language for text the server writes for people. Requests from the app carry their interface
 * language in the x-pc-locale header (src/i18n/index.ts). Everything else, agents and tools
 * included, gets the English source text, so an agent's view of a message never depends on who
 * is looking at the screen.
 *
 * The table lives with the interface (src/i18n) and this file does not import it: the standalone
 * agent service shares server modules that call tr(), must not depend on src/
 * (server/test/accept-018-rest-ssr-seam.test.mjs), and only ever answers in English. The editor
 * server hands the table over with useTranslator() (server/vite-plugin-locale.ts).
 *
 * Some of these modules also run in the page (server/auth/client.mjs, server/render-node/): there
 * src/i18n/index.ts puts the page's language and the table into the same state, and nothing here
 * may import a node: module statically (src/pageNodeImports.test.mjs).
 */

/*
 * One state per process or page. Vite bundles the config's own imports, while modules loaded at run
 * time come from disk: both copies of this file must see the same request and the same table.
 */
const state = (globalThis[Symbol.for('promptcut.i18n')] ??= { translate: null, known: new Set(['en']), locale: 'en' });
const hooks = globalThis.process?.getBuiltinModule?.('node:async_hooks');
state.current ??= hooks ? new hooks.AsyncLocalStorage() : null;
state.extra ??= {};
state.version ??= 0;

/** The editor server installs the table: translate(locale, source, args), and the languages it knows */
export function useTranslator(translate, locales) {
  state.translate = translate;
  state.known = new Set(['en', ...locales]);
}

/**
 * Rows kept outside src/i18n/table.json, for code that ships its own table: looked up after it.
 * The same as addRows() in src/i18n/index.ts, which reads them through the shared state.
 */
export function addRows(rows) {
  Object.assign(state.extra, rows);
  state.version++;
}

/** Connect middleware: the rest of this request runs in the language it asked for */
export function localeMiddleware(req, _res, next) {
  const asked = req.headers['x-pc-locale'];
  if (!state.current) return next();
  state.current.run(state.known.has(asked) ? asked : 'en', next);
}

const fill = (text, args) => (args.length ? text.replace(/\{(\d+)\}/g, (hole, index) => (Number(index) < args.length ? String(args[Number(index)]) : hole)) : text);

export function tr(source, ...args) {
  const locale = state.current?.getStore() ?? state.locale ?? 'en';
  return state.translate ? state.translate(locale, source, args) : fill(source, args);
}
