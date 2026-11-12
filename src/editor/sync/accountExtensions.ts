/**
 * Website account and project member seams (public-side extension registry, see
 * `docs/plan/community-boundary.md`).
 *
 * Two patterns:
 * 1. **Replacement seams (member source `MemberSource`, join source `JoinSource`)**:
 *    - The public-side default implementation uses LAN shared projects (`server/auth/` project
 *      password/ticket/invite code + `server/lan/` discovery + `src/editor/sync/` real-time member sync);
 *    - The cloud implementation (`cloud/account/ui-manifest.tsx`) registers at startup and takes over the
 *      `accountId` branch; non-account projects still fall back to the LAN implementation.
 * 2. **Cross-cutting and optional extension slots (`AccountExtensions`)**:
 *    - Upload-rejected text, project link assembly, the account client factory (`createAccountClient`),
 *      and the account entry components of the start page and collaboration settings.
 *    - Without `cloud/account/` installed it runs with the community edition default policy, with no
 *      error and no crash.
 *
 * This module is the only load point allowed to optionally load `cloud/account/manifest.ts`; public-side
 * business files only import this module, and do not import `cloud/` or `src/account/` directly.
 */
import type { JSX } from "react";

import type { JoinRequestStatus } from "./joinRequestText.ts";
import { tr } from "../../i18n/index.ts";

export const MEMBERS_POLL_OPEN_MS = 3000;
export const MEMBERS_POLL_CLOSED_MS = 15_000;

export const GUEST_LIMITS = Object.freeze({
  projects: 1,
  conversations: 1,
  videos: 3,
  assetMB: 100,
  ttlDays: 3,
} as const);

export const GUEST_LIMITS_TEXT =
  tr("Guests can create {0} cloud projects, start {1} AI chats, ", GUEST_LIMITS.projects, GUEST_LIMITS.conversations) +
  tr("upload {0} videos (each ≤ {1} MB), and projects and media are kept for {2} days; ", GUEST_LIMITS.videos, GUEST_LIMITS.assetMB, GUEST_LIMITS.ttlDays) +
  tr("You can only view other people's projects. After you sign up or log in, the current guest project and chats will be moved to your account.");

export const GUEST_CHAT_LIMIT_TEXT = tr("Guests can open at most 1 chat. Sign up or log in to create more chats.");

export interface Account {
  id: string;
  name: string;
  email?: string | null;
}

export interface GuestLogin {
  id: string;
  name: string;
  token: string;
  expiresAt: number;
}

export interface GuestSavedProject {
  id: string;
  name: string;
}

export interface ThirdPartyProvider {
  provider: "google";
  clientId: string;
}

export type ThirdPartyLogin =
  | { kind: "signed-in"; account: Account }
  | { kind: "need-name"; ticket: string; email: string | null };

export interface CloudAgentConsent {
  accountId: string;
  accepted: boolean;
  noticeVersion: 1;
  acceptedAt?: number;
}

export interface CloudProject {
  projectId: string;
  name: string;
  authorityId: string;
  creatorAccountId?: string;
  url?: string;
}

export interface ProjectLists {
  owned: CloudProject[];
  joined: CloudProject[];
}

export interface ProjectSession {
  connectionTicket: string;
  assetTicket: string;
  agentDelegationTicket: string;
  expiresAt: number;
  projectId: string;
  creator: boolean;
  access: "r" | "rw";
  accessRevision: number;
  hosted: {
    agent: { available: boolean; enabled: boolean; url: string | null };
    render?: { available: boolean; enabled: boolean; streams?: boolean; streamsAllowed?: boolean };
  };
  linkToken?: string;
  hasSecondaryPassword?: boolean;
  needsSecondaryPassword?: boolean;
}

export interface AccountJoinRequestRow {
  accountId: string;
  joinRequestId: string;
  accountName: string | null;
  createdAt: number;
}

