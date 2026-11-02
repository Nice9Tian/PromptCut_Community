/**
 * The "organization data" half of the sidebar tree: groups, which group a project is in, pins, archive,
 * and the manual order.
 *
 * **Two realms of groups, never mixed** (user decision, 2026-10-23: "Split into local groups (the desktop
 * app's local Agent) and cloud groups. Cloud groups are stored in the cloud, local groups are stored
 * locally. A local project cannot be put into a cloud group (and vice versa)"):
 *
 * |                     | Which projects it holds                                         | Where it is stored                     | Which screen uses it |
 * |---------------------|-----------------------------------------------------------------|----------------------------------------|----------------------|
 * | Local group `local` | Local draft projects (`editor/io/drafts.ts`)                    | Locally (`localStorage`)               | `DesktopStart.tsx`   |
 * | Cloud group `cloud` | Cloud projects (the project list of the cloud document service) | Cloud, follows the account (see below) | `OnlineStart.tsx`    |
 *
 * One `OrgState` belongs to only one realm (`realm`), and four places go by it: the key, the marker in the
 * content, building the manifest, and putting into a group; a mismatch in any one of them is rejected:
 * - **Storage keys are split by realm** (`orgKey`): `pc.start.org.local.<scope>` and
 *   `pc.start.org.cloud.<scope>`, whose prefixes differ, so neither can overwrite the other;
 * - **The content carries a marker** (`parseOrg`): something read back that is marked as the other realm
 *   is treated as never recorded, so one realm's content is never taken as the other's;
 * - **Building the manifest accepts only projects of the same realm** (`mergeProjects`);
 * - **Putting into a group is only allowed within the same realm** (`moveProject`, `moveRefusal`): across
 *   realms a sentence of explanation is returned and the organization data is left unchanged.
 *
 * **Where the cloud realm is stored**: in the cloud document service, one copy per account, and the whole
 * copy (groups, which group a project is in, pins, archive, order, chat markers) goes to the cloud
 * together (interface `POST /hosted/shared/account/start-org`, server
 * `cloud/docservice/modules/account-org.mjs`, rulings V22-05~09).
 * The local key `pc.start.org.cloud.<account>` is its cache in this browser: it is used first on open;
 * for the sync logic see `orgSync.ts`, `orgMerge.ts` and `useCloudOrg.ts`.
 * When the server does not have this route yet (an old server) it quietly falls back to "recorded only in
 * this browser" and the UI changes its wording accordingly. Guests have no cloud copy (a guest identity
 * does not cross devices and has just one project), and so no groups.
 *
 * The projects themselves (which exist, what they are called, who created them) always follow the project
 * list: only the organization data is recorded here, and a project that is not in the list does not appear
 * out of nowhere; when the list is temporarily unavailable, the organization data already recorded is not
 * lost either (`withProjects` leaves entries that did not appear this time as they are).
 *
 * Pure functions plus one pair of read/write, without touching React; reading and writing are both
 * wrapped in try/catch (incognito windows and disabled site data throw outright), and when it cannot be
 * read it is treated as never recorded. Always return new objects, never modify in place (repository
 * constraint). Unit tests: `vibeOrg.test.mjs`, `orgRealm.test.mjs`.
 */
import type { OrgRealm, Ratio, TreeFlags, VibeChat, VibeGroup, VibeProject } from "./types.ts";
import { tr } from "../i18n/index.ts";

export type { OrgRealm } from "./types.ts";

export interface OrgProject extends TreeFlags {
  id: string;
  groupId: string | null;
}

export interface OrgChat extends TreeFlags {
  id: string;
  projectId: string;
}

/** The saved groups: which realm a group belongs to is decided by the `realm` of the whole `OrgState`, and each group no longer records it again */
export type OrgGroup = Omit<VibeGroup, "realm">;

export interface OrgState {
  v: 1;
  /** Which realm this copy belongs to; the key, the content, building the manifest and putting into a group are all checked against it */
  realm: OrgRealm;
  groups: OrgGroup[];
  /** The array order is the display order (among siblings) */
  projects: OrgProject[];
  chats: OrgChat[];
}

const EMPTY: Readonly<Record<OrgRealm, OrgState>> = Object.freeze({
  local: Object.freeze({ v: 1, realm: "local", groups: [], projects: [], chats: [] }) as OrgState,
  cloud: Object.freeze({ v: 1, realm: "cloud", groups: [], projects: [], chats: [] }) as OrgState,
});

