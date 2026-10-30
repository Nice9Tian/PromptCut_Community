/** Explicit GPU descriptions. No Python or string-expression compilation occurs here.
 * 这些类型搬到了 src/kernel/cardGpu.ts —— CardDef 要用它们声明 `card()` 的返回值,
 * 类型留在渲染层的话 kernel 就在类型上依赖 render 了。这里原样 re-export,
 * `from "./gpuExecutor"` 的写法一个都没变。 */
export type { Expr, SourceValue, PixelsValue, DrawValue, GlslValue, BitmapValue, CardGpuValue, ValueResolver } from "../../kernel/cardGpu";
import type { CardGpuValue, Expr, PixelsValue, SourceValue, ValueResolver } from "../../kernel/cardGpu";
export class CardGpuError extends Error {
  constructor(public readonly code: "unavailable" | "shader-compile" | "shader-link" | "budget" | "cancelled" | "missing-source" | "invalid-value", message: string, public readonly log?: string) {
    // Frame tickets and the see_frames transport retain Error.message. Include
    // the compiler diagnostic there so an author can fix an undeclared uniform
    // or syntax error without losing it at the browser/service boundary.
    super(log?.trim() ? `${message}\n${log.trim().slice(0, 8192)}` : message);
  }
}
type Target = { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number };
const VERTEX = `#version 300 es
layout(location=0) in vec2 position; layout(location=1) in vec2 uv; out vec2 v_uv;
void main(){gl_Position=vec4(position,0,1);v_uv=uv;}`;
const COPY = "uniform sampler2D u_input0;void main(){outColor=texture(u_input0,v_uv);}";
const COPY_IMAGE = "uniform sampler2D u_input0;void main(){outColor=texture(u_input0,vec2(v_uv.x,1.-v_uv.y));}";

function numberAt(value: Expr, time: number, depth = 0): number {
  if (depth > 64) throw new CardGpuError("budget", "Expression depth exceeded");
  if (typeof value === "number") { if (Number.isFinite(value)) return value; throw new CardGpuError("invalid-value", "Non-finite uniform"); }
  if (!value || value.type !== "expr") throw new CardGpuError("invalid-value", "Invalid time expression");
  const args = (value.args || []).map(v => numberAt(v, time, depth + 1));
  const operations: Record<string, () => number> = {
    time: () => time, add: () => args[0] + args[1], sub: () => args[0] - args[1], mul: () => args[0] * args[1],
    div: () => args[0] / args[1], neg: () => -args[0], sin: () => Math.sin(args[0]), cos: () => Math.cos(args[0]),
    min: () => Math.min(...args), max: () => Math.max(...args),
  };
  const result = operations[value.op]?.();
  if (!Number.isFinite(result)) throw new CardGpuError("invalid-value", "Invalid or non-finite time expression");
  return result;
}

