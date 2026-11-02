import { cardSourceVersion } from "../../render/cardSourceVersion.mjs";
import { cyrb53 } from "../../render/cyrb53.mjs";
/**
 * The online page reads card sources from the content store and recognizes user cards that are "known but
 * cannot run on this machine" (C10 contract section 9, "Recognition", user semantics change 2026-09-29).
 *
 * The online bundle's card table is generated at build time from `src/cards/user`; cards in the desktop
 * app's card library and cards synced through the content store are not in the table, and the online build
 * also turns off the page-side card sync (`cardSync.ts`). So here, through the document service connection
 * the page already has (the same `docRequest` the online source uses, not going through `/api`):
 *
 *   `content.list({ kind: 'card-source', prefix: 'src/cards/user/' })` → entry files
 *   (`src/cards/user/<name>.tsx`) whose hash changed, each fetched with `content.get` → the body is the
 *   source string (`server/card-sync.mjs`) → `parseCardSource` extracts the card's id, name, description,
 *   parameter defaults and controls (literals only) → `registry.setSyncedUserCards` (the source is not
 *   executed and does not enter the main registry; the parameters panel sees defaults and controls through
 *   `registry.syncedCardView`).
 *
 * **Follow imports** (C10 contract section 9 [ruling 2026-09-30]): files in the same directory that an
 * entry file reaches through relative imports (`.ts` / `.tsx` under `src/cards/user/`, which the desktop
 * app syncs into the content store together as the card's import closure) are also in the list, so their
 * bodies are fetched by hash in the same way, and then their own imports are followed further down (no
 * refetch on cycles); when parsing an entry, these bodies are handed to `parseCardSource` (`files`), so
 * controls and defaults brought in by imports are still recognized. Imports of built-in modules that the
 * page carries itself are resolved by the `builtins` given by the caller (`src/cards/builtinSourceExports.ts`).
 * Files not in the list cannot be fetched, and the panel explains which one.
 *
 * To follow changes, the approach chosen is **periodic refetch** (list every `CARD_SOURCE_POLL_MS`, and do
 * not refetch bodies whose hash did not change), not subscribing to `content.watch`: the content store's
 * subscriptions recognize only the last `watch` set per connection, so they would knock out other
 * subscribers on the same connection; there is also no need to resubscribe on session resumption or
 * reconnect.
 * When the connection changes (reconnect, switching project, leaving the shared project), clear the table
 * and refetch. When fetching fails (not connected, rejected, timeout), the table in hand is left untouched
 * and retried in the next round.
 */
import { cardSourceImports, importSpecifiers, isUserCardEntryKey, parseCardSource, type ParsedCardSource } from "../../kernel/cardSourceParse.mjs";
import type { BundleResult } from "../../online/cardRuntime/protocol.ts";
import { setSyncedUserCards, type SyncedUserCard } from "../../kernel/registry";
import { tr } from "../../i18n/index.ts";

/** How often to re-list the content store's card sources */
export const CARD_SOURCE_POLL_MS = 5_000;
/** Key prefix of user card sources in the content store */
export const CARD_SOURCE_PREFIX = "src/cards/user/";
export const CARD_SOURCE_KIND = "card-source";
/** Maximum number of non-entry files to fetch by following imports (keeps bad data from bogging the page down) */
export const CARD_SOURCE_MAX_DEPS = 200;

/** Keys in the list that can be fetched as imported files: `.ts` / `.tsx` / `.mjs` / `.js` under the user card directory (subdirectories included) */
export function isCardSourceModuleKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith(CARD_SOURCE_PREFIX) && /\.(tsx?|mjs|js)$/.test(key) && !key.split("/").some((p) => p === "" || p === "." || p === "..");
}

/** Keys in the list that can be fetched as styles: `.css` under the user card directory (imported by a card via `import "./x.css"`; fetched only when transpiling is needed) */
export function isCardSourceStyleKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith(CARD_SOURCE_PREFIX) && key.endsWith(".css") && !key.split("/").some((p) => p === "" || p === "." || p === "..");
}

/** Keys of the style files a source imports by relative path (`./x.css`, `../y.css`; those climbing out of the user card directory do not count) */
export function cardSourceStyleImports(source: string, key: string): string[] {
  const out = new Set<string>();
  for (const spec of importSpecifiers(source)) {
    if (typeof spec !== "string" || !spec.endsWith(".css") || !(spec.startsWith("./") || spec.startsWith("../"))) continue;
    const parts = key.split("/").slice(0, -1);
    let ok = true;
    for (const p of spec.split("/")) {
      if (p === "" || p === ".") continue;
      if (p === "..") { if (!parts.length) { ok = false; break; } parts.pop(); continue; }
      parts.push(p);
    }
    const k = parts.join("/");
    if (ok && isCardSourceStyleKey(k)) out.add(k);
  }
  return [...out];
}

