/**
 * Compiles the two GLSL blocks from `src/start/BrandCanvas.tsx` with **software WebGL** (which is
 * what export uses); if compilation fails, prints Chrome's info log as-is.
 *
 *   node scripts/login-art/check-glsl.mjs
 *
 * Why extracted separately: when compilation fails inside a card, React only says "<LoginArt>
 * component error" without providing the shader error body; guessing GLSL through a card wastes
 * time, so compiling it directly is much better.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const text = fs.readFileSync(path.join(ROOT, 'src/start/BrandCanvas.tsx'), 'utf8').replace(/\r\n/g, '\n');
const grab = (name) => {
  const m = new RegExp('export const ' + name + ' = `(.*?)`;', 's').exec(text);
  if (!m) throw new Error('Not found: ' + name);
  return m[1];
};
const VERT = grab('VERT');
const FRAG = grab('FRAG');

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.goto('about:blank');
const result = await page.evaluate(([v, f]) => {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const gl = canvas.getContext('webgl2');
  if (!gl) return { webgl2: false };
  const make = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? { ok: true, sh } : { ok: false, log: gl.getShaderInfoLog(sh) };
  };
  const vs = make(gl.VERTEX_SHADER, v);
  if (!vs.ok) return { webgl2: true, stage: 'vert', log: vs.log };
  const fs2 = make(gl.FRAGMENT_SHADER, f);
  if (!fs2.ok) return { webgl2: true, stage: 'frag', log: fs2.log };
  const prog = gl.createProgram();
  gl.attachShader(prog, vs.sh); gl.attachShader(prog, fs2.sh); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { webgl2: true, stage: 'link', log: gl.getProgramInfoLog(prog) };
  // Compiling is not enough: actually render a frame to check if it is fully transparent
  gl.useProgram(prog);
  gl.viewport(0, 0, 64, 64);
  gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), 64, 64);
  gl.uniform1f(gl.getUniformLocation(prog, 'uPxScale'), 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(4);
  gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { webgl2: true, ok: true, centerPixelWithNoUniforms: [...px] };
}, [VERT, FRAG]);
console.log(JSON.stringify(result, null, 1));
await browser.close();
process.exit(result.ok ? 0 : 1);
