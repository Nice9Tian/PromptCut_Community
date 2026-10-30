/**
 * 渲染出来的那一帧在交出去之前要做的像素活:合成素材层、压底色、数透明像素、缩图。
 *
 * # 为什么单独放在这里
 *
 * 这些全是 pngjs 的同步解码 / 编码加逐像素循环。原来写在 vite-plugin-vision.ts 里,跑在
 * **给编辑器供模块的那个 Vite 进程**的事件循环上 —— 实测一张有内容的 1080p 帧解码 54 ms、
 * 编码 94 ms,see_frames 每帧解两次编两次,事件循环每帧被卡约 300 ms,期间编辑器要的模块、
 * 素材、接口一个都发不出去(docs/archive/topics/decoupling-plan.md 第 1.1 节)。
 *
 * 现在由渲染 worker(scripts/render-worker.mjs)在自己的进程里做完,父进程只读结果文件的字节,
 * 不解码。纯函数放在 .mjs 里,node --test 不经 vite 就能测。
 */
import fs from "node:fs/promises";
import { PNG } from "pngjs";
import { composeFrame } from "./vision-compose.mjs";

/** 缩图的长边上限:给模型看清楚画面够了,再大只是白烧上下文 */
export const MAX_EDGE = 768;
/** 透明处画成棋盘格,模型才分得清「透明」和「黑色」 */
const CHECKER_A = [0x6b, 0x70, 0x7b];
const CHECKER_B = [0x8b, 0x91, 0x9c];
const CHECKER_PX = 16;

/**
 * 等比缩到 maxEdge 以内,同时把透明底合成到棋盘格上。
 *
 * 用 pngjs 手写而不是拉 sharp / 再起一个 ffmpeg:这一步只是把一张图缩小,
 * 为它引入一个原生依赖或者又一个子进程不划算。盒式平均对「看清楚画面上有什么」
 * 足够,而且缩小时它比取点采样更不容易把细字抖没。
 */
export function shrink(png, maxEdge = MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(png.width, png.height));
  const w = Math.max(1, Math.round(png.width * scale));
  const h = Math.max(1, Math.round(png.height * scale));
  const out = new PNG({ width: w, height: h });

  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * png.height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * png.height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * png.width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * png.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * png.width + sx) << 2;
          // 先按各自的 alpha 预乘再平均,否则透明像素里的垃圾颜色会把边缘染脏
          const al = png.data[i + 3] / 255;
          r += png.data[i] * al; g += png.data[i + 1] * al; b += png.data[i + 2] * al;
          a += al; n++;
        }
      }
      const o = (y * w + x) << 2;
      const cover = a / n;
      // 合成到棋盘格上:out = 前景(已预乘) + 格子色 × (1 - 覆盖率)。
      // 卡片盖住的地方 cover=1,格子一点都露不出来;只有真透明的地方才看得见格子。
      const matte = (((x / CHECKER_PX) | 0) + ((y / CHECKER_PX) | 0)) % 2 === 0 ? CHECKER_A : CHECKER_B;
      out.data[o] = Math.round(r / n + matte[0] * (1 - cover));
      out.data[o + 1] = Math.round(g / n + matte[1] * (1 - cover));
      out.data[o + 2] = Math.round(b / n + matte[2] * (1 - cover));
      out.data[o + 3] = 255;
    }
  }
  return { png: out, width: w, height: h };
}

/**
 * 把透明底压平到一个底色上(原地改)。`hex` 是六位十六进制(不带 #)。
 *
 * 这个选择只该在**预渲染的时候**做一次:不传 = 透明底,物体在卡片没画的地方也透空(挖空观感,
 * 适合标志 / 招牌);传了 = 实心物体表面印着这张卡。
 */
export function flatten(png, hex) {
  const v = parseInt(hex, 16);
  const [br, bgc, bb] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  for (let i = 0; i < png.data.length; i += 4) {
    const a = png.data[i + 3] / 255;
    png.data[i] = Math.round(png.data[i] * a + br * (1 - a));
    png.data[i + 1] = Math.round(png.data[i + 1] * a + bgc * (1 - a));
    png.data[i + 2] = Math.round(png.data[i + 2] * a + bb * (1 - a));
    png.data[i + 3] = 255;
  }
  return png;
}

/** 全透明像素占比,保留三位小数。渲出一张空图时它是 1 —— bake_card 靠它提醒「这张卡在这一刻没画东西」 */
export function transparentRatio(png) {
  let clear = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] === 0) clear++;
  return Math.round((clear / (png.width * png.height)) * 1000) / 1000;
}

/**
 * 一帧的后处理。
 *
 * item:
 *   cards   —— 页面渲出来的卡片层 PNG(透明底)
 *   layers  —— 素材层 PNG,从下到上(ffmpeg 抽的帧,见 vision-compose 的 extractArgs)
 *   out     —— 写到哪儿
 *   bg      —— 六位十六进制底色;不给就保持透明
 *   stats   —— 要不要数透明像素
 *   shrink  —— 要不要缩到 MAX_EDGE 并铺棋盘格(给模型看的那一种)
 *
 * **什么都不用做就不解码**:原样拷过去。原来没有素材层时也要 read 再 write 一遍,纯属白烧。
 */
export async function postFrame(item) {
  const layers = Array.isArray(item.layers) ? item.layers : [];
  const needDecode = layers.length > 0 || !!item.bg || !!item.stats || !!item.shrink;
  if (!needDecode) {
    if (item.out !== item.cards) await fs.copyFile(item.cards, item.out);
    return { width: null, height: null };
  }
  let img = PNG.sync.read(await fs.readFile(item.cards));
  if (layers.length) {
    const decoded = [];
    for (const f of layers) decoded.push(PNG.sync.read(await fs.readFile(f)));
    img = composeFrame(img.width, img.height, decoded, img);
  }
  if (item.bg) flatten(img, item.bg);
  const ratio = item.stats ? transparentRatio(img) : undefined;
  const fin = item.shrink ? shrink(img) : { png: img, width: img.width, height: img.height };
  await fs.writeFile(item.out, PNG.sync.write(fin.png));
  return { width: fin.width, height: fin.height, ...(ratio === undefined ? {} : { transparentRatio: ratio }) };
}
