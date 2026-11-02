import { loadProc, serializeProc, forgetSaveTarget, withFrameSnapshots } from "./proc";
import { acquireDraftLock, releaseDraftLock } from "./procLock";
import { isViewOnly, viewOnlyReason, viewOnlyText } from "./viewOnly";
import { actions } from "../../store/project";
import type { Project } from "../../kernel/project";
import { onGoneConversion } from "../sync/recoveryAssociation";
import { tr } from "../../i18n/index.ts";

/** Local draft: a .proc file in the server's `.pc-projects/` directory */
export interface DraftInfo {
  id: string;
  name: string;
  updatedAt: string;
  size: number;
  duration: number;
  clips: number;
  thumbnail: string | null;
  /** The file is corrupted (cannot be parsed). It is still listed so the user can delete it */
  broken: boolean;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || tr("Request failed ({0})", res.status));
  }
  return data as T;
}

export async function listDrafts(): Promise<DraftInfo[]> {
  const data = await json<{ projects: DraftInfo[] }>(await fetch("/api/projects"));
  return data.projects ?? [];
}

/** Draft id: starts with a timestamp, so sorting the list by name is also roughly sorting by time */
export function newDraftId(): string {
  return `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveDraft(id: string, thumbnail: string | null = null): Promise<DraftInfo> {
  // A read-only view page stops here, with no need to wait for the server to reject it and then report an error; the error message also reads more human
  if (isViewOnly()) throw new Error(viewOnlyText());
  await (await import("../sync/syncManager")).whenSaved();
  return json<DraftInfo>(
    await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: await withFrameSnapshots(serializeProc(thumbnail)),
    }),
  );
}

/** Read a draft and load it into the store. Returns the loaded Project */
export async function openDraft(id: string): Promise<Project> {
  /*
   * Grab the exclusive lock first, then read the content. The order must not be reversed: if we read first and
   * then grab, two instances may both have loaded the project into memory, and telling one of them
   * "you did not get the lock" would be too late, since it can already edit.
   */
  const lock = await acquireDraftLock(id);
  if (!lock.ok) throw new Error(lock.error || tr("This project is open in another PromptCut"));
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!res.ok) {
    await releaseDraftLock();
    throw new Error(tr("Cannot open this draft ({0})", res.status));
  }
  // Old drafts have no project.id: use the draft id instead, so it matches the old entries in the custom card ownership table
  const project = loadProc(await res.text(), { legacyId: id });
  // Switching drafts changes the destination, so it must not overwrite the previous project's file
  forgetSaveTarget();
  actions.loadProject(project, `${project.name}.proc`);
  return project;
}

export async function deleteDraft(id: string): Promise<void> {
  if (isViewOnly()) throw new Error(viewOnlyReason() === "read-only-member" ? tr("You can only view this project, so you cannot delete it.") : tr("This is read-only view mode, so this project cannot be deleted"));
  // Like saveDraft, this must carry the owner header: delete is also a write, and the write gate on a headless instance checks this header.
  // If it is missing, clicking delete on the instance's **own** page gets blocked by its own gate.
  await json(await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/**
 * Which draft is currently being edited.
 *
 * Kept in a module-level variable rather than the store: it only affects which file "save" writes to, does not take part in undo/redo,
 * and should not go into the .proc file itself. Written when the start page selects a draft, read when the top bar saves.
 */
let activeDraftId: string | null = null;

export function setActiveDraftId(id: string | null): void {
  // Switching drafts (including setting it to null: new project, open from file) releases the previous lock.
  // Release only the previous one (with id): opening a draft first does openDraft(id) to grab the new lock, then comes here to record the id,
  // and without the id it would release the lock just grabbed (the draft being edited after the switch loses its lock).
  // No await: most call sites are inside a user gesture, so a slow release should not block the UI; releasing is idempotent itself.
  if (activeDraftId && activeDraftId !== id) void releaseDraftLock(activeDraftId);
  activeDraftId = id;
}

/** If there is none, create one on the spot, so "save" always has somewhere to write */
export function ensureActiveDraftId(): string {
  if (!activeDraftId) activeDraftId = newDraftId();
  return activeDraftId;
}

export function getActiveDraftId(): string | null {
  return activeDraftId;
}
// After an expired cloud project is converted to a local project, the original draft is kept: the converted project no longer belongs to it, and saving opens a new one
onGoneConversion(() => setActiveDraftId(null));
