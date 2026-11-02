import type { AddressInfo } from "node:net";
import type { Plugin, ViteDevServer } from "vite";
import { selectInterfaces } from "./lan/discovery.mjs";
import { fromLocalClient } from "./http-guard.mjs";
import { LAN_OPEN_PATH, lanOpenInfo } from "./lan-open.mjs";

/**
 * The "Open on mobile" query (semantics `docs/semantics/mechanism/platforms.md` "Second screen on
 * LAN").
 *
 *   `GET /api/lan-open` → `{ lanHost, port, command, addresses: [{ name, address }] }`
 *
 * Only answers one thing: whether this machine's editor is currently bound to the LAN, and which
 * LAN addresses it has. Accessing projects across devices uses invite links for shared projects;
 * the link and QR code are constructed by the page itself (`src/editor/LanOpenDialog.tsx`), so this
 * endpoint does not touch projects or sign any tokens.
 *
 * **Only responds to loopback requests**: this information is intended for the editor page on the
 * desktop machine. Others on the LAN do not need to know which subnets this machine has. Loopback
 * check uses `fromLocalClient` in `http-guard.mjs`, applying the same standard as other management
 * endpoints.
 *
 * Address lists are fetched on the fly: network interfaces may be plugged or unplugged and change
 * subnets, so caching would only yield stale addresses. `selectInterfaces` already filters out
 * loopback, link-local (169.254/16), and disabled interfaces. Whether it is bound to the LAN is
 * determined by the actual listening address; see `boundToLan` in `lan-open.mjs`.
 */
export function lanOpenPlugin(): Plugin {
  return {
    name: "promptcut-lan-open",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(LAN_OPEN_PATH, (req, res, next) => {
        if ((req.method ?? "GET") !== "GET") return next();
        if (!fromLocalClient(req)) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "This message is only for the editor page on this machine" }));
          return;
        }
        const addr = server.httpServer?.address();
        const bound = addr && typeof addr === "object" ? (addr as AddressInfo).address : addr;
        const port = addr && typeof addr === "object" ? (addr as AddressInfo).port : null;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify(lanOpenInfo({ bound, port, nics: selectInterfaces() })));
      });
    },
  };
}