/**
 * Transpile a synced card into a bundle the stage can execute (`docs/plan/online-card-exec-contract.md`
 * section 1). Injected by the browser entry (the transpiler is loaded on demand, see
 * `src/online/cardRuntime/transpile.browser.ts`); if omitted, only static parsing is done, as before.
 */
export interface CardBundling {
  /** Whether this page can execute synced cards right now (`src/online/cardRuntime/gate.ts`); if not, do not transpile and clear existing bundles */
  enabled: () => boolean;
  /** One card per entry: the bundle, or the run state of this card */
  run: (job: { entries: readonly string[]; read: (key: string) => { body: string; hash: string } | null }) => Promise<BundleResult[]>;
  /** The result changed (as a whole; an empty array when execution is not possible) */
  onBundles: (results: BundleResult[]) => void;
}

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

export interface OnlineCardSourcesDeps {
  /** The browser entry injects the raw built-in source table, so the pure sync / Node side does not depend on Vite macros. */
  sourceFiles?: Record<string, string>;
  request: Request;
  /** The current connection (the shared project's link object; if it changes, clear the table and refetch; null = not connected to a shared project) */
  linkKey: () => unknown;
  /** The table changed (after writing into the registry) */
  onChange?: (entries: SyncedUserCard[]) => void;
  /** Where to write; defaults to the registry */
  apply?: (entries: SyncedUserCard[]) => boolean;
  /**
   * The first round of each connection has a result (called once per connection): `ok` true means listing and
   * fetching finished and the table was written (it still counts if a few entries could not be fetched this
   * round), false means the list could not be fetched (not connected, rejected, timeout, malformed reply).
   * `link` is the connection used in that round. The online page's measurement waits for it to open the gate
   * (`measureGate.ts`); it is called again when the connection changes (switching project, reconnect); rounds
   * before the shared project is connected do not count.
   */
  onFirstSettled?: (ok: boolean, link: unknown) => void;
  requestTimeoutMs?: number;
  now?: () => number;
  /** Exports of the built-in modules the page carries itself (the `builtins` of `parseCardSource`); by default built-in modules are not recognized */
  builtins?: (key: string) => Readonly<Record<string, unknown>> | null | undefined;
  /** Transpile into a bundle the stage can execute; if omitted, no transpiling */
  bundling?: CardBundling;
}

type ParsedCard = Pick<ParsedCardSource, "id" | "name"> & Partial<Omit<ParsedCardSource, "id" | "name">> & { audioSourceVersion?: string };

/**
 * A list + the bodies fetched so far → entries for synced user cards (by key, in source order; for the same
 * id, the first one wins).
 * Description, defaults and controls are carried over as they are (for the parameters panel); those that
 * are absent are not written.
 */
export function entriesOf(keys: readonly string[], parsed: ReadonlyMap<string, ParsedCard[]>): SyncedUserCard[] {
  const out: SyncedUserCard[] = [];
  const seen = new Set<string>();
  for (const key of [...keys].sort()) {
    for (const c of parsed.get(key) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({
        id: c.id, name: c.name, source: key,
        ...(c.embeddedAudio ? { embeddedAudio: true } : {}),
        ...(c.audioSourceVersion ? { audioSourceVersion: c.audioSourceVersion } : {}),
        ...(c.description !== undefined ? { description: c.description } : {}),
        ...(c.defaults !== undefined ? { defaults: c.defaults } : {}),
        ...(c.controls !== undefined ? { controls: c.controls } : {}),
        ...(c.controlsIncomplete ? { controlsIncomplete: true } : {}),
        ...(c.skippedControls?.length ? { skippedControls: c.skippedControls } : {}),
      });
    }
  }
  return out;
}

/** The instance currently running (only one per page); `nodeCardInfoLive.ts` reads synced sources through it to compute the code identity (chunk N) */
let activeSources: OnlineCardSources | null = null;
/** Read-only entry to the synced sources: the key table of entry files and "key → body and hash"; returns null if none is running */
export function activeCardSourceReader(): { entries: () => string[]; read: (key: string) => { body: string; hash: string } | null } | null {
  return activeSources ? activeSources.reader() : null;
}

