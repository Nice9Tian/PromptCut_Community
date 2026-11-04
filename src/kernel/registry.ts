import type { CardDef, Control } from "./types";
import { cardCapabilities } from "./frameMode.mjs";

const map = new Map<string, CardDef<any>>();
/**
 * Incremented every time the registry changes (register, clear): whoever memoizes on "which cards
 * are in the registry" (the source version table) uses it as the key
 */
let registryGen = 0;
export function cardsRegistryGen(): number {
  return registryGen;
}

/**
 * Register cards. An id collision within a single call is a genuine mistake (two cards fighting over
 * one id), so it throws directly; the same id across calls is treated as an overwrite, because
 * cards/index.ts gets re-executed by HMR (creating/modifying a card under src/cards/user/ triggers
 * it), while this map lives in another module and is not reset along with it.
 * It used to throw every time, so right after a card was created the hot update would crash the whole
 * app with "duplicate card id", and only a manual refresh could recover it.
 */
export function registerCards(defs: CardDef<any>[]) {
  registryGen++;
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.id)) throw new Error(`Duplicate card id: ${d.id}`);
    seen.add(d.id);
    const capabilities = cardCapabilities(d);
    // The authority for compositing / canvasHeavy is the review table (src/cards/capabilities.json),
    // not the card source, so registration stamps them all with the review conclusion: whoever calls
    // getCard(id) afterwards reads the same answer.
    map.set(d.id, { ...d, need_prerendering: capabilities.need_prerendering, compositing: capabilities.compositing,
      canvasHeavy: capabilities.canvasHeavy,
      ...(!Object.hasOwn(d, 'need_prerendering') ? { _derivedPrerendering: true } : {}) });
  }
}

/*
 * Notification that the card code has changed (C6.6 integration 3b). `cards/index.ts` is the
 * hot-update boundary (it catches hot updates itself and reinstalls the whole set of cards), so hot
 * updates no longer bubble up to Editor, Preview and StageView, which would make their effects re-run
 * in Fast Refresh and wipe the stage's RPC client. So the parties that need to see the new cards (the
 * stage re-render, the editor's card list, the probe re-measurement) subscribe here.
 * This module is not on the hot-update chain (it does not re-run when a card changes), so the
 * subscriptions stay valid.
 */
let cardsGen = 0;
let cardsStampValue = 0;
const cardListeners = new Set<() => void>();

/**
 * Called after `cards/index.ts` has reinstalled the whole set of cards on a hot update. `stamp` is the
 * timestamp of this batch of hot updates (vite pushes the same one to every page); the editor page
 * uses it to check that both stages have also switched to this version (`editor/stageCards.ts`).
 */
export function noteCardsUpdated(stamp: number = Date.now()): void {
  cardsGen++;
  cardsStampValue = Math.max(cardsStampValue, stamp);
  for (const l of [...cardListeners]) {
    try { l(); } catch (err) { console.warn("[registry] Card update subscriber failed", err); }
  }
}

/** Timestamp of the latest card hot update; 0 if it never changed */
export function cardsStamp(): number {
  return cardsStampValue;
}

/** How many times the card code has changed (in this page session); the first load is 0 */
export function cardsVersion(): number {
  return cardsGen;
}

export function onCardsUpdated(cb: () => void): () => void {
  cardListeners.add(cb);
  return () => { cardListeners.delete(cb); };
}

/**
 * Clear before reloading the whole set of cards, so that deleted card files do not linger in the
 * library after a hot update
 */
export function resetCards() {
  registryGen++;
  map.clear();
}

/**
 * Remove a few cards. Used only by the Cloud Agent service: it temporarily registers a project's user
 * card definitions (statically parsed, the source is not executed) and removes them when done, so
 * they are not left to the next project (`registerProjectCards` in `server/agent/ssr-host.mjs`).
 * Pages do not call it.
 */
export function unregisterCards(ids: readonly string[]) {
  let changed = false;
  for (const id of ids) changed = map.delete(id) || changed;
  if (changed) registryGen++;
}