export interface AccountMembersSnapshot {
  v: 2;
  authorityId: string;
  projectId: string;
  accessRevision: number;
  self: { accountId: string; creator: boolean; access: "r" | "rw" };
  creatorAccountId: string;
  allowLinkJoin: boolean;
  members: { accountId: string; accountName: string | null; access: "r" | "rw"; joinedAt: number | null }[];
  devices: {
    accountId: string;
    accountName: string | null;
    deviceId: string;
    deviceName: string;
    creator: boolean;
    conns: { role: "page" | "agent" | "render"; service?: "agent" | "render"; conversation?: string | number }[];
  }[];
  bans?: { accountId: string; accountName: string | null; reason: "kick" }[];
  requests?: AccountJoinRequestRow[];
}

export interface AccountKickOperation {
  op: "kick" | "unban";
  accountId: string;
  expectedAccessRevision: number;
  requestId: string;
}

export interface AccountEntryOperation {
  op: "set-entry";
  allowLinkJoin: boolean;
  expectedAccessRevision: number;
  requestId: string;
}

export interface AccountJoinDecision {
  op: "approve-join" | "reject-join";
  accountId: string;
  joinRequestId: string;
  requestId: string;
}

export type AccountMemberOperation = AccountKickOperation | AccountEntryOperation | AccountJoinDecision;

export type AccountMemberResult =
  | { eventId: string; accessRevision: number; completed: false; state: "pending-services" }
  | { joinRequest: { accountId: string; joinRequestId: string; state: "approved" | "rejected" }; accessRevision: number };

export interface AccountClientOptions {
  online: boolean;
  origin: string;
  device: { deviceId: string; deviceName: string };
  fetch?: typeof fetch;
  native?: (operation: string, args?: Record<string, unknown>) => Promise<unknown>;
  now?: () => number;
}

export interface CloudAccountClient {
  readonly account: Account | null;
  readonly principal: Account | null;
  readonly guest: GuestLogin | null;
  readonly authVersion: number;
  enterAsGuest(): Promise<GuestLogin>;
  newGuest(): Promise<GuestLogin>;
  leaveGuest(): void;
  subscribeAuth(listener: () => void): () => void;
  restore(): Promise<Account | null>;
  login(identifier: string, password: string, remember: boolean, requestId?: string): Promise<Account>;
  thirdPartyProviders(): Promise<ThirdPartyProvider[]>;
  loginWithThirdParty(provider: string, token: string, remember: boolean): Promise<ThirdPartyLogin>;
  registerWithThirdParty(ticket: string, name: string, remember: boolean): Promise<Account>;
  /**
   * Email sign-up, done as the account service's existing steps (it has no email-only registration;
   * issue #2, 2026-11-03): first `register` (`POST /api/account/register {name,password}`, which also
   * signs in, like `login`), then `startEmail` (`POST /api/account/email/start {email,password}`, sends a
   * code), then `confirmEmail` (`POST /api/account/email/confirm {code}`).
   * **Optional**: a client without `register` makes the login dialog hide "Sign up with email".
   * A failure throws an Error whose `code` is the service's error code (`name-taken`, `email-taken`,
   * `bad-code`, `mail-off`…) and whose `message` is the service's own text; the dialog maps the code to
   * interface text and falls back to the message (`src/start/accountErrors.ts`).
   */
  register?(name: string, password: string): Promise<Account>;
  startEmail?(email: string, password: string): Promise<void>;
  confirmEmail?(code: string): Promise<void>;
  logout(): Promise<void>;
  cloudAgentConsent(): Promise<CloudAgentConsent>;
  acceptCloudAgentConsent(requestId?: string): Promise<CloudAgentConsent>;
  getStartOrg(): Promise<{ version: number; org: unknown | null; updatedAt: number }>;
  putStartOrg(
    baseVersion: number,
    org: unknown,
  ): Promise<
    | { conflict: false; version: number; org: unknown; updatedAt: number }
    | { conflict: true; version: number; org: unknown | null; updatedAt: number }
  >;
  lists(): Promise<ProjectLists>;
  create(
    name: string,
    initialProject: unknown,
    requestId: string,
    opts?: { projectId?: string; rev?: number; history?: unknown[] },
  ): Promise<{ projectId: string; authorityId: string }>;
  regenProjectLink(
    projectId: string,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; linkToken: string }>;
  deleteProject(
    projectId: string,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number }>;
  setSecondaryPassword(
    projectId: string,
    password: string | null,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; hasSecondaryPassword: boolean }>;
  setAgentEnabled(
    projectId: string,
    enabled: boolean,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; completed: false }>;
  setHostedService(
    projectId: string,
    service: "agent" | "render",
    enabled: boolean,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; completed: false }>;
  setHostedOption(
    projectId: string,
    service: "render",
    option: "streams",
    enabled: boolean,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; completed: false }>;
  members(projectId: string): Promise<AccountMembersSnapshot>;
  memberAdmin(projectId: string, operation: AccountMemberOperation): Promise<AccountMemberResult>;
  joinRequestStatus(projectId: string): Promise<JoinRequestStatus>;
  sendJoinRequest(projectId: string, requestId: string): Promise<JoinRequestStatus>;
  join(
    projectId: string,
    requestId: string,
    joinOpts?: { token?: string; linkToken?: string; secondaryPassword?: string },
  ): Promise<ProjectSession>;
  session(projectId: string, opts?: { minRemainingMs?: number }): Promise<ProjectSession>;
}

