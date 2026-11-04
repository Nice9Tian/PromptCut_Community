/**
 * Shared WebGL renderer for canvas cards: the drawing half (R9 M2 / M3).
 *
 * **The same code runs in two places**: in the GL Worker (`glWorker.ts`, the primary path for both
 * routes) and on the stage main thread (`glHost.ts` capability fallback: when `webgl2` on
 * `OffscreenCanvas` is unavailable in the Worker). Both import the same `programs.ts`, so they
 * render the exact same code. This does **not touch the DOM** (`OffscreenCanvas` exists in both
 * places).
 *
 * # Unified drawing approach (same for both routes)
 *
 * Context attributes `{ alpha: true, antialias: false, premultipliedAlpha: true }`; each atlas is
 * drawn to a **multisample FBO** (`renderbufferStorageMultisample`, `samples = min(4, MAX_SAMPLES)`),
 * resolved via `blitFramebuffer` to the default framebuffer without anti-aliasing (that
 * `OffscreenCanvas`), and then cropped to bitmaps by region via `createImageBitmap`.
 * **Cannot directly enable `antialias: true`**: WebGL2 does not allow blitting to a multisampled
 * draw buffer.
 *
 * The `three` branch renderer is created **once** with the shared context; that atlas FBO is passed
 * to it via `setRenderTargetFramebuffer`, with the render target marked as `isXRRenderTarget` and
 * textures marked as sRGB: three treats such targets as "draw to screen" (output color space and
 * tone mapping are identical to drawing directly to canvas), otherwise drawing into a render target
 * stays in linear space and appears darker overall.
 *
 * # One atlas per `stageId`
 *
 * Under Route 2, the two stages share this single context: each `stageId` has its own "active card
 * set + atlas region", while program cache and texture cache are shared (so textures exist only
 * once). `release({ stageId })` clears only that portion.
 */

import * as THREE from "three";
import type {
  CanvasCardProgram, GlBeatCard, GlFromWorker, GlLayoutCard, GlProgram, GlWorkerDiag, ThreeBuilt, TwoDProgram,
} from "./CanvasCardProgram";
import { ATLAS_MAX, ATLAS_MAX_COMPACT, layoutKeyOf, packAtlas } from "./atlasPack.mjs";

type DoneMsg = Extract<GlFromWorker, { type: "done" }>;
type RegionsMsg = Extract<GlFromWorker, { type: "regions" }>;
type BeatMsg = { stageId: string; seq: number; t: number; cards: GlBeatCard[]; strict?: boolean; measure?: boolean; debugSleepMs?: number };

interface Page {
  w: number;
  h: number;
  fbo: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depth: WebGLRenderbuffer;
  /** Render target used when three draws into this page (lazily created) */
  rt: THREE.WebGLRenderTarget | null;
}

interface Region { page: number; x: number; y: number; w: number; h: number }

interface CardState {
  clipId: string;
  programId: string;
  kind: GlLayoutCard["kind"];
  w: number;
  h: number;
  textures: GlLayoutCard["textures"];
  stage: GlLayoutCard["stage"];
  params: Record<string, unknown>;
  /** Identity of parameters + dimensions + textures; rebuilds three's scene when changed */
  buildKey: string;
  program: CanvasCardProgram | undefined;
  /** three: built scene; leave this card blank for this tick before `ready` (compilation / textures) */
  built: ThreeBuilt | null;
  /** Preparing (compilation, texture decoding); strict ticks wait for it */
  preparing: Promise<void> | null;
  ready: boolean;
  error: string | null;
  /** 2d: its own canvas */
  canvas2d: OffscreenCanvas | null;
  /** Referenced texture URLs (tracks references for texture cache) */
  refs: string[];
}

interface StageState {
  pages: Page[];
  regions: Map<string, Region>;
  cards: Map<string, CardState>;
  layoutKey: string;
}

