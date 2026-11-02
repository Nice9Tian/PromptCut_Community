import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse, IncomingMessage } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { tr } from "./i18n.mjs";

/**
 * SKILL mode toggle endpoints, plus an exclusive lock for .proc.
 *
 * Separated from vite-plugin-skill.ts: that side handles "how the desktop app connects"
 * (registration), while this side handles "whether SKILL is enabled" (gate state,
 * server/skill-gate.mjs).
 *
 * Endpoints:
 *   GET  /api/skill-mode              Whether currently in SKILL mode (frontend polls once per second, Rust shell reads file directly)
 *   POST /api/skill-mode/open         Enable (user switches to SKILL in top bar)
 *   POST /api/skill-mode/close        Disable (user switches back to Classic mode)
 *   POST /api/skill-mode/last-action  Page returns the frame of the previous action in the desktop session for the SKILL floating window
 *   POST /api/skill-lock/acquire      .proc exclusive lock: acquire when opening a project
 *   POST /api/skill-lock/release      Release lock
 */

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => reject(new Error(tr("Failed to read request body"))));
  });
}

interface LockFile {
  pid: number;
  at: string;
  /** Who holds the lock; used for conflict notices */
  host: string;
}

function lockPathFor(procPath: string): string {
  return procPath + ".lock";
}

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive lock on a .proc.
 *
 * Why exclusive: if two PromptCut instances open the same .proc simultaneously, each writes back
 * based on its own in-memory state, and the later write completely overwrites the earlier one:
 * not a merge, but data loss. Therefore, only one instance is permitted to write to a file.
 * The same applies in SKILL mode: the desktop app session modifies the project in this instance,
 * without creating a separate replica.
 *
 * # Two layers of criteria; the order must not be reversed
 *
 * The lock is a sidecar file `<name>.proc.lock` (**not the .proc itself**: in testing, exclusively
 * locking the file itself prevented Node from even reading it, locking out our own process).
 * Test "whether someone holds it" in order from highest to lowest reliability:
 *
 * 1. **From the kernel**: getting EBUSY from `open(lock,'r+')` indicates a process is holding
 *    this handle in share mode 0 (done by the Rust shell in the desktop app, see
 *    desktop/src-tauri/src/proc_lock.rs). This signal is the most solid: as soon as the holder
 *    dies, the kernel immediately reclaims the handle, so deadlocks do not exist and no liveness
 *    check is needed.
 * 2. **pid in the lock file**: when there is no shell (during development `npm run dev`, running
 *    in a browser), we can only fall back to this. It has two weaknesses: if the holder is
 *    forcefully killed, a dead lock file is left behind; pids can be recycled by the OS, so if a
 *    dead process's pid is assigned to a new process, it is misjudged as "someone is still holding
 *    it". Thus it is merely a fallback; avoid it whenever criterion 1 is usable.
 *
 * Creation uses `open(path,'wx')` rather than "existsSync first, then write": the latter is not
 * atomic, and two instances can pass the check simultaneously and both assume they acquired the
 * lock. wx is atomic (in testing with 20 processes competing concurrently, exactly 1 won).
 */
