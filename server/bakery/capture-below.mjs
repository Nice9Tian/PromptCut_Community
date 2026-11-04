/**
 * How to capture each frame for below-dependent streams (`kind: 'below'`): **differential layer
 * extraction** (render refactor "Wu-2", "Below-2", `docs/plan/prerender-products-contract.md`
 * section 5.3): on the Node side.
 *
 * An isolated project for such streams keeps the target card and all layers below it
 * (`isolatedBelowProject` in `server/frame-stream.mjs`). Capture two images per frame:
 *
 *   - Upper capture R: with the target card (the original single screenshot of `bakeStream`);
 *   - Lower capture L: on the **same page, at the exact same moment**, hide the target card layer
 *     and capture another.
 *
 * Then calculate a layer S such that "S overlaid on L with standard blending" equals R
 * (`diffLayer`), and pass S to the encoder. Where the target card makes no changes, S is fully
 * transparent, so the sparse pass can measure the entity box as usual and tighten on the second
 * pass, leaving only the area modified by the target card in the stream.
 *
 * # Why the lower layers of both captures are in the same frame state
 *
 * Hiding the target card does not reload the page, does not advance time, and does not touch React:
 * it only injects a style rule with `!important` into `<head>` to force the target card layer's
 * opacity to 0, and removes it as-is after capturing (following the frosted-glass overlay approach
 * in `./chrome.mjs`: only override transition durations without touching `transition-property`,
 * and remove in two steps without disturbing any running animations). Between the two captures,
 * none of the lower layer's DOM, animations, assets, or canvases change; the page clock is pinned
 * at this frame (`src/kernel/exportClock.ts`), and this extra tick yields the same value for
 * time-reading loops and an interval of 0 for interval-based loops.
 *
 * Relying solely on "in theory it should not change" is not enough; the first frame of each segment
 * verifies two things (`verify`, enabled by default):
 *
 *   - Take another capture while hidden; it must be byte-for-byte identical to the lower capture
 *     (ensuring it is not a stale frame from the compositor's previous tick);
 *   - Take another capture after removal; it must be byte-for-byte identical to the upper capture
 *     (ensuring hiding and removal did not mutate the page, and the page itself did not change
 *     during the extra ticks).
 *
 * If either condition fails, this segment fails (avoiding emitting potentially incorrect frames);
 * if the first condition fails, this stream will discard a frame before every subsequent lower
 * capture.
 *
 * # Screenshot rectangle and delivered rectangle
 *
 * Both captures are taken according to `view` (the entire scene for this kind of stream), and cropped
 * to `rect` after computation (the upper-bound rectangle in the sparse pass, and the tightened
 * rectangle in the second pass). The screenshot rectangle is not tightened: frosted glass needs to
 * sample the lower layer around itself, and cropping the screen smaller alters the blur near the edges
 * (measured numbers in `docs/reports/AGENT-rr-below-diff.md`).
 *
 * Only callers of `bakeStream` (`server/frame-stream.mjs`) use this; the export and snapshot
 * pipelines do not pass through here.
 */
import { captureFrame } from './capture-frame.mjs';
import { decodePngRgba } from './capture-canvas.mjs';

/** Same screenshot parameters as the track stream in `./bake.mjs`: PNG with transparency */
const SHOT = { format: 'png', optimizeForSpeed: true };

/* ======================================================================== *
 * Calculate that layer (pure function)
 * ======================================================================== */

/**
 * How much to relax the color lower bound (premultiplied color, full scale 1; 1/255 is one step in
 * 8-bit). Both screenshots are individually rounded to 8-bit, so their difference inherently has
 * about one step of noise; the lower bound is obtained by dividing this difference by `color_L` (or
 * `1 − color_L`), and when the divisor is very small, noise is amplified into full opacity
 * (measured: the opacity around shadows on solid video backgrounds jumps erratically between the
 * "expected value" and 1). Therefore, each lower bound is relaxed according to its own divisor:
 * when the divisor is close to 1 it is barely relaxed, and when the divisor is close to 0 it is
 * effectively ignored. The cost is that the composited color differs by at most this one step.
 */
