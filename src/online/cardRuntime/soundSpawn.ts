/**
 * How to spawn the sound thread (browser only): **bootstrapped from blob URL**, real thread script
 * fetched by the thread itself from stage origin.
 *
 * Stage Content Security Policy only allows spawning background threads from blob URLs
 * (`worker-src blob:`, `docs/plan/online-card-exec-contract.md` 3.3: blob threads inherit stage
 * document policy, while those spawned from same-origin URLs do not). Stage hardening removed
 * global `Worker` (preventing card code from spawning background threads itself); here we spawn via
 * `spawnRuntimeWorker` using native constructor retained in module closure before guard installation
 * (approach matches `src/render/gl/spawnWorker.ts`).
 *
 * In dev mode Vite serves the thread as ES module → bootstrap script uses `import`; in build output
 * the thread is bundled into an IIFE file → `importScripts`.
 */
import workerUrl from "./soundWorker.ts?worker&url";
import { trustedTypesPrelude } from "../../render/gl/spawnWorker.ts";
import { spawnRuntimeWorker } from "../isolation/scopeGuard.ts";
import type { WorkerLike } from "./soundHost.ts";

export function spawnSoundWorker(): WorkerLike {
  const abs = new URL(workerUrl, location.href).href;
  if (import.meta.env.DEV) {
    return spawnRuntimeWorker(`import ${JSON.stringify(abs)};`, { type: "module", name: "pc-card-sound" }) as unknown as WorkerLike;
  }
  return spawnRuntimeWorker(`${trustedTypesPrelude()}importScripts(${JSON.stringify(abs)});`, { name: "pc-card-sound" }) as unknown as WorkerLike;
}
