/**
 * 测试与探针不写用户目录：把会把产物引到用户目录的环境变量摘掉。
 *
 * 编辑器、预渲染进程、渲染主机的输出目录都是「环境变量优先，缺省落在仓库 `out/`」：
 *   - `PROMPTCUT_EXPORT_DIR`：导出根目录，帧库在它下面的 `frame-library/`（`server/vite-plugin-frames.ts`），
 *     素材内容库在 `media/`、导出在 `export-<id>/`（`server/vite-plugin-media.ts`、`vite-plugin-export.ts`）；
 *   - `PROMPTCUT_DATA_DIR`：成本记录、卡片改动层、同步卡片等数据（`server/costs-store.mjs` 等）。
 * 桌面壳把前者设成 `%USERPROFILE%\Videos\PromptCut`、后者设成应用数据目录，经环境变量交给编辑器进程；
 * 桌面版里的 Agent、从桌面版环境里开的终端、或某台机器上全局设了这两个变量时，测试和探针起的子进程
 * 会原样继承它们，产物（尤其是帧库）就写进用户的 Videos 目录。
 *
 * 这里的做法是**摘掉**而不是改设成 `<仓库>/out`：两个变量没设时各自的缺省就是仓库里的开发期布局
 * （导出根 `<root>/out`；数据目录没设时卡片改动直接改检出目录、同步卡片落 `.pc-work/`），
 * 设成 `<root>/out` 反而会改变开发期行为。需要临时目录的探针照旧自己显式设。
 *
 * 用法：
 *   - 探针、验证脚本：第一行 `import './lib/no-user-dirs.mjs'`（相对路径按所在目录改），摘掉本进程的，
 *     之后所有 `{ ...process.env }` 起的子进程和同进程里的 `FramePipeline` 都不再继承；
 *   - `npm test`：`server/test/global-setup.mjs` 在测试运行器主进程里摘一次，各测试文件的子进程都继承摘过的环境；
 *   - 守门：`server/test/no-user-dirs.test.mjs`。
 *
 * 产品入口（`cloud/scripts/render-host.mjs` 自己按 `--data` 显式设、
 * `scripts/prune-prerender-cache.mjs` 本来就是清用户帧库的维护工具）不用它：它们要的就是用户的目录。
 *
 * 同一个入口顺带设 `PROMPTCUT_NO_PORT_FILE=1`（`markNoPortFile`）：编辑器一起来就把端口写进公共的
 * `%TEMP%\promptcut\port.json`（`server/vite-plugin-ai.ts`），用户会话里的 PromptCut MCP 服务
 * （`server/mcp-server.mjs`）按它找编辑器。测试和探针起的编辑器写了它，会把用户的 MCP 工具调用引到探针那台上，
 * 或者反过来让某个探针的代理收到用户的调用。设了这个变量，编辑器就不写；桌面版和用户自己 `npm run dev`
 * 起的编辑器没有这个变量，照旧写。守门：`server/test/port-file.test.mjs`。
 */
import os from 'node:os';
import path from 'node:path';

/** 会把产物引到用户目录的环境变量 */
export const USER_DIR_ENV_KEYS = Object.freeze(['PROMPTCUT_EXPORT_DIR', 'PROMPTCUT_DATA_DIR', 'PROMPTCUT_ARTIFACT_DIR']);

/** 桌面版的导出目录：`<home>/Videos/PromptCut`（`desktop/src-tauri/src/lib.rs`） */
export function userExportDir(home = os.homedir()) {
  return path.join(home, 'Videos', 'PromptCut');
}

/** p 是否就是用户导出目录或在它下面（Windows 上不分大小写） */
export function isUnderUserExportDir(p, home = os.homedir()) {
  if (!p) return false;
  const norm = (x) => {
    const r = path.resolve(String(x));
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const base = norm(userExportDir(home));
  const target = norm(p);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * 从 env 里删掉 `USER_DIR_ENV_KEYS`（原地改，默认改本进程的 `process.env`）。
 * Windows 上环境变量名不分大小写，`process.env` 本身会处理；普通对象按原名删。
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ key: string, value: string }[]} 删掉了哪些
 */
export function scrubUserDirEnv(env = process.env) {
  const removed = [];
  for (const key of USER_DIR_ENV_KEYS) {
    if (env[key] !== undefined) {
      removed.push({ key, value: String(env[key]) });
      delete env[key];
    }
  }
  return removed;
}

/**
 * 给要显式设目录的调用方兜底：env 里这几个变量任何一个指向用户导出目录就抛。
 * @param {Record<string, string | undefined>} env
 * @param {string} [who] 报错时说是谁
 */
export function assertNoUserExportDir(env, who = '子进程') {
  for (const key of USER_DIR_ENV_KEYS) {
    if (isUnderUserExportDir(env[key])) {
      throw new Error(`${who} 的 ${key}=${env[key]} 指向用户的 ${userExportDir()}，测试与探针不得写那里`);
    }
  }
}

/** 设成 `1` 时编辑器不写公共的 `%TEMP%\promptcut\port.json`（`server/vite-plugin-ai.ts`） */
export const NO_PORT_FILE_ENV = 'PROMPTCUT_NO_PORT_FILE';

/**
 * 在 env 里设 `PROMPTCUT_NO_PORT_FILE=1`（原地改，默认改本进程的 `process.env`）；之后 `{ ...process.env }`
 * 起的编辑器都不写公共的 port.json。返回设之前的值。
 * @param {Record<string, string | undefined>} [env]
 */
export function markNoPortFile(env = process.env) {
  const before = env[NO_PORT_FILE_ENV];
  env[NO_PORT_FILE_ENV] = '1';
  return before;
}
