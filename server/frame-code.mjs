import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const fingerprints = new Map();
const captures = new Map();
const snapshots = new Map();
/** server/ 的上一级 —— 仓库根,也是打包后的 runtime/app 根。snapshotCode 只读源码,
 * 调用方(card-cache)手里只有缓存目录、拿不到仓库根时用它。 */
const APP_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
/** Code that decides which pixels a screenshot contains. A fix here (e.g. a
 * readiness wait or a stale-screenshot guard) must retire frames captured by
 * the old code, including card caches whose keys do not contain frameCode. */
/* `scripts/export-frames.mjs` 那一整个文件现在是 `server/bakery/` 里的七个模块
 * (chrome / bake / shards / media / ffmpeg / export / audio-mix),七个一起列出来 ——
 * 哈希到的内容和搬家前完全一样,既不多也不少。 */
const BAKERY_FILES = ['server/bakery/chrome.mjs', 'server/bakery/bake.mjs', 'server/bakery/shards.mjs',
  'server/bakery/media.mjs', 'server/bakery/ffmpeg.mjs', 'server/bakery/export.mjs', 'server/bakery/audio-mix.mjs'];
/* 画布直取(产轨道流时从画布取像素,不经过截图)的两个文件也决定流里的像素:Node 一侧的 `capture-canvas.mjs`
 * 和页面一侧的 `src/render/gl/canvasGrab.ts`。它们不决定快照 HTML,不进下面的 `SNAPSHOT_FILES`。
 * 依赖下层的流的差分取层(`capture-below.mjs`:怎么藏目标卡、怎么由两张截图算出那一层)同理。 */
const CAPTURE_FILES = [...BAKERY_FILES, 'server/bakery/capture-frame.mjs', 'server/bakery/capture-snapshot.mjs', 'server/bakery/frame-media.mjs',
  'server/bakery/frame-ready.mjs', 'server/bakery/png-integrity.mjs', 'server/bakery/capture-canvas.mjs', 'src/render/gl/canvasGrab.ts',
  'server/bakery/capture-below.mjs'];
/**
 * 源码按文本哈希,换行先统一成 LF:仓库是 `text=auto`,Windows 检出是 CRLF、Linux 检出是 LF,
 * 同一个提交在两种机器上不能算出两个代码版本(另一台机器上的独立渲染主机按代码版本分池、按快照键核对任务)。
 */
const textOf = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
/* 哈希的是文件原文,注释也在里头:改下面任何一份清单里的文件,哪怕只动一行注释,也会换一个代码版本,
 * 让已有的快照键和卡片缓存键全部作废、下次部署整站重渲。先例:2026-10-23 的探针总审要把
 * `src/render/snapshotRename.ts` 文件头里的探针路径改成归档路径,〔裁〕V21-30 按这条理由驳回,
 * 把去向记在 `scripts/archive/probes/README.md`。 */
const hashFiles = (hash, root, files) => {
  for (const file of files) {
    hash.update(file);
    try { hash.update(textOf(path.join(root, file))); } catch { hash.update('missing'); }
  }
};
/**
 * 用户卡目录里除了装载入口 `index.ts` 以外的一切(卡片文件、它们用到的文件、归属表 `_scopes.json`)
 * 不进全局代码版本(C6.6 c66-host-cards):用户卡是项目的内容,不是渲染器的版本。两台节点多一张、少一张
 * 或改过一张用户卡,仍是同一个代码版本、同一个池;用到用户卡(或改动层里改过的卡)的任务在
 * `requires.cardSources` 里另标它要的那张卡的代码身份,节点手里有这份代码才认领(`server/card-code.mjs`)。
 * 改动层(`card-overrides.mjs`)本来就不在这里:它在数据目录里,不在 `src/` 下。
 */
