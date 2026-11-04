import { tr } from "../../i18n/index.ts";
/**
 * Wording shown in the UI for join requests and entry types (user decision, 2026-10-22, `docs/semantics/workflow/project.md`,
 * "Multi-user collaboration" items 26 and 27, "Expired cloud project to local" line 44). The desktop start page
 * (`AccountProjects.tsx`), the mobile start page (`src/mobile/MobileStart.tsx`), the prompt for reopening a file
 * (`src/editor/sync/recoveryAssociation.ts`), the members popover (`AccountMembersPanel.tsx`, and the mobile members
 * panel) and the checkbox in project settings (`AccountEntryOption.tsx`) all share this one, so the wording is
 * consistent everywhere. The quoted lines are the verbatim semantics text.
 * Punctuation: the status lines of the blocked section (blocked, sent, rejected, approved) and the bubbles after
 * "Approve / Reject" follow the verbatim semantics text and have no period at the end; explanations of two or more
 * sentences (the note under the checkbox, the line after the reopen-file request is sent) use periods as usual.
 */

export interface JoinRequestStatus {
  projectId: string;
  state: "none" | "pending" | "rejected" | "member";
  entry: "link" | "list";
  canApply: boolean;
  requestedAt?: number;
  decidedAt?: number;
  retryAt?: number;
}

export const JOIN_REQUEST_TEXT = {
  /** Blocked by the account list (verbatim semantics text: "You are not on this project's member list") */
  notListed: tr("You are not on this project's member list"),
  /** Button (verbatim semantics text) */
  send: tr("Send request"),
  /** After sending (verbatim semantics text) */
  sent: tr("Sent. Waiting for the creator to approve"),
  /** Rejected (verbatim semantics text) */
  rejected: tr("The creator did not approve your request"),
  /** Approved, joining now (or about to enter the secondary password) */
  approved: tr("The creator approved your request"),
  /** Reopening a file: the logged-in account is not a member (verbatim semantics text: "This account is not a member of this cloud project") */
  reopenNotMember: tr("This account is not a member of this cloud project"),
  /** Opened from a direct project address, and the logged-in account is not yet a member: the link is already filled in and the user clicks join themselves (`product/platforms.md`, "Direct project address") */
  directNotMember: tr("You are not a member of this project yet. Click \"Join and open project\" to join."),
  /** After clicking "Send request" when reopening a file: how to reconnect once approved */
  reopenSent: tr("Sent. Waiting for the creator to approve. Once approved, reopen this file to reconnect to the cloud project."),
  /** Checkbox in project settings (verbatim semantics text: "Anyone with the link can join") */
  entryLabel: tr("Anyone with the link can join"),
  /** The line under the checkbox after it is unchecked: the list is the current members, and new people can only request to join */
  entryListHint: (members: number) => tr("Account list only ({0} members now). New people must send a request, which you approve under \"Members\" in the top bar.", members),
  /** The line shown while the box is checked */
  entryLinkHint: tr("Anyone with the project link can join after signing in to their website account."),
  /** Title of the requests section in the members popover */
  requestsTitle: (n: number) => tr("Join requests ({0})", n),
  approve: tr("Approve"),
  reject: tr("Reject"),
  /** Bubble after the creator clicks "Approve" or "Reject" (same line on desktop and mobile) */
  approvedToast: (name: string) => tr("Approved {0}'s request", name),
  rejectedToast: (name: string) => tr("Rejected {0}'s request", name),
  /** Clicking into a project from the "My projects" list when it has a secondary password and the user has not yet entered the current version of it (same line as when joining via a link) */
  secondaryRequired: tr("This project has a secondary project password. Enter the secondary password."),
} as const;

/** Written to the minute in this machine's time zone: "Oct 22 14:05" */
function minuteText(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return tr("{0}/{1} {2}:{3}", d.getMonth() + 1, d.getDate(), two(d.getHours()), two(d.getMinutes()));
}
/** "What time you can apply again" (when attempts run out, computed from the `retryAt` returned by the server) */
export function retryAtText(retryAt: number): string {
  return tr("You can request again after {0}.", minuteText(retryAt));
}
/** The time on the line under each request in the members popover */
export function requestedAtText(createdAt: number): string {
  return tr("Requested {0}", minuteText(createdAt));
}

/**
 * The notice when reopening a file and the logged-in account is not a member (semantics `workflow/project.md` line 44):
 * when the project only has an account list, there is also a "Send request" button.
 * If a request was already sent and is pending, or was rejected and attempts are used up, no button is given and the
 * current state is spelled out after the notice. If the project can be entered by anyone with the link (`entry: 'link'`),
 * or the account turns out to be a member already, return null and use the original line, without a button.
 */
export function reopenNotice(status: JoinRequestStatus): { text: string; canSend: boolean } | null {
  if (status.entry !== 'list' || status.state === 'member') return null;
  const base = JOIN_REQUEST_TEXT.reopenNotMember;
  if (status.state === 'pending') return { text: tr("{0}. {1}", base, JOIN_REQUEST_TEXT.sent), canSend: false };
  const notice = joinRequestNotice(status);
  const tail = status.state === 'rejected' ? tr(". {0}", JOIN_REQUEST_TEXT.rejected) : '';
  if (notice?.canSend) return { text: `${base}${tail}`, canSend: true };
  return { text: `${base}${tail}${notice?.hint ? tr(". {0}", notice.hint) : ''}`, canSend: false };
}

/**
 * What the blocked user's section should say and whether to give the "Send request" button. `member` (just approved)
 * says only one line, and then the page goes on to enter the project (for one with a secondary password, it then asks
 * for the password). When the project has been changed back to "anyone with the link can enter" (`entry: 'link'`, not
 * yet a member), return null and the whole section is hidden: the page just tries joining again. It must not show the
 * secondary password box while also saying "Sent, waiting for the creator to approve" or "You are not on this
 * project's member list" (consistent with `reopenNotice`).
 */
export function joinRequestNotice(status: JoinRequestStatus): { text: string; canSend: boolean; hint?: string } | null {
  if (status.state === 'member') return { text: JOIN_REQUEST_TEXT.approved, canSend: false };
  if (status.entry === 'link') return null;
  if (status.state === 'pending') return { text: JOIN_REQUEST_TEXT.sent, canSend: false };
  const text = status.state === 'rejected' ? JOIN_REQUEST_TEXT.rejected : JOIN_REQUEST_TEXT.notListed;
  return { text, canSend: status.canApply, ...(!status.canApply && status.retryAt ? { hint: retryAtText(status.retryAt) } : {}) };
}

/**
 * When a request is approved (`member`) or the project is changed back to "anyone with the link can enter"
 * (`entry: 'link'`), the page should automatically go through joining once more: return a key that changes with the
 * state, and the page calls join once whenever the key changes (for one with a secondary password, it then asks for
 * the password). Return null in all other cases
 */
export function autoJoinKey(request: JoinRequestStatus | null): string | null {
  return request && (request.state === 'member' || request.entry === 'link') ? `${request.projectId}:${request.state}:${request.entry}` : null;
}
