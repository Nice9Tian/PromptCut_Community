/**
 * RGBA → I420 (BT.601 limited range), same conversion as ffmpeg's `-pix_fmt yuv420p`
 * (swscale default matrix) in desktop export.
 *
 * Why convert ourselves: passing `new VideoFrame(canvas)` directly to `VideoEncoder`, Chrome
 * converts RGB to YUV with its own matrix, leaving output without color tags. Players (and
 * ffprobe / ffmpeg) decode it back using BT.601, shifting red by over a dozen color levels;
 * desktop export does not have this deviation. Converting to I420 here first before passing it out
 * (`format: 'I420'` in `VideoFrame`) ensures both export paths decode to consistent colors.
 *
 * Chroma is averaged 2×2; when width or height is odd, the last row / column pads edge pixels.
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
