/**
 * 在线浏览器模式的**运行期**标记(C10a 集成返工)。
 *
 * `mode.ts` 的 `ONLINE` 是编译期常量,但它读 `import.meta.env`,会被 Node 单测载入的模块不能静态引它
 * (守门 `src/online/modeImportGuard.test.mjs`)。这些模块要在在线页面里停掉编辑器进程的 `/api/*` 调用
 * (契约第 2 节:要么隐藏或置灰,要么走在线替代),就读这个标记:`boot.ts` 在 `ONLINE` 时、别的模块求值之前设上。
 * 桌面运行环境与 Node 单测里恒为 false。
 *
 * **在线构建剪枝**(M8 遗留 L24):这个标记是运行期的,在线构建不会因为它剪掉任何代码;`mode.ts` 的 `ONLINE`
 * 从别的模块引进来也一样 —— 实测 rolldown 摇树时不认引进来的常量(引进来的常量要到之后的内联、压缩才换成字面量,
 * 那时只剪得掉就地写的函数字面量,剪不掉它引用的模块)。要让在线构建连同背后的 `/api` 调用一起剪掉,
 * 在**用到它的模块里**就地写一行:
 *
 *     const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
 *
 * 值与 `ONLINE` 相同(Vite 在构建和开发服务里都把 `import.meta.env.VITE_PC_ONLINE` 换成字面量),Node 单测里
 * `import.meta.env` 不存在、为 false,不会像静态引 `mode.ts` 那样当场抛错。守门:`src/online/onlinePrune.test.mjs`
 * 核对这一行逐字相同,`server/test/c10a-online-build.test.mjs` 核对 `/api` 棘轮清单与产物一致。
 */

const KEY = "__pcOnlinePage";

export function onlinePage(): boolean {
  return (globalThis as Record<string, unknown>)[KEY] === true;
}

export function markOnlinePage(): void {
  (globalThis as Record<string, unknown>)[KEY] = true;
}

/**
 * 在线浏览器模式里置灰的入口悬停时的说明(C10 契约第 10 节、第 17 节表 A):
 * 「在线浏览器模式暂不支持{入口名}，请在电脑上的 PromptCut 里使用。」
 * 入口名用用户在界面上看到的叫法(「导入媒体」「语音识别」「配音」……)。
 */
export const ONLINE_UNSUPPORTED_PREFIX = "在线浏览器模式暂不支持";
export const ONLINE_UNSUPPORTED_SUFFIX = "，请在电脑上的 PromptCut 里使用。";
export function onlineUnsupported(entry: string): string {
  return `${ONLINE_UNSUPPORTED_PREFIX}${entry}${ONLINE_UNSUPPORTED_SUFFIX}`;
}