export class OnlineCardSources {
  private readonly deps: OnlineCardSourcesDeps;
  private link: unknown = null;
  /** Key → this body and its hash (entry files and files fetched by following imports) */
  private readonly cache = new Map<string, { hash: string; body: string }>();
  /** Entry key → parse result; when any body changes, reparse the whole set */
  private parsed = new Map<string, ParsedCard[]>();
  private busy: Promise<void> | null = null;
  private entries: SyncedUserCard[] = [];
  private stopped = false;
  private settled = false;
  /** The last transpile result and the input signature it corresponds to (hashes of the entries and the closure); no retranspile if the signature is unchanged */
  private bundles: BundleResult[] = [];
  private bundledSig: string | null = null;
  readonly stats = { lists: 0, gets: 0, errors: 0, lastSyncAt: 0, lastError: "" as string, truncated: false, bundleRuns: 0, bundleErrors: 0 };

  constructor(deps: OnlineCardSourcesDeps) {
    this.deps = deps;
    activeSources = this;
  }

  /** Read-only entry (see `activeCardSourceReader`) */
  reader(): { entries: () => string[]; read: (key: string) => { body: string; hash: string } | null } {
    return {
      entries: () => this.entries.map((e) => e.source).filter((k): k is string => typeof k === "string" && !!k),
      read: (key) => this.cache.get(key) ?? null,
    };
  }

  private apply(entries: SyncedUserCard[]): void {
    this.entries = entries;
    const changed = (this.deps.apply ?? setSyncedUserCards)(entries);
    if (changed) this.deps.onChange?.(entries);
  }

