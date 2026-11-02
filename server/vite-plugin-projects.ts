import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { tr } from "./i18n.mjs";

/**
 * Local drafts: each draft is a `.proc` file on disk.
 *
 * Stored under `.pc-projects/` at the project root (same approach as `.pc-chats/`, already in
 * `.gitignore`). Using real files instead of `localStorage` allows drafts to be backed up, copied,
 * and swapped with `.proc` files exported via "Save project": both sides share the same format,
 * and dropping an exported file back into this directory makes it a draft.
 */

const DIR = ".pc-projects";
const EXT = ".proc";

/**
 * Draft IDs only allow these characters: used directly as filenames, cannot let ../ escape
 * the directory
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Exported for testing: this check is the only barrier against path traversal, worth pinning down
 * separately
 */
export function isValidDraftId(id: string): boolean {
  return ID_RE.test(id);
}

function projectsDir(root: string): string {
  // PROMPTCUT_PROJECTS_DIR: tests and probes point the draft directory to a temp directory,
  // isolated from user drafts
  const dir = process.env.PROMPTCUT_PROJECTS_DIR || path.join(root, DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Location of a draft on disk. Exported for `vite-plugin-skill-state.ts`: exclusive locks need
 * to find the real file by draft ID, and directory rules (including `PROMPTCUT_PROJECTS_DIR`
 * overrides) should only define this once.
 */
export function draftFileFor(root: string, id: string): string | null {
  return fileFor(root, id);
}

/**
 * Atomically writes a draft: writes a temp file in the same directory, flushes to disk, then
 * renames over the destination. If the process dies midway, the old draft remains intact;
 * if any step fails, the temp file is cleaned up, leaving no partial file.
 */
function writeFileAtomic(file: string, body: string): void {
  // Target already exists but is not writable (read-only): error directly, do not rely on renaming
  // to bypass read-only (rename behavior for read-only files varies across platforms)
  if (fs.existsSync(file)) fs.accessSync(file, fs.constants.W_OK);
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, body, "utf8");
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* Failure to clean up does not alter the error to report */ }
    throw e;
  }
}

function fileFor(root: string, id: string): string | null {
  if (!isValidDraftId(id)) return null;
  return path.join(projectsDir(root), id + EXT);
}

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: { on: (ev: string, fn: (c?: unknown) => void) => void; destroy: () => void }, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      // An arrangement file is at most a few MB; exceeding that usually means media itself was stuffed in
      if (body.length > limit) {
        req.destroy();
        reject(new Error(tr("Project file too large")));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => reject(new Error(tr("Failed to read request body"))));
  });
}

/**
 * Picks out the fields to display in the list from `.proc` contents, catching corrupt files
 * as well
 */
function summarize(id: string, file: string) {
  const stat = fs.statSync(file);
  const base = { id, updatedAt: stat.mtime.toISOString(), size: stat.size };
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const project = doc?.project ?? doc;
    // A project can have multiple cuts: the active one is in tracks, while the rest are parked
    // in cuts[].tracks; the clip count in the list includes all of them
    const countTracks = (tracks: unknown) =>
      (Array.isArray(tracks) ? (tracks as { clips?: unknown[] }[]) : []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);
    const clips = countTracks(project?.tracks)
      + (Array.isArray(project?.cuts) ? (project.cuts as { tracks?: unknown }[]).reduce((n, c) => n + countTracks(c.tracks), 0) : 0);
    return {
      ...base,
      name: project?.name || id,
      duration: Number(project?.duration) || 0,
      clips,
      thumbnail: typeof doc?.thumbnail === "string" ? doc.thumbnail : null,
      broken: false,
    };
  } catch {
    // Corrupted files are also listed, so users can see and delete them rather than having them vanish
    // into thin air
    return { ...base, name: id, duration: 0, clips: 0, thumbnail: null, broken: true };
  }
}

/**
 * Local backups (C6.5, `docs/plan/c65-design.md` Sections 3 and 8): the entities of one's own
 * version before being overwritten by others, and modifications discarded while offline, are saved
 * by the page into `backups/` under the draft directory "before switching to the latest version",
 * one JSON file per backup. "Local backups…" in the "Project" menu lists them chronologically;
 * retrieving an individual backup restores it with a fresh write. The page submits them in the
 * `LocalBackup` shape from `docsync.ts`; this only adds an id without parsing the content.
 */
