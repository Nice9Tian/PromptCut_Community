/**
 * The "clip → `cardCostKey` / declared frame mode / review-table capabilities" section (K1 / K2).
 *
 * Two callers need **the same one**:
 *   - `probeRunner.ts` uses `identityKeys` to decide "whether this card has been measured";
 *   - `planDispatch.ts` feeds the same one to `planPipelines` (R4a report section 8 item 2 split it out of
 *     `planPipelines` precisely because it needs the card registry and the source version, neither of which is project data).
 * If each computed it separately, the record the probe writes and the key the dispatch table looks up would
 * drift apart on things like "how the source version is computed".
 *
 * Memoized on the **object reference** of `project`: the store is updated immutably, so an unchanged reference
 * means nothing changed,
 * and `cardSourceVersion` has to go through every card's source; without caching, each project change would
 * waste one computation.
 */
import type { Project } from "../kernel/project";
import { projectCardGraph } from "../kernel/cardGraph.mjs";
import { flatPlanProject, withFlatNodes } from "../kernel/cutFlatten.mjs";
import { allCards, cardRunState, cardRunStatesGen, cardsRegistryGen, getCard, syncedCardView, syncedUserCardsGen, unknownCardClipIds, userCardSources } from "../kernel/registry";
import { localOnlyClipIds, onlineBrowserMode } from "../render/placeholderHost";
import { cardSourceVersion } from "../render/cardSourceVersion.mjs";
import { builtinCardSourceFiles, cardSourceFilesVersion } from "../render/cardSourceFiles.mjs";
import { clipCostIndex, clipCostNodes } from "../render/pipelinePlan.mjs";

export interface ClipIdentity {
  /** clipId → `cardCostKey(node, sourceVersion, fps, durationFrames)` */
  identityKeys: Record<string, string>;
  /** clipId → declared frame mode (`direct` / `stateful`). Used for fallback dispatch when there is no cost record */
  frameModes: Record<string, string>;
  /** clipId → this node's capability table (`canvasHeavy` / `compositing` / `frameMode`) */
  capabilities: Map<string, Record<string, unknown>>;
}

const EMPTY: ClipIdentity = { identityKeys: {}, frameModes: {}, capabilities: new Map() };

/*
 * The source version table itself is also memoized (C6.6 integration, T4): it depends only on the cards in the
 * registry, custom card source, and the card source table, and is independent of the project.
 * Previously every project change (moving a clip, editing a parameter) recomputed the whole table: every
 * built-in card had to scan all source files with a regex to find its entry,
 * about 40 ms each time, which together with other work became a > 50 ms long task. Recompute when any of the
 * three changes (registry reinstalled, custom card source replaced,
 * source table hot-updated).
 */
let versionsMemo: { reg: number; files: number; user: unknown; out: Record<string, string> } | null = null;

/** Source version, computed with the same algorithm as `__pcCardPlan` in `ExportView.tsx` (user cards carry dependencies) */
export function sourceVersionsOf(): Record<string, string> {
  const user = userCardSources();
  const reg = cardsRegistryGen();
  const files = cardSourceFilesVersion();
  if (versionsMemo && versionsMemo.reg === reg && versionsMemo.files === files && versionsMemo.user === user) return versionsMemo.out;
  const out: Record<string, string> = {};
  for (const card of allCards()) {
    const file = user.fileOf[card.id];
    out[card.id] = file && user.files[file] !== undefined
      ? `user:${cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, `/src/cards/user/${file}.tsx`)}`
      : `builtin:${cardSourceVersion(card, builtinCardSourceFiles)}`;
  }
  versionsMemo = { reg, files, user, out };
  return out;
}

let cachedProject: Project | null = null;
let cached: ClipIdentity = EMPTY;
/** The other two memoization keys: whether online browser mode is on, and the generation of the synced user card table (decides which clips cannot run on this machine) */
let cachedLocalKey = "";

/**
 * Clips this page cannot run in online browser mode (media effect cards, user cards that cannot run; C10
 * contract section 9, `placeholderHost.needsLocalPc`) get no identity:
 * user cards this page can run (those in the bundle at build time, and those synced and loaded successfully)
 * get an identity like built-in cards and are measured as such (`online-card-exec-contract.md` section 6): the page does not measure them (`probeRunner` picks cards by identity),
 * when the dispatch table finds neither a cost record nor a declared frame mode, it treats them all as heavy
 * cards (`declared-heavy` in `clipWeight`): even records measured earlier on the background stage in the old L2 are not honored;
 * the stage cannot get their identity, so it stops and does not catch up; their records are not transcribed into the document service.
 * Desktop (mode off) is unchanged.
 */
function dropLocalOnly(project: Project, id: ClipIdentity): ClipIdentity {
  return dropClips(id, localOnlyClipIds(project.tracks.flatMap((tr) => tr.clips)));
}

/**
 * Card clips defined on neither side (unknown cards, `registry.unknownCardClipIds`; same on desktop and
 * online) also get no identity: the stage does not draw them, and measurement should not pick them
 * (previously it would measure an empty card on the background stage and record a cost record). On the
 * dispatch table side, `planDispatch` removes them entirely (not treated as heavy cards, not put in the prerender set).
 */
function dropUnknown(project: Project, id: ClipIdentity): ClipIdentity {
  return dropClips(id, unknownCardClipIds(project.tracks.flatMap((tr) => tr.clips)));
}

