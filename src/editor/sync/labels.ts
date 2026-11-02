/**
 * Wording for "which place" and "who changed it" in the undo bar, the offline dialog and the local backup list
 * (c65-undo-draft.md, section 2).
 *
 * - Entities are counted at the top level, and the prefix carries the category: clip "Opening shot", track "Main track",
 *   project settings "Frame rate";
 * - Identity: another member (username), a chat of the Agent, a member's Cloud Agent, you on another page.
 *
 * Pure functions that do not read the store: the project and "who am I" are both passed in by the caller.
 */
import { entityValuePath, getAt, parsePath } from "../../kernel/diffProject";
import { relocatePath } from "../../kernel/cutPaths";
import type { Project } from "../../kernel/project";
import { getCard } from "../../kernel/registry";
import type { Writer } from "../../store/docsync";
import { cloudAgentLabel } from "./hostedServices";
import { tr } from "../../i18n/index.ts";
import { shownName, shownNameOf } from "../../i18n/names.ts";

/** Collection name → category */
const KIND: Record<string, string> = {
  tracks: tr("track"),
  clips: tr("Clips"),
  transitions: tr("Transition"),
  cuts: tr("Cut"),
  media: tr("media"),
  cardNodes: tr("Media effect card nodes"),
  cardDefinitions: tr("Card definitions"),
  filters: tr("Filters"),
  pixelMaps: tr("Pixel map"),
  audioFx: tr("Audio effects"),
  captions: tr("Captions"),
};

/** Top-level project field → name */
const META: Record<string, string> = {
  name: tr("Name"),
  fps: tr("Frame rate"),
  width: tr("Width"),
  height: tr("Height"),
  duration: tr("Duration"),
  themeId: tr("Theme"),
  camera3dFov: tr("3D perspective"),
  glRoute: tr("Render route"),
  creativity: tr("Creativity level"),
  media: tr("media"),
  tracks: tr("track"),
  cuts: tr("Cut"),
};

const quoted = (s: string) => tr("\"{0}\"", s);

/**
 * How a clip is referred to: consistent with the clip's title on the timeline (ClipView: a card clip uses the card name,
 * a media clip uses its label). When the same card appears several times, the start time is appended to tell them apart;
 * if neither exists, use the id.
 */
function clipName(c: Record<string, unknown> | undefined, id: string): string {
  if (!c) return id;
  let name = "";
  if (typeof c.cardId === "string" && c.cardId) name = shownNameOf(getCard(c.cardId)?.name) ?? c.cardId;
  else if (typeof c.label === "string" && c.label.trim()) name = c.label.trim();
  if (!name) return id;
  return typeof c.start === "number" ? `${name} @${c.start.toFixed(1)}s` : name;
}

/** Entity → human-readable name, for example `clip "Opening shot"`, `track "Track 1"`, `project settings "Frame rate"` */
export function entityLabel(entity: string, project: Project | null): string {
  if (entity === "*") return tr("Entire project");
  if (entity.startsWith("/meta/")) {
    const key = entity.slice("/meta/".length).replace(/~1/g, "/").replace(/~0/g, "~");
    return tr("Project setting {0}", quoted(META[key] ?? key));
  }
  const segs = parsePath(entity);
  if (!segs || segs.length < 2) return entity;
  const coll = segs[segs.length - 2];
  const id = segs[segs.length - 1].replace(/^@/, "");
  const kind = KIND[coll] ?? tr("Items");
  // When a track is in a parked cut, the entity's path (regardless of where it lives) must be remapped by track id to where it lives now before a value can be read
  const valuePath = entityValuePath(entity);
  const value = project ? ((getAt(project, valuePath) ?? getAt(project, relocatePath(project, valuePath))) as Record<string, unknown> | undefined) : undefined;
  if (coll === "clips") return tr("Clip {0}", quoted(clipName(value, id)));
  const name = value && typeof value.name === "string" && value.name.trim() ? value.name.trim() : id;
  return `${kind}${quoted(name)}`;
}

/** Whether an entity can be clicked to jump to it: clip (select it and move the playhead to its start), track, project settings */
export function clipOfEntity(entity: string): string | null {
  const m = /\/clips\/@([^/]+)$/.exec(entity);
  return m ? m[1].replace(/~1/g, "/").replace(/~0/g, "~") : null;
}

