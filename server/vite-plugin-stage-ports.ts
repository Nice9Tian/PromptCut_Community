import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Plugin, ViteDevServer } from "vite";
import { STAGE_PORTS, stagePortsOf } from "./stage-ports.mjs";
import { STAGE_CLIENT_HEADER, viaStagePort } from "./http-guard.mjs";
import { stageRequestAllowed, stageGateLog, STAGE_DENY_BODY, setStageMediaHashesGetter } from "./stage-gate.mjs";

export function projectMediaHashes(project: any): Set<string> {
  const hashes = new Set<string>();
  if (!project || !Array.isArray(project.media)) return hashes;
  for (const m of project.media) {
    if (typeof m.hash === "string" && m.hash) hashes.add(m.hash.toLowerCase());
    if (typeof m.tiers?.original === "string" && m.tiers.original) hashes.add(m.tiers.original.toLowerCase());
    if (typeof m.tiers?.small === "string" && m.tiers.small) hashes.add(m.tiers.small.toLowerCase());
    if (typeof m.url === "string") {
      const match = /\/@media\/([0-9a-fA-F]{64})/i.exec(m.url);
      if (match) hashes.add(match[1].toLowerCase());
    }
  }
  return hashes;
}

export function currentProjectMediaHashes(): Set<string> | null {
  const getter = (globalThis as any).__PC_LATEST_MIRROR__;
  const m = typeof getter === "function" ? getter() : null;
  if (!m || !m.project) return null;
  return projectMediaHashes(m.project);
}

/**
 * Two stage ports (E1). Start a **transparent reverse proxy** on editor port +1 and +2 each,
 * forwarding back to the same vite instance as-is, with only one extra job: adding
 * `Origin-Agent-Cluster: ?1` to every response.
 *
 * # Why open separate ports
 *
 * Both stage iframes must land in **their own renderer process**, otherwise pushing frames on a single
 * heavy card freezes the editor main document along with it (pinned render 1: user interaction must
 * never stutter). Chromium determines whether to enter an isolated process by **site**, and a site
 * does not include ports: changing ports on the same host is still the same site. Measured
 * (`scripts/probes/oac-probe.mjs`, Chrome 152 / WebView2 153, report
 * `docs/archive/restructure_planning/g0-a-webview2-probe.md`): without the header, both iframes and
 * the parent page are squeezed into one process; when A hits an infinite loop for 2.5 seconds, the
 * parent page worst-case rAF interval exceeds 2,000 ms. After adding `Origin-Agent-Cluster: ?1`, this
 * origin is clustered by **origin**, the iframes become isolated processes, and the parent page
 * worst-case interval drops to 7-17 ms.
 *
 * **This header must be present on the very first load of this origin**: Chromium caches the
 * determination of whether this origin is origin-keyed per BrowsingInstance; adding it later has no
 * effect. Therefore, add it to **all** responses here instead of picking only stage documents:
 * missing even one invalidates the whole round, while adding it to extra responses has no effect at
 * all. (`window.originAgentCluster` always returns true and cannot be used as a criterion; for
 * acceptance check, check whether CDP `Target.getTargets` contains a target with `type: 'iframe'`.)
 *
 * # Two things passed through
 *
 * - **Range / 206**: When scrubbing `<video>` in the stage, requesting its own origin requires
 *   fetching in segments (after R3 asset layer enters the stage). Copying the status code and
 *   response headers back as-is is sufficient; do not change `content-length` / `content-range` on
 *   your own.
 * - **`upgrade`**: vite's HMR WebSocket. The address calculated by the client script is
 *   `importMetaUrl.hostname:importMetaUrl.port` (vite 8 client.mjs), which is the stage port; without
 *   forwarding, it falls back to connecting directly to the vite port (vite's built-in fallback),
 *   leaving a connection failure line on every console refresh. After forwarding, it behaves
 *   identically to same-origin.
 *
 * # What if they fail to start
 *
 * If a port is occupied, **do not start that proxy**, and omit it from the port table injected into
 * the page; when the page sees an incomplete table, it falls back to same-origin single stage
 * (`previewMode.ts`). The dev server must not crash just because an extra port failed to start.
 *
 * # Where to listen
 *
 * Wherever vite binds (`127.0.0.1`, or `0.0.0.0` for `npm run dev`), the two stage ports bind there
 * too: when a LAN device opens the editor, the stage iframe address is constructed using
 * `location.hostname` (`previewMode.ts`), so the stage ports must also be on the LAN. Forwarding back
 * to vite always uses 127.0.0.1, so the peer seen by vite is always loopback: the proxy writes the
 * real peer into `STAGE_CLIENT_HEADER` (overwriting any header of the same name on the request to
 * prevent forgery), and the local check for `/api/**` uses this to distinguish (`fromLocalClient` in
 * `http-guard.mjs`).
 *
 * # Forward only whitelisted requests
 *
 * The stage window runs card code (including cards written by the user or other members). The stage
 * port is same-origin to it, so the proxy **rejects all by default**, forwarding only requests in the
 * `server/stage-gate.mjs` whitelist to the editor process and returning 403 on the spot for others;
 * WebSocket upgrade works the same way (passing only the hot update connection). The editor process
 * side checks again using the header written by the proxy (the first middleware in `configureServer`
 * below), serving as the second line of defense.
 */

/** The page uses this global to know which stage ports actually started; if they fail to start, it is an empty table and the page falls back to same-origin single stage */
const INJECT_MARK = "__PC_STAGE_PORTS__";

