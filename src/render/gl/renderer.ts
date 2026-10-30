/**
 * canvas 卡的共享 WebGL 渲染器 —— 画的那一半(R9 M2 / M3)。
 *
 * **同一份代码跑在两个地方**:GL Worker 里(`glWorker.ts`,两条路线的主路)和舞台主线程上
 * (`glHost.ts` 的能力退路:Worker 里拿不到 `OffscreenCanvas` 的 `webgl2` 时)。两处 import 同一张
 * `programs.ts`,所以画出来的是同一份代码。这里**不碰 DOM**(`OffscreenCanvas` 在两处都有)。
 *
 * # 统一的画法(两条路线一样)
 *
 * 上下文属性 `{ alpha: true, antialias: false, premultipliedAlpha: true }`;每个图集画在**多重采样 FBO**
 * 上(`renderbufferStorageMultisample`,`samples = min(4, MAX_SAMPLES)`),`blitFramebuffer` 解析到
 * 不带抗锯齿的默认帧缓冲(那张 `OffscreenCanvas`),再按区域 `createImageBitmap` 裁位图。
 * **不能直接开 `antialias: true`**:WebGL2 不允许往多重采样的绘制缓冲 blit。
 *
 * `three` 支的渲染器用共享上下文建**一次**;图集那个 FBO 经 `setRenderTargetFramebuffer` 交给它,
 * 渲染目标标成 `isXRRenderTarget`、纹理标 sRGB —— three 对这种目标按「画到屏幕」处理
 * (输出色彩空间、色调映射都和直接画画布一样),否则画进渲染目标会停在线性空间、整体偏暗。
 *
 * # 每个 `stageId` 一份图集
 *
 * 路线 2 下两个舞台共用这一个上下文:每个 `stageId` 各有「活跃卡集合 + 图集区域」,
 * program 缓存和纹理缓存共用(所以纹理只有一份)。`release({ stageId })` 只清那一份。
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
  /** three 画进这一页时用的渲染目标(懒建) */
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
  /** 参数 + 尺寸 + 纹理的身份;变了就重建 three 的 scene */
  buildKey: string;
  program: CanvasCardProgram | undefined;
  /** three:建好的场景;`ready` 之前(编译 / 纹理)这张卡这一拍留空 */
  built: ThreeBuilt | null;
  /** 正在准备(编译、纹理解码);strict 的拍等它 */
  preparing: Promise<void> | null;
  ready: boolean;
  error: string | null;
  /** 2d:自己的画布 */
  canvas2d: OffscreenCanvas | null;
  /** 引用着的纹理地址(给纹理缓存记引用) */
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
  /** `quad` 几何的 VAO(属性位置按 program 各不同,所以一个 program 一个) */
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
 * 主线程退路跑在舞台页里时,`setTimeout` 被舞台时钟换成了虚拟定时器(暂停时不响)—— 等编译、Worker 睡觉
 * 都要用真的那份。Worker 里没有这回事,`setTimeout` 就是真的。
 */
const onMainThread = typeof window !== "undefined";
const realTimeout: (cb: () => void, ms: number) => unknown =
  (onMainThread && (window as unknown as { __pcRealSetTimeout?: (cb: () => void, ms: number) => number }).__pcRealSetTimeout) || setTimeout;
const sleep = (ms: number) => new Promise<void>((r) => realTimeout(r, ms));

/** 位图解码的两种朝向:GL 纹理要自下而上(`flipY`),2D `drawImage` 要原样 */
type Orientation = "flipY" | "none";