export function acquireLock(procPath: string, retriesLeft = 3): { ok: boolean; error?: string; stolen?: boolean; by?: "kernel" | "pid" } {
  const file = lockPathFor(procPath);
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: "promptcut" });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic creation. If acquired, it belongs to me; no need to check anything else
    try {
      fs.writeFileSync(file, mine, { flag: "wx" });
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    // The file already exists. First ask the kernel: is anyone holding its handle
    try {
      fs.closeSync(fs.openSync(file, "r+"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EBUSY") {
        return { ok: false, by: "kernel", error: tr("This project file is already open in another PromptCut") };
      }
      // Treat other errors (permissions, etc.) as failure to acquire the lock, but explain the reason
      return { ok: false, error: tr("Cannot read lock file: {0}", (e as Error).message) };
    }

    // No one is holding the handle; fall back to the weak pid criterion.
    // Lock files whose contents cannot be read are treated as **unowned**: 0-byte locks really do
    // occur: if Rust opens it with create flags during a liveness check, an empty file is left
    // behind. Previously JSON.parse threw here, caught by the outermost fallback ("failure to write
    // a lock should not block opening a project") which returned ok:true: consequently, neither side
    // actually acquired the lock, the pid defense line permanently failed for this project, and
    // there was no notice whatsoever.
    let cur: LockFile | null = null;
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      const parsed = raw ? (JSON.parse(raw) as LockFile) : null;
      if (parsed && typeof parsed.pid === "number") cur = parsed;
    } catch { /* Invalid content → unowned */ }

    if (cur && cur.pid === process.pid) return { ok: true };
    if (cur && pidAlive(cur.pid)) {
      return { ok: false, by: "pid", error: tr("This project file is already open in another PromptCut (process {0}, since {1})", cur.pid, cur.at) };
    }

    /*
     * The previous holder is gone (crashed / killed), or this is an empty shell lock: take over.
     *
     * # Takeover itself must be atomic
     *
     * Simply "delete and re-acquire" is not enough; this is where the previous version failed:
     * deletion is **unconditional**, and does not check whether the file is still the one judged dead
     * just now. A slight timing offset between two instances results in:
     *
     *   B: Reads dead pid, decides it can take over            (not deleted yet)
     *   A: Reads dead pid → deletes → wx creates new lock → wins   (lock now holds A's pid)
     *   B: Proceeds, deletes **the lock A just created** → wx → also wins
     *
     * Both receive ok:true, and two PromptCut instances write to the same .proc together.
     * (The original test had 12 processes running in lockstep, which happened to mask this staggered timing.)
     *
     * # Fix: atomically claim the takeover right first, then take over
     *
     * Use `wx` to create a sidecar `.claim` file: this step is atomic, and only one process can
     * create it. The one that succeeds is eligible to delete the old lock; those that fail go back
     * to repeat the normal check: by then the old lock has either been replaced with a live pid by
     * the winner (so it is correctly rejected), or happens not to be created yet (so it wins via wx
     * itself). In either case, there is only one winner.
     *
     * claim exists only for these few microseconds. If the process holding the claim happens to be
     * killed in the middle, the claim will remain: therefore, we also perform a liveness check on
     * the claim below and clean it up if dead, preventing a leftover file from permanently locking
     * the project.
     */
    if (retriesLeft <= 0) {
      return { ok: false, error: tr("The lock file was repeatedly taken by others, please try again later") };
    }

    const claim = file + ".claim";
    try {
      fs.writeFileSync(claim, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Someone is taking over the same dead lock. First check whether that process is still alive
      let holder: number | null = null;
      try {
        const raw = fs.readFileSync(claim, "utf8").trim();
        const parsed = raw ? (JSON.parse(raw) as LockFile) : null;
        if (parsed && typeof parsed.pid === "number") holder = parsed.pid;
      } catch { /* If unreadable, treat as unowned */ }
      if (holder === null || !pidAlive(holder)) {
        try { fs.unlinkSync(claim); } catch { /* Someone else cleaned it up first; ignore */ }
      }
      // Go back and repeat the normal evaluation: the winner has likely created the new lock by now
      return acquireLock(procPath, retriesLeft - 1);
    }

    try {
      // Only the process that acquired the claim reaches here
      try {
        fs.unlinkSync(file);
      } catch (e) {
        // If it cannot be deleted, it is likely held by someone else (the shell's kernel handle)
        // at this moment: that means a live lock, not a dead lock
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          return { ok: false, by: "kernel", error: tr("This project file is already open in another PromptCut") };
        }
      }
      const again = acquireLock(procPath, retriesLeft - 1);
      return again.ok ? { ...again, stolen: true } : again;
    } finally {
      try { fs.unlinkSync(claim); } catch { /* Already gone, ignore */ }
    }
  } catch (e) {
    // Inability to write a lock (e.g. read-only directory) should not block opening a project entirely
    return { ok: true, error: (e as Error).message };
  }
}

export function releaseLock(procPath: string): void {
  const file = lockPathFor(procPath);
  try {
    // Also clean up shell locks (0-byte files left by Rust liveness checks): leaving it means
    // the next acquire has to go through another "unowned → delete → re-acquire" pass. If someone
    // actually holds the handle, unlink will fail on its own and will not mistakenly delete it.
    const raw = fs.readFileSync(file, "utf8").trim();
    let cur: LockFile | null = null;
    try { cur = raw ? (JSON.parse(raw) as LockFile) : null; } catch { cur = null; }
    if (!cur || cur.pid === process.pid) fs.unlinkSync(file);
  } catch {
    /* If there is no lock, it is not my lock, or the shell is holding it (cannot delete), ignore */
  }
}

