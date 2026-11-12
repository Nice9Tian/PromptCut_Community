/**
 * Actions of the "multi-user collaboration" project setting (C10a contract `docs/plan/c10a-contract.md`
 * section 6; semantics `workflow/project.md` "Multi-user collaboration").
 *
 * - **Enable**: if placed in the cloud, `POST shared/create` to the hosted side (the address defaults to the
 *   built-in hosted address and can be changed, as in C6.5) → enter as the creator and write the current
 *   project in with a root replace (`enterShared`, the C6.5 path) → `invite-create` → the UI shows the
 *   invite link and a QR code. If placed on this machine, it reuses C6.5's local hosting (this machine's
 *   document service `/docservice/shared/create`), registers with the cloud using the original device
 *   binding and keeps an outbound tunnel.
 * - **Defaults when ticked**: placed on this machine, open entry, creator username taken from the device
 *   name; the project password and the creator password are both generated automatically (16 characters
 *   each) and stored on this machine [ruling, section 6].
 * - **Invite code**: the plaintext is returned to the creator only at issue time and stored in the
 *   protected storage of his machine; the server does not store the plaintext, and other members cannot get
 *   it [ruling, section 6].
 * - **Cancel**: if placed in the cloud, first pull the project itself and the full-size originals of the
 *   referenced assets all back to this machine (prerender output can be regenerated, so it is not pulled),
 *   then `delete` as the creator, and the local project returns to the `local` space; if it fails midway,
 *   it is restored to the enabled state. If placed on this machine, stop local hosting (delete the shared
 *   project from this machine's document service) and return to the `local` space.
 *
 * The UI is in `CollabSection.tsx`; connecting, entering and creator operations are in `syncManager.ts`.
 */
import { adminOp, enterShared, ensureDevice, expectSharedClose, getSyncView, leaveSharedToLocal, pushToast, whenSaved, recoveryRequest, type AdminError } from "./syncManager";
import { errorStatus, route, hosted, type SharedMode, type Where } from "./sharedApi";
import { getState } from "../../store/project";
import { originalHashOf } from "../../render/mediaTier";
import { enqueueExistingMedia, type EnqueueExistingResult } from "../media/assetTiers";
import { ingestUnhashedMedia } from "../io/mediaUpload";
import { ONLINE } from "../../online/mode";
import { HOSTED_DOC_PATH, inviteLinkOf } from "../../online/invite";
import { cacheCollabSecrets, cachedCollabSecrets } from "./collabSecrets";
import { tr } from "../../i18n/index.ts";

/* ---------------- What this machine records ---------------- */

export interface InviteInfo {
  link: string;
  expiresAt: number;
  maxUses: number | null;
}

/** Collaboration projects enabled as creator on this device: the two automatically generated passwords and the invite link (only the creator's machine has them) */
export interface LocalCollab {
  projectId: string;
  where: Where;
  mode: SharedMode;
  name: string;
  creatorUsername: string;
  creatorPassword?: string;
  projectPassword?: string;
  invite?: InviteInfo | null;
}

const LOCAL_KEY = "pc.shared.local";

function readAll(): Record<string, LocalCollab> {
  try {
    const v = hosted.migrateHostedDeep(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? ""));
    return v && typeof v === "object" ? (v as Record<string, LocalCollab>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, LocalCollab>) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
}

export function localCollab(projectId: string): LocalCollab | null {
  return cachedCollabSecrets<LocalCollab>(projectId) ?? readAll()[projectId] ?? null;
}

async function saveLocal(rec: LocalCollab) {
  const descriptor = getSyncView().association;
  if (ONLINE) { cacheCollabSecrets(rec.projectId, rec); return; }
  if (!descriptor || descriptor.roomId !== rec.projectId) throw new Error(tr("The secret of the current room cannot be saved reliably"));
  await recoveryRequest("settings-write", descriptor, { settings: rec });
  cacheCollabSecrets(rec.projectId, rec);
  const all = readAll(); delete all[rec.projectId]; writeAll(all);
}

function dropLocal(projectId: string) {
  cacheCollabSecrets(projectId, null);
  const all = readAll();
  delete all[projectId];
  writeAll(all);
}

/* ---------------- Defaults ---------------- */

const PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Automatically generated password: 16 characters, with easily misread 0 O 1 l I removed */
export function generatePassword(length = 16): string {
  const bytes = new Uint8Array(length * 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    // Rejection sampling, so the first few characters do not get a higher probability
    if (bytes[i] >= 256 - (256 % PW_ALPHABET.length)) continue;
    out += PW_ALPHABET[bytes[i] % PW_ALPHABET.length];
  }
  return out.length === length ? out : generatePassword(length);
}

/** Default creator username: the device name */
export async function defaultCreatorName(): Promise<string> {
  const d = await ensureDevice();
  return (d?.deviceName || tr("Me")).slice(0, 64);
}

/* ---------------- Invite code ---------------- */

/** Origin of the invite link: the public origin given by the server → the online page's own origin → the origin of the document service address */
/**
 * The **document service path** to carry in the invite link (`inviteLinkOf` in `online/invite.ts`): the
 * hosted side is at `/hosted/`, a LAN host is at `/docservice`. The two differ and cannot be inferred from
 * the origin alone, so it is written into the link at issue time.
 *
 * If the server gave `linkOrigin` (the public origin of the hosted side), use the hosted side's path; if
 * not, take its own path from the document service's base
 * --- when placed on this machine, that is `/docservice`.
 */
function docPathOf(given: unknown, base: string): string {
  if (typeof given === "string" && /^https?:\/\//.test(given)) return HOSTED_DOC_PATH;
  let path: string;
  try {
    path = new URL(base).pathname || HOSTED_DOC_PATH;
  } catch {
    return HOSTED_DOC_PATH;
  }
  /*
   * **The trailing slash must be removed** (found by the 2026-10-26 end-to-end probe): the hosted side's
   * `/hosted/` must have the slash (nginx answers 301 for the version without it, and a WebSocket upgrade
   * cannot follow a redirect), while **a LAN host's `/docservice` is the opposite and needs the version
   * without a slash** (see `hostedWsUrlOf` in `online/invite.ts`). The document service's base has a slash
   * here; if it were written into the link as is, the member side would build `ws://host/docservice/`, the
   * handshake would fail, and the UI would only say "Cannot connect to the server".
   */
  if (path === HOSTED_DOC_PATH) return path;
  return path.replace(/\/+$/, "") || "/";
}

function linkOriginOf(given: unknown, base: string): string {
  if (typeof given === "string" && /^https?:\/\//.test(given)) return given;
  if (ONLINE) return location.origin;
  try {
    return new URL(base).origin;
  } catch {
    return location.origin;
  }
}

export type InviteResult = { ok: true; invite: InviteInfo } | { ok: false; error: AdminError };

/** Issue (revoke the old one, issue a new one): needs the creator password on the spot every time */
/**
 * The origin to use in invite links when the project is hosted on this machine: **the host's LAN
 * address**, not the one the creator is connected to right now.
 *
 * The creator usually reaches their own document service over loopback (`http://127.0.0.1:<port>`),
 * and a link built from that origin only opens on this machine: a phone on the LAN would get its own
 * loopback. So we ask which subnets this machine is bound to (`/api/lan-open`, which only answers
 * over loopback, which is fine here) and take the first subnet + the editor's port. With several
 * network adapters we take the first one: if the user is connected through another subnet, the
 * "Open on phone" dialog says so on the spot (`linkOnLan` in `LanOpenDialog`). If the query fails,
 * fall back to deriving it from base, which is no worse than before.
 */
async function lanLinkOrigin(): Promise<string | null> {
  // The online build has no editor process, so no /api/lan-open either. If this branch is not pruned,
  // the endpoint address gets dragged into the online output unconditionally by createInvite()
  // (C10A-API-03 flagged red). ONLINE is a compile-time constant, so the whole block is pruned here.
  if (ONLINE) return null;
  try {
    const r = await fetch("/api/lan-open", { cache: "no-store" });
    if (!r.ok) return null;
    const v = (await r.json()) as { lanHost?: boolean; port?: number | null; addresses?: { address?: string }[] };
    const address = v?.addresses?.[0]?.address;
    if (!v?.lanHost || !address || !v.port) return null;
    return `http://${address}:${v.port}`;
  } catch {
    return null;
  }
}

export async function createInvite(creatorPassword: string): Promise<InviteResult> {
  const s = getSyncView().shared;
  if (!s) return { ok: false, error: "offline" };
  const r = await adminOp("invite-create", { password: creatorPassword });
  if (!r.ok) return r;
  const code = String(r.reply.code ?? "");
  const origin = (s.where === "lan" ? await lanLinkOrigin() : null) ?? linkOriginOf(r.reply.linkOrigin, s.base);
  const invite: InviteInfo = {
    link: inviteLinkOf(origin, code, docPathOf(r.reply.linkOrigin, s.base)),
    expiresAt: Number(r.reply.expiresAt),
    maxUses: typeof r.reply.maxUses === "number" ? r.reply.maxUses : null,
  };
  const prev = localCollab(s.projectId);
  await saveLocal({ ...(prev ?? { projectId: s.projectId, where: s.where, mode: s.mode, name: s.name, creatorUsername: s.username }), invite });
  return { ok: true, invite };
}

export interface InviteStatus {
  active: boolean;
  expiresAt: number | null;
  maxUses: number | null;
  used: number;
  revokedAt: number | null;
}

export async function fetchInviteStatus(creatorPassword: string): Promise<{ ok: true; status: InviteStatus } | { ok: false; error: AdminError }> {
  const r = await adminOp("invite-status", { password: creatorPassword });
  if (!r.ok) return r;
  const m = r.reply;
  return {
    ok: true,
    status: {
      active: m.active === true,
      expiresAt: typeof m.expiresAt === "number" ? m.expiresAt : null,
      maxUses: typeof m.maxUses === "number" ? m.maxUses : null,
      used: Number(m.used) || 0,
      revokedAt: typeof m.revokedAt === "number" ? m.revokedAt : null,
    },
  };
}

/* ---------------- Enable ---------------- */

export interface EnableOptions {
  where: Where;
  mode: SharedMode;
  name: string;
  creator: { username: string; password: string };
  /** Project password for open entry */
  projectPassword?: string;
  /** List for restricted entry */
  list?: { username: string; password: string; access?: "r" | "rw" }[];
  /** Host address (for cloud hosting); if omitted, taken in override order */
  hostedUrl?: string | null;
}

export type EnableError = "offline" | "unreachable" | "name-taken" | "lan-failed";

export async function enableCollab(o: EnableOptions): Promise<{ ok: true; invite: InviteInfo | null } | { ok: false; error: EnableError }> {
  if (o.where === "hosted" && typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, error: "offline" };
  let made: Awaited<ReturnType<typeof route.createSharedProject>>;
  try {
    made = await route.createSharedProject({
      where: o.where,
      name: o.name,
      mode: o.mode,
      creator: o.creator,
      ...(o.mode === "free" ? { password: o.projectPassword } : { list: o.list ?? [] }),
      ...(o.where === "hosted" && o.hostedUrl ? { hostedUrl: o.hostedUrl } : {}),
    });
  } catch (e) {
    const { status, reason } = errorStatus(e);
    console.warn("[collab] Creating the shared project failed:", status, reason, (e as Error)?.message);
    if (status === 409 || reason === "name-taken") return { ok: false, error: "name-taken" };
    return { ok: false, error: o.where === "hosted" ? "unreachable" : "lan-failed" };
  }
  const device = getSyncView().device;
  const entered = await enterShared(
    { where: made.where, base: made.base, projectId: made.projectId, name: made.name, mode: made.mode, service: o.where === "lan" ? hosted.resolveHostedUrl({ ui: o.hostedUrl }) || made.base : made.base, ...(o.where === "lan" ? { hostDeviceName: device?.deviceName } : {}) },
    { as: "creator", username: o.creator.username, password: o.creator.password },
    { initialize: true },
  );
  if (!entered.ok) {
    console.warn("[collab] Entering as the creator failed:", entered.error);
    return { ok: false, error: o.where === "hosted" ? "unreachable" : "lan-failed" };
  }
  if (o.where === "lan") {
    const descriptor = getSyncView().association;
    if (descriptor) await recoveryRequest("activate-host", descriptor);
  }
  await saveLocal({
    projectId: made.projectId,
    where: made.where,
    mode: made.mode,
    name: made.name,
    creatorUsername: o.creator.username,
    creatorPassword: o.creator.password,
    ...(o.mode === "free" ? { projectPassword: o.projectPassword } : {}),
    invite: null,
  });
  if (o.where !== "hosted") {
    /*
     * A project hosted on this machine also signs an invite link (added on 2026-10-26 when the user
     * decided on "the whole LAN shared project set"): phones and tablets on the LAN can join by
     * scanning the code (`product/platforms.md`, "The second screen on the LAN"). The link origin comes
     * from the document service's base via `linkOriginOf`: when the host starts with
     * `PROMPTCUT_LAN_HOST=1`, that is its LAN address.
     * If signing fails we only lose the link (project name + passphrase still work for joining), so it
     * does not block enabling.
     */
    const lanInvite = await createInvite(o.creator.password);
    return { ok: true, invite: lanInvite.ok ? lanInvite.invite : null };
  }
  /*
   * Assets already in the project before enabling must also go to the cloud (C10a integration rework):
   * wait until the editor process has the hosted side's asset service and the rw ticket (the upload
   * target set by connectSharedAssets when entering the shared project), then hand them to the upload
   * queue by hash, and from then on follow the upload queue's rules (small sizes of all assets first,
   * then the original sizes).
   * Does not block enabling: upload progress is managed by the upload queue, and missing ones (not in
   * the local content store) are logged.
   */
  void queueExistingMedia();
  const inv = await createInvite(o.creator.password);
  // The project is already created and entered; if the invite code was not signed we only lose the link, and in settings the user can click "Revoke and regenerate" again
  return { ok: true, invite: inv.ok ? inv.invite : null };
}

/**
 * After enabling "host in the cloud", hand the assets already in the project to the upload queue:
 * first add old assets that have no hash but whose bytes this machine can still get to the library
 * (`ingestUnhashedMedia`, which writes back to the asset table and syncs to the document service),
 * then enqueue by hash. Those that cannot be added and are not in the local content store cannot be
 * uploaded, so other members cannot get them: list the names of these assets to the user in a bubble
 * (the console line does not count as notifying).
 * Returns the number handed to the queue and the names that could not be uploaded (the account
 * method's "Move to the cloud" `accountMoveFlow.ts` uses it too); returns null if nothing was handed over.
 */
export async function queueExistingMedia(): Promise<{ queued: number; missing: string[] } | null> {
  if (ONLINE) return null;
  try { await ingestUnhashedMedia(); } catch (e) { console.warn("[collab] Backfilling into the store did not finish:", (e as Error)?.message); }
  const media = getState().project.media ?? [];
  const r = await enqueueExistingMedia(media, { post: postEnqueue });
  if (!r) { console.warn("[collab] Existing media was not handed to the upload queue (no upload target available, or no local editor)"); return null; }
  const nameOfHash = new Map<string, string>();
  for (const m of media) {
    const h = String(m.tiers?.original || m.hash || "").toLowerCase();
    if (h && !nameOfHash.has(h)) nameOfHash.set(h, m.name);
  }
  const names = [
    ...(r.skipped ?? []).filter((s) => !s.pending).map((s) => s.name),
    ...r.missing.map((h) => nameOfHash.get(String(h).toLowerCase()) ?? String(h)),
  ];
  if (!names.length) return { queued: r.queued.length, missing: [] };
  console.warn("[collab] These assets could not be uploaded:", names);
  pushToast(uploadMissingMessage(names), "warn", Infinity);
  return { queued: r.queued.length, missing: names };
}

/** Assets that could not be uploaded when hosting in the cloud: the message for the user (names deduplicated, only the first several listed when there are too many) */
export function uploadMissingMessage(names: readonly string[], limit = 8): string {
// i18n-allow: names in older projects carry the Chinese marker
  const uniq = [...new Set(names.map((n) => String(n || "").replace(/^\((?:missing|缺失)\) /, "")).filter(Boolean))];
  const shown = uniq.slice(0, limit).join(tr(", "));
  const more = uniq.length > limit ? tr(" and {0} more", uniq.length) : "";
  return tr("These media files were not found on this machine and were not uploaded to the cloud, so other members cannot see them: {0}{1}", shown, more);
}

/**
 * The editor process's "enqueue by hash" (`server/vite-plugin-media.ts`). In the online build `ONLINE`
 * is the constant true, and this branch is pruned together with the endpoint address (the online
 * page has no editor process; it also never reaches enabling cloud hosting, which is done in the
 * desktop app).
 */
export const postEnqueue = ONLINE ? null : async (body: unknown): Promise<EnqueueExistingResult | null> => {
  try {
    const r = await fetch("/api/media/upload-queue/enqueue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json()) as { ok?: boolean } & EnqueueExistingResult;
    return j?.ok ? { queued: j.queued ?? [], missing: j.missing ?? [], local: !!j.local } : null;
  } catch {
    return null;
  }
};

/* ---------------- Cancel ---------------- */

export type DisableError = "forbidden" | "rate-limited" | "pull-failed" | "offline" | "online-page";

/** Pull back the original-size assets: hand them to the editor process's prefetch queue and poll the local content store until all arrive; no progress for one minute counts as failure */
export async function pullOriginals(hashes: string[], onProgress?: (done: number, total: number) => void): Promise<boolean> {
  if (ONLINE) return false; // The online page has no local media library
  if (!hashes.length) return true;
  try {
    const r = await fetch("/api/media/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: hashes.map((hash) => ({ hash })) }) });
    if (!r.ok) return false;
  } catch {
    return false;
  }
  let have = new Set<string>();
  let lastProgress = Date.now();
  for (;;) {
    const got = new Set<string>();
    for (let i = 0; i < hashes.length; i += 40) {
      const part = hashes.slice(i, i + 40);
      try {
        const r = await fetch(`/api/media/local?hashes=${part.join(",")}`, { cache: "no-store" });
        const j = (await r.json()) as { hashes?: string[] };
        for (const h of j.hashes ?? []) got.add(h);
      } catch {
        /* No answer this round: ask again next round */
      }
    }
    if (got.size > have.size) lastProgress = Date.now();
    have = got;
    onProgress?.(have.size, hashes.length);
    if (have.size >= hashes.length) return true;
    if (Date.now() - lastProgress > 60_000) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Cancel multi-user collaboration (creator): verify the creator password → if hosted in the cloud,
 * first pull the project itself and the original-size assets back to this machine → `delete` →
 * return to the local space.
 * If it fails before deletion, collaboration stays enabled; once the service deletion succeeds, even
 * if writing the local deregistration record fails, it must not be reported as the room still existing.
 */
export async function disableCollab(creatorPassword: string, onProgress?: (done: number, total: number) => void): Promise<{ ok: true } | { ok: false; error: DisableError }> {
  const s = getSyncView().shared;
  if (!s) return { ok: false, error: "offline" };
  if (ONLINE) return { ok: false, error: "online-page" };
  // First verify the creator password once (no side effects), to avoid a wasted pull
  const check = await adminOp("list-bans", { password: creatorPassword });
  if (!check.ok) return { ok: false, error: check.error === "rate-limited" ? "rate-limited" : check.error === "offline" ? "offline" : "forbidden" };
  try {
    await whenSaved(10_000);
  } catch {
    return { ok: false, error: "pull-failed" };
  }
  const project = structuredClone(getState().project);
  if (s.where === "hosted") {
    const hashes = [...new Set((project.media ?? []).map((m) => originalHashOf(m)).filter((h): h is string => !!h))];
    if (!(await pullOriginals(hashes, onProgress))) return { ok: false, error: "pull-failed" };
  }
  expectSharedClose(true);
  const del = await adminOp("delete", { key: check.key });
  if (!del.ok) {
    expectSharedClose(false);
    return { ok: false, error: del.error === "rate-limited" ? "rate-limited" : del.error === "forbidden" ? "forbidden" : "pull-failed" };
  }
  dropLocal(s.projectId);
  // What gets pulled back to this machine is what the page holds at the moment the deletion lands, not
  // the copy made before acting above: changes the room accepted between the copy and the deletion
  // landing (other members', and our own not yet confirmed) all reached the page on the same
  // connection before the deletion's reply, and using the earlier copy would lose them
  const final = structuredClone(getState().project);
  const descriptor = getSyncView().association;
  if (descriptor) {
    try { await recoveryRequest("revoke", descriptor); }
    catch { pushToast(tr("The room was deleted, but the local deregistration record could not be saved. Keep the project and check the disk; the old room will not be recreated."), "warn", Infinity); }
  }
  leaveSharedToLocal(final);
  return { ok: true };
}

/** The creator changed the password in the member popover or in settings: the copy recorded on this machine follows (not recorded on devices where it was never enabled) */
export async function rememberPasswords(projectId: string, p: { creatorPassword?: string; projectPassword?: string }) {
  const prev = localCollab(projectId);
  if (!prev) return;
  await saveLocal({ ...prev, ...p });
}