/** The organization data of a realm in which nothing has been recorded (a shared frozen object, do not modify it) */
export const emptyOrg = (realm: OrgRealm): OrgState => EMPTY[realm];

/** There is only one copy of local groups in local storage: the desktop app is one machine, so the scope is fixed to this */
export const LOCAL_ORG_SCOPE = "desktop";

/** The scope of cloud groups: the id of the logged-in account. Guests have none (guests have no groups, see the file header) */
export const cloudOrgScope = (accountId: string): string => `acc:${accountId}`;

/**
 * Keys in local storage. **The prefixes of the two realms differ** (`pc.start.org.local.` /
 * `pc.start.org.cloud.`), so no scope name can collide with the opposite realm.
 * The cloud realm has one copy per account; the local realm goes by scope (currently there is only
 * `LOCAL_ORG_SCOPE`).
 */
export const orgKey = (realm: OrgRealm, scope: string): string => `pc.start.org.${realm}.${scope}`;

/** The old key from before the realms were split (`pc.start.org.<scope>`): recognized once when the new key cannot be read; only the new key is ever written */
const legacyOrgKey = (scope: string): string => `pc.start.org.${scope}`;

/** A local project cannot go into a cloud group and a cloud project cannot go into a local group: the sentence addressed to the user. Returns null for the same realm */
export function moveRefusal(projectRealm: OrgRealm, groupRealm: OrgRealm): string | null {
  if (projectRealm === groupRealm) return null;
  return projectRealm === "local"
    ? tr("A local project cannot be placed into a cloud group: local groups hold local projects, and cloud groups hold cloud projects.")
    : tr("A cloud project cannot be placed into a local group: cloud groups hold cloud projects, and local groups hold local projects.");
}

/**
 * Whether cloud groups are stored in the cloud. Always true once cloud storage is connected (the server
 * has `start-org` and the page has sync); it is kept as a constant so that a build whose server is not
 * deployed properly can switch it back to false, and the UI then says only "recorded only in this
 * browser" at once, without pretending it already works across devices.
 * Detecting an old server at runtime (one without this route) is a separate path, see the second
 * parameter of `orgWhereText`.
 */
export const CLOUD_ORG_IN_CLOUD = true;

/**
 * Where this realm's organization data is stored, as one sentence addressed to the user (used by the hint
 * for creating a group and by the sidebar's description).
 * `inCloud`: whether the cloud realm is really stored in the cloud right now; by default it follows
 * `CLOUD_ORG_IN_CLOUD`, and the online screen passes false when it detects an old server.
 */
export function orgWhereText(realm: OrgRealm, inCloud: boolean = CLOUD_ORG_IN_CLOUD): string {
  if (realm === "local") return tr("Only remembered on this machine");
  return inCloud ? tr("Stored in the cloud, visible on other devices too") : tr("Only remembered in this browser for now");
}

/** What is said at "New group": which realm of group this is, where it is stored, and what it holds */
export function groupNoteText(realm: OrgRealm, inCloud: boolean = CLOUD_ORG_IN_CLOUD): string {
  return realm === "local"
    ? tr("Local group: {0}. Only local projects can go in it.", orgWhereText("local"))
    : tr("Cloud group: {0}. Only cloud projects can go in it.", orgWhereText("cloud", inCloud));
}

/**
 * After the cloud project list has been fetched, remove from the organization data the projects that are
 * **no longer in the list**, so the cloud copy does not only grow and never shrink:
 * project entries with no group, pin or archive (no organization data at all, just a position) are
 * removed; the chat entries under a project are removed together with the project.
 * Entries that do have organization data are kept (perhaps the list was only partially fetched). If the
 * list was not fetched (`ids` is null) nothing is cleaned up. When there is nothing to clean, the
 * original object is returned.
 */
export function pruneOrg(org: OrgState, ids: ReadonlySet<string> | null): OrgState {
  if (!ids) return org;
  const keep = (p: OrgProject) => ids.has(p.id) || p.groupId !== null || !!p.pinned || !!p.archived;
  const projects = org.projects.filter(keep);
  const known = new Set([...ids, ...projects.map((p) => p.id)]);
  const chats = org.chats.filter((c) => known.has(c.projectId));
  if (projects.length === org.projects.length && chats.length === org.chats.length) return org;
  return { ...org, projects, chats };
}

