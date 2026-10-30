/**
 * Agent 的网页操作:`/api/web/*`。
 *
 * 真正干活的在 server/web/ 四个模块里（browser 起实例、view 出图和清单、hit 把坐标
 * 翻成 uid、session 是动作层），这里只做三件事：把 HTTP 请求分发过去、保证同一时刻
 * 只有一个动作在跑、把浏览器的懒启动收在一个地方。
 *
 * ## 为什么浏览器是懒启动的
 *
 * 起一个有头 Chrome 要几百毫秒还占一份内存，而大多数会话根本不上网。所以第一次
 * web_open 才起，`closeBrowser()` 之后又回到没有的状态。用户手动关掉窗口也不会留下
 * 一个死实例——getBrowser 每次会看 `browser.connected`。
 *
 * ## executablePath 为什么必须显式给
 *
 * `PUPPETEER_CACHE_DIR` 只有 Tauri 正式包里才设（desktop/src-tauri/src/lib.rs:338）。
 * dev 下 puppeteer 会去用开发机自己的 `~/.cache/puppeteer` —— 实测确实如此，两边版本
 * 碰巧都是 152.0.7977.75 所以一直没出事。一旦不一样，就是「跑起来的不是随包那份」
 * 这种极难查的问题，所以这里按 VERSIONS.json 里的版本号算出确切路径传进去，
 * 算不出来才退回让 puppeteer 自己找。
 */
import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "http";
import type { Connect } from "vite";
import path from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { readBody, dataDir } from "./vite-plugin-stt";

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

/**
 * 找随包那份 Chrome。找不到返回 undefined —— 那时候 puppeteer 会用它自己的缓存，
 * dev 下这是对的，正式包里则说明 runtime/chrome 没组装好，让它自己报错更清楚。
 */
export function findBundledChrome(root: string): string | undefined {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR
    ?? path.join(root, "desktop", "src-tauri", "runtime", "chrome");
  const chromeRoot = path.join(cacheDir, "chrome");
  if (!existsSync(chromeRoot)) return undefined;
  // 目录名形如 win64-152.0.7977.75，正常只有一个；有多个就取字典序最大的那个
  const builds = readdirSync(chromeRoot).filter((d) => d.startsWith("win")).sort();
  const build = builds[builds.length - 1];
  if (!build) return undefined;
  const exe = path.join(chromeRoot, build, "chrome-win64", "chrome.exe");
  return existsSync(exe) ? exe : undefined;
}

export function webPlugin(): Plugin {
  return {
    name: "vite-plugin-web",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;

      // 动态 import：这几个模块拉起 puppeteer，不上网的会话不该为它们付启动成本
      const mods = async () => ({
        browser: await import("./web/browser.mjs"),
        session: await import("./web/session.mjs"),
      });

      /** 拿到浏览器实例。没起过就起 */
      async function inst() {
        const { browser } = await mods();
        return browser.getBrowser({
          dataDir: dataDir(root),
          executablePath: findBundledChrome(root),
        });
      }

      server.middlewares.use(async (req: Connect.IncomingMessage, res, next) => {
        if (!req.url?.startsWith("/api/web")) return next();
        const url = req.url.split("?")[0];
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只支持 POST" });

        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          if (raw.length) body = JSON.parse(raw.toString("utf-8"));
        } catch {
          return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
        }

        const { session } = await mods();
        // 所有动作串行：共用一个页，并发点击没有意义，而且这台机器上并发浏览器
        // 实例多了会 0xC0000142（见 vite-plugin-vision.ts 那条注释）
        return session.enqueue(async () => {
          try {
            if (url === "/api/web/close") {
              const { browser } = await mods();
              await browser.closeBrowser();
              return sendJson(res, 200, { ok: true, closed: true });
            }

            const it = await inst();

            if (url === "/api/web/open") {
              if (!body.url) return sendJson(res, 400, { ok: false, error: "要给 url" });
              return sendJson(res, 200, await session.open(it.page, String(body.url)));
            }
            if (url === "/api/web/view")   return sendJson(res, 200, await session.view(it.page));
            if (url === "/api/web/click")  return sendJson(res, 200, await session.click(it.page, body));
            if (url === "/api/web/type")   return sendJson(res, 200, await session.type(it.page, body));
            if (url === "/api/web/scroll") return sendJson(res, 200, await session.scroll(it.page, body));
            if (url === "/api/web/read")   return sendJson(res, 200, await session.read(it.page, body));
            if (url === "/api/web/handoff") return sendJson(res, 200, await session.handoff(it, body));

            return sendJson(res, 404, { ok: false, error: `没有这个接口:${url}` });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return sendJson(res, 200, { ok: false, error: msg });
          }
        });
      });
    },
  };
}
