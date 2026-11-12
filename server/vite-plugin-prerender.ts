import type { Plugin, ViteDevServer } from "vite";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { isPrerender } from "./render-role.mjs";
import { prerenderState, setPrerender } from "./prerender-client.mjs";
import { repushMirror, replayReadySessions } from "./vite-plugin-mirror";
import { stageOriginsOf, stagePortsOf } from "./stage-ports.mjs";
import { listenSafe } from "./safe-port.mjs";
import { createSessionLineForwarder } from "./render-node/session-diag.mjs";
import { autoRenderNodeOffReason, normalizeBinding, ticketOk } from "./auto-render-node.mjs";
import { createBindingMemory, createTicketRelay } from "./render-node-relay.mjs";
import { createRenderServerPool } from "./render-server-pool.mjs";
import { localPrerenderMode } from "./prerender-mode.mjs";
import { tr } from "./i18n.mjs";

/**
 * Spawns and supervises the prerender process (docs/archive/topics/decoupling-plan.md
 * Section 3 "Prerender", Phase 2).
 *
 * As soon as the dev server on the editor side starts listening, it spawns a second Vite instance
 * (vite.prerender.config.ts) using the same node on another port, with **process priority set to
 * below normal**. The render workers and Chrome instances it spawns inherit this priority
 * (on Windows, child processes inherit the parent's BELOW_NORMAL by default), so even if the Agent
 * opens several Chrome instances rendering concurrently, the system still allocates CPU first
 * to the editor and the UI's own pair of hot-standby renderers.
 *
 * The page gets its address from /api/prerender/info, and long-running requests (prerender,
 * animated GIFs, export progress) are sent directly to it.
 */

/**
 * Stops restarting after several consecutive crashes, avoiding endlessly respawning a process
 * that fails to start
 */
const MAX_RESTARTS = 5;

/**
 * Picks an available port for the prerender process. Cannot simply `listen(0)`: machines where
 * the dynamic port range is shifted low may get "bad ports" like 1719, 6000, or 6665, which
 * browsers reject with ERR_UNSAFE_PORT and Node fetch reports as bad port; no one can connect
 * even when the prerender process is up. `listenSafe` switches to another port if it hits a bad
 * one (server/safe-port.mjs).
 */
async function freePort(): Promise<number> {
  const s = net.createServer();
  s.unref();
  const port = await listenSafe(s, "127.0.0.1");
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** Different ways the browser might open the editor side: prerender cross-origin allowlist */
/**
 * Origins allowed for the prerender process. The editor's own origin, **plus origins for the two
 * stage ports** (E1): when the page inside the stage iframe calls the prerender process (snapshot
 * bytes in J3, SSE in C3), its Origin header carries its own origin, not the editor's: missing it
 * results in blanket 403s.
 */
function editorOrigins(server: ViteDevServer): string[] {
  const addr = server.httpServer?.address() as AddressInfo | null;
  const port = addr?.port || server.config.server.port || 5190;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...stageOriginsOf(port)];
}

/**
 * Where the bin used to spawn the second Vite instance is located.
 *
 * Check `<root>/node_modules/vite/bin/vite.js` first (standard installation); **resolve as a module
 * if not found**: a git worktree has no `node_modules` of its own (Node traverses up to the main
 * repository's copy), and the same applies to pnpm's non-hoisted layout. Hardcoding paths prevents
 * the prerender process from starting at all in either case, and the only symptom is "never ready",
 * making it hard to diagnose as a resolution problem.
 *
 * Vite's `exports` does not allow `./bin/vite.js`, so resolve the main entry point and walk back
 * to the package root.
 */
function viteBin(root: string): string {
  const local = path.join(root, "node_modules", "vite", "bin", "vite.js");
  if (fs.existsSync(local)) return local;
  try {
    const main = createRequire(import.meta.url).resolve("vite");
    const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
    if (at < 0) return local;
    const guess = path.join(main.slice(0, at + 6), "bin", "vite.js");
    return fs.existsSync(guess) ? guess : local;
  } catch { return local; }
}

function killTree(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || !child.pid) return;
  // Prerender also manages render workers and Chrome; killing only it leaves orphans
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
}

