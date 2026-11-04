/**
 * Online browser identity: desktop / mobile (semantics: "Identity" in `product/platforms.md`
 * "Online browser"; determination logic in `mechanism/platforms.md` "Identity").
 *
 * - Chromium-based browsers check `navigator.userAgentData.mobile`: true classifies as mobile;
 * - Browsers without `userAgentData` check user agent tokens: iPhone / iPod, or Android mobile
 *   tokens (`Android` with `Mobile`) classify as mobile.
 *   **Plain HTTP also takes this path**: `navigator.userAgentData` is only available in secure
 *   contexts; when opened over LAN via `http://192.168.x.y:port` ("second screen on LAN"),
 *   Chrome on Android cannot read it either, leaving only user agent tokens to check
 *   (revealed by end-to-end probes on 2026-10-26);
 * - Others are classified as desktop. If neither can be read, it is also classified as desktop.
 * - Safari on iPad defaults to a desktop declaration (`Macintosh` + multi-touch): treated as
 *   desktop before stage gates are implemented, but flagged as `ipadLike` in results; once the
 *   stage gate in `docs/plan/online-browser-task.md` is connected, those staying at tier 1 are
 *   reclassified as mobile (`resolveIpad`).
 *
 * Identity determines two things: render node (desktop acts as one, mobile does not) and UI
 * (mobile uses the mobile UI). The UI side does not check where the document service resides;
 * online pages and local editor pages share the same rule, see `pickLayout`. There is also a URL
 * parameter `?layout=mobile|desktop` for development and acceptance checks only, see `pickLayout`;
 * no user toggle is exposed in the UI.
 *
 * Does not import `mode.ts`; directly usable in Node unit tests (UA and others can be injected).
 */

export type DeviceKind = "desktop" | "phone";

export interface UaDataLike {
  mobile?: boolean;
}

export interface DeviceKindInput {
  ua?: string | null;
  uaData?: UaDataLike | null;
  maxTouchPoints?: number;
}

export interface DeviceKindResult {
  kind: DeviceKind;
  /** Which criterion was used for determination */
  by: "uaData" | "ua" | "none";
  /** Looks like an iPad (iPad token in user agent, or reports desktop Mac with multi-touch): currently treated as desktop, pending stage gate reclassification */
  ipadLike: boolean;
}

export function judgeDeviceKind(input: DeviceKindInput): DeviceKindResult {
  const ua = String(input.ua ?? "");
  const touch = input.maxTouchPoints ?? 0;
  const ipadLike = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
  const mobile = input.uaData?.mobile;
  if (typeof mobile === "boolean") return { kind: mobile ? "phone" : "desktop", by: "uaData", ipadLike: ipadLike && !mobile };
  // Android tablets lack `Mobile` in their tokens and are treated as desktop, like iPad
  if (ua) return { kind: /iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua)) ? "phone" : "desktop", by: "ua", ipadLike };
  return { kind: "desktop", by: "none", ipadLike: false };
}

/**
 * Used for iPad reclassification after stage gates are connected: reaching tier 2 or tier 3
 * counts as desktop, staying at tier 1 counts as mobile.
 * When the gate is not yet implemented, callers pass no tier and the result remains unchanged.
 */
export function resolveIpad(result: DeviceKindResult, stageGateLevel?: 1 | 2 | 3): DeviceKind {
  if (!result.ipadLike || stageGateLevel === undefined) return result.kind;
  return stageGateLevel >= 2 ? "desktop" : "phone";
}

/** Reads the identity of the current page */
export function currentDeviceKind(): DeviceKindResult {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { userAgentData?: UaDataLike }) : null;
  return judgeDeviceKind({ ua: nav?.userAgent ?? "", uaData: nav?.userAgentData ?? null, maxTouchPoints: nav?.maxTouchPoints ?? 0 });
}

export type Layout = "desktop" | "mobile";

/**
 * Selects UI: mobile identity goes to mobile UI, others go to desktop UI (semantics: "Identity"
 * in `product/platforms.md`).
 *
 * **Does not check where the document service resides**: online pages and local editor pages share
 * the same rule, so a mobile phone on the LAN opening a local project on the desktop machine also
 * gets the mobile UI ("second screen on LAN" in `product/platforms.md` "Desktop app").
 * The desktop app's own window (Tauri's WebView) reports a desktop declaration and keeps the
 * desktop UI as usual.
 *
 * `?layout=mobile|desktop` is for development and acceptance checks only (convenient for viewing
 * the mobile UI in desktop browsers); recognized by both page types, with no user toggle exposed
 * in the UI.
 */
export function pickLayout(opts: { kind: DeviceKind; search?: string }): Layout {
  let forced: string | null = null;
  try {
    forced = new URLSearchParams(opts.search ?? "").get("layout");
  } catch {
    forced = null;
  }
  if (forced === "mobile" || forced === "desktop") return forced;
  return opts.kind === "phone" ? "mobile" : "desktop";
}
