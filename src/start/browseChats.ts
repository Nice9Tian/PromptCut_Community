/**
 * What to list under a cloud project that is "expanded but not opened" (issue #15).
 *
 * The Vibe mode sidebar used to be able to list chats only for the project **currently connected**: chats
 * are requested from that project's Cloud Agent service using that project's identity, and globally only
 * one project can be connected, so clicking a second project made the first collapse back. Here we open a
 * **read-only** path for projects that are not connected:
 *
 *   1. Fetch a session once from this project's document service (`client.session`, the same
 *      `/hosted/shared/account/session` used when entering a project), and take its Cloud Agent
 *      delegation ticket and address: **no document connection is opened and the project open in the
 *      editor is untouched**;
 *   2. With that ticket, `GET /conversations`, then re-check by shared / private (`viewableChats` in
 *      `vibeOrg.ts`); other people's private chats are not listed.
 *
 * The pacing is deliberately conservative: fetch only when the user opens that branch, and what was
 * fetched is not fetched again within `BROWSE_TTL_MS`; returning the page to the foreground or a refresh
 * does not refetch automatically. A ticket lives only five minutes, and each session fetch makes the
 * server sign three tickets, so someone with ten projects expanded would trigger ten signings on every
 * refresh: not worth it.
 *
 * The browse state is **read-only**: the listed chats can only be clicked into (which connects that
 * project); rename, pin, archive and delete are not done here:
 * deleting a chat goes through the Agent service of the project currently connected, and pin and archive
 * are written under the "currently open project", so doing them in the browse state would land on a
 * different project.
 * Which items are greyed out and what they say is in `ops.blocked` of `OnlineStart.tsx`.
 *
 * This file does not import React (the React layer is in `OnlineStart.tsx`, subscribing with
 * `useSyncExternalStore`), so Node unit tests can use it directly.
 */
import { CloudError, ONLINE_AGENT_PATH, getAiCloudProvider } from "../ai/extensions.ts";
import { viewableChats } from "./vibeOrg.ts";
import type { VibeChat } from "./types.ts";
import { tr } from "../i18n/index.ts";

/** The few fields of the session reply needed to list chats (structural type, no direct dependency on `src/account/client.ts`) */
export interface BrowseSession {
  agentDelegationTicket: string;
  creator: boolean;
  hosted?: {
    agent?: { available: boolean; enabled?: boolean; url: string | null } | null;
  } | null;
}

