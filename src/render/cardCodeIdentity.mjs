/**
 * 卡片代码身份的算法(桌面与在线页面共用;用法见 `server/card-code.mjs` 文件头,在线一侧见
 * `docs/plan/online-card-exec-contract.md` 第 5 节)。
 *
 * 一张卡的身份 = 定义文件加它一路相对导入到的卡片 / 部件文件(闭包),每个文件记「仓库相对路径 + 内容哈希」,
 * 整体取 sha256 的前 32 位。内容哈希与内容库同一算法(`server/card-sync.mjs` 的 `sourceHash`:
 * `sha256(JSON.stringify(换行统一成 LF 的源码))`)。
 *
 * 本模块只管「跟哪些文件」「拿什么去取摘要」这两件纯文本的事,不读文件、不取摘要:
 *   - 桌面(`server/vite-plugin-cards.ts`)注入「改动层优先」的读文件与 Node 的 sha256;
 *   - 在线页面(`src/online/cardRuntime/codeIdentity.ts`)注入内容库同步来的源码、页面自带的内置源码与 WebCrypto。
 * 两边算出同一个值,任务的 `requires.cardSources` 与节点报的 `cardSourceVersions` 才对得上。
 *
 * 不依赖 Node 内置模块,也不依赖浏览器接口。
 */

/** 进闭包的范围:卡片目录与部件目录 */
export const CARD_CODE_ROOTS = Object.freeze(["src/cards/", "src/parts/"]);
const CARD_CODE_EXT = /\.(tsx|ts|css)$/;
/** 闭包最多跟多少个文件 */
export const CARD_CODE_CLOSURE_LIMIT = 60;
/** 身份取摘要的前多少位十六进制 */
export const CARD_CODE_ID_HEX = 32;

/** 这个仓库相对路径在不在闭包的范围里:卡片 / 部件目录下、是源码或样式文件、不是测试 */
export function isCardCodePath(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  if (/\.test\.(ts|tsx|mjs)$/.test(rel)) return false;
  return CARD_CODE_ROOTS.some((r) => rel.startsWith(r)) && CARD_CODE_EXT.test(rel);
}

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

/** `fromRel` 所在目录下的相对说明符 → 仓库相对路径;爬出仓库根回 null */
function resolveRel(fromRel, spec) {
  const parts = fromRel.split("/").slice(0, -1);
  for (const p of spec.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.length ? parts.join("/") : null;
}

/**
 * 一份源码里每个相对导入的候选路径(按源码里的先后;每个说明符一组,组内按试的先后):
 * 原样、`.tsx`、`.ts`、`/index.tsx`、`/index.ts`。爬出仓库根的说明符不出组。
 */
export function localImportCandidates(rel, source) {
  const out = [];
  for (const m of String(source ?? "").matchAll(IMPORT_RE)) {
    const base = resolveRel(rel, m[1] || m[2]);
    if (!base) continue;
    out.push([base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]);
  }
  return out;
}

/**
 * 一个文件直接用到的本地文件:每个相对导入取第一个存在的候选,落在闭包范围里的才要;去重、保持先后。
 * @param {string} rel
 * @param {{ read: (rel: string) => string | null, isFile: (rel: string) => boolean }} io
 */
export function localImportsOf(rel, io) {
  let source = null;
  try { source = io.read(rel); } catch { source = null; }
  if (source == null) return [];
  const out = [];
  for (const candidates of localImportCandidates(rel, source)) {
    const hit = candidates.find((c) => io.isFile(c));
    if (!hit) continue;
    if (isCardCodePath(hit) && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** 一张卡的全部本地源码:定义文件 + 它一路用到的卡片 / 部件文件(第一个是定义文件) */
export function importClosureOf(entry, io, limit = CARD_CODE_CLOSURE_LIMIT) {
  const seen = [entry];
  for (let i = 0; i < seen.length && seen.length < limit; i++) {
    for (const r of localImportsOf(seen[i], io)) if (!seen.includes(r)) seen.push(r);
  }
  return seen;
}

/**
 * 取摘要之前的那段文本:每个文件一行「路径」一行「内容哈希」(读不到的写 `missing`)。
 * @param {readonly string[]} files  闭包(`importClosureOf` 的结果)
 * @param {(rel: string) => string | null} hashOf  这个文件的内容哈希;读不到回 null
 */
export function cardCodePreimage(files, hashOf) {
  let text = "";
  for (const rel of files) {
    const hash = hashOf(rel);
    text += `${rel}\n${hash == null ? "missing" : hash}\n`;
  }
  return text;
}
