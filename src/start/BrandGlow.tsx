/*
 * Redo the background glow of the official website home page with the renderer.
 *
 * The background of the official website home page is two fixed radial glows on `body`; the original is in the VisuHive repo
 * `site/assets/home.css`:
 *
 *   background:
 *     radial-gradient(1200px 700px at 15% -10%, var(--glow-a), transparent 60%),
 *     radial-gradient(900px  600px at 100% 40%, var(--glow-b), transparent 60%),
 *     var(--bg);
 *   background-attachment: fixed;
 *
 * In dark mode `--glow-a` is rgba(0,219,219,.14), `--glow-b` is rgba(0,219,219,.08), and `--bg` is #111016,
 * that is, the `--ui-accent` and `--ui-bg` of this repo's "Streamlight" skin. Measured live on 2026-10-23: zero canvases on the home page,
 * the whole layer is this CSS, with no other dynamic background.
 *
 * **So why use the renderer?** Two reasons:
 *   1. A gradient over a large dark area bands in 8 bits, ring after ring clearly visible especially on phone OLEDs.
 *      Adding a little dither noise in the shader breaks up the steps, which a CSS gradient cannot do.
 *   2. The parameters are tunable: position, radius, density, color and drift are all uniforms; the user drags them on the tuning bench, and the numbers settled on are written back to
 *      LOOK below. Setting `drift` to 0 makes it identical to the official website, completely still.
 *
 * It is a separate matter from `BrandCanvas.tsx` (the flowing aurora on the left of the login page) and they do not affect each other: that one is already final on the desktop app.
 *
 * If WebGL2 cannot start, it falls back to a `div` covered with exactly the official website's CSS gradient; the fallback is identical to the original,
 * just without the dither.
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import "./brandGlow.css";
import { tr } from "../i18n/index.ts";

/**
 * Image parameters. The tuning bench (make-glow-lab.mjs in the scratchpad) reads the numbers here directly to make sliders;
 * once tuned, write the "current values" back as a whole block to sync.
 *
 * The positions `ax/ay/bx/by` are viewport fractions (0 = left/top, 1 = right/bottom, may be negative),
 * the radii `arx/ary/brx/bry` are CSS pixels: as on the official website they are fixed pixels and do not scale with the window.
 */
export const LOOK = {
  /**
   * Seconds per drift cycle. This option has no effect when `drift` is 0.
   *
   * This value is also the **length of the prerendered looping video**: phases of both light orbs
   * are integer harmonic multiples of uLoop; uLoop going from 0 to 1 returns exactly to the start,
   * so the first and last frames compute identically and the loop connects seamlessly.
   * 28 seconds × 24 frames = 672 frames, an exact integer, never off by half a frame.
   */
  loopSeconds: 28,
  /** How far each light orb drifts (CSS pixels). 0 = completely static, avoiding frame-by-frame redraws */
  drift: 110,

  /**
   * Reference viewport (CSS pixels): the two position sets below were tuned at **this size**.
   *
   * (user decision, 2026-10-23): "Align with the center of the fill-screen version." So the two light
   * orbs are not placed by current viewport ratio, which would make mobile and widescreen compositions
   * completely different, but converted to **fixed pixel offsets relative to screen center**:
   *
   *     center = viewport center + (position - 0.5) × reference viewport
   *
   * When the viewport is exactly the reference size, this formula reduces to "position × reference
   * viewport", identical to what was seen on the tuning console; smaller screens get a center crop of
   * the same composition, while larger screens expose an extra margin. The radius is inherently fixed
   * pixels and does not scale.
   *
   * 559×1290 was the actual size of the "fill widescreen" preview on the tuning console at the time.
   */
  refW: 559,
  refH: 1290,

  /** First orb (cool color, pressing in from top-left) */
  ax: 0.41,
  ay: -0.1,
  arx: 1900,
  ary: 1830,
  aAlpha: 0.225,
  aStop: 0.43,

  /** Second orb (warm color, pressing in from bottom-right) */
  bx: 1.08,
  by: 0.68,
  brx: 2400,
  bry: 1100,
  bAlpha: 0.025,
  bStop: 0.13,

  /** Dither: noise intensity to break up color banding (0.004 ≈ 1/255). Increasing grainSize turns dither into visible grain */
  grain: 0.008,
  grainSize: 2,

  /**
   * Color. Left empty, it follows the skin (base color `--ui-bg`, light `--ui-accent`); if filled,
   * uses the specified value.
   *
   * Base color and the cool orb are left empty: when switching skins or changing accent color in
   * settings, this layer follows. The warm orb is the orange chosen by the user (user decision, 2026-10-23)
   * and has nothing to do with skin, so it is hardcoded: the same pattern as `BrandCanvas.tsx`
   * where "cool side follows skin, warm side is hardcoded".
   */
  bg: "",
  colA: "",
  colB: "#FF7B00",

  /** Internal resolution = min(device pixel ratio, 2) × this number. Gradients are cheap; 1 gives 1:1 */
  resScale: 1,
};

