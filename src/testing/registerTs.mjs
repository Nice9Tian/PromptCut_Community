/**
 * 单测里第一行 `import "../testing/registerTs.mjs"`:装上 `resolveTs.mjs` 的解析钩子,
 * 之后 `await import()` 的 `.ts` 模块里没写扩展名的相对 import 也解析得到。
 *
 * 另外给一个 `src/` 下文件的 URL 拼法,`mock.module` 要的是解析后的地址。
 */
import { register } from "node:module";

register(new URL("./resolveTs.mjs", import.meta.url));

/** `srcUrl("store/project.ts")` → `src/store/project.ts` 的 file URL */
export const srcUrl = (relative) => new URL(`../${relative}`, import.meta.url).href;
