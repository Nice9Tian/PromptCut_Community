import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";
import { apiPath, clientAddressOf, fromLocalClient, isLoopbackAddress, isLocalOrigin, remoteTagOf } from "./http-guard.mjs";
import { prepareLocalDocumentDir, recoveryDir } from "./recovery/paths.mjs";
import { buildExtensions } from "./vite-plugin-hosted-gate";
import { mediaDir } from "./vite-plugin-media";
import { artifactStoreDir } from "./asset-service";

/**
 * Local document service (contract `docs/plan/docservice-contract.md` Section 5, Section 10).
 *
 * The same document service code (`server/docservice/`) is attached into vite's http server in
 * **attached mode**:
 * - WebSocket: `ws://<editor address>/docservice` (subprotocol `promptcut.v1`). Only accepts upgrades
 *   for this single path; vite's HMR also uses `upgrade`, and document service never touches other
 *   paths;
 * - `GET /api/docservice/healthz`: same object as `/healthz` from remote document service. Governed
 *   by same-origin guard for `/api/**` (`vite-plugin-api-guard.ts`), only for local machine and same
 *   origin.
 *
 * Assembled via `docservice/shared-service.mjs` (`mode: 'lan'`, LAN host; contract
 * `docs/plan/auth-contract.md`):
 * Render queue, project versions, and content store are each instantiated per space, additionally
 * mounting service address registry and shared project modules.
 * Logs for the local (`local`) space land in `<root>/out/docservice`, shared project spaces in
 * `<root>/out/docservice/tenants/<projectId>/`, credentials stored in `<root>/out/docservice/auth/`
 * (`fsDeny` in `vite.config.ts` blocks the entire directory, not exposed via static service).
 * Credential stores are retrieved as in-process singletons per directory (`credentialStoreFor` in
 * `auth/store.mjs`), and asset service (`vite-plugin-media.ts`) uses the same copy to verify ticket
 * generation and signing key.
 *
 * Shared endpoints: `/docservice/shared/{create,lookup,challenge}` (HTTP, cross-origin `*`), only
 * local loopback can create projects.
 *
 * Authentication (judging real peer via `clientAddressOf` in `http-guard.mjs`, requests forwarded
 * from stage port reverse proxy are also evaluated by real peer written into it):
 * - Connections from local loopback carry nothing: local identity
 *   `{ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' }`; those carrying
 *   `promptcut.tenant.<projectId>` are local claims (creator's own page, prerender process
 *   joining local hosted shared project);
 * - Connections from LAN can only enter with proof or connection tickets;
 * - Cluster tokens are never recognized in attached mode (the management interface of a LAN host
 *   only binds loopback and requires no token, contract Section 10).
 * When credential store fails to load, it only logs `config.error { reason: 'auth-store' }`: local
 * identity proceeds as usual, while LAN requests all receive 401; when running as a LAN host
 * (`PROMPTCUT_LAN_HOST=1`), startup is refused (SP contract Section 5).
 *
 * **LAN host** (contract `docs/plan/shared-project-contract.md` Sections 4 and 5): when
 * `PROMPTCUT_LAN_HOST=1`, `vite.config.ts` has editor bind `0.0.0.0`, with document service and
 * asset service mounted on the same http server, thereby becoming reachable over LAN. When editor
 * binds a non-loopback address and has shared projects, it broadcasts and responds on local subnet
 * via `lan/discovery.mjs` (`createLanHosting`); it stops when all projects are deleted or editor
 * exits. Management interface only recognizes loopback (item 3 above).
 *
 * Document service has only one instance in editor process, not mounted in prerender process
 * (`vite.prerender.config.ts`).
 * Any error at any step only logs, without affecting editor startup.
 */