export function skillStatePlugin(): Plugin {
  return {
    name: "promptcut-skill-state",
    configureServer(server: ViteDevServer) {
      /** Locks held by this process; release together on exit */
      const held = new Set<string>();
      const releaseAll = () => {
        for (const p of held) releaseLock(p);
        held.clear();
      };
      server.httpServer?.on("close", releaseAll);
      process.on("exit", releaseAll);

      server.middlewares.use("/api/skill-mode", async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const action = url.pathname.replace(/^\/+/, "");
        try {
          const gate = await import(new URL("./skill-gate.mjs", import.meta.url).href);
          if (!action && req.method === "GET") {
            return sendJson(res, 200, { ok: true, state: gate.readState() });
          }
          if (action === "open" && req.method === "POST") {
            await readBody(req);
            return sendJson(res, 200, { ok: true, state: gate.openGate() });
          }
          // The page returns the frame for "the timeline action completed in the previous step of the desktop
          // session" (requested by the editor process via SSE skill.preview): written to
          // skillRoot/last-action.{png,json}, and the shell watcher (desktop/src-tauri/src/skill_shell.rs)
          // watches the json modification time and pushes it to the floating window. Not accepted when
          // SKILL mode is disabled: the floating window only exists in SKILL mode.
          if (action === "last-action" && req.method === "POST") {
            if (!gate.readState().active) {
              return sendJson(res, 200, { ok: true, skipped: "skill-off" });
            }
            const body = JSON.parse((await readBody(req)) || "{}");
            const base64 = typeof body.base64 === "string" ? body.base64 : "";
            const png = Buffer.from(base64, "base64");
            if (png.length < 8 || png.subarray(0, 8).toString("binary") !== "\x89PNG\r\n\x1a\n") {
              return sendJson(res, 400, { ok: false, error: "base64 is not a png" });
            }
            const root = gate.skillRoot();
            fs.mkdirSync(root, { recursive: true });
            // Save png to a temporary file first then rename: the shell reads every second, and reading
            // half an image wastes a push
            const pngPath = path.join(root, "last-action.png");
            fs.writeFileSync(pngPath + ".tmp", png);
            fs.renameSync(pngPath + ".tmp", pngPath);
            const meta = {
              tool: typeof body.tool === "string" ? body.tool.slice(0, 64) : null,
              clipId: typeof body.clipId === "string" ? body.clipId.slice(0, 64) : null,
              t: typeof body.t === "number" && Number.isFinite(body.t) ? body.t : null,
              at: new Date().toISOString(),
            };
            const jsonPath = path.join(root, "last-action.json");
            fs.writeFileSync(jsonPath + ".tmp", JSON.stringify(meta), "utf8");
            fs.renameSync(jsonPath + ".tmp", jsonPath);
            return sendJson(res, 200, { ok: true, ...meta, bytes: png.length });
          }
          if (action === "close" && req.method === "POST") {
            const body = JSON.parse((await readBody(req)) || "{}");
            const state = gate.closeGate(body.by || "user");
            // Log a line to sidecar log: when a user reports "Closing… stuck", first check here if the request was received
            console.log(`[skill-mode] close by=${body.by || "user"} at=${state.closedAt}`);
            return sendJson(res, 200, { ok: true, state });
          }
          return sendJson(res, 404, { ok: false, error: "API not available" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });

      server.middlewares.use("/api/skill-lock", async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        const url = new URL(req.url || "/", "http://localhost");
        const action = url.pathname.replace(/^\/+/, "");
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          /*
           * The frontend usually only has a draft id (path rules are on the server, and can be modified
           * by PROMPTCUT_PROJECTS_DIR), so both are accepted here: draftId is resolved into the actual path
           * by the projects plugin, while path is reserved for callers that already know the absolute path.
           */
          let raw = body.path;
          if (!raw && body.draftId) {
            const { draftFileFor } = await import(new URL("./vite-plugin-projects.ts", import.meta.url).href);
            raw = draftFileFor(server.config.root || process.cwd(), String(body.draftId));
            if (!raw) return sendJson(res, 400, { ok: false, error: "Invalid draft id" });
          }
          if (!raw) return sendJson(res, 400, { ok: false, error: "path or draftId is required" });
          const target = path.resolve(String(raw));
          if (action === "acquire") {
            const out = acquireLock(target);
            if (out.ok) held.add(target);
            // Return the resolved actual path to the frontend: the desktop shell layer needs it to
            // exclusively hold the kernel handle
            return sendJson(res, out.ok ? 200 : 409, { ...out, file: target });
          }
          if (action === "release") {
            releaseLock(target);
            held.delete(target);
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 404, { ok: false, error: "API not available" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}

export default skillStatePlugin;