export const DIFF_TOLERANCE = 1 / 255;

/**
 * Renders the frosted-glass outer frame (rounded rectangle) into a mask.
 * `glass`: `[{ x, y, w, h, radii }]`, coordinates are scene pixels (decimals allowed);
 * `radii` is `[horizontal_radius, vertical_radius]` for the four corners (top-left, top-right,
 * bottom-right, bottom-left), optional. `area`: rectangle corresponding to the mask
 * `{ x, y, w, h }` (scene coordinates, integers). Pixels whose centers fall within the rounded
 * rectangle are marked 1. Returns `Uint8Array(area.w × area.h)`.
 */
export function glassMask(glass, area, mask = new Uint8Array(area.w * area.h)) {
  const { w, h } = area;
  for (const g of glass ?? []) {
    if (!(g?.w > 0 && g?.h > 0)) continue;
    const x0 = g.x - area.x, y0 = g.y - area.y, x1 = x0 + g.w, y1 = y0 + g.h;
    const corner = n => { const c = g.radii?.[n]; return [Math.max(0, Number(c?.[0]) || 0), Math.max(0, Number(c?.[1]) || 0)]; };
    const tl = corner(0), tr = corner(1), br = corner(2), bl = corner(3);
    // CSS rule: when the sum of radii of two adjacent corners exceeds the side length, all four
    // corners are scaled down by the same ratio.
    const fit = (len, a, b) => (a + b > len ? len / (a + b) : 1);
    const f = Math.min(1, fit(g.w, tl[0], tr[0]), fit(g.w, bl[0], br[0]), fit(g.h, tl[1], bl[1]), fit(g.h, tr[1], br[1]));
    for (const c of [tl, tr, br, bl]) { c[0] *= f; c[1] *= f; }
    // How much width the corner radius consumes on this row: the corner radius is (rx, ry), and dy is
    // the vertical distance from this row to the center.
    const eaten = (rx, ry, dy) => (rx > 0 && ry > 0 && dy > 0 ? rx * (1 - Math.sqrt(Math.max(0, 1 - (dy / ry) * (dy / ry)))) : 0);
    const rowFrom = Math.max(0, Math.ceil(y0 - 0.5)), rowTo = Math.min(h, Math.ceil(y1 - 0.5));
    for (let py = rowFrom; py < rowTo; py++) {
      const cy = py + 0.5;
      const left = x0 + Math.max(eaten(tl[0], tl[1], y0 + tl[1] - cy), eaten(bl[0], bl[1], cy - (y1 - bl[1])));
      const right = x1 - Math.max(eaten(tr[0], tr[1], y0 + tr[1] - cy), eaten(br[0], br[1], cy - (y1 - br[1])));
      const from = Math.max(0, Math.ceil(left - 0.5)), to = Math.min(w, Math.ceil(right - 0.5));
      if (to > from) mask.fill(1, py * w + from, py * w + to);
    }
  }
  return mask;
}

