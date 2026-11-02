/**
 * Language for text the server writes for people. Requests from the app carry their interface
 * language in the x-pc-locale header (src/i18n/index.ts). Everything else, agents and tools
 * included, gets the English source text, so an agent's view of a message never depends on who
 * is looking at the screen.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { LOCALES, translate } from '../src/i18n/index.ts';

const current = new AsyncLocalStorage();

/** Connect middleware: the rest of this request runs in the language it asked for */
export function localeMiddleware(req, _res, next) {
  const asked = req.headers['x-pc-locale'];
  current.run(LOCALES.some((l) => l.id === asked) ? asked : 'en', next);
}

export function tr(source, ...args) {
  return translate(current.getStore() ?? 'en', source, args);
}
