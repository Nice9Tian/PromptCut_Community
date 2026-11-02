/**
 * Execute transpiled card modules in an isolated environment
 * (`docs/plan/online-card-exec-contract.md` Sections 2 and 8).
 *
 * **Only permitted in cross-origin stages and sound threads spawned by stages.** Editor pages,
 * same-origin single stages, and export pages do not construct a loader (pinned by gatekeeper test
 * `cardRuntime.test.mjs`: `src/editor/` and `src/export/` do not import this file). This file does
 * not touch the DOM or network: how styles are injected, whom definitions are handed to, and whom
 * status is reported to are all handled by callbacks supplied by the creator, so stage and sound
 * thread share the same implementation.
 *
 * A bundle (`CardBundle`) = a card's entry plus closure. Loading steps:
 *   1. Fetch page built-in modules (packages and built-in modules) used in the closure first (some
 *      require on-demand loading, while execution is synchronous);
 *   2. Starting from the entry, execute CommonJS-style:
 *      `new Function("require", "module", "exports", code)`;
 *      module instances are separated per bundle (one set per card: if any file in the closure
 *      changes, the entire card re-executes, avoiding unchanged modules holding on to stale
 *      dependencies); therefore, when two cards import the same synced file, each has its own
 *      instance, unlike desktop (where it is shared), and module-level state is not shared across
 *      cards; page built-in modules are always that same page instance; cycles are handled
 *      following CommonJS;
 *   3. In entry exports, accept anything resembling a card definition (structural check matches
 *      `isCardDef` in desktop `src/cards/user/index.ts`).
 * If any step fails, this bundle does not take effect and reports runtime status (`missing-module` /
 * `unsupported-syntax` / `load-error`). When loading a new generation fails, the previous generation
 * is also torn down: do not render a new version with old code.
 */
import type { CardDef } from "../../kernel/types.ts";
import type { CardBundle, CardModule, CardRunState, LoadResult, ResolvedImport } from "./protocol.ts";

/** Page built-in module table (stage uses `hostModules.ts`; sound thread uses placeholder version) */
export interface HostModules {
  /** Package name → module getter (can be async on-demand); packages not in table cannot be imported */
  packages: Readonly<Record<string, () => unknown | Promise<unknown>>>;
  /** Repository-relative path of built-in module → module getter function; returns null if not found */
  builtin: (path: string) => (() => unknown | Promise<unknown>) | null;
}

export interface CardLoaderOptions {
  /** Online card runtime version for this environment; bundles with different versions are not loaded */
  runtime: string;
  host: HostModules;
  /**
   * Compiles CommonJS text into a function. Defaults to `new Function` (stage Content Security
   * Policy includes `'unsafe-eval'`).
   * In environments with Trusted Types enabled, the creator provides an implementation using a policy.
   */
  compile?: (code: string, key: string) => (require: (spec: string) => unknown, module: { exports: unknown }, exports: unknown) => void;
  /**
   * Styles for this card changed: `css` is all the styles it should have at this moment (synced style
   * files first, followed by supplementary generated Tailwind styles); empty string = tear down. In
   * the stage, replace a `<style data-pc-card-style="<entry>">`; sound thread does not supply this
   * callback.
   */
  onStyle?: (entry: string, css: string) => void;
  /**
   * Each CSS is injected independently, Tailwind last; preserve each file's @import
   * atStartOfOwnStylesheet. Takes precedence over onStyle when provided.
   */
  onStyles?: (entry: string, cssFiles: readonly string[]) => void;
  /** Loaded card definitions replaced (all bundles combined; for duplicate ids, earlier entry key wins) */
  onCards?: (defs: CardDef<any>[]) => void;
  /** Entry outcomes changed (entry key → outcome); creator computes each card's runtime status and reports to editor page */
  onResults?: (results: ReadonlyMap<string, LoadResult>) => void;
}

export interface CardLoader {
  /**
   * Replace the full set with this group of bundles (the full payload sent by the editor page after
   * each sync). Unchanged bundles (same generation) are not touched or re-executed; bundles not in
   * this group are torn down. Returns outcomes for each entry. On concurrent calls, the later one
   * waits for the previous one to finish.
   */
  setBundles(bundles: readonly CardBundle[]): Promise<LoadResult[]>;
  /** Card definitions successfully loaded at this moment */
  cards(): CardDef<any>[];
  /** Outcomes for each entry at this moment */
  results(): ReadonlyMap<string, LoadResult>;
  /** Tear down all (when stage unmounts or falls back to same-origin single stage) */
  clear(): void;
}

