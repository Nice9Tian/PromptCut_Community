/**
 * RGBA → I420(BT.601 有限范围),和桌面导出里 ffmpeg 的 `-pix_fmt yuv420p`(swscale 缺省矩阵)同一个换算。
 *
 * 为什么自己换:直接 `new VideoFrame(canvas)` 交给 `VideoEncoder`,Chrome 按它自己的矩阵把 RGB 换成 YUV,
 * 产物不带色彩标记,播放器(和 ffprobe / ffmpeg)按 BT.601 解回来,红色偏出十几个色阶;桌面导出没有这个偏差。
 * 这里先换成 I420 再交出去(`VideoFrame` 的 `format: 'I420'`),两条导出路解回来的颜色一致。
 *
 * 色度按 2×2 取平均;宽高是奇数时最后一行 / 列按边上的像素补。
 */
export function rgbaToI420(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, out?: Uint8Array): Uint8Array {
  const cw = (width + 1) >> 1, ch = (height + 1) >> 1;
  const ySize = width * height, cSize = cw * ch;
  const buf = out && out.length >= ySize + 2 * cSize ? out : new Uint8Array(ySize + 2 * cSize);
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < height; y++) {
    let i = y * width * 4, o = y * width;
    for (let x = 0; x < width; x++, i += 4, o++) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      buf[o] = clamp(Math.round(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255));
    }
  }
  const uBase = ySize, vBase = ySize + cSize;
  for (let cy = 0; cy < ch; cy++) {
    const y0 = cy * 2, y1 = Math.min(height - 1, y0 + 1);
    for (let cx = 0; cx < cw; cx++) {
      const x0 = cx * 2, x1 = Math.min(width - 1, x0 + 1);
      let r = 0, g = 0, b = 0;
      for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        const i = (py * width + px) * 4;
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
      }
      r /= 4; g /= 4; b /= 4;
      const k = cy * cw + cx;
      buf[uBase + k] = clamp(Math.round(128 + (-37.797 * r - 74.203 * g + 112.0 * b) / 255));
      buf[vBase + k] = clamp(Math.round(128 + (112.0 * r - 93.786 * g - 18.214 * b) / 255));
    }
  }
  return buf;
}
