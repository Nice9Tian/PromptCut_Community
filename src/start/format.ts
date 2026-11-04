import { tr } from "../i18n/index.ts";
/** Display formats used on the start page: duration and time. Used to live in `mockProjects.ts`; moved here after the mock data was removed */

/** Duration as mm:ss; over one hour as h:mm:ss. 0 seconds is an empty project that hasn't been cut yet; unknown (never opened in this browser) gives an empty string */
export function humanDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "";
  if (sec <= 0) return tr("Empty project");
  const s = Math.round(sec);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Time shown in the list: today shows only hours and minutes, this year shows month and day, earlier shows year, month and day */
export function humanWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.getFullYear() === now.getFullYear()) return tr("{0}/{1}", d.getMonth() + 1, d.getDate());
  return tr("{1}/{2}/{0}", d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Map a project's width and height to one of the three aspect ratios (close ones go to the nearest) */
export function ratioOf(width: number, height: number): "16:9" | "9:16" | "1:1" | null {
  if (!(width > 0) || !(height > 0)) return null;
  const r = width / height;
  if (r > 1.2) return "16:9";
  if (r < 0.83) return "9:16";
  return "1:1";
}

/** Project sizes for the three aspect ratios: a new project's size is set by the one clicked on the start page */
export const RATIO_SIZE = { "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 } } as const;

/** Name of a project created from the start page's "say one sentence" box: the first part of the sentence, newlines removed; an empty one is named "Untitled" */
export function projectNameFromPrompt(text: string, max = 24): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return tr("Untitled");
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : line;
}

/**
 * Project names in this service are **unique site-wide** (`nameKey` in `server/auth/protocol.mjs`,
 * "Room name occupied" in `server/auth/store.mjs`; creating a project with a duplicate name returns
 * 409 `name-taken`, and case 3 of `account-move.test.mjs` states it as "another account creating a
 * project with the same name returns name-taken").
 *
 * On the start page, the names on these two paths are **picked automatically**: a blank project is
 * always named "Untitled", and a say-one-sentence project takes the first part of that sentence.
 * Since the name is chosen by the machine, a user who collides with someone else's project of the
 * same name has no way to fix it: the second person to click "New project" gets blocked by
 * "This project name is already in use" (2026-10-23 live test: a brand-new guest clicking
 * "New project" always got 409).
 * So on a collision we switch to another name and retry: first the original name, then "name 2" ...
 * "name 5", and if that still collides, append four random digits.
 * Names are capped at 64 characters (`isProjectName`) and the start page's names are at most 24
 * characters long, so the suffix never exceeds the cap.
 */
export function nextProjectName(base: string, attempt: number): string {
  if (attempt <= 0) return base;
  if (attempt <= 4) return `${base} ${attempt + 1}`;
  return `${base} ${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;
}

/**
 * Try creating with `nextProjectName` one name at a time, until it succeeds (returns the name that
 * was used) or `tries` attempts are used up.
 * Only `name-taken` triggers a rename and retry; other errors (not logged in, guest over quota,
 * network down) are thrown to the caller unchanged.
 */
export async function createWithFreeName(
  create: (name: string) => Promise<void>, base: string, tries = 8,
): Promise<string> {
  for (let i = 0; ; i++) {
    const name = nextProjectName(base, i);
    try { await create(name); return name; } catch (e) {
      if (i >= tries - 1 || (e as { code?: string })?.code !== "name-taken") throw e;
    }
  }
}
