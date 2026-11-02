/**
 * The "real picture", aspect ratio and duration on a start-page thumbnail cell: recorded when this
 * browser opened the project.
 *
 * The cloud project list (`/api/account/projects`) gives only the project id and name, not the aspect
 * ratio, duration or first frame; without entering a project its content cannot be obtained, and there
 * is no interface that fetches a first-frame snapshot without entering the project. So the approach in
 * this version ([ruling vibe-wire-1], level 3: users cannot tell the difference between methods, they
 * only see whether there is a picture):
 *   - When a project is opened in Vibe mode (the document service is already connected and the project
 *     content is on the page), record its aspect ratio and duration;
 *   - The first frame is the frame of "the topmost visible video / image media at second 0" (taken the
 *     same way as the mobile app's media cells, `src/mobile/thumbs.ts` and `Thumb.tsx`: decoded through
 *     a preview URL of the asset service that carries a read-only ticket, and shrunk to a small JPEG);
 *     once obtained, it is recorded;
 *   - Never opened, only cards and no media, or cannot be obtained (decode failed, cross-origin content
 *     cannot be drawn onto the canvas): the cell falls back to the original color block, so there is no
 *     blank and no broken image.
 * It is not the composited whole frame (how cards overlay on media can only be drawn by the stage, and
 * the stage lives in a cross-origin iframe whose pixels the parent page cannot read).
 * To get "the composited first frame given by the prerender" an interface that fetches a first-frame
 * snapshot per project would have to be added on the server side; it is listed as a to-do (the report's
 * "Not done" section).
 *
 * Recorded locally (localStorage), keeping only the most recent `MAX` projects; reads and writes are
 * wrapped in try/catch, and when it cannot be read it is treated as never recorded.
 */
import type { SeenMeta } from "./vibeOrg.ts";
import type { Ratio } from "./types.ts";

const KEY = "pc.start.seen";
/** How many projects to record at most (each thumbnail is a dozen or so KB) */
const MAX = 40;

type Store = Record<string, SeenMeta>;

function read(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Store = {};
    for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const ratio = r.ratio === "16:9" || r.ratio === "9:16" || r.ratio === "1:1" ? (r.ratio as Ratio) : null;
      out[id] = {
        ratio,
        duration: typeof r.duration === "number" && Number.isFinite(r.duration) ? r.duration : null,
        thumb: typeof r.thumb === "string" && r.thumb.startsWith("data:image/") ? r.thumb : null,
        seenAt: typeof r.seenAt === "string" ? r.seenAt : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
let cache: Store | null = null;

export function seenProjects(): Store {
  if (!cache) cache = read();
  return cache;
}

export function subscribeSeen(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Record a project's picture info. Only the given fields are changed; the oldest ones beyond MAX are dropped */
export function rememberSeen(projectId: string, patch: Partial<SeenMeta>): void {
  const all = { ...seenProjects() };
  const prev = all[projectId] ?? { ratio: null, duration: null, thumb: null, seenAt: null };
  const next: SeenMeta = { ...prev, ...patch };
  if (prev.ratio === next.ratio && prev.duration === next.duration && prev.thumb === next.thumb && prev.seenAt === next.seenAt) return;
  all[projectId] = next;
  const ids = Object.keys(all).sort((a, b) => (all[b].seenAt ?? "").localeCompare(all[a].seenAt ?? ""));
  for (const id of ids.slice(MAX)) delete all[id];
  cache = all;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage is full: drop the thumbnail and try again, keeping at least the aspect ratio and duration
    try {
      const slim: Store = {};
      for (const [id, m] of Object.entries(all)) slim[id] = { ...m, thumb: id === projectId ? m.thumb : null };
      localStorage.setItem(KEY, JSON.stringify(slim));
      cache = slim;
    } catch { /* If it cannot be saved, it is only valid for this session of the page */ }
  }
  for (const l of [...listeners]) l();
}
