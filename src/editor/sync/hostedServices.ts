/**
 * Pure UI logic for host services (services the host brings itself on a cloud node) (contract
 * `docs/plan/hosted-render-contract.md` sections 1.7 and 3).
 *
 * - Top level of the member list: `hosted: { render: { available, enabled }, agent: { available, enabled } }`.
 *   Projects kept on this machine and hosted sides without a registry have no such field (parsed
 *   as null); `enabled` is this project's switch for the service, and a missing record counts as on.
 * - Member-list rows whose `service` field is non-empty are host services: shown by service name,
 *   not by username; they are not members, not counted in the member count, and have no kick button.
 * - Project settings has one checkbox row per service, **rendered by service name**: for now only
 *   `render`; the fourth one (Cloud Agent) needs just one entry each in `HOSTED_SERVICE_ROWS` and
 *   `HOSTED_SERVICE_TEXT` to add a row.
 *
 * - Under the render node row there is one more indented sub-option row, "Generate track stream"
 *   (contract `hosted-render-contract.md` section 3.1): `hosted.render.streams` in the member list
 *   (boolean; appears only if the document service reported it; old hosted sides do not report it,
 *   so this row is not shown); a missing record counts as off (user decision, 2026-10-12: when the
 *   online browser is paused, any frame can be viewed without relying on the render node; the cloud
 *   produces no track stream by default, to save server resources); when the render node row is
 *   off, it is greyed out and cannot be clicked.
 *   Sub-options are rendered by "service name + option name"; their text is in `HOSTED_OPTION_TEXT`.
 *
 * - A service connection that enters the project on behalf of a member (Cloud Agent) gets no row of
 *   its own: it belongs to that member's row, with the entry in `conns` carrying `service: 'agent'`,
 *   and the UI shows "<member name>'s Cloud Agent" under that member (`cloudAgentConns`,
 *   `cloudAgentLabel`; contract `docs/plan/cloud-agent-contract.md` section 5).
 *   The `agent` row in project settings is the "Cloud Agent" switch.
 *
 * No React and no sync manager runtime (types only), so unit tests import it directly.
 */
import type { AdminError, MemberRow } from "./syncManager";
import { tr } from "../../i18n/index.ts";

export type HostedServiceName = "render" | "agent";

export interface HostedServiceState {
  available: boolean;
  enabled: boolean;
  /** The render node's sub-option "Generate track stream": present only if the document service reported it (old hosted sides do not have it); the default off is computed by the document service and then reported (a missing record counts as off, only an explicit true counts as on) */
  streams?: boolean;
  /** Whether the account has permission to enable "Generate track stream" (in the permission group or an admin) */
  streamsAllowed?: boolean;
}

/** Name of a sub-option under a service; for now only the render node's `streams` */
export type HostedOptionName = "streams";

/** Which sub-options appear in project settings and in what order (each hangs under its own service row) */
export const HOSTED_OPTION_ROWS: readonly { service: HostedServiceName; option: HostedOptionName }[] = [{ service: "render", option: "streams" }];

export type HostedView = Partial<Record<HostedServiceName, HostedServiceState>>;

/** Which rows appear in project settings and in what order */
export const HOSTED_SERVICE_ROWS: readonly HostedServiceName[] = ["render", "agent"];

export interface HostedServiceText {
  label: string;
  /** The line of description under a checkbox row */
  hint: (enabled: boolean) => string;
  /** The notice other members get when "the creator changed the switch"; an empty string means no notice in that direction (same rule for both switches: notify only when turned off, not when turned on, [user decision 2026-10-07]) */
  changed: (enabled: boolean) => string;
  /** The one-line sentence in the creator's confirmation dialog (`enabled` is the state to change to) */
  confirm: (enabled: boolean) => string;
}