/** Who this page is: the session number and the connection identity (the local space is `local`, a shared project is `username@device`) */
export interface Me {
  session: string;
  userId: string | null;
}

type Actor = { userId?: string; username?: string; deviceId?: string; deviceName?: string; role?: string; conversation?: number; session?: string; service?: string;
  /** The write identity of an account cloud project carries the account id (`server/docservice/modules/actor.mjs`); `userId` is `account:<account id>@<device id>`, not meant for people to read */
  accountId?: string };

/** Key of the display-name table in an account cloud project: looked up by account (the same account has the same name on any device) */
export const accountNameKey = (accountId: string): string => `account:${accountId}`;

/** The username in `username@device` (the write identity carries no username, and it cannot be found in the member list either when the initiating member is offline) */
const usernameOf = (userId: string | undefined): string => {
  const s = userId ?? "";
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(0, at) : s;
};

/** Display name in a shared project: the displayName given by the member list (with the device name added when names collide), looked up by userId */
export type DisplayNames = Map<string, string>;

/**
 * Write identity → human-readable wording: `Zhang San`, `Agent "chat 2"`, `Zhang San · Agent · chat 2`, `Zhang San's Cloud Agent`,
 * `you on another page`.
 * A Cloud Agent (`role: 'agent'` and `service: 'agent'`, contract cloud-agent-contract.md section 5) uses the identity of
 * the member who started it: others see "<member name>'s Cloud Agent", and the device that started it sees "Your Cloud Agent".
 */
export function writerLabel(by: Writer | undefined, me: Me, names: DisplayNames = new Map()): string {
  // Both shapes are recognized: `{ actor, session }` (recorded by DocSync), and the bare actor given directly by the document service (`project.overwritten.by`)
  const raw = by as (Writer & Actor) | undefined;
  const actor = ((raw?.actor && typeof raw.actor === "object" ? raw.actor : raw && typeof raw.userId === "string" ? raw : {}) as Actor);
  const session = by?.session ?? actor.session;
  const sameUser = !!actor.userId && actor.userId === me.userId;
  if (!actor.userId && session === me.session) return tr("You on this page");
  if (actor.role === "agent" && actor.service === "agent") {
    if (sameUser) return tr("Your Cloud Agent");
    // Account cloud project: a Cloud Agent's write identity is `account:<account id>@run:<task id>`, with no device; people are identified by account and names are looked up by account
    if (typeof actor.accountId === "string") {
      if (me.userId?.startsWith(`${accountNameKey(actor.accountId)}@`)) return tr("Your Cloud Agent");
      if (names.has(accountNameKey(actor.accountId))) return cloudAgentLabel(names.get(accountNameKey(actor.accountId))!);
    }
    return cloudAgentLabel(actor.username ?? usernameOf(actor.userId));
  }
  if (actor.role === "agent") {
    const n = typeof actor.conversation === "number" ? tr("Chat #{0}", actor.conversation) : tr("A chat");
    if (sameUser || !actor.username) return `Agent${quoted(n)}`;
    return `${names.get(actor.userId ?? "") ?? actor.username} · Agent · ${n}`;
  }
  if (session === me.session && (sameUser || !actor.userId)) return tr("You on this page");
  if (sameUser) return tr("You on another page");
  if (actor.userId && names.has(actor.userId)) return names.get(actor.userId)!;
  // Account cloud project: the member list gives names by account (`displayNames` in `syncManager.ts`)
  if (typeof actor.accountId === "string" && names.has(accountNameKey(actor.accountId))) return names.get(accountNameKey(actor.accountId))!;
  return actor.username ?? actor.userId ?? tr("Someone else");
}

/**
 * After a password change or reset the user chose "Log out", and the document service rolled back the changes the old
 * devices made in the meantime: the bubble received by members who are online right now
 * (`product/document-service.md`, "Handling of changes from saving and delayed logout", user decision, 2026-10-22).
 * <username> is the account that changed the password; when the name cannot be found, fall back to "A member".
 */
export function rolledBackText(name: unknown): string {
  return typeof name === "string" && name.trim() ? tr("{0} undid content", name.trim()) : tr("A member undid content");
}

/** Human-readable text for the project history sequence number (change count): History sequence number N */
export function historySeqLabel(rev: number | null | undefined): string {
  if (rev === null || rev === undefined || !Number.isFinite(rev)) return tr("History sequence number -");
  return tr("History sequence number {0}", rev);
}