/** Replacement seam: project member source (shared by desktop `MembersPanel.tsx`, mobile `useMembers.ts` and `sheets.tsx`) */
export interface MemberSource {
  readonly kind: "lan" | "account";
  /** Member popover dedicated to "cloud account projects" in the desktop top bar; if unregistered or for LAN projects, the public-side `LegacyMembersButton` is used */
  readonly DesktopAccountPanel?: () => JSX.Element | null;
  /** Read the snapshot of the current shared project's members (returns `null` on failure or offline) */
  fetchMembers(): Promise<AccountMembersSnapshot | null>;
  /** Member management actions (kick, unban, change entry mode, approve join requests) */
  memberAdmin(operation: AccountMemberOperation): Promise<AccountMemberResult>;
  /** Remove a member from a LAN/password collaboration project (with the creator password or a delegation ticket) */
  kickLanMember?(
    row: { username: string; deviceId: string | null },
    auth: { password?: string; key?: string },
  ): Promise<{ ok: true; key: string } | { ok: false; error: string }>;
  /** Issue an invite link for a LAN/password shared project */
  createInvite?(
    creatorPassword: string,
  ): Promise<{ ok: true; link: string; expiresAt: number; maxUses: number | null } | { ok: false; error: string }>;
}

export interface LanInviteResolution {
  ok: true;
  base: string;
  code: string;
  projectId: string;
  name: string;
  mode: "free" | "restricted";
}

/** Replacement seam: join-shared-project source (the public-side default uses LAN invite codes and handshake; the cloud uses website account project joining) */
export interface JoinSource {
  readonly kind: "lan" | "account";
  /** Parse and verify a LAN invite link (`#invite=<43 chars>&doc=<path>`) */
  resolveLanInvite(rawLink: string): Promise<LanInviteResolution | { ok: false; error: string }>;
  /** Redeem a LAN invite code with a user name (and optional password) and handshake into the shared project */
  joinLanByInvite(params: {
    base: string;
    code: string;
    username: string;
    password?: string;
  }): Promise<{ ok: true; projectId: string } | { ok: false; error: string }>;
}