const BACKUP_DIR = "backups";
const BACKUP_ID_RE = /^[0-9]{13}-[a-z0-9]{6}$/;
/** Keep at most this many backups; delete the oldest when exceeded */
const BACKUP_KEEP = 500;

function backupsDir(root: string): string {
  const dir = path.join(projectsDir(root), BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The list only needs summaries: does not include entity values, does not include the whole
 * project
 */
function backupSummary(id: string, file: string) {
  try {
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    const entities = b.kind === "offline-discard"
      ? [...new Set((Array.isArray(b.batch) ? b.batch : []).flatMap((x: { entities?: string[] }) => (Array.isArray(x?.entities) ? x.entities : [])))]
      : [b.entity].filter((e: unknown) => typeof e === "string");
    return { id, kind: b.kind, projectId: b.projectId ?? null, projectName: b.projectName ?? null, entity: b.entity ?? null, entities, by: b.by ?? null, rev: b.rev ?? b.baseRev ?? null, at: Number(b.at) || 0, pageSession: typeof b.pageSession === "string" ? b.pageSession : null, broken: false };
  } catch {
    return { id, kind: null, projectId: null, projectName: null, entity: null, entities: [], by: null, rev: null, at: 0, broken: true };
  }
}

function handleBackups(root: string, req: import("node:http").IncomingMessage, res: ServerResponse): Promise<void> | void {
  const url = new URL(req.url || "/", "http://localhost");
  const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const dir = backupsDir(root);
  if (req.method === "GET" && !id) {
    const items = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => backupSummary(f.slice(0, -5), path.join(dir, f)));
    items.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    return sendJson(res, 200, { ok: true, backups: items });
  }
  if (req.method === "POST" && !id) {
    return readBody(req as never, 128 * 1024 * 1024).then((body) => {
      const b = JSON.parse(body);
      if (!b || typeof b !== "object" || (b.kind !== "overwritten" && b.kind !== "offline-discard")) {
        return sendJson(res, 400, { ok: false, error: tr("Unrecognized backup") });
      }
      const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
      const file = path.join(dir, `${newId}.json`);
      fs.writeFileSync(`${file}.tmp`, body, "utf8");
      fs.renameSync(`${file}.tmp`, file);
      const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
      for (const f of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) fs.rmSync(path.join(dir, f), { force: true });
      return sendJson(res, 200, { ok: true, id: newId, file });
    });
  }
  if (req.method === "GET") {
    if (!BACKUP_ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: "Invalid backup id" });
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: tr("Backup does not exist") });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(fs.readFileSync(file, "utf8"));
    return;
  }
  return sendJson(res, 405, { ok: false, error: "Only GET / POST are supported" });
}

export function projectsPlugin(): Plugin {
  return {
    name: "promptcut-projects",
    configureServer(server: ViteDevServer) {
      const root = server.config.root || process.cwd();

      server.middlewares.use("/api/project-backups", async (req, res) => {
        try {
          await handleBackups(root, req, res);
        } catch (e) {
          sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });

      server.middlewares.use("/api/projects", async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        // middlewares.use strips the mount prefix, so pathname here is "/" or "/<id>"
        const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

        try {
          if (req.method === "GET" && !id) {
            const dir = projectsDir(root);
            const items = fs
              .readdirSync(dir)
              .filter((f) => f.endsWith(EXT))
              .map((f) => summarize(f.slice(0, -EXT.length), path.join(dir, f)))
              // Most recently modified first, matching the intuition of "Local drafts"
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            return sendJson(res, 200, { ok: true, projects: items });
          }

          const file = fileFor(root, id);
          if (!file) return sendJson(res, 400, { ok: false, error: "Invalid draft id" });

          if (req.method === "GET") {
            if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: tr("Draft does not exist") });
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            return res.end(fs.readFileSync(file, "utf8"));
          }

          if (req.method === "PUT") {
            const body = await readBody(req as never);
            // Parse once first: better to throw an error here than write bad JSON as a draft
            JSON.parse(body);
            writeFileAtomic(file, body);
            return sendJson(res, 200, { ok: true, ...summarize(id, file) });
          }

          if (req.method === "DELETE") {
            if (fs.existsSync(file)) fs.unlinkSync(file);
            return sendJson(res, 200, { ok: true });
          }

          return sendJson(res, 405, { ok: false, error: "Only GET / PUT / DELETE are supported" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}

export default projectsPlugin;