function dropClips(id: ClipIdentity, local: ReadonlySet<string>): ClipIdentity {
  if (!local.size) return id;
  const identityKeys: Record<string, string> = {};
  const frameModes: Record<string, string> = {};
  const capabilities = new Map<string, Record<string, unknown>>();
  for (const [k, v] of Object.entries(id.identityKeys)) if (!local.has(k)) identityKeys[k] = v;
  for (const [k, v] of Object.entries(id.frameModes)) if (!local.has(k)) frameModes[k] = v;
  for (const [k, v] of id.capabilities) if (!local.has(k)) capabilities.set(k, v);
  return { identityKeys, frameModes, capabilities };
}

/**
 * The media effect card node of a sound-bearing motion card clip (its picture is a component and it
 * has a separate `audio()`) counts as a cost identity node (`clipCostNodes` in `pipelinePlan.mjs`):
 * its picture is just an ordinary DOM card, so like any other card it is measured the first time it
 * is needed, and classed light or heavy from the result. Before 2026-10-06 it had no identity (the
 * node synthesized by the media effect card branch carried no `clipId`), was never measured, and its
 * picture was always treated as a heavy card on both desktop and online.
 *
 * A media effect card whose picture comes from `card()`, and an audio media effect card with only
 * `audio()`, still do not count and have no identity: measurement uses a shrunk project that keeps
 * only this one clip (`shrinkProject` in `probeRunner.ts`, without media or card graph nodes), and
 * the input of a media effect card cannot be fetched there; an audio media effect card has no
 * picture.
 */
function ownsVisual(node: { cardId?: unknown }): boolean {
  const def = typeof node.cardId === "string" ? getCard(node.cardId) : undefined;
  return !!def && !!def.Component && typeof def.card !== "function";
}

/**
 * Flatten into a graph. When the card graph has dangling inputs, `projectCardGraph` throws (deleting
 * a clip does not clean up `cardNodes`). Previously the whole project had no identity for that round,
 * no card was measured, and all fell back to their declarations (any card without a declared `direct`
 * was treated as heavy). Now it steps back and flattens again using only the clips' own cards (no
 * card graph nodes, ignoring the clip's `nodeId`): the node content of ordinary cards and sound-bearing
 * motion cards is the same as in the full graph, so identities are still given and measured; a broken
 * media effect card chain never had an identity anyway. Only if this pass throws too is the project
 * treated as having no identity.
 */
function costGraph(project: Project, cardOf: (id: string) => ReturnType<typeof getCard> = getCard): ReturnType<typeof projectCardGraph> {
  try {
    return projectCardGraph(project, cardOf);
  } catch {
    const bare = { ...project, cardNodes: [], tracks: project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.nodeId ? { ...c, nodeId: undefined } : c)) })) };
    return projectCardGraph(bare as Project, cardOf);
  }
}

export function clipIdentityOf(raw: Project | null): ClipIdentity {
  if (!raw) return EMPTY;
  const project = raw;
  // The generation of the registry and the sync table also goes into the key: when a card definition arrives (hot update, synced), an unknown card becomes a known card, and its identity follows
  const localKey = `${onlineBrowserMode() ? "on" : "off"}:${syncedUserCardsGen()}:${cardsRegistryGen()}:${cardRunStatesGen()}`;
  if (project === cachedProject && localKey === cachedLocalKey) return cached;
  let out = EMPTY;
  try {
    // One broken card must not stall the probe and the dispatch table: when the graph cannot be flattened, step back and flatten using only the clips' own cards (`costGraph`); only if that fails too is it treated as "no identity"
    /*
     * A synced user card that can run on this page (`docs/plan/online-card-exec-contract.md`, sections 5
     * and 6): the editor page has no definition for it (it only executes inside the stage), so the node
     * of this card in the graph is synthesized from the statically parsed default parameters. The source
     * version uses this generation's short signature (carried in the run state: runtime version plus
     * the hash of the closure), with the prefix `user:online:`, which does not collide with the desktop's
     * `user:<closure source>`: the cost records of the two sides are kept separately.
     */
    const cardOf = (id: string) => getCard(id) ?? (cardRunState(id)?.state === "ready" && syncedCardView(id) ? ({ id, defaults: syncedCardView(id)!.defaults } as unknown as ReturnType<typeof getCard>) : undefined);
    /*
     * Replace a cut segment with the cards inside it (the flattened view of `kernel/cutFlatten.mjs`; user
     * decision, 2026-10-21): every card in a cut segment has its own identity, just like a card on the
     * parent timeline (the clip id is `<segment id>~<card's clip id>`), and is measured and dispatched
     * the same way. Same source as the card plan of the export page.
     */
    const flat = flatPlanProject(project);
    const graph = withFlatNodes(flat, costGraph(flat, cardOf));
    const versions = sourceVersionsOf();
    const versionOf = (cardId: string) => versions[cardId] ?? (cardRunState(cardId)?.state === "ready" && cardRunState(cardId)!.version ? `user:online:${cardRunState(cardId)!.version}` : null);
    const own = { ownNode: ownsVisual };
    const { identityKeys, frameModes } = clipCostIndex(flat, graph, (node) => versionOf((node as { cardId?: string }).cardId ?? ""), own);
    const capabilities = new Map<string, Record<string, unknown>>();
    for (const [clipId, node] of clipCostNodes(flat, graph, own)) capabilities.set(clipId, (node.capabilities ?? {}) as Record<string, unknown>);
    out = { identityKeys, frameModes, capabilities };
    if (onlineBrowserMode()) out = dropLocalOnly(flat, out);
    out = dropUnknown(flat, out);
  } catch {
    out = EMPTY;
  }
  cachedProject = project;
  cachedLocalKey = localKey;
  cached = out;
  return out;
}

/** For tests */
export function resetClipIdentityCache(): void {
  cachedProject = null;
  cachedLocalKey = "";
  cached = EMPTY;
  versionsMemo = null;
}