/** UI text for each service. To add a service, add an entry here and then add its name to `HOSTED_SERVICE_ROWS` */
export const HOSTED_SERVICE_TEXT: Partial<Record<HostedServiceName, HostedServiceText>> = {
  render: {
    label: tr("Host's render node"),
    hint: (enabled) => (enabled ? tr("The host's render node on the cloud node prerenders this project. The creator can turn this off.") : tr("Turned off: the host's render node no longer prerenders this project. Existing prerender output is kept.")),
    // Same rule as the Cloud Agent: other members get a bubble only when it is turned off, not when turned on [user decision 2026-10-07]
    changed: (enabled) => (enabled ? "" : tr("The creator turned off the host's render node. It no longer prerenders this project.")),
    confirm: (enabled) => (enabled ? tr("Once turned on, the host's render node will prerender this project.") : tr("Once turned off, the host's render node will no longer prerender this project. Existing prerender output is kept.")),
  },
  agent: {
    label: tr("Cloud Agent"),
    hint: (enabled) => (enabled ? tr("Members can choose \"Cloud\" in the AI panel to have an Agent on the cloud node edit the project on their behalf, and it keeps going after the app is closed. The creator can turn this off.") : tr("Turned off: members can no longer use the Cloud Agent, and cloud chats in progress have been stopped. Changes already applied are kept.")),
    // Other members get one bubble only when it is turned off, nothing when turned on (an empty string pops nothing) [user decision 2026-10-07]
    changed: (enabled) => (enabled ? "" : tr("The creator turned off the Cloud Agent, and cloud chats in progress have been stopped.")),
    confirm: (enabled) => (enabled ? tr("Once turned on, members can choose \"Cloud\" in the AI panel to have an Agent on the cloud node edit the project on their behalf.") : tr("Once turned off, members can no longer use the Cloud Agent, and cloud chats in progress will be stopped immediately. Changes already applied are kept.")),
  },
};

export interface HostedOptionText {
  label: string;
  /** The line of description under a checkbox row */
  hint: (enabled: boolean) => string;
  /** The notice other members get when "the creator changed this option"; an empty string means no notice in that direction (same rule as the service switch: notify only when turned off) */
  changed: (enabled: boolean) => string;
  /** The one-line sentence in the creator's confirmation dialog (`enabled` is the state to change to) */
  confirm: (enabled: boolean) => string;
}

/** UI text for each sub-option (follows the task brief for now; to be fixed after the user reviews screenshots). The key is `<service name>.<option name>` */
export const HOSTED_OPTION_TEXT: Record<string, HostedOptionText> = {
  "render.streams": {
    label: tr("Generate track streams"),
    hint: (enabled) => (enabled ? tr("The host's render node generates track streams for this project, so heavy cards play more smoothly in the online browser.") : tr("Not turned on: the host's render node does not generate track streams for this project, and playback uses the track streams generated on each member's own device. Once turned on, the host generates them too, so heavy cards play more smoothly in the online browser, at the cost of more cloud render time.")),
    changed: (enabled) => (enabled ? "" : tr("The creator turned off track streams, so the host's render node no longer generates track streams for this project.")),
    confirm: (enabled) => (enabled ? tr("Once turned on, the host's render node will generate track streams for this project.") : tr("Once turned off, the host's render node no longer generates track streams for this project, and the ones already generated are kept.")),
  },
};

export const hostedOptionText = (service: unknown, option: unknown): HostedOptionText | null =>
  (typeof service === "string" && typeof option === "string" && HOSTED_OPTION_TEXT[`${service}.${option}`]) || null;

const isServiceName = (v: unknown): v is HostedServiceName => v === "render" || v === "agent";