/** The group manifest the sidebar needs: the saved groups, stamped with this realm's marker */
export function groupsOf(org: OrgState): VibeGroup[] {
  return org.groups.map((g) => ({ ...g, realm: org.realm }));
}

function flagsOf(x: unknown): TreeFlags {
  const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const out: TreeFlags = {};
  if (r.pinned === true) out.pinned = true;
  if (r.archived === true) out.archived = true;
  return out;
}

function idOk(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200;
}

type Loose = Record<string, unknown>;
const rows = (x: unknown): Loose[] => (Array.isArray(x) ? x.filter((r) => r && typeof r === "object") : []) as Loose[];

/**
 * What is read back cannot be trusted (edited by hand, or another shape written by an old version):
 * recognize it entry by entry and drop what cannot be recognized.
 * `realm` is the realm the caller wants to read: a whole copy marked as the other realm is not accepted
 * (treated as never recorded); one with no marker is the old format written before the realms were split,
 * and is accepted as the realm the caller wants.
 */
export function parseOrg(raw: string | null, realm: OrgRealm): OrgState {
  if (!raw) return emptyOrg(realm);
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return emptyOrg(realm);
  }
  const r = (v && typeof v === "object" ? v : {}) as Loose;
  if (r.realm !== undefined && r.realm !== realm) return emptyOrg(realm);
  const groups: OrgGroup[] = rows(r.groups)
    .filter((g) => idOk(g.id) && typeof g.name === "string" && g.name.trim() !== "")
    .map((g) => ({ id: g.id as string, name: String(g.name).slice(0, 200), ...flagsOf(g) }));
  const groupIds = new Set(groups.map((g) => g.id));
  const projects: OrgProject[] = rows(r.projects)
    .filter((p) => idOk(p.id))
    .map((p) => ({ id: p.id as string, groupId: idOk(p.groupId) && groupIds.has(p.groupId) ? p.groupId : null, ...flagsOf(p) }));
  const chats: OrgChat[] = rows(r.chats)
    .filter((c) => idOk(c.id) && idOk(c.projectId))
    .map((c) => ({ id: c.id as string, projectId: c.projectId as string, ...flagsOf(c) }));
  return { v: 1, realm, groups, projects, chats };
}

/** Read the copy of this realm stored locally. No scope (not logged in), cannot be read, or what is read is wrong: all treated as never recorded */
export function loadOrg(realm: OrgRealm, scope: string | null): OrgState {
  if (!scope) return emptyOrg(realm);
  try {
    // If the new key is absent, recognize the old key from before the realms were split once (it has no realm
    // marker, and is accepted as the realm the caller wants)
    const raw = localStorage.getItem(orgKey(realm, scope)) ?? localStorage.getItem(legacyOrgKey(scope));
    return parseOrg(raw, realm);
  } catch {
    return emptyOrg(realm);
  }
}

/** Write locally. The key is decided by this copy's own realm (`org.realm`), so the caller has no chance to write one realm into the other realm's key */
export function saveOrg(scope: string | null, org: OrgState): void {
  if (!scope) return;
  try {
    localStorage.setItem(orgKey(org.realm, scope), JSON.stringify(org));
  } catch {
    /* If it cannot be saved, it is only valid for this session of the page */
  }
}

/** One project in the project manifest: carries which realm it belongs to (a local draft is local; ones in the cloud list that I created, that I joined, and the guest's own are cloud) */
export interface OrgEntry {
  id: string;
  name: string;
  role: VibeProject["role"];
  realm: OrgRealm;
}

/** The picture info recorded when this browser opened the project (`thumbCache.ts`) */
export interface SeenMeta {
  ratio: Ratio | null;
  duration: number | null;
  thumb: string | null;
  seenAt: string | null;
}

/**
 * Build the project manifest the sidebar needs from the project list and the organization data. Order:
 * those with a recorded order go by that order; newly appearing ones this time (just created, just pulled
 * in) go to the very front, keeping their order from the list among themselves. When the same project
 * appears in both "Created by me" and "Joined by me", only the first occurrence is kept.
 * **Only projects of the same realm as this organization data are accepted**: cloud projects never appear
 * in local organization data, and local drafts never appear in the cloud's.
 */
