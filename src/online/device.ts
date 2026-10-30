/**
 * 纯浏览器的设备身份（C10a 契约 `docs/plan/c10a-contract.md` 第 2 节；主执行计划 12.2 节「设备名」）。
 *
 * 在线浏览器模式没有编辑器进程，不经 `GET /api/docservice/device`：
 * - 设备 id：128 位随机数，base64url（22 个字符，落在 auth 契约 `deviceId` 的 16～64 个 `[A-Za-z0-9_-]` 里）；
 * - 设备名：「浏览器名 + 系统名 + 随机 4 位」，例如 `Chrome · Android · 4821`；
 * - 两样都存在页面本地（localStorage `pc.online.device`），下次打开还是同一台设备。本地存不了（隐私模式、被禁用）时
 *   只在这一次会话里有效。
 * 桌面运行环境照旧由编辑器进程给（`syncManager.ts` 的 `loadDevice`）。
 *
 * 不引 `mode.ts`，Node 单测直接用（UA 与存储都可注入）。
 */

export interface BrowserDevice {
  deviceId: string;
  deviceName: string;
}

export const DEVICE_KEY = "pc.online.device";

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

interface UaData {
  brands?: { brand: string; version?: string }[];
  platform?: string;
  mobile?: boolean;
}

/** UA → 浏览器名与系统名（只为给人看；识别不了就写「浏览器」「未知系统」） */
export function browserLabel(ua: string, uaData?: UaData | null, maxTouchPoints = 0): { browser: string; os: string } {
  const s = String(ua || "");
  let browser = "浏览器";
  if (/MicroMessenger/i.test(s)) browser = "微信";
  else if (/EdgA?\/|Edg\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/Firefox\/|FxiOS\//.test(s)) browser = "Firefox";
  else if (/CriOS\/|Chrome\/|Chromium\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari";
  const brands = uaData?.brands?.map((b) => b.brand) ?? [];
  if (browser === "浏览器" && brands.length) browser = brands.find((b) => !/Not.?A.?Brand|Chromium/i.test(b)) ?? brands[0];
  let os = "未知系统";
  const platform = uaData?.platform ?? "";
  if (/iPhone|iPod/.test(s)) os = "iOS";
  else if (/iPad/.test(s) || (/Macintosh/.test(s) && maxTouchPoints > 1)) os = "iPadOS"; // iPad 常报桌面 UA
  else if (/Android/i.test(s) || /Android/i.test(platform)) os = "Android";
  else if (/Windows/i.test(s) || /Windows/i.test(platform)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(s) || /macOS/i.test(platform)) os = "macOS";
  else if (/CrOS/.test(s) || /Chrome OS/i.test(platform)) os = "ChromeOS";
  else if (/Linux/i.test(s) || /Linux/i.test(platform)) os = "Linux";
  return { browser, os };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface DeviceDeps {
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  random?: (bytes: Uint8Array) => Uint8Array;
  ua?: string;
  uaData?: UaData | null;
  maxTouchPoints?: number;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

let memo: BrowserDevice | null = null;

/** 取（必要时生成并存下）这台浏览器的设备身份 */
export function loadBrowserDevice(deps: DeviceDeps = {}): BrowserDevice {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const random = deps.random ?? ((b: Uint8Array) => globalThis.crypto.getRandomValues(b));
  try {
    const saved = JSON.parse(storage?.getItem(DEVICE_KEY) ?? "null") as Partial<BrowserDevice> | null;
    if (saved && typeof saved.deviceId === "string" && ID_RE.test(saved.deviceId) && typeof saved.deviceName === "string" && saved.deviceName.trim()) {
      return { deviceId: saved.deviceId, deviceName: saved.deviceName.slice(0, 64) };
    }
  } catch {
    /* 存的东西坏了：重新生成 */
  }
  if (deps.storage === undefined && memo) return memo;
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { userAgentData?: UaData }) : null;
  const { browser, os } = browserLabel(deps.ua ?? nav?.userAgent ?? "", deps.uaData ?? nav?.userAgentData ?? null, deps.maxTouchPoints ?? nav?.maxTouchPoints ?? 0);
  const idBytes = random(new Uint8Array(16));
  const tail = random(new Uint8Array(2));
  const four = String(((tail[0] << 8) | tail[1]) % 10000).padStart(4, "0");
  const device = { deviceId: b64url(idBytes), deviceName: `${browser} · ${os} · ${four}`.slice(0, 64) };
  try {
    storage?.setItem(DEVICE_KEY, JSON.stringify(device));
  } catch {
    /* 存不了：只在这次会话里用 */
  }
  if (deps.storage === undefined) memo = device;
  return device;
}
