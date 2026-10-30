/**
 * 在线浏览器的身份：电脑 / 手机（语义 `product/platforms.md`「在线浏览器」的「身份」，
 * 判法见 `mechanism/platforms.md`「身份」）。
 *
 * - Chromium 系看 `navigator.userAgentData.mobile`：是就算手机；
 * - 没有 `userAgentData` 的看标识：有 iPhone / iPod，或安卓的手机标识（`Android` 且 `Mobile`）算手机。
 *   **明文 HTTP 上也走这一条**：`navigator.userAgentData` 只在安全上下文里有，局域网里用 `http://192.168.x.y:口`
 *   打开时（「局域网里的第二块屏」）安卓 Chrome 也读不到它，只剩标识可看（2026-10-26 端到端探针照出来的）；
 * - 其余算电脑。两样都读不到也算电脑。
 * - iPad 的 Safari 缺省报桌面声明（`Macintosh` + 多点触控）：舞台闸门实现之前按电脑算，
 *   但结果里标 `ipadLike`，以后 `docs/plan/online-browser-task.md` 的舞台闸门接上时，
 *   停在第一级的改判手机（`resolveIpad`）。
 *
 * 身份决定两件事：渲染节点（电脑当、手机不当）和界面（手机用手机版界面）。界面那一面不看文档服务在哪，
 * 在线页面与本机编辑器页面同一条规则，见 `pickLayout`。另有一个只给开发和验收用的地址参数
 * `?layout=mobile|desktop`，也见 `pickLayout`；不在界面上给用户开关。
 *
 * 不引 `mode.ts`，Node 单测直接用（UA 等都可注入）。
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
  /** 按哪一样判的 */
  by: "uaData" | "ua" | "none";
  /** 像 iPad（标识里有 iPad，或报桌面 Mac 却有多点触控）：现在按电脑算，等舞台闸门改判 */
  ipadLike: boolean;
}

export function judgeDeviceKind(input: DeviceKindInput): DeviceKindResult {
  const ua = String(input.ua ?? "");
  const touch = input.maxTouchPoints ?? 0;
  const ipadLike = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
  const mobile = input.uaData?.mobile;
  if (typeof mobile === "boolean") return { kind: mobile ? "phone" : "desktop", by: "uaData", ipadLike: ipadLike && !mobile };
  // 安卓平板的标识里没有 `Mobile`，和 iPad 一样按电脑算
  if (ua) return { kind: /iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua)) ? "phone" : "desktop", by: "ua", ipadLike };
  return { kind: "desktop", by: "none", ipadLike: false };
}

/**
 * 舞台闸门接上之后给 iPad 改判用：到了第二级或第三级算电脑，停在第一级算手机。
 * 闸门还没实现时调用方不传级别，结果不变。
 */
export function resolveIpad(result: DeviceKindResult, stageGateLevel?: 1 | 2 | 3): DeviceKind {
  if (!result.ipadLike || stageGateLevel === undefined) return result.kind;
  return stageGateLevel >= 2 ? "desktop" : "phone";
}

/** 读当前页面的身份 */
export function currentDeviceKind(): DeviceKindResult {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { userAgentData?: UaDataLike }) : null;
  return judgeDeviceKind({ ua: nav?.userAgent ?? "", uaData: nav?.userAgentData ?? null, maxTouchPoints: nav?.maxTouchPoints ?? 0 });
}

export type Layout = "desktop" | "mobile";

/**
 * 选界面：身份为手机的进手机版，其余进桌面界面（语义 `product/platforms.md`「身份」）。
 *
 * **不看文档服务在哪**：在线页面和本机编辑器页面同一条规则，所以局域网里的手机打开桌面那台机器上的本机项目
 * 也是手机版界面（`product/platforms.md`「桌面应用」的「局域网里的第二块屏」）。桌面应用自己的窗口
 * （Tauri 的 WebView）报的是桌面声明，照旧是桌面界面。
 *
 * `?layout=mobile|desktop` 只给开发和验收用（方便在桌面浏览器里看手机版），两种页面都认；界面上不给用户开关。
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