export function mergeProjects(org: OrgState, cloud: readonly OrgEntry[], meta: Readonly<Record<string, SeenMeta>> = {}): VibeProject[] {
  const byId = new Map<string, OrgEntry>();
  for (const c of cloud) if (c.realm === org.realm && !byId.has(c.id)) byId.set(c.id, c);
  const groupIds = new Set(org.groups.map((g) => g.id));
  const known = org.projects.filter((p) => byId.has(p.id));
  const knownIds = new Set(known.map((p) => p.id));
  const fresh: OrgProject[] = [...byId.values()].filter((c) => !knownIds.has(c.id)).map((c) => ({ id: c.id, groupId: null }));
  return [...fresh, ...known].map((o) => {
    const c = byId.get(o.id)!;
    const m = meta[o.id];
    const p: VibeProject = {
      id: c.id,
      name: c.name,
      role: c.role,
      realm: org.realm,
      groupId: o.groupId && groupIds.has(o.groupId) ? o.groupId : null,
      ratio: m?.ratio ?? null,
      duration: m?.duration ?? null,
      thumb: m?.thumb ?? null,
      seenAt: m?.seenAt ?? null,
    };
    if (o.pinned) p.pinned = true;
    if (o.archived) p.archived = true;
    return p;
  });
}

/**
 * After the sidebar has changed projects (pin, archive, sort, change group), write back the organization
 * data. Entries that are not in this manifest (the list is temporarily unavailable, or the account scope
 * changed) are left behind as they are, not lost.
 */
export function withProjects(org: OrgState, list: readonly Pick<VibeProject, "id" | "realm" | "groupId" | "pinned" | "archived">[]): OrgState {
  // Projects of the other realm do not enter this copy (normally unreachable: the manifest is built by
  // `mergeProjects` and already contains only the same realm)
  const mine = list.filter((p) => p.realm === org.realm);
  const ids = new Set(mine.map((p) => p.id));
  const rest = org.projects.filter((p) => !ids.has(p.id));
  return {
    ...org,
    projects: [...mine.map((p) => ({ id: p.id, groupId: p.groupId ?? null, ...flagsOf(p) })), ...rest],
  };
}

export function withGroups(org: OrgState, groups: readonly (OrgGroup & { realm?: OrgRealm })[]): OrgState {
  // Groups of the other realm do not enter this copy
  groups = groups.filter((g) => g.realm === undefined || g.realm === org.realm);
  const ids = new Set(groups.map((g) => g.id));
  return {
    ...org,
    groups: groups.map((g) => ({ id: g.id, name: g.name, ...flagsOf(g) })),
    // A deleted group: the projects in it go back to "Ungrouped"
    projects: org.projects.map((p) => (p.groupId && !ids.has(p.groupId) ? { ...p, groupId: null } : p)),
  };
}

export function withChats(org: OrgState, projectId: string, list: readonly Pick<VibeChat, "id" | "pinned" | "archived">[]): OrgState {
  const ids = new Set(list.map((c) => c.id));
  const rest = org.chats.filter((c) => !(c.projectId === projectId && ids.has(c.id)));
  return { ...org, chats: [...list.map((c) => ({ id: c.id, projectId, ...flagsOf(c) })), ...rest] };
}

/** Create a group. A blank name is called "New group"; the id is unique within this copy */
export function addGroup(org: OrgState, name: string, rand: () => string = () => Math.random().toString(36).slice(2, 8)): { org: OrgState; id: string } {
  const taken = new Set(org.groups.map((g) => g.id));
  let id = `g-${rand()}`;
  for (let i = 0; taken.has(id) && i < 50; i++) id = `g-${rand()}${i}`;
  const group: OrgGroup = { id, name: name.trim().slice(0, 200) || tr("New group") };
  return { org: { ...org, groups: [...org.groups, group] }, id };
}

/**
 * Put a project into a group (null means move it out of its group). **Only the same realm is allowed**:
 * when the project belongs to the other realm (a local project into a cloud group, a cloud project into a
 * local group) the organization data is left unchanged and `refused` is the sentence addressed to the
 * user. Every entry point for putting into a group (the context menu, drag-and-drop in the future) must go
 * through this one function.
 */
