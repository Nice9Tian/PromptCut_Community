type TauriGlobal = {
  core?: { invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown> };
  app?: { getVersion?: () => Promise<string> };
};

/** 外壳从这一版起才有 `account_bridge` 命令（`desktop/src-tauri/src/account_vault.rs`，`lib.rs` 的 `invoke_handler` 里登记）。 */
export const ACCOUNT_BRIDGE_MIN_SHELL = '0.2.8';

/**
 * 老外壳上点账号入口时给用户看的话。更新补丁只换 Node 那一半，不换 Rust 外壳；`account_bridge` 在外壳里，
 * 所以补丁装不出这个功能，要装完整安装包（用户 2026-10-17 定：补丁的最低外壳仍是 0.2.0，不抬，入口自己说明）。
 */
export const OLD_SHELL_ACCOUNT_TEXT =
  '这个功能要装完整安装包。你现在用的桌面外壳比较旧，只装更新补丁换不掉它，云端项目和账号登录要新外壳才能用；请安装最新的完整安装包。本地项目不受影响，照常可用。';

/** 外壳里没有账号桥时抛这个。界面按 `code` 或 `isDesktopShellTooOld` 认，别拿文案比。 */
export class DesktopShellTooOldError extends Error {
  readonly code = 'desktop-shell-too-old';
  constructor() { super(OLD_SHELL_ACCOUNT_TEXT); this.name = 'DesktopShellTooOldError'; }
}

export function isDesktopShellTooOld(error: unknown): boolean {
  return error instanceof DesktopShellTooOldError || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'desktop-shell-too-old');
}

/**
 * Tauri 2 对「外壳里没有、或没放行这个命令」的调用，拒绝时给的就是下面三句话（逐字，整句匹配）。出处是 tauri 2.11 的
 * `src/webview/mod.rs`（`Command {cmd} not allowed by ACL` / `Command {command} not found`）和 `src/ipc/authority.rs`
 * （调试版的 `{cmd} not allowed. Command not found` / `... Plugin not found`）：
 * - 老外壳（0.2.0～0.2.7）的 `build.rs` 没有登记 `account_bridge`，权限清单里也没有它；页面又是 127.0.0.1:5210 的「远程来源」，
 *   所以在发布版上拿到第一句；没有应用权限清单的更老外壳、本地来源的调用是第二句；调试版是第三句。
 * - 新外壳自己的错误只有 `account_vault.rs` 里那几个 `desktop-account-*` 代号，和这三句不会撞；新外壳权限配错时
 *   说的是 `... not allowed on window ...` 那一长句，也不匹配，照常原样抛出。
 * 一律不用「消息里含有 not found / ACL」这类宽松匹配：宽松了就会把真错误也说成外壳太老。
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

/** 一次 `account_bridge` 调用被拒，拒绝的原话是不是「这个外壳没有这个命令」 */
export function isMissingAccountBridgeRejection(rejection: unknown): boolean {
  const text = rejectionText(rejection);
  return text !== null && MISSING_COMMAND_REJECTIONS.some((pattern) => pattern.test(text));
}

function versionParts(version: unknown): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === 'string' ? version.trim() : '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** 外壳版本不低于 0.2.8（有账号桥）：true / false；读不出版本：null */
export function shellHasAccountBridge(version: unknown): boolean | null {
  const have = versionParts(version), need = versionParts(ACCOUNT_BRIDGE_MIN_SHELL);
  if (!have || !need) return null;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}

/**
 * 拒绝的原话像「没有这个命令」时再核一次外壳版本，防止新外壳权限配错时被说成「外壳太老」：
 * 读得出版本且不低于 0.2.8，就不是外壳太老，照常报原来的错；读不出（更老的外壳连 `core:default` 都没放给远程页面）按外壳太老算。
 */
async function shellLacksAccountBridge(tauri: TauriGlobal): Promise<boolean> {
  let version: unknown = null;
  try { version = await tauri.app?.getVersion?.(); } catch { /* 读不出版本 */ }
  return shellHasAccountBridge(version) !== true;
}

/**
 * The native bridge checks the actual main WebView label and URL. Cards get no vault API.
 * 外壳里没有这个命令（0.2.8 以前的外壳打了补丁）抛 `DesktopShellTooOldError`；其它错误原样抛。
 */
export async function desktopAccountBridge(operation: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!tauri || !invoke) throw new Error('此环境没有桌面账号安全存储，请使用桌面版或在线编辑器。');
  try {
    return await invoke('account_bridge', { operation, args });
  } catch (error) {
    if (isMissingAccountBridgeRejection(error) && await shellLacksAccountBridge(tauri)) throw new DesktopShellTooOldError();
    throw error;
  }
}
