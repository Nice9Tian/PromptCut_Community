/**
 * Media compositing for compatibility bypass: when explicitly passing --media=ffmpeg, Chrome only
 * renders card transparent layers, while video / image assets are composited into the final video
 * by ffmpeg.
 *
 * # Why not let Chrome render media together
 *
 * Previously, the export page mounted every media clip as a <video>, seeking each layer in the
 * frame once per frame and waiting for seeking to finish before taking a screenshot (ExportView's
 * __pcSetT / __pcFrameReady). A single seek in 1080p H.264 requires decoding to the target frame,
 * taking tens to hundreds of milliseconds, and crossfades double that per frame; frames containing
 * video could also never be classified as static (isStatic in server/bakery/bake.mjs). Ultimately
 * ffmpeg merely laid the PNG sequence over a gray background: video pixels were scaled by Chrome
 * and baked into PNGs. see_frames switched long ago to "page only renders cards, ffmpeg extracts
 * media frames" (vision-compose.mjs), and this approach is brought here to the entire export
 * pipeline: media layers are assembled into a single filter graph following the same rules as
 * ExportView / preview MediaLayers, with one ffmpeg pass for decoding, positioning, fading, card
 * overlaying, and encoding.
 *
 * # Rules aligned with the page (each corresponds to a piece of frontend code)
 *
 *   - Which clips, who overlays whom: videoLayersAt in kernel/project.ts: walk tracks in reverse,
 *     higher tracks are on top; hidden tracks and audio are excluded.
 *   - Whether a frame appears: same as ExportView, evaluate start <= t < end using `i / fps`,
 *     directly converted here to frame index intervals.
 *   - Opacity: opacityAt = opacity × fade-in × fade-out, implemented using colorchannelmixer
 *     (constant) and fade alpha (linear) respectively.
 *   - Which media frame to take: after Chrome seeks to currentTime, it displays "the last frame
 *     with timestamp ≤ currentTime"; here fps=round=up is used to place media frames onto the
 *     export frame grid, which is the same retrieval method (round=near would switch frames half
 *     a frame early). Frame-by-frame comparison against legacy export (Chrome frame-by-frame seek)
 *     in testing: on wf-test media, the exact same frame is retrieved; on a Bilibili mp4 with many
 *     B-frames (has_b_frames=4), legacy export lagged this rule by 1~2 frames: Chrome was skewed
 *     there, while here we retrieve according to the rule (verified independently without Chrome).
 *   - Positioning: preview MediaLayers approach: outer container is clip.frame box (the frameCss
 *     system: anchor point, scale, plane rotation, overflow:hidden), inside which media fills
 *     with object-fit: cover. The legacy export page ignored frame (always filled full screen),
 *     causing export and preview to mismatch; here we follow preview. Media clips do not allow
 *     3D (assertNo3dOnMedia in kernel/envelope.ts).
 *   - Emphasis: see comments on emphasisOps below.
 *   - Frosted glass on cards (backdrop-filter): see the mask parameter in buildComposeArgs.
 *
 * Pure function, does not touch disk or spawn processes, tested directly with node --test
 * (server/test/export-compose.test.mjs).
 */

import { ffmpegChain, ffmpegStages, ffmpegStaticChain, filterOfClip, isAnimated, resolveOps, sendcmdScript } from "../src/kernel/filters.mjs";
import { clipSpeed, mediaTimeAt } from "../src/kernel/clipTime.mjs";
import { tr as trText } from "./i18n.mjs";

/** Same criteria as ExportView / flattenOverlay: all visual media clips (video + image) from bottom to top, regardless of time */
export function composeLayers(project) {
  const out = [];
  for (const tr of [...(project.tracks || [])].reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips || []) {
      if (!c.mediaId) continue;
      const media = (project.media || []).find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      // Filter definitions are project-level (project.filters), but compositing only receives layers: attach the definition and parameters for this clip here
      const def = filterOfClip(project, c);
      const pixelMap = c.pixelMap && (project.pixelMaps ?? []).find((x) => x.id === c.pixelMap.id);
      out.push({ clip: c, media, ...(def ? { filter: { def, params: c.filter.params } } : null), ...(pixelMap ? { pixelMap } : null) });
    }
  }
  return out;
}

