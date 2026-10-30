/**
 * 舞台入口 `stage.html` 的生成(契约 `docs/plan/online-card-exec-contract.md` 第 3.3 节):由在线构建出来的 `index.html` 复制一份,
 * 在 `<head>` 最前面加上舞台的内容安全策略(`<meta http-equiv="Content-Security-Policy">`)。两个入口引的是同一份脚本包,
 * `index.html` 本身一个字不变。策略原文取自 `src/online/stagePolicy.mjs`(与 nginx 响应头、本机代理同出一处)。
 * 纯函数;`vite.config.ts` 的在线构建插件调它,单测 `server/test/stage-policy-nginx.test.mjs` 核。
 */
import { STAGE_CSP_META } from '../src/online/stagePolicy.mjs';

export const STAGE_ENTRY_FILE = 'stage.html';

export function stageEntryHtml(indexHtml) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${STAGE_CSP_META}" />`;
  const m = /<head[^>]*>/i.exec(indexHtml);
  if (!m) throw new Error('index.html 里没有 <head>,没法生成舞台入口');
  const at = m.index + m[0].length;
  return `${indexHtml.slice(0, at)}\n    ${meta}${indexHtml.slice(at)}`;
}
