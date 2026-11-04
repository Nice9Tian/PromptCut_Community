import { tr } from "../../i18n/index.ts";
/**
 * Python cards in an old `.proc` are **not forward compatible** (user decision; this includes
 * filters, transitions and sound effects).
 *
 * The whole Python card runtime has been archived to `archive/python-cards/`; the repo no longer has
 * the HTTP endpoint of the isolated runtime, the browser-side host component, or `adapter: 'python'`
 * nodes. So when opening an old project that contains Python cards, they are dropped from the raw
 * JSON **before it is converted to a `Project`**:
 *
 * - The `cardDefinitions` **whole field** is deleted, not just the python entries. The
 *   `{ ...createEmptyProject(), ...project, id }` in `proc.ts` spreads whatever is in the raw JSON
 *   into the `Project` as is and saves it back as is into the next `.proc`; leaving it would be a
 *   dead field passed down forever;
 * - Nodes in `cardNodes` with `adapter: 'python'` are discarded outright;
 * - Clips that reference those nodes have `nodeId` cleared: a media clip goes back to a plain media
 *   clip (the native audio track naturally regains sound), while a pure python clip with only a
 *   `nodeId` and no `cardId` has neither node nor `cardId`, is skipped by
 *   `flattenOverlay` (`src/kernel/project.ts`), and is neither shown nor reported as an error.
 *
 * No placeholder cards, no `list_cards` hint, no automatic translation.
 */

/** Number of discarded **instances** (the number of python nodes deleted): these are what the user sees disappear. */
export function dropPythonNodes(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const project = raw as Record<string, any>;

  // Delete the whole field, not just the python entries
  delete project.cardDefinitions;

  const nodes: any[] = Array.isArray(project.cardNodes) ? project.cardNodes : [];
  const dropped = new Set<string>();
  for (const node of nodes) if (node?.adapter === "python" && typeof node.id === "string") dropped.add(node.id);
  if (dropped.size) {
    project.cardNodes = nodes.filter((node) => node?.adapter !== "python");
    for (const track of Array.isArray(project.tracks) ? project.tracks : []) {
      for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
        if (clip && typeof clip === "object" && dropped.has(clip.nodeId)) delete clip.nodeId;
      }
    }
  }
  return dropped.size;
}

/*
 * Notification bar: the count of dropped cards is shown only **once**. Same approach as the media
 * category migration (`mediaMigrationBus.ts`): the load path is pure logic and accumulates here,
 * and the UI side takes it and displays it.
 */
let pending = 0;
const EVENT = "pc-python-nodes-dropped";

/** Called by the load path; when the UI is not mounted (headless instance, unit tests) it only accumulates and reports no error. */
export function publishPythonDrop(count: number): void {
  if (!(count > 0)) return;
  pending += count;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function takePythonDrops(): number {
  const out = pending;
  pending = 0;
  return out;
}

export function onPythonDrops(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** The message for the notification bar. Defined in one place only, so the two sides do not word it differently. */
export function pythonDropMessage(count: number): string {
  return tr("{0} Python cards were disabled and are no longer shown", count);
}
