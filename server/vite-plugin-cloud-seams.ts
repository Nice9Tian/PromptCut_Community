/*
 * 浏览器侧云端扩展包的别名解析（公开侧，`docs/plan/community-boundary.md` 第二节「不变量」第 2 条）。
 *
 * 不变量第 2 条说：共享代码不认识任何云端模块的名字，Node 侧从调用方拿表，**浏览器侧走别名**。
 * 这个插件就是那个别名。浏览器侧的加载点引的是下面这几个说明符，谁都不写路径：
 *
 *   #promptcut-cloud-ai            → <云端目录>/ai/manifest.ts
 *   #promptcut-cloud-account       → <云端目录>/account/manifest.ts
 *   #promptcut-cloud-account-ui    → <云端目录>/account/ui-manifest.tsx
 *   #promptcut-cloud-online        → <云端目录>/online/manifest.ts
 *
 * 找不到目标就解析到 `src/community/cloudSeamStub.ts`（一个什么都不导出的模块），于是加载点
 * 判定「没装扩展」，落回公开侧自带的默认实现。
 *
 * 为什么不是在两个仓库各写一份 `vite.config.ts` 的 alias（总纲第十节原来是这么写的）：
 * 那样 `vite.config.ts` 就得两边各一份、内容不同，而它现在是共享树里的文件。做成一个公开插件之后
 * 两个仓库用同一个 `vite.config.ts`，云端目录照 `PROMPTCUT_CLOUD_DIR` 找 —— 和
 * `server/docservice/extensions.mjs`、`server/vite-plugin-hosted-gate.ts` 同一个约定。
 *
 * 为什么非走别名不可（这是三处真实的坑，不是洁癖）：A、B、E 三份活的浏览器侧加载点原来都写成
 * `new URL("../../../<闭源目录>/…/manifest.ts", import.meta.url)` 加 `@vite-ignore` 的动态 import。
 * 那种写法在正式构建里**根本加载不到** —— `.ts` 不进产物，`@vite-ignore` 又让 Vite 不去解析它，
 * 于是运行期 import 一个不存在的 URL，`catch` 一吞就静默失败，而私有仓库文件齐全，看起来却像好的。
 *
 * 另外把产品声明（`product.config.json`，闭源目录里有就用那份，见 `server/auth/product.mjs`）写进
 * `__PROMPTCUT_PRODUCT__`：挂在每一个配置上的只有这个插件，声明走这里才不会漏掉哪个构建。
 *
 * 守门例外声明：本文件是「共享树不许加载闭源目录」在浏览器构建这一块的唯一例外，
 * 登记在 `server/test/community-ownership.mjs` 的 `LOADER_WHITELIST` 里。
 * 本文件不出现任何具体云端业务模块路径，只按下面这张表拼 `<云端目录>/<子路径>`。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** 别名 → 云端目录下的子路径。加新的浏览器侧接缝时在这里加一行。 */
const SEAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "#promptcut-cloud-ai": ["ai", "manifest.ts"],
  "#promptcut-cloud-account": ["account", "manifest.ts"],
  "#promptcut-cloud-account-ui": ["account", "ui-manifest.tsx"],
  "#promptcut-cloud-online": ["online", "manifest.ts"],
});

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = existsSync(path.join(here, "..", "package.json")) ? path.resolve(here, "..") : process.cwd();

/** 云端目录：与 `server/docservice/extensions.mjs` 同一约定（子模块布局下不在仓库根下面） */
function cloudDirOf(): string {
  const env = process.env.PROMPTCUT_CLOUD_DIR?.trim();
  return env ? path.resolve(env) : path.join(repoRoot, "cloud");
}

const STUB = path.join(repoRoot, "src", "community", "cloudSeamStub.ts");

/** 产品声明：闭源目录里那份优先，否则是公开版那份 */
function productDeclaration(): string {
  const closed = path.join(cloudDirOf(), "product.config.json");
  return readFileSync(existsSync(closed) ? closed : path.join(repoRoot, "product.config.json"), "utf8");
}

export function cloudSeamsPlugin(): Plugin {
  return {
    name: "promptcut-cloud-seams",
    enforce: "pre",
    config: () => ({ define: { __PROMPTCUT_PRODUCT__: JSON.stringify(JSON.parse(productDeclaration())) } }),
    resolveId(source) {
      const sub = SEAMS[source];
      if (!sub) return null;
      const target = path.join(cloudDirOf(), ...sub);
      return existsSync(target) ? target : STUB;
    },
  };
}

export default cloudSeamsPlugin;