/**
 * Which frames this clip appears in within the exported [f0, f1] frames: first and last frame
 * (inclusive), returning null if it does not appear. Determination copied verbatim from
 * ExportView: `sec = i / fps`, `sec >= start && sec < end`. Estimate with multiplication first,
 * then correct frame-by-frame, to prevent floating-point rounding errors like 2.68 × 30 from
 * miscalculating boundary frames by one.
 */
export function clipFrameRange(clip, fps, f0, f1) {
  const inside = (i) => i / fps >= clip.start && i / fps < clip.end;
  let a = Math.max(f0, Math.ceil(clip.start * fps) - 1);
  while (a <= f1 && !inside(a)) {
    if (a / fps >= clip.end) return null;
    a++;
  }
  if (a > f1) return null;
  while (a - 1 >= f0 && inside(a - 1)) a--;
  let b = Math.min(f1, Math.max(a, Math.floor(clip.end * fps) + 1));
  while (b > a && !inside(b)) b--;
  while (b + 1 <= f1 && inside(b + 1)) b++;
  return [a, b];
}

/**
 * Placement of clip.frame on the stage, converted to integers required by ffmpeg: the asset first
 * covers a w×h box (already multiplied by scale), rotates around the box center into ow×oh,
 * with its top-left corner landing at (x, y).
 *
 * Same chain of transforms as frameCss: box top-left = anchor coordinates - anchor offset within
 * the box, scaling / rotation around the anchor (transformOrigin = anchor%). The vector from the
 * anchor to the box center is scaled then rotated to get the transformed box center position;
 * ffmpeg's rotate rotates around the image center and its output is also center-aligned, so we just
 * need to place the output center there.
 * Rotation direction: both CSS rotate(θ) and ffmpeg rotate=a are positive clockwise
 * (y-axis points down).
 */
export function placement(frame, stage) {
  if (!frame) return { w: stage.width, h: stage.height, ow: stage.width, oh: stage.height, x: 0, y: 0, rotate: 0, scale: 1 };
  const w0 = frame.w ?? stage.width;
  const h0 = frame.h ?? stage.height;
  const [ax, ay] = frame.anchor ?? [0, 0];
  const s = frame.scale ?? 1;
  const rot = ((frame.rotate ?? 0) * Math.PI) / 180;
  const w = Math.max(1, Math.round(w0 * s));
  const h = Math.max(1, Math.round(h0 * s));
  // Box center relative to anchor: (0.5 - anchor) × size, scaled first then rotated
  const vx = (0.5 - ax) * w0 * s;
  const vy = (0.5 - ay) * h0 * s;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const cx = frame.x + vx * cos - vy * sin;
  const cy = frame.y + vx * sin + vy * cos;
  let ow = w;
  let oh = h;
  if (rot !== 0) {
    ow = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin) - 1e-9);
    oh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos) - 1e-9);
  }
  return { w, h, ow, oh, x: Math.round(cx - ow / 2), y: Math.round(cy - oh / 2), rotate: rot, scale: s };
}

/* ---------------------------------------------------------------------------------------------
 * Color: emphasis color is an arbitrary CSS color string (kernel/emphasis.ts does not parse it,
 * delegating to the browser). ffmpeg requires numeric values; common formats are recognized here;
 * unrecognized ones return null, and caller falls back to default color and clarifies in notes.
 * ------------------------------------------------------------------------------------------- */
