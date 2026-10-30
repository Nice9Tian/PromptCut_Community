/**
 * 像素映射的 WebGL2 后端。
 *
 * 为什么有这个文件:像素映射原先是 `getImageData` → 逐像素解释表达式 → `putImageData`,
 * 实测 1080p 每帧 416～483 ms(docs/archive/restructure_planning/render_pipeline_restructure.md 2.1(b)),超 30 fps 的每拍
 * 预算约二十倍,任何机器都重。表达式翻译成片元着色器之后这一步整个挪到 GPU 上,主线程
 * 只剩上传纹理和提交。**逐像素的 CPU 循环已整体删除、不留运行时退路**;`mapRgba` 保留,
 * 只给单测和 GPU / CPU 对照用。
 *
 * 一个文档一个上下文:离屏的 `OffscreenCanvas` + WebGL2,program 按片元源码的内容哈希
 * 缓存(同一条定义挂到多少段上都只编一次)。画完用 `transferToImageBitmap` 交给素材层
 * 自己的 `<canvas>`(那张画布用 `bitmaprenderer` 上下文)。
 *
 * 为什么是 `transferToImageBitmap` 而不是 `drawImage`:
 *   1. 它是**整块位图的转移**,像素逐个原样落到目标画布上;`drawImage` 走的是 2D 合成,
 *      源画布(premultipliedAlpha:false)的直通 alpha 要先预乘、再在目标画布上反预乘,
 *      低 alpha 的像素每来回一趟就掉一两级 —— 抠色正是大量产生低 alpha 像素的活。
 *   2. 离屏画布不进 DOM,也就不会多出一个要被 HTML 快照序列化的 canvas。
 *   3. 目标画布的尺寸由位图决定,不用另外同步 width / height。
 * 代价是目标画布只能有 `bitmaprenderer` 这一种上下文(一个画布只能有一种),所以素材层那张
 * 画布不能再用 2D。读实体框的 `canvasPixels` 走的是 `drawImage` 到离屏 2D 画布,不受影响。
 *
 * 预览、导出页、see_frames 共用这一份:三处都渲同一棵 FrameScene。
 * 以后共享 WebGL 渲染器(R9)落地时,把这个上下文并进去即可,contract 不变。
 */
import { compilePixelMapGlsl, type PixelMapDef } from "../kernel/pixelMap.mjs";

export interface PixelMapDrawOpts {
  def: PixelMapDef;
  /** 源:视频 / 图片元素,或已经套过滤镜的中转画布 */
  source: TexImageSource;
  /** to 是另一段素材时的第二张纹理;没有或还没解码好时传 null */
  target?: TexImageSource | null;
  width: number;
  height: number;
  /** 片段内秒数,着色器里的 uT */
  t: number;
}

interface Prog {
  program: WebGLProgram;
  uTex: WebGLUniformLocation | null;
  uTarget: WebGLUniformLocation | null;
  uHasTarget: WebGLUniformLocation | null;
  uT: WebGLUniformLocation | null;
  uSize: WebGLUniformLocation | null;
}

let canvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let texSrc: WebGLTexture | null = null;
let texTgt: WebGLTexture | null = null;
let programs = new Map<string, Prog>();

export class PixelMapGlError extends Error {}

/** 上下文丢了(或还没建)就整套重来:program、纹理都随上下文一起没了 */
function dropContext() {
  canvas = null;
  gl = null;
  texSrc = null;
  texTgt = null;
  programs = new Map();
}

/** 单测 / 换文档时手动清空 */
export function resetPixelMapGl() {
  dropContext();
}

function newTexture(g: WebGL2RenderingContext): WebGLTexture {
  const tex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, tex);
  // 源和画面同尺寸时 uv 正落在纹素中心,LINEAR 和最近邻取到同一个值;尺寸不同时才真的做双线性,
  // 和原先 CPU 路线里 drawImage(s, 0, 0, w, h) 的拉伸口径一致。
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  return tex;
}

function ensure(): WebGL2RenderingContext {
  if (gl && !gl.isContextLost()) return gl;
  if (gl) dropContext();
  if (typeof OffscreenCanvas === "undefined") {
    throw new PixelMapGlError("这个运行环境没有 OffscreenCanvas,画不了像素映射(需要 Chrome / WebView2)");
  }
  const c = new OffscreenCanvas(1, 1);
  const g = c.getContext("webgl2", {
    alpha: true,
    // 直通 alpha:着色器写出去的就是 mapRgba 的那四个数,不经预乘来回
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    desynchronized: false,
  }) as WebGL2RenderingContext | null;
  if (!g) throw new PixelMapGlError("拿不到 WebGL2 上下文,画不了像素映射");
  // 丢上下文时别让浏览器直接放弃:preventDefault 之后才有机会重建
  (c as unknown as EventTarget).addEventListener("webglcontextlost", (e) => { e.preventDefault(); dropContext(); });
  g.disable(g.BLEND);
  g.disable(g.DEPTH_TEST);
  g.disable(g.SCISSOR_TEST);
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // 浏览器默认会按素材自带的色彩描述做一次转换;像素映射要的是素材原样的数值
  g.pixelStorei(g.UNPACK_COLORSPACE_CONVERSION_WEBGL, g.NONE);
  canvas = c;
  gl = g;
  texSrc = newTexture(g);
  texTgt = newTexture(g);
  return g;
}

