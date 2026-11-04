import type { Plugin } from "vite";
import { LOCALES, translate } from "../src/i18n/index.ts";
import { localeMiddleware, useTranslator } from "./i18n.mjs";

/** Runs first, so every later middleware sees the request's language (server/i18n.mjs). */
export function localePlugin(): Plugin {
  // The editor server is the one that answers people in their own language: it brings the table
  useTranslator(translate, LOCALES.map((l) => l.id));
  return {
    name: "promptcut-locale",
    configureServer(server) {
      server.middlewares.use(localeMiddleware);
    },
  };
}
