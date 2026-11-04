import { tr } from "../../i18n/index.ts";
/**
 * Whether this page can change the project right now. Two sources:
 *
 * 1. **Read-only viewer page opened with `?observe=1`**: it does not connect to the MCP bridge (see
 *    src/ai/mcpExecutor.ts), so it does not push the editor off the tool channel; it cannot save (the
 *    save button in the top bar is disabled), does not connect to the document service, and does not
 *    transcode media.
 * 2. **The project only granted read-only permission** (`access: 'r'`): this is what a guest entering
 *    someone else's project gets (user decision, 2026-10-23), and a read-only member will take this path
 *    in the future too. `src/editor/sync/syncManager.ts` hands over the permission sent by the server when
 *    entering the project.
 *
 * What actually blocks writes is the server (for the account path, `permission` in
 * `server/account/authority.mjs`; the document service blocks once more in
 * `server/docservice/modules/project.mjs`). This only keeps the UI from letting people do work in vain,
 * and **is not** the permission itself: even if this copy is bypassed, the cloud project still cannot be changed.
 *
 * There used to be another kind of read-only link carrying a key (`?view=`, for the agent in a SKILL
 * headless instance to view the picture), archived along with the headless instance (plan
 * `docs/plan/agent-workflow-plan.md` A4).
 */

/** The permission given by the current project; null when not in a shared project (local space), in which case something else decides whether it can be changed */
let projectAccess: 'r' | 'rw' | null = null;

/** When entering a project / resuming a session, record the permission sent by the server; pass null when leaving the project */
export function setProjectAccess(access: 'r' | 'rw' | null): void {
  projectAccess = access === 'r' || access === 'rw' ? access : null;
}

/** The permission this project gives right now */
export function projectAccessNow(): 'r' | 'rw' | null {
  return projectAccess;
}

/** Why it is read-only: the address carries `observe`, or the project only granted read-only. Null if neither */
export function viewOnlyReason(): 'observe' | 'read-only-member' | null {
  if (projectAccess === 'r') return 'read-only-member';
  if (typeof location === "undefined") return null;
  try {
    return new URLSearchParams(location.search).has("observe") ? 'observe' : null;
  } catch {
    return null;
  }
}

export function isViewOnly(): boolean {
  return viewOnlyReason() !== null;
}

/** The sentence the UI shows when changes are not possible. The two read-only cases read differently: in one you opened it read-only yourself, in the other the project did not give you write permission */
export function viewOnlyText(): string {
  return viewOnlyReason() === 'read-only-member'
    ? tr("You can only view this project, you cannot change its content.")
    : tr("This is read-only view mode, this project cannot be changed.");
}
