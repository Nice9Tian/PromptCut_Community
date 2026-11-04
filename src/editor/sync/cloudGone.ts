import { newProjectId, type Project } from "../../kernel/project";
import type { CollaborationDescriptor, ConvertedFrom } from "./recoveryAssociation";
import { tr } from "../../i18n/index.ts";

/** Proof that "this project no longer exists", issued by the document service and checked by the client (`verifyGoneProof` in `server/recovery/gone-proof.mjs`) */
export interface GoneProof {
  v: 1; authorityId: string; projectId: string; state: "gone"; tombstoneRevision: number; issuedAt: number; kid: string; signature: string;
}

/**
 * Expired cloud project → standalone local project (pure function, does not touch the store, sends no requests).
 *
 * - Converts only when the project id in the proof is identical, character for character, to the room id
 *   recorded in the file; otherwise it throws (the caller should never get here);
 * - Content is kept as is: tracks, clips, parameters, the asset table (hashes, paths, names), card nodes
 *   and cuts are all untouched;
 * - A new local project id is assigned: the converted project is no longer the same as the original cloud
 *   project and does not borrow the old cloud identity;
 * - Returns no collaboration association: the caller clears the association, and multi-user collaboration
 *   is off by default.
 */
export function convertGoneProject(
  project: Project,
  descriptor: CollaborationDescriptor,
  proof: GoneProof,
  deps: { newId?: () => string; now?: () => Date } = {},
): { project: Project; from: ConvertedFrom } {
  if (descriptor.version !== 1 || descriptor.where !== "hosted" || !descriptor.roomId || !descriptor.service) throw new Error(tr("Only cloud projects can be converted to local projects as \"no longer exists\""));
  if (proof?.state !== "gone" || proof.projectId !== descriptor.roomId) throw new Error(tr("The \"no longer exists\" proof does not match this project"));
  if (!project || !Array.isArray(project.tracks)) throw new Error(tr("The project content is unreadable, nothing was converted"));
  const id = (deps.newId ?? newProjectId)();
  return {
    project: { ...project, id },
    from: { v: 1, roomId: descriptor.roomId, service: descriptor.service, authorityId: proof.authorityId,
      tombstoneRevision: proof.tombstoneRevision, kid: proof.kid, convertedAt: (deps.now?.() ?? new Date()).toISOString() },
  };
}

/**
 * Before converting, merges the offline changes on this device that were not sent out into the content in hand.
 *
 * Offline changes are recorded in this machine's recovery data. On a normal re-entry they are restored only
 * after the identity is found; but when the project has already been purged, the proof is obtained right
 * away and that step is never reached. If they are not merged in first, the converted local project holds
 * only the content in the file, and once the local identity is then deregistered these changes can never be
 * retrieved.
 * - If already restored (`restored`), it does not read again;
 * - If it cannot be read (the local recovery data is temporarily unreadable), it throws
 *   `offline-edits-unreadable`: the caller neither converts nor deregisters, and retries later;
 * - If it was read but cannot be merged in (a corrupted record), it throws `offline-edits-damaged`: the
 *   caller neither converts nor deregisters, keeps it as is and shows a notice.
 */
export async function restoreOfflineEdits(o: {
  restored: boolean;
  readJournal: () => Promise<unknown | null>;
  restoreJournal: (journal: unknown) => void;
}): Promise<"already" | "none" | "restored"> {
  if (o.restored) return "already";
  let journal: unknown;
  try { journal = await o.readJournal(); }
  catch (cause) { throw Object.assign(new Error(tr("The offline edits on this device cannot be read for now")), { reason: "offline-edits-unreadable", cause }); }
  if (journal === null || journal === undefined) return "none";
  try { o.restoreJournal(journal); }
  catch (cause) { throw Object.assign(new Error(tr("The offline edit records on this device are damaged")), { reason: "offline-edits-damaged", cause }); }
  return "restored";
}
