import { tr } from "../i18n/index.ts";
/**
 * Device identity for browser-only mode (C10a contract `docs/plan/c10a-contract.md` section 2;
 * main execution plan section 12.2 "Device name").
 *
 * Online browser mode has no editor process and does not call `GET /api/docservice/device`:
 * - Device id: 128-bit random number, base64url (22 characters, within the 16-64 `[A-Za-z0-9_-]`
 *   characters of auth contract `deviceId`);
 * - Device name: "browser name + OS name + 4 random digits", e.g. `Chrome · Android · 4821`;
 * - Both are stored locally in the page (localStorage `pc.online.device`), identifying the same
 *   device on subsequent opens. If local storage is unavailable (incognito mode, disabled), it is
 *   only valid for this session.
 * Desktop runtime environments are provided by the editor process as before (`loadDevice` in
 * `syncManager.ts`).
 *
 * Does not import `mode.ts`; directly usable in Node unit tests (UA and storage can be injected).
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

/** UA → browser name and OS name (for display only; writes "Browser" and "Unknown OS" if unrecognized) */
export function browserLabel(ua: string, uaData?: UaData | null, maxTouchPoints = 0): { browser: string; os: string } {
  const s = String(ua || "");
  let browser = tr("Browser");
  if (/MicroMessenger/i.test(s)) browser = tr("WeChat");
  else if (/EdgA?\/|Edg\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/Firefox\/|FxiOS\//.test(s)) browser = "Firefox";
  else if (/CriOS\/|Chrome\/|Chromium\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari";
  const brands = uaData?.brands?.map((b) => b.brand) ?? [];
  if (browser === tr("Browser") && brands.length) browser = brands.find((b) => !/Not.?A.?Brand|Chromium/i.test(b)) ?? brands[0];
  let os = tr("Unknown OS");
  const platform = uaData?.platform ?? "";
  if (/iPhone|iPod/.test(s)) os = "iOS";
  else if (/iPad/.test(s) || (/Macintosh/.test(s) && maxTouchPoints > 1)) os = "iPadOS"; // iPads often report desktop UAs
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

/** Gets (generating and storing if necessary) the device identity of this browser */
export function loadBrowserDevice(deps: DeviceDeps = {}): BrowserDevice {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const random = deps.random ?? ((b: Uint8Array) => globalThis.crypto.getRandomValues(b));
  try {
    const saved = JSON.parse(storage?.getItem(DEVICE_KEY) ?? "null") as Partial<BrowserDevice> | null;
    if (saved && typeof saved.deviceId === "string" && ID_RE.test(saved.deviceId) && typeof saved.deviceName === "string" && saved.deviceName.trim()) {
      return { deviceId: saved.deviceId, deviceName: saved.deviceName.slice(0, 64) };
    }
  } catch {
    /* Stored data is corrupted: regenerate */
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
    /* Cannot persist: use only for this session */
  }
  if (deps.storage === undefined) memo = device;
  return device;
}