const WS_PATH = "/docservice";
const HEALTH_PATH = "/api/docservice/healthz";
const SHARED_PREFIX = `${WS_PATH}/shared/`;
const DEVICE_PATH = "/api/docservice/device";
const DISCOVER_PATH = "/api/docservice/lan-discover";
const LAN_DISCOVER_ALL_PATH = "/api/lan/discover";
const DATA_SERVER_PREFIX = "/api/data-server/";

type Log = (event: string, fields: object) => void;

/**
 * Connection open/close, handshake rejection, etc. are logged as usual; others are also logged,
 * all with `[docservice]` prefix, one line each
 */
const log: Log = (event, fields) => {
  try {
    console.info("[docservice]", event, JSON.stringify(fields));
  } catch {
    console.info("[docservice]", event);
  }
};

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const pathnameOf = (req: IncomingMessage): string | null => {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
};

function sendJson(res: ServerResponse, status: number, body: object, head: boolean) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(head ? undefined : JSON.stringify(body));
}

/**
 * Attach an empty `error` listener to the socket of **every** upgrade request on the http server
 * (contract Section 10, item 14).
 *
 * Once Node hands `upgrade` over to listeners, it no longer provides a fallback for socket errors.
 * When vite's HMR listener encounters a path not belonging to it, it returns directly without sending
 * a response or attaching an `error` listener; when such a pending handshake has its peer reset
 * (`ECONNRESET`), an unhandled `error` event occurs, causing the entire dev server to exit (verified
 * by test: any non-HMR path in normal mode or `/docservice` of a headless instance can crash it).
 *
 * This listener only attaches an error listener: it does not respond, close the socket, or read data,
 * so it does not affect HMR or other handlers; attaching it before or after vite's HMR listener is
 * equally safe: `error` will only occur after the `upgrade` event has finished synchronous dispatch,
 * by which time all listeners have already run. Using `prependListener` to put it at the very front
 * here is solely to attach it prior to any handler that might synchronously throw.
 * Attach only once per socket (deduplicated via WeakSet).
 */
function guardUpgradeSockets(httpServer: NonNullable<import("vite").ViteDevServer["httpServer"]>) {
  const guarded = new WeakSet<Duplex>();
  const onUpgrade = (_req: IncomingMessage, socket: Duplex) => {
    if (guarded.has(socket)) return;
    guarded.add(socket);
    socket.on("error", () => {});
  };
  httpServer.prependListener("upgrade", onUpgrade);
  httpServer.once("close", () => httpServer.off("upgrade", onUpgrade));
}

/** Disabled mode: does not create document service, both routes explicitly return 503 */
/** Editor runs as LAN host (`PROMPTCUT_LAN_HOST=1`, `vite.config.ts` binds `0.0.0.0` accordingly) */
export const lanHostRequested = () => process.env.PROMPTCUT_LAN_HOST === "1";

/** Whether listen address is loopback-only (`127.x`, `::1`, `localhost`); `0.0.0.0`, `::`, LAN are not */
export function isLoopbackListen(address: string | null | undefined): boolean {
  const a = String(address ?? "").toLowerCase();
  return a === "localhost" || isLoopbackAddress(a);
}

type LanStore = { list(): Array<{ projectId: string; name: string; mode: string }> };
type LanHost = { start(): Promise<void>; stop(): Promise<void>; refresh(): Promise<void>; running(): boolean };

/**
 * Host side of LAN discovery (contract `docs/plan/shared-project-contract.md` Section 4,
 * `lan/discovery.mjs`):
 * - When editor binds a non-loopback address (`PROMPTCUT_LAN_HOST=1`, or `--host 0.0.0.0` in
 *   `npm run dev`) and there are shared projects in credential store, start broadcasting and
 *   responding; credential store in attached mode only holds LAN mode projects (hosted mode projects
 *   are on the hosted side);
 * - When a project is created (`shared/create`) or deleted (creator action `delete`), reconcile
 *   again: if projects remain, announce immediately once; stop if none are left;
 * - When editor only binds loopback, do not broadcast: others cannot connect to the announced address;
 * - Stop when editor exits (http server closes).
 * Errors such as failing to open the UDP port only log (`[docservice] lan.error`), without affecting
 * the editor.
 *
 * `createHost` is only for test injection (defaults to `createLanHost` in `lan/discovery.mjs`).
 */
