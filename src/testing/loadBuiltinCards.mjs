/**
 * Read declarations of all built-in cards in Node (shared by gatekeeper test
 * `src/cards/capabilities.test.mjs` and `scripts/probes/card-table-digest-compare.mjs`).
 *
 * Built-in cards = the four groups registered together with `registerCards` in `src/cards/index.ts`:
 * magicui, native, media wrapper cards (generated from asset catalog), probe cards. Cards are `.tsx`
 * and use `import.meta.glob`, so loaded via vite's `ssrLoadModule`; read declarations only, do not render.
 *
 * Usage:
 *   const kit = await loadBuiltinCards(root);
 *   try { kit.groups.native …; await kit.load('/src/kernel/registry.ts') } finally { await kit.close() }
 *
 * Process can exit cleanly on its own after `close()` (gatekeeper test relies on this; browser shell
 * specifically handles timers left behind by playback library).
 */
import { createServer } from "vite";

/** The four groups of `registerCards([...])` in `src/cards/index.ts`: export name → module */
export const BUILTIN_CARD_GROUPS = {
  magicuiCards: "/src/cards/magicui/index.ts",
  nativeCards: "/src/cards/native/index.ts",
  assetCards: "/src/cards/assets/index.ts",
  probeCards: "/src/cards/_probe/index.ts",
};

/** Browser globals needed upon card module load (lottie-web, tsParticles, etc.); provide a shell just to read card declarations */
export function stubBrowserGlobals() {
  const g = globalThis;
  g.window ??= g;
  // lottie-web draws on a canvas upon load to test features: provide a context that accepts
  // everything and does nothing
  const context = () => new Proxy({}, { get: () => () => ({ data: [0, 0, 0, 0] }), set: () => true });
  const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: context, addEventListener() {} });
  // Set readyState to complete: lottie-web polls every 100 ms after loading to check if document
  // is ready and only stops when found; without stopping, process cannot exit cleanly
  g.document ??= { readyState: "complete", createElement: el, createElementNS: el, documentElement: { style: {} }, body: el(), head: el(),
    getElementsByTagName: () => [], getElementsByClassName: () => [], addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  if (!g.navigator) Object.defineProperty(g, "navigator", { value: { userAgent: "node" }, configurable: true });
  // Do not actually schedule callbacks: only read declarations and do not render here;
  // scheduling them keeps library loop continuing indefinitely, process cannot exit cleanly
  g.requestAnimationFrame ??= () => 0;
  g.cancelAnimationFrame ??= () => {};
  g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}

/**
 * @param {string} root Root of repository (or directory extracted from a commit)
 * @returns {Promise<{ groups: Record<string, any[]>, cards: any[], load: (file: string) => Promise<any>, close: () => Promise<void> }>}
 *   `cards` is the raw declarations of the four groups concatenated in registration order
 *   (not rewritten by registry)
 */
export async function loadBuiltinCards(root) {
  stubBrowserGlobals();
  const vite = await createServer({ root, configFile: false, logLevel: "error",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const load = (file) => vite.ssrLoadModule(file);
    const groups = {};
    for (const [name, file] of Object.entries(BUILTIN_CARD_GROUPS)) {
      const cards = (await load(file))[name];
      if (!Array.isArray(cards)) throw new Error(`${file} does not export ${name}`);
      groups[name] = cards;
    }
    return { groups, cards: Object.values(groups).flat(), load, close: () => vite.close() };
  } catch (error) {
    await vite.close();
    throw error;
  }
}