export interface AccountProjectsHookResult {
  origin: string;
  account: Account | null;
  orgApi: {
    getStartOrg(): Promise<{ version: number; org: unknown | null; updatedAt: number }>;
    putStartOrg(
      baseVersion: number,
      org: unknown,
    ): Promise<
      | { conflict: false; version: number; org: unknown; updatedAt: number }
      | { conflict: true; version: number; org: unknown | null; updatedAt: number }
    >;
  } | null;
  busy: boolean;
  error: string;
  setError: (v: string) => void;
  shellOld: boolean;
  link: string;
  setLink: (v: string) => void;
  lists: ProjectLists | null;
  listError: string;
  refreshLists: () => Promise<void>;
  perform: (action: () => Promise<void>) => Promise<void>;
  enter: (projectId: string, name?: string, initial?: ProjectSession) => Promise<void>;
  open: (projectId: string, name?: string) => Promise<"ok" | "secondary-required" | "failed">;
  login: (name: string, password: string, remember: boolean) => Promise<void>;
  adoptSession: () => Promise<boolean>;
  logout: () => Promise<void>;
  create: (name: string) => Promise<void>;
  join: (raw?: string, secondaryPassword?: string) => Promise<"ok" | "not-listed" | "secondary-required" | "bad-secondary" | "expired">;
  guest: GuestLogin | null;
  guestProject: GuestSavedProject | null;
  enterAsGuest: () => Promise<boolean>;
  newGuest: () => Promise<boolean>;
  leaveGuest: () => void;
  openGuestProject: () => Promise<void>;
  request: JoinRequestStatus | null;
  sendRequest: () => Promise<void>;
  clearRequest: () => void;
  directSecondary: { projectId: string; link: string } | null;
  clearDirectSecondary: () => void;
  peekSession: (projectId: string) => Promise<ProjectSession>;
  projectLink: typeof projectLink;
}

export interface AccountExtensions {
  formatUploadError?: (code: string) => string;
  projectLink?: (origin: string, projectId: string, linkToken?: string) => string;
  createAccountClient?: (options: AccountClientOptions) => CloudAccountClient;
  useAccountProjects?: (opts: { online: boolean; onEnterEditor: () => void }) => AccountProjectsHookResult;
  AccountEntryOption?: (props: { disabled?: boolean }) => JSX.Element | null;
  AccountProjects?: (props: { online: boolean; onEnterEditor: () => void }) => JSX.Element | null;
  MobileAccountStart?: (props: { onEnterEditor: () => void }) => JSX.Element;
}

/* ---------------- Default implementation and state ---------------- */

const DEFAULT_MEMBER_SOURCE: MemberSource = {
  kind: "lan",
  async fetchMembers() {
    return null;
  },
  async memberAdmin() {
    throw new Error(tr("Website account member management is not enabled for the current project"));
  },
};

const DEFAULT_JOIN_SOURCE: JoinSource = {
  kind: "lan",
  async resolveLanInvite() {
    return { ok: false, error: tr("Can't reach the server. Please try again later.") };
  },
  async joinLanByInvite() {
    return { ok: false, error: tr("Can't reach the server. Please try again later.") };
  },
};

let defaultLanMemberSource: MemberSource = DEFAULT_MEMBER_SOURCE;
let activeMemberSource: MemberSource = DEFAULT_MEMBER_SOURCE;
let defaultLanJoinSource: JoinSource = DEFAULT_JOIN_SOURCE;
let activeJoinSource: JoinSource = DEFAULT_JOIN_SOURCE;
let currentExtensions: AccountExtensions = {};

const listeners = new Set<() => void>();
function notifyListeners() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* An error in a single subscriber does not affect the other subscribers */
    }
  }
}

export function subscribeAccountExtensions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The public-side LAN member source registers as the default implementation at module initialization */
export function setDefaultLanMemberSource(source: MemberSource): void {
  defaultLanMemberSource = source;
  if (activeMemberSource === DEFAULT_MEMBER_SOURCE || activeMemberSource.kind === "lan") {
    activeMemberSource = source;
    notifyListeners();
  }
}

export function getDefaultLanMemberSource(): MemberSource {
  return defaultLanMemberSource;
}

export function registerMemberSource(source: MemberSource): void {
  if (!source || typeof source.fetchMembers !== "function" || typeof source.memberAdmin !== "function") {
    throw new Error("registerMemberSource requires fetchMembers and memberAdmin functions");
  }
  activeMemberSource = source;
  notifyListeners();
}

export function getMemberSource(): MemberSource {
  return activeMemberSource;
}

export function resetMemberSource(): void {
  activeMemberSource = defaultLanMemberSource;
  notifyListeners();
}

/** The public-side LAN join source registers as the default implementation at module initialization */
export function setDefaultLanJoinSource(source: JoinSource): void {
  defaultLanJoinSource = source;
  if (activeJoinSource === DEFAULT_JOIN_SOURCE || activeJoinSource.kind === "lan") {
    activeJoinSource = source;
    notifyListeners();
  }
}

