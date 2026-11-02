import type { CardDef } from "../kernel/types";
import { onlinePage } from "../online/pageFlag.ts";
import { tr } from "../i18n/index.ts"; // With extension: this module's unit tests do not install the resolve hook and import it directly

/**
 * How much of the card library is exposed to the Agent: three tiers, and whether each tier can be turned off.
 *
 * # Why this exists
 *
 * `src/cards/user/` is **one global directory**, and `index.ts` scans the whole directory with `import.meta.glob`.
 * So a card the Agent built for project A used to show up in `list_cards` when opening project B.
 * The user's own words: "ThreeJS assets leaked to him from the previous project again". That card was made
 * for a particular client; leaking into someone else's video is both noise and a risk (the Agent really would use it).
 *
 * # Three tiers
 *
 *   Base media     The three built-in groups: built-in library (native), third-party ones brought over (magicui),
 *                  media wrapper cards (asset). Shipped with the package and always there, but each group can be
 *                  turned off, e.g. "this video only uses the built-in library".
 *   Custom media   The user cards marked "shared". Visible across projects, an opening left for things like
 *                  your own brand cards.
 *   Project media  The default tier for user cards: they appear only in **the project that built them**.
 *                  Custom cards are mostly made for one client, so sharing by default is the
 *                  counterintuitive choice.
 *
 * Tiers are recorded on the server in `src/cards/user/_scopes.json` (see server/vite-plugin-cards.ts),
 * because the registry receives imported CardDef objects and cannot read comments in the file.
 *
 * # What about old cards
 *
 * Cards built before this feature have no entry in the table. **Do not hide them**: quietly making four
 * existing cards vanish is harder to trace than a leak. They are handled as "custom (unassigned)", marked in
 * the panel, and the user decides whether to keep or delete them;
 * and the "custom media" switch itself is the most direct stopgap: turn it off and immediately only built-in
 * cards plus this project's cards remain.
 */

export type CardScope = "project" | "custom";
export type BaseGroup = "native" | "magicui" | "asset";

export interface ScopeEntry {
  scope: CardScope;
  projectId?: string;
  createdAt?: string;
}

export interface CardVisibility {
  /** Master switch for base media. Off = only custom / this project's cards remain (rarely used, but kept) */
  base: boolean;
  /** Which groups of base media are exposed */
  groups: Record<BaseGroup, boolean>;
  /** Custom media (custom cards marked shared, visible across projects) */
  custom: boolean;
  /** Project media (custom cards that belong only to the current project). Turning it off means "only use ready-made cards this round" */
  project: boolean;
}

export const ALL_GROUPS: BaseGroup[] = ["native", "magicui", "asset"];

export const GROUP_LABEL: Record<BaseGroup, string> = {
  native: tr("Built-in library"),
  magicui: tr("Third-party components"),
  asset: tr("Lottie / particles"),
};

const DEFAULT: CardVisibility = {
  base: true,
  groups: { native: true, magicui: true, asset: true },
  custom: true,
  project: true,
};

const LS_KEY = "pc.cardVisibility.v1";

export function readVisibility(): CardVisibility {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT;
    const p = JSON.parse(raw);
    return {
      base: p.base !== false,
      groups: { ...DEFAULT.groups, ...(p.groups || {}) },
      custom: p.custom !== false,
      project: p.project !== false,
    };
  } catch {
    return DEFAULT;
  }
}

export function writeVisibility(v: CardVisibility): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch { /* If it cannot be saved, just do not remember it this time; it should not raise an error */ }
}

/** The server-side ownership table. It changes rarely, so it is read in and cached; invalidated after a card is built or a tier is changed */
let scopeCache: Record<string, ScopeEntry> | null = null;

/** Compile-time constant of the online build (usage and intent in "online build pruning" of `src/online/pageFlag.ts`): /api/cards/scopes is pruned in the online build */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export async function loadScopes(force = false): Promise<Record<string, ScopeEntry>> {
  if (scopeCache && !force) return scopeCache;
  // Online browser mode has no editor process, so there is no ownership table for custom cards (user cards are not rendered on online pages in phase one, contract section 1)
  if (ONLINE_BUILD || onlinePage()) return (scopeCache = {});
  try {
    const r = await fetch("/api/cards/scopes").then((x) => x.json());
    scopeCache = r?.ok ? (r.scopes ?? {}) : {};
  } catch {
    scopeCache = {};
  }
  return scopeCache ?? {};
}

export function invalidateScopes(): void {
  scopeCache = null;
}

