/**
 * Spawns the GL Worker (R9 M2). Both `glHost` of the stage / export page (Route 1) and editor parent
 * page (Route 2) spawn through here.
 *
 * **Why not `new Worker(new URL('./glWorker.ts', import.meta.url))` directly**: in that case, the
 * Worker's main script is a request issued by the page itself, while its completion event
 * (`loadingFinished`) is reported to the Worker's own target in CDP: `waitNet`
 * (`server/bakery/chrome.mjs`) on the export page sees it as constantly "in flight" in the page's
 * Network domain, waiting the full 30 seconds per frame in vain and erroring (empirically tested).
 * Therefore the page only spawns a `blob:` bootstrap script; the real module is fetched by the
 * Worker itself, and that request is recorded on the Worker's target, not charged to the page.
 *
 * Stage hardening removes global `Worker` (preventing card code from spawning background threads
 * itself); here it spawns via `spawnRuntimeWorker` using the native constructor preserved in the
 * module closure before the guard was installed. In development vite serves Workers as ES modules →
 * bootstrap script uses `import`; in build outputs Workers default to IIFE → `importScripts`.
 */
import workerUrl from "./glWorker.ts?worker&url";
import { spawnRuntimeWorker } from "../../online/isolation/scopeGuard.ts";

/**
 * If an online cross-origin stage carries Trusted Types (`require-trusted-types-for 'script'`), the
 * blob Worker inherits it: `importScripts` in the Worker requires a default policy first. Add this
 * statement only when this document already has a default policy; elsewhere the bootstrap script
 * remains completely unchanged.
 */
export function trustedTypesPrelude(): string {
  const tt = (globalThis as { trustedTypes?: { defaultPolicy?: unknown } }).trustedTypes;
  if (!tt?.defaultPolicy) return "";
  return `if (self.trustedTypes && !self.trustedTypes.defaultPolicy) self.trustedTypes.createPolicy("default", { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s });`;
}

export function spawnGlWorker(): Worker {
  const abs = new URL(workerUrl, location.href).href;
  if (import.meta.env.DEV) {
    return spawnRuntimeWorker(`import ${JSON.stringify(abs)};`, { type: "module" });
  }
  return spawnRuntimeWorker(`${trustedTypesPrelude()}importScripts(${JSON.stringify(abs)});`);
}
