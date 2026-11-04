/**
 * The base of the left block of the login page: a flowing gradient drawn by a WebGL shader (the user gave a reference poster, 2026-10-23).
 *
 * **To be clear first: this is not ray tracing.** The effect in the reference image is a "smoky gradient", done in the fragment shader by repeatedly
 * **domain warping** (domain warp) fractal noise and mapping it to color bands. Path tracing solves the interaction of light and geometry; this image has neither geometry nor light sources,
 * and using path tracing would be dozens of times slower and would not look like this. So this is a shader, not ray tracing.
 * If what you want is the kind with "volume and light falloff", I can add a volume-marching pass (single scattering), at the cost of frame rate.
 *
 * Colors: the cool side takes the software theme color `--ui-accent` (user decision, 2026-10-23: "replace the blue part with this software's theme color"),
 * the warm side is the amber from the reference image. Changing skin or accent color both carry through, since the variable is re-read every half second.
 *
 * Power saving: it stops when the page goes to the background or this block scrolls out of view; `prefers-reduced-motion` draws one frame without motion; the internal resolution is discounted by
 * the device pixel ratio (the image is blurry anyway, so enlarging it shows no difference). If WebGL2 cannot start or the context is lost, it falls back to
 * `BrandAurora` (the CSS version), so no black block is left.
 *
 * The set of numbers in LOOK was tried one by one on a tuning bench (`shader-lab.html` in the session scratchpad, the same shader with sliders),
 * not made up; to tune again, start that page and drag the sliders, then copy the numbers back.
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { BrandAurora } from "./BrandAurora";
import "./brandCanvas.css";
import { tr } from "../i18n/index.ts";

/** Image parameters. Each one corresponds to a uniform in the shader; change the numbers to change the pattern, no need to touch GLSL */
export const LOOK = {
  /**
   * Loop cycle duration in seconds. Prerendered video is this long; the longer it is, the harder it
   * is to notice the loop, at the cost of a slightly larger file. The real-time version also follows
   * the same period, so on-screen and prerendered show the exact same motion.
   */
  loopSeconds: 48,
  /**
   * Size of the circle in the noise domain (noise units). Before the change, it drifted forward
   * continuously at "0.025 units per second"; one 48-second cycle travels 1.2 units; circle circumference
   * must match it so motion stays as slow as before. The closed curve of fundamental plus second
   * harmonic has circumference ~2π·R·1.3, so R ≈ 1.2 / (2π·1.3) ≈ 0.15.
   */
  swirl: 0.15,
  /**
   * Noise scale: too large fragments it, too small leaves only a smooth gradient with no discernible
   * shape.
   */
  scale: 0.9,
  /**
   * Reference size of the texture (CSS pixels). Texture is anchored to screen pixels and does not scale
   * with this area: this value sets "how many pixels count as one unit"; changing it equals zooming in
   * or out overall; enlarging the window only reveals more.
   */
  refPx: 460,
  /**
   * Vertical flattening factor (<1 = texture is stretched vertically): the "curtain" in the
   * reference image relies on it.
   */
  yStretch: 0.9,
  /** Approximate horizontal position of the cool/warm boundary (0 left, 1 right) */
  split: 0.54,
  /**
   * Falloff exponent for cool and warm colors. When >1, both sides weaken in the middle → naturally
   * darkens and grays (that is where the dark patch in the reference image comes from); =1 is standard
   * interpolation, where the middle does not darken.
   */
  falloff: 1.5,
  /**
   * **Two-color blend range** (the knob requested by the user, 2026-10-23): width of transition zone.
   * 0 = hard edge, each side independent; 1 = entire block transitions, blended colors everywhere.
   */
  blend: 0.42,
  /**
   * How turbulently noise perturbs the cool/warm boundary. When large, orange reaches into the cyan side
   * and cyan ventures into orange, interlocking both colors: this is the other half of "blending"; merely
   * widening the transition zone only yields a flat gradient.
   */
  mixWarp: 0.8,
  /** Intensity of fine vertical stripes (the thin lines on the right half of the reference poster) */
  streak: 0.0,
  /** Striped frosted glass: number of stripes per screen */
  stripeN: 2.0,
  /** Stripe tilt (0 = straight vertical; slightly tilted following 104° from previous CSS version) */
  stripeSkew: 0.0,
  /** Frosted blur radius (distance in noise coordinates): larger values are blurrier */
  frostBlur: 0.68,
  /** Contrast between frosted stripes and clear stripes */
  frost: 1.0,
  /** Milky opacity (scattering) of frosted surface: the ground side of the glass is slightly brighter */
  milky: 0.25,
  /** Thin highlight at the boundary between clear and frosted stripes (ridge of the glass) */
  edge: 0.056,
  /** Grain intensity */
  grain: 0.125,
  /** Grain coarseness: pixels per cell (at internal resolution); larger cells mean coarser grain */
  grainSize: 1.0,
  /**
   * Grain refraction extent: frosted glass scatters light via surface bumps; this value is
   * "how chaotic the bumps are".
   */
  grainJitter: 0.0,
  /**
   * Grain softening. 0 = interpolation only (no longer pixelated); increasing it adds a 5-point average,
   * equivalent to a very light Gaussian blur, making grain softer and smoother.
   */
  grainSoft: 0.5,
  /** Displacement distance for each of the two domain warps */
  warpA: 4.0,
  warpB: 4.2,
  /** Brightness curve: higher exponents suppress shadows more aggressively */
  gamma: 3.35,
  /** How much highlights are boosted */
  gain: 4.0,
  /** Floor value for darkest shadows (not 0, pure black lacks depth) */
  floor: 0.1,
  /** Highlight roll-off: larger values suppress earlier to prevent blowing out into neon */
  roll: 0.8,
  /** Saturation: 1 is unchanged, greater than 1 is more vivid */
  sat: 1.38,
  /** Internal resolution scale: 0.6 means rendering at 60% of CSS dimensions then scaling up */
  resScale: 0.6,
  /**
   * Cool side color. Empty string = follows software theme color `--ui-accent` (changes when switching
   * skins); to pin it down, enter hex, e.g. "#00DBDB".
   */
  cool: "",
  /** Warm side color (amber in the reference image) */
  warm: "#E2731F",
  /** Fallback when theme color cannot be read */
  coolFallback: [0.0, 0.859, 0.859] as [number, number, number],
  /**
   * Color separation direction: 0 = horizontal (cool left, warm right), 1 = vertical (cool top, warm
   * bottom). Setting it to 1 gives the user's request (2026-10-23): "yellow enters from bottom,
   * blue enters from top".
   */
  axis: 0.0,
  /**
   * **Background enters as alpha** (user decision, 2026-10-23): dark areas keep the canvas transparent,
   * letting the page's own background color show through rather than painting a fake background in
   * the shader: switching skins or changing background colors never touches this, always revealing
   * the true background. 0 = opaque (same as before), 1 = fully transparent in dark areas.
   */
  seeThrough: 0.55,
  /**
   * Width of fade-out to transparent along the right edge (0 = no fade), used with the above to
   * create a layout where "the right side is background color".
   */
  fadeEdge: 0.6,
};

