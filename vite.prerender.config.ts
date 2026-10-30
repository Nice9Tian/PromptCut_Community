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
 * 预渲染进程的 Vite(docs/archive/topics/decoupling-plan.md 第 3 节「预渲染」)。
 *
 * 由编辑器那一端的 dev server(server/vite-plugin-prerender.ts)用 PROMPTCUT_ROLE=prerender 拉起,
 * 独立进程、独立端口、低于正常的进程优先级。它做三件事:
 *
 *   1. 渲染池、导出、Agent 的看图请求 —— 渲染请求挂在**这个**源上,不占编辑器那个源的 6 条连接;
 *   2. 渲染用的 Chrome 从**这里**加载导出页和卡片模块,不和编辑器抢它那个 Vite;
 *   3. PNG 的像素活在渲染 worker 里做(server/png-post.mjs),这个进程的事件循环只收发。
 *
 * 只挂导出页需要的插件:没有 vite-plugin-ai(它会改写全局 port.json,把 MCP 指到这里来),
 * 没有听写 / 镜头 / 追踪 / 素材收集这些会起子进程的插件。
 */

/**
 * 只放行编辑器那一端的源(环境变量里给的几个写法:127.0.0.1 / localhost / [::1])。
 * 浏览器发 JSON POST 会先发预检,这里答了预检,后面的同源守卫(apiGuardPlugin → originOk)
 * 也按同一张名单放行 —— 两处用同一个环境变量,不会一个放一个拦。
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
 * 素材路由(`/@media/*`、`/api/asset/*`、`/api/media/*`):预渲染进程只经素材服务的 HTTP API 读素材
 * (`docs/semantics/product/asset-service.md`「职责」),所以由编辑器那一端拉起时(给了
 * `PROMPTCUT_EDITOR_URL`,本地素材服务就在那个进程里)整条转发过去,自己不再读本地内容库。
 * 没给这个变量(脚本直接用这份配置起一台)时没有别处可转,仍挂本地的媒体插件。
 */
function mediaRoutes(): Plugin {
  const editor = String(process.env.PROMPTCUT_EDITOR_URL || "").trim();
  return editor ? assetProxyPlugin(editor) : mediaPlugin();
}

const fsDeny = [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/out/cookies/**"];

export default defineConfig({
  // 依赖预构建缓存和编辑器那一份分开,两个进程同时写 node_modules/.vite 会互相踩
  // PROMPTCUT_VITE_CACHE_DIR：检出目录只读时把缓存指到可写的地方（见 vite.config.ts 同名处）；不设时与原来相同
  cacheDir: process.env.PROMPTCUT_VITE_CACHE_DIR
    ? `${process.env.PROMPTCUT_VITE_CACHE_DIR}/${process.env.PROMPTCUT_HEADLESS === "1" ? "prerender-headless" : "prerender"}`
    : process.env.PROMPTCUT_HEADLESS === "1" ? "node_modules/.vite-prerender-headless" : "node_modules/.vite-prerender",
  clearScreen: false,
  // 依赖扫描入口只找真正的页面,不把 out/frame-library 下的快照 .html 当入口(`server/vite-scan-ignore.mjs`)
  optimizeDeps: { entries: DEP_SCAN_ENTRIES },
  // 跨源守卫要排在所有接口前面(中间件按 configureServer 的调用顺序注册)
  // hostedGatePlugin 只在托管方渲染服务的工作进程里生效(页面请求闸、出口代理,`server/hosted-render/vite-gate.mjs`),别处是空的
  plugins: [cloudSeamsPlugin(), prerenderGatePlugin(), hostedGatePlugin(), corsForEditor(), apiGuardPlugin(), react(), tailwindcss(), exportPlugin(), mirrorPlugin(), costsPlugin(), framesPlugin(), mediaRoutes(), vitePluginCards(), rawEolPlugin(), visionPlugin()],
  server: {
    // 渲染页每一趟都是全新的页面,用不着热更新;源码改了照样重新变换(watcher 还开着)
    hmr: false,
    fs: { deny: fsDeny },
    // 按相对项目根的路径段判断,不用 glob 字符串(worktree 路径里的 `.worktrees` 会让 glob 全部失效),名单见 `server/vite-scan-ignore.mjs`
    watch: { ignored: [watchIgnored(path.dirname(fileURLToPath(import.meta.url)))] },
  },
});
