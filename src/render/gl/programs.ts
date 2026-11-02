/**
 * Registry for the function half of canvas cards (R9 M1).
 *
 * Each card migrated into the shared renderer places an `<id>.gl.ts` next to its own file, exporting
 * `program` (`CanvasCardProgram`). Collected all at once here with `import.meta.glob`: **the Worker
 * and the main-thread fallback import the same table**, so both paths render the same code.
 * `eager: true`: no code splitting in the Worker, one bundle carries everything.
 *
 * Key = filename without `.gl.ts` (matches card id); `.gl.ts` can also explicitly export `programId`
 * to override. User cards' `.gl.ts` is served as usual by vite in the desktop runtime environment;
 * online browser mode only has built-in cards.
 */
import type { CanvasCardProgram } from "./CanvasCardProgram";

const modules = import.meta.glob<{ program?: CanvasCardProgram; programId?: string }>("../../cards/**/*.gl.ts", { eager: true });

const table = new Map<string, CanvasCardProgram>();
for (const [file, mod] of Object.entries(modules)) {
  if (!mod?.program) continue;
  const base = file.split("/").pop()!.replace(/\.gl\.ts$/, "");
  table.set(mod.programId ?? base, mod.program);
}

export function programOf(programId: string): CanvasCardProgram | undefined {
  return table.get(programId);
}

export function programIds(): string[] {
  return [...table.keys()].sort();
}
