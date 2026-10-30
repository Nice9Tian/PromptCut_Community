/**
 * `?raw` 源码统一换行(eol-eperm)。
 *
 * Vite 自带的 `?raw` 加载(`vite:asset`)把文件原文照字面塞进 `export default "..."`。Windows 上 autocrlf 检出是 CRLF,
 * 于是同一个提交在 CRLF 检出与 LF 检出上构建,内嵌源码表(`src/render/cardSourceFiles.mjs`、`src/cards/user/index.ts`、
 * `src/ai/roles/index.ts`)的字符串不同,在线构建的分块哈希跟着不同;页面侧拿它算的卡片源码版本(成本身份键的一段)也不同。
 * 服务端的代码版本(`server/frame-code.mjs`)早已统一成 LF,这里让页面侧同口径:项目 `src/` 下的 `?raw` 一律交出 LF 的原文。
 *
 * 排在 `enforce: 'pre'`,先于 `vite:asset`。卡片改动层(`vite-plugin-cards.ts` 的 `cardOverridesLoader`,也是 pre)
 * 在插件数组里排在本插件前面,改过的文件由它交出(它自己也统一换行),本插件只管其余。
 */
import fs from 'node:fs';
import path from 'node:path';

export const normalizeEol = (text) => String(text).replace(/\r\n/g, '\n');

const RAW_QUERY = /[?&]raw(?:&|$)/;

/** 这个模块 id 该不该由本插件交出:带 `?raw`、落在 `<root>/src/` 下的绝对路径 */
export function rawEolTarget(root, id) {
  if (typeof id !== 'string' || !RAW_QUERY.test(id)) return null;
  const file = id.split('?')[0];
  if (!path.isAbsolute(file)) return null;
  const rel = path.relative(path.join(root, 'src'), file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

/** `?raw` 模块的代码:LF 原文 */
export const rawModuleCode = (text) => `export default ${JSON.stringify(normalizeEol(text))}`;

/** Vite 插件 */
export function rawEolPlugin() {
  let root = process.cwd();
  return {
    name: 'promptcut-raw-eol',
    enforce: 'pre',
    configResolved(config) { root = config.root; },
    // 入口页 index.html 同理:构建产物里的它照原文抄换行,CRLF 检出出来的 dist 就和 LF 的不同
    // (Vite 拆掉入口 <script> 时还会在 </body> 前留下一个 CR,所以产物落盘前再统一一次)
    transformIndexHtml: { order: 'post', handler: (html) => normalizeEol(html) },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const item of Object.values(bundle)) {
          if (item.type === 'asset' && item.fileName.endsWith('.html') && typeof item.source === 'string') item.source = normalizeEol(item.source);
        }
      },
    },
    load(id) {
      const file = rawEolTarget(root, id);
      if (!file) return null;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
      this.addWatchFile(file);
      return rawModuleCode(text);
    },
  };
}