export function getDefaultLanJoinSource(): JoinSource {
  return defaultLanJoinSource;
}

export function registerJoinSource(source: JoinSource): void {
  if (!source || typeof source.resolveLanInvite !== "function" || typeof source.joinLanByInvite !== "function") {
    throw new Error("registerJoinSource requires resolveLanInvite and joinLanByInvite functions");
  }
  activeJoinSource = source;
  notifyListeners();
}

export function getJoinSource(): JoinSource {
  return activeJoinSource;
}

export function resetJoinSource(): void {
  activeJoinSource = defaultLanJoinSource;
  notifyListeners();
}

export function registerAccountExtensions(ext: Partial<AccountExtensions>): void {
  currentExtensions = { ...currentExtensions, ...ext };
  notifyListeners();
}

export function getAccountExtensions(): Readonly<AccountExtensions> {
  return currentExtensions;
}

export function resetAccountExtensions(): void {
  currentExtensions = {};
  activeMemberSource = defaultLanMemberSource;
  activeJoinSource = defaultLanJoinSource;
  notifyListeners();
}

/* ---------------- Cross-cutting convenience entry points (with a default fallback) ---------------- */

const DEFAULT_UPLOAD_REFUSAL_TEXT: Record<string, string> = {
  "guest-file-too-large": tr("Each source file uploaded by a guest cannot exceed {0} MB.", GUEST_LIMITS.assetMB),
  "guest-video-limit": tr("Guests can upload at most {0} videos. To upload more, please sign up for an account.", GUEST_LIMITS.videos),
  "guest-read-only": tr("You can only view this project, you cannot change its content."),
};

/**
 * Cross-cutting seam: the reason given when an asset upload is permanently rejected.
 * When the cloud is registered it goes through `accountErrorText`; when unregistered (community edition
 * or a standalone unit test) it uses the built-in fallback text.
 */
export function formatUploadRejectionReason(code: string): string {
  if (currentExtensions.formatUploadError) return currentExtensions.formatUploadError(code);
  return DEFAULT_UPLOAD_REFUSAL_TEXT[code] ?? tr("Request failed ({0})", code || "unknown");
}

/** Project link assembly (`<origin>/p/<id>` or `<origin>/s/<id>/<linkToken>`) */
export function projectLink(origin: string, projectId: string, linkToken?: string): string {
  if (currentExtensions.projectLink) return currentExtensions.projectLink(origin, projectId, linkToken);
  return new URL(linkToken ? `/editor/s/${projectId}/${linkToken}` : `/editor/p/${projectId}`, new URL(origin).origin).toString();
}

function createFallbackAccountClient(options: AccountClientOptions): CloudAccountClient {
  const cleanOrigin = new URL(options.origin).origin;
  const unavailable = async (): Promise<never> => {
    const err = new Error(tr("The website account extension is not installed in this version")) as Error & { status?: number; code?: string };
    err.status = 501;
    err.code = "not-account-cloud";
    throw err;
  };
  return {
    account: null,
    principal: null,
    guest: null,
    authVersion: 0,
    enterAsGuest: unavailable,
    newGuest: unavailable,
    leaveGuest: () => {},
    subscribeAuth: () => () => {},
    restore: async () => null,
    login: unavailable,
    thirdPartyProviders: async () => [],
    loginWithThirdParty: unavailable,
    registerWithThirdParty: unavailable,
    logout: async () => {},
    cloudAgentConsent: unavailable,
    acceptCloudAgentConsent: unavailable,
    getStartOrg: unavailable,
    putStartOrg: unavailable,
    lists: unavailable,
    create: unavailable,
    regenProjectLink: unavailable,
    deleteProject: unavailable,
    setSecondaryPassword: unavailable,
    setAgentEnabled: unavailable,
    setHostedService: unavailable,
    setHostedOption: unavailable,
    members: unavailable,
    memberAdmin: unavailable,
    joinRequestStatus: unavailable,
    sendJoinRequest: unavailable,
    join: unavailable,
    session: unavailable,
  };
}