/** Top-level `hosted` of the member list message → UI state; returns null if missing or malformed (projects kept on this machine, old hosted sides) */
export function parseHosted(raw: unknown): HostedView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: HostedView = {};
  for (const name of ["render", "agent"] as const) {
    const s = (raw as Record<string, unknown>)[name];
    if (!s || typeof s !== "object") continue;
    const { available, enabled, streams, streamsAllowed } = s as Record<string, unknown>;
    if (typeof available !== "boolean" || typeof enabled !== "boolean") continue;
    out[name] = { available, enabled };
    // Sub-options: accepted only if well-formed (boolean); old hosted sides do not report them, so the field is absent and the row is not shown
    if (name === "render" && typeof streams === "boolean") out[name]!.streams = streams;
    if (name === "render" && typeof streamsAllowed === "boolean") out[name]!.streamsAllowed = streamsAllowed;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Account project failed to change a host service switch (or "Generate track stream") → error kind +
 * a reason that can be shown to people directly.
 * The `AccountFailure` thrown by the account client carries `status`, `code` and a one-line message
 * already translated from `code` (`accountErrorText`, e.g. when not in the permission group:
 * "Your account has no permission to enable this option. Contact the host."); say exactly that,
 * and no longer reuse the passphrase project's "Wrong password." (2026-10-20 online test: a 403 was
 * reported as something else or nothing at all)
 */
