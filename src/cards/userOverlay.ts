/**
 * 改动层里有、底版(检出里的 `src/cards/user/`)没有的用户卡。
 *
 * 装机版(桌面、独立渲染主机)有卡片改动层(`server/card-overrides.mjs`):本机原来没有的用户卡
 * (create_card、打开 .proc、卡片源码同步装进来的)只写进改动层,检出目录一个文件都不写。
 * `./user/index.ts` 用 `import.meta.glob` 按目录收卡,只看得见真实目录,这些卡由这个模块另列给它。
 *
 * 磁盘上这份是空表:没有改动层时(开发期、在线构建)就是它。有改动层时,卡片插件的加载钩子
 * (`server/vite-plugin-cards.ts` 的 `cardOverridesLoader` / `userOverlayModuleCode`)把它换成真实清单,
 * 用户卡目录里多了、少了文件就重载它。键和 `./user/index.ts` 的 glob 同形:`./<相对 src/cards/user/ 的路径>`。
 */
/** 入口卡(一层的 .tsx)的模块 */
export const overlayModules: Record<string, Record<string, unknown>> = {};
/** 入口卡的源码原文 */
export const overlayRaws: Record<string, string> = {};
/** 全部源码文件(.ts / .tsx / .mjs / .css)的原文,缓存身份用 */
export const overlayDependencyRaws: Record<string, string> = {};