/**
 * Change the tier of a card (the right-click menu item).
 *
 * projectId is passed in by the caller and not looked up here: this module holds only **rules** and does not
 * depend on the editor's io layer.
 * That dependency used to exist, and as a result this pure logic could not be unit-tested (node cannot resolve
 * vite-style imports without extensions),
 * yet isCardVisible is the single fix point for the whole "custom card leaks across projects" problem, and it
 * is the one that most needs tests.
 */
export async function setCardScope(cardId: string, scope: CardScope, projectId?: string | null): Promise<void> {
  if (ONLINE_BUILD || onlinePage()) return;
  await fetch("/api/cards/scopes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId, scope, projectId: projectId ?? undefined }),
  });
  invalidateScopes();
}

/** Returns the cache if the ownership table was already loaded, null if not. Saving is synchronous and cannot wait for a request */
export function peekScopes(): Record<string, ScopeEntry> | null {
  return scopeCache;
}

/**
 * All card ids used in the project: the cardId of the clips in all cuts (the active one in tracks, parked ones
 * in cuts[].tracks).
 *
 * "Used" is itself the hardest evidence of ownership: if the card sits on the timeline, it is this project's
 * media,
 * whatever draft id the ownership table recorded (that table used to record by draft id, which stops matching
 * when opened a different way).
 */
export function usedCardIds(p: { tracks?: { clips?: { cardId?: string }[] }[]; cuts?: { tracks?: { clips?: { cardId?: string }[] }[] }[] }): Set<string> {
  const out = new Set<string>();
  const scan = (tracks: { clips?: { cardId?: string }[] }[] | undefined) => {
    for (const t of tracks ?? []) for (const c of t.clips ?? []) if (typeof c.cardId === "string" && c.cardId) out.add(c.cardId);
  };
  scan(p.tracks);
  for (const cut of p.cuts ?? []) scan(cut.tracks);
  return out;
}

/**
 * Which files in the same directory (`./other` / `./other.tsx`) a user card's source imports.
 * When packing into .proc, bring those dependencies along, otherwise the card will not compile on another machine.
 */
export function localCardImports(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\bfrom\s+["']\.\/([A-Za-z0-9_-]+)(?:\.tsx)?["']/g)) out.add(m[1]);
  for (const m of source.matchAll(/\bimport\s+["']\.\/([A-Za-z0-9_-]+)(?:\.tsx)?["']/g)) out.add(m[1]);
  return [...out];
}

/**
 * Whether this card should appear in list_cards right now.
 *
 * The criterion has two halves: for built-in cards, whether "the group is on"; for user cards, "tier + whether
 * this project built it".
 * When the ownership table is unavailable (not finished loading, request failed), **always let it through**:
 * better to give a few extra cards
 * than to have the Agent suddenly see no card at all because of one network blip.
 *
 * `used` is the set of cards used on the current project's timeline (usedCardIds). If used, it counts as this
 * project's media,
 * regardless of the project id in the ownership table; otherwise, when opening a .proc from the desktop, the
 * card the video is actually using could not be found in the card library.
 */
export function isCardVisible(
  card: CardDef<any>,
  v: CardVisibility,
  scopes: Record<string, ScopeEntry>,
  projectId: string | null,
  used?: ReadonlySet<string>,
): boolean {
  if (card.source !== "user") {
    if (!v.base) return false;
    const g = card.source as BaseGroup;
    return v.groups[g] !== false;
  }
  if (v.project && used?.has(card.id)) return true;
  const entry = scopes[card.id];
  // No entry = an old card built before this feature; handle it as "custom (unassigned)", do not hide it.
  // Quietly making a few existing cards vanish is harder to trace than a leak. To clean up, change the tier or delete manually in the card library.
  if (!entry) return v.custom;
  if (entry.scope === "custom") return v.custom;
  // Project media: appears only in the project that built it. If no project id was recorded (old data), treat it as this project's, do not hide it
  if (!v.project) return false;
  if (!entry.projectId) return true;
  return entry.projectId === projectId;
}

/** The line to show on the panel: who this user card belongs to and which tier it is */
export function describeUserCard(
  card: CardDef<any>,
  scopes: Record<string, ScopeEntry>,
  projectId: string | null,
  used?: ReadonlySet<string>,
): { scope: CardScope | "unknown"; mine: boolean } {
  const e = scopes[card.id];
  if (!e) return { scope: "unknown", mine: !!used?.has(card.id) };
  return { scope: e.scope, mine: !e.projectId || e.projectId === projectId || !!used?.has(card.id) };
}
