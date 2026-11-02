import { tr } from "../../i18n/index.ts";
type TauriGlobal = {
  core?: { invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown> };
  app?: { getVersion?: () => Promise<string> };
};

/** The shell only has the `account_bridge` command from this version on (`desktop/src-tauri/src/account_vault.rs`, registered in `invoke_handler` in `lib.rs`). */
export const ACCOUNT_BRIDGE_MIN_SHELL = '0.2.8';

/**
 * The message shown to the user when clicking the account entry on an old shell. Update patches only
 * replace the Node half, not the Rust shell; `account_bridge` lives in the shell, so a patch cannot
 * install this feature and the full installer is needed (user decision, 2026-10-17: the patch's
 * minimum shell stays 0.2.0, not raised, and the entry explains it itself).
 */
export const OLD_SHELL_ACCOUNT_TEXT =
  tr("This feature requires the full installer. Your desktop shell is too old and an update patch cannot replace it. Cloud projects and account sign-in need the new shell; please install the latest full installer. Local projects are not affected and keep working as usual.");

/** Thrown when the shell has no account bridge. The UI recognizes it by `code` or `isDesktopShellTooOld`, do not compare the message text. */
export class DesktopShellTooOldError extends Error {
  readonly code = 'desktop-shell-too-old';
  constructor() { super(OLD_SHELL_ACCOUNT_TEXT); this.name = 'DesktopShellTooOldError'; }
}

export function isDesktopShellTooOld(error: unknown): boolean {
  return error instanceof DesktopShellTooOldError || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'desktop-shell-too-old');
}

/**
 * When Tauri 2 gets a call to a command that "is not in the shell, or is not allowed", it rejects with
 * the following three sentences (verbatim, matched as whole sentences). The source is tauri 2.11's
 * `src/webview/mod.rs` (`Command {cmd} not allowed by ACL` / `Command {command} not found`) and
 * `src/ipc/authority.rs` (the debug build's `{cmd} not allowed. Command not found` /
 * `... Plugin not found`):
 * - The `build.rs` of old shells (0.2.0 to 0.2.7) does not register `account_bridge`, and the
 *   permission manifest does not have it either; the page is also a "remote origin" at
 *   127.0.0.1:5210, so on the release build you get the first sentence; older shells with no app
 *   permission manifest, and calls from a local origin, get the second; the debug build gets the third.
 * - The new shell's own errors are only the few `desktop-account-*` codes in `account_vault.rs`,
 *   which never collide with these three; when the new shell's permissions are misconfigured, it
 *   says the long `... not allowed on window ...` sentence, which does not match either and is
 *   thrown unchanged as usual.
 * Never use loose matching such as "the message contains not found / ACL": being loose would also
 * report real errors as the shell being too old.
 */
const MISSING_COMMAND_REJECTIONS = [
  /^Command account_bridge not allowed by ACL$/,
  /^Command account_bridge not found$/,
  /^account_bridge not allowed\. (?:Command|Plugin) not found$/,
];

function rejectionText(rejection: unknown): string | null {
  if (typeof rejection === 'string') return rejection.trim();
  if (rejection instanceof Error) return rejection.message.trim();
  if (typeof rejection === 'object' && rejection !== null && typeof (rejection as { message?: unknown }).message === 'string') return (rejection as { message: string }).message.trim();
  return null;
}

/** Whether the rejection text of a rejected `account_bridge` call says "this shell does not have this command" */
export function isMissingAccountBridgeRejection(rejection: unknown): boolean {
  const text = rejectionText(rejection);
  return text !== null && MISSING_COMMAND_REJECTIONS.some((pattern) => pattern.test(text));
}

function versionParts(version: unknown): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === 'string' ? version.trim() : '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** The shell version is not lower than 0.2.8 (has the account bridge): true / false; version unreadable: null */
export function shellHasAccountBridge(version: unknown): boolean | null {
  const have = versionParts(version), need = versionParts(ACCOUNT_BRIDGE_MIN_SHELL);
  if (!have || !need) return null;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}

/**
 * When the rejection text looks like "no such command", check the shell version once more, to avoid a
 * misconfigured new shell being reported as "shell too old": if the version is readable and not lower
 * than 0.2.8, the shell is not too old, and the original error is reported as usual; if it is
 * unreadable (older shells did not even grant `core:default` to remote pages), treat it as too old.
 */
async function shellLacksAccountBridge(tauri: TauriGlobal): Promise<boolean> {
  let version: unknown = null;
  try { version = await tauri.app?.getVersion?.(); } catch { /* Version unreadable */ }
  return shellHasAccountBridge(version) !== true;
}

/**
 * The native bridge checks the actual main WebView label and URL. Cards get no vault API.
 * If the shell does not have this command (shells before 0.2.8 were patched), throws
 * `DesktopShellTooOldError`; other errors are thrown unchanged.
 */
export async function desktopAccountBridge(operation: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!tauri || !invoke) throw new Error(tr("This environment has no desktop account secure storage. Please use the desktop app or the online editor."));
  try {
    return await invoke('account_bridge', { operation, args });
  } catch (error) {
    if (isMissingAccountBridgeRejection(error) && await shellLacksAccountBridge(tauri)) throw new DesktopShellTooOldError();
    throw error;
  }
}