/**
 * The vertex and fragment shaders and the set of image parameters are all **exported**: when prerendering the loop animation of the login page's left rail,
 * the script that generates the user card source takes them as is (`scripts/login-art/make-card.mjs`),
 * so the on-screen version and the prerendered version draw the same GLSL and do not drift apart.
 */
export const VERT = `#version 300 es
void main() {
  // A triangle covering the whole screen: no vertex buffer, coordinates are computed from the vertex ID
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
/* Radius of the circle in the noise domain (noise units). 0 = no motion at all */
uniform float uSwirl;
/* Loop phase, 0→1 is one full turn. A full turn lands exactly on the start, so frame 0 and frame N are byte-identical */
uniform float uLoop;
uniform vec3  uCool;
uniform vec3  uWarm;
uniform float uScale, uYStretch, uSplit, uFalloff, uBlend, uMixWarp, uStreak, uGrain;
uniform float uAxis, uSeeThrough, uFadeEdge;
uniform float uRefPx, uPxScale;
/* Flatten: set to 1 when prerendering to video. Video cannot carry alpha, so the background color is composited in first and the output is opaque; the on-screen version sets 0 and still outputs premultiplied semi-transparent color */
uniform float uFlatten;
/* Color laid underneath when flattening (--bg-canvas of the login page) */
uniform vec3  uBg;
uniform float uWarpA, uWarpB, uGamma, uGain, uFloor, uRoll, uSat;
uniform float uStripeN, uStripeSkew, uFrostBlur, uFrost, uMilky, uEdge;
uniform float uGrainSize, uGrainJitter, uGrainSoft;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/**
 * Noise for the grain: **interpolated**, not floor-ed squares.
 *
 * With floor + hash each cell is a constant and jumps at the borders, which looks like a mosaic (pointed out by the user, 2026-10-23).
 * In vnoise the four corner hashes are interpolated with smoothstep, so cells blend into one continuous surface.
 * When uGrainSoft > 0, a 5-point average (up, down, left, right plus center) is applied once more,
 * which acts like a very light Gaussian and softens the grain further;
 * at 0 only the interpolation layer remains.
 */
float grainNoise(vec2 c, float soft) {
  float n = vnoise(c);
  if (soft > 0.001) {
    float d = soft * 0.5;
    n = (n + vnoise(c + vec2(d, 0.0)) + vnoise(c - vec2(d, 0.0))
           + vnoise(c + vec2(0.0, d)) + vnoise(c - vec2(0.0, d))) * 0.2;
  }
  return n;
}

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;

  /*
   * The texture is anchored to **screen pixels** and does not scale with the size of this block (user decision, 2026-10-23):
   * widening or heightening the window only "reveals more"; it does not stretch the same picture.
   *
   * The origin is the split line (the skeleton of the composition) and the vertical midline, so however wide this block is,
   * the texture near the cool/warm boundary always looks the same, and changes only happen at the two ends.
   *
   * First convert gl_FragCoord back to CSS pixels (internal rendering is scaled down by uPxScale), so the texture
   * thickness is the same on high-DPI and regular screens; uRefPx is the reference size, and changing it scales the whole thing up or down.
   */
  vec2 cssPx = gl_FragCoord.xy / max(0.0001, uPxScale);
  vec2 anchor = vec2(uSplit * uRes.x, 0.5 * uRes.y) / max(0.0001, uPxScale);
  vec2 p = (cssPx - anchor) / max(1.0, uRefPx) * uScale;
  p.y *= uYStretch;
  /*
   * Time **walks a closed loop** in the noise domain; it does not drift forward forever.
   *
   * Why it changed (2026-10-24, user decision: "the left side is the renderer's prerendered animation"): the prerender produces a finite-length video
   * that must loop seamlessly. The old four terms were all forward-only translations like p + t * k, which do not close on the timeline,
   * so cutting a segment to loop would jump at the seam. Now each term's offset is a periodic function of uLoop,
   * and uLoop going from 0 to 1 returns exactly to the starting point: frame 0 and frame N are computed byte-identical, and the seam is invisible.
   *
   * The path is not a perfect circle but loops within loops (fundamental + second harmonic): a perfect circle looks like spinning in place and the loop is obvious at a glance;
   * with a second harmonic added, the trajectory is a curled closed curve that travels farther and looks less like circling, while the period is still 1.
   * The four terms each get a different phase and direction so the four layers do not move together.
   * Each term subtracts its value at loopAng = 0, so the frame at uLoop = 0 is exactly the same as before this change: the numbers from the tuning bench still work.
   * (The variable is called loopAng, not a: this shader already has two a's, one of the four corners in the noise at line 166 and the opacity at line 323. Naming it a gives ERROR: a : redefinition, the whole shader fails to compile, and it falls back to the CSS version on the spot.)
   */
  float loopAng = 6.2831853 * uLoop;
  #define LOOPV(ph, dir, amp) (uSwirl * (amp) * (       vec2(sin(loopAng * (dir) + (ph)) - sin(ph), cos(loopAng * (dir) + (ph)) - cos(ph))     + vec2(sin(loopAng * 2.0 * (dir) + (ph)) - sin(ph), cos(loopAng * 2.0 * (dir) + (ph)) - cos(ph)) * 0.45))

  // Two domain warps: the first pushes the coordinates apart, the second pushes the result of the first again.
  // This is how the "stirred" layering in the reference image comes about; a single noise layer cannot produce it
  vec2 q = vec2(fbm(p + LOOPV(0.0, 1.0, 1.0)), fbm(p + vec2(5.2, 1.3) + LOOPV(2.1, -1.0, 0.7)));
  vec2 r = vec2(fbm(p + uWarpA * q + vec2(1.7, 9.2) + LOOPV(4.0, 1.0, 0.5)),
                fbm(p + uWarpA * q + vec2(8.3, 2.8) + LOOPV(5.6, -1.0, 0.4)));
  // Striped frosted glass: within each diagonal stripe the texture underneath is "ground down": one less layer of detail and pushed sideways a bit,
  // as if seen through frosted glass; between stripes it is clear. This is the shader equivalent of the previous version's backdrop-filter striped frost
  // (what the user asked for by name was the three things "flowing aurora + striped frosted glass + grain", so we cannot keep just two of them)
  // The stripe profile uses sin, not fract: fract jumps back to 0 at the end, breaking at every stripe seam and looking like window blinds
  float phase = (uv.x * uStripeN + uv.y * uStripeSkew) * 6.2831853;
  float frost = smoothstep(-0.85, 0.85, sin(phase));
  vec2 pw = p + uWarpB * r;

  /*
   * Frosted stripes: **smear the pixels behind sideways** (average four horizontal neighbor samples), which is exactly what glass does.
   *
   * The previous two versions both got it wrong: one blended in noise at another scale (that is ghosting), the other pulled out the detail layer (that is downsampling).
   * The base image at scale≈0.9 is already smooth with little detail to pull out, so after pulling it out only flat slabs remain, which looks like window blinds.
   * The radius of a clear stripe is 0, so the four samples land on the same point and the result equals the original image; stripes are therefore continuous with no seams.
   */
  /*
   * Grain: **does not change over time**. Glass is a motionless thing, so of course the grain on its surface does not move either ---
   * the old version recomputed it every frame (time was in the hash), which looked like the whole screen flickering (pointed out by the user, 2026-10-23).
   * Coarse grain works by quantizing screen coordinates by uGrainSize: one random number per cell, and the larger the cell the coarser the grain.
   */
  // Grain is also computed in CSS pixels, otherwise it would get finer on high-DPI screens
  vec2 gco = cssPx / max(1.0, uGrainSize);
  float gn1 = grainNoise(gco, uGrainSoft);
  float gn2 = grainNoise(gco + 71.3, uGrainSoft);

  float br = frost * uFrost * uFrostBlur;
  /*
   * Frost "perturbation": each grain samples with an extra offset in its own random direction. Frosted glass scatters light
   * through tiny bumps on its surface, so the grain has to **take part in the refraction**, rather than being sprinkled over the picture afterwards.
   * The offset is multiplied by br: on clear stripes br=0, the grain has no effect, and clear areas stay clear.
   */
  vec2 jit = vec2(gn1 - 0.5, gn2 - 0.5) * br * uGrainJitter;
  float f = (fbm(pw + jit + vec2(-1.5 * br, 0.0)) + fbm(pw + jit + vec2(-0.5 * br, 0.0))
           + fbm(pw + jit + vec2(0.5 * br, 0.0)) + fbm(pw + jit + vec2(1.5 * br, 0.0))) * 0.25;

  // The cool/warm boundary is roughly a vertical line, and noise only nudges it lightly: push too much and the two sides bite into each other.
  // The reference image is "cool on the left, warm on the right, a dark band in the middle", not mixed together
  // Direction of the color split: uAxis=0 splits horizontally (cool left, warm right), =1 splits vertically (cool top, warm bottom).
  // When splitting vertically use 1-uv.y so that "top" is the cool color
  float axisC = mix(uv.x, 1.0 - uv.y, clamp(uAxis, 0.0, 1.0));
  // The boundary is pushed around by noise: the larger uMixWarp, the deeper the two colors bite into each other
  float split = uSplit + (r.x - 0.5) * uMixWarp;
  // Half-width of the transition band: uBlend opens from "a hard edge" all the way to "the whole block is transition"
  float halfW = mix(0.02, 0.85, clamp(uBlend, 0.0, 1.0));
  float m = smoothstep(split - halfW, split + halfW, axisC);

  // The dark region in the middle is **not painted on**: each light falls off outward from its own side, and in the middle neither is strong,
  // so the sum is dark and desaturated. This is how blue and orange mix into a dark color in the reference image (pointed out by the user, 2026-10-23).
  // The larger uFalloff, the harder the middle drops; at 1 it degrades to plain interpolation and the middle does not darken
  float wc = pow(clamp(1.0 - m, 0.0, 1.0), uFalloff);
  float ww = pow(clamp(m, 0.0, 1.0), uFalloff);
  vec3 base = uCool * wc + uWarm * ww;

  // Light and dark: the dark parts are pushed down hard, so most places are close to black and color lights up only in a few spots. This is the weight of the reference image
  float lum = pow(clamp(f * 1.18, 0.0, 1.0), uGamma);
  vec3 col = base * (uFloor + uGain * lum);
  // Highlight roll-off: bright parts obtained by direct multiplication would blow out into neon, and this step pushes them back down
  col = col / (1.0 + col * uRoll);
  // Fine-tune saturation
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uSat);

  // Two things about glass: the frosted face itself is milky (scattering lifts the brightness a little), and where clear stripes meet frosted stripes there is a thin highlight (the glass edge)
  col *= 1.0 + frost * uMilky;
  float edge = 1.0 - abs(frost * 2.0 - 1.0);
  col += pow(edge, 3.0) * uEdge;

  // Fine vertical stripes: one fixed random number per column, more visible toward the right (the fine lines on the right half of the reference poster)
  float band = hash12(vec2(floor(uv.x * 240.0), 7.0));
  col *= 1.0 + (band - 0.5) * uStreak * smoothstep(0.18, 0.9, uv.x);

  // Vignette
  vec2 d = (uv - 0.5) * vec2(1.08, 1.0);
  col *= 0.30 + 0.70 * smoothstep(1.15, 0.18, length(d));

  // The overlaid grain layer is likewise motionless, and more visible on frosted stripes: it is part of the glass, not film grain laid over the picture
  col += (gn1 - 0.5) * uGrain * (0.3 + 0.7 * frost);

  /*
   * The background comes in as alpha (user decision, 2026-10-23): dark areas leave the canvas transparent, letting the page's real background color show through,
   * instead of painting a fake background color here. The benefit is that changing skins or the background color never requires touching the shader: what shows through is always the real one.
   * Bright areas are opaque, so colors that should be rich stay rich.
   */
  // uSeeThrough acts as a threshold: luminance below it is fully see-through, above it fully opaque.
  // It used to be written as interpolation, and the darkest spots kept an opacity of (1-uSeeThrough), so dark areas were "a layer laid over the background" rather than the background itself
  float a = uSeeThrough < 0.001 ? 1.0 : smoothstep(0.0, uSeeThrough, lum);
  // Then fade out along the right edge (basically has no effect when uFadeEdge=0): works with the line above to make the "right side is the background color" layout
  if (uFadeEdge > 0.001) a *= 1.0 - smoothstep(1.0 - uFadeEdge, 1.0, uv.x);

  // Premultiplied output: color is multiplied by alpha first (the context is opened in premultiplied mode).
  // Straight alpha gets drawn as opaque on the GPU compositing path (the bug the user reported on 2026-10-24)
  float aOut = clamp(a, 0.0, 1.0);
  vec3 rgbOut = max(col, 0.0);
  // The flatten path: composite the background color in and set alpha to 1. Prerendering to video must take this path: video cannot carry alpha,
  // and the export writes straight-alpha PNGs, so storing premultiplied values directly as straight would leave a ring of red-green fringes on the fade-out edge.
  fragColor = uFlatten > 0.5
    ? vec4(mix(uBg, rgbOut, aOut), 1.0)
    : vec4(rgbOut * aOut, aOut);
}`;