const NAMED = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], lime: [0, 255, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], aqua: [0, 255, 255], magenta: [255, 0, 255],
  fuchsia: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  maroon: [128, 0, 0], olive: [128, 128, 0], teal: [0, 128, 128], navy: [0, 0, 128], purple: [128, 0, 128],
  orange: [255, 165, 0], pink: [255, 192, 203], gold: [255, 215, 0], transparent: [0, 0, 0, 0],
};

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** CSS color → [r, g, b, a] (0-255, a is 0-1). Returns null if unrecognized */
export function parseCssColor(str) {
  const s = String(str || "").trim().toLowerCase();
  if (!s) return null;
  if (NAMED[s]) {
    const [r, g, b, a = 1] = NAMED[s];
    return [r, g, b, a];
  }
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const v = [...h].map((c) => parseInt(c + c, 16));
      return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].slice(0, h.length / 2).map((i) => parseInt(h.slice(i, i + 2), 16));
      return [v[0], v[1], v[2], h.length === 8 ? v[3] / 255 : 1];
    }
    return null;
  }
  m = s.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (p, scale) => (p.endsWith("%") ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const alpha = parts[3] !== undefined ? num(parts[3], 1) : 1;
  let rgb;
  if (m[1].startsWith("rgb")) rgb = parts.slice(0, 3).map((p) => num(p, 255));
  else rgb = hslToRgb(parseFloat(parts[0]), num(parts[1].endsWith("%") ? parts[1] : parts[1] + "%", 1), num(parts[2].endsWith("%") ? parts[2] : parts[2] + "%", 1));
  if ([...rgb, alpha].some((v) => !Number.isFinite(v))) return null;
  return [...rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))), Math.max(0, Math.min(1, alpha))];
}

/* ---------------------------------------------------------------------------------------------
 * Emphasis (shadow / stroke). Uses the same routine as emphasisFilter in kernel/emphasis.ts
 * (that side is TS, whereas the export script is an .mjs running directly on node, so a copy is
 * kept here; unit tests reconcile outputs from both sides, and changing one side turns tests on
 * the other red).
 *
 * CSS `filter: drop-shadow(a) drop-shadow(b) …` applies **sequentially**: the second shadow casts
 * "original image + first shadow", so the eight stroke directions stack together into a border
 * thicker than the line width. Here they are stacked layer by layer in the same order, not eight
 * shadows side by side.
 * Blur: per spec, drop-shadow blur radius is twice the standard deviation; gblur's sigma takes
 * half the radius.
 *
 * When it is visible: in preview, filter is attached to the asset element with an outer box of
 * overflow:hidden, while the asset covers and fills this box:
 * **For opaque assets (ordinary video, jpg), cast shadows fall completely outside the box and are
 * clipped, and inside the box is covered by the asset itself, leaving not a single pixel changed on screen.**
 * Only assets with an alpha channel (keyed PNG, video with alpha) show emphasis. So the caller tells
 * here whether the asset has alpha, and if not, skips entirely: the result is identical to computing it,
 * saving eight passes of full-size blur per frame.
 * ------------------------------------------------------------------------------------------- */
const EMPHASIS_DEFAULTS = {
  shadow: { color: "#000000", size: 18, opacity: 0.55, dx: 0, dy: 8 },
  outline: { color: "#ffffff", size: 6, opacity: 1, dx: 0, dy: 0 },
};
const clampNum = (v, lo, hi, d) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/**
 * A series of sequentially applied drop-shadows: [{ dx, dy, blur, color: [r,g,b,a] }]
 * (stage pixels, already multiplied by scale).
 * Returns [] if there is no emphasis / parameters are invalid. notes reports downgrades
 * such as unrecognized colors.
 */
