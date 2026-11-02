/**
 * Pins a non-local snapshot (semantics `workflow/project.md` "Temporarily offline projects and saving": on
 * save, record the hash, time and history sequence number of the confirmed snapshot of the non-local
 * content; `mechanism/document-service.md`: the hash and time do not replace comparable baseline content).
 *
 * When an account cloud project is saved as .proc / .procp, the file's cloud association marker
 * (`cloudAssociation`) carries, besides the history sequence number and time:
 *   - `base`: the version of the project the document service had confirmed at the moment of saving (the
 *     confirmed copy in this page's DocSync) --- the **baseline content**;
 *   - `baseSha256`: the SHA-256 of `JSON.stringify(base)`, checked on read-back; if it does not match, it is
 *     treated as having no baseline (the file was corrupted).
 * When the file is reopened and reconnected to the cloud, it is used as the baseline: baseline → the file
 * content is compared item by item to get "my changes", and places the cloud changed by others after the
 * save are not treated as "things I undid".
 * Old files lack this part: they open as before, and on reconnect fall back to the original approach (the
 * cloud at reconnect time is the baseline).
 *
 * Pure function, can be loaded by Node unit tests.
 */
import type { Project } from "../../kernel/project";
import { diffThings, type MergeThing } from "./mergeItems";
import { sha256Hex } from "./sha256";

export interface CloudSnapshot {
  /** History sequence number of the baseline */
  rev: number;
  /** Baseline content (the version confirmed by the document service) */
  project: Project;
}

/** The snapshot items in the cloud association marker at save time */
export interface SnapshotFields {
  savedRev: number;
  savedAt: string;
  base?: Project;
  baseSha256?: string;
}

export const snapshotHash = (base: Project): string => sha256Hex(JSON.stringify(base));

/**
 * Snapshot fields at save time: when connected to this cloud project, take the current confirmed copy; when
 * not connected (opened from the local copy, offline), keep the baseline and sequence number already in the
 * file ---
 * that version is still "what the cloud looked like before my changes", and replacing it with anything else
 * would get the baseline wrong.
 */
export function snapshotForSave(prev: { savedRev: number; base?: Project; baseSha256?: string }, live: CloudSnapshot | null, now: Date = new Date()): SnapshotFields {
  if (live) return { savedRev: live.rev, savedAt: now.toISOString(), base: live.project, baseSha256: snapshotHash(live.project) };
  return { savedRev: prev.savedRev, savedAt: now.toISOString(), ...(prev.base ? { base: prev.base, baseSha256: prev.baseSha256 ?? snapshotHash(prev.base) } : {}) };
}

/** The baseline read back: used only if the shape is right and the hash matches; returns null for old files (which lack it) or corrupted ones */
export function verifiedBase(v: { base?: unknown; baseSha256?: unknown }): Project | null {
  const base = v.base as Project | undefined;
  if (!base || typeof base !== "object" || !Array.isArray((base as Project).tracks)) return null;
  if (typeof v.baseSha256 !== "string" || snapshotHash(base) !== v.baseSha256) return null;
  return base;
}

export type ReopenPlan =
  /** Nobody touched the cloud after the save: commit the changes in the file as one ordinary change */
  | { kind: "commit" }
  /** The cloud was changed by others: baseline → the file is compared item by item to get my changes, which go into the pending merge items (the merge conflicts window) */
  | { kind: "table"; things: MergeThing[] }
  /** Old file has no baseline: fall back to the original approach */
  | { kind: "legacy" }
  /** The file is the same as the baseline (nothing changed locally) */
  | { kind: "none" };

/** How to handle the changes in the file when it is reopened and reconnected to the cloud */
export function reopenPlan(assoc: { savedRev: number; base?: unknown; baseSha256?: unknown }, file: Project, cloudRev: number, meta: { batch: string; at: number }): ReopenPlan {
  const base = verifiedBase(assoc);
  if (!base) return { kind: "legacy" };
  const things = diffThings(base, file, { source: "offline", batch: meta.batch, baseRev: assoc.savedRev, at: meta.at });
  if (!things.length) return { kind: "none" };
  if (cloudRev === assoc.savedRev) return { kind: "commit" };
  return { kind: "table", things };
}