/** Hex → RGB in 0..1 */
function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Resolve a CSS variable into RGB in 0..1. If it cannot be read, use the fallback: the variable may be color-mix(), so let the browser compute it itself */
function readColor(name: string, fallback: [number, number, number]): [number, number, number] {
  try {
    const probe = document.createElement("span");
    probe.style.cssText = `color: var(${name}); position: absolute; opacity: 0; pointer-events: none;`;
    document.body.appendChild(probe);
    const got = getComputedStyle(probe).color;
    probe.remove();
    const m = /rgba?\(([^)]+)\)/.exec(got);
    if (!m) return fallback;
    const parts = m[1].split(/[,\s/]+/).map(Number).filter((n) => Number.isFinite(n));
    if (parts.length < 3) return fallback;
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
  } catch {
    return fallback;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // If it does not compile, fall back to the CSS version; leave the reason in the console, otherwise we only see a fallback background and cannot investigate.
    // A common cause in development: editing this file triggers hot reload, which remounts the component repeatedly and creates a new WebGL context each time,
    // until the browser limit (about 16 in Chrome) is used up, after which every new context is broken, and then the log will be null.
    // A full page refresh fixes it; it is not a shader bug.
    console.warn(
      "[BrandCanvas] shader compile failed:",
      gl.getShaderInfoLog(sh),
      "gl.getError=", gl.getError(),
      "(in development, if the log is null, the WebGL context limit was most likely exceeded by accumulated hot reloads; refresh the whole page)",
    );
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function BrandCanvas(): JSX.Element {
  const host = useRef<HTMLCanvasElement>(null);
  /** If it cannot start, fall back to the CSS version */
  const [dead, setDead] = useState(false);

  useEffect(() => {
    const canvas = host.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", {
      // The page background must show through, so the canvas must have alpha.
      // **Use premultiplied alpha (the default path)**: on 2026-10-24 the user reported "alpha of the login screen background fails to display",
      // verified with a system screenshot: on screen this block was a **fully opaque** cyan-orange gradient, while the one captured via CDP readback was the normal semi-transparent smoke.
      // The two paths differ: readback goes through the CPU and computes straight alpha correctly; the screen goes through GPU compositing, and `premultipliedAlpha: false`
      // is not handled correctly on this path, so RGB was drawn at full strength. Premultiplied is the browser default and the path every compositor handles reliably,
      // at the cost of only having to multiply the color by alpha in the shader yourself (see the end of the fragment shader).
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      // Later we will capture this frame and bake it into a static image; without preserving, the pixels cannot be read
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      setDead(true);
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) {
      setDead(true);
      return;
    }
    const prog = gl.createProgram();
    if (!prog) {
      setDead(true);
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[BrandCanvas] shader link failed:", gl.getProgramInfoLog(prog));
      setDead(true);
      return;
    }
    gl.useProgram(prog);

    const at = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = at("uRes");
    const uLoop = at("uLoop");
    const uCool = at("uCool");
    const uPxScale = at("uPxScale");

    // The one-time ones: the image parameters do not change per frame, setting them once is enough
    gl.uniform3f(at("uWarm"), ...hexToRgb(LOOK.warm, [0.886, 0.451, 0.122]));
    gl.uniform1f(at("uFlatten"), 0);   // This on-screen version must be semi-transparent, so do not flatten
    gl.uniform3f(at("uBg"), 0, 0, 0);  // Not used when not flattening; pass a value so the driver does not complain
    gl.uniform1f(at("uSwirl"), LOOK.swirl);
    gl.uniform1f(at("uScale"), LOOK.scale);
    gl.uniform1f(at("uYStretch"), LOOK.yStretch);
    gl.uniform1f(at("uSplit"), LOOK.split);
    gl.uniform1f(at("uFalloff"), LOOK.falloff);
    gl.uniform1f(at("uBlend"), LOOK.blend);
    gl.uniform1f(at("uMixWarp"), LOOK.mixWarp);
    gl.uniform1f(at("uAxis"), LOOK.axis);
    gl.uniform1f(at("uSeeThrough"), LOOK.seeThrough);
    gl.uniform1f(at("uFadeEdge"), LOOK.fadeEdge);
    gl.uniform1f(at("uRefPx"), LOOK.refPx);
    gl.uniform1f(at("uStreak"), LOOK.streak);
    gl.uniform1f(at("uGrain"), LOOK.grain);
    gl.uniform1f(at("uWarpA"), LOOK.warpA);
    gl.uniform1f(at("uWarpB"), LOOK.warpB);
    gl.uniform1f(at("uGamma"), LOOK.gamma);
    gl.uniform1f(at("uGain"), LOOK.gain);
    gl.uniform1f(at("uFloor"), LOOK.floor);
    gl.uniform1f(at("uRoll"), LOOK.roll);
    gl.uniform1f(at("uSat"), LOOK.sat);
    gl.uniform1f(at("uStripeN"), LOOK.stripeN);
    gl.uniform1f(at("uStripeSkew"), LOOK.stripeSkew);
    gl.uniform1f(at("uFrostBlur"), LOOK.frostBlur);
    gl.uniform1f(at("uFrost"), LOOK.frost);
    gl.uniform1f(at("uMilky"), LOOK.milky);
    gl.uniform1f(at("uEdge"), LOOK.edge);
    gl.uniform1f(at("uGrainSize"), LOOK.grainSize);
    gl.uniform1f(at("uGrainJitter"), LOOK.grainJitter);
    gl.uniform1f(at("uGrainSoft"), LOOK.grainSoft);

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let raf = 0;
    let visible = true;
    let frames = 0;
    const started = performance.now();

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const s = Math.min(window.devicePixelRatio || 1, 1.5) * LOOK.resScale;
      const w = Math.max(2, Math.round(box.width * s));
      const h = Math.max(2, Math.round(box.height * s));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
      // Internal pixels / CSS pixels: the shader uses it to convert coordinates back to CSS pixels, so texture and grain do not get finer on high-DPI screens
      gl.uniform1f(uPxScale, s);
    };

    const draw = () => {
      resize();
      // Changing skin or accent color must carry through. Re-reading every half second is enough, no need to read every frame
      // Cool side: use LOOK.cool if filled in, otherwise follow the theme color (re-read every half second, so a skin change shows up)
      if (frames % 30 === 0) {
        gl.uniform3f(uCool, ...(LOOK.cool ? hexToRgb(LOOK.cool, LOOK.coolFallback) : readColor("--ui-accent", LOOK.coolFallback)));
      }
      // Take the fractional part of the phase: after a full circle it returns to 0, so the on-screen version also joins up seamlessly
      const secs = (performance.now() - started) / 1000;
      gl.uniform1f(uLoop, still ? 0 : (secs / LOOK.loopSeconds) % 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frames++;
    };

    const loop = () => {
      if (!visible || document.hidden) {
        raf = 0;
        return;
      }
      draw();
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (raf === 0 && visible && !document.hidden && !still) raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    draw(); // Draw one frame first: if it is not yet in view, or animation is off, there is at least an image
    if (!still) start();

    // Stop when scrolled out of view or switched to the background: the login page in a background tab should not keep holding the GPU
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) start();
      else stop();
    });
    io.observe(canvas);

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    const ro = new ResizeObserver(() => {
      draw();
      start();
    });
    ro.observe(canvas);

    // A graphics driver reset or switching between discrete and integrated GPU both lose the context; if lost, fall back to the CSS version, do not leave a black block
    const onLost = (e: Event) => {
      e.preventDefault();
      stop();
      setDead(true);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  if (dead) return <BrandAurora />;
  return <canvas ref={host} className="ps-brand-canvas" data-pc="start-brand-canvas" aria-hidden="true" />;
}

/*
 * Bake into a version that needs no real-time rendering (to be done once the user says it has been reviewed).
 *
 * **Bake only the color-independent layer**, and let `--ui-accent` tint the color at runtime. This point is firm:
 * when the user changes skin or changes the accent color in settings, this block must follow (`src/skins/`, ten skins × light and dark). A fully baked-in image
 * no longer matches after a skin change. Approach:
 *   1. Change the shader to output only **luminance and structure** (f, frost, band and the vignette terms combined into one single channel), without multiplying by color;
 *   2. Render one frame (or one loop) at the target size and save it as single-channel WebP / AVIF, or as H.264 / VP9 grayscale video;
 *   3. On the page, use it as a mask: a layer covered with an `--ui-accent` → amber gradient, with `mask-image` (or `-webkit-mask`)
 *      applying this grayscale image. A skin change only changes the gradient layer; the mask does not need rebaking.
 *
 * The loop must be seamless: time currently only moves forward, so **it cannot simply be joined end to end**. To loop, turn the time dimension into rotation on a circle
 * (take `cos/sin` as the two channels of the noise time parameter), or crossfade two segments.
 *
 * If we really want to "bake everything in, color included" (for instance if we want exactly the reference poster's specific palette, not following the skin), that is a separate decision
 * and the user must be asked first; the cost is that this block no longer follows skin changes.
 */