export function emphasisOps(raw, scale = 1, notes = []) {
  if (!raw || (raw.kind !== "shadow" && raw.kind !== "outline")) return [];
  const d = EMPHASIS_DEFAULTS[raw.kind];
  const n = {
    color: typeof raw.color === "string" && raw.color.trim() ? raw.color.trim() : d.color,
    size: clampNum(raw.size, 0, 80, d.size),
    opacity: clampNum(raw.opacity, 0, 1, d.opacity),
    dx: clampNum(raw.dx, -200, 200, d.dx),
    dy: clampNum(raw.dy, -200, 200, d.dy),
  };
  if (n.size <= 0 || n.opacity <= 0) return [];
  let rgba = parseCssColor(n.color);
  if (!rgba) {
    notes.push(trText("Emphasis color \"{0}\" not recognized, composited with default color {1}", n.color, d.color));
    rgba = parseCssColor(d.color);
  }
  // Same as tint in emphasis.ts: opacity is rounded to percentage, stacked onto the color's own alpha
  const color = [rgba[0], rgba[1], rgba[2], n.opacity >= 1 ? rgba[3] : rgba[3] * (Math.round(n.opacity * 100) / 100)];
  // + 0 turns -0 into 0: emphasis.ts formats -0 as "0px" anyway when concatenating strings
  const px = (v) => +(v * scale).toFixed(2) + 0;
  if (raw.kind === "shadow") return [{ dx: px(n.dx), dy: px(n.dy), blur: px(n.size), color }];
  const r = n.size;
  const blur = r > 4 ? r * 0.2 : 0;
  const ops = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * 2 * Math.PI) / 8;
    ops.push({ dx: px(Math.cos(a) * r), dy: px(Math.sin(a) * r), blur: px(blur), color });
  }
  return ops;
}

const f3 = (v) => String(+Number(v).toFixed(6));

/**
 * A series of sequentially applied drop-shadows on a w×h gbrap frame.
 *
 * Within the same emphasis, each shadow has the same color, opacity, and blur (guaranteed by
 * emphasisOps), differing only in offset, so there is no need to stack across four planes for each
 * layer (in tests, doing so for eight-layer strokes dragged overall composition from 55 fps down to 20 fps):
 *   - Stack sequentially only on the alpha plane (grayscale): layer k = previous layer over its own
 *     shadow. Shadow alpha = blurred, translated previous-layer alpha × color alpha; the alpha
 *     formula for "over", a + s(1 - a), happens to be the blend screen mode;
 *   - After stacking, obtain the total alpha, combine with solid color to make a single shadow,
 *     with original image placed on top.
 * The difference from layer-by-layer full-color stacking is only at semitransparent edges of the
 * original image (where the calculated shadow is slightly more solid), imperceptible to the naked eye.
 */
function emphasisChain(inLabel, outLabel, ops, w, h, k) {
  const [r, g, b, ca] = ops[0].color;
  const sigma = ops[0].blur > 0 ? ops[0].blur / 2 : 0;
  const L = (s) => `e${k}${s}`;
  const lines = [`[${inLabel}]split=3[${L("top")}][${L("col")}][${L("src")}]`, `[${L("src")}]alphaextract[${L("a0")}]`];
  ops.forEach((op, j) => {
    const dx = Math.round(op.dx);
    const dy = Math.round(op.dy);
    const pad = Math.max(Math.abs(dx), Math.abs(dy));
    const s = [];
    if (sigma > 0) s.push(`gblur=sigma=${f3(sigma)}`);
    if (pad > 0) s.push(`pad=${w + 2 * pad}:${h + 2 * pad}:${pad + dx}:${pad + dy}:color=black`, `crop=${w}:${h}:${pad}:${pad}`);
    s.push(`lut=c0=val*${f3(ca)}`);
    lines.push(
      `[${L(`a${j}`)}]split[${L(`p${j}`)}][${L(`q${j}`)}]`,
      `[${L(`q${j}`)}]${s.join(",")}[${L(`s${j}`)}]`,
      `[${L(`p${j}`)}][${L(`s${j}`)}]blend=all_mode=screen[${L(`a${j + 1}`)}]`,
    );
  });
  lines.push(
    `[${L("col")}]lutrgb=r=${r}:g=${g}:b=${b}[${L("rgb")}]`,
    `[${L("rgb")}][${L(`a${ops.length}`)}]alphamerge[${L("sh")}]`,
    // Shadow below, original image above. overlay also composites alpha when the main video has alpha
    `[${L("sh")}][${L("top")}]overlay=format=gbrp:alpha=straight[${outLabel}]`,
  );
  return lines;
}