/**
 * Differential layer extraction: compute a layer S from the image with the target card `upper` (R)
 * and the image without the target card `lower` (L), such that S overlaid on L with standard
 * blending equals R. All three are straight RGBA (PNG format, and also the format fed to the
 * encoder); `upper` and `lower` are full images of `width × height`, and `crop` (integers, defaults
 * to the full image) is the patch to deliver. Returns `{ rgba, width, height, changed }`: pixels of
 * S (sized to `crop`) and the count of pixels with opacity greater than 0.
 *
 * In terms of premultiplied color, each pixel must satisfy:
 *
 *     color_R = color_S + color_L × (1 − a)    opacity_R = a + opacity_L × (1 − a)    0 ≤ color_S ≤ a ≤ 1
 *
 * Once a is determined, color_S is `color_R − color_L × (1 − a)`, so we only need to determine a:
 *
 *   - R and L are identical: fully transparent (a = 0).
 *   - L is fully transparent: S is R.
 *   - L is fully opaque: the opacity formula imposes no constraint on a; a takes the minimum value
 *     that keeps color_S within [0, a], which is the maximum of the two lower bounds across color
 *     channels: `1 − color_R / color_L` and `(color_R − color_L) / (1 − color_L)` (formulas in
 *     contract section 5.3). Shadows, darkening, and brightening computed this way yield their
 *     exact original layer. Each of the two lower bounds is relaxed by `DIFF_TOLERANCE`: the former
 *     subtracts `tolerance × (1 − color_L) / color_L`, and the latter subtracts
 *     `tolerance × color_L / (1 − color_L)`.
 *   - L is translucent: the opacity formula gives
 *     `aα = (opacity_R − opacity_L) / (1 − opacity_L)`. If the lower bound b required by color is
 *     not greater than aα, take aα, and both hold strictly; when the lower bound required by color
 *     is greater (due to 8-bit quantization noise amplified on very dark or very bright L pixels),
 *     compromise on both sides: choose the a that equalizes "opacity error" and "color error",
 *     `(aα × (1 − opacity_L) + b × m) / ((1 − opacity_L) + m)`, where m is the slope of that color
 *     lower bound with respect to a (`color_L` or `1 − color_L`). When L is fully opaque, this
 *     reduces to the previous case; taking only b (the contract's original formulation) inflates
 *     opacity by a dozen levels on such pixels.
 *   - **Pixels inside the frosted-glass outer frame where L is also fully opaque: a takes 1, and
 *     S is R.** (`glass`: frosted-glass outer frame measured from the page, see `pageHideTarget`.)
 *     For these pixels, choosing any a from the minimum value to 1 reproduces R when overlaid on
 *     the same L; 1 is chosen because this area is originally the "filtered lower layer" overlaid
 *     as a whole block: if the minimum value were taken, S's opacity would be an image fluctuating
 *     with lower-layer details; when pasted back onto the stage, any slight discrepancy from stream
 *     generation (video off by a frame, live-rendered cards off by half a frame) would leak sharp
 *     lower-layer details through what should be blurred glass, and encoding error would also increase.
 *
 * After rounding a to 8 bits, color_S is recalculated (clamped to [0, a]), and straight color
 * (`color_S / a`) is delivered.
 */
