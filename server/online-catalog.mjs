/**
 * 在线构建里的动效素材目录（`vite build --mode online` 专用）。
 *
 * 桌面上 `/catalog/<kind>/<name>.json` 由开发服务器的中间件提供（`server/vite-plugin-cards.ts` 的 `/catalog` 路由），
 * 只放行 `server/catalog/<kind>/index.json` 里登记过的名字。卡片参数里存的是同源绝对路径（如 `/catalog/lottie/bodymovin.json`），
 * 同一个项目桌面、在线都要能开，所以地址不改；在线页面没有本机进程，就由构建把同一批文件原样产出到
 * `dist-online/catalog/<kind>/<name>.json`，随在线构建部署到 `<部署目录>/editor/catalog/`，托管端的 nginx 在 `/catalog/` 下提供
 * （编辑器页的源与两个舞台源都要：舞台 iframe 里的 fetch 解析到舞台自己的源）。
 *
 * 只产出登记过的条目，与中间件放行的集合相同：种类只认 lottie、particles，名字只认 `[A-Za-z0-9-]+`。
 * 页面不在运行时读 index.json（`src/cards/catalogAssets.ts` 在构建时 import 它），所以 index.json 本身不产出。
 */
import fs from 'node:fs';
import path from 'node:path';

export const CATALOG_KINDS = ['lottie', 'particles'];
const NAME = /^[A-Za-z0-9-]+$/;

/** `server/catalog/<kind>/index.json` 登记的条目：`{ kind, name, fileName: 'catalog/<kind>/<name>.json', source: 绝对路径 }` */
export function catalogEntries(root) {
  const out = [];
  for (const kind of CATALOG_KINDS) {
    const dir = path.join(root, 'server', 'catalog', kind);
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    for (const item of index.items ?? []) {
      const name = String(item?.name ?? '');
      if (!NAME.test(name)) throw new Error(`[online-catalog] ${kind}/index.json 里的名字 "${name}" 不合 [A-Za-z0-9-]+（桌面的 /catalog 路由也取不到它）`);
      const source = path.join(dir, `${name}.json`);
      if (!fs.existsSync(source)) throw new Error(`[online-catalog] ${kind}/index.json 登记了 "${name}"，但 ${source} 不在`);
      out.push({ kind, name, fileName: `catalog/${kind}/${name}.json`, source });
    }
  }
  return out;
}

/** vite 插件：构建时把登记的条目原样（逐字节）产出到输出目录的 `catalog/<kind>/<name>.json` */
export function onlineCatalogPlugin(root = process.cwd()) {
  return {
    name: 'promptcut-online-catalog',
    apply: 'build',
    generateBundle() {
      for (const e of catalogEntries(root)) this.emitFile({ type: 'asset', fileName: e.fileName, source: fs.readFileSync(e.source) });
    },
  };
}