export function accountHostedFailure(error: unknown): { ok: false; error: AdminError; message: string } {
  const e = (error && typeof error === "object" ? error : {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === "number" ? e.status : NaN;
  const kind: AdminError = status === 403 ? "forbidden" : status === 400 ? "bad-message" : status === 0 || e.code === "network" ? "offline" : "other";
  const known = typeof e.code === "string" && typeof e.message === "string" && e.message !== "" && e.message !== e.code;
  const message = known ? (e.message as string) : kind === "offline" ? tr("Could not reach the cloud service. Try again later.") : tr("Did not succeed, try again later.");
  return { ok: false, error: kind, message };
}

/** The one-line sentence in the dialog when changing a host service switch fails: if a reason is given (account project), say it; otherwise fall back to the error kind as before (passphrase project; `fallback` is that side's text) */
export function hostedFailText(r: { error: string; message?: string }, unavailable: string, fallback: (error: string) => string): string {
  if (r.message) return r.message;
  return r.error === "bad-message" ? unavailable : fallback(r.error);
}

/** Apply a `hosted-service-changed` notification to the state: return it unchanged if the service is unknown or this project has no such service */
export function applyHostedChange(hosted: HostedView | null, service: unknown, enabled: unknown): HostedView | null {
  if (!isServiceName(service) || typeof enabled !== "boolean") return hosted;
  const prev = hosted?.[service];
  if (!prev) return hosted;
  return { ...hosted, [service]: { ...prev, enabled } };
}

/** Apply a `hosted-option-changed` notification to the state: return it unchanged if the service or option is unknown, or this project did not report this option (old hosted side) */
export function applyHostedOptionChange(hosted: HostedView | null, service: unknown, option: unknown, enabled: unknown): HostedView | null {
  if (service !== "render" || option !== "streams" || typeof enabled !== "boolean") return hosted;
  const prev = hosted?.render;
  if (!prev || typeof prev.streams !== "boolean") return hosted;
  return { ...hosted, render: { ...prev, streams: enabled } };
}

/**
 * For account projects: between the previous and current reads of the host service state, which
 * changes should give other members a notice (same rule and same text as passphrase project
 * notifications: notify only when turned off, not when turned on). Returns the sentence to pop up;
 * no change, turned on, or the previous read lacking this item: nothing pops up.
 */
export function hostedChangeNotices(prev: HostedView | null, next: HostedView | null): string[] {
  const out: string[] = [];
  const a = prev?.render, b = next?.render;
  if (a && b) {
    if (a.enabled && !b.enabled) { const text = HOSTED_SERVICE_TEXT.render?.changed(false); if (text) out.push(text); }
    if (a.streams === true && b.streams === false) { const text = hostedOptionText("render", "streams")?.changed(false); if (text) out.push(text); }
  }
  return out;
}

/**
 * Whether this page currently sees this project's "Generate track stream" as in effect: the project
 * is in the cloud, the host has a render node, the render node is on, and this option is on.
 * The online page uses it to resend the manifest plan when this option goes from off to on
 * (`streamsOn` in `src/online/planPublisher.ts`). The old document service does not report this
 * option: always false.
 */
export function hostedStreamsOn(where: "lan" | "hosted" | null | undefined, hosted: HostedView | null): boolean {
  const r = hosted?.render;
  return where === "hosted" && !!r && r.available === true && r.enabled === true && r.streams === true;
}

/**
 * Whether ticking a host service must first verify the creator password: passphrase projects do
 * (the creator's action is proven by the password); account projects have no creator password and
 * rely on the account's login state, with the server gatekeeping by creator identity, so they go
 * straight to the confirmation step.
 */
export const hostedFlowNeedsPassword = (account: boolean): boolean => !account;

export interface HostedRow {
  service: HostedServiceName;
  label: string;
  enabled: boolean;
}

/**
 * Which rows to show in project settings: they appear only if the project is in the cloud and the
 * registry of this hosted side has the service (`available`). Projects kept on this machine,
 * hosted sides without a registry, and `available` being false all have no such item.
 */
export function hostedRowsOf(where: "lan" | "hosted" | null | undefined, hosted: HostedView | null): HostedRow[] {
  if (where !== "hosted" || !hosted) return [];
  const rows: HostedRow[] = [];
  for (const service of HOSTED_SERVICE_ROWS) {
    const s = hosted[service];
    const text = HOSTED_SERVICE_TEXT[service];
    if (s?.available && text) rows.push({ service, label: text.label, enabled: s.enabled });
  }
  return rows;
}

export interface HostedOptionRow {
  service: HostedServiceName;
  option: HostedOptionName;
  label: string;
  enabled: boolean;
  /** The service row it hangs under is off: this row is greyed out and cannot be clicked */
  parentOff: boolean;
  /** The account has no permission to enable this option: greyed out, cannot be clicked */
  notAllowed?: boolean;
}

/**
 * Which sub-options to show in project settings: they appear only if the project is in the cloud,
 * this hosted side has the service (`available`), and the document service reported the option
 * (old hosted sides do not report it).
 * They still appear when the service row is off, with `parentOff` true, and the UI greys them out.
 */
export function hostedOptionRowsOf(where: "lan" | "hosted" | null | undefined, hosted: HostedView | null): HostedOptionRow[] {
  if (where !== "hosted" || !hosted) return [];
  const rows: HostedOptionRow[] = [];
  for (const { service, option } of HOSTED_OPTION_ROWS) {
    const s = hosted[service];
    const text = hostedOptionText(service, option);
    const value = s?.[option];
    if (s?.available && text && typeof value === "boolean") {
      const notAllowed = option === "streams" && s.streamsAllowed === false;
      rows.push({ service, option, label: text.label, enabled: value, parentOff: !s.enabled, ...(notAllowed ? { notAllowed: true } : {}) });
    }
  }
  return rows;
}

/** The Cloud Agent connections that enter the project on this member's behalf (the items in the member row's `conns` carrying `service: 'agent'`) */
export function cloudAgentConns<T extends { role: string; service?: string }>(conns: readonly T[]): T[] {
  return conns.filter((c) => c.service === "agent");
}

/** Attribution of a Cloud Agent: "<member name>'s Cloud Agent" (used by the operation log, override notices and the member list alike) */
export const cloudAgentLabel = (name: string): string => tr("{0}'s Cloud Agent", name);

/** Whether this row of the member list is a host service */
export const isServiceRow = (row: Pick<MemberRow, "service">): boolean => typeof row.service === "string" && row.service !== "";

/** The name shown on a service row: by service name, not by username; an unknown service name gets a generic name */
export function serviceRowLabel(service: string | undefined): string {
  return (isServiceName(service) && HOSTED_SERVICE_TEXT[service]?.label) || tr("Host's service");
}

/** Split the member list into two segments: members (first, counted in the member count) and host services (after, not counted, no kick button) */
export function splitMembers<T extends Pick<MemberRow, "service">>(rows: readonly T[]): { people: T[]; services: T[] } {
  const people: T[] = [];
  const services: T[] = [];
  for (const r of rows) (isServiceRow(r) ? services : people).push(r);
  return { people, services };
}

/* ---------------------------------------------------------------------------------------------
 * Counting rules for the member list [user decision 2026-10-07; changed the same day: Cloud Agent is counted by "whether a turn is running right now", not by "whether it is connected"]: "Members: N · Agents: M"
 *
 * A Cloud Agent connection stays connected after a turn ends (reclaimed only after 10 idle minutes),
 * so being connected says little about whether it is working. While a turn is running, the Agent
 * service attaches an item `cloud-run` via the presence state (`cloudRunning()` in `presence.ts`: a
 * set of member keys `username@deviceId`, written the same way as `${username}@${deviceId}` in the
 * member row); the functions below all take this table:
 *
 * - Member count only counts people who are really online: a row counts only if it has any
 *   connection that is not a "Cloud Agent" (a page, a local Agent or a render process each show
 *   that his device is online);
 * - Agent count = local Agents (one connection per chat) plus Cloud Agents with a turn running (at
 *   most one per member, even if the instance has several connections); idle Cloud Agent
 *   connections are not counted;
 * - The member is offline but his Cloud Agent has a turn running: the row is shown as usual and
 *   marked "Offline, Agent running", not counted in members, counted in Agents;
 * - The member is offline and only idle Cloud Agent connections remain: the row is not shown (no
 *   mark, not counted in either number);
 * - The member is online and the Cloud Agent is idle: the row does not show the "[Cloud Agent]"
 *   mark; it shows only while a turn is running;
 * - Host service rows (render node) are counted in neither number (`splitMembers` has already
 *   separated them).
 * ------------------------------------------------------------------------------------------- */

type CountRow = Pick<MemberRow, "conns" | "username" | "deviceId">;

/** Member keys (`username@deviceId`) whose Cloud Agent has a turn running right now */
export type CloudRunning = ReadonlySet<string>;

/** The key of a member row in the "turn running" table: written the same way as the `userId` of the source identity in the presence state (`username@deviceId`) */
export const memberKeyOf = (row: Pick<MemberRow, "username" | "deviceId">): string => `${row.username}@${row.deviceId}`;

/** Whether the member of this row is really online right now */
export function isPersonOnline(row: Pick<MemberRow, "conns">): boolean {
  return row.conns.some((c) => c.service !== "agent");
}

/** This member's Cloud Agent has a turn running right now (connected, and in the "turn running" table) */
export function isCloudAgentRunning(row: CountRow, running: CloudRunning): boolean {
  return cloudAgentConns(row.conns).length > 0 && running.has(memberKeyOf(row));
}

/** This member is offline but his Cloud Agent has a turn running: mark "Offline, Agent running" */
export function isCloudAgentOnly(row: CountRow, running: CloudRunning): boolean {
  return !isPersonOnline(row) && isCloudAgentRunning(row, running);
}

/** This member is offline and only idle Cloud Agent connections remain: this row is not shown */
export function isIdleCloudAgentOnly(row: CountRow, running: CloudRunning): boolean {
  return !isPersonOnline(row) && cloudAgentConns(row.conns).length > 0 && !isCloudAgentRunning(row, running);
}

/** Rows to show in the member list (dropping those left with only idle Cloud Agent connections). `people` is the member rows split out by `splitMembers` */
export function visibleMembers<T extends CountRow>(people: readonly T[], running: CloudRunning): T[] {
  return people.filter((r) => !isIdleCloudAgentOnly(r, running));
}

/** Number of local Agents (connections in this row with `role: 'agent'` that are not a Cloud Agent) */
export function localAgentCount(row: Pick<MemberRow, "conns">): number {
  return row.conns.filter((c) => c.role === "agent" && c.service !== "agent").length;
}

/** Member count and Agent count for the top bar. `people` is the member rows split out by `splitMembers` */
export function memberCounts(people: readonly CountRow[], running: CloudRunning): { people: number; agents: number } {
  let online = 0;
  let agents = 0;
  for (const r of visibleMembers(people, running)) {
    if (isPersonOnline(r)) online++;
    agents += localAgentCount(r) + (isCloudAgentRunning(r, running) ? 1 : 0);
  }
  return { people: online, agents };
}

/** Text on the top bar button. You are always online, so the member count is at least 1 */
export function memberCountLabel(people: readonly CountRow[], running: CloudRunning): string {
  const c = memberCounts(people, running);
  return tr("Members: {0} · Agents: {1}", Math.max(1, c.people), c.agents);
}

/* ---------------------------------------------------------------------------------------------
 * The member list of an account cloud project (`AccountMembersPanel`, mobile app `useMembers`) uses the same counting rules [semantics `product/agent.md` "How the member list is counted"].
 *
 * The member list (`members`) has one row per account; online connections (`devices`) are given per
 * "account + device"; a Cloud Agent's task connection has no device, and the document service
 * groups it by task ID into one item `run:<task ID>`, recorded under the initiating member's
 * account (`server/account/project-members.mjs`).
 * An account project's task connection is connected only while a turn is running (closed when the
 * turn ends), so "connected" means "a turn is running", and the `cloud-run` in the presence state is
 * not consulted separately.
 *
 * - Member count: accounts that have a page connection (`role: 'page'`);
 * - Agent count: local Agent connections (`role: 'agent'` and not a Cloud Agent) counted one by one,
 *   and a Cloud Agent counts at most one per member;
 * - The member has no page connection and the Cloud Agent is connected: "Offline, Agent running",
 *   not counted in members, counted in Agents.
 * ------------------------------------------------------------------------------------------- */

interface AccountConnLike { role: string; service?: string; conversation?: string | number }
interface AccountDeviceLike { accountId: string; conns: readonly AccountConnLike[] }

export interface AccountMemberState {
  /** The member is online (has a page connection) */
  online: boolean;
  /** His Cloud Agent has a turn running right now */
  cloudRunning: boolean;
  /** The member is offline, the Cloud Agent is running: mark "Offline, Agent running" */
  offlineAgent: boolean;
  /** The local Agent connections under his name */
  localAgents: AccountConnLike[];
}

/** The online and Agent state of an account member right now */
export function accountMemberState(accountId: string, devices: readonly AccountDeviceLike[]): AccountMemberState {
  const conns = devices.filter((d) => d.accountId === accountId).flatMap((d) => d.conns);
  const online = conns.some((c) => c.role === "page");
  const cloudRunning = conns.some((c) => c.role === "agent" && c.service === "agent");
  return { online, cloudRunning, offlineAgent: !online && cloudRunning, localAgents: conns.filter((c) => c.role === "agent" && c.service !== "agent") };
}

/** The two numbers of "Members: N · Agents: M" for an account project. Only accounts in the list are counted (the document service has already filtered out kicked members and connections not in the list) */
export function accountMemberCounts(snapshot: { members: readonly { accountId: string }[]; devices: readonly AccountDeviceLike[] }): { people: number; agents: number } {
  let people = 0;
  let agents = 0;
  for (const m of snapshot.members) {
    const s = accountMemberState(m.accountId, snapshot.devices);
    if (s.online) people++;
    agents += s.localAgents.length + (s.cloudRunning ? 1 : 0);
  }
  return { people, agents };
}

/** Text on the account project's top bar button */
export function accountMemberCountLabel(snapshot: Parameters<typeof accountMemberCounts>[0]): string {
  const c = accountMemberCounts(snapshot);
  return tr("Members: {0} · Agents: {1}", c.people, c.agents);
}
