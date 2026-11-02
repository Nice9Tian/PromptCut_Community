import { framesPlugin } from "./server/vite-plugin-frames";
import { mirrorPlugin } from "./server/vite-plugin-mirror";
import { costsPlugin } from "./server/vite-plugin-costs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { apiGuardPlugin } from "./server/vite-plugin-api-guard";
import { hostedGatePlugin } from "./server/vite-plugin-hosted-gate";
import { cloudSeamsPlugin } from "./server/vite-plugin-cloud-seams";
import { exportPlugin } from "./server/vite-plugin-export";
import { mediaPlugin } from "./server/vite-plugin-media";
import { assetProxyPlugin } from "./server/asset-client";
import vitePluginCards from "./server/vite-plugin-cards";
import { visionPlugin } from "./server/vite-plugin-vision";
import { prerenderGatePlugin } from "./server/prerender-gate.mjs";
import { rawEolPlugin } from "./server/raw-eol.mjs";
import { watchIgnored, DEP_SCAN_ENTRIES } from "./server/vite-scan-ignore.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Vite for the prerender process (docs/archive/topics/decoupling-plan.md Section 3 "Prerender").
 *
 * Spawned by the dev server on the editor side (server/vite-plugin-prerender.ts) with
 * PROMPTCUT_ROLE=prerender, running in a separate process on a separate port with lower-than-normal
 * process priority. It handles three things:
 *
 *   1. Render pool, export, and Agent image viewing requests: render requests attach to **this**
 *      origin, without occupying the 6 connections on the editor origin;
 *   2. Chrome used for rendering loads export pages and card modules from **here**, avoiding competing
 *      with the editor for its Vite instance;
 *   3. PNG pixel work is done in the render worker (server/png-post.mjs); this process's event loop
 *      only handles sending and receiving.
 *
 * Attaches only plugins needed by export pages: no vite-plugin-ai (which rewrites the global
 * port.json and redirects MCP here), and no speech-to-text / shot / tracking / media collection
 * plugins that spawn subprocesses.
 */

/**
 * Allow only origins from the editor side (several formats given in environment variables:
 * 127.0.0.1 / localhost / [::1]).
 * When a browser sends a JSON POST, it sends a preflight first; this answers the preflight, and the
 * same-origin guard downstream (apiGuardPlugin → originOk) also allows requests matching the same
 * list: both places use the same environment variable, avoiding one allowing while the other blocks.
 */
function corsForEditor(): Plugin {
  const allowed = new Set(String(process.env.PROMPTCUT_CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean));
  return {
    name: "promptcut-prerender-cors",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && allowed.has(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Max-Age", "600");
          if (req.method === "OPTIONS") {
            res.statusCode = 204;
            return res.end();
          }
        }
        next();
      });
    },
  };
}

/**
 * Media routing (`/@media/*`, `/api/asset/*`, `/api/media/*`): the prerender process reads assets
 * only via the asset service HTTP API (`docs/semantics/product/asset-service.md` "Responsibilities"),
 * so when spawned by the editor side (when `PROMPTCUT_EDITOR_URL` is provided, the local asset
 * service lives in that process), forward the entire route there instead of reading the local content
 * store directly. When this variable is not provided (e.g. when a script starts an instance directly
 * with this configuration), there is nowhere else to forward, so still attach the local media plugin.
 */
function mediaRoutes(): Plugin {
  const editor = String(process.env.PROMPTCUT_EDITOR_URL || "").trim();
  return editor ? assetProxyPlugin(editor) : mediaPlugin();
}

const fsDeny = [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/out/cookies/**"];

export default defineConfig({
  // Dependency pre-bundling cache is separated from the editor's copy; two processes writing to
  // node_modules/.vite simultaneously will step on each other
  // PROMPTCUT_VITE_CACHE_DIR: points cache to a writable location when the checkout directory is read-only
  // (see the same name in vite.config.ts); unchanged when unset
  cacheDir: process.env.PROMPTCUT_VITE_CACHE_DIR
    ? `${process.env.PROMPTCUT_VITE_CACHE_DIR}/${process.env.PROMPTCUT_HEADLESS === "1" ? "prerender-headless" : "prerender"}`
    : process.env.PROMPTCUT_HEADLESS === "1" ? "node_modules/.vite-prerender-headless" : "node_modules/.vite-prerender",
  clearScreen: false,
  // Dependency scanning entry points look only for real pages, not treating snapshot .html
  // under out/frame-library as entry points (`server/vite-scan-ignore.mjs`)
  optimizeDeps: { entries: DEP_SCAN_ENTRIES },
  // Cross-origin guard must precede all endpoints (middleware is registered in configureServer call order)
  // hostedGatePlugin is only active in host render service worker processes (page request gate,
  // egress proxy, `server/hosted-render/vite-gate.mjs`); empty elsewhere
  plugins: [cloudSeamsPlugin(), prerenderGatePlugin(), hostedGatePlugin(), corsForEditor(), apiGuardPlugin(), react(), tailwindcss(), exportPlugin(), mirrorPlugin(), costsPlugin(), framesPlugin(), mediaRoutes(), vitePluginCards(), rawEolPlugin(), visionPlugin()],
  server: {
    // Every pass of a render page is a fresh page, so HMR is unnecessary; source changes are still
    // transformed anew (watcher remains enabled)
    hmr: false,
    fs: { deny: fsDeny },
    // Check by path segments relative to project root instead of glob strings (`.worktrees` in
    // worktree paths invalidates all globs); see `server/vite-scan-ignore.mjs` for the list
    watch: { ignored: [watchIgnored(path.dirname(fileURLToPath(import.meta.url)))] },
  },
});
