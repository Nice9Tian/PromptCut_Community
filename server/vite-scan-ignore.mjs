// 开发服务器(vite.config.ts、vite.prerender.config.ts)的监听忽略与依赖扫描入口。
//
// 为什么不用 glob 字符串写忽略:Vite 8 把 `server.watch.ignored` 原样交给它打包的 chokidar 3,
// chokidar 用 picomatch 的缺省选项(dot: false)去匹配**绝对路径**。dot: false 时 `**` 不跨过以点开头的一段,
// 于是只要项目根的绝对路径里有这样一段(worktree 都在 `<仓库>/.worktrees/<名>/` 下),`**/out/**` 这类写法
// 一条都不生效,连 Vite 自带的 `**/node_modules/**`、`**/.git/**` 也一样。反过来在仓库根起服务时,
// `.worktrees/` 下每个 worktree 的源码与 out/ 都被纳入监听。这里改成按「相对项目根的路径段」判断的函数,
// 与根的绝对路径长什么样无关。
//
// 依赖扫描入口:没给 `optimizeDeps.entries` 时 Vite 用 `**/*.html` 找入口,只排除 node_modules 与 build.outDir(dist),
// 帧库(out/frame-library 下成千上万个 .html)会整个被当成入口读一遍 —— 15 万个文件时冷启动慢十几倍。
// 这里把入口限定在确实是页面的几处。新增页面放在这几处以外时,依赖照样能在运行时被发现,只是首开多一次预构建。
import path from "node:path";

/** 路径里出现这些段(相对项目根)就不监听。`**\/x/**` 原来的语义:任意深度的同名目录都算。 */
const IGNORED_SEGMENTS = new Set([
  // Vite 的缺省忽略(传函数不会替换它们,但它们的 glob 同样受上面的 dot 问题影响,这里一并兜住)
  ".git", "node_modules", "test-results",
  // 不是源码:桌面壳的二进制、导出产物与帧库、内置 Python、本地工作与验收产物、小工具编译产物、构建产物与文档
  "desktop", "out", "python", "work", "tools", "dist", "dist-online", "docs", "archive",
  // 草稿、任务目录、会话历史:运行时数据,改一下就触发一次热更新纯属浪费
  ".pc-projects", ".pc-work", ".pc-chats",
  // 在仓库根起服务时,别的 worktree 不是本服务的源码
  ".worktrees",
]);

/**
 * `server.watch.ignored` 用的判断函数。chokidar 经 anymatch 调用,传进来的路径已统一成正斜杠。
 * 项目根以外的路径(配置文件依赖、env 文件)不在这里忽略,交给 Vite 自己的规则。
 * `.lock`:.proc 的独占锁,外壳用共享模式 0 握着它,chokidar 去 fs.watch 立刻拿到 EBUSY,整个 dev server 当场退出。
 */
export function watchIgnored(root) {
  const base = path.resolve(root);
  return (p) => {
    if (typeof p !== "string" || p === "") return false;
    if (p.endsWith(".lock")) return true;
    const rel = path.relative(base, path.resolve(p));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return rel.split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg));
  };
}

/** `optimizeDeps.entries`:相对项目根的 glob,与原先 `**\/*.html` 实际找到的页面相同,但不去翻 out/ 等大目录。 */
export const DEP_SCAN_ENTRIES = ["*.html", "src/**/*.html", "desktop/ui/**/*.html", "scripts/**/*.html"];