/**
 * Assemble full ffmpeg arguments.
 *
 * opts:
 *   width / height / fps / startFrame / endFrame: exported aspect ratio and frame range (matches bakeFrames)
 *   cardsPattern: card transparent layer PNG sequence (%06d), numbered starting from startFrame
 *   layers: result of composeLayers, with each item supplemented with:
 *       src: path or URL readable by ffmpeg; skipped if missing (explained in notes)
 *       hasAlpha: whether asset has an alpha channel (determines if emphasis is computed)
 *       colorSpace: ffprobe's color_space, decoded according to untaggedMatrix when untagged
 *       decoder: optional, forced decoder (VP9 with alpha requires libvpx-vp9 to decode alpha)
 *   mask: optional { pattern, blur }: mask sequence for card frosted glass (backdrop-filter).
 *       When the page only renders cards, behind the glass is transparent, cannot blur video;
 *       here the entire "gray background + assets" is blurred according to blur,
 *       mixed back with mask (glass area is white, carrying the glass's own opacity), then cards
 *       are stacked: the glass's background color and stroke are all in the card layer.
 *   background: background color, defaults to #333333 (matches earlier preview.mp4 gray background)
 *   untaggedMatrix: matrix to convert video to RGB when untagged for color space, defaults to bt709
 *   out: output mp4
 *
 * Returns { args, graph, notes, used }: graph is provided separately, caller can pass via file if too long.
 */