type HttpServerLike = Pick<import("node:http").Server, "address" | "once" | "listening">;
type LanHostOptions = { projects: () => Array<{ projectId: string; name: string; mode: string }>; hostDeviceName: string; servicePort: number; log: Log };
export function createLanHosting(
  httpServer: HttpServerLike,
  { createHost, log: say = log }: { createHost?: (options: LanHostOptions) => LanHost | Promise<LanHost>; log?: Log } = {},
) {
  let store: LanStore | null = null;
  let hostDeviceName = "";
  let servicePort: number | null = null;
  let host: LanHost | null = null;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();

  const listProjects = () => {
    try {
      return store?.list() ?? [];
    } catch {
      return [];
    }
  };

  const step = async () => {
    if (closed || !store || servicePort === null) return;
    const want = listProjects().length > 0;
    if (want && !host) {
      const make = createHost ?? (async (o: LanHostOptions) => (await import("./lan/discovery.mjs")).createLanHost(o) as LanHost);
      try {
        host = await make({ projects: listProjects, hostDeviceName, servicePort, log: say });
        await host.start();
      } catch (err) {
        say("lan.error", { stage: "start", message: errText(err) });
        host = null;
      }
    } else if (!want && host) {
      const h = host;
      host = null;
      await h.stop();
    } else if (host) {
      await host.refresh();
    }
  };

  const sync = () => {
    chain = chain.then(step).catch((err) => say("lan.error", { stage: "sync", message: errText(err) }));
    return chain;
  };

  const onListening = () => {
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") return;
    if (isLoopbackListen(addr.address)) {
      say("lan.skip", { reason: "loopback-only", address: addr.address });
      return;
    }
    servicePort = addr.port;
    sync();
  };
  if (httpServer.listening) queueMicrotask(onListening);
  else httpServer.once("listening", onListening);
  httpServer.once("close", () => {
    closed = true;
    chain = chain.then(async () => {
      const h = host;
      host = null;
      await h?.stop();
    }).catch(() => {});
  });

  return {
    /** Credential store and local device name ready; if http server is already listening, reconcile immediately once */
    attach(options: { store: LanStore | null; hostDeviceName: string }) {
      store = options.store;
      hostDeviceName = options.hostDeviceName;
      sync();
    },
    sync,
  };
}