export function isUserCardSource(rel) {
  const r = String(rel).replaceAll('\\', '/');
  return r.startsWith('src/cards/user/') && r !== 'src/cards/user/index.ts';
}
export function invalidateFrameCode(root) { fingerprints.delete(root); captures.delete(root); snapshots.delete(root); }
export function frameCode(root) {
  if (fingerprints.has(root)) return fingerprints.get(root);
  const hash = createHash('sha256');
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const file = path.join(dir, item.name);
      const rel = path.relative(root, file).replaceAll('\\', '/');
      if (isUserCardSource(rel)) continue;
      if (item.isDirectory()) walk(file);
      else if (/\.(tsx?|mjs|css|json)$/.test(item.name)) { hash.update(rel); hash.update(textOf(file)); }
    }
  }
  walk(path.join(root, 'src'));
  hashFiles(hash, root, [...CAPTURE_FILES, 'server/frame-pipeline.mjs', 'server/frame-identity.mjs']);
  const value = hash.digest('hex'); fingerprints.set(root, value); return value;
}
export function captureCode(root) {
  if (captures.has(root)) return captures.get(root);
  const hash = createHash('sha256');
  hashFiles(hash, root, CAPTURE_FILES);
  const value = hash.digest('hex').slice(0, 32); captures.set(root, value); return value;
}

/**
 * 生成快照的代码指纹 —— 共享快照键(A3a)里唯一一项「渲染器版本」。
 *
 * 只哈希 CAPTURE_FILES 里**和生成快照有关**的两个:原 `export-frames.mjs`
 * (`__pcCreateSnapshot` 本体:样式内联、id 改名、canvas 换 img、按 data-pc-clip 切 control
 * 子树;搬家后是 `server/bakery/` 的那七个模块)和
 * `capture-snapshot.mjs`(把快照 HTML 塞回文档栅格化);再加页面侧的
 * `src/render/createSnapshot.ts` 及它调的四个模块(`snapshot/inlineStyles.ts` /
 * `snapshot/rasterizeCanvas.ts` / `snapshot/snapshotStyleProps.mjs` / `snapshot/renameSceneIds.ts`)和
 * `src/render/snapshotRename.ts`。
 * 其余 CAPTURE_FILES(capture-frame / frame-media / frame-ready / png-integrity)
 * 决定的是**截图**,不决定快照 HTML 的内容,不进这个指纹。
 *
 * J1 联动(必须一起读):J1 把生成快照的逻辑从原 export-frames.mjs 搬进 src/ 之后,
 * **这里只在快照代码自己拆文件时跟着加** —— 集合要恰好覆盖决定快照内容的那些文件。于是:
 *   - 改生成快照的代码 ⇒ 指纹变 ⇒ 共享键变 ⇒ 旧快照自然失效,不会被错误复用;
 *   - 不改 ⇒ 指纹不变 ⇒ 旧快照跨机器照常复用,搬家本身不作废任何快照。
 * 反例:直接用 `frameCode`(它哈希整个 src/(用户卡除外)加 frame-pipeline.mjs)的话,任何一次
 * 无关的卡片改动都会把全世界的共享快照冲掉,共享档就没有意义了。
 *
 * 缺文件按 `hashFiles` 的老规矩记 `'missing'`:某个模块还没落地时指纹也是确定的。
 */
const SNAPSHOT_FILES = [...BAKERY_FILES, 'server/bakery/capture-snapshot.mjs',
  'src/render/createSnapshot.ts', 'src/render/snapshot/inlineStyles.ts',
  'src/render/snapshot/rasterizeCanvas.ts', 'src/render/snapshot/snapshotStyleProps.mjs',
  'src/render/snapshot/renameSceneIds.ts', 'src/render/snapshotRename.ts'];
export function snapshotCode(root = APP_ROOT) {
  if (snapshots.has(root)) return snapshots.get(root);
  const hash = createHash('sha256');
  hashFiles(hash, root, SNAPSHOT_FILES);
  const value = hash.digest('hex').slice(0, 32); snapshots.set(root, value); return value;
}
