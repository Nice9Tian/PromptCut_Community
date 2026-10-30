/**
 * 以局域网模式起本机编辑器（语义 `docs/semantics/mechanism/platforms.md`「局域网里的第二块屏」）。
 *
 *   npm run dev:lan [-- --port 5190 ...]
 *
 * 和 `npm run dev` 的区别只有两样：
 *   1. 设 `PROMPTCUT_LAN_HOST=1` —— 编辑器绑 `0.0.0.0`（`vite.config.ts` 的 `lanHostPlugin`），
 *      挂在它上面的文档服务与素材服务随之对局域网可达；放本机的共享项目建成后开始广播
 *      （`server/vite-plugin-docservice.ts`）。
 *   2. 命令行也给 `--host 0.0.0.0`，免得哪天 `dev` 的缺省改回回环时这条命令跟着失效。
 *
 * 只给开发与验收用。打包的桌面应用由外壳起编辑器（它给 `--host 127.0.0.1`），要不要绑局域网归外壳管。
 *
 * 子进程按硬约束设 `windowsHide`（`docs/semantics/guide_files/constraints.md`），别把终端窗口弹到前台。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rest = process.argv.slice(2);
/** 用户自己给了 --port / --host 就不再补一份，免得 vite 拿到两个同名参数 */
const has = (flag) => rest.some((a) => a === flag || a.startsWith(`${flag}=`));
const args = [
  ...(has("--port") ? [] : ["--port", "5190"]),
  ...(has("--strictPort") ? [] : ["--strictPort"]),
  ...(has("--host") ? [] : ["--host", "0.0.0.0"]),
  ...rest,
];

const vite = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [vite, ...args], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, PROMPTCUT_LAN_HOST: "1" },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