/** Hosts retain the canvas in its original DOM stacking context. */
export class CardGpuExecutor {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private programs = new Map<string, WebGLProgram>();
  private targets = new Map<number, Target>();
  private disposed = false;
  private serial = Promise.resolve();
  constructor(public readonly canvas: HTMLCanvasElement | OffscreenCanvas, private readonly resolve: ValueResolver, private readonly maxPasses = 32, private readonly maxDepth = 32) {
    // A card draws when its inputs/time change, while capture may happen after
    // further compositor ticks or freeze the canvas with toDataURL. The default
    // disposable drawing buffer can become transparent between those steps.
    //
    // 离屏画布(图卡递归解析上游时用的那种)和 DOM 画布的 getContext 是两个不同的重载,
    // strict 下对联合类型直接调编不过,所以各调各的再收窄。
    const attributes = { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true };
    const context = canvas instanceof OffscreenCanvas
      ? canvas.getContext("webgl2", attributes)
      : canvas.getContext("webgl2", attributes);
    const gl = context as WebGL2RenderingContext | null;
    if (!gl) throw new CardGpuError("unavailable", "WebGL2 is unavailable");
    this.gl = gl;
    const buffer = gl.createBuffer(), vao = gl.createVertexArray();
    if (!buffer || !vao) throw new CardGpuError("unavailable", "GPU allocation failed");
    this.buffer = buffer; this.vao = vao;
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0,0,1,-1,1,0,-1,1,0,1,1,1,1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,2,gl.FLOAT,false,16,8); gl.bindVertexArray(null);
  }
  private check(signal?: AbortSignal) {
    if (this.disposed || signal?.aborted) throw new CardGpuError("cancelled", "GPU execution cancelled");
  }
  private program(raw: string) {
    const existing = this.programs.get(raw); if (existing) return existing;
    if (this.programs.size >= 128) throw new CardGpuError("budget", "Shader program budget exceeded");
    if (typeof raw !== "string" || raw.length > 512 * 1024) throw new CardGpuError("invalid-value", "Invalid shader source");
    const fragment = raw.trimStart().startsWith("#version 300 es") ? raw : "#version 300 es\nprecision highp float;in vec2 v_uv;out vec4 outColor;\n" + raw;
    const gl = this.gl, shaders: WebGLShader[] = []; let program: WebGLProgram | null = null;
    try {
      for (const [kind, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(kind); if (!shader) throw new CardGpuError("unavailable", "Shader allocation failed");
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new CardGpuError("shader-compile", "GLSL compilation failed", gl.getShaderInfoLog(shader) || "");
      }
      program = gl.createProgram(); if (!program) throw new CardGpuError("unavailable", "Program allocation failed");
      shaders.forEach(shader => gl.attachShader(program!, shader)); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new CardGpuError("shader-link", "GLSL link failed", gl.getProgramInfoLog(program) || "");
      this.programs.set(raw, program); return program;
    } catch (error) { if (program) gl.deleteProgram(program); throw error; }
    finally { shaders.forEach(shader => gl.deleteShader(shader)); }
  }
  private target(index: number) {
    const gl = this.gl, width = this.canvas.width, height = this.canvas.height;
    const existing = this.targets.get(index);
    if (existing?.width === width && existing.height === height) return existing;
    if (existing) { gl.deleteFramebuffer(existing.framebuffer); gl.deleteTexture(existing.texture); this.targets.delete(index); }
    const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new CardGpuError("unavailable", "Framebuffer allocation failed");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    this.textureParameters(); gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer); throw new CardGpuError("unavailable", "Incomplete framebuffer");
    }
    const result = { texture, framebuffer, width, height }; this.targets.set(index,result); return result;
  }
  private textureParameters() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  }
  private draw(source: string, inputs: WebGLTexture[], uniforms: Record<string, Expr | Expr[]>, time: number, target: WebGLFramebuffer | null) {
    const gl = this.gl, program = this.program(source);
    if (inputs.length > gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)) throw new CardGpuError("budget", "Texture input budget exceeded");
    gl.bindFramebuffer(gl.FRAMEBUFFER,target); gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.disable(gl.BLEND); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(program);
    inputs.forEach((texture,index) => { gl.activeTexture(gl.TEXTURE0+index); gl.bindTexture(gl.TEXTURE_2D,texture);
      const location = gl.getUniformLocation(program,"u_input"+index); if (location !== null) gl.uniform1i(location,index); });
    for (const [name,value] of Object.entries(uniforms)) {
      const location = gl.getUniformLocation(program,name); if (location === null) continue;
      if (Array.isArray(value)) {
        const values = value.map(v => numberAt(v,time));
        if (values.length === 2) gl.uniform2fv(location,values); else if (values.length === 3) gl.uniform3fv(location,values);
        else if (values.length === 4) gl.uniform4fv(location,values); else gl.uniform1fv(location,values);
      } else gl.uniform1f(location,numberAt(value,time));
    }
    if (!Object.hasOwn(uniforms,"u_time")) { const location = gl.getUniformLocation(program,"u_time"); if (location !== null) gl.uniform1f(location,time); }
    if (!Object.hasOwn(uniforms,"u_resolution")) { const location = gl.getUniformLocation(program,"u_resolution"); if (location !== null) gl.uniform2f(location,this.canvas.width,this.canvas.height); }
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLE_STRIP,0,4); gl.bindVertexArray(null);
  }
  private image(image: TexImageSource, target: Target, time: number) {
    const gl = this.gl, texture = gl.createTexture(); if (!texture) throw new CardGpuError("unavailable", "Texture allocation failed");
    try {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      this.textureParameters(); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
      // DOM/image bitmap rows have a top-left origin. Flip only on upload-copy;
      // subsequent framebuffer passes already use the GPU's bottom-left origin.
      this.draw(COPY_IMAGE,[texture],{},time,target.framebuffer);
    } finally { gl.deleteTexture(texture); }
  }
  execute(value: CardGpuValue, time: number, signal?: AbortSignal): Promise<void> {
    const result = this.serial.catch(() => {}).then(() => this.executeNow(value,time,signal));
    this.serial = result; return result;
  }
  private async executeNow(value: CardGpuValue, time: number, signal?: AbortSignal) {
    this.check(signal); let next = 0;
    const memo = new WeakMap<object, WebGLTexture>(), visiting = new WeakSet<object>();
    const render = async (value: CardGpuValue, depth: number): Promise<WebGLTexture> => {
      this.check(signal);
      if (!value || typeof value !== "object") throw new CardGpuError("missing-source", "Missing GPU input");
      if (memo.has(value)) return memo.get(value)!;
      if (visiting.has(value)) throw new CardGpuError("invalid-value", "GPU graph cycle");
      if (next >= this.maxPasses || depth > this.maxDepth) throw new CardGpuError("budget", "GPU graph budget exceeded");
      const target = this.target(next++); visiting.add(value);
      try {
        if (value.type === "source" || value.type === "pixels") {
          const at = value.type === "source" ? numberAt(value.time ?? { type:"expr",op:"time" },time)*(value.rate??1)+(value.offset??0) : time;
          const image = await this.resolve(value,at,signal); this.check(signal);
          if (!image) throw new CardGpuError("missing-source", "Host did not resolve a GPU input");
          this.image(image,target,time);
        } else if (value.type === "draw") {
          const canvas = document.createElement("canvas"); canvas.width=this.canvas.width;canvas.height=this.canvas.height;
          const context=canvas.getContext("2d")!;
          for (const command of value.commands) {
            context.fillStyle=`rgba(${command.color[0]*255},${command.color[1]*255},${command.color[2]*255},${command.color[3]})`;
            if(command.type==="solid")context.fillRect(0,0,canvas.width,canvas.height);
            else context.fillRect(command.x??0,command.y??0,command.width??0,command.height??0);
          }
          this.image(canvas,target,time);
        } else if (value.type === "bitmap") {
          // CPU 像素算法的出口:已经是一张图了,直接按上传-拷贝那条路走(COPY_IMAGE 负责翻 Y)
          if (!value.image) throw new CardGpuError("missing-source", "Bitmap value has no image");
          this.image(value.image,target,time);
        } else if (value.type === "glsl") {
          const inputs:WebGLTexture[]=[];
          for(const input of value.inputs||[])inputs.push(await render(input,depth+1));
          this.check(signal);this.draw(value.fragment,inputs,value.uniforms||{},time,target.framebuffer);
        } else throw new CardGpuError("invalid-value","Unknown GPU value");
        memo.set(value,target.texture);return target.texture;
      } finally { visiting.delete(value); }
    };
    const result=await render(value,0);this.check(signal);this.draw(COPY,[result],{},time,null);
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;
    for(const program of this.programs.values())this.gl.deleteProgram(program);
    for(const target of this.targets.values()){this.gl.deleteFramebuffer(target.framebuffer);this.gl.deleteTexture(target.texture);}
    this.gl.deleteBuffer(this.buffer);this.gl.deleteVertexArray(this.vao);this.programs.clear();this.targets.clear();
  }
}
