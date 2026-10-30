#!/usr/bin/env node
/**
 * 清掉帧库里已经不会再被引用的旧缓存（M4 换键之后的孤儿目录）。
 *
 * 为什么会有孤儿：M4 起预渲染的结果键乘上了环境指纹（`docs/plan/render-queue-contract.md` E 节），
 * 同一次合并还改了预渲染管线的代码，整场景缓存和轨道前缀缓存的键里带着代码版本（`frameCode`），
 * 也一起换了。换键之前写的目录再也算不出它们的名字，只占盘。
 *
 * 怎么判「旧」：键是哈希，从目录名看不出新旧，所以按时间判 —— 一个键目录里**最新的**文件
 * 早于分界时刻（缺省是 M4 合并进 main 的时刻）才算旧。换键之后写过的目录一定有更新的文件，
 * 所以不会误删；还在跑旧代码的进程在分界之后写的目录会留下，之后再跑一次即可。
 *
 * 管哪些目录（都在帧库根下，一个键一个目录）：
 *   controls-html/<键>               共享档快照
 *   controls-local/<entry.key>/<键>  本地档快照（外层空了一并删）
 *   controls/<键>                    独立卡 PNG 缓存
 *   streams/<键>                     轨道流
 *   tracks/<键>                      轨道前缀缓存（键带代码版本）
 *   <entry.key>                      整场景缓存（键带代码版本）
 * 不碰：`controls-lock/`（卡片级指纹锁，M4 之后才有）、根下的普通文件、认不出的目录。
 *
 * 缺省只列出、不删；加 `--apply` 才删。遇到符号链接或 junction 一律跳过，不顺着删。
 *
 * 用法：
 *   node scripts/prune-prerender-cache.mjs                 # 列出 out/frame-library 里的旧目录
 *   node scripts/prune-prerender-cache.mjs --apply         # 真删
 *   --root <帧库目录>     缺省 $PROMPTCUT_EXPORT_DIR/frame-library，没设就是 ./out/frame-library
 *   --before <时刻>       ISO 时间或毫秒数，缺省 M4_KEYS_SINCE
 *   --json                结果按 JSON 打印
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { M4_KEYS_SINCE, findStale, removeStale, looksLikeFrameLibrary } from '../server/prerender-cache-prune.mjs';

function parseArgs(argv) {
  const opts = { apply: false, json: false, root: null, before: M4_KEYS_SINCE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--root') opts.root = argv[++i];
    else if (arg === '--before') {
      const raw = argv[++i];
      const value = /^\d+$/.test(raw ?? '') ? Number(raw) : Date.parse(raw);
      if (!Number.isFinite(value)) throw new Error(`--before 认不出:${raw}`);
      opts.before = value;
    } else throw new Error(`不认识的参数:${arg}`);
  }
  opts.root ||= path.join(process.env.PROMPTCUT_EXPORT_DIR || path.join(process.cwd(), 'out'), 'frame-library');
  return opts;
}

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root);
  if (!await looksLikeFrameLibrary(root)) {
    console.error(`${root} 不像帧库(没有 controls-html / controls / streams 等子目录),不处理。`);
    process.exit(2);
  }
  const { stale, kept, skipped } = await findStale(root, opts.before);
  const byFamily = {};
  for (const item of stale) {
    const row = (byFamily[item.family] ||= { dirs: 0, bytes: 0 });
    row.dirs++; row.bytes += item.bytes;
  }
  const total = stale.reduce((sum, item) => sum + item.bytes, 0);
  const removed = opts.apply ? await removeStale(root, stale) : 0;
  const summary = { root, before: new Date(opts.before).toISOString(), applied: opts.apply, stale: stale.length, bytes: total,
    kept, skipped: skipped.map(item => item.dir), byFamily, removed };
  if (opts.json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`帧库:${root}`);
  console.log(`分界:${summary.before}(最新文件早于它的键目录算旧)`);
  for (const [family, row] of Object.entries(byFamily)) console.log(`  ${family.padEnd(15)} ${String(row.dirs).padStart(5)} 个目录  ${mb(row.bytes)}`);
  console.log(`旧目录合计 ${stale.length} 个、${mb(total)};保留 ${kept} 个;跳过(链接)${skipped.length} 个`);
  console.log(opts.apply ? `已删除 ${removed} 个目录。` : '只列出,没有删除。确认无误后加 --apply 再跑一次。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.message || error); process.exit(1); });
}