export function diffLayer(upper, lower, width, height, { crop = null, glass = null, mask = null, tolerance = DIFF_TOLERANCE } = {}) {
  const c = crop ?? { x: 0, y: 0, w: width, h: height };
  if (!(Number.isInteger(c.x) && Number.isInteger(c.y) && Number.isInteger(c.w) && Number.isInteger(c.h)) || c.x < 0 || c.y < 0 || c.w <= 0 || c.h <= 0 || c.x + c.w > width || c.y + c.h > height) {
    throw new Error(`diffLayer: the rectangle to hand off is outside the frame: ${JSON.stringify(c)} (frame ${width}×${height})`);
  }
  if (upper.length < width * height * 4 || lower.length < width * height * 4) throw new Error('diffLayer: data is smaller than the frame');
  const out = Buffer.alloc(c.w * c.h * 4);
  const m = mask ?? (glass?.length ? glassMask(glass, c) : null);
  let changed = 0;
  for (let y = 0; y < c.h; y++) {
    let i = ((y + c.y) * width + c.x) * 4;
    let o = y * c.w * 4;
    let q = y * c.w;
    for (let x = 0; x < c.w; x++, i += 4, o += 4, q++) {
      const ra8 = upper[i + 3], la8 = lower[i + 3];
      const r0 = upper[i], r1 = upper[i + 1], r2 = upper[i + 2];
      const l0 = lower[i], l1 = lower[i + 1], l2 = lower[i + 2];
      const solid = la8 === 255 && m !== null && m[q] === 1;
      if (ra8 === la8 && r0 === l0 && r1 === l1 && r2 === l2) {
        // Identical: fully transparent. Do not leave holes inside the frosted-glass outer frame
        // (scattered transparent pixels will bleed after encoding).
        if (solid) { out[o] = r0; out[o + 1] = r1; out[o + 2] = r2; out[o + 3] = 255; changed++; }
        continue;
      }
      if (ra8 === 0) continue;
      if (la8 === 0 || solid) {
        out[o] = r0; out[o + 1] = r1; out[o + 2] = r2; out[o + 3] = solid ? 255 : ra8;
        changed++;
        continue;
      }
      const wa = (255 - la8) / 255;
      let aa = wa > 0 ? (ra8 - la8) / (255 - la8) : 0;
      if (aa < 0) aa = 0;
      let a = aa;
      const rc0 = r0 * ra8 / 65025, rc1 = r1 * ra8 / 65025, rc2 = r2 * ra8 / 65025;
      const lc0 = l0 * la8 / 65025, lc1 = l1 * la8 / 65025, lc2 = l2 * la8 / 65025;
      let b, v;
      if (lc0 > 0) { b = 1 - (rc0 + tolerance * (1 - lc0)) / lc0; if (b > aa) { v = (aa * wa + b * lc0) / (wa + lc0); if (v > a) a = v; } }
      if (lc0 < 1) { b = (rc0 - lc0 - tolerance * lc0) / (1 - lc0); if (b > aa) { v = (aa * wa + b * (1 - lc0)) / (wa + 1 - lc0); if (v > a) a = v; } }
      if (lc1 > 0) { b = 1 - (rc1 + tolerance * (1 - lc1)) / lc1; if (b > aa) { v = (aa * wa + b * lc1) / (wa + lc1); if (v > a) a = v; } }
      if (lc1 < 1) { b = (rc1 - lc1 - tolerance * lc1) / (1 - lc1); if (b > aa) { v = (aa * wa + b * (1 - lc1)) / (wa + 1 - lc1); if (v > a) a = v; } }
      if (lc2 > 0) { b = 1 - (rc2 + tolerance * (1 - lc2)) / lc2; if (b > aa) { v = (aa * wa + b * lc2) / (wa + lc2); if (v > a) a = v; } }
      if (lc2 < 1) { b = (rc2 - lc2 - tolerance * lc2) / (1 - lc2); if (b > aa) { v = (aa * wa + b * (1 - lc2)) / (wa + 1 - lc2); if (v > a) a = v; } }
      if (a > 1) a = 1;
      const a8 = Math.round(a * 255);
      if (a8 === 0) continue;
      const aq = a8 / 255, keep = 1 - aq;
      let s = rc0 - lc0 * keep; out[o] = s <= 0 ? 0 : s >= aq ? 255 : Math.round(s / aq * 255);
      s = rc1 - lc1 * keep; out[o + 1] = s <= 0 ? 0 : s >= aq ? 255 : Math.round(s / aq * 255);
      s = rc2 - lc2 * keep; out[o + 2] = s <= 0 ? 0 : s >= aq ? 255 : Math.round(s / aq * 255);
      out[o + 3] = a8;
      changed++;
    }
  }
  return { rgba: out, width: c.w, height: c.h, changed };
}

/**
 * Checks whether the two captures have different pixels outside `crop` (byte-by-byte comparison,
 * very fast). Returns their bounding box (in full-image pixel coordinates) if any, or null if none.
 * The full-density pass delivers only the patch inside the tight rectangle; if the target card
 * modifies outside the rectangle (the sparse pass only measures every few frames, so intermediate
 * frames might exceed it), use this for coarse screening first, then inspect closely with
 * `layerOutside`.
 */