interface Instance { module: { exports: unknown }; done: boolean }
interface Loaded { bundle: CardBundle; result: LoadResult; defs: CardDef<any>[] }

/** Structural check: exports resembling CardDef (matches `isCardDef` in `src/cards/user/index.ts`) */
export function isCardDef(value: unknown): value is CardDef<any> {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<CardDef<any>>;
  return typeof c.id === "string" && !!c.id && typeof c.name === "string" && !!c.defaults && typeof c.defaults === "object" && Array.isArray(c.controls)
    && (typeof c.Component === "function" || typeof c.card === "function" || typeof c.audio === "function");
}

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0].slice(0, 200);

const defaultCompile: NonNullable<CardLoaderOptions["compile"]> = (code, key) =>
  // sourceURL: makes visible in the stack trace which synced file it is when an error occurs
  new Function("require", "module", "exports", `${code}\n//# sourceURL=pc-card:///${key}`) as ReturnType<NonNullable<CardLoaderOptions["compile"]>>;

export function createCardLoader(opts: CardLoaderOptions): CardLoader {
  const compile = opts.compile ?? defaultCompile;
  /** Entry key → loaded bundle */
  const loaded = new Map<string, Loaded>();
  /** Fetched page built-in modules */
  const hostCache = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();

  const hostKey = (r: ResolvedImport) => (r.kind === "package" ? `p:${r.name}` : r.kind === "builtin" ? `b:${r.path}` : null);

  /** Step 1: fetch all page built-in modules required by this bundle; return its name if unavailable */
  async function preload(bundle: CardBundle): Promise<{ missing: string; file: string } | null> {
    for (const m of bundle.modules) {
      for (const r of Object.values(m.imports)) {
        const k = hostKey(r);
        if (!k || hostCache.has(k)) continue;
        const name = r.kind === "package" ? r.name : (r as { path: string }).path;
        const get = r.kind === "package"
          ? (Object.hasOwn(opts.host.packages, r.name) ? opts.host.packages[r.name] : null)
          : opts.host.builtin((r as { path: string }).path);
        if (!get) return { missing: name, file: m.key };
        try { hostCache.set(k, await get()); } catch { return { missing: name, file: m.key }; }
      }
    }
    return null;
  }

  /** Steps 2 and 3: execute entry and collect card definitions */
  function evaluate(bundle: CardBundle): { defs: CardDef<any>[] } | { state: CardRunState } {
    const byKey = new Map<string, CardModule>(bundle.modules.map((m) => [m.key, m]));
    /** Module instances belonging to this bundle (key → instance) */
    const instances = new Map<string, Instance>();
    const run = (m: CardModule): unknown => {
      const hit = instances.get(m.key);
      if (hit) return hit.module.exports; // Partially executed modules (cyclic) return their exports at this moment
      const inst: Instance = { module: { exports: {} }, done: false };
      instances.set(m.key, inst);
      const require = (spec: string): unknown => {
        const r = Object.hasOwn(m.imports, spec) ? m.imports[spec] : undefined;
        if (!r) throw new Error(`The online page has no such module: ${String(spec).slice(0, 80)}`);
        if (r.kind === "style") return {};
        if (r.kind === "synced") {
          const dep = byKey.get(r.key);
          if (!dep) throw new Error(`Bundle is missing ${r.key}`);
          return run(dep);
        }
        return hostCache.get(hostKey(r)!);
      };
      compile(m.js, m.key)(require, inst.module, inst.module.exports);
      inst.done = true;
      return inst.module.exports;
    };
    const entry = bundle.modules[0];
    if (!entry || entry.key !== bundle.entry) return { state: { state: "load-error", detail: "Bundle has no entry file", file: bundle.entry } };
    let exports: unknown;
    try {
      exports = run(entry);
    } catch (err) {
      const syntax = err instanceof SyntaxError;
      return { state: { state: syntax ? "unsupported-syntax" : "load-error", detail: firstLine(err), file: bundle.entry } };
    }
    const defs: CardDef<any>[] = [];
    const seen = new Set<string>();
    if (exports && typeof exports === "object") {
      for (const v of Object.values(exports as Record<string, unknown>)) {
        if (isCardDef(v) && !seen.has(v.id)) { seen.add(v.id); defs.push(v); }
      }
    }
    if (!defs.length) return { state: { state: "load-error", detail: "This file does not export a card definition", file: bundle.entry } };
    return { defs };
  }

  const styleOf = (b: CardBundle) => [...b.styles.map((s) => s.css), b.tailwind].filter(Boolean).join("\n");
  const setStyles = (entry: string, bundle?: CardBundle) => {
    if (opts.onStyles) opts.onStyles(entry, bundle ? [...bundle.styles.map(s => s.css), bundle.tailwind].filter(Boolean) : []);
    else opts.onStyle?.(entry, bundle ? styleOf(bundle) : "");
  };

  function publish(): void {
    opts.onCards?.(api.cards());
    opts.onResults?.(api.results());
  }

  async function apply(bundles: readonly CardBundle[]): Promise<LoadResult[]> {
    const want = new Map<string, CardBundle>();
    for (const b of bundles ?? []) if (b && typeof b.entry === "string" && Array.isArray(b.modules) && !want.has(b.entry)) want.set(b.entry, b);
    let changed = false;
    for (const entry of [...loaded.keys()]) {
      if (want.has(entry)) continue;
      loaded.delete(entry);
      setStyles(entry);
      changed = true;
    }
    for (const [entry, bundle] of [...want].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const cur = loaded.get(entry);
      if (cur && cur.bundle.generation === bundle.generation) continue;
      changed = true;
      const fail = (state: CardRunState) => {
        loaded.set(entry, { bundle, defs: [], result: { ok: false, entry, generation: bundle.generation, state } });
        setStyles(entry);
      };
      // Generation switch: previous generation is torn down first, and new generation re-executes the entire card
      loaded.delete(entry);
      if (bundle.runtime !== opts.runtime) { fail({ state: "load-error", detail: `Runtime version mismatch (page ${bundle.runtime}, this environment ${opts.runtime})`, file: entry }); continue; }
      const miss = await preload(bundle);
      if (miss) { fail({ state: "missing-module", detail: miss.missing, file: miss.file }); continue; }
      // Styles injected before execution: styles are already present when card is first mounted
      setStyles(entry, bundle);
      const out = evaluate(bundle);
      if ("state" in out) { fail(out.state); continue; }
      loaded.set(entry, { bundle, defs: out.defs, result: { ok: true, entry, generation: bundle.generation, cardIds: out.defs.map((d) => d.id) } });
    }
    if (changed) publish();
    return [...want.keys()].map((entry) => loaded.get(entry)!.result);
  }

  const api: CardLoader = {
    setBundles(bundles) {
      const next = chain.then(() => apply(bundles), () => apply(bundles));
      chain = next.catch(() => undefined);
      return next;
    },
    cards() {
      const out: CardDef<any>[] = [];
      const seen = new Set<string>();
      for (const entry of [...loaded.keys()].sort()) {
        for (const d of loaded.get(entry)!.defs) if (!seen.has(d.id)) { seen.add(d.id); out.push(d); }
      }
      return out;
    },
    results() {
      return new Map([...loaded].map(([entry, l]) => [entry, l.result]));
    },
    clear() {
      const had = loaded.size > 0;
      for (const entry of loaded.keys()) setStyles(entry);
      loaded.clear();
      if (had) publish();
    },
  };
  return api;
}

/**
 * Outcomes for each entry → runtime status of each card (card id → status). Successfully loaded
 * cards are `ready`; failed entries have no card id to speak of, so the caller distributes them
 * to cards using the statically resolved "entry → card id" table (`entryCards`).
 */
export function runStatesOf(results: ReadonlyMap<string, LoadResult>, entryCards: (entry: string) => readonly string[]): Map<string, CardRunState> {
  const out = new Map<string, CardRunState>();
  for (const [entry, r] of [...results].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (r.ok) { for (const id of r.cardIds) if (!out.has(id)) out.set(id, { state: "ready" }); continue; }
    for (const id of entryCards(entry)) if (!out.has(id)) out.set(id, r.state);
  }
  return out;
}
