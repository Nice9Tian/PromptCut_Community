/**
 * The shapes of the three kinds of things on the start page of Vibe mode: groups, projects, and project
 * Agents (cloud chats).
 *
 * Data sources (business layer wired in on 2026-10-23, `docs/reports/AGENT-claude-vibe-wire.md`):
 * - **Projects**: the project list of the cloud document service (`lists` in
 *   `src/account/useAccountProjects.ts`: created by me / joined by me); guests have no such table, and
 *   their one project is recorded locally (`src/account/guest.ts`). Names and ownership follow the
 *   server; the aspect ratio, duration and thumbnail were recorded when this browser opened the project
 *   (`thumbCache.ts`), and are absent if it was never opened, in which case the UI falls back to a
 *   color block.
 * - **Project Agents**: the cloud Agent chats in the currently connected project that the current
 *   account can see (the history list in `src/ai/cloud/useCloud.ts`; the server filters by the shared /
 *   private rules of `product/agent.md`, and the page re-checks with the same rule, see `viewableChats`
 *   in `vibeOrg.ts`).
 * - **Groups** (user decision, 2026-10-23: split into local groups and cloud groups that cannot hold
 *   each other's projects): a local group holds local draft projects and is stored locally; a cloud
 *   group holds cloud projects and is stored in the cloud. The two realms each manage their own
 *   projects, and `OrgRealm` is used here to mark which realm a thing belongs to (`vibeOrg.ts`).
 *
 * Pin, archive and manual order follow the group: local projects are recorded locally, and cloud
 * projects are recorded in the cloud copy.
 */

/** Which realm a group or project belongs to: local (desktop app, local draft projects) or cloud (projects of the cloud document service). The two realms are never mixed */
export type OrgRealm = "local" | "cloud";

/** All three kinds of things can be right-clicked and dragged to reorder, so they all carry these two markers (the rule is in `treeState.ts`: it only applies among one's own siblings) */
export interface TreeFlags {
  pinned?: boolean;
  archived?: boolean;
}

export interface VibeGroup extends TreeFlags {
  id: string;
  name: string;
  /** Which realm this group belongs to; it can only hold projects of the same realm */
  realm: OrgRealm;
}

export type Ratio = "16:9" | "9:16" | "1:1";

export interface VibeProject extends TreeFlags {
  id: string;
  name: string;
  /** Which realm a project belongs to: a local draft is local, a cloud project is cloud. It can only be put in a group of the same realm */
  realm: OrgRealm;
  /** The group it belongs to (a group in the same realm); null means not in any group */
  groupId: string | null;
  /** Created by me / joined by me / the guest's own single project */
  role: "owned" | "joined" | "guest";
  /** Recorded the last time this browser opened it; null if it was never opened */
  ratio: Ratio | null;
  duration: number | null;
  /** Thumbnail (data URL, small JPEG); null if it cannot be obtained, and the UI falls back to a color block */
  thumb: string | null;
  /** Time of the last open in this browser (ISO); null if it was never opened */
  seenAt: string | null;
}

/** Project Agent: one cloud Agent chat. Attached only to projects (the semantics has no "group Agent", and this version does not build it) */
export interface VibeChat extends TreeFlags {
  id: string;
  name: string;
  projectId: string;
  /** In progress / interrupted / error / invalid / idle */
  state: "idle" | "running" | "interrupted" | "failed" | "revoked";
  visibility: "shared" | "private";
  /** The project creator viewing someone else's private chat: read-only */
  readOnly: boolean;
  /** A new chat that has not sent any message yet (exists only on this page; the server does not have this one yet) */
  fresh?: boolean;
}