export function changedOutside(upper, lower, width, height, crop) {
  let x0 = width, y0 = -1, x1 = -1, y1 = -1;
  const scan = (y, from, to) => {
    const start = (y * width + from) * 4, end = (y * width + to) * 4;
    if (to <= from || upper.compare(lower, start, end, start, end) === 0) return;
    let first = from, last = to - 1;
    while (upper.readUInt32LE((y * width + first) * 4) === lower.readUInt32LE((y * width + first) * 4)) first++;
    while (upper.readUInt32LE((y * width + last) * 4) === lower.readUInt32LE((y * width + last) * 4)) last--;
    if (y0 < 0) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  };
  for (let y = 0; y < height; y++) {
    if (y < crop.y || y >= crop.y + crop.h) scan(y, 0, width);
    else { scan(y, 0, crop.x); scan(y, crop.x + crop.w, width); }
  }
  return y1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Checks whether the computed layer has opaque pixels outside `crop`. Returns their bounding box
 * (in full-image pixel coordinates) if any, or null if none. Uses the same criterion as measuring
 * the entity box in the sparse pass (layer opacity greater than 0): pixels that differ byte-for-byte
 * between the two captures but still calculate to fully transparent do not count (where the lower
 * layer is nearly transparent, colors between the two captures often disagree, but after
 * premultiplication there is actually no difference), otherwise these pixels would be treated as
 * "modified outside the rectangle" on every frame.
 */
export function layerOutside(upper, lower, width, height, crop, { glass = null, origin = { x: 0, y: 0 } } = {}) {
  const exact = changedOutside(upper, lower, width, height, crop);
  if (!exact) return null;
  const mask = glass?.length ? glassMask(glass, { x: exact.x + origin.x, y: exact.y + origin.y, w: exact.w, h: exact.h }) : null;
  const ring = diffLayer(upper, lower, width, height, { crop: exact, mask }).rgba;
  let x0 = width, y0 = -1, x1 = -1, y1 = -1;
  for (let y = 0; y < exact.h; y++) {
    const py = y + exact.y, inRows = py >= crop.y && py < crop.y + crop.h;
    for (let x = 0; x < exact.w; x++) {
      if (!ring[(y * exact.w + x) * 4 + 3]) continue;
      const px = x + exact.x;
      if (inRows && px >= crop.x && px < crop.x + crop.w) continue;
      if (y0 < 0) y0 = py;
      y1 = py;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
    }
  }
  return y1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ======================================================================== *
 * In-page: hide / remove the target card layer
 * ======================================================================== */

/**
 * Runs in the page (`page.evaluate`, function body references nothing outside). Suppresses the
 * opacity of clip `clipId`'s layer to 0, returning `{ ok, absent, reason, glass }`:
 *
 *   - `absent`: this card is not on the page at this frame (not yet reached in point, already past
 *     out point); nothing was changed, and upper and lower captures are naturally identical;
 *   - `ok: false`: cannot suppress (`reason: 'not-hidden'`, computed opacity is not 0);
 *   - `glass`: outer frames (scene coordinates) and four corner radii of frosted glass in the target
 *     card that actually filter the lower layer at this moment, passed to `diffLayer` as masks.
 *     Only includes those that are visible, whose self and ancestors do not cause it to form a
 *     separate layer (opacity not 1, filters, blend modes, clipping, masks), and have no rotation
 *     or 3D: frosted glass on a separate layer cannot sample the lower layer, and a rotated outer
 *     frame does not match its shape: these are excluded from masks and computed using minimum
 *     opacity (which still reconstructs the original picture when overlaid).
 *
 * What is hidden is the `[data-pc-native-layer]` wrapped around each card on the export page; if
 * this layer is absent (old-shaped timeline), it hides the wrapper layer `[data-pc-clip]`. Cards
 * inside cut segments (flattened virtual clips, [ruling] R01) hide their wrapper layer
 * `[data-pc-flat-clip]` inside the nested scene; virtual clip ids contain `~` and do not collide
 * with top-level ids. When looking for frosted-glass outer frames, ancestor inspection stops at the
 * nested scene (`[data-pc-cut-scene]`): the nested scene is the sampling boundary for frosted glass
 * (`CutSegmentScene`'s `clip-path`), and the glass area is overlaid as a whole block inside the
 * scene; the scene's own `clip-path` is not counted as "forming a separate layer".
 */
export function pageHideTarget(clipId) {
  const ID = '__pc_below_hide';
  document.getElementById(ID)?.remove();
  const esc = CSS.escape(String(clipId));
  const sel = `[data-pc-native-layer="${esc}"], [data-pc-clip="${esc}"]:not([data-pc-media]), [data-pc-flat-clip="${esc}"]`;
  const layer = document.querySelector(`[data-pc-native-layer="${esc}"]`) ?? document.querySelector(`[data-pc-clip="${esc}"]:not([data-pc-media])`)
    ?? document.querySelector(`[data-pc-flat-clip="${esc}"]`);
  if (!layer) return { ok: true, absent: true, reason: null, glass: [] };
  const plain = v => !v || v === 'none' || v === 'normal';
  const ownLayer = cs => cs.opacity !== '1' || !plain(cs.filter) || !plain(cs.mixBlendMode) || !plain(cs.clipPath)
    || !plain(cs.maskImage) || !plain(cs.webkitMaskImage);
  const axisAligned = cs => {
    const t = cs.transform;
    if (!t || t === 'none') return true;
    const hit = /^matrix\(([^)]+)\)$/.exec(t);
    if (!hit) return false;
    const n = hit[1].split(',').map(Number);
    return Math.abs(n[1]) < 1e-6 && Math.abs(n[2]) < 1e-6 && n[0] > 0 && n[3] > 0;
  };
  const glass = [];
  for (const el of layer.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const filter = cs.backdropFilter || cs.webkitBackdropFilter;
    if (plain(filter) || cs.visibility !== 'visible' || cs.display === 'none') continue;
    // If it is translucent itself, has filters, etc.: this glass area is not overlaid as a whole block.
    if (ownLayer(cs) || !axisAligned(cs)) continue;
    let direct = true;
    for (let p = el.parentElement; p && direct; p = p.parentElement) {
      if (p.hasAttribute('data-pc-cut-scene')) break;
      const ps = getComputedStyle(p);
      if (ownLayer(ps) || !plain(ps.backdropFilter || ps.webkitBackdropFilter) || !axisAligned(ps)) direct = false;
      if (p.hasAttribute('data-pc-scene')) break;
    }
    if (!direct) continue;
    const box = el.getBoundingClientRect();
    if (!(box.width >= 1 && box.height >= 1)) continue;
    const sx = el.offsetWidth > 0 ? box.width / el.offsetWidth : 1, sy = el.offsetHeight > 0 ? box.height / el.offsetHeight : 1;
    const radius = value => {
      const parts = String(value || '0').trim().split(/\s+/);
      const one = (text, base) => (String(text).endsWith('%') ? (parseFloat(text) || 0) / 100 * base : parseFloat(text) || 0);
      return [one(parts[0], el.offsetWidth) * sx, one(parts[1] ?? parts[0], el.offsetHeight) * sy];
    };
    glass.push({ x: box.left, y: box.top, w: box.width, h: box.height,
      radii: [radius(cs.borderTopLeftRadius), radius(cs.borderTopRightRadius), radius(cs.borderBottomRightRadius), radius(cs.borderBottomLeftRadius)] });
  }
  const hold = `${sel} { transition-duration: 0s !important; transition-delay: 0s !important; }`;
  const style = document.createElement('style');
  style.id = ID;
  style.setAttribute('data-hold', hold);
  style.textContent = `${hold}\n${sel} { opacity: 0 !important; }`;
  document.head.appendChild(style);
  const hidden = getComputedStyle(layer).opacity === '0';
  return { ok: hidden, absent: false, reason: hidden ? null : 'not-hidden', glass };
}

/**
 * Runs in the page: removes the style rule added by `pageHideTarget`. In two steps: first keep
 * only "transition duration 0" to compute styles once (so reverting values triggers no
 * transitions), then delete entirely.
 */
export function pageShowTarget() {
  const style = document.getElementById('__pc_below_hide');
  if (!style) return false;
  style.textContent = style.getAttribute('data-hold') || '';
  void document.body.offsetHeight;
  style.remove();
  void document.body.offsetHeight;
  return true;
}

/* ======================================================================== *
 * Frame-capture hook for `bakeStream`
 * ======================================================================== */

/**
 * Differential layer extraction record for a stream (attached to `StreamProducer` stream state,
 * passed through as-is by `status()`).
 */
export function newBelowRecord() {
  return {
    /**
     * Reason why verification failed (`upper-changed`: upper capture changed after hide and remove);
     * once set, segments for this stream are no longer produced.
     */
    failed: null,
    /**
     * Whether to discard a frame before taking lower captures (turned on after verification finds two
     * consecutive captures while hidden are not identical).
     */
    primeLower: false,
    /**
     * How many frames captured; how many of those where the target card is absent from the page, where
     * upper and lower captures are byte-identical, and where the mask contains frosted glass; how many
     * verifications run; how many times the target card modified outside the delivered rectangle.
     */
    frames: 0, absent: 0, same: 0, glassFrames: 0, checks: 0, overflows: 0,
    /**
     * Cumulative elapsed time (ms): single screenshot for upper capture, hide and capture lower
     * capture then remove, two extra captures for verification, decoding two PNGs, computing that layer.
     */
    upperMs: 0, lowerMs: 0, verifyMs: 0, decodeMs: 0, diffMs: 0,
    /** Most recent verification `{ frame, lowerStable, upperStable }` */
    last: null,
  };
}

const samePixels = (a, b) => {
  if (a.equals(b)) return true;
  const da = decodePngRgba(a), db = decodePngRgba(b);
  return !!da && !!db && da.width === db.width && da.height === db.height && da.data.equals(db.data);
};

/**
 * Used for `bakeStream`'s `capture`: one per segment. `capture(frame, shoot)` returns
 * `{ rgba, width, height }` passed to `onFrame` for this frame (S calculated by differential layer
 * extraction, straight RGBA sized to `rect`).
 *
 * `clipId`: target card's clip; `view`: rectangle for both screenshots (scene coordinates,
 * `bakeStream`'s `clip` must match it); `rect`: delivered rectangle (scene coordinates, inside `view`);
 * `record`: record for this stream (`newBelowRecord`); `verify`: whether to run the two
 * verifications on the first frame of each segment; `note(message)`: log a diagnostic;
 * `tap({ frame, upperPng, lowerPng, glass, absent })`: used by probe to expose the two raw captures
 * taken at this frame (omitted in production).
 *
 * Fixed order: upper capture (`shoot()`) → hide → lower capture → (capture another during verification)
 * → remove → (capture another during verification). Does not advance time or remount in between;
 * once hidden, removal always occurs whether capturing succeeds or not (`finally`).
 *
 * When `rect` is smaller than `view`, if that layer still has opaque pixels outside `rect` (the target
 * card modified outside the delivered rectangle), an error with `code: 'below-overflow'` is thrown,
 * where `box` is the bounding box of those pixels (scene coordinates); the caller expands the
 * rectangle and retries.
 */
export function belowSegmentCapture(bakery, { clipId, view, rect, record = newBelowRecord(), signal = null, verify = true, note = () => {}, tap = null }) {
  const crop = { x: rect.x - view.x, y: rect.y - view.y, w: rect.w, h: rect.h };
  if (crop.x < 0 || crop.y < 0 || crop.x + crop.w > view.w || crop.y + crop.h > view.h) {
    throw new Error(`Layer diff: the rectangle to hand off ${JSON.stringify(rect)} is not inside the screenshot rectangle ${JSON.stringify(view)}`);
  }
  const fail = (code, message) => Object.assign(new Error(`Layer diff: ${message}`), { code });
  const shot = () => captureFrame(bakery, SHOT, signal, { prime: false, clip: view });
  let checked = !verify;
  let mask = null, maskKey = '';
  return async (frame, shoot) => {
    if (record.failed) throw fail(record.failed, `the last measurement of this stream failed (${record.failed}), no longer producing it`);
    let at = performance.now();
    const upperPng = await shoot();
    record.upperMs += performance.now() - at;
    at = performance.now();
    const checking = !checked;
    const hid = await bakery.page.evaluate(pageHideTarget, clipId);
    let lowerPng = null, lowerAgain = null;
    try {
      if (!hid?.ok) throw fail('not-hidden', `the layer of clip ${clipId} cannot be hidden (${hid?.reason ?? 'the page did not respond'})`);
      if (!hid.absent) {
        if (record.primeLower) await shot();
        lowerPng = await shot();
        if (checking) { record.lowerMs += performance.now() - at; at = performance.now(); lowerAgain = await shot(); }
      }
    } finally {
      if (hid && !hid.absent) await bakery.page.evaluate(pageShowTarget);
    }
    record.frames++;
    if (tap) await tap({ frame, upperPng, lowerPng, glass: hid.glass ?? [], absent: hid.absent === true });
    if (hid.absent) {
      record.lowerMs += performance.now() - at;
      record.absent++;
      return { rgba: Buffer.alloc(crop.w * crop.h * 4), width: crop.w, height: crop.h };
    }
    if (checking) {
      const upperAgain = await shot();
      const lowerStable = samePixels(lowerPng, lowerAgain), upperStable = samePixels(upperPng, upperAgain);
      record.verifyMs += performance.now() - at;
      record.checks++;
      record.last = { frame, lowerStable, upperStable };
      if (!upperStable) {
        record.failed = 'upper-changed';
        note(`Layer diff failed: after hiding and restoring clip ${clipId} at frame ${frame}, the frame containing the target card changed; this stream is no longer produced`);
        throw fail('upper-changed', `at frame ${frame}, the frame containing the target card changed after hiding and restoring`);
      }
      if (!lowerStable) {
        record.primeLower = true;
        note(`Layer diff: at frame ${frame} with clip ${clipId} hidden, two consecutive captures differ; from now on this stream discards one capture before each capture below`);
        throw fail('lower-unstable', `at frame ${frame} with the target card hidden, two consecutive captures differ`);
      }
      checked = true;
    } else record.lowerMs += performance.now() - at;
    const glass = hid.glass?.length ? hid.glass : null;
    if (!glass && upperPng.equals(lowerPng)) {
      record.same++;
      return { rgba: Buffer.alloc(crop.w * crop.h * 4), width: crop.w, height: crop.h };
    }
    at = performance.now();
    const upper = decodePngRgba(upperPng), lower = decodePngRgba(lowerPng);
    if (!upper || !lower || upper.width !== view.w || upper.height !== view.h || lower.width !== view.w || lower.height !== view.h) {
      throw fail('png', `the screenshot at frame ${frame} cannot be decoded, or is not ${view.w}×${view.h}`);
    }
    record.decodeMs += performance.now() - at;
    at = performance.now();
    if (crop.w < view.w || crop.h < view.h) {
      const outside = layerOutside(upper.data, lower.data, view.w, view.h, crop, { glass, origin: view });
      if (outside) {
        record.overflows++;
        throw Object.assign(fail('below-overflow', `at frame ${frame} the target card changed outside the rectangle handed off`), { box: { x: outside.x + view.x, y: outside.y + view.y, w: outside.w, h: outside.h } });
      }
    }
    if (glass) {
      record.glassFrames++;
      const key = JSON.stringify(glass);
      if (key !== maskKey) { mask = glassMask(glass, rect); maskKey = key; }
    }
    const layer = diffLayer(upper.data, lower.data, view.w, view.h, { crop, mask: glass ? mask : null });
    record.diffMs += performance.now() - at;
    return { rgba: layer.rgba, width: layer.width, height: layer.height };
  };
}