function isAccountFailure(error: unknown): error is Error & { status: number; code: string } {
  return (
    error instanceof Error &&
    !(error instanceof CloudError) &&
    typeof (error as { status?: unknown }).status === "number" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

/** How long the fetched chat list is not refetched (milliseconds). The ticket itself lives five minutes; this number must be smaller than that */
export const BROWSE_TTL_MS = 180_000;

/** What one "expanded but not opened" project in the sidebar looks like right now */
export interface BrowseEntry {
  state: "loading" | "ready" | "error";
  /** Chats already re-checked by shared / private; empty until fetched */
  chats: VibeChat[];
  /** The line of text written under this branch (fetching, cannot fetch, this project has no Cloud Agent, needs a secondary password…); not written if none */
  note?: string;
  /** Whether to show "Retry" after that line */
  retry?: boolean;
  /** When this copy was fetched (`now()`); 0 if never fetched */
  at: number;
}

export interface BrowseDeps {
  /** Fetch this project's session once (`peekSession` of `useAccountProjects`) */
  session: (projectId: string) => Promise<BrowseSession>;
  /** Who is viewing right now (the id of the account or guest); needed to re-check private chats */
  viewer: () => { accountId: string | null };
  /** Same-origin address of the online page; used to build the Agent address when the document service does not report one (same rule as `resolveCloudAgent`) */
  origin?: () => string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export type BrowseState = Readonly<Record<string, BrowseEntry>>;

/**
 * Where this project's Cloud Agent is. Same rule as `resolveCloudAgent` in `endpoint.ts` (the online
 * branch): if the document service says there is none, there is none; if it says there is one but gives
 * no address, build it from the page's same origin
 */
export function agentBaseOf(hosted: BrowseSession["hosted"], origin: string): { url: string | null; note?: string } {
  const agent = hosted?.agent;
  if (!agent?.available) return { url: null, note: tr("The cloud hosting this project has no Agent service, so chats cannot be listed.") };
  if (agent.enabled === false) return { url: null, note: tr("The project creator turned off the Cloud Agent, so chats cannot be listed here.") };
  const url = agent.url ? agent.url.replace(/\/+$/, "") : `${origin}${ONLINE_AGENT_PATH}`;
  return { url };
}

/** Which line to write underneath when the fetch fails, and whether to give "Retry". Only give it for what can retry by itself (network, service temporarily unavailable), not where the user has to do something else */
export function browseNoteOf(error: unknown): { note: string; retry: boolean } {
  if (isAccountFailure(error)) {
    // Needs this project's secondary password, no longer on the list, on the ban list, project gone: retrying any number of times is the same, so tell them what to do
    if (error.code === "secondary-password-required") return { note: tr("This project requires the project secondary password first: click the project name to open it and follow the prompt."), retry: false };
    if (["not-listed", "banned", "no-project", "project-gone"].includes(error.code)) return { note: error.message, retry: false };
    if (error.status === 401) return { note: error.message, retry: false };
    return { note: error.message, retry: true };
  }
  if (error instanceof CloudError) {
    if (error.code === "disabled") return { note: tr("The project creator turned off the Cloud Agent, so chats cannot be listed here."), retry: false };
    if (error.code === "unauthorized" || error.code === "forbidden") return { note: tr("You do not have permission to read this project's chats."), retry: false };
    return { note: error.message, retry: true };
  }
  return { note: error instanceof Error && error.message ? error.message : tr("Cannot read this project's chats right now."), retry: true };
}

/**
 * Fetch a project's chat list. A `note` with a value means nothing can be listed (no Agent service, the
 * creator turned it off); these two cases do not count as failures,
 * no retry is needed, so they are recorded as `ready` as usual
 */
export async function fetchBrowsedChats(projectId: string, deps: BrowseDeps): Promise<{ chats: VibeChat[]; note?: string }> {
  const session = await deps.session(projectId);
  const origin = deps.origin?.() ?? (typeof location !== "undefined" ? location.origin : "");
  const base = agentBaseOf(session.hosted, origin);
  if (!base.url) return { chats: [], ...(base.note ? { note: base.note } : {}) };
  const items = await getAiCloudProvider().listCloudChats({
    baseUrl: () => base.url,
    projectId: () => projectId,
    ticket: async () => session.agentDelegationTicket,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { chats: viewableChats(items, { accountId: deps.viewer().accountId, creator: session.creator === true }, projectId) };
}

export interface BrowseChats {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => BrowseState;
  /**
   * Time to fetch this project's chats (the user opened that branch). `force` means the user clicked
   * "Retry" themselves: fetch once regardless of the TTL.
   * Ones being fetched, and ones fetched within the TTL, send no request again
   */
  load: (projectId: string, options?: { force?: boolean }) => void;
  /** Switching account or logging out: drop the whole bucket (otherwise the previous account's chats would leak through) */
  forget: () => void;
}

export function createBrowseChats(deps: BrowseDeps): BrowseChats {
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  const inFlight = new Set<string>();
  let state: BrowseState = {};
  const emit = () => { for (const l of [...listeners]) l(); };
  const put = (projectId: string, entry: BrowseEntry) => { state = { ...state, [projectId]: entry }; emit(); };

  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot() { return state; },
    load(projectId, options) {
      if (!projectId || inFlight.has(projectId)) return;
      const had = state[projectId];
      if (!options?.force && had && had.state === "ready" && now() - had.at < BROWSE_TTL_MS) return;
      inFlight.add(projectId);
      // While fetching, leave the previous result in place: only write "fetching" on that line, so the chats already listed below do not flicker away
      put(projectId, { state: "loading", chats: had?.chats ?? [], note: tr("Reading this project's chats…"), at: had?.at ?? 0 });
      void fetchBrowsedChats(projectId, deps).then(
        (out) => { inFlight.delete(projectId); put(projectId, { state: "ready", chats: out.chats, ...(out.note ? { note: out.note } : {}), at: now() }); },
        (error) => {
          inFlight.delete(projectId);
          const why = browseNoteOf(error);
          put(projectId, { state: "error", chats: had?.chats ?? [], note: why.note, retry: why.retry, at: had?.at ?? 0 });
        },
      );
    },
    forget() { inFlight.clear(); if (Object.keys(state).length === 0) return; state = {}; emit(); },
  };
}