/** Fallback when the skin cannot be read: `--ui-bg` #111016 and `--ui-accent` #00dbdb of Streamlight dark */
const BG_FALLBACK: [number, number, number] = [0.067, 0.063, 0.086];
const ACCENT_FALLBACK: [number, number, number] = [0, 0.859, 0.859];

export const VERT = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;

export const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2 uRes;      // internal pixels of the canvas
uniform float uPxScale; // internal pixels / CSS pixels
/* loop phase: 0→1 runs one full cycle and returns to the start */
uniform float uLoop;

uniform vec3 uBg;
uniform vec3 uColA;
uniform vec3 uColB;

uniform float uAx, uAy, uArx, uAry, uAAlpha, uAStop;
uniform float uBx, uBy, uBrx, uBry, uBAlpha, uBStop;
uniform float uGrain, uGrainSize, uDrift;
uniform float uRefW, uRefH;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/*
 * A CSS-style radial glow: radial-gradient(rx ry at cx cy, color density a0, transparent stop).
 * CSS gradients interpolate linearly in **premultiplied** space, so the hue stays constant and only alpha falls
 * in a straight line from a0 to 0, reaching nothing at stop (a ratio of the ellipse radius). This computes it the same way,
 * without smoothstep, otherwise it would not match the website.
 */
float glow(vec2 px, vec2 c, vec2 r, float stop, float a0) {
  float t = length((px - c) / max(r, vec2(1.0)));
  return a0 * clamp(1.0 - t / max(stop, 1e-4), 0.0, 1.0);
}

