/**
 * 逐帧导出的**命令行入口**(`npm run export`)。
 *
 * 渲染引擎本身不在这里了:整套库(找 ffmpeg、开预渲染间、逐帧渲、分片、素材解析、整片编排、
 * Chrome 内混音)搬进了 `server/bakery/`,见 `server/bakery/index.mjs`。
 * 这个文件只剩两件事:解析参数,以及把参数交给 `exportFrames`。
 *
 * 下面那行 `export *` 是给仓库外的老调用方留的兼容转出 —— 仓库内部一律直接
 * import `server/bakery/...`,不要再经过这里。
 */
import { fileURLToPath } from 'url';
import { exportFrames } from '../server/bakery/index.mjs';

export * from '../server/bakery/index.mjs';

const isMain = import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  // 默认按机器资源分片；显式 --workers 1 可复现单进程路径。
  const opts = { noVideo: false, workers: 'auto' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') opts.url = args[++i];
    else if (args[i] === '--workers') opts.workers = args[++i];
    else if (args[i] === '--media') opts.media = args[++i];
    else if (args[i] === '--audio') opts.audio = args[++i]; // ffmpeg:不走 Chrome 混音(没有音频效果),对账用
    else if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--frames') opts.frames = args[++i];
    else if (args[i] === '--fps') opts.fps = parseFloat(args[++i]);
    else if (args[i] === '--warm') opts.warm = parseInt(args[++i], 10);
    else if (args[i] === '--no-video') opts.noVideo = true;
    else if (args[i] === '--format') opts.format = args[++i];
    else if (args[i] === '--quality') opts.quality = parseInt(args[++i], 10);
    else if (args[i] === '--static-skip') opts.staticSkip = true;
    else if (args[i] === '--dom-cache') opts.domCache = true;
    else if (args[i] === '--target-frames') opts.targetFrames = args[++i].split(',').map(Number).filter(Number.isFinite);
  }
  exportFrames(opts).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