export function docservicePlugin(): Plugin {
  return {
    name: "promptcut-docservice",
    apply: "serve",
    async configureServer(server) {
      const httpServer = server.httpServer;
      if (!httpServer) {
        log("docservice.skip", { reason: "no-http-server" });
        return;
      }
      // Prevent unhandled upgrades from crashing the dev server when reset by the peer
      guardUpgradeSockets(httpServer);

      let service: { health(): object; close(): Promise<void> } | null = null;
      let handleShared: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null;
      let localDataDir = "";
      let localStore: any = null;
      let storeMissing = false;
      // Host side of LAN discovery (contract `docs/plan/shared-project-contract.md` Section 4):
      // called back by shared endpoints when projects are created or deleted
      const lan = createLanHosting(httpServer);
      try {
        const [{ createSharedDocService }, { credentialStoreFor }, { localDeviceInfo }, { recoveryHttp }] = await Promise.all([
          import("./docservice/shared-service.mjs"),
          import("./auth/store.mjs"),
          import("./auth/device.mjs"),
          import("./recovery/http.mjs"),
        ]);
        const dataDir = prepareLocalDocumentDir(server.config.root);
        localDataDir = dataDir;
        // Credential store: in-process singleton, asset service retrieves the same copy by directory
        let store: object | null = null;
        try {
          store = credentialStoreFor(path.join(dataDir, "auth"), { log });
          localStore = store;
        } catch (err) {
          storeMissing = true;
          log("config.error", { reason: "auth-store", message: errText(err) });
        }
        const isLoopback = (req: IncomingMessage) => {
          const address = clientAddressOf(req);
          // True initiator is local: peer is loopback and every hop in forwarding headers is loopback
          // (`auth/origin.mjs`, contract Section 10)
          return address !== null && isLocalOrigin(req, address);
        };
        const built = createSharedDocService({
          mode: "lan",
          dataDir,
          store,
          server: httpServer,
          path: WS_PATH,
          isLoopback,
          remoteOf: (req: IncomingMessage) => remoteTagOf(req, clientAddressOf(req)),
          localDevice: localDeviceInfo(),
          log,
          onCreate: () => lan.sync(),
          onDelete: () => lan.sync(),
        });
        lan.attach({ store: store as LanStore | null, hostDeviceName: localDeviceInfo().deviceName });
        service = built.service;
        handleShared = built.handleHttp;
        const recDir = recoveryDir(server.config.root);
        // Enabling, refreshing, and reopening LAN projects all go through it; the commercial edition
        // table adds hosted registration and moves on top of this
        const createRecovery = typeof buildExtensions.recoveryHttp?.createMiddleware === "function" ? buildExtensions.recoveryHttp.createMiddleware : recoveryHttp;
        server.middlewares.use(createRecovery({
          dir: recDir, dataDir, store, device: localDeviceInfo(),
          assets: { media: { root: mediaDir(server.config.root), shard: false }, snap: { root: artifactStoreDir(server.config.root, "snap"), shard: false }, px: { root: artifactStoreDir(server.config.root, "px"), shard: false } },
          reloadSpace: built.service.reloadSpace,
          baseOf: () => `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/docservice`,
          onClose: (close: () => void) => httpServer.once("close", close),
        }));
        log("docservice.attach", { path: WS_PATH, modules: built.service.health().modules, authStore: store ? "ok" : "unavailable" });
      } catch (err) {
        log("docservice.error", { stage: "attach", message: errText(err) });
        return;
      }

      // LAN host (PROMPTCUT_LAN_HOST=1) binds non-loopback but credential store is not loaded:
      // refuse startup (SP contract Section 5, M6a fail-closed)
      if (lanHostRequested() && storeMissing) {
        log("config.error", { reason: "auth-store", lanHost: true });
        throw new Error("LAN host (PROMPTCUT_LAN_HOST=1) requires a usable credential store: <root>/out/docservice/auth is unreadable, refusing to start");
      }

      // Preflight for shared endpoints must answer before vite's built-in cors middleware (which does
      // not accept LAN origins, for the same reason as assetPreflightMiddleware in asset-service.ts)
      server.middlewares.stack.unshift({
        route: "",
        handle: ((req: IncomingMessage, res: ServerResponse, next: () => void) => {
          if (String(req.method || "").toUpperCase() !== "OPTIONS" || !pathnameOf(req)?.startsWith(SHARED_PREFIX)) return next();
          if (!handleShared!(req, res)) next();
        }) as any,
      });
      server.middlewares.use((req, res, next) => {
        if (!pathnameOf(req)?.startsWith(SHARED_PREFIX)) return next();
        if (!handleShared!(req, res)) next();
      });

      // Two routes needed by page "Create / open shared project" (C6.5 D11, `src/editor/sync/`):
      // - `GET /api/docservice/device`: local device info, and whether editor is bound to LAN (LAN mode
      //   requires restarting editor with PROMPTCUT_LAN_HOST=1);
      // - `GET /api/docservice/lan-discover?name=`: browser cannot send UDP, so editor process searches
      //   on local subnet on its behalf (`lan/discovery.mjs`, 3 s timeout).
      // Both are behind the same-origin guard for `/api/**`, only for local machine and same origin.
      server.middlewares.use(async (req, res, next) => {
        const p = apiPath(req.url);
        if (p !== DEVICE_PATH && p !== DISCOVER_PATH) return next();
        const method = String(req.method || "GET").toUpperCase();
        if (method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          res.end();
          return;
        }
        try {
          if (p === DEVICE_PATH) {
            const { localDeviceInfo } = await import("./auth/device.mjs");
            const addr = httpServer.address();
            const bound = addr && typeof addr !== "string" ? addr.address : null;
            return sendJson(res, 200, { ok: true, ...localDeviceInfo(), lanHost: !!bound && !isLoopbackListen(bound), lanHostRequested: lanHostRequested() }, false);
          }
          const name = new URL(req.url ?? "/", "http://localhost").searchParams.get("name") ?? "";
          if (!name.trim()) return sendJson(res, 400, { ok: false, error: "bad-request" }, false);
          const { discoverLan } = await import("./lan/discovery.mjs");
          const r = await discoverLan({ name, timeoutMs: 3000 });
          return sendJson(res, 200, { ok: true, hosts: r.hosts, errors: r.errors, elapsedMs: r.elapsedMs }, false);
        } catch (err) {
          log("docservice.error", { stage: p, message: errText(err) });
          return sendJson(res, 500, { ok: false, error: "internal" }, false);
        }
      });

      // Wildcard & filtered LAN discovery for Team Project discovery (`GET /api/lan/discover?name=&timeoutMs=`)
      server.middlewares.use(async (req, res, next) => {
        const p = apiPath(req.url);
        if (p !== LAN_DISCOVER_ALL_PATH) return next();
        const method = String(req.method || "GET").toUpperCase();
        if (method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          res.end();
          return;
        }
        if (!fromLocalClient(req)) return sendJson(res, 403, { ok: false, error: "forbidden" }, false);
        try {
          const u = new URL(req.url ?? "/", "http://localhost");
          const rawName = (u.searchParams.get("name") ?? "").trim();
          const rawTimeout = Number(u.searchParams.get("timeoutMs"));
          const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(3000, Math.max(400, Math.round(rawTimeout))) : 1200;
          const [{ discoverLan }, { localDeviceInfo }] = await Promise.all([
            import("./lan/discovery.mjs"),
            import("./auth/device.mjs"),
          ]);
          const addr = httpServer.address();
          const bound = addr && typeof addr !== "string" ? addr.address : null;
          const port = addr && typeof addr !== "string" ? addr.port : null;
          const lanHost = !!bound && !isLoopbackListen(bound);
          const device = localDeviceInfo();
          const r = await discoverLan({ ...(rawName ? { name: rawName } : {}), timeoutMs });
          const localList: Array<{ projectId: string; name: string; mode: string }> = localStore?.list?.() ?? [];
          const filteredLocal = rawName
            ? localList.filter((item) => item.name.trim().toLowerCase() === rawName.toLowerCase())
            : localList;
          return sendJson(res, 200, {
            ok: true,
            lanHost,
            lanHostRequested: lanHostRequested(),
            deviceName: device.deviceName,
            hosts: r.hosts,
            localProjects: port
              ? filteredLocal.map((item) => ({
                  ...item,
                  hostDeviceName: device.deviceName,
                  base: `http://127.0.0.1:${port}/docservice`,
                  local: true,
                }))
              : [],
            errors: r.errors,
            elapsedMs: r.elapsedMs,
          }, false);
        } catch (err) {
          log("docservice.error", { stage: "lan-discover-all", message: errText(err) });
          return sendJson(res, 500, { ok: false, error: "internal" }, false);
        }
      });

      // Local Data Server status, commit log, member account management, and creator handover routes (`/api/data-server/*`)
      server.middlewares.use(async (req, res, next) => {
        const p = apiPath(req.url);
        if (!p.startsWith(DATA_SERVER_PREFIX)) return next();
        if (!fromLocalClient(req)) return sendJson(res, 403, { ok: false, error: "forbidden" }, false);
        const sub = p.slice(DATA_SERVER_PREFIX.length - 1);
        const method = String(req.method || "GET").toUpperCase();
        try {
          const [{ localDeviceInfo }, ds] = await Promise.all([
            import("./auth/device.mjs"),
            import("./data-server.mjs"),
          ]);
          const addr = httpServer.address();
          const bound = addr && typeof addr !== "string" ? addr.address : null;
          const port = addr && typeof addr !== "string" ? addr.port : null;
          const lanHost = !!bound && !isLoopbackListen(bound);
          const device = localDeviceInfo();

          if (method === "GET" && sub === "/status") {
            const u = new URL(req.url ?? "/", "http://localhost");
            const projectId = u.searchParams.get("projectId") ?? "";
            const contentId = u.searchParams.get("contentId") ?? "";
            return sendJson(res, 200, ds.inspectLocalDataServer({
              store: localStore,
              dataDir: localDataDir,
              device,
              lanHost,
              port,
              projectId,
              contentId,
            }), false);
          }

          if (method !== "POST") {
            res.statusCode = 405;
            res.setHeader("Allow", "GET, POST");
            res.end();
            return;
          }

          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 256 * 1024) return sendJson(res, 413, { ok: false, error: "too-large" }, false);
          }
          const body = JSON.parse(raw || "{}");

          if (sub === "/export-handover") {
            const pkg = ds.exportHandoverPackage({ store: localStore, projectId: body.projectId });
            return sendJson(res, 200, { ok: true, roomAuth: pkg }, false);
          }
          if (sub === "/adopt") {
            const adopted = ds.adoptDataServerProject({
              store: localStore,
              roomAuth: body.roomAuth,
              lanSync: () => lan.sync(),
            });
            return sendJson(res, 200, {
              ...adopted,
              base: port ? `http://127.0.0.1:${port}/docservice` : null,
              hostDeviceName: device.deviceName,
            }, false);
          }
          if (sub === "/relinquish") {
            const removed = ds.relinquishLocalDataServer({
              store: localStore,
              projectId: body.projectId,
              lanSync: () => lan.sync(),
            });
            return sendJson(res, 200, { ok: true, removed }, false);
          }
          if (sub === "/members") {
            await ds.mutateDataServerMembers({
              store: localStore,
              projectId: body.projectId,
              action: body.action,
              username: body.username,
              password: body.password,
              access: body.access,
              mode: body.mode,
              projectPassword: body.projectPassword,
              deviceId: body.deviceId,
            });
            return sendJson(res, 200, ds.inspectLocalDataServer({
              store: localStore,
              dataDir: localDataDir,
              device,
              lanHost,
              port,
              projectId: body.projectId,
            }), false);
          }
          return sendJson(res, 404, { ok: false, error: "no-endpoint" }, false);
        } catch (err: any) {
          const code = err?.code ?? "bad-request";
          const status = code === "not-local-host" ? 404 : 400;
          return sendJson(res, status, { ok: false, code, error: errText(err) }, false);
        }
      });

      server.middlewares.use((req, res, next) => {
        if (apiPath(req.url) !== HEALTH_PATH) return next();
        const method = String(req.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, HEAD");
          res.end();
          return;
        }
        let body: object;
        try {
          body = service!.health();
        } catch (err) {
          log("docservice.error", { stage: "health", message: errText(err) });
          return sendJson(res, 500, { ok: false, error: "internal" }, method === "HEAD");
        }
        sendJson(res, 200, body, method === "HEAD");
      });

      httpServer.once("close", () => {
        service?.close().catch((err: unknown) => log("docservice.error", { stage: "close", message: errText(err) }));
      });
    },
  };
}

export default docservicePlugin;
