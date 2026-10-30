import { createServer } from "vite";
import puppeteer from "puppeteer";

process.env.PROMPTCUT_ROLE = 'prerender';
const server = await createServer({ configFile:'vite.prerender.config.ts', server: { host: "127.0.0.1", port: 5198, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await puppeteer.launch({ headless: true, args: ["--window-position=-32000,-32000", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const session = await browser.target().createCDPSession();
  const { targetId } = await session.send('Target.createTarget', {url:'about:blank',newWindow:true,left:-32000,top:-32000,width:1280,height:720,focus:false});
  await session.detach();
  const page = await (await browser.waitForTarget(t=>t._targetId===targetId)).page();
  page.on("pageerror", error => console.error("page error:", error.message));
  await page.goto("http://127.0.0.1:5198/");
  await page.evaluate(async () => { document.body.innerHTML = '<canvas id="c" width="4" height="4"></canvas>'; window.G = (await import("/src/render/cards/gpuExecutor.ts")).CardGpuExecutor; });
  const result = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas"), gl = canvas.getContext("webgl2");
    let madeT=0, deletedT=0, madeF=0, deletedF=0;
    const ct=gl.createTexture.bind(gl), dt=gl.deleteTexture.bind(gl), cf=gl.createFramebuffer.bind(gl), df=gl.deleteFramebuffer.bind(gl);
    gl.createTexture=()=>{madeT++;return ct()}; gl.deleteTexture=x=>{deletedT++;return dt(x)}; gl.createFramebuffer=()=>{madeF++;return cf()}; gl.deleteFramebuffer=x=>{deletedF++;return df(x)};
    const gpu = new window.G(canvas, async (s, t) => { if (s.nodeId?.startsWith("missing")) return null; const c=document.createElement("canvas");c.width=c.height=1;const x=c.getContext("2d");x.fillStyle=t < .5 ? "#f00" : "#00f";x.fillRect(0,0,1,1);return c; });
    const px=()=>{const v=new Uint8Array(4);gl.readPixels(2,2,1,1,gl.RGBA,gl.UNSIGNED_BYTE,v);return [...v]};
    await gpu.execute({type:"draw",commands:[{type:"solid",color:[1,0,0,.5]}]},0); const solid=px();
    await gpu.execute({type:"glsl",fragment:"uniform float u_time;void main(){outColor=vec4(u_time,0.,0.,1.);}",uniforms:{u_time:{type:"expr",op:"time"}}},.75); const unordered=px();
    await gpu.execute({type:"glsl",fragment:"uniform float u_time;void main(){outColor=vec4(u_time,0.,0.,1.);}",uniforms:{u_time:{type:"expr",op:"add",args:[{type:"expr",op:"mul",args:[2,{type:"expr",op:"time"}]},.25]}}},.25); const explicitTime=px();
    await gpu.execute({type:"glsl",inputs:[{type:"glsl",fragment:"void main(){outColor=vec4(0.,1.,0.,1.);}"}],fragment:"uniform sampler2D u_input0;void main(){outColor=texture(u_input0,v_uv);}"},0); const chain=px();
    await gpu.execute({type:"glsl",fragment:"uniform sampler2D u_input0;void main(){outColor=texture(u_input0,v_uv);}",inputs:[{type:"source",nodeId:"a",time:{type:"expr",op:"time"}}]},.25); const inputA=px();
    await gpu.execute({type:"glsl",fragment:"uniform sampler2D u_input0;void main(){outColor=texture(u_input0,v_uv);}",inputs:[{type:"source",nodeId:"a",time:{type:"expr",op:"time"}}]},.75); const inputB=px();
    let err; try { await gpu.execute({type:"glsl",fragment:"void main(){bad syntax}"},0); } catch(e) { err={code:e.code,log:e.log,message:e.message}; }
    let missing0, missing1; const shader="uniform sampler2D u_input0;uniform sampler2D u_input1;void main(){outColor=texture(u_input0,v_uv)+texture(u_input1,v_uv);}";
    try { await gpu.execute({type:"glsl",fragment:shader,inputs:[{type:"source",nodeId:"missing-0"},{type:"source",nodeId:"ok"}]},0); } catch(e) { missing0=e.code; }
    try { await gpu.execute({type:"glsl",fragment:shader,inputs:[{type:"source",nodeId:"ok"},{type:"source",nodeId:"missing-1"}]},0); } catch(e) { missing1=e.code; }
    canvas.width=2;canvas.height=2; const image=document.createElement("canvas");image.width=image.height=2;const ix=image.getContext("2d");ix.fillStyle="#f00";ix.fillRect(0,0,1,1);ix.fillStyle="#0f0";ix.fillRect(1,0,1,1);ix.fillStyle="#00f";ix.fillRect(0,1,1,1);ix.clearRect(1,1,1,1);
    const imageGpu=new window.G(canvas,async()=>image); await imageGpu.execute({type:"glsl",fragment:"uniform sampler2D u_input0;void main(){outColor=texture(u_input0,v_uv);}",inputs:[{type:"source",nodeId:"asymmetric"}]},0); const grid=new Uint8Array(16);gl.readPixels(0,0,2,2,gl.RGBA,gl.UNSIGNED_BYTE,grid); imageGpu.dispose();
    canvas.width=4;canvas.height=4; await gpu.execute({type:"glsl",fragment:"void main(){outColor=vec4(0.,0.,1.,1.);}"},0); const replaced=px();
    const ext=gl.getExtension("WEBGL_debug_renderer_info"), renderer=ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unavailable"; gpu.dispose(); return {solid,unordered,explicitTime,chain,inputA,inputB,err,missing0,missing1,grid:[...grid],replaced,renderer,counts:[madeT,deletedT,madeF,deletedF]};
  });
  console.log(JSON.stringify(result)); const require = (ok, why) => { if (!ok) throw new Error(why); };
  require(result.solid[0] > 120 && result.solid[2] === 0 && result.solid[3] > 120, "straight-alpha draw failed");
  require(result.unordered[0] > 180, "out-of-order typed time failed"); require(result.chain[1] > 200, "FBO cascade failed");
  require(result.explicitTime[0] > 185 && result.explicitTime[0] < 195, "explicit u_time was overwritten");
  require(result.inputA[0] > 200 && result.inputB[2] > 200, "two input/source time transition failed");
  require(result.missing0 === "missing-source" && result.missing1 === "missing-source", "missing source did not fail at both sampler positions");
  // readPixels returns bottom-to-top rows; the DOM canvas must show red/green
  // on the top row and blue/transparent on the bottom row.
  require(result.grid.join(",") === [0,0,255,255,0,0,0,0,255,0,0,255,0,255,0,255].join(","), "asymmetric 2x2 orientation/alpha changed");
  require(result.err?.code === "shader-compile" && typeof result.err.log === "string" && result.err.message.includes(result.err.log.trim().slice(0,8192)), "shader diagnostic was lost from the transported error message"); require(result.replaced[2] > 200, "shader source replacement left stale program");
  require(result.counts[0] === result.counts[1] && result.counts[2] === result.counts[3], "resources were not released after error/dispose");
  console.log(JSON.stringify({ ...result, rendererMode: /swiftshader|llvmpipe/i.test(result.renderer) ? "software" : "hardware-or-unreported" }));
} finally { await browser?.close(); await server.close(); }