export function getCard(id: string): CardDef<any> | undefined {
  return map.get(id) ?? runtimeCards.get(id);
}

export function allCards(): CardDef<any>[] {
  return [...map.values()];
}

/**
 * The original source text of custom cards (src/cards/user/): file name → source, and card id → file
 * name.
 * When saving a .proc, the custom cards the project uses must be packed along with it
 * (editor/io/procCards.ts).
 *
 * It is injected by cards/index.ts every time (including HMR re-runs), rather than letting procCards
 * import cards/user directly: that would add a dependency chain cards/user → procCards → proc →
 * drafts → headless, with no module on the chain that can catch hot updates, so every time the Agent
 * creates / modifies a card the editor would reload the whole page.
 */
let userSources: { files: Record<string, string>; fileOf: Record<string, string>; dependencies: Record<string, string> } = { files: {}, fileOf: {}, dependencies: {} };

export function setUserCardSources(files: Record<string, string>, fileOf: Record<string, string>, dependencies: Record<string, string> = {}) {
  userSources = { files, fileOf, dependencies };
}

export function userCardSources(): { files: Record<string, string>; fileOf: Record<string, string>; dependencies: Record<string, string> } {
  return userSources;
}

/*
 * User cards that are "known but cannot run on this machine" (C10 contract section 9, "Recognition";
 * semantics changed by user decision, 2026-09-29).
 *
 * The online bundle's card table is generated at build time from `src/cards/user`; cards in the
 * desktop app's card library and cards synced through the content store are not in the table. The
 * online page reads the card sources of this project's content store through its own document service
 * connection (`kind: 'card-source'`), parses each card's id and name out of the source and records
 * them in this table (the stage is a separate document, to which the parent page sends a copy via
 * RPC). This table is **not part of the main registry**: users of `allCards()` (the card library
 * panel, tools, the source version table) cannot see them, and `getCard(id)` returns undefined for
 * them, since this machine does not have their code.
 *
 * Entries whose card id collides with a build-time card are ignored at query time (built-in wins, same
 * as the `taken` rule in `cards/index.ts`; build-time user cards count as user cards anyway).
 * The desktop runtime does not set this table, and it is always empty.
 */
export interface SyncedUserCard {
  embeddedAudio?: boolean;
  audioSourceVersion?: string;
  id: string;
  name: string;
  /**
   * Source key (the key of that source in the content store, like `src/cards/user/x.tsx`); for
   * diagnostics
   */
  source?: string;
  /** Description in the source (only if it is a literal; fallback for the timeline subtitle) */
  description?: string;
  /**
   * Parameter defaults recognized in the source (`cardSourceParse`; keys it cannot recognize have
   * been dropped)
   */
  defaults?: Record<string, unknown>;
  /** Parameter controls recognized in the source (parsed one by one, unrecognized ones are skipped) */
  controls?: Control[];
  /**
   * Some control was not recognized (or the whole `controls` is not a literal): the parameters panel
   * uses this to explain "cannot be changed online"
   */
  controlsIncomplete?: boolean;
  /**
   * The skipped controls, one by one (the recognizable key / label / type, and the reason): the
   * parameters panel explains which one it is
   */
  skippedControls?: SkippedControl[];
}

/** One control in a synced card that was not recognized (`skippedControls` of `cardSourceParse`) */
export interface SkippedControl {
  key?: string;
  label?: string;
  type?: string;
  reason: string;
}

/**
 * Read-only view of a synced user card for the UI: shaped like `CardDef` (name, description,
 * defaults, controls) but **with no component**, so this machine cannot run it.
 * The parameters panel and the timeline subtitle look up `getCard` first, and use this when that
 * finds nothing (`syncedCardView`).
 */
export interface SyncedCardView {
  id: string;
  name: string;
  description?: string;
  defaults: Record<string, unknown>;
  controls: Control[];
  controlsIncomplete: boolean;
  /** The skipped controls, one by one (an empty list when there are none) */
  skippedControls: SkippedControl[];
  /** Always true: the reader knows from it that this is a synced view, not a definition that can run */
  synced: true;
}

