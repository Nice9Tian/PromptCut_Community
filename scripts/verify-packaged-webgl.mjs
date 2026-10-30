/** Verify the packaged Chromium binary itself, without a development server. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const executablePath = process.argv[2];
assert.ok(executablePath, 'Pass the installed chrome-headless-shell.exe path');
const browser = await puppeteer.launch({ executablePath, headless: 'shell', args: [
  '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check',
  '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw',
  '--disable-gpu', '--disable-gpu-rasterization', '--disable-gpu-compositing',
  '--enable-unsafe-swiftshader',
] });
try {
  const page = (await browser.pages())[0];
  const result = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('Packaged Chrome cannot create WebGL2');
    const program = gl.createProgram();
    for (const [type, source] of [
      [gl.VERTEX_SHADER, '#version 300 es\nvoid main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0,1); }'],
      [gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; out vec4 color; void main(){color=vec4(0.25,0.5,0.75,1);}'],
    ]) {
      const shader=gl.createShader(type); gl.shaderSource(shader,source); gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program,shader);
    }
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program); gl.drawArrays(gl.TRIANGLES,0,3);
    const rgba=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
    return {rgba:[...rgba],error:gl.getError(),version:gl.getParameter(gl.VERSION)};
  });
  assert.deepEqual(result.rgba,[64,128,191,255]); assert.equal(result.error,0);
  console.log('PASS packaged GLSL',JSON.stringify({executablePath,...result}));
} finally { await browser.close(); }