export function moveProject(org: OrgState, project: Pick<VibeProject, "id" | "realm">, groupId: string | null): { org: OrgState; refused: string | null } {
  const refused = moveRefusal(project.realm, org.realm);
  if (refused) return { org, refused };
  const target = groupId && org.groups.some((g) => g.id === groupId) ? groupId : null;
  const has = org.projects.some((p) => p.id === project.id);
  const projects = has
    ? org.projects.map((p) => (p.id === project.id ? { ...p, groupId: target } : p))
    : [{ id: project.id, groupId: target }, ...org.projects];
  return { org: { ...org, projects }, refused: null };
}

/** One item of the context menu "Move to group". A `blocked` value means it cannot be put in: grayed out, with the reason on hover */
export interface MoveTarget {
  id: string | null;
  name: string;
  blocked?: string;
}

/**
 * Which groups a project's context menu "Move to group" can list. Groups of the other realm are listed
 * too, grayed out with an explanation (once the sidebar has both realms of groups at the same time, users
 * will want to put the project over there, and we must tell them why it cannot be done rather than quietly
 * not listing it). The group it is currently in and archived groups are not listed; when it is already in
 * some group there is one more item, "Move out of group".
 */
export function moveTargetsFor(project: Pick<VibeProject, "realm" | "groupId">, groups: readonly VibeGroup[]): MoveTarget[] {
  const targets: MoveTarget[] = groups
    .filter((g) => !g.archived && g.id !== project.groupId)
    .map((g) => {
      const blocked = moveRefusal(project.realm, g.realm);
      return blocked ? { id: g.id, name: g.name, blocked } : { id: g.id, name: g.name };
    });
  if (project.groupId) targets.push({ id: null, name: "" });
  return targets;
}

/* ---------------- Project Agent: which chats are visible ---------------- */

/** One entry in the cloud history list (`CloudChatItem` in `src/ai/cloud/types.ts`; only the fields that are used are recognized here) */
export interface ChatItemLike {
  id: string;
  title: string;
  state: VibeChat["state"];
  visibility?: "shared" | "private";
  ownerAccountId?: string;
  creatorReadOnly?: boolean;
}

/**
 * The chats the current account can see (`product/agent.md` "Connection"): a shared chat is visible to all
 * valid members of the same project; a private chat is visible only to the account that owns it, with
 * the exception that the project creator can view it read-only. The server has already filtered by this
 * rule, and the page re-checks it: **other people's private chats must never be listed**.
 * Old entries without an owner (the server did not give `ownerAccountId`) go by the server's filtering
 * and are listed as they are.
 */
export function viewableChats(items: readonly ChatItemLike[], viewer: { accountId: string | null; creator: boolean }, projectId: string): VibeChat[] {
  const out: VibeChat[] = [];
  for (const it of items) {
    const visibility = it.visibility === "private" ? "private" : "shared";
    const owned = typeof it.ownerAccountId === "string" && it.ownerAccountId !== "";
    const mine = owned && viewer.accountId !== null && it.ownerAccountId === viewer.accountId;
    if (visibility === "private") {
      // Private: one without an owner is listed only when the server said the creator is viewing read-only; one with an owner is listed only if it is mine or I am the creator
      if (!owned && !it.creatorReadOnly && viewer.accountId === null) continue;
      if (owned && !mine && !viewer.creator) continue;
    }
    out.push({
      id: it.id,
      name: it.title || tr("Cloud chat"),
      projectId,
      state: it.state,
      visibility,
      readOnly: visibility === "private" && (it.creatorReadOnly === true || (owned && !mine)),
    });
  }
  return out;
}

/** Apply the pins, archive and order recorded locally to this project's chats. Chats newly appearing on the server go to the front (the same rule as projects) */
export function mergeChats(org: OrgState, projectId: string, chats: readonly VibeChat[]): VibeChat[] {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const known = org.chats.filter((c) => c.projectId === projectId && byId.has(c.id));
  const knownIds = new Set(known.map((c) => c.id));
  const fresh = chats.filter((c) => !knownIds.has(c.id));
  return [
    ...fresh,
    ...known.map((o) => {
      const c: VibeChat = { ...byId.get(o.id)! };
      if (o.pinned) c.pinned = true;
      if (o.archived) c.archived = true;
      return c;
    }),
  ];
}