export function prerenderPlugin(): Plugin {
  return {
    name: "promptcut-prerender",
    configureServer(server: ViteDevServer) {
      if (isPrerender) return;
      const root = server.config.root;

      server.middlewares.use("/api/prerender/info", (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        const s = prerenderState();
        // `mode`: mode passed when spawning (`prerender-mode.mjs`), with just one extra key
        res.end(JSON.stringify({ ok: true, url: s.url, ready: s.ready, error: s.error, mode }));
      });

      /*
       * Mode of the prerender process (docs/semantics/mechanism/rendering.md "Query rendering and
       * prerender process"; cloud-task.md I4(a)):
       * User machines default to one process: `full` when a local Agent is present, `user` when not.
       * The editor process always hosts a local Agent (`vite-plugin-ai`), so it defaults to `full`;
       * if `PROMPTCUT_PRERENDER_MODE` is explicitly set in the editor environment, follow it
       * (`localPrerenderMode`).
       */
      const mode = localPrerenderMode(process.env);

      let child: ChildProcess | null = null;
      let closing = false;
      const tail: string[] = [];

      /*
       * ---- Desktop app auto-becomes render node for shared projects (editor process side, `server/render-node-relay.mjs`) ----
       *
       *   POST /api/render-node/bind            Page: enters shared project { url, projectId, assetBase?, contentId?, ticket? };
       *                                         records (excluding ticket) and forwards to prerender process
       *   POST /api/render-node/unbind          Page: leaves project / cancels collaboration { projectId };
       *                                         forwards to tear down
       *   POST /api/render-node/ticket          Page: returns connection ticket { reqId, ticket | error }
       *   POST /api/render-node/ticket-request  Prerender process (local, no Origin): { projectId } → { ticket };
       *                                         requests from page via HMR `pc:render-node`
       *   GET  /api/render-node/status          Diagnostics (excluding ticket)
       *
       * After the prerender process crashes, restarts, and passes health checks, forward recorded
       * config again (without ticket).
       * When switch `PROMPTCUT_AUTO_RENDER_NODE=0` (or a node is already configured via environment
       * variables), bind returns `{ enabled: false, reason }` and forwards nothing.
       */
      const rnLog = (event: string, fields: object = {}) => {
        try { console.info("[render-node]", event, JSON.stringify(fields)); } catch { console.info("[render-node]", event); }
      };
      const rnMemory = createBindingMemory();
      const rsPool = createRenderServerPool();
      const rnRelay = createTicketRelay({
        send: (data: object) => server.ws.send({ type: "custom", event: "pc:render-node", data }),
        hasPage: () => { const n = (server.ws as any)?.clients?.size; return typeof n === "number" ? n > 0 : true; },
      });
      const rnSend = (res: any, status: number, data: unknown) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(data));
      };
      const rnBody = (req: any, limit = 16 * 1024) => new Promise<any>((resolve, reject) => {
        let body = "";
        req.on("data", (c: Buffer) => { body += c; if (body.length > limit) { req.destroy(); reject(new Error(tr("Request body too large"))); } });
        req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Request body is not JSON")); } });
        req.on("error", reject);
      });
      /**
       * Forward to prerender process; ignore if not ready (re-forward from recorded config once ready)
       */
      const rnForward = async (pathname: string, body: object) => {
        const s = prerenderState();
        if (!s.ready || !s.url) return { ok: true, pending: true };
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (process.env.PROMPTCUT_INTERNAL_TOKEN) headers["x-pc-internal-token"] = process.env.PROMPTCUT_INTERNAL_TOKEN;
          const r = await fetch(s.url + pathname, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
          return await r.json().catch(() => ({ ok: false, error: `The prerender process returned non-JSON (HTTP ${r.status})` }));
        } catch (e: any) {
          return { ok: false, pending: true, error: String(e?.message ?? e) };
        }
      };
      const rnDeliverRemembered = () => {
        const b = rnMemory.get();
        if (!b) return;
        void rnForward("/api/frames/render-node", b).then((r: any) => rnLog("replay", { projectId: b.projectId, action: r?.action ?? null, ok: r?.ok !== false }));
      };
      server.middlewares.use("/api/render-node", (req, res, next) => {
        const route = (req.url || "/").split("?")[0];
        if (req.method === "GET" && route === "/status") {
          return rnSend(res, 200, { ok: true, enabled: autoRenderNodeOffReason(process.env) === null, off: autoRenderNodeOffReason(process.env), binding: rnMemory.get(), relay: rnRelay.stats() });
        }
        if (req.method !== "POST") return next();
        void (async () => {
          let input: any;
          try { input = await rnBody(req); } catch (e: any) { return rnSend(res, 400, { ok: false, error: e?.message || String(e) }); }
          if (route === "/bind") {
            const off = autoRenderNodeOffReason(process.env);
            if (off) return rnSend(res, 200, { ok: true, enabled: false, reason: off });
            let binding;
            try { binding = normalizeBinding(input); } catch (e: any) { return rnSend(res, 400, { ok: false, error: e?.message || String(e) }); }
            const prev = rnMemory.get();
            rnMemory.set(binding);
            rsPool.syncCurrentBinding(binding, { name: typeof input?.name === "string" ? input.name : undefined });
            if (!prev || prev.projectId !== binding.projectId || prev.url !== binding.url) rnLog("bind", { projectId: binding.projectId, url: binding.url, assetBase: binding.assetBase, contentId: binding.contentId });
            const r = await rnForward("/api/frames/render-node", { ...binding, ...(ticketOk(input.ticket) ? { ticket: input.ticket } : {}) });
            return rnSend(res, 200, { enabled: true, ...r });
          }
          if (route === "/unbind") {
            const projectId = typeof input?.projectId === "string" ? input.projectId : null;
            const cleared = rnMemory.clear(projectId);
            rsPool.syncCurrentBinding(rnMemory.get());
            if (cleared) rnLog("unbind", { projectId, reason: typeof input?.reason === "string" ? input.reason.slice(0, 40) : null });
            const r = await rnForward("/api/frames/render-node/unbind", { projectId, reason: typeof input?.reason === "string" ? input.reason.slice(0, 40) : "page-left" });
            return rnSend(res, 200, { cleared, ...r });
          }
          if (route === "/ticket") {
            return rnSend(res, rnRelay.answer(input) ? 200 : 404, { ok: true });
          }
          if (route === "/ticket-request") {
            // Only for the local prerender process (server-side requests without Origin); reject all requests
            // from pages in the browser (an extra guard beyond the api guard)
            if (req.headers.origin) return rnSend(res, 403, { ok: false, error: "Local processes only" });
            const projectId = typeof input?.projectId === "string" ? input.projectId : "";
            const b = rnMemory.get();
            if (!b || b.projectId !== projectId) return rnSend(res, 409, { ok: false, code: "not-bound", error: "The editor is not bound to this project" });
            try {
              const ticket = await rnRelay.request(projectId);
              return rnSend(res, 200, { ok: true, ticket });
            } catch (e: any) {
              return rnSend(res, 503, { ok: false, code: e?.code ?? "no-ticket", error: e?.message || String(e) });
            }
          }
          return rnSend(res, 404, { ok: false, error: "Unknown render-node operation" });
        })();
      });

      const fetchPrerenderJson = async (pathname: string) => {
        const s = prerenderState();
        if (!s.ready || !s.url) return null;
        try {
          const headers: Record<string, string> = {};
          if (process.env.PROMPTCUT_INTERNAL_TOKEN) headers["x-pc-internal-token"] = process.env.PROMPTCUT_INTERNAL_TOKEN;
          const r = await fetch(s.url + pathname, { headers, signal: AbortSignal.timeout(2500) });
          return r.ok ? await r.json().catch(() => null) : null;
        } catch {
          return null;
        }
      };

      server.middlewares.use("/api/render-server", (req, res, next) => {
        const route = (req.url || "/").split("?")[0];
        if (req.method === "GET" && route === "/status") {
          void (async () => {
            rsPool.syncCurrentBinding(rnMemory.get());
            const s = prerenderState();
            const [nodeStatus, queueSummary, diag] = await Promise.all([
              fetchPrerenderJson("/api/frames/render-node"),
              fetchPrerenderJson("/api/frames/queue"),
              fetchPrerenderJson("/api/frames/diagnostics"),
            ]);
            const claims = Array.isArray(diag?.queue?.claims) ? diag.queue.claims : [];
            for (const c of claims) {
              if (!c || typeof c.id !== "string") continue;
              rsPool.recordTask({
                id: `claim:${c.id}`,
                projectId: c.projectId || nodeStatus?.projectId || rnMemory.get()?.projectId || "local",
                kind: c.kind || "render",
                status: c.outcome === "failed" ? "failed" : c.outcome ? "completed" : "running",
                frames: Number(c.frames) || 0,
                segments: Number(c.segments) || (c.kind === "stream" ? 1 : 0),
                startedAt: Number.isFinite(c.claimedAt) ? c.claimedAt : undefined,
                finishedAt: Number.isFinite(c.finishedAt) ? c.finishedAt : undefined,
                durationMs: Number.isFinite(c.durationMs) ? c.durationMs : undefined,
              });
            }
            return rnSend(res, 200, {
              ...rsPool.status({
                nodeStatus: nodeStatus ?? { enabled: autoRenderNodeOffReason(process.env) === null, bound: !!rnMemory.get(), ...(rnMemory.get() ?? {}) },
                queueSummary,
                prerenderReady: s.ready,
              }),
              mode,
            });
          })();
          return;
        }
        if (req.method !== "POST") return next();
        void (async () => {
          let input: any;
          try { input = await rnBody(req, 32 * 1024); } catch (e: any) { return rnSend(res, 400, { ok: false, error: e?.message || String(e) }); }
          if (route === "/add") {
            try {
              const project = input?.kind === "invite"
                ? await rsPool.addInviteProject(input)
                : await rsPool.addJoinedProject(input);
              return rnSend(res, 200, { ok: true, project });
            } catch (e: any) {
              const code = e?.code ?? e?.reason ?? "bad-request";
              const status = Number.isInteger(e?.status) ? e.status : code === "password-required" ? 401 : 400;
              return rnSend(res, status, {
                ok: false,
                code,
                error: e?.message || String(e),
                ...(e?.project ? { project: e.project } : {}),
                ...(e?.retryAfter ? { retryAfter: e.retryAfter } : {}),
              });
            }
          }
          if (route === "/remove") {
            const removed = await rsPool.removeProject(input?.projectId);
            return rnSend(res, 200, { ok: true, removed });
          }
          if (route === "/record") {
            const record = rsPool.recordTask(input);
            return rnSend(res, 200, { ok: true, record });
          }
          return rnSend(res, 404, { ok: false, error: "Unknown render-server operation" });
        })();
      });

      const start = async () => {
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        const addr = server.httpServer?.address() as AddressInfo | null;
        const editorPort = addr?.port || server.config.server.port || 5190;
        const stagePorts = stagePortsOf(editorPort);
        const internalToken = process.env.PROMPTCUT_INTERNAL_TOKEN || (globalThis as any).__PC_INTERNAL_TOKEN__ || (() => {
          const tok = ((globalThis as any).__PC_INTERNAL_TOKEN__ = "pc-tok-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
          return tok;
        })();
        process.env.PROMPTCUT_INTERNAL_TOKEN = internalToken;
        child = spawn(process.execPath, [
          viteBin(root), "--config", path.join(root, "vite.prerender.config.ts"),
          "--port", String(port), "--strictPort", "--host", "127.0.0.1",
        ], {
          cwd: root,
          env: {
            ...process.env,
            PROMPTCUT_ROLE: "prerender",
            PROMPTCUT_PRERENDER_MODE: mode,
            PROMPTCUT_CORS_ORIGINS: editorOrigins(server).join(","),
            PROMPTCUT_STAGE_PORTS: stagePorts.join(","),
            PROMPTCUT_INTERNAL_TOKEN: internalToken,
            /*
             * Address of the editor side, used by the mirror plugin to pull back the whole project (A7).
             * The frame request body only contains `{session, localRev}`; when a forwarded push is dropped
             * or this process just started up, it uses this key to `GET /api/data/project?session=&localRev=`
             * and fetch that version back.
             *
             * [ruling] Included in all three modes. The plan (cloud-task.md I1, I4(a)) specified that `agent`
             * mode would not include it and the project would be pushed by the Agent server (I2), but I2's push
             * is not yet here: today local Agent queries only include `{session, localRev}` and rely on this
             * address to pull back; the asset service base URL (`assetServiceOrigin` in `asset-client.ts`)
             * is also still this. Without it, `agent` mode launched locally cannot query a single image.
             * Remove it as planned once I2 push and I3 "tell asset service address on launch" land.
             */
            PROMPTCUT_EDITOR_URL: editorOrigins(server)[0],
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        try {
          os.setPriority(child.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch { /* Failure to set priority does not affect functionality, just loses a layer of protection */ }
        const keep = (c: Buffer) => { tail.push(c.toString()); if (tail.length > 30) tail.shift(); };
        /*
         * Prerender process output only keeps the tail for error reporting on crash; among these,
         * queue node and session event lines pushing queues to the document service
         * (`[queue-node] docservice.session.*`, throttled by event at source, see `vite-plugin-frames.ts`)
         * are forwarded into the editor process logs, so "detach, resume, rebuild" can be seen from
         * the editor side during chaos tests. Lines contain no session IDs or credentials.
         */
        const forwardOut = createSessionLineForwarder((line: string) => console.info(`[prerender] ${line}`));
        const forwardErr = createSessionLineForwarder((line: string) => console.info(`[prerender] ${line}`));
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
        child.stdout?.on("data", forwardOut);
        child.stderr?.on("data", forwardErr);
        // Host render service worker process: records of the page request gate in the prerender process
        // (`[page-gate] …`, rate-limited at source) are forwarded as-is, showing what was blocked
        // in the management process logs
        if (process.env.PROMPTCUT_RENDER_BROKER) {
          let gateTail = "";
          child.stdout?.on("data", (c: Buffer) => {
            const lines = (gateTail + c.toString()).split(/\r?\n/);
            gateTail = (lines.pop() ?? "").slice(-4000);
            for (const line of lines) if (line.startsWith("[page-gate]")) console.info(line.slice(0, 2000));
          });
        }
        /*
         * For troubleshooting (disabled by default): when `PROMPTCUT_PRERENDER_LOG=<file>`, appends all
         * output of the prerender process as-is into this file, each chunk prefixed with the received
         * timestamp (used in `docs/archive/agent-reports/AGENT-uc-latency.md` to investigate tab switching
         * freezes). Does nothing if unset.
         */
        const fullLog = String(process.env.PROMPTCUT_PRERENDER_LOG || "").trim();
        if (fullLog) {
          const tee = (c: Buffer) => { try { fs.appendFileSync(fullLog, `@${Date.now()} ${c.toString()}`); } catch { /* Ignore if unable to write */ } };
          child.stdout?.on("data", tee);
          child.stderr?.on("data", tee);
        }
        setPrerender({ url, ready: false, error: null });

        const me = child;
        me.on("exit", (code) => {
          if (child === me) child = null;
          setPrerender({ ready: false, error: `Prerender process exited (code ${code}): ${tail.join("").trim().slice(-400)}` });
          if (closing) return;
          const n = prerenderState().restarts + 1;
          setPrerender({ restarts: n });
          if (n <= MAX_RESTARTS) setTimeout(() => { if (!closing) start().catch(() => {}); }, 1000 * n);
        });

        // Ready = its own health-check endpoint responds (vite-plugin-vision registered on the
        // prerender side)
        const t0 = Date.now();
        while (child === me && Date.now() - t0 < 120000) {
          try {
            const r = await fetch(`${url}/api/prerender/health`, { signal: AbortSignal.timeout(2000) });
            if (r.ok) {
              setPrerender({ ready: true, error: null, restarts: 0 });
              /*
               * It just started up (or just restarted after a crash) and has no projects at hand.
               * Push the latest version of each session as a catch-up; otherwise, the next frame request must
               * fall back to a pull-back: a pull-back is an extra round trip, and crash-restarts often coincide
               * with the user scrubbing the timeline.
               */
              /*
               * After catch-up pushing the mirror, replay preloads serially according to the session version
               * registry (Item 4 Option A): the prerender process only recognizes session versions brought by
               * preload; after a crash and restart, it relies on this step to learn each session's version again,
               * with no action needed from the page. If it restarts again during replay (`child !== me`), stop
               * and hand off to the next round.
               */
              void repushMirror(url)
                .then(() => replayReadySessions(url, () => child === me))
                .then((results) => { if (results.length) console.log(`[prerender] Replaying preload after restart: ${JSON.stringify(results)}`); })
                .catch(() => {})
                // The page submitted shared config (auto render node): it just started up and has none, so
                // forward again based on the recorded config (without ticket; it requests one when creating a session)
                .then(() => { if (child === me) rnDeliverRemembered(); });
              return;
            }
          } catch { /* Not up yet */ }
          await new Promise((r) => setTimeout(r, 300));
        }
      };

      server.httpServer?.once("listening", () => {
        start().catch((e) => setPrerender({ ready: false, error: e?.message || String(e) }));
      });
      const stop = () => { closing = true; void rsPool.close(); killTree(child); };
      server.httpServer?.on("close", stop);
      process.once("exit", stop);
    },
  };
}

export default prerenderPlugin;
