import type { Plugin } from "vite";
import { localeMiddleware } from "./i18n.mjs";

/** Runs first, so every later middleware sees the request's language (server/i18n.mjs). */
export function localePlugin(): Plugin {
  return {
    name: "promptcut-locale",
    configureServer(server) {
      server.middlewares.use(localeMiddleware);
    },
  };
}