  private settle(ok: boolean, link: unknown): void {
    if (this.settled || this.stopped) return;
    this.settled = true;
    try { this.deps.onFirstSettled?.(ok, link); } catch { /* A broken subscriber does not affect sync */ }
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ms = this.deps.requestTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.deps.request(msg, ms),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(tr("Content store request timed out"))), ms); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  }

  /** Run one round; if one is already running, wait for that round */
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.syncOnce().finally(() => { this.busy = null; });
    return this.busy;
  }

  private async syncOnce(): Promise<void> {
    const link = this.deps.linkKey();
    if (link !== this.link) {
      // Connection changed: when switching projects, cards of the other project must not be kept
      this.link = link;
      this.cache.clear();
      this.parsed = new Map();
      this.apply([]);
      this.setBundles([], null);
      // The first round of the new connection counts as "the first time" again
      this.settled = false;
    }
    if (!link) return;
    let listing: Record<string, unknown>;
    try {
      listing = await this.request({ type: "content.list", kind: CARD_SOURCE_KIND, prefix: CARD_SOURCE_PREFIX });
      this.stats.lists++;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = String((err as Error)?.message ?? err).slice(0, 160);
      this.settle(false, link);
      return;
    }
    if (this.stopped || this.deps.linkKey() !== link) return;
    if (listing?.type !== "content.listing" || !Array.isArray(listing.items)) {
      this.stats.errors++;
      this.stats.lastError = tr("Bad response: {0}", String(listing?.type ?? "")).slice(0, 160);
      this.settle(false, link);
      return;
    }
    this.stats.truncated = listing.truncated === true;
    const listed = new Map<string, string>();
    const styles = new Map<string, string>();
    for (const it of listing.items as { key?: unknown; hash?: unknown }[]) {
      if (isCardSourceModuleKey(it?.key)) listed.set(it.key, typeof it.hash === "string" ? it.hash : "");
      else if (isCardSourceStyleKey(it?.key)) styles.set(it.key, typeof it.hash === "string" ? it.hash : "");
    }
    // Style files are fetched only when transpiling is needed (pages that do not transpile stay identical to before)
    const wantStyles = !!this.deps.bundling?.enabled();
    if (wantStyles) for (const [k, h] of styles) listed.set(k, h);
    const entryKeys = [...listed.keys()].filter((k) => isUserCardEntryKey(k)).sort();
    let dirty = false;
    for (const k of [...this.cache.keys()]) if (!listed.has(k)) { this.cache.delete(k); dirty = true; }
    // The entry file, then follow imports to fetch the referenced files in the same directory (only those in the list; no refetch if the hash is unchanged; no refetch on cycles)
    const queue = [...entryKeys];
    const visited = new Set<string>();
    let deps = 0;
    while (queue.length) {
      const key = queue.shift()!;
      if (visited.has(key)) continue;
      visited.add(key);
      if (!isUserCardEntryKey(key) && ++deps > CARD_SOURCE_MAX_DEPS) break;
      const hash = listed.get(key) ?? "";
      const hit = this.cache.get(key);
      if (!(hit && hash && hit.hash === hash)) {
        try {
          const got = await this.request({ type: "content.get", kind: CARD_SOURCE_KIND, key });
          this.stats.gets++;
          if (this.stopped || this.deps.linkKey() !== link) return;
          if (got?.type !== "content.item" || got.missing) { if (this.cache.delete(key)) dirty = true; continue; }
          const body = typeof got.body === "string" ? got.body : "";
          this.cache.set(key, { hash: typeof got.hash === "string" ? got.hash : hash, body });
          dirty = true;
        } catch (err) {
          // This entry could not be fetched this round: keep the old body (if any) and fetch again next round
          this.stats.errors++;
          this.stats.lastError = String((err as Error)?.message ?? err).slice(0, 160);
        }
      }
      const cur = this.cache.get(key);
      if (!cur) continue;
      if (key.endsWith(".css")) continue;
      for (const dep of cardSourceImports(cur.body, key)) if (listed.has(dep) && !visited.has(dep)) queue.push(dep);
      if (wantStyles) for (const dep of cardSourceStyleImports(cur.body, key)) if (listed.has(dep) && !visited.has(dep)) queue.push(dep);
    }
    // Files that are no longer referenced are not kept
    for (const k of [...this.cache.keys()]) if (!visited.has(k)) { this.cache.delete(k); dirty = true; }
    if (dirty || [...this.parsed.keys()].some((k) => !this.cache.has(k))) {
      const files = (k: string) => this.cache.get(k)?.body ?? null;
      const next = new Map<string, ParsedCard[]>();
      for (const k of entryKeys) {
        const cur = this.cache.get(k);
        if (!cur) continue;
        const sourceFiles = { ...this.deps.sourceFiles, ...Object.fromEntries([...this.cache].map(([key, value]) => [`/${key}`, value.body])) };
        next.set(k, parseCardSource(cur.body, { key: k, files, builtins: this.deps.builtins }).map(card => ({ ...card,
          audioSourceVersion: cyrb53(`user:${cardSourceVersion(card, sourceFiles, `/${k}`)}`) })));
      }
      this.parsed = next;
    }
    this.apply(entriesOf([...this.parsed.keys()], this.parsed));
    await this.bundle(entryKeys.filter((k) => this.cache.has(k)), link);
    if (this.stopped || this.deps.linkKey() !== link) return;
    this.stats.lastSyncAt = (this.deps.now ?? Date.now)();
    this.settle(true, link);
  }

  private setBundles(results: BundleResult[], sig: string | null): void {
    const had = this.bundles.length > 0;
    this.bundles = results;
    this.bundledSig = sig;
    if (!had && !results.length) return;
    try { this.deps.bundling?.onBundles(results); } catch { /* A broken subscriber does not affect sync */ }
  }

  /**
   * Entry point for transpiling this round (when this page can execute). If the input is unchanged (hashes of
   * the entries and of the fetched files are all unchanged), do not retranspile;
   * if execution is no longer possible, clear the existing bundles. If the transpiler fails to load or throws:
   * no bundle this round, try again next round.
   */
  private async bundle(entries: string[], link: unknown): Promise<void> {
    const b = this.deps.bundling;
    if (!b) return;
    if (!b.enabled()) { if (this.bundledSig !== null) this.setBundles([], null); return; }
    const sig = JSON.stringify([entries, [...this.cache].map(([k, v]) => [k, v.hash]).sort()]);
    if (sig === this.bundledSig) return;
    if (!entries.length) { this.setBundles([], sig); return; }
    try {
      const results = await b.run({ entries, read: (key) => this.cache.get(key) ?? null });
      if (this.stopped || this.deps.linkKey() !== link) return;
      this.stats.bundleRuns++;
      this.setBundles(results, sig);
    } catch (err) {
      this.stats.bundleErrors++;
      this.stats.lastError = String((err as Error)?.message ?? err).slice(0, 160);
    }
  }

  /** The cards recognized at this moment (for diagnostics and probes) */
  debug() {
    return {
      link: !!this.link,
      settled: this.settled,
      keys: [...this.parsed.keys()].sort(),
      deps: [...this.cache.keys()].filter((k) => !isUserCardEntryKey(k)).sort(),
      cards: this.entries.map((e) => ({ ...e })),
      bundles: this.bundles.map((r) => (r.ok
        ? { entry: r.entry, ok: true, generation: r.bundle.generation, modules: r.bundle.modules.map((m) => m.key), styles: r.bundle.styles.map((x) => x.key), tailwindBytes: r.bundle.tailwind.length }
        : { entry: r.entry, ok: false, state: r.state })),
      ...this.stats,
    };
  }

  /** Stop and clear the table (when leaving the online page or rebuilding on a tier change) */
  stop(): void {
    this.stopped = true;
    if (activeSources === this) activeSources = null;
    this.setBundles([], null);
    this.cache.clear();
    this.parsed = new Map();
    this.link = null;
    this.apply([]);
  }
}