export function createAccountClient(options: AccountClientOptions): CloudAccountClient {
  return currentExtensions.createAccountClient
    ? currentExtensions.createAccountClient(options)
    : createFallbackAccountClient(options);
}

/* ---------------- Optional load point (the only place that dynamically loads cloud/account/) ---------------- */

// The cloud extension package goes through an **alias**, resolved by `server/vite-plugin-cloud-seams.ts` at build time to the closed-source directory or an empty stub.
// What was written here before was a dynamic import of `new URL("../../../<closed-source dir>/account/manifest.ts", import.meta.url)` plus
// `@vite-ignore`, with three problems: ① a public file assembling a closed-source path (G1 flagged red);
// ② no equivalent of PROMPTCUT_CLOUD_DIR, so under the submodule layout the relative path points to `community/` instead of the private root,
//    silently missing, and since the private repository has all the files nobody noticed; ③ `.ts` does not go into the output, and `@vite-ignore` makes Vite not resolve it,
//    so it could never be loaded in the official build. The specifiers of the two imports below must be **literals** for Vite to resolve them.

function isModuleNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const msg = String((err as { message?: unknown }).message ?? "");
  // ERR_PACKAGE_IMPORT_NOT_DEFINED: when Node runs this file directly (unit tests, server) there is no Vite alias table,
  // and `#promptcut-cloud-*` failing to resolve gives this code. That is exactly "cloud extension not installed", not an error.
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_IMPORT_NOT_DEFINED") return true;
  return (
    msg.includes("Cannot find module") ||
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Failed to load module script") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("Does the file exist")
  );
}

let coreLoadPromise: Promise<boolean> | null = null;
let uiLoadPromise: Promise<boolean> | null = null;

/**
 * Try to load `cloud/account/manifest.ts` (and, in a browser environment,
 * `cloud/account/ui-manifest.tsx`). When the community edition moves `cloud/` away, catch
 * MODULE_NOT_FOUND and return `false`, so the default LAN implementation keeps running.
 */
export async function loadAccountExtensions(opts: { manifestUrl?: string; includeUi?: boolean } = {}): Promise<boolean> {
  if (opts.manifestUrl) {
    try {
      const mod = (await import(/* @vite-ignore */ opts.manifestUrl)) as { register?: () => Promise<void> | void };
      if (typeof mod.register === "function") await mod.register();
      return true;
    } catch (err) {
      if (isModuleNotFound(err)) return false;
      throw err;
    }
  }

  if (!coreLoadPromise) {
    coreLoadPromise = (async () => {
      try {
        const mod = (await import("#promptcut-cloud-account")) as { register?: () => Promise<void> | void };
        // The empty stub exports nothing, so "installed" is decided by whether `register` exists, not by whether the import succeeded
        if (typeof mod.register !== "function") return false;
        await mod.register();
        return true;
      } catch (err) {
        if (isModuleNotFound(err)) return false;
        throw err;
      }
    })();
  }

  const coreLoaded = await coreLoadPromise;
  const wantUi = opts.includeUi ?? typeof document !== "undefined";
  if (coreLoaded && wantUi) {
    if (!uiLoadPromise) {
      uiLoadPromise = (async () => {
        try {
          const uiMod = (await import("#promptcut-cloud-account-ui")) as { registerUi?: () => Promise<void> | void };
          if (typeof uiMod.registerUi !== "function") return false;
          await uiMod.registerUi();
          return true;
        } catch (err) {
          if (isModuleNotFound(err)) return false;
          // A Node environment (e.g. a plain Node test that skips Vite's JSX transform) cannot resolve .tsx, so silently skip the UI extension
          if (err instanceof SyntaxError || String((err as Error)?.message ?? "").includes("Unexpected token")) {
            return false;
          }
          throw err;
        }
      })();
    }
    await uiLoadPromise;
  }
  return coreLoaded;
}

// Warm up the core seam asynchronously on module import (non-blocking; a failure is silently treated as no extension installed)
void loadAccountExtensions({ includeUi: typeof document !== "undefined" }).catch(() => false);