export function stagePortsPlugin(): Plugin {
  let ports: number[] = [];
  const servers: http.Server[] = [];
  /** Whether the proxies have finished starting. Wait for them before injecting the port table: otherwise the page might get an empty table on first open */
  let ready: Promise<void> = Promise.resolve();

  /** Request headers forwarded to vite: as-is, except writing the real peer into STAGE_CLIENT_HEADER (overwriting the request's own to prevent forgery) */
  const forwardHeaders = (req: http.IncomingMessage) => ({ ...req.headers, [STAGE_CLIENT_HEADER]: req.socket.remoteAddress || "" });

  /** Proxy for a single stage port: forwards everything back to 127.0.0.1:<vite port>, adding OAC header to responses */
  const makeProxy = (listenHost: string, listenPort: number, targetPort: number): Promise<http.Server | null> =>
    new Promise((resolve) => {
      const proxy = http.createServer((req, res) => {
        const ok = stageRequestAllowed(req.method, req.url, { headers: req.headers, projectMediaHashes: currentProjectMediaHashes });
        stageGateLog(req.method, req.url, false, ok);
        if (!ok) {
          // Do not read the request body: close the connection once responded, without forwarding bytes to the editor process
          res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "origin-agent-cluster": "?1", connection: "close" });
          res.end(STAGE_DENY_BODY);
          return;
        }
        const up = http.request(
          { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: forwardHeaders(req) },
          (pres) => {
            /*
             * The Host header is forwarded as-is, so vite still sees the stage port as Host: the same-origin
             * guard for `/api/**` (`originOk` in `http-guard.mjs`) checks `origin === "http://" + host`,
             * so requests sent by the stage page to its own origin are still considered same-origin,
             * requiring no loopholes opened in the guard.
             */
            res.writeHead(pres.statusCode ?? 502, { ...pres.headers, "origin-agent-cluster": "?1" });
            pres.pipe(res);
          },
        );
        up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(up);
      });
      // vite's HMR WebSocket: the client connects to the stage port, forwarded to vite as-is
      proxy.on("upgrade", (req, socket: Duplex, head: Buffer) => {
        const ok = stageRequestAllowed(req.method, req.url, { upgrade: true, headers: req.headers });
        stageGateLog(req.method, req.url, true, ok);
        if (!ok) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const up = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: forwardHeaders(req) });
        up.on("upgrade", (pres, psocket, phead) => {
          const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}`];
          for (const [k, v] of Object.entries(pres.headers)) {
            for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
          }
          socket.write(lines.join("\r\n") + "\r\n\r\n");
          if (phead?.length) socket.write(phead);
          psocket.pipe(socket);
          socket.pipe(psocket);
          psocket.on("error", () => socket.destroy());
          socket.on("error", () => psocket.destroy());
        });
        up.on("error", () => socket.destroy());
        if (head?.length) up.write(head);
        up.end();
      });
      proxy.on("error", () => resolve(null));
      proxy.listen(listenPort, listenHost, () => resolve(proxy));
    });

  return {
    name: "promptcut-stage-ports",
    apply: "serve",

    configureServer(server: ViteDevServer) {
      setStageMediaHashesGetter(currentProjectMediaHashes);
      /*
       * Second line: requests arriving with the stage port header that are not in the whitelist are
       * also rejected by the editor process itself (for all paths, not just `/api`).
       * Under normal circumstances this is unreachable: the proxy already rejected them; kept to guard
       * against future places that might write this header but forget to pass the gate.
       * Requests connecting directly to the editor port do not have this header and are passed directly
       * here, keeping behavior completely unchanged.
       */
      server.middlewares.use((req, res, next) => {
        if (!viaStagePort(req) || stageRequestAllowed(req.method, req.url, { headers: req.headers, projectMediaHashes: currentProjectMediaHashes })) return next();
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(STAGE_DENY_BODY);
      });

      // Probes and the desktop shell query "which two stage ports" here (the page uses the global injected below without calling the endpoint)
      server.middlewares.use("/api/stage/ports", (_req, res) => {
        void ready.then(() => {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ ok: true, count: STAGE_PORTS, ports }));
        });
      });

      server.httpServer?.on("listening", () => {
        const addr = server.httpServer?.address() as AddressInfo | null;
        if (!addr || typeof addr === "string") return;
        // Bound to the same place as vite: when vite binds to all interfaces (0.0.0.0 / ::), stage ports also bind to all interfaces so LAN devices can open the stage
        const host = addr.address;
        ready = (async () => {
          for (const p of stagePortsOf(addr.port)) {
            const s = await makeProxy(host, p, addr.port);
            if (s) { servers.push(s); ports.push(p); }
            else server.config.logger.warn(`[stage-ports] Port ${p} could not start (probably in use), this stage falls back to same-origin`);
          }
          if (ports.length) server.config.logger.info(`[stage-ports] Stage ports ${ports.join(" / ")} (with Origin-Agent-Cluster: ?1)`);
        })();
      });

      const stop = () => { for (const s of servers) s.close(); servers.length = 0; ports = []; };
      server.httpServer?.on("close", stop);
      const origClose = server.close.bind(server);
      server.close = async () => { stop(); return origClose(); };
    },

    /*
     * Inject the port table into every page (both the editor page and stage page use the same index.html).
     * Use injection instead of letting the page fetch: the iframe src must be determined on the first
     * render; an extra async round trip adds an extra frame of "stage not yet mounted" blank window.
     */
    async transformIndexHtml() {
      await ready;
      return [{
        tag: "script",
        injectTo: "head-prepend" as const,
        children: `window.${INJECT_MARK}=${JSON.stringify(ports)};`,
      }];
    },
  };
}

export default stagePortsPlugin;
