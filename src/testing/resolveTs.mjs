/**
 * `node --test` 的解析钩子:相对路径没写扩展名时,依次试 `.ts` / `.tsx` / `/index.ts`。
 *
 * 编辑台的很多模块照 Vite 的习惯写 `import … from "../store/project"`,node 的 ESM 解析器
 * 不认,一 import 就 `ERR_MODULE_NOT_FOUND`。单测里用 `import "../testing/registerTs.mjs"`
 * 装上它,再配 `mock.module` 把拉不进 node 的重依赖(store、卡片注册表)换掉。
 *
 * 只补解析,不做转译:`.tsx` 能解析到,但 node 的类型剥离不认 JSX,真走到 `.tsx` 还是要 mock。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HAS_EXT = /\.(?:[cm]?[jt]sx?|json|css)$/;

export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && !HAS_EXT.test(specifier) && context.parentURL?.startsWith("file:")) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
  }
  return next(specifier, context);
}