export function buildComposeArgs(opts) {
  const { width, height, fps, startFrame, endFrame, cardsPattern, out } = opts;
  const pixelLayer = (opts.layers || []).find((layer) => layer.pixelMap && !layer.missingMaterial);
  if (pixelLayer) throw new Error(trText("Clip {0} uses a pixel map. Export with the default Chrome export (--media chrome); the ffmpeg compatibility bypass does not support pixel-level mapping", pixelLayer.clip?.id || trText("(unknown)")));
  const bg = opts.background || "#333333";
  const untagged = opts.untaggedMatrix || "bt709";
  const notes = [];
  const frames = endFrame - startFrame + 1;
  const dur = +(frames / fps).toFixed(3);
  const t0 = startFrame / fps;
  const args = ["-y", "-hide_banner", "-nostdin"];
  /*
   * Every input includes -reinit_filter 0: do not rebuild the entire filtergraph when input frame
   * format changes midway.
   * In practice, card PNGs change format midway: when the whole frame is opaque (such as a card
   * filling the entire screen), PNGs encoded by Chrome omit alpha, changing from rgba to rgb24.
   * By default, ffmpeg tears down and rebuilds the filtergraph on such changes: synchronization state
   * for fps / trim / each overlay is completely lost; in testing, a 240-frame segment loses 1-4 frames
   * (different each time), and the entire 60-second graph pass freezes near that frame. Without rebuilding,
   * format conversion attached after the input reconfigures per frame, producing correct visuals
   * (compared pixel-by-pixel with rebuilding, average difference is within 1.5/255, within encoding error).
   * Card / mask is followed explicitly by format=rgba: if the first frame happens to be rgb24,
   * negotiated format would lack alpha, compressing subsequent transparent frames into opaque ones.
   */
  const R = ["-reinit_filter", "0"];
  // Input 0: background; 1: cards (or already stream-encoded card video); 2: mask (optional);
  // then one input per asset clip
  args.push(...R, "-f", "lavfi", "-i", `color=c=${bg}:s=${width}x${height}:r=${fps}:d=${dur}`);
  if (opts.cardsVideo) args.push(...R, "-i", opts.cardsVideo);
  else args.push(...R, "-framerate", String(fps), "-start_number", String(startFrame), "-i", cardsPattern);
  let next = 2;
  let maskIn = -1;
  if (opts.mask) {
    maskIn = next++;
    args.push(...R, "-framerate", String(fps), "-start_number", String(startFrame), "-i", opts.mask.pattern);
  }
  const graph = [];
  const used = [];
  // Time-varying filters need a sendcmd script: only path and content are provided here,
  // to be written to disk by caller (this module does not touch disk)
  const sidecars = [];
  let base = "b0";
  graph.push(`[0:v]format=gbrp[b0]`);
  const stage = { width, height };
  for (const layer of opts.layers || []) {
    const { clip, media } = layer;
    const range = clipFrameRange(clip, fps, startFrame, endFrame);
    if (!range) continue;
    if (!layer.src && !layer.missingMaterial) {
      notes.push(trText("File for media \"{0}\" not found, clip {1} has no picture on this layer", media.name || media.id, clip.id));
      continue;
    }
    const [a, b] = range;
    const ta = a / fps;
    const off = clip.mediaOffset ?? 0;
    const k = next++;
    const isMissing = !!layer.missingMaterial;
    const isImage = isMissing || media.kind === "image";
    const p = placement(clip.frame, stage);
    /*
     * This layer is first placed at **absolute time on the entire timeline** (frame number = export frame
     * number); fade in/out and clipping are written in absolute time, and only at the end shifted as a whole
     * to segment start t0. If shifted first in reverse, exporting a segment (--frames) would have a negative
     * fade-in start point, and fade does not accept a negative st.
     */
    let shift;
    /** Speed-changed video clip: asset timestamp divided by this (= clip speed); 1 otherwise, setpts syntax unchanged */
    let ptsScale = 1;
    // Video only: asset's built-in audio / captions / data streams are dropped during demuxing
    // (audio is mixed separately by mux-audio)
    args.push(...R, "-an", "-sn", "-dn");
    if (isMissing) {
      if (!opts.fontFile) throw new Error("Confirming missing media requires an explicit Chinese font file; the text proxy cannot be skipped.");
      const len = (b - a + 2) / fps;
      args.push(...R, "-f", "lavfi", "-i", `color=c=0x20242b:s=${p.w}x${p.h}:r=${fps}:d=${len}`);
      shift = ta;
    } else if (isImage) {
      // Image: looped into a stream at fps, with the first frame placed at frame a
      const len = (b - a + 2) / fps;
      args.push("-loop", "1", "-framerate", String(fps), "-t", f3(len), "-i", layer.src);
      shift = ta;
    } else {
      // Video: -ss placed before -i for fast seek; leave an extra 0.5s margin ahead to ensure
      // "last frame ≤ target time" is also decoded (precise seek drops frames before -ss, which might be
      // exactly what Chrome displays at frame a).
      // After -ss S, timestamp for asset time m is m - S; on the timeline it is
      // clip.start + (m - off) / speed (kernel/clipTime.mjs).
      // Speed-changed clip: length of asset read is multiplied by speed rate, timestamp divided by rate
      // then shifted; defaulting to 1 makes each formula below bit-for-bit identical to the original
      const speed = clipSpeed(clip);
      const mt = mediaTimeAt(clip, ta);
      const ss = Math.max(0, mt - 0.5);
      const len = (b - a + 1) / fps * speed + (mt - ss) + 0.5;
      if (layer.decoder) args.push("-c:v", layer.decoder);
      args.push("-ss", f3(ss), "-t", f3(len), "-i", layer.src);
      shift = speed === 1 ? clip.start - off + ss : clip.start + (ss - off) / speed;
      if (speed !== 1) ptsScale = speed;
    }
    const chain = [
      ptsScale === 1 ? `setpts=PTS+${f3(shift)}/TB` : `setpts=PTS/${f3(ptsScale)}+${f3(shift)}/TB`,
      `fps=${fps}:round=up`,
      `trim=start_pts=${a}:end_pts=${b + 1}`,
    ];
    // cover: scale proportionally to cover the box, then crop centered. Untagged video color space is
    // decoded as untagged (consistent with Chrome's assumption for HD assets)
    const matrix = !isImage && (!layer.colorSpace || layer.colorSpace === "unknown") ? `:in_color_matrix=${untagged}` : "";
    chain.push(`scale=${p.w}:${p.h}:force_original_aspect_ratio=increase${matrix}`, `crop=${p.w}:${p.h}`, "format=gbrap");
    if (isMissing) {
      const file = `${String(opts.sidecarDir || ".").replace(/\\/g, "/")}/missing-${k}.txt`;
      const name = String(layer.missingMaterialName || media.missingMaterial?.original?.name || media.name || media.id).replace(/[\r\n\u0000-\u001f]/g, " ")
        // The "(missing) " tag added to missing asset names in the media library does not appear on screen;
        // only the original name is displayed (consistent with missingMaterialLabel in
        // src/audio/missingMaterial.ts).
        // New names have the English tag "(missing) ", while old projects had the Chinese one; strip both.
        .replace(/^\((?:missing|缺失)\) (?=.)/, "");
      sidecars.push({ file, text: trText("Media not found: {0}", name) });
      const escapeFilterPath = (value) => String(value).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
      const quoted = escapeFilterPath(file);
      const font = escapeFilterPath(opts.fontFile);
      chain.push(`drawtext=textfile='${quoted}':fontfile='${font}':fontcolor=white:fontsize=${Math.max(16, Math.round(Math.min(p.w, p.h) / 16))}:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=0x20242b:boxborderw=18`);
    }
    /*
     * Filters (kernel/filters.mjs, same values as preview and see_frames): placed after the box,
     * before emphasis and opacity: in CSS, filter precedes opacity, and emphasis drop-shadow is written
     * in the same filter, positioned after filters.
     * Blur is computed from pixels after box scaling (in preview, blur is written inside the box,
     * scaling along with the box scale), consistent with emphasis multiplied by p.scale.
     */
    if (layer.filter) {
      const { def, params } = layer.filter;
      const d = clip.end - clip.start;
      if (isAnimated(def)) {
        // Per-frame parameter modification: sendcmd connects after trim, where timestamps are absolute time
        // on the timeline (frame i = i/fps)
        const tag = `fx${k}`;
        const frames = [];
        for (let i = a; i <= b; i++) frames.push({ ts: i / fps, t: i / fps - clip.start });
        const { script, blurPad } = sendcmdScript(def, params, d, frames, tag, p.scale, fps);
        const file = `${String(opts.sidecarDir || ".").replace(/\\/g, "/")}/filter-${k}.cmd`;
        sidecars.push({ file, text: script });
        // Colons in Windows paths are filter parameter separators: single quotes + \: escaped
        // (same syntax as passing paths to the subtitles filter).
        // Single quotes in paths prematurely close the quotes, causing the rest of the chain to be
        // treated as options for sendcmd (tested: "Option not found"):
        // close quotes, escape \', then reopen quotes. Spaces and Chinese characters need no handling in testing
        const quoted = file.replace(/:/g, "\\:").replace(/'/g, "'\\''");
        chain.push(`sendcmd=f='${quoted}'`, ffmpegChain(ffmpegStages(resolveOps(def, params, ta - clip.start, d), p.scale), tag, blurPad));
      } else {
        const fx = ffmpegStaticChain(resolveOps(def, params, 0, d), p.scale);
        if (fx) chain.push(fx);
      }
    }
    const lines = [];
    let cur = `m${k}`;
    lines.push(`[${k}:v]${chain.join(",")}[${cur}]`);
    // Emphasis: only visible for assets with alpha (see comment above emphasisOps for rationale)
    const ops = emphasisOps(clip.emphasis, p.scale, notes);
    if (ops.length) {
      if (layer.hasAlpha) {
        lines.push(...emphasisChain(cur, `m${k}e`, ops, p.w, p.h, k));
        cur = `m${k}e`;
      } else {
        notes.push(trText("Emphasis of clip {0} was not composited: the media is opaque and the shadow is entirely outside the frame and clipped, so it is also invisible in the preview", clip.id));
      }
    }
    const tail = [];
    const opacity = clip.opacity ?? 1;
    if (opacity < 1) tail.push(`colorchannelmixer=aa=${f3(Math.max(0, opacity))}`);
    const fin = clip.fadeIn ?? 0;
    const fout = clip.fadeOut ?? 0;
    if (fin > 0) tail.push(`fade=t=in:st=${f3(Math.max(0, clip.start))}:d=${f3(fin)}:alpha=1`);
    if (fout > 0) tail.push(`fade=t=out:st=${f3(Math.max(0, clip.end - fout))}:d=${f3(fout)}:alpha=1`);
    if (p.rotate !== 0) tail.push(`rotate=a=${f3(p.rotate)}:ow=${p.ow}:oh=${p.oh}:c=none:bilinear=1`);
    // Move back to segment start (see the "absolute time" section above)
    if (startFrame > 0) tail.push(`setpts=PTS-${f3(t0)}/TB`);
    if (tail.length) {
      lines.push(`[${cur}]${tail.join(",")}[m${k}t]`);
      cur = `m${k}t`;
    }
    const nb = `b${k}`;
    // eof_action=pass: after this segment finishes, main video continues as normal;
    // before it starts, overlay already passes main video through as-is
    lines.push(`[${base}][${cur}]overlay=x=${p.x}:y=${p.y}:eof_action=pass:format=gbrp[${nb}]`);
    graph.push(...lines);
    base = nb;
    used.push({ clipId: clip.id, input: k, frames: [a, b], x: p.x, y: p.y, w: p.w, h: p.h });
  }
  if (maskIn >= 0) {
    const sigma = Math.max(0, Number(opts.mask.blur) || 0);
    graph.push(
      `[${base}]split[gA][gB]`,
      `[gB]gblur=sigma=${f3(sigma)}[gBl]`,
      `[${maskIn}:v]format=rgba,alphaextract,format=gbrp[gM]`,
      `[gA][gBl][gM]maskedmerge[gOut]`,
    );
    base = "gOut";
  }
  // Card layer is stacked the previous way: converted to yuv420p then composited with overlay default
  // yuv420: areas with only cards and no assets are pixel-by-pixel identical to previous preview.mp4
  graph.push(`[${base}]format=yuv420p[base]`, `[1:v]format=rgba[cards]`, `[base][cards]overlay=eof_action=endall[out]`);
  const g = graph.join(";");
  // Lock frame count with -frames:v: cutting by seconds (-t) rounds duration to three decimals,
  // resulting in one frame too many or too few
  /*
   * If the filtergraph is too long, write it to a file and read via -/filter_complex (syntax since
   * ffmpeg 7; -filter_complex_script is already removed in 9): Windows command-line limit is 32767
   * characters, which a few asset clips each attaching a 33-point curve can easily approach.
   */
  const LONG_GRAPH = 12000;
  if (g.length > LONG_GRAPH) {
    const file = `${String(opts.sidecarDir || ".").replace(/\\/g, "/")}/filter-graph.txt`;
    sidecars.push({ file, text: g });
    args.push("-/filter_complex", file);
  } else args.push("-filter_complex", g);
  args.push("-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-frames:v", String(frames), out);
  return { args, graph: g, notes, used, sidecars };
}