interface GlProg {
  program: WebGLProgram;
  done: boolean;
  error: string | null;
  uniforms: Map<string, WebGLUniformLocation | null>;
  aPos: number;
  /** VAO for `quad` geometry (attribute locations differ by program, so one per program) */
  vao: WebGLVertexArrayObject | null;
}

export interface GlRenderer {
  readonly ok: boolean;
  readonly error: string | null;
  readonly renderer: string;
  readonly samples: number;
  layout(stageId: string, cards: GlLayoutCard[]): RegionsMsg;
  beat(msg: BeatMsg): Promise<{ msg: DoneMsg; transfer: Transferable[] }>;
  release(stageId: string): void;
  diag(): GlWorkerDiag;
}

/*
 * When the main-thread fallback runs in the stage page, `setTimeout` is replaced by the stage
 * clock with a virtual timer (does not fire when paused): waiting for compilation and Worker
 * sleep both require the real one. In the Worker there is no such thing; `setTimeout` is real.
 */
const onMainThread = typeof window !== "undefined";
const realTimeout: (cb: () => void, ms: number) => unknown =
  (onMainThread && (window as unknown as { __pcRealSetTimeout?: (cb: () => void, ms: number) => number }).__pcRealSetTimeout) || setTimeout;
const sleep = (ms: number) => new Promise<void>((r) => realTimeout(r, ms));

/** Two orientations for bitmap decoding: GL textures need bottom-to-top (`flipY`), 2D `drawImage` as-is */
type Orientation = "flipY" | "none";

