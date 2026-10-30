import { framesPlugin } from "./server/vite-plugin-frames";
import { mirrorPlugin } from "./server/vite-plugin-mirror";
import { costsPlugin } from "./server/vite-plugin-costs";
import { defineConfig, type Plugin, type Rollup, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
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

/** 项目根:本文件所在目录。监听忽略按相对它的路径判断(`server/vite-scan-ignore.mjs`)。 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * 局域网主机(`docs/plan/shared-project-contract.md` 第 5 节):`PROMPTCUT_LAN_HOST=1` 时编辑器绑 `0.0.0.0`,
 * 挂在它上面的文档服务与素材服务随之对局域网可达,局域网模式的共享项目建成后开始广播(`server/vite-plugin-docservice.ts`)。
 * 不设时什么都不改:沿用命令行的 `--host`(桌面壳给 `127.0.0.1`,`npm run dev` 给 `0.0.0.0`)或 vite 的缺省(回环)。
 *
 * 用插件的 `config` 钩子而不是直接写 `server.host`:钩子的返回值合并在命令行参数**之后**,能压过桌面壳写死的
 * `--host 127.0.0.1`;直接写在配置里会被命令行盖掉。
 * 预渲染进程用的是 `vite.prerender.config.ts`,不含这个插件,照旧只绑回环。
 */
const lanHost = process.env.PROMPTCUT_LAN_HOST === "1";
const lanHostPlugin = (): Plugin => ({
  name: "promptcut-lan-host",
  config: () => (lanHost ? { server: { host: "0.0.0.0" } } : undefined),
});

/**
 * vite 的静态中间件会把**项目根下的任意文件**按路径发出去 —— 实测
 * `GET /out/cookies/bilibili.txt` 是 200,内容原样。开发期 dataDir 就是 `<root>/out`,
 * 于是素材收集存下的站点登录态(SESSDATA / bili_jct,等于账号)成了一条 HTTP 可取的地址。
 * 同源策略只挡「别的网页读」,挡不住 agent 自己那个浏览器:它会去任意外站,
 * 页面上写一句「打开 http://127.0.0.1:5210/out/cookies/bilibili.txt」就能把 cookie
 * 读进模型上下文。所以在文件系统这一层直接拒掉。
 *
 * 前四条是 vite 的默认值:`deny` 是**整体替换**不是追加,不带上就等于把默认防护删了。
 * (正式包里 PROMPTCUT_DATA_DIR 指向 %LOCALAPPDATA%,不在根下,本来就取不到;
 *  这一条保的是开发期和「壳连仓库 dev server」那种跑法。)
 *
 * 本地文档服务的日志(`<root>/out/docservice`,项目版本日志与内容库,含卡片源码)同理:
 * 只经文档服务的 WebSocket 读写,不经静态服务暴露。
 */
const fsDeny = [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/out/cookies/**", "**/out/docservice/**", "**/out/collaboration/**"];

/*
 * 卡片、部件文件不做 Fast Refresh(C6.6 集成 3b)。它们导出的是卡片定义(对象),不是纯组件,
 * Fast Refresh 本来就接不住:插件先把文件当成自接的边界,页面里校验不过再 invalidate,
 * 于是每改一张卡,编辑器页面和两个舞台各自再触发一轮热更新(实测晚到 3 s),正好打断在跑的重测。
 * 排除之后热更新直接沿导入链走到 `src/cards/index.ts`(它自己接住、重装整套卡片),一次就完。
 */
const REACT_REFRESH_EXCLUDE = [/\/node_modules\//, /\/src\/cards\//, /\/src\/parts\//];

const desktopConfig: UserConfig = {
  // 依赖预构建缓存缺省在检出目录的 node_modules/.vite；检出目录只读时（托管方的渲染服务以非 root 用户跑，发布目录属 root）
  // 由 PROMPTCUT_VITE_CACHE_DIR 指到可写的地方（`server/hosted-render/main.mjs` 设成渲染数据目录下的 vite-cache）。不设时与原来相同
  ...(process.env.PROMPTCUT_VITE_CACHE_DIR ? { cacheDir: `${process.env.PROMPTCUT_VITE_CACHE_DIR}/editor` } : {}),
  // 卡口必须排在所有接口插件**前面**:中间件按 configureServer 的调用顺序注册,排在后面就等于没有。
  //   apiGuardPlugin  —— /api/** 的同源校验,任何 dev server 都生效。
  // stagePortsPlugin 排在 apiGuard 后面:它自己那条 /api/stage/ports 也该受同一道卡口管。
  // docservicePlugin(本地文档服务)总是注册。
  // hostedGatePlugin 只在托管方渲染服务的工作进程里生效(页面请求闸,`server/hosted-render/vite-gate.mjs`),别处是空的;它要先于一切接口
  plugins: [cloudSeamsPlugin(), hostedGatePlugin(), lanHostPlugin(), apiGuardPlugin(), stagePortsPlugin(), react({ exclude: REACT_REFRESH_EXCLUDE }), tailwindcss(), exportPlugin(), exportsListPlugin(), mirrorPlugin(), costsPlugin(), framesPlugin(), vitePluginAi(), sttPlugin(), shotsPlugin(), trackPlugin(), subjectPlugin(), mediaPlugin(), chatsPlugin(), vitePluginCards(), rawEolPlugin(), projectsPlugin(), visionPlugin(), skillPlugin(), skillStatePlugin(), collectPlugin(), webPlugin(), prerenderPlugin(), voicePlugin(), audioPlugin(), docservicePlugin(), lanOpenPlugin()],
  // 依赖扫描入口只找真正的页面:缺省的 `**/*.html` 会把 out/frame-library 下成千上万个快照 .html 当入口读一遍(`server/vite-scan-ignore.mjs`)
  optimizeDeps: { entries: DEP_SCAN_ENTRIES },
  server: {
        fs: { deny: fsDeny },
        watch: {
          /*
           * 这里每一条都不是源码,而且**漏掉会出人命**:
           *
           * - desktop / out / python:桌面壳的二进制、导出产物、内置 Python。
           *   watch 到正在写的 exe 会 EBUSY 把 dev server 崩掉。
           * - **.lock**:.proc 的独占锁。外壳用共享模式 0 握着它,chokidar 去 fs.watch
           *   立刻拿到 EBUSY,而那是 FSWatcher 的 error 事件 —— **整个 dev server 当场退出**,
           *   连带 sidecar 和编辑器一起没。实测过一次,不是推测。
           * - .pc-projects / .pc-work / .pc-chats:草稿、打开的项目副本、会话历史。都是运行时数据,
           *   改一下就触发一次 HMR 纯属浪费,而且草稿是自动保存的,等于每次保存都重载。
           */
          /*
           * 不用「任意深度 out 目录」这类 glob 字符串:chokidar 拿 picomatch 的缺省选项(dot: false)匹配绝对路径,
           * 根路径里只要有以点开头的一段(worktree 在 `.worktrees/` 下)就一条都不生效。
           * 名单与原因见 `server/vite-scan-ignore.mjs`;另外还挡 `.worktrees/`(在仓库根起服务时别的 worktree 不是源码)。
           */
          ignored: [watchIgnored(ROOT)],
        },
      },
};

/**
 * 在线构建（C10a 契约 `docs/plan/c10a-contract.md` 第 2 节〔裁〕）：`vite build --mode online` 产出 `dist-online/`，
 * `base: "/editor/"`，编译期常量 `import.meta.env.VITE_PC_ONLINE === "1"`（`src/online/mode.ts` 的 `ONLINE`）。
 *
 * - 只挂换行统一（`raw-eol`）、React 与 Tailwind：上面那些插件都是编辑器进程的 `/api/**` 接口与开发期的中间件，在线页面没有编辑器进程；
 *   卡片的改动层（`vite-plugin-cards` 的 pre 插件）是本机用户的定制，也不进在线构建；
 * - 桌面构建（`vite build`）与开发服务（`vite`）照旧走 `desktopConfig`，不受影响；
 * - `dist-online/` 由 `scripts/remote/docservice.mjs deploy-hosted --editor dist-online` 部署到托管端的 `<部署目录>/editor/`，
 *   nginx 在 `/editor` 下提供（契约第 2 节「nginx」）；
 * - 动效素材目录（`onlineCatalogPlugin`，`server/online-catalog.mjs`）：卡片参数里的 `/catalog/<kind>/<name>.json` 在桌面由开发服务器的中间件提供，
 *   在线没有本机进程，构建时把 index.json 登记的 Lottie、粒子文件原样产出到 `dist-online/catalog/`，随 `editor/` 一起部署，
 *   托管端 nginx 在编辑器页的源与两个舞台源的 `/catalog/` 下提供。地址不变，同一个项目桌面、在线都能开。
 */
/*
 * C10 契约第 7 节(主会话 2026-09-28 的补充约束):在线页面发布的清单计划写 `requires.codeVersion`,由构建时按渲染节点同一套算法
 * (`server/frame-code.mjs` 的 `frameCode`,换行统一成 LF)算出、以 `__PC_CODE_VERSION__` 嵌进页面(`src/online/buildInfo.ts`)。
 * 只在在线构建里算(遍历 src/ 一次)。
 * 不压缩、不优化 CSS(`cssMinify: false` 与 Tailwind 插件的 `optimize: false`,M7 探针 P2 之后主会话裁定):快照把根元素上的 CSS 自定义属性按原文内联,压缩过的 CSS
 * (`0.4` → `.4`、`150ms` → `.15s`)会让在线页面生成的快照与桌面(未压缩)逐字节不同、像素相同 —— 同指纹同结果键下混两种字节。
 */
const cardRuntimeDeps = () => {
  const require = createRequire(import.meta.url);
  const versionOf = (name: string) => {
    // 包的入口文件往上找到它自己的 package.json(有的包不导出 package.json)
    let dir = path.dirname(require.resolve(name));
    for (let i = 0; i < 6; i++) {
      const file = path.join(dir, "package.json");
      if (fs.existsSync(file)) { const pkg = JSON.parse(fs.readFileSync(file, "utf8")); if (pkg.name === name) return String(pkg.version); }
      dir = path.dirname(dir);
    }
    throw new Error(`取不到 ${name} 的版本`);
  };
  return { sucrase: versionOf("sucrase"), tailwindcss: versionOf("tailwindcss") };
};

/**
 * 舞台入口 `stage.html`(契约 `docs/plan/online-card-exec-contract.md` 第 3.3 节):跨源舞台的 iframe 载它,不载 `index.html`。
 *
 * 在线**构建**收尾时由构建出来的 `index.html` 复制一份、在 `<head>` 最前面加上舞台的内容安全策略
 * (`<meta http-equiv="Content-Security-Policy">`),产出为 `dist-online/stage.html`。这样两个入口引的是**同一份脚本包**
 * (文件名、分块与只有一个入口时逐字节相同),`index.html` 本身一个字不变。
 * 生成在 `server/stage-entry.mjs`;策略原文取自 `src/online/stagePolicy.mjs`(与 nginx 响应头、本机代理同出一处)。`<meta>` 是兜底:托管端的 nginx 没更新时舞台
 * 不至于裸奔;真正算数的是响应头那一份(舞台自检只认响应头,`isolation/isolationCheck.ts`)。
 * 桌面构建没有这个插件、不产出这个文件;开发服务也没有(那里 `/stage.html` 落到 `index.html`,自检不过、不执行用户卡)。
 */
const stageEntryPlugin = (): Plugin => ({
  name: "promptcut-stage-entry",
  apply: "build",
  enforce: "post",
  generateBundle: {
    order: "post",
    handler(_options, bundle) {
      const index = bundle["index.html"];
      if (!index || index.type !== "asset") throw new Error("在线构建里没有 index.html,没法生成舞台入口 stage.html");
      const html = typeof index.source === "string" ? index.source : Buffer.from(index.source).toString("utf8");
      this.emitFile({ type: "asset", fileName: STAGE_ENTRY_FILE, source: stageEntryHtml(html) });
    },
  },
});

/**
 * 在线构建的版本文件 `version.json`(语义 `product/platforms.md` 与 `mechanism/platforms.md`「在线浏览器」的「新版本提示」):
 * 产出 `dist-online/version.json`,内容为 `{"codeVersion":"<值>","entry":"assets/index-<哈希>.js"}`:`codeVersion` 与嵌进页面的
 * `__PC_CODE_VERSION__` 是同一个值(渲染服务拿它比对,`server/hosted-render/main.mjs`);`entry` 是编辑器页入口脚本的文件名,
 * 只改依赖、构建配置时代码版本不变而它会变。编辑器页切回前台时及在前台每 10 分钟取它(`src/online/updateCheck.ts`),
 * 两样任一与本页不同就挂出新版本提示。桌面构建与开发服务不挂这个插件、不产出这个文件。
 */
const versionJsonPlugin = (codeVersion: string): Plugin => ({
  name: "promptcut-version-json",
  apply: "build",
  generateBundle(_options, bundle) {
    // 编辑器页的入口脚本:门面是 index.html 的那个入口块;没有就取文件名排在最前的入口块
    const entries = Object.values(bundle ?? {}).filter((c): c is Rollup.OutputChunk => !!c && c.type === "chunk" && c.isEntry);
    const page = entries.find((c) => /[\\/]index\.html$/.test(c.facadeModuleId ?? "")) ?? entries.sort((a, b) => a.fileName.localeCompare(b.fileName))[0];
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify(page ? { codeVersion, entry: page.fileName } : { codeVersion }) });
  },
});

const onlineConfig = async (): Promise<UserConfig> => {
  const { frameCode, captureCode } = await import("./server/frame-code.mjs");
  const codeVersion = frameCode(process.cwd());
  // 本页产流(任务书 `render-refactor-task.md`「甲二」,`src/online/pageStreamPlan.ts`):轨道流的键里有截图代码的指纹,
  // 页面要算出与切分方相同的键,就得带着同一套算法在构建时算出的这一项
  const streamCodes = { capture: captureCode(process.cwd()) };
  return {
    base: "/editor/",
    // Tailwind 的构建期优化(Lightning CSS)即使不压缩也会改写数值(`0.4` → `.4`),与开发服务器(桌面导出页)的原文不同:一并关掉
    // cloudSeamsPlugin 必须挂在**每一个**配置上：它解析浏览器侧的云端别名，漏一个那个构建就直接
    // 报 "failed to resolve import"（2026-10-27 就是这么漏的，只加到了桌面那份）。
    // 有一条测试钉住这件事：server/test/build-extensions.test.mjs 的 SEAM-VITE-01。
    plugins: [cloudSeamsPlugin(), onlinePrunePlugin(), rawEolPlugin(), react({ exclude: REACT_REFRESH_EXCLUDE }), tailwindcss({ optimize: false }), onlineCatalogPlugin(process.cwd()), stageEntryPlugin(), versionJsonPlugin(codeVersion)],
    define: {
      "import.meta.env.VITE_PC_ONLINE": JSON.stringify("1"), __PC_CODE_VERSION__: JSON.stringify(codeVersion),
      __PC_STREAM_CODES__: JSON.stringify(streamCodes),
      // 在线卡片运行时版本里的转译器与 Tailwind 版本(`src/online/cardRuntime/version.ts`):取实际装的那一版
      __PC_CARD_RUNTIME_DEPS__: JSON.stringify(cardRuntimeDeps()),
    },
    build: { outDir: "dist-online", emptyOutDir: true, cssMinify: false },
    // 构建用不上;有人拿 `vite --mode online` 起开发服务时,监听与依赖扫描同桌面那份,不去翻 out/ 与别的 worktree
    optimizeDeps: { entries: DEP_SCAN_ENTRIES },
    server: { watch: { ignored: [watchIgnored(ROOT)] } },
  };
};

export default defineConfig(async ({ mode }) => (mode === "online" ? onlineConfig() : desktopConfig));
