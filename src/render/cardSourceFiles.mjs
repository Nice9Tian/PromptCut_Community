// Keep this Vite macro unconditional: conditional import.meta.glob is not
// transformed into the eager raw module table.
const globbed = import.meta.glob([
  '/src/cards/**/*.{ts,tsx,mjs,css}', '/src/parts/**/*.{ts,tsx,mjs,css}',
  '/src/render/**/*.{ts,tsx,mjs,css}', '/src/kernel/**/*.{ts,tsx,mjs,css}',
  '!/src/**/*.test.{ts,tsx,mjs,js}',
], { query: '?raw', import: 'default', eager: true });

/*
 * Hot reload boundary (C6.6 integration 3b): if any file under cards, parts, render, or kernel
 * changes, this source code table must be recomputed. Previously it did not handle hot reload,
 * bubbling all the way to the editor along
 * "this module → costIdentity → probeRunner → ProbeGate / Preview",
 * causing Preview's effect to rerun during Fast Refresh and clear the stage's RPC client.
 * Now this module catches it directly: on rerun, it writes the new table **in place** into the object
 * exported the first time (referencing modules always hold that same instance), so no one needs
 * to be notified to swap references, and the next source version / identity key calculation reads
 * the updated table.
 */
const kept = import.meta.hot?.data?.files;
if (kept) {
  for (const k of Object.keys(kept)) if (!(k in globbed)) delete kept[k];
  Object.assign(kept, globbed);
}
export const builtinCardSourceFiles = kept ?? globbed;
if (import.meta.hot) {
  import.meta.hot.data.files = builtinCardSourceFiles;
  import.meta.hot.data.version = (import.meta.hot.data.version ?? -1) + 1;
  import.meta.hot.accept();
}

/**
 * Number of times the source code table has changed (0 on initial load, incremented by one for each
 * hot reload rerun). Callers memoizing on the source code table (the source version table in
 * `costIdentity.ts`) use this as their key. Reads `import.meta.hot.data` (shared across executions
 * of the same module), so older instances of this function held by callers also read the new value.
 */
export function cardSourceFilesVersion() {
  return import.meta.hot?.data?.version ?? 0;
}
