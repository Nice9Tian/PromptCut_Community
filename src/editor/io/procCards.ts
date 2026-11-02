import type { Project } from "../../kernel/project";
import { allCards, userCardSources } from "../../kernel/registry";
import { invalidateScopes, localCardImports, peekScopes, usedCardIds } from "../cardScope";
import { tr } from "../../i18n/index.ts";

/**
 * Custom cards travel with the .proc.
 *
 * Cards the Agent writes with create_card land in src/cards/user/, which is **this machine's global
 * directory** and not in the project file. Previously the .proc stored only the cardId, so if a .proc
 * was copied away, moved to another machine, or this machine's card was overwritten by another project,
 * the map card and title card in the video were left with just a name that could not be found.
 *
 * Now: on save, the source of the custom cards the project uses (and those the ownership table records
 * under this project's name) is packed together into the cards section of the .proc;
 * on open, it is handed to the server to be reinstalled into src/cards/user/. Before installing, it goes
 * through the same review as create_card (a .proc may be sent by someone else, and the source inside
 * will run in the editor); when it differs from this machine's version, **the one stored in the project wins**,
 * and this machine's copy is first backed up to .pc-work/card-history/ and then overwritten:
 * opening a project should show it as it was saved.
 */

/** A file packed into the .proc. id = the file name under src/cards/user/ (without .tsx), usually the card id */
export interface BundledCard {
  id: string;
  source: string;
}

/** Which custom cards the current project should take along: those used on the timeline + those the ownership table records under this project's name, then complete the dependencies by following same-directory imports */
export function collectProjectCards(p: Project): BundledCard[] {
  const { files: userCardFiles, fileOf: userCardFileOf } = userCardSources();
  const queue: string[] = [];
  for (const cardId of usedCardIds(p)) {
    const file = userCardFileOf[cardId];
    if (file) queue.push(file);
  }
  // Cards that were created but not yet placed on the timeline also count as this project's. If the ownership table was never loaded, take only the used ones: saving cannot wait for a request
  const scopes = peekScopes();
  if (scopes && p.id) {
    for (const [cardId, e] of Object.entries(scopes)) {
      if (e.scope === "project" && e.projectId === p.id && userCardFileOf[cardId]) queue.push(userCardFileOf[cardId]);
    }
  }
  const out = new Map<string, string>();
  while (queue.length) {
    const file = queue.shift()!;
    if (out.has(file)) continue;
    const source = userCardFiles[file];
    if (typeof source !== "string") continue;
    out.set(file, source);
    for (const dep of localCardImports(source)) if (!out.has(dep)) queue.push(dep);
  }
  return [...out.keys()].sort().map((id) => ({ id, source: out.get(id)! }));
}

/** Extract the cards section from the .proc document. Entries with the wrong shape are dropped without throwing: one bad card should not make the whole project unopenable */
export function bundledCardsOf(doc: unknown): BundledCard[] {
  const list = (doc as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is BundledCard => !!c && typeof (c as BundledCard).id === "string" && typeof (c as BundledCard).source === "string",
  );
}

export interface CardRestoreResult {
  id: string;
  status: "written" | "updated" | "unchanged" | "rejected";
  error?: string;
  backup?: string;
}

/** Result of the most recent card install, for troubleshooting (visible in the console as window.__pcCardRestore) */
let lastRestore: CardRestoreResult[] = [];
export function lastCardRestore(): CardRestoreResult[] {
  return lastRestore;
}

/**
 * Reinstall the cards carried in the .proc onto this machine. Asynchronous, and does not block opening the project:
 * after install, vite hot-updates and the cards show up in the stage and the card library on their own.
 * projectId is used to stamp ownership on cards this machine did not have before.
 */
export async function restoreProjectCards(cards: BundledCard[], projectId: string | null): Promise<CardRestoreResult[]> {
  if (cards.length === 0) return [];
  try {
    const res = await fetch("/api/cards/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cards,
        projectId: projectId ?? undefined,
        // Report only the ids of built-in cards: a same-named user card is an "update", while a same-named built-in card is a collision
        existingIds: allCards().filter((c) => c.source !== "user").map((c) => c.id),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lastRestore = data.results as CardRestoreResult[];
  } catch (e) {
    lastRestore = cards.map((c) => ({ id: c.id, status: "rejected" as const, error: tr("Card install request failed: {0}", e instanceof Error ? e.message : String(e)) }));
  }
  invalidateScopes();
  for (const r of lastRestore) {
    if (r.status === "rejected") console.warn(`[proc] Card "${r.id}" bundled in the project was not installed: ${r.error}`);
    else if (r.status === "updated") console.info(`[proc] Card "${r.id}" was updated to the version stored in the project, the old local version is backed up at ${r.backup ?? "(not backed up)"}`);
  }
  (window as unknown as { __pcCardRestore?: CardRestoreResult[] }).__pcCardRestore = lastRestore;
  return lastRestore;
}

/** Take the cards from the .proc text and reinstall them. If it cannot be parsed, do nothing (parseProc would already have reported an error for such text) */
export function restoreCardsFromProcText(text: string, projectId: string | null): Promise<CardRestoreResult[]> {
  let doc: unknown = null;
  try {
    doc = JSON.parse(text);
  } catch {
    return Promise.resolve([]);
  }
  return restoreProjectCards(bundledCardsOf(doc), projectId);
}