let synced = new Map<string, SyncedUserCard>();
/**
 * The view of each synced entry, built together when the table is replaced: a card that did not
 * change returns the same object (the UI detects changes by reference)
 */
let views = new Map<string, SyncedCardView>();
let syncedGen = 0;
const syncedListeners = new Set<() => void>();

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Signature of an entry (to decide "content unchanged") */
function entrySig(e: SyncedUserCard): string {
  return JSON.stringify([e.name, e.source ?? null, e.description ?? null, e.defaults ?? null, e.controls ?? null, !!e.controlsIncomplete, e.skippedControls ?? null, e.embeddedAudio ?? null, e.audioSourceVersion ?? null]);
}

/**
 * Replace the synced user cards wholesale. When one id has several entries, the first is taken. If the
 * content did not change, returns false and does not notify; if it changed, `syncedUserCardsGen()` is
 * incremented and subscribers are notified.
 */
export function setSyncedUserCards(entries: Iterable<SyncedUserCard>): boolean {
  const next = new Map<string, SyncedUserCard>();
  for (const e of entries ?? []) {
    if (!e || typeof e.id !== "string" || !e.id || next.has(e.id)) continue;
    next.set(e.id, {
      id: e.id, name: typeof e.name === "string" ? e.name : "",
      ...(e.embeddedAudio === true ? { embeddedAudio: true } : {}),
      ...(typeof e.audioSourceVersion === "string" ? { audioSourceVersion: e.audioSourceVersion } : {}),
      ...(typeof e.source === "string" && e.source ? { source: e.source } : {}),
      ...(typeof e.description === "string" ? { description: e.description } : {}),
      ...(isRecord(e.defaults) ? { defaults: e.defaults } : {}),
      ...(Array.isArray(e.controls) ? { controls: e.controls.filter((c) => isRecord(c) && typeof c.key === "string" && typeof c.type === "string") } : {}),
      ...(e.controlsIncomplete ? { controlsIncomplete: true } : {}),
      ...(Array.isArray(e.skippedControls) && e.skippedControls.length
        ? { skippedControls: e.skippedControls.filter((c) => isRecord(c) && typeof c.reason === "string") } : {}),
    });
  }
  const same = next.size === synced.size && [...next].every(([id, e]) => {
    const cur = synced.get(id);
    return !!cur && entrySig(cur) === entrySig(e);
  });
  if (same) return false;
  const nextViews = new Map<string, SyncedCardView>();
  for (const [id, e] of next) {
    const prev = synced.get(id);
    const prevView = views.get(id);
    if (prev && prevView && entrySig(prev) === entrySig(e)) { nextViews.set(id, prevView); continue; }
    nextViews.set(id, Object.freeze({
      id, name: e.name, ...(e.description !== undefined ? { description: e.description } : {}),
      defaults: e.defaults ?? {}, controls: e.controls ?? [], controlsIncomplete: !!e.controlsIncomplete,
      skippedControls: e.skippedControls ?? [], synced: true as const,
    }));
  }
  synced = next;
  views = nextViews;
  syncedGen++;
  for (const l of [...syncedListeners]) {
    try { l(); } catch (err) { console.warn("[registry] Synced user card subscriber failed", err); }
  }
  return true;
}

/**
 * The synced user card table as of now (including colliding entries; use `isUserCardId` /
 * `knownCardName` to query)
 */
export function syncedUserCards(): ReadonlyMap<string, SyncedUserCard> {
  return synced;
}

/**
 * Incremented every time the synced table changes (whoever memoizes on "which cards are user cards"
 * uses it as the key)
 */
export function syncedUserCardsGen(): number {
  return syncedGen;
}

export function onSyncedUserCardsChanged(cb: () => void): () => void {
  syncedListeners.add(cb);
  return () => { syncedListeners.delete(cb); };
}

/**
 * Whether this synced entry takes effect: entries colliding with build-time cards (those in the
 * registry) are ignored
 */
