import { framesPlugin } from "./server/vite-plugin-frames";
import { mirrorPlugin } from "./server/vite-plugin-mirror";
import { costsPlugin } from "./server/vite-plugin-costs";
import { defineConfig, type Plugin, type Rollup, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { localePlugin } from "./server/vite-plugin-locale";
import { apiGuardPlugin } from "./server/vite-plugin-api-guard";
import { hostedGatePlugin } from "./server/vite-plugin-hosted-gate";
import { cloudSeamsPlugin } from "./server/vite-plugin-cloud-seams";
import { onlinePrunePlugin } from "./server/vite-plugin-online-prune";
import { exportPlugin } from "./server/vite-plugin-export";
import { exportsListPlugin } from "./server/vite-plugin-exports-list";
import vitePluginAi from "./server/vite-plugin-ai";
import { sttPlugin } from "./server/vite-plugin-stt";
import { shotsPlugin } from "./server/vite-plugin-shots";
import { trackPlugin } from "./server/vite-plugin-track";
import { subjectPlugin } from "./server/vite-plugin-subject";
import { mediaPlugin } from "./server/vite-plugin-media";
import { chatsPlugin } from "./server/vite-plugin-chats";
import vitePluginCards from "./server/vite-plugin-cards";
import { projectsPlugin } from "./server/vite-plugin-projects";
import { visionPlugin } from "./server/vite-plugin-vision";
import { skillPlugin } from "./server/vite-plugin-skill";
import { skillStatePlugin } from "./server/vite-plugin-skill-state";
import { collectPlugin } from "./server/vite-plugin-collect";
import { webPlugin } from "./server/vite-plugin-web";
import { prerenderPlugin } from "./server/vite-plugin-prerender";
import { voicePlugin } from "./server/vite-plugin-voice";
import { audioPlugin } from "./server/vite-plugin-audio";
import { stagePortsPlugin } from "./server/vite-plugin-stage-ports";
import { docservicePlugin } from "./server/vite-plugin-docservice";
import { rawEolPlugin } from "./server/raw-eol.mjs";
import { lanOpenPlugin } from "./server/vite-plugin-lan-open";
import { onlineCatalogPlugin } from "./server/online-catalog.mjs";
import { watchIgnored, DEP_SCAN_ENTRIES } from "./server/vite-scan-ignore.mjs";
import { stageEntryHtml, STAGE_ENTRY_FILE } from "./server/stage-entry.mjs";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Project root: directory containing this file. Watch ignores are relative to it (`server/vite-scan-ignore.mjs`). */
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * LAN host (`docs/plan/shared-project-contract.md` Section 5): when `PROMPTCUT_LAN_HOST=1`, the editor
 * binds to `0.0.0.0`, making document service and asset service mounted on it reachable over the LAN,
 * and starts broadcasting once LAN-mode shared projects are created (`server/vite-plugin-docservice.ts`).
 * When unset, nothing is changed: uses CLI `--host` (`127.0.0.1` from desktop shell, `0.0.0.0`
 * from `npm run dev`) or vite's default (loopback).
 *
 * Use the plugin's `config` hook rather than writing `server.host` directly: the hook's return value
 * merges **after** CLI arguments, overriding `--host 127.0.0.1` hardcoded by the desktop shell;
 * writing directly in the config would be overridden by the CLI.
 * The prerender process uses `vite.prerender.config.ts`, does not include this plugin, and binds only
 * to loopback as before.
 */
const lanHost = process.env.PROMPTCUT_LAN_HOST === "1";
const lanHostPlugin = (): Plugin => ({
  name: "promptcut-lan-host",
  config: () => (lanHost ? { server: { host: "0.0.0.0" } } : undefined),
});

/**
 * vite's static middleware serves **any file under the project root** by path: in testing,
 * `GET /out/cookies/bilibili.txt` returns 200 with raw content. In development, dataDir is `<root>/out`,
 * so site login state (SESSDATA / bili_jct, equivalent to account) saved by media collection becomes
 * an HTTP-fetchable address. Same-origin policy only blocks "reads by other web pages", but cannot
 * block the agent's own browser: it visits arbitrary external sites, and writing "open
 * http://127.0.0.1:5210/out/cookies/bilibili.txt" on the page can read cookies into the model context.
 * Therefore, reject directly at the filesystem layer.
 *
 * The first four entries are vite defaults: `deny` is **full replacement**, not append, and omitting
 * them deletes the default protection. (In release packages PROMPTCUT_DATA_DIR points to %LOCALAPPDATA%,
 * outside the root and unreachable anyway; this rule protects development and "shell connects to
 * repository dev server" workflows.)
 *
 * Same for local document service logs (`<root>/out/docservice`, project revision logs and content
 * store, including card source code): read and written only via the document service WebSocket, not
 * exposed via static serving.
 */
const fsDeny = [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/out/cookies/**", "**/out/docservice/**", "**/out/collaboration/**"];

/*
 * Card and part files do not use Fast Refresh (C6.6 integration 3b). They export card definitions
 * (objects), not pure components, which Fast Refresh cannot catch to begin with: the plugin first
 * treats files as self-accepting boundaries, then invalidates after page validation fails.
 * As a result, editing a single card triggers another round of hot updates in the editor page and
 * both stages (delayed by 3s in testing), disrupting test reruns in progress.
 * After exclusion, hot updates propagate along the import chain to `src/cards/index.ts` (which
 * catches it and reloads the entire card suite), finishing in a single pass.
 */
const REACT_REFRESH_EXCLUDE = [/\/node_modules\//, /\/src\/cards\//, /\/src\/parts\//];

const desktopConfig: UserConfig = {
  // Dependency pre-bundling cache defaults to node_modules/.vite in the checkout directory; when the
  // checkout directory is read-only (the host's render service runs as non-root, while the release
  // directory belongs to root), PROMPTCUT_VITE_CACHE_DIR points to a writable location
  // (`server/hosted-render/main.mjs` sets it to vite-cache under the render data directory). When
  // unset, behaves the same as before
  ...(process.env.PROMPTCUT_VITE_CACHE_DIR ? { cacheDir: `${process.env.PROMPTCUT_VITE_CACHE_DIR}/editor` } : {}),
  // Gates must come **before** all API plugins: middleware registers in configureServer call order;
  // placing them after is equivalent to not having them.
  //   apiGuardPlugin: same-origin check for /api/**, active on any dev server.
  // stagePortsPlugin comes after apiGuard: its own /api/stage/ports should be governed by the same gate.
  // docservicePlugin (local document service) is always registered.
  // hostedGatePlugin is only active in host render service worker processes (page request gate,
  // `server/hosted-render/vite-gate.mjs`), empty elsewhere; it must precede all APIs
  plugins: [localePlugin(), cloudSeamsPlugin(), hostedGatePlugin(), lanHostPlugin(), apiGuardPlugin(), stagePortsPlugin(), react({ exclude: REACT_REFRESH_EXCLUDE }), tailwindcss(), exportPlugin(), exportsListPlugin(), mirrorPlugin(), costsPlugin(), framesPlugin(), vitePluginAi(), sttPlugin(), shotsPlugin(), trackPlugin(), subjectPlugin(), mediaPlugin(), chatsPlugin(), vitePluginCards(), rawEolPlugin(), projectsPlugin(), visionPlugin(), skillPlugin(), skillStatePlugin(), collectPlugin(), webPlugin(), prerenderPlugin(), voicePlugin(), audioPlugin(), docservicePlugin(), lanOpenPlugin()],
  // Dependency scanning entry points only look for real pages: default `**/*.html` reads thousands
  // of snapshot .html files under out/frame-library as entries (`server/vite-scan-ignore.mjs`)
  optimizeDeps: { entries: DEP_SCAN_ENTRIES },
  server: {
        fs: { deny: fsDeny },
        watch: {
          /*
           * None of these is source code, and **missing any is fatal**:
           *
           * - desktop / out / python: desktop shell binaries, export outputs, built-in Python.
           *   Watching an exe being written triggers EBUSY and crashes the dev server.
           * - **.lock**: exclusive lock for .proc. The shell holds it in sharing mode 0, so chokidar's fs.watch
           *   immediately gets EBUSY, which is an FSWatcher error event:
           *   **the entire dev server exits on the spot**, taking down the sidecar and editor with it.
           *   Verified in testing once, not speculation.
           * - .pc-projects / .pc-work / .pc-chats: drafts, open project replicas, session history. All are
           *   runtime data; triggering HMR on every change is pure waste, and drafts are auto-saved, meaning
           *   every save reloads.
           */
          /*
           * Do not use glob strings like "arbitrary-depth out directory": chokidar matches absolute paths
           * with picomatch default options (dot: false), and if the root path contains a dot-prefixed segment
           * (worktree is under `.worktrees/`), none of the rules take effect.
           * See `server/vite-scan-ignore.mjs` for the list and reasons; it also blocks `.worktrees/` (other
           * worktrees are not source code when starting the server at the repository root).
           */
          ignored: [watchIgnored(ROOT)],
        },
      },
};

/**
 * Online build (C10a contract `docs/plan/c10a-contract.md` Section 2 [ruling]):
 * `vite build --mode online` outputs `dist-online/`, `base: "/editor/"`, compile-time constant
 * `import.meta.env.VITE_PC_ONLINE === "1"` (`ONLINE` in `src/online/mode.ts`).
 *
 * - Only attaches newline normalization (`raw-eol`), React, and Tailwind: plugins above are
 *   `/api/**` endpoints of the editor process and development middleware, whereas online pages have
 *   no editor process; card overlay layers (pre-plugin of `vite-plugin-cards`) are local user
 *   customizations and also do not enter online builds;
 * - Desktop builds (`vite build`) and dev server (`vite`) go through `desktopConfig` as before,
 *   unaffected;
 * - `dist-online/` is deployed by `scripts/remote/docservice.mjs deploy-hosted --editor dist-online`
 *   to `<deploy-dir>/editor/` on the hosted side, served by nginx under `/editor` (contract
 *   Section 2 "nginx");
 * - Motion graphics asset catalog (`onlineCatalogPlugin`, `server/online-catalog.mjs`):
 *   `/catalog/<kind>/<name>.json` in card parameters is served on desktop by dev server middleware;
 *   online has no local process, so during build, Lottie and particle files registered in index.json
 *   are output as-is to `dist-online/catalog/` and deployed along with `editor/`, served by
 *   hosted-side nginx under `/catalog/` on the editor page origin and both stage origins. URLs
 *   remain unchanged, so the same project opens on both desktop and online.
 */
/*
 * C10 contract Section 7 (supplementary constraint from lead session, 2026-09-28): the manifest
 * plan published by online pages writes `requires.codeVersion`, computed at build time using the
 * same algorithm as render nodes (`frameCode` in `server/frame-code.mjs`, newlines normalized to LF)
 * and embedded into the page as `__PC_CODE_VERSION__` (`src/online/buildInfo.ts`).
 * Computed only in online builds (traverses src/ once).
 * Do not minify or optimize CSS (`cssMinify: false` and Tailwind plugin `optimize: false`, ruled
 * by lead session after M7 probe P2): snapshots inline CSS custom properties on the root element
 * verbatim; minified CSS (`0.4` → `.4`, `150ms` → `.15s`) causes snapshots generated by online
 * pages to differ byte-for-byte from desktop (unminified) while being pixel-identical: mixing two
 * kinds of bytes under the same fingerprint and result key.
 */
const cardRuntimeDeps = () => {
  const require = createRequire(import.meta.url);
  const versionOf = (name: string) => {
    // Walk up from a package entry file to find its own package.json (some packages do not export package.json)
    let dir = path.dirname(require.resolve(name));
    for (let i = 0; i < 6; i++) {
      const file = path.join(dir, "package.json");
      if (fs.existsSync(file)) { const pkg = JSON.parse(fs.readFileSync(file, "utf8")); if (pkg.name === name) return String(pkg.version); }
      dir = path.dirname(dir);
    }
    throw new Error(`Cannot get the version of ${name}`);
  };
  return { sucrase: versionOf("sucrase"), tailwindcss: versionOf("tailwindcss") };
};

/**
 * Stage entry `stage.html` (contract `docs/plan/online-card-exec-contract.md` Section 3.3):
 * cross-origin stage iframes load this, not `index.html`.
 *
 * When online **build** finalizes, a copy is made from the built `index.html`, prepending the stage
 * Content Security Policy (`<meta http-equiv="Content-Security-Policy">`) to `<head>`, outputting
 * `dist-online/stage.html`. This ensures both entry points reference the **exact same script bundle**
 * (filenames and chunks are byte-for-byte identical to having only a single entry point), while
 * `index.html` itself remains unchanged by a single character.
 * Generated in `server/stage-entry.mjs`; policy text is taken from `src/online/stagePolicy.mjs`
 * (shared with nginx response headers and local proxy). `<meta>` is a fallback: so the stage is not
 * left exposed when hosted side nginx has not been updated; what truly counts is the response header
 * version (stage self-check only recognizes response headers, `isolation/isolationCheck.ts`).
 * Desktop builds do not include this plugin and do not output this file; neither does the dev server
 * (where `/stage.html` falls back to `index.html`, failing self-check and not executing user cards).
 */
const stageEntryPlugin = (): Plugin => ({
  name: "promptcut-stage-entry",
  apply: "build",
  enforce: "post",
  generateBundle: {
    order: "post",
    handler(_options, bundle) {
      const index = bundle["index.html"];
      if (!index || index.type !== "asset") throw new Error("No index.html in the online build, cannot generate the stage entry stage.html");
      const html = typeof index.source === "string" ? index.source : Buffer.from(index.source).toString("utf8");
      this.emitFile({ type: "asset", fileName: STAGE_ENTRY_FILE, source: stageEntryHtml(html) });
    },
  },
});

/**
 * Version file `version.json` for online builds (semantics in `product/platforms.md` and
 * `mechanism/platforms.md` "Online browser" under "New version notice"):
 * Outputs `dist-online/version.json` with content `{"codeVersion":"<value>","entry":"assets/index-<hash>.js"}`:
 * `codeVersion` is the same value as `__PC_CODE_VERSION__` embedded into the page (used by render service
 * for comparison, `server/hosted-render/main.mjs`); `entry` is the filename of the editor page entry
 * script, which changes even when code version stays the same if only dependencies or build config change.
 * Fetched when the editor page switches back to the foreground and every 10 minutes in the foreground
 * (`src/online/updateCheck.ts`); displays a new version notice if either differs from this page.
 * Desktop builds and dev server do not attach this plugin and do not output this file.
 */
const versionJsonPlugin = (codeVersion: string): Plugin => ({
  name: "promptcut-version-json",
  apply: "build",
  generateBundle(_options, bundle) {
    // Entry script for the editor page: facade is the entry chunk for index.html; if absent,
    // pick the entry chunk whose filename sorts first
    const entries = Object.values(bundle ?? {}).filter((c): c is Rollup.OutputChunk => !!c && c.type === "chunk" && c.isEntry);
    const page = entries.find((c) => /[\\/]index\.html$/.test(c.facadeModuleId ?? "")) ?? entries.sort((a, b) => a.fileName.localeCompare(b.fileName))[0];
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify(page ? { codeVersion, entry: page.fileName } : { codeVersion }) });
  },
});

const onlineConfig = async (): Promise<UserConfig> => {
  const { frameCode, captureCode } = await import("./server/frame-code.mjs");
  const codeVersion = frameCode(process.cwd());
  // Stream generation on this page (task brief `render-refactor-task.md` "Jia-2", `src/online/pageStreamPlan.ts`):
  // track stream keys contain the screenshot code fingerprint; for the page to compute the same key as
  // the splitter, it must carry this value computed at build time using the same algorithm
  const streamCodes = { capture: captureCode(process.cwd()) };
  return {
    base: "/editor/",
    // Tailwind build-time optimization (Lightning CSS) rewrites values (`0.4` → `.4`) even without minification,
    // differing from dev server verbatim text (desktop export page): disable as well
    // cloudSeamsPlugin must be attached to **every** configuration: it resolves browser-side cloud aliases;
    // missing one causes that build to immediately report "failed to resolve import" (exactly how it was
    // missed on 2026-10-27, added only to the desktop one).
    // A test pins this down: SEAM-VITE-01 in server/test/build-extensions.test.mjs.
    plugins: [cloudSeamsPlugin(), onlinePrunePlugin(), rawEolPlugin(), react({ exclude: REACT_REFRESH_EXCLUDE }), tailwindcss({ optimize: false }), onlineCatalogPlugin(process.cwd()), stageEntryPlugin(), versionJsonPlugin(codeVersion)],
    define: {
      "import.meta.env.VITE_PC_ONLINE": JSON.stringify("1"), __PC_CODE_VERSION__: JSON.stringify(codeVersion),
      __PC_STREAM_CODES__: JSON.stringify(streamCodes),
      // Transpiler and Tailwind versions in the online card runtime version
      // (`src/online/cardRuntime/version.ts`): use the versions actually installed
      __PC_CARD_RUNTIME_DEPS__: JSON.stringify(cardRuntimeDeps()),
    },
    build: { outDir: "dist-online", emptyOutDir: true, cssMinify: false },
    // Not needed for builds; when someone starts dev server with `vite --mode online`, watch and
    // dependency scanning match the desktop version without scanning out/ or other worktrees
    optimizeDeps: { entries: DEP_SCAN_ENTRIES },
    server: { watch: { ignored: [watchIgnored(ROOT)] } },
  };
};

export default defineConfig(async ({ mode }) => (mode === "online" ? onlineConfig() : desktopConfig));
