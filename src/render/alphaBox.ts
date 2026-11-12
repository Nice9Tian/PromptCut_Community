/**
 * Measure the normalized alpha bounding box (`0..1`) of a card texture so 3D boards crop transparent
 * margins while preserving exact stage placement.
 */

export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function alphaBox(
  data: ArrayLike<number>,
  width: number,
  height: number,
  opts: { threshold?: number } = {},
): NormBox | null {
  const th = opts.threshold ?? 0;
  if (width <= 0 || height <= 0) return null;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= th) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(width - 1, x1 + 1);
  y1 = Math.min(height - 1, y1 + 1);
  return {
    x: x0 / width,
    y: y0 / height,
    w: (x1 - x0 + 1) / width,
    h: (y1 - y0 + 1) / height,
  };
}

export function worthCropping(box: NormBox | null, minSaving = 0.04): boolean {
  if (!box) return false;
  return box.w < 1 - minSaving || box.h < 1 - minSaving;
}

let probe: HTMLCanvasElement | null = null;

export function measureImageBox(
  img: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
  maxEdge = 256,
): NormBox | null {
  const iw = img.naturalWidth || img.width || 0;
  const ih = img.naturalHeight || img.height || 0;
  if (!iw || !ih) return null;
  const scale = Math.min(1, maxEdge / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  try {
    probe ??= document.createElement("canvas");
    if (probe.width !== w || probe.height !== h) {
      probe.width = w;
      probe.height = h;
    }
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return alphaBox(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    return null;
  }
}