function syncedEntry(id: string): SyncedUserCard | undefined {
  if (map.has(id)) return undefined;
  return synced.get(id);
}

/**
 * Whether this id is a user card: a build-time custom card registration (`userCardSources().fileOf`),
 * or a synced user card (colliding ones do not count).
 * Replaces the `hasOwnProperty(userCardSources().fileOf, id)` written inline in various places.
 */
export function isUserCardId(id: string | undefined | null): boolean {
  if (typeof id !== "string" || !id) return false;
  if (Object.prototype.hasOwnProperty.call(userSources.fileOf, id)) return true;
  return !!syncedEntry(id);
}

/**
 * Read-only view of a synced user card (see `SyncedCardView`). **Not part of the main registry**:
 * `getCard` and `allCards()` still cannot see them; ids that collide with build-time cards, or that
 * were not synced, return undefined.
 */
export function syncedCardView(id: string | undefined | null): SyncedCardView | undefined {
  if (typeof id !== "string" || !id || !syncedEntry(id)) return undefined;
  return views.get(id);
}

/**
 * Display name of this card: the name defined at build time → the name in the synced table → null
 * (unknown card)
 */
export function knownCardName(id: string | undefined | null): string | null {
  if (typeof id !== "string" || !id) return null;
  const def = map.get(id);
  if (def) return def.name;
  return syncedEntry(id)?.name ?? null;
}

/**
 * Whether this card is recognized: it has a definition in the build-time registry, or it is a user card
 * (registered at build time, or synced from the content store by the online page).
 * Cards found on neither side are "unknown cards": the stage does not draw them, and the timeline
 * labels them "Unknown card".
 */
export function isKnownCardId(id: string | undefined | null): boolean {
  if (typeof id !== "string" || !id) return false;
  return map.has(id) || isUserCardId(id);
}

/**
 * Card clips with no definition on either side (unknown cards; same on desktop and online). The stage
 * never draws them anyway, so measurement skips them (no identity is given), the dispatch table does
 * not treat them as heavy cards, they do not enter the prerender set, and the manifest plan the page
 * sends therefore does not contain them either.
 * Only clips that have `cardId` written are considered (media effect card clips with only `nodeId`,
 * and media clips, do not count).
 */
export function unknownCardClipIds(clips: Iterable<{ id: string; cardId?: string }>): Set<string> {
  const out = new Set<string>();
  for (const c of clips) if (c && typeof c.cardId === "string" && c.cardId && !isKnownCardId(c.cardId)) out.add(c.id);
  return out;
}

/* ------------------------------------------------------------------ *
 * Cards loaded at runtime (the online browser executes synced user cards and media effect cards,
 * `docs/plan/online-card-exec-contract.md` sections 2 and 8)
 * ------------------------------------------------------------------ */

/**
 * The runtime status of a synced card on this page (the ten kinds in contract section 8). Only `ready`
 * means "this page can run it"; all the others fall back to the original approach (count as a heavy
 * card, paste the prerender output, show an hourglass when missing, wait for a render node), and the
 * parameters panel explains the reason according to the status.
 */
export type CardRunStateName =
  | "ready" | "loading" | "unsupported-syntax" | "missing-module" | "load-error"
  | "gpu" | "media" | "runtime-error" | "not-isolated";

export interface CardRunState {
  state: CardRunStateName;
  /**
   * Details for the parameters panel: which syntax, which module, the first line of the error;
   * omitted when there are none
   */
  detail?: string;
  /** The file that has the problem (a content store key) */
  file?: string;
  /**
   * Short signature of this generation of source (the runtime version plus the hash of every file in the
   * closure); a card that can run uses it as the source version in its cost identity
   */
  version?: string;
}

export const CARD_RUN_STATES: readonly CardRunStateName[] = Object.freeze([
  "ready", "loading", "unsupported-syntax", "missing-module", "load-error", "gpu", "media", "runtime-error", "not-isolated",
]);

