/**
 * Interface text for the account service's error codes, used by the login dialog (`LoginDialog.tsx`).
 *
 * The account service (VisuHive repo, `account/app.mjs`) answers with an error code and a message in
 * Chinese. The code is what the dialog shows in the interface language; the server's message is the
 * fallback for a code this table does not know, so nothing new from the server is ever swallowed.
 * The client puts the code on the thrown Error as `code` (`CloudAccountClient` in
 * `src/editor/sync/accountExtensions.ts`).
 */
import { tr } from "../i18n/index.ts";

/** Codes the dialog knows. Order follows the account service's own list */
export const ACCOUNT_ERROR_CODES = [
  "bad-login",
  "bad-password",
  "bad-name",
  "name-taken",
  "email-taken",
  "bad-email",
  "bad-code",
  "too-many",
  "mail-off",
  "mail-failed",
  "network",
] as const;
export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];

export function accountErrorCodeText(code: AccountErrorCode): string {
  switch (code) {
    case "bad-login": return tr("Wrong account name or password.");
    case "bad-password": return tr("Wrong password.");
    case "bad-name": return tr("That account name can’t be used. Use 3–24 letters, digits, _ or -.");
    case "name-taken": return tr("That account name is taken. Try another one.");
    case "email-taken": return tr("That email is already linked to another account.");
    case "bad-email": return tr("That doesn’t look like an email address.");
    case "bad-code": return tr("The code is wrong or has expired.");
    case "too-many": return tr("Too many tries. Wait a few minutes and try again.");
    case "mail-off": return tr("Sending email isn’t available right now.");
    case "mail-failed": return tr("The email couldn’t be sent. Try again later.");
    case "network": return tr("Can’t reach the account service. Check your connection and try again.");
  }
}

function codeOf(e: unknown): string | null {
  if (!e || typeof e !== "object") return null;
  const raw = (e as { code?: unknown; error?: unknown }).code ?? (e as { error?: unknown }).error;
  return typeof raw === "string" ? raw : null;
}

/**
 * Text for a failure: a known code → interface text; otherwise the server's message; otherwise `fallback`.
 * A `TypeError` from `fetch` (offline, refused) counts as `network`.
 * `context` overrides a code where the same code means something else on that step: the service's
 * `bad-password` is "too short" when signing up but "wrong password" when sending the email code.
 */
export function accountErrorText(e: unknown, fallback: string, context: Partial<Record<AccountErrorCode, string>> = {}): string {
  const code = codeOf(e);
  if (code && Object.hasOwn(context, code)) return context[code as AccountErrorCode]!;
  if (code && (ACCOUNT_ERROR_CODES as readonly string[]).includes(code)) return accountErrorCodeText(code as AccountErrorCode);
  if (e instanceof TypeError) return accountErrorCodeText("network");
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return fallback;
}