export function createGlRenderer(opts: {
  /** 只有一个舞台:图集按小的上限开(`ATLAS_MAX_COMPACT`) */
  compact: boolean;
  programOf: (id: string) => CanvasCardProgram | undefined;
  /** 主线程退路在没有 `OffscreenCanvas` 的环境里自己给一张画布 */
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
    if (!gl) error = "拿不到 webgl2 上下文";
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

  /* ---------------------------------------------------------------- 缓存(各 stageId 共用) */

  const stages = new Map<string, StageState>();
  /** GLSL 源码哈希 → 编译好的 program(同一张卡的多个片段共用) */
  const glPrograms = new Map<string, GlProg>();
  /** 地址 + 朝向 → 解码后的位图(`mediaId + tier` 已由主线程解析进地址里) */
  const bitmaps = new Map<string, Promise<ImageBitmap>>();
  const bitmapDone = new Map<string, ImageBitmap>();
  /** gl 支:地址 → 纹理 */
  const glTextures = new Map<string, WebGLTexture>();
  /** three 支:地址 → 同一个 `THREE.Texture` 实例(同一个 renderer 下多张卡共用,只上传一次) */
  const threeTextures = new Map<string, THREE.Texture>();
  /** 纹理地址被多少张卡引用着(各 stageId 合计);归零就删 */
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

  /* ---------------------------------------------------------------- 纹理 */

  const bitmapOf = (url: string, orientation: Orientation): Promise<ImageBitmap> => {
    const key = `${orientation}|${url}`;
    let p = bitmaps.get(key);
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`纹理 ${r.status}: ${url}`);
          return r.blob();
        })
        .then((blob) => createImageBitmap(blob, { imageOrientation: orientation === "flipY" ? "flipY" : "from-image", premultiplyAlpha: "none" }))
        .then((bm) => { bitmapDone.set(key, bm); return bm; });
      // 失败了别缓存:下一次再试
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
    // 位图解码时已经翻过了:three 对 ImageBitmap 不认 flipY
    tex.flipY = false;
    // 和原来 TextureLoader 那条路一致:颜色空间标 sRGB,否则整体偏暗
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
  /** 没人引用的纹理全删(`back` 队列空时显存近零,下次任务重新上传) */
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

  /* ---------------------------------------------------------------- gl 支的 program */

  const hashOf = (s: string): string => {
    // cyrb53 的简化版:只用来当缓存键
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

  /** `compileShader` / `linkProgram` 走 `KHR_parallel_shader_compile`,按 GLSL 哈希缓存 */
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
        prog.error = `着色器链接失败:${g.getShaderInfoLog(vs) || ""} ${g.getShaderInfoLog(fs) || ""} ${g.getProgramInfoLog(program) || ""}`.trim();
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

  /** 铺满区域的三角形条(−1..1),各 program 的 VAO 共用这一份顶点缓冲 */
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

  /* ---------------------------------------------------------------- 卡的准备 */

  const stageOf = (stageId: string): StageState => {
    let s = stages.get(stageId);
    if (!s) {
      s = { pages: [], regions: new Map(), cards: new Map(), layoutKey: "" };
      stages.set(stageId, s);
    }
    return s;
  };

  const disposeCard = (c: CardState) => {
    try { c.built?.dispose?.(); } catch { /* 卡自己的 dispose 抛了也不能拖垮别的卡 */ }
    c.built = null;
    c.ready = false;
    c.preparing = null;
    dropRefs(c.refs);
    c.refs = [];
  };

  /** three:建 scene(纹理先到位),编译完才算 ready */
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
      // three 的 compileAsync 靠全局 setTimeout 轮询:主线程上那是舞台的虚拟定时器,暂停时永远等不到,所以同步编
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
    if (!c.program) { c.error = `没有注册 program:${c.programId}`; return; }
    if (c.program.kind !== c.kind) { c.error = `program ${c.programId} 是 ${c.program.kind},契约写的是 ${c.kind}`; return; }
    const p = c.kind === "three" ? prepareThree(c) : c.kind === "gl" ? prepareGl(c) : prepare2d(c);
    c.preparing = p.then(
      () => { c.preparing = null; },
      (e) => { c.preparing = null; c.error = e instanceof Error ? e.message : String(e); },
    );
  };

  /* ---------------------------------------------------------------- 图集 */

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

  /** 默认帧缓冲(那张 OffscreenCanvas)取各舞台最大的一页,只在布局变了时改尺寸 */
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
    // 走了的卡:清掉它的场景和纹理引用
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
    // 2d 卡不进图集(各自一张 OffscreenCanvas 2D)
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

  /* ---------------------------------------------------------------- 一拍 */

  /** 这一页的渲染目标(three 用):外部帧缓冲 = 图集 FBO,按「画到屏幕」处理色彩 */
  const rtOf = (page: Page): THREE.WebGLRenderTarget => {
    if (page.rt) return page.rt;
    const r = ensureThree();
    const rt = new THREE.WebGLRenderTarget(page.w, page.h, { depthBuffer: false });
    (rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    // three 的公开方法(WebXR 用的那条),类型声明里没收
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

  /** 同一上下文里的活是串行的:两个 stageId 的 blit 串行(路线 2),`beat` 本来就是一拍一条 */
  let queue: Promise<unknown> = Promise.resolve();

  const beatNow = async (msg: BeatMsg): Promise<{ msg: DoneMsg; transfer: Transferable[] }> => {
    const g = gl;
    const done: DoneMsg = { type: "done", stageId: msg.stageId, seq: msg.seq, t: msg.t, bitmaps: new Map() };
    if (!g || g.isContextLost()) {
      done.error = error ?? "context-lost";
      return { msg: done, transfer: [] };
    }
    const s = stageOf(msg.stageId);
    // 先吃掉参数:只传变了的,和上一次的合并
    for (const bc of msg.cards) {
      const c = s.cards.get(bc.clipId);
      if (!c || !bc.params) continue;
      c.params = bc.params;
      const shapeKey = c.buildKey.slice(0, c.buildKey.indexOf("#"));
      const nextKey = `${shapeKey}#${JSON.stringify(bc.params)}`;
      if (nextKey !== c.buildKey) {
        // 参数变了:three 重建场景(和原来组件在 layout effect 里整个重建一致)
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

    /* 2d:各画各的 */
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

    /* 图集:每页 清 → 画 → blit 解析到默认帧缓冲 → 裁位图 */
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
      // 默认帧缓冲比这一页大时,页贴在左下角:图像坐标的 y 要加上多出来的那一截
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