function compileShader(g: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = g.createShader(type)!;
  g.shaderSource(sh, src);
  g.compileShader(sh);
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    const log = g.getShaderInfoLog(sh);
    g.deleteShader(sh);
    throw new PixelMapGlError(`着色器编译失败:${log}`);
  }
  return sh;
}

function programOf(g: WebGL2RenderingContext, def: PixelMapDef): Prog {
  const { fragment, vertex, key } = compilePixelMapGlsl(def);
  const hit = programs.get(key);
  if (hit) return hit;
  const vs = compileShader(g, g.VERTEX_SHADER, vertex);
  const fs = compileShader(g, g.FRAGMENT_SHADER, fragment);
  const program = g.createProgram()!;
  g.attachShader(program, vs);
  g.attachShader(program, fs);
  g.linkProgram(program);
  g.deleteShader(vs);
  g.deleteShader(fs);
  if (!g.getProgramParameter(program, g.LINK_STATUS)) {
    const log = g.getProgramInfoLog(program);
    g.deleteProgram(program);
    throw new PixelMapGlError(`着色器链接失败:${log}`);
  }
  const prog: Prog = {
    program,
    uTex: g.getUniformLocation(program, "uTex"),
    uTarget: g.getUniformLocation(program, "uTarget"),
    uHasTarget: g.getUniformLocation(program, "uHasTarget"),
    uT: g.getUniformLocation(program, "uT"),
    uSize: g.getUniformLocation(program, "uSize"),
  };
  programs.set(key, prog);
  return prog;
}

/** 画一帧到离屏画布上(同步;drawArrays 之后画面还在 GPU 上,取走时才落定) */
function render(opts: PixelMapDrawOpts): WebGL2RenderingContext {
  const g = ensure();
  const w = Math.max(1, Math.round(opts.width));
  const h = Math.max(1, Math.round(opts.height));
  if (canvas!.width !== w || canvas!.height !== h) { canvas!.width = w; canvas!.height = h; }
  const prog = programOf(g, opts.def);
  g.viewport(0, 0, w, h);
  g.useProgram(prog.program);

  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, texSrc);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, opts.source as TexImageSource);
  g.uniform1i(prog.uTex, 0);

  const hasTarget = !!opts.target;
  g.activeTexture(g.TEXTURE1);
  g.bindTexture(g.TEXTURE_2D, texTgt);
  // 没有第二张素材时也要给个合法纹理:采样一张未初始化的 sampler 在部分驱动上是未定义行为
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, (hasTarget ? opts.target : opts.source) as TexImageSource);
  g.uniform1i(prog.uTarget, 1);
  g.uniform1i(prog.uHasTarget, hasTarget ? 1 : 0);

  g.uniform1f(prog.uT, opts.t);
  g.uniform2f(prog.uSize, w, h);

  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  // 三个顶点由 gl_VertexID 算出来,不用顶点缓冲,也不用 VAO
  g.drawArrays(g.TRIANGLES, 0, 3);
  return g;
}

/**
 * 画一帧,并把结果整块转移到素材层自己的画布上。
 * `out` 只能有 `bitmaprenderer` 上下文(这个函数会替它取)。
 */
export function drawPixelMap(out: HTMLCanvasElement, opts: PixelMapDrawOpts): void {
  render(opts);
  const ctx = out.getContext("bitmaprenderer");
  if (!ctx) throw new PixelMapGlError("素材层的画布拿不到 bitmaprenderer 上下文(这个画布上已经有别的上下文了?)");
  ctx.transferFromImageBitmap(canvas!.transferToImageBitmap());
}

/**
 * 画一帧并把像素读回来,**从上往下**排(和 ImageData 的行序一致),直通 alpha。
 * 只给验收对照和探针用:它绕开了画布转移,量的是着色器本身算出来的数。
 */
export function readPixelMap(opts: PixelMapDrawOpts): Uint8ClampedArray {
  const g = render(opts);
  const w = Math.max(1, Math.round(opts.width));
  const h = Math.max(1, Math.round(opts.height));
  const flipped = new Uint8Array(w * h * 4);
  g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, flipped);
  const out = new Uint8ClampedArray(w * h * 4);
  const rowBytes = w * 4;
  for (let row = 0; row < h; row++) {
    out.set(flipped.subarray((h - 1 - row) * rowBytes, (h - row) * rowBytes), row * rowBytes);
  }
  return out;
}

/**
 * 探针专用:把这个文档的 WebGL2 上下文交出去,好在 drawPixelMap 外面套一层
 * EXT_disjoint_timer_query_webgl2 量 GPU 真实耗时。渲染路径不用它。
 */
export function pixelMapGlContext(): WebGL2RenderingContext {
  return ensure();
}

/** 真在 GPU 上跑吗:验收时把 renderer 串写进报告,免得拿软件渲染的数当 GPU 的数 */
export function pixelMapGlInfo(): { vendor: string; renderer: string; version: string } | null {
  try {
    const g = ensure();
    const ext = g.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: String(ext ? g.getParameter(ext.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR)),
      renderer: String(ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)),
      version: String(g.getParameter(g.VERSION)),
    };
  } catch {
    return null;
  }
}

// 导出页和 see_frames 在自己的 Chrome 上下文里跑同一棵场景树;探针脚本靠这几个口子取数。
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__pcPixelMapGl = { drawPixelMap, readPixelMap, pixelMapGlInfo, resetPixelMapGl };
}
