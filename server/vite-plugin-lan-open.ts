import type { AddressInfo } from "node:net";
import type { Plugin, ViteDevServer } from "vite";
import { selectInterfaces } from "./lan/discovery.mjs";
import { fromLocalClient } from "./http-guard.mjs";
import { LAN_OPEN_PATH, lanOpenInfo } from "./lan-open.mjs";

/**
 * 「在手机上打开」这条问答（语义 `docs/semantics/mechanism/platforms.md`「局域网里的第二块屏」）。
 *
 *   `GET /api/lan-open` → `{ lanHost, port, command, addresses: [{ name, address }] }`
 *
 * 只答一件事：这台机器的编辑器现在绑在局域网上没有、局域网地址是哪几个。跨设备进项目走的是共享项目的
 * 邀请链接，链接与二维码由页面自己拼（`src/editor/LanOpenDialog.tsx`），所以这里不碰项目、不签任何码。
 *
 * **只答回环的请求**：这条信息是给桌面那台机器上的编辑页面看的。局域网里的别人不需要知道本机有哪几个
 * 网段。判回环用 `http-guard.mjs` 的 `fromLocalClient`，和别的管理口同一把尺。
 *
 * 地址列表现取：网卡会插拔、会换网段，缓存只会给出过期的地址。`selectInterfaces` 已经排掉回环、
 * 链路本地（169.254/16）和没启用的网卡。绑没绑局域网按实际监听地址判，见 `lan-open.mjs` 的 `boundToLan`。
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
          res.end(JSON.stringify({ error: "这条信息只给本机的编辑页面" }));
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