/**
 * Card definitions loaded at runtime. **Only present in the environments that execute them** (the
 * cross-origin stage, the sound thread started by the stage); the editor page is always empty.
 * `getCard` only looks here when it cannot find the card in the build-time registry (those whose id
 * collides with a build-time card do not take effect); `allCards()` does not include them.
 */
const runtimeCards = new Map<string, CardDef<any>>();
let runtimeGen = 0;
const runtimeListeners = new Set<() => void>();

const stamp = (d: CardDef<any>): CardDef<any> => {
  const capabilities = cardCapabilities(d);
  return { ...d, need_prerendering: capabilities.need_prerendering, compositing: capabilities.compositing, canvasHeavy: capabilities.canvasHeavy,
    ...(!Object.hasOwn(d, "need_prerendering") ? { _derivedPrerendering: true } : {}) } as CardDef<any>;
};

/**
 * Replace the runtime-loaded cards wholesale (called by the loader after every generation change).
 * Like `registerCards`, it stamps capabilities according to the review table; cards absent from the
 * review table get the defaults.
 * When one id has several entries, the first is taken. Returns true if the table changed, and
 * `cardsRegistryGen()` and `runtimeCardsGen()` are each incremented and subscribers notified.
 */
export function setRuntimeCards(defs: Iterable<CardDef<any>>): boolean {
  const next = new Map<string, CardDef<any>>();
  for (const d of defs ?? []) if (d && typeof d.id === "string" && d.id && !next.has(d.id)) next.set(d.id, d);
  const same = next.size === runtimeCards.size && [...next].every(([id, d]) => runtimeSource.get(id) === d);
  if (same) return false;
  runtimeCards.clear();
  runtimeSource.clear();
  for (const [id, d] of next) { runtimeSource.set(id, d); runtimeCards.set(id, stamp(d)); }
  registryGen++;
  runtimeGen++;
  for (const l of [...runtimeListeners]) {
    try { l(); } catch (err) { console.warn("[registry] Runtime card subscriber failed", err); }
  }
  return true;
}
/**
 * The original definition before capabilities were stamped on (used to decide "unchanged": the same
 * object means the same generation)
 */
const runtimeSource = new Map<string, CardDef<any>>();

/** Whether this card is runtime-loaded and in effect right now (not shadowed by a build-time card) */
export function isRuntimeCard(id: string | undefined | null): boolean {
  return typeof id === "string" && !!id && !map.has(id) && runtimeCards.has(id);
}

export function runtimeCardsGen(): number {
  return runtimeGen;
}

export function onRuntimeCardsChanged(cb: () => void): () => void {
  runtimeListeners.add(cb);
  return () => { runtimeListeners.delete(cb); };
}

let runStates = new Map<string, CardRunState>();
let runStatesGen = 0;
const runStateListeners = new Set<() => void>();

const validRunState = (v: unknown): v is CardRunState => isRecord(v) && typeof v.state === "string" && (CARD_RUN_STATES as readonly string[]).includes(v.state);

/**
 * Replace the runtime statuses of synced cards wholesale (card id → status). The stage reports the load
 * results to the editor page, and the editor page merges in what it knows itself (transpile failed,
 * this page has no isolated environment) and writes it here; the parameters panel, the timeline badge
 * and the light/heavy classification all read it.
 * Entries with the wrong shape are dropped (what the stage reports is treated as untrusted input).
 * Returns false and does not notify when the content is unchanged.
 */
