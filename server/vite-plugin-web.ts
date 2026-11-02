/**
 * Agent web operations: `/api/web/*`.
 *
 * The real work is done in four modules under server/web/ (browser spawns instances, view generates
 * images and manifests, hit translates coordinates into uids, session is action layer); this only does
 * three things: dispatch HTTP requests there, ensure only one action runs at a time, and consolidate
 * lazy browser launching in one place.
 *
 * ## Why the browser is lazily launched
 *
 * Launching a headed Chrome takes several hundred milliseconds and consumes memory, while most
 * sessions never access web. Therefore it is only launched on first web_open, and returns to
 * unlaunched state after `closeBrowser()`. Users manually closing window also will not leave a dead
 * instance: getBrowser checks `browser.connected` every time.
 *
 * ## Why executablePath must be explicitly provided
 *
 * `PUPPETEER_CACHE_DIR` is only set in release Tauri packages (desktop/src-tauri/src/lib.rs:338).
 * Under dev, puppeteer uses `~/.cache/puppeteer` on development machine itself: confirmed in testing,
 * both versions happened to be 152.0.7977.75 so no issues arose. Once they differ, extremely elusive
 * issues like "the running copy is not the bundled one" occur, so exact path is calculated from version
 * number in VERSIONS.json and passed in here, falling back to letting puppeteer locate it only when
 * calculation fails.
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
 * Find bundled Chrome copy. Returns undefined if not found: at that point puppeteer uses its own
 * cache, which is correct under dev, while in release packages it indicates runtime/chrome was not
 * assembled properly, letting it throw its own clearer error.
 */
export function findBundledChrome(root: string): string | undefined {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR
    ?? path.join(root, "desktop", "src-tauri", "runtime", "chrome");
  const chromeRoot = path.join(cacheDir, "chrome");
  if (!existsSync(chromeRoot)) return undefined;
  // Directory name is formatted like win64-152.0.7977.75, normally only one; if multiple exist, pick the lexicographically largest one
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

      // Dynamic import: these modules launch puppeteer; sessions that do not access web should not pay their startup cost
      const mods = async () => ({
        browser: await import("./web/browser.mjs"),
        session: await import("./web/session.mjs"),
      });

      /** Get browser instance. Launch if not already launched */
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
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Only POST is supported" });

        let body: Record<string, unknown> = {};
        try {
          const raw = await readBody(req);
          if (raw.length) body = JSON.parse(raw.toString("utf-8"));
        } catch {
          return sendJson(res, 400, { ok: false, error: "Request body is not valid JSON" });
        }

        const { session } = await mods();
        // All actions are serialized: sharing a single page, concurrent clicks make no sense, and too many
        // concurrent browser instances on this machine will cause 0xC0000142 (see comment in vite-plugin-vision.ts)
        return session.enqueue(async () => {
          try {
            if (url === "/api/web/close") {
              const { browser } = await mods();
              await browser.closeBrowser();
              return sendJson(res, 200, { ok: true, closed: true });
            }

            const it = await inst();

            if (url === "/api/web/open") {
              if (!body.url) return sendJson(res, 400, { ok: false, error: "url is required" });
              return sendJson(res, 200, await session.open(it.page, String(body.url)));
            }
            if (url === "/api/web/view")   return sendJson(res, 200, await session.view(it.page));
            if (url === "/api/web/click")  return sendJson(res, 200, await session.click(it.page, body));
            if (url === "/api/web/type")   return sendJson(res, 200, await session.type(it.page, body));
            if (url === "/api/web/scroll") return sendJson(res, 200, await session.scroll(it.page, body));
            if (url === "/api/web/read")   return sendJson(res, 200, await session.read(it.page, body));
            if (url === "/api/web/handoff") return sendJson(res, 200, await session.handoff(it, body));

            return sendJson(res, 404, { ok: false, error: `No such endpoint: ${url}` });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return sendJson(res, 200, { ok: false, error: msg });
          }
        });
      });
    },
  };
}