export function createGlRenderer(opts: {
  /** Only one stage: allocate atlas using the smaller upper limit (`ATLAS_MAX_COMPACT`) */
  compact: boolean;
  programOf: (id: string) => CanvasCardProgram | undefined;
  /** Main-thread fallback provides a canvas itself in environments without `OffscreenCanvas` */
  canvas?: OffscreenCanvas | HTMLCanvasElement;
}): GlRenderer {
  const maxAtlas = opts.compact ? ATLAS_MAX_COMPACT : ATLAS_MAX;
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  let gl: WebGL2RenderingContext | null = null;
  let error: string | null = null;
  try {
    canvas = opts.canvas ?? new OffscreenCanvas(1, 1);
    gl = canvas.getContext("webgl2", {
      alpha: true, antialias: false, premultipliedAlpha: true,
      depth: false, stencil: false, preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) error = "Could not get a webgl2 context";
  } catch (e) {
    canvas = null as unknown as OffscreenCanvas;
    error = e instanceof Error ? e.message : String(e);
  }
  let contextLost = 0;
  if (gl) {
    (canvas as unknown as EventTarget).addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      contextLost++;
    });
  }
  const samples = gl ? Math.max(0, Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number)) : 0;
  const rendererName = gl ? String(gl.getParameter(gl.RENDERER)) : "";
  const parallel = gl?.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;

  /* ---------------------------------------------------------------- Cache (shared across stageIds) */

  const stages = new Map<string, StageState>();
  /** GLSL source hash → compiled program (shared across multiple clips of the same card) */
  const glPrograms = new Map<string, GlProg>();
  /** URL + orientation → decoded bitmap (`mediaId + tier` already resolved into URL by main thread) */
  const bitmaps = new Map<string, Promise<ImageBitmap>>();
  const bitmapDone = new Map<string, ImageBitmap>();
  /** gl branch: URL → texture */
  const glTextures = new Map<string, WebGLTexture>();
  /** three branch: URL → same `THREE.Texture` instance (shared by cards under same renderer, uploaded once) */
  const threeTextures = new Map<string, THREE.Texture>();
  /** How many cards reference the texture URL (total across stageIds); delete when reaching zero */
  const texRefs = new Map<string, number>();
  let uploads = 0;
  let three: THREE.WebGLRenderer | null = null;
  let quadBuffer: WebGLBuffer | null = null;

  const ensureThree = (): THREE.WebGLRenderer => {
    if (three) return three;
    three = new THREE.WebGLRenderer({ canvas: canvas as OffscreenCanvas, context: gl! });
    three.setPixelRatio(1);
    three.autoClear = false;
    three.setClearColor(0x000000, 0);
    return three;
  };

  /* ---------------------------------------------------------------- Textures */

  const bitmapOf = (url: string, orientation: Orientation): Promise<ImageBitmap> => {
    const key = `${orientation}|${url}`;
    let p = bitmaps.get(key);
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`Texture ${r.status}: ${url}`);
          return r.blob();
        })
        .then((blob) => createImageBitmap(blob, { imageOrientation: orientation === "flipY" ? "flipY" : "from-image", premultiplyAlpha: "none" }))
        .then((bm) => { bitmapDone.set(key, bm); return bm; });
      // Do not cache on failure: retry next time
      p.catch(() => bitmaps.delete(key));
      bitmaps.set(key, p);
    }
    return p;
  };

  const threeTextureOf = async (url: string): Promise<THREE.Texture> => {
    const hit = threeTextures.get(url);
    if (hit) return hit;
    const bm = await bitmapOf(url, "flipY");
    const again = threeTextures.get(url);
    if (again) return again;
    const tex = new THREE.Texture(bm as unknown as HTMLImageElement);
    // Already flipped during bitmap decoding: three ignores flipY for ImageBitmap
    tex.flipY = false;
    // Consistent with original TextureLoader path: mark color space as sRGB, otherwise darker overall
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    threeTextures.set(url, tex);
    uploads++;
    return tex;
  };

  const glTextureOf = async (url: string): Promise<WebGLTexture> => {
    const hit = glTextures.get(url);
    if (hit) return hit;
    const bm = await bitmapOf(url, "flipY");
    const again = glTextures.get(url);
    if (again) return again;
    const g = gl!;
    const tex = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D, tex);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, bm);
    glTextures.set(url, tex);
    uploads++;
    three?.resetState();
    return tex;
  };

  const addRefs = (urls: string[]) => { for (const u of urls) texRefs.set(u, (texRefs.get(u) ?? 0) + 1); };
  const dropRefs = (urls: string[]) => { for (const u of urls) texRefs.set(u, (texRefs.get(u) ?? 1) - 1); };
  /** Delete all unreferenced textures (VRAM near zero when `back` queue is empty, re-upload on next task) */
  const collectTextures = () => {
    for (const [url, n] of [...texRefs]) {
      if (n > 0) continue;
      texRefs.delete(url);
      const t3 = threeTextures.get(url);
      if (t3) { t3.dispose(); threeTextures.delete(url); }
      const tg = glTextures.get(url);
      if (tg) { gl!.deleteTexture(tg); glTextures.delete(url); }
      for (const o of ["flipY", "none"] as const) {
        const key = `${o}|${url}`;
        bitmapDone.get(key)?.close();
        bitmapDone.delete(key);
        bitmaps.delete(key);
      }
    }
  };

  /* ---------------------------------------------------------------- gl branch programs */

  const hashOf = (s: string): string => {
    // Simplified version of cyrb53: used only as cache key
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };

  /** `compileShader` / `linkProgram` use `KHR_parallel_shader_compile`, cached by GLSL hash */
  const glProgramOf = (p: GlProgram): GlProg => {
    const key = hashOf(p.vertex + "\u0000" + p.fragment);
    const hit = glPrograms.get(key);
    if (hit) return hit;
    const g = gl!;
    for (const ext of p.extensions ?? []) g.getExtension(ext);
    const sh = (type: number, src: string) => {
      const s = g.createShader(type)!;
      g.shaderSource(s, src);
      g.compileShader(s);
      return s;
    };
    const vs = sh(g.VERTEX_SHADER, p.vertex);
    const fs = sh(g.FRAGMENT_SHADER, p.fragment);
    const program = g.createProgram()!;
    g.attachShader(program, vs);
    g.attachShader(program, fs);
    g.linkProgram(program);
    const prog: GlProg = { program, done: false, error: null, uniforms: new Map(), aPos: -1, vao: null };
    const finish = () => {
      prog.done = true;
      if (!g.getProgramParameter(program, g.LINK_STATUS)) {
        prog.error = `Shader link failed: ${g.getShaderInfoLog(vs) || ""} ${g.getShaderInfoLog(fs) || ""} ${g.getProgramInfoLog(program) || ""}`.trim();
      }
      prog.aPos = g.getAttribLocation(program, "aPos");
      g.deleteShader(vs);
      g.deleteShader(fs);
    };
    (prog as GlProg & { check: () => boolean }).check = () => {
      if (prog.done) return true;
      if (parallel && !g.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) return false;
      finish();
      return true;
    };
    glPrograms.set(key, prog);
    return prog;
  };
  const glProgramReady = (prog: GlProg): boolean => (prog as GlProg & { check: () => boolean }).check();

  /** Triangle strip covering the area (−1..1); VAOs of each program share this vertex buffer */
  const quadVaoOf = (prog: GlProg): WebGLVertexArrayObject | null => {
    if (prog.vao) return prog.vao;
    const g = gl!;
    if (!quadBuffer) {
      quadBuffer = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, quadBuffer);
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    }
    prog.vao = g.createVertexArray();
    g.bindVertexArray(prog.vao);
    g.bindBuffer(g.ARRAY_BUFFER, quadBuffer);
    if (prog.aPos >= 0) {
      g.enableVertexAttribArray(prog.aPos);
      g.vertexAttribPointer(prog.aPos, 2, g.FLOAT, false, 0, 0);
    }
    g.bindVertexArray(null);
    return prog.vao;
  };

  /* ---------------------------------------------------------------- Card preparation */

  const stageOf = (stageId: string): StageState => {
    let s = stages.get(stageId);
    if (!s) {
      s = { pages: [], regions: new Map(), cards: new Map(), layoutKey: "" };
      stages.set(stageId, s);
    }
    return s;
  };

  const disposeCard = (c: CardState) => {
    try { c.built?.dispose?.(); } catch { /* Even if a card's own dispose throws, it must not bring down other cards */ }
    c.built = null;
    c.ready = false;
    c.preparing = null;
    dropRefs(c.refs);
    c.refs = [];
  };

  /** three: build scene (textures in place first), considered ready only after compilation */
  const prepareThree = (c: CardState): Promise<void> => {
    const r = ensureThree();
    const program = c.program as Extract<CanvasCardProgram, { kind: "three" }>;
    const key = c.buildKey;
    return (async () => {
      const textures: Record<string, THREE.Texture> = {};
      for (const t of c.textures) textures[t.name] = await threeTextureOf(t.url);
      if (c.buildKey !== key) return;
      const built = program.build(THREE, c.params, { width: c.w, height: c.h, stage: c.stage, textures });
      c.built = built;
      built.update(0, { reset: true });
      // three's compileAsync polls via global setTimeout: on the main thread that is the stage's
      // virtual timer and never resolves when paused, so compile synchronously
      if (onMainThread) r.compile(built.scene, built.camera);
      else await r.compileAsync(built.scene, built.camera);
      if (c.buildKey !== key) return;
      c.ready = true;
    })();
  };

  const prepareGl = (c: CardState): Promise<void> => {
    const program = c.program as GlProgram;
    return (async () => {
      for (const t of c.textures) await glTextureOf(t.url);
      const prog = glProgramOf(program);
      while (!glProgramReady(prog)) await sleep(1);
      if (prog.error) throw new Error(prog.error);
      c.ready = true;
    })();
  };

  const prepare2d = (c: CardState): Promise<void> => (async () => {
    for (const t of c.textures) await bitmapOf(t.url, "none");
    c.canvas2d = new OffscreenCanvas(c.w, c.h);
    c.ready = true;
  })();

  const startPrepare = (c: CardState) => {
    if (c.ready || c.preparing || c.error) return;
    if (!c.program) { c.error = `No program registered: ${c.programId}`; return; }
    if (c.program.kind !== c.kind) { c.error = `program ${c.programId} is ${c.program.kind}, but the contract says ${c.kind}`; return; }
    const p = c.kind === "three" ? prepareThree(c) : c.kind === "gl" ? prepareGl(c) : prepare2d(c);
    c.preparing = p.then(
      () => { c.preparing = null; },
      (e) => { c.preparing = null; c.error = e instanceof Error ? e.message : String(e); },
    );
  };

  /* ---------------------------------------------------------------- Atlas */

  const freePages = (s: StageState) => {
    const g = gl!;
    for (const p of s.pages) {
      g.deleteFramebuffer(p.fbo);
      g.deleteRenderbuffer(p.color);
      g.deleteRenderbuffer(p.depth);
      p.rt?.dispose();
    }
    s.pages = [];
  };

  /** Default framebuffer (that OffscreenCanvas) takes largest page across stages, resizing only on layout change */
  const fitCanvas = () => {
    let w = 1, h = 1;
    for (const s of stages.values()) for (const p of s.pages) { w = Math.max(w, p.w); h = Math.max(h, p.h); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };

  const makePage = (w: number, h: number): Page => {
    const g = gl!;
    const color = g.createRenderbuffer()!;
    g.bindRenderbuffer(g.RENDERBUFFER, color);
    g.renderbufferStorageMultisample(g.RENDERBUFFER, samples, g.RGBA8, w, h);
    const depth = g.createRenderbuffer()!;
    g.bindRenderbuffer(g.RENDERBUFFER, depth);
    g.renderbufferStorageMultisample(g.RENDERBUFFER, samples, g.DEPTH24_STENCIL8, w, h);
    const fbo = g.createFramebuffer()!;
    g.bindFramebuffer(g.FRAMEBUFFER, fbo);
    g.framebufferRenderbuffer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.RENDERBUFFER, color);
    g.framebufferRenderbuffer(g.FRAMEBUFFER, g.DEPTH_STENCIL_ATTACHMENT, g.RENDERBUFFER, depth);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.bindRenderbuffer(g.RENDERBUFFER, null);
    three?.resetState();
    return { w, h, fbo, color, depth, rt: null };
  };

  const layout = (stageId: string, cards: GlLayoutCard[]): RegionsMsg => {
    const s = stageOf(stageId);
    const next = new Map<string, GlLayoutCard>(cards.map((c) => [c.clipId, c]));
    // Departed cards: clean up their scenes and texture references
    for (const [id, c] of [...s.cards]) {
      if (!next.has(id)) { disposeCard(c); s.cards.delete(id); }
    }
    for (const lc of cards) {
      const old = s.cards.get(lc.clipId);
      const texKey = lc.textures.map((t) => `${t.name}=${t.url}`).join(",");
      const shapeKey = `${lc.programId}|${lc.kind}|${lc.w}x${lc.h}|${texKey}|${JSON.stringify(lc.stage)}`;
      if (old && old.buildKey.startsWith(shapeKey + "#")) continue;
      if (old) disposeCard(old);
      const c: CardState = {
        clipId: lc.clipId, programId: lc.programId, kind: lc.kind, w: Math.max(1, Math.round(lc.w)), h: Math.max(1, Math.round(lc.h)),
        textures: lc.textures, stage: lc.stage, params: old?.params ?? {}, buildKey: `${shapeKey}#${old ? JSON.stringify(old.params) : "{}"}`,
        program: opts.programOf(lc.programId), built: null, preparing: null, ready: false, error: null, canvas2d: null,
        refs: lc.textures.map((t) => t.url),
      };
      addRefs(c.refs);
      s.cards.set(lc.clipId, c);
    }
    collectTextures();
    // 2d cards do not enter the atlas (each has its own OffscreenCanvas 2D)
    const atlasCards = cards.filter((c) => c.kind !== "2d").map((c) => ({ id: c.clipId, w: c.w, h: c.h }));
    const key = layoutKeyOf(atlasCards);
    if (key !== s.layoutKey) {
      s.layoutKey = key;
      freePages(s);
      s.regions = new Map();
      if (atlasCards.length) {
        const packed = packAtlas(atlasCards, maxAtlas);
        packed.pages.forEach((p, i) => {
          s.pages.push(makePage(p.w, p.h));
          for (const it of p.items) s.regions.set(it.id, { page: i, x: it.x, y: it.y, w: it.w, h: it.h });
        });
      }
      fitCanvas();
    }
    return {
      type: "regions", stageId,
      pages: s.pages.map((p) => ({ w: p.w, h: p.h })),
      regions: Object.fromEntries(s.regions),
    };
  };

  const release = (stageId: string) => {
    const s = stages.get(stageId);
    if (!s || !gl) return;
    for (const c of s.cards.values()) disposeCard(c);
    freePages(s);
    stages.delete(stageId);
    collectTextures();
    fitCanvas();
  };

  /* ---------------------------------------------------------------- One tick */

  /** Render target for this page (used by three): external framebuffer = atlas FBO, colors treated as "draw to screen" */
  const rtOf = (page: Page): THREE.WebGLRenderTarget => {
    if (page.rt) return page.rt;
    const r = ensureThree();
    const rt = new THREE.WebGLRenderTarget(page.w, page.h, { depthBuffer: false });
    (rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    // Public method of three (the one used by WebXR), not included in type declarations
    (r as unknown as { setRenderTargetFramebuffer(rt: THREE.WebGLRenderTarget, fb: WebGLFramebuffer): void }).setRenderTargetFramebuffer(rt, page.fbo);
    page.rt = rt;
    return rt;
  };

  const drawGlCard = (c: CardState, t: number, page: Page, x: number, yGl: number, w: number, h: number) => {
    const g = gl!;
    const program = c.program as GlProgram;
    const prog = glProgramOf(program);
    g.bindFramebuffer(g.FRAMEBUFFER, page.fbo);
    g.viewport(x, yGl, w, h);
    g.enable(g.SCISSOR_TEST);
    g.scissor(x, yGl, w, h);
    g.disable(g.DEPTH_TEST);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.useProgram(prog.program);
    const u = (name: string) => {
      if (!prog.uniforms.has(name)) prog.uniforms.set(name, g.getUniformLocation(prog.program, name));
      return prog.uniforms.get(name)!;
    };
    const values = { uT: t, uResolution: [w, h], ...program.uniforms(t, c.params) };
    for (const [name, v] of Object.entries(values)) {
      const loc = u(name);
      if (!loc) continue;
      if (typeof v === "number") g.uniform1f(loc, v);
      else if (v.length === 2) g.uniform2fv(loc, v);
      else if (v.length === 3) g.uniform3fv(loc, v);
      else if (v.length === 4) g.uniform4fv(loc, v);
      else if (v.length === 16) g.uniformMatrix4fv(loc, false, v);
    }
    c.textures.forEach((tx, i) => {
      g.activeTexture(g.TEXTURE0 + i);
      g.bindTexture(g.TEXTURE_2D, glTextures.get(tx.url) ?? null);
      const loc = u(tx.name);
      if (loc) g.uniform1i(loc, i);
    });
    const geo = program.geometry ?? "quad";
    if (geo === "quad") {
      g.bindVertexArray(quadVaoOf(prog));
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      g.bindVertexArray(null);
    } else {
      const vao = g.createVertexArray();
      g.bindVertexArray(vao);
      const vb = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, vb);
      g.bufferData(g.ARRAY_BUFFER, new Float32Array(geo.vertices), g.STREAM_DRAW);
      if (prog.aPos >= 0) { g.enableVertexAttribArray(prog.aPos); g.vertexAttribPointer(prog.aPos, 2, g.FLOAT, false, 0, 0); }
      if (geo.indices) {
        const ib = g.createBuffer();
        g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ib);
        g.bufferData(g.ELEMENT_ARRAY_BUFFER, new Uint16Array(geo.indices), g.STREAM_DRAW);
        g.drawElements(g.TRIANGLES, geo.indices.length, g.UNSIGNED_SHORT, 0);
        g.deleteBuffer(ib);
      } else {
        g.drawArrays(g.TRIANGLES, 0, geo.vertices.length / 2);
      }
      g.bindVertexArray(null);
      g.deleteBuffer(vb);
      g.deleteVertexArray(vao);
    }
    g.disable(g.SCISSOR_TEST);
    g.disable(g.BLEND);
    three?.resetState();
  };

  /** Work in the same context is serialized: blits for two stageIds are serialized (Route 2), `beat` is one per tick anyway */
  let queue: Promise<unknown> = Promise.resolve();

  const beatNow = async (msg: BeatMsg): Promise<{ msg: DoneMsg; transfer: Transferable[] }> => {
    const g = gl;
    const done: DoneMsg = { type: "done", stageId: msg.stageId, seq: msg.seq, t: msg.t, bitmaps: new Map() };
    if (!g || g.isContextLost()) {
      done.error = error ?? "context-lost";
      return { msg: done, transfer: [] };
    }
    const s = stageOf(msg.stageId);
    // Consume parameters first: only pass what changed, merge with previous
    for (const bc of msg.cards) {
      const c = s.cards.get(bc.clipId);
      if (!c || !bc.params) continue;
      c.params = bc.params;
      const shapeKey = c.buildKey.slice(0, c.buildKey.indexOf("#"));
      const nextKey = `${shapeKey}#${JSON.stringify(bc.params)}`;
      if (nextKey !== c.buildKey) {
        // Parameters changed: three rebuilds the scene (consistent with component rebuilding entirely in layout effect)
        disposeCard(c);
        c.refs = c.textures.map((tx) => tx.url);
        addRefs(c.refs);
        c.buildKey = nextKey;
        c.error = null;
      }
    }
    const cards = msg.cards.map((bc) => ({ bc, c: s.cards.get(bc.clipId) })).filter((x): x is { bc: GlBeatCard; c: CardState } => !!x.c);
    for (const { c } of cards) startPrepare(c);
    if (msg.strict) {
      for (const { c } of cards) if (c.preparing) await c.preparing;
    }
    if (msg.debugSleepMs) await sleep(msg.debugSleepMs);
    const skipped: Record<string, string> = {};
    const gpuMs: Record<string, number> = {};
    const now = () => (typeof performance !== "undefined" ? performance.now() : 0);
    const transfer: Transferable[] = [];

    /* 2d: each draws its own */
    for (const { bc, c } of cards) {
      if (c.kind !== "2d") continue;
      if (!c.ready || !c.canvas2d) { skipped[c.clipId] = c.error ?? "preparing"; continue; }
      const ctx = c.canvas2d.getContext("2d")!;
      const images: Record<string, ImageBitmap> = {};
      for (const tx of c.textures) { const bm = bitmapDone.get(`none|${tx.url}`); if (bm) images[tx.name] = bm; }
      const t0 = msg.measure ? now() : 0;
      ctx.clearRect(0, 0, c.w, c.h);
      (c.program as TwoDProgram).draw(ctx, bc.t, c.params, { width: c.w, height: c.h, stage: c.stage, images, reset: !!bc.reset });
      const bm = c.canvas2d.transferToImageBitmap();
      if (msg.measure) gpuMs[c.clipId] = now() - t0;
      done.bitmaps.set(c.clipId, bm);
      transfer.push(bm);
    }

    /* Atlas: each page clear → draw → blit resolve to default framebuffer → crop bitmap */
    const crops: Array<Promise<void>> = [];
    s.pages.forEach((page, pageIndex) => {
      const onPage = cards.filter(({ c }) => c.kind !== "2d" && s.regions.get(c.clipId)?.page === pageIndex);
      if (!onPage.length) return;
      g.bindFramebuffer(g.FRAMEBUFFER, page.fbo);
      g.disable(g.SCISSOR_TEST);
      g.colorMask(true, true, true, true);
      g.depthMask(true);
      g.viewport(0, 0, page.w, page.h);
      g.clearColor(0, 0, 0, 0);
      g.clearDepth(1);
      g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT | g.STENCIL_BUFFER_BIT);
      three?.resetState();
      const drawn: Array<{ c: CardState; r: Region }> = [];
      for (const { bc, c } of onPage) {
        const r = s.regions.get(c.clipId)!;
        if (!c.ready) { skipped[c.clipId] = c.error ?? "preparing"; continue; }
        const yGl = page.h - r.y - r.h;
        const t0 = msg.measure ? now() : 0;
        try {
          if (c.kind === "three" && c.built) {
            const rr = ensureThree();
            const rt = rtOf(page);
            rt.viewport.set(r.x, yGl, r.w, r.h);
            rt.scissor.set(r.x, yGl, r.w, r.h);
            rt.scissorTest = true;
            rr.setRenderTarget(rt);
            c.built.update(bc.t, { reset: !!bc.reset });
            rr.render(c.built.scene, c.built.camera);
            rr.setRenderTarget(null);
          } else if (c.kind === "gl") {
            drawGlCard(c, bc.t, page, r.x, yGl, r.w, r.h);
          }
        } catch (e) {
          c.error = e instanceof Error ? e.message : String(e);
          skipped[c.clipId] = c.error;
          three?.resetState();
          continue;
        }
        if (msg.measure) { g.finish(); gpuMs[c.clipId] = now() - t0; }
        drawn.push({ c, r });
      }
      if (!drawn.length) return;
      g.flush();
      g.bindFramebuffer(g.READ_FRAMEBUFFER, page.fbo);
      g.bindFramebuffer(g.DRAW_FRAMEBUFFER, null);
      g.disable(g.SCISSOR_TEST);
      g.blitFramebuffer(0, 0, page.w, page.h, 0, 0, page.w, page.h, g.COLOR_BUFFER_BIT, g.NEAREST);
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      three?.resetState();
      // When default framebuffer is larger than this page, the page is pinned to the bottom-left:
      // add the extra offset to the image coordinate y
      const top = canvas.height - page.h;
      for (const { c, r } of drawn) {
        crops.push(createImageBitmap(canvas as OffscreenCanvas, r.x, top + r.y, r.w, r.h).then((bm) => {
          done.bitmaps.set(c.clipId, bm);
          transfer.push(bm);
        }));
      }
    });
    await Promise.all(crops);
    if (Object.keys(skipped).length) done.skipped = skipped;
    if (msg.measure) done.gpuMs = gpuMs;
    return { msg: done, transfer };
  };

  return {
    get ok() { return !!gl && !error; },
    get error() { return error; },
    renderer: rendererName,
    samples,
    layout(stageId, cards) {
      if (!gl) return { type: "regions", stageId, pages: [], regions: {} };
      return layout(stageId, cards);
    },
    beat(msg) {
      const run = queue.then(() => beatNow(msg));
      queue = run.catch(() => {});
      return run;
    },
    release(stageId) {
      queue = queue.then(() => release(stageId)).catch(() => {});
    },
    diag() {
      const atlas: Record<string, Array<{ w: number; h: number }>> = {};
      for (const [id, s] of stages) atlas[id] = s.pages.map((p) => ({ w: p.w, h: p.h }));
      return {
        contexts: gl && !gl.isContextLost() ? 1 : 0,
        stages: [...stages.keys()],
        programs: glPrograms.size,
        bitmaps: bitmapDone.size,
        glTextures: glTextures.size,
        threeTextures: threeTextures.size,
        uploads,
        atlas,
        contextLost,
        renderer: rendererName,
      };
    },
  };
}