void main() {
  float s = max(uPxScale, 1e-4);
  vec2 cssPx = gl_FragCoord.xy / s;
  float wCss = uRes.x / s;
  float hCss = uRes.y / s;
  // gl_FragCoord counts y from the bottom up, CSS from the top down: flip it so the position parameters mean the same as the numbers on the website
  cssPx.y = hCss - cssPx.y;

  // The two blobs drift in opposite directions, offset a little so they read as two blobs; when drift = 0 this term is 0
  /*
   * The two blobs drift in opposite directions, offset a little so they read as two blobs; when drift = 0 this term is 0.
   *
   * The two frequencies are 4 and 3 (originally 1 and 0.75, same ratio of 0.75, but not integer multiples):
   * only integer multiples guarantee both terms return to the start together when uLoop completes a full cycle. Prerendering to video relies on this to close the loop.
   * Speed is unchanged: the seconds per cycle are set by LOOK.loopSeconds.
   */
  vec2 d = uDrift * vec2(sin(uLoop * 6.2831853 * 4.0), cos(uLoop * 6.2831853 * 3.0));

  /*
   * Aligned to the screen center: positions are not computed from the current viewport's proportions, but converted to fixed pixel offsets from the center
   * (see refW / refH in the component for the reference viewport). When the viewport is exactly the reference size the result equals "position × viewport";
   * on a smaller screen it is a center crop of the same composition.
   */
  vec2 mid = vec2(wCss, hCss) * 0.5;
  vec2 ref = vec2(max(uRefW, 1.0), max(uRefH, 1.0));

  float aA = glow(cssPx, mid + (vec2(uAx, uAy) - 0.5) * ref + d, vec2(uArx, uAry), uAStop, uAAlpha);
  float aB = glow(cssPx, mid + (vec2(uBx, uBy) - 0.5) * ref - d, vec2(uBrx, uBry), uBStop, uBAlpha);

  // Layer order matches the website: in CSS the layer written first is on top, so B goes onto the base color first, then A on top
  vec3 col = uBg;
  col = mix(col, uColB, aB);
  col = mix(col, uColA, aA);

  // Dithering: large gradients on dark colors show banding in 8 bits, so add a little noise to break up the steps
  float n = hash(floor(gl_FragCoord.xy / max(uGrainSize, 1.0)) + 0.5);
  col += (n - 0.5) * uGrain;

  fragColor = vec4(max(col, 0.0), 1.0);
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
    // If it does not compile, fall back to the CSS version; leave the reason in the console, otherwise we only see a base color and cannot investigate.
    // A common cause in development: editing this file triggers hot reload, which remounts the component repeatedly and creates a new WebGL context each time,
    // until the browser limit (about 16 in Chrome) is used up, after which every new context is broken, and then the log will be null.
    // A full page refresh fixes it; it is not a shader bug.
    console.warn(
      "[BrandGlow] shader compile failed:",
      gl.getShaderInfoLog(sh),
      "gl.getError=", gl.getError(),
      "(in development, if the log is null, the WebGL context limit was most likely exceeded by accumulated hot reloads; refresh the whole page)",
    );
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function BrandGlow(): JSX.Element {
  const host = useRef<HTMLCanvasElement>(null);
  /** If it cannot start, fall back to the official website's original CSS gradient */
  const [dead, setDead] = useState(false);

  useEffect(() => {
    const canvas = host.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", {
      // This layer is an opaque background (it also draws the base color), so no blending is needed
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      // Later we will capture this frame as a static image; without preserving, the pixels cannot be read
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
      console.warn("[BrandGlow] shader link failed:", gl.getProgramInfoLog(prog));
      setDead(true);
      return;
    }
    gl.useProgram(prog);

    const at = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = at("uRes");
    const uPxScale = at("uPxScale");
    const uLoop = at("uLoop");
    const uBg = at("uBg");
    const uColA = at("uColA");
    const uColB = at("uColB");

    // Geometry and density do not change per frame, setting them once is enough
    for (const [name, value] of [
      ["uAx", LOOK.ax], ["uAy", LOOK.ay], ["uArx", LOOK.arx], ["uAry", LOOK.ary],
      ["uAAlpha", LOOK.aAlpha], ["uAStop", LOOK.aStop],
      ["uBx", LOOK.bx], ["uBy", LOOK.by], ["uBrx", LOOK.brx], ["uBry", LOOK.bry],
      ["uBAlpha", LOOK.bAlpha], ["uBStop", LOOK.bStop],
      ["uGrain", LOOK.grain], ["uGrainSize", LOOK.grainSize], ["uDrift", LOOK.drift],
      ["uRefW", LOOK.refW], ["uRefH", LOOK.refH],
    ] as const) {
      gl.uniform1f(at(name), value);
    }

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    /** Without drift it is a still picture: drawing one frame is enough, no per-frame loop; the battery saved on phones is worth it */
    const animated = LOOK.drift > 0.0001 && !still;

    let raf = 0;
    let visible = true;
    let frames = 0;
    const started = performance.now();

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const s = Math.min(window.devicePixelRatio || 1, 2) * LOOK.resScale;
      const w = Math.max(2, Math.round(box.width * s));
      const h = Math.max(2, Math.round(box.height * s));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uPxScale, s);
    };

    const draw = () => {
      resize();
      // Changing skin or accent color must carry through. Re-reading every half second is enough; when not drawing per frame, read on every draw
      if (frames % 30 === 0) {
        gl.uniform3f(uBg, ...(LOOK.bg ? hexToRgb(LOOK.bg, BG_FALLBACK) : readColor("--ui-bg", BG_FALLBACK)));
        gl.uniform3f(uColA, ...(LOOK.colA ? hexToRgb(LOOK.colA, ACCENT_FALLBACK) : readColor("--ui-accent", ACCENT_FALLBACK)));
        gl.uniform3f(uColB, ...(LOOK.colB ? hexToRgb(LOOK.colB, ACCENT_FALLBACK) : readColor("--ui-accent", ACCENT_FALLBACK)));
      }
      // Take the fractional part: after a full circle it returns to 0, so the on-screen version also joins up seamlessly
      const secs = (performance.now() - started) / 1000;
      gl.uniform1f(uLoop, animated ? (secs / LOOK.loopSeconds) % 1 : 0);
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
      if (animated && raf === 0 && visible && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    draw(); // Draw one frame first: when there is no drift, this one frame is everything
    start();

    // Stop when switched to the background or scrolled out of view (with no drift there is no loop anyway; these two only act as a safeguard)
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) start();
      else stop();
    });
    io.observe(canvas);

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    // The window changed so we must redraw: with no drift there is no loop, so this alone supplies the frame
    const ro = new ResizeObserver(() => {
      draw();
      start();
    });
    ro.observe(canvas);

    // A GPU driver reset or switching between the discrete and integrated GPU loses the context; if lost,
    // fall back to the CSS version rather than leaving a black block
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

  // The fallback is the website's own CSS (see brandGlow.css), identical to the original, just without the jitter
  if (dead) return <div className="ps-brand-glow ps-brand-glow--css" aria-hidden="true" />;
  return <canvas ref={host} className="ps-brand-glow" data-pc="start-brand-glow" aria-hidden="true" />;
}
