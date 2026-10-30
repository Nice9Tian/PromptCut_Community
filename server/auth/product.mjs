/**
 * 这一版产品带什么：协作面板能选哪些位置、有没有托管端、账号云端在哪。
 *
 * 声明是一份配置文件，公开版和闭源版各一份，内容不同：仓库根的 `product.config.json` 是公开版的；
 * `<云端目录>/product.config.json` 在的话用它（云端目录与 `server/docservice/extensions.mjs` 同一约定）。
 * 公开树里不写任何托管地址（`server/test/community-boundary.test.mjs` 的 G6），地址只在闭源那一份里。
 *
 * 两条路取到同一份：
 * - 浏览器：`server/vite-plugin-cloud-seams.ts` 在构建时把声明写进 `__PROMPTCUT_PRODUCT__`；
 * - Node：这里同步读文件。本模块要让浏览器也能引（`hosted-default.mjs` 不许静态引 node: 内置模块），
 *   所以内置模块经 `process.getBuiltinModule` 取，浏览器里没有 `process`，这条路自然跳过。
 *
 * 两份都读不到（只带了部分文件的部署）就按「什么都没有」算，和公开版的声明一样。
 *
 * 守门例外声明：本文件登记在 `server/test/community-ownership.mjs` 的 `LOADER_WHITELIST` 里，
 * 它只读云端目录下这一份声明，不加载代码。
 */
/* global __PROMPTCUT_PRODUCT__ */

const NOTHING = { collab: { targets: [] }, hosted: null, accountCloudOrigin: null };

function readDeclaration() {
  const proc = globalThis.process;
  const fs = proc?.getBuiltinModule?.('node:fs');
  if (!fs) return null;
  const path = proc.getBuiltinModule('node:path');
  const { fileURLToPath } = proc.getBuiltinModule('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envCloudDir = proc.env.PROMPTCUT_CLOUD_DIR?.trim();
  const cloudDir = envCloudDir ? path.resolve(envCloudDir) : path.join(root, 'cloud');
  for (const file of [path.join(cloudDir, 'product.config.json'), path.join(root, 'product.config.json')]) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

export const PRODUCT = Object.freeze({
  ...NOTHING,
  ...(typeof __PROMPTCUT_PRODUCT__ !== 'undefined' ? __PROMPTCUT_PRODUCT__ : readDeclaration()),
});