export function setCardRunStates(states: Iterable<readonly [string, CardRunState]> | Record<string, CardRunState>): boolean {
  const next = new Map<string, CardRunState>();
  const entries = states && typeof (states as Iterable<unknown>)[Symbol.iterator] === "function"
    ? [...(states as Iterable<readonly [string, CardRunState]>)] : Object.entries((states ?? {}) as Record<string, CardRunState>);
  for (const [id, v] of entries) {
    if (typeof id !== "string" || !id || !validRunState(v)) continue;
    next.set(id, Object.freeze({
      state: v.state,
      ...(typeof v.detail === "string" && v.detail ? { detail: v.detail.slice(0, 300) } : {}),
      ...(typeof v.file === "string" && v.file ? { file: v.file.slice(0, 200) } : {}),
      ...(typeof v.version === "string" && v.version ? { version: v.version.slice(0, 64) } : {}),
    }));
  }
  const same = next.size === runStates.size && [...next].every(([id, v]) => {
    const cur = runStates.get(id);
    return !!cur && cur.state === v.state && cur.detail === v.detail && cur.file === v.file && cur.version === v.version;
  });
  if (same) return false;
  runStates = next;
  runStatesGen++;
  for (const l of [...runStateListeners]) {
    try { l(); } catch (err) { console.warn("[registry] Card run state subscriber failed", err); }
  }
  return true;
}

/**
 * Whether any synced card is still being transpiled or loaded right now (`loading`; the start gate of
 * measurement waits for them to get a result, `src/editor/measureGate.ts`)
 */
export function anyCardLoading(): boolean {
  for (const v of runStates.values()) if (v.state === "loading") return true;
  return false;
}

/**
 * Runtime status of this synced card on this page; returns undefined when there is no record (the
 * caller treats it as "cannot run")
 */
export function cardRunState(id: string | undefined | null): CardRunState | undefined {
  return typeof id === "string" && id ? runStates.get(id) : undefined;
}

/**
 * Whether this card can run on this page: always true for cards defined at build time (including
 * repository user cards that were already in the bundle at build time); for synced cards, in the
 * environments that execute them (stage, sound thread) it depends on whether loading succeeded, and
 * on the editor page on whether the runtime status is `ready`.
 */
export function cardRunnableHere(id: string | undefined | null): boolean {
  if (typeof id !== "string" || !id) return false;
  if (localExec.blocked.has(id)) return false;
  if (map.has(id) || runtimeCards.has(id)) return true;
  return runStates.get(id)?.state === "ready";
}

/**
 * The two conclusions of the document that executes cards (the cross-origin stage) itself
 * (`docs/plan/online-card-exec-contract.md` 4.3 and section 8):
 *   - `graph`: whether this document can run media effect cards (the picture half is allowed to
 *     execute, and the graphics capability is sufficient); by default it cannot;
 *   - `blocked`: cards loaded at runtime but that went wrong in this document (the media effect
 *     card's input cannot be resolved, or it throws while running): pull them down and fall back to
 *     the original approach.
 * Only the stage writes it; the editor page does not (there it looks at the runtime status the stage
 * reports back). When it changes, `cardsRegistryGen()` and `cardRunStatesGen()` are each incremented
 * and subscribers notified.
 */
let localExec: { graph: boolean; blocked: ReadonlySet<string> } = { graph: false, blocked: new Set() };
export function setLocalCardExec(next: { graph: boolean; blocked?: Iterable<string> }): boolean {
  const blocked = new Set<string>();
  for (const id of next.blocked ?? []) if (typeof id === "string" && id) blocked.add(id);
  const graph = next.graph === true;
  if (graph === localExec.graph && blocked.size === localExec.blocked.size && [...blocked].every((id) => localExec.blocked.has(id))) return false;
  localExec = { graph, blocked };
  registryGen++;
  runStatesGen++;
  for (const l of [...runStateListeners]) {
    try { l(); } catch (err) { console.warn("[registry] Card run state subscriber failed", err); }
  }
  return true;
}
/** Whether this document can run media effect cards (true only in the stage that executes cards) */
export function graphCardsRunnableHere(): boolean {
  return localExec.graph;
}

export function cardRunStatesGen(): number {
  return runStatesGen;
}

export function onCardRunStatesChanged(cb: () => void): () => void {
  runStateListeners.add(cb);
  return () => { runStateListeners.delete(cb); };
}

/** For unit tests: clear the runtime cards and runtime statuses */
export function resetRuntimeCardsForTest(): void {
  runtimeCards.clear();
  runtimeSource.clear();
  runStates = new Map();
  localExec = { graph: false, blocked: new Set() };
}
