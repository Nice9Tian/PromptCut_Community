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
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/*
 * One state per process. Vite bundles the config's own imports, while modules loaded at run time
 * come from disk: both copies of this file must see the same request and the same table.
 */
const state = (globalThis[Symbol.for('promptcut.i18n')] ??= { current: new AsyncLocalStorage(), translate: null, known: new Set(['en']) });

/** The editor server installs the table: translate(locale, source, args), and the languages it knows */
export function useTranslator(translate, locales) {
  state.translate = translate;
  state.known = new Set(['en', ...locales]);
}

/** Connect middleware: the rest of this request runs in the language it asked for */
export function localeMiddleware(req, _res, next) {
  const asked = req.headers['x-pc-locale'];
  state.current.run(state.known.has(asked) ? asked : 'en', next);
}

const fill = (text, args) => (args.length ? text.replace(/\{(\d+)\}/g, (hole, index) => (Number(index) < args.length ? String(args[Number(index)]) : hole)) : text);

export function tr(source, ...args) {
  const locale = state.current.getStore() ?? 'en';
  return state.translate ? state.translate(locale, source, args) : fill(source, args);
}
