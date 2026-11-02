/**
 * 从 `src/start/` 里那两块着色器生成**用户卡**，好让 PromptCut 自己的渲染器把它们预渲染成循环视频
 * （用户 2026-10-24 定：「三处都改成渲染器预渲染的循环视频：桌面登录页、手机版登录、官网首页」）。
 *
 *   node scripts/login-art/make-card.mjs            # 两张都生成
 *   node scripts/login-art/make-card.mjs login-art  # 只生成一张
 *
 * | 卡 id | 源文件 | 用在哪 |
 * |---|---|---|
 * | `pc-login-art`  | `src/start/BrandCanvas.tsx` | 桌面登录页左栏那块流动的极光 |
 * | `pc-brand-glow` | `src/start/BrandGlow.tsx`   | 手机版登录的背景、官网首页的背景光（同一块，两种画幅） |
 *
 * **为什么是生成的，不是手写的。** 屏幕上那一版（做视频放不出来时的兜底）和预渲染那一版必须画
 * 同一段 GLSL，手抄两份迟早各自漂。卡片又不能跨层 import `src/start/`（分层守门会拦，
 * 用户卡还要能整份序列化进 .proc），所以这里把 GLSL 原样抄进生成的文件，
 * 并在文件头写明「别手改，改源组件再重跑这个脚本」。
 *
 * 取三样：`VERT`、`FRAG` 两段模板字符串，和 `LOOK` 那个对象字面量。
 * uniform 的上传代码按约定自动生成 —— FRAG 里每个 `uniform float uFoo` 都对应 `LOOK.foo`
 * （首字母小写），这条约定由下面的核对当场把关，对不上就报错退出，不会悄悄少传一个。
 * （这一条真拦下过事：`uFlatten` 加进 FRAG 却忘了登记，脚本当场报错。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 每帧单独传、或由画布尺寸决定的那几个，不从 LOOK 取 */
const PER_FRAME = new Set(['uRes', 'uLoop', 'uPxScale', 'uFlatten']);

/**
 * 两张卡的配置。`colors` 里每一项是 `[uniform 名, 参数名, 默认色, 标签, 说明]`：
 * 颜色一律由卡片参数给，不读 CSS 变量 —— 导出要可重放，不能依赖页面上的 `--ui-accent`。
 */
const CARDS = {
  'login-art': {
    src: 'src/start/BrandCanvas.tsx',
    out: 'src/cards/user/login-art.tsx',
    exportName: 'loginArt',
    id: 'pc-login-art',
    name: 'Login page left rail aurora',
    description: 'The flowing aurora on the left of the login page. The picture is a function of the frame clock and loops back to the start after a full cycle, made specifically to be prerendered into a seamless looping video.',
    useWhen: 'Only for rendering the login page left rail into a looping video; for a flowing background elsewhere, write another card.',
    tags: ['background', 'aurora', 'shader', 'login page'],
    // 画幅要和 render-all.mjs 里那组 W/H 一致，否则画布被缩放、几何就对不上
    size: [Number(process.env.LOGIN_ART_W || 880), Number(process.env.LOGIN_ART_H || 1080)],
    sizeFromStage: false,
    require: ['loopSeconds', 'swirl'],
    colors: [
      ['uCool', 'cool', '#26c6e6', 'Cool color', 'The cool side (the on-screen version takes the theme accent color; hardcoded here so the export is replayable)'],
      ['uWarm', 'warm', '#e2731f', 'Warm color', 'The warm side'],
    ],
    // 这一块本来输出带 alpha（页面上要透出底下的遮罩），视频带不了 alpha，所以压平
    flatten: {
      param: 'bg',
      hex: '#111016',
      label: 'Base color',
      doc: 'Color laid underneath when flattening (the login page\'s --bg-canvas). Video cannot carry alpha, so the base color must be composited in first',
    },
  },
  'brand-glow': {
    src: 'src/start/BrandGlow.tsx',
    out: 'src/cards/user/brand-glow.tsx',
    exportName: 'brandGlow',
    id: 'pc-brand-glow',
    name: 'Home page background glow',
    description: 'The two background glows on the website home page and the mobile app login. The picture is a function of the frame clock and loops back to the start after a full cycle, made specifically to be prerendered into a seamless looping video.',
    useWhen: 'Only for rendering the home page / mobile login background glow into a looping video; for a background glow elsewhere, write another card.',
    tags: ['background', 'glow', 'shader', 'home page'],
    /*
     * 这一张**跟着项目画幅走**（`sizeFromStage`）：这段着色器的两团光半径是固定 CSS 像素、
     * 构图以画面中心对齐（见 BrandGlow.tsx 的 refW / refH），所以在什么尺寸上渲，
     * 出来的就是那个尺寸上的构图。手机要竖版、官网首页要横版，两种画幅只差项目的 width / height，
     * 卡片本身一张就够 —— 不然每换一种画幅都要重新生成一次卡，committed 的那份还只能是最后一次的尺寸。
     * 下面这组数只是 `stage` 没传进来时的兜底（预览、调参台）。
     */
    size: [Number(process.env.GLOW_W || 559), Number(process.env.GLOW_H || 1290)],
    sizeFromStage: true,
    require: ['loopSeconds', 'drift'],
    colors: [
      ['uBg', 'bg', '#111016', 'Base color', 'Base color (the website\'s --bg, the --ui-bg of this repo\'s "Flowing light" skin)'],
      ['uColA', 'colA', '#00dbdb', 'Cool glow', 'Color of the first glow (the on-screen version takes --ui-accent; hardcoded here so the export is replayable)'],
      ['uColB', 'colB', '#FF7B00', 'Warm glow', 'Color of the second glow'],
    ],
    // 这一块自己就输出不透明（底色由它画），不用压平
    flatten: null,
  },
};

const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const keys = want.length ? want : Object.keys(CARDS);
for (const k of keys) {
  if (!CARDS[k]) throw new Error(`No such card: ${k} (available: ${Object.keys(CARDS).join(', ')})`);
}
for (const key of keys) build(key, CARDS[key]);

function build(key, cfg) {
  const SRC = path.join(ROOT, cfg.src);
  const OUT = path.join(ROOT, cfg.out);
  const [W, H] = cfg.size;
  const text = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

  const grabTemplate = (name) => {
    const m = new RegExp('export const ' + name + ' = `(.*?)`;', 's').exec(text);
    if (!m) throw new Error(`Could not find export const ${name} = \`...\` in ${cfg.src}`);
    return m[1];
  };
  const VERT = grabTemplate('VERT');
  const FRAG = grabTemplate('FRAG');

  const lookBody = /export const LOOK = \{(.*?)\n\};/s.exec(text);
  if (!lookBody) throw new Error(`Could not find export const LOOK = { ... } in ${cfg.src}`);
  /** LOOK 里的键（只认顶层两空格缩进那一层，注释和嵌套不算） */
  const lookKeys = [...new Set([...lookBody[1].matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1]))];

  /** FRAG 里声明的 uniform：[类型, 名字] */
  const uniforms = [];
  for (const m of FRAG.matchAll(/uniform\s+(float|vec2|vec3)\s+([^;]+);/g)) {
    for (const n of m[2].split(',')) uniforms.push([m[1], n.trim()]);
  }

  const colorNames = new Set(cfg.colors.map((c) => c[0]));
  if (cfg.flatten) colorNames.add('uBg');
  const lookNameOf = (u) => u[1].toLowerCase() + u.slice(2);

  // 约定核对：每个 float uniform 都要在 LOOK 里有对应的键，少一个就当场报错
  const missing = uniforms
    .filter(([ty, n]) => ty === 'float' && !PER_FRAME.has(n) && !lookKeys.includes(lookNameOf(n)))
    .map(([, n]) => n);
  if (missing.length) throw new Error(`${key}: these uniforms have no matching key in LOOK: ${missing.join(', ')}`);
  for (const need of cfg.require) {
    if (!lookKeys.includes(need)) throw new Error(`${key}: LOOK is missing ${need}, which the seamless loop needs`);
  }
  const unmapped = uniforms.filter(([ty, n]) => ty === 'vec3' && !colorNames.has(n)).map(([, n]) => n);
  if (unmapped.length) throw new Error(`${key}: these color uniforms are not registered in colors: ${unmapped.join(', ')}`);

  const floatUploads = uniforms
    .filter(([ty, n]) => ty === 'float' && !PER_FRAME.has(n))
    .map(([, n]) => `    gl.uniform1f(at(${JSON.stringify(n)}), LOOK.${lookNameOf(n)});`)
    .join('\n');

  /** 卡片参数：颜色那几个，加上（如果要压平的话）底色 */
  const params = cfg.colors.map(([, p, hex, label, doc]) => ({ key: p, hex, label, doc }));
  if (cfg.flatten) {
    params.push({ key: cfg.flatten.param, hex: cfg.flatten.hex, label: cfg.flatten.label, doc: cfg.flatten.doc });
  }

  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const rgbLit = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return `[${(((n >> 16) & 255) / 255).toFixed(3)}, ${(((n >> 8) & 255) / 255).toFixed(3)}, ${((n & 255) / 255).toFixed(3)}]`;
  };
  const colorUploads = cfg.colors
    .map(([u, p, hex]) => `    gl.uniform3f(at(${JSON.stringify(u)}), ...hexToRgb(params.${p}, ${rgbLit(hex)}));`)
    .join('\n');
  const flattenUploads = cfg.flatten
    ? '\n    // Prerendered to video: flatten. Merge the background color in, set alpha to 1\n'
      + '    gl.uniform1f(at("uFlatten"), 1);\n'
      + `    gl.uniform3f(at("uBg"), ...hexToRgb(params.${cfg.flatten.param}, ${rgbLit(cfg.flatten.hex)}));`
    : '';
  /** WebGL2 起不来时拿来涂底的那个参数：有底色用底色，没有就用第一个颜色 */
  const fallbackParam = cfg.flatten ? cfg.flatten.param : cfg.colors[0][1];
  /** 组件名：由导出名首字母大写来，读堆栈时能一眼看出是哪张卡 */
  const Comp = cfg.exportName[0].toUpperCase() + cfg.exportName.slice(1);

  /*
   * `defaults.loopSeconds` 写**字面量**，不写 `LOOK.loopSeconds`。
   *
   * 卡片有一条「只读源码也要能认出这张卡」的路（`src/kernel/cardSourceParse.ts`，在线页面和
   * 同步表都走它）：它认同文件常量的**引用**，但认不出 `常量.属性` 这种取值，
   * 于是 defaults 里会少掉 loopSeconds 这一项，和模块真正导出的 CardDef 对不上，
   * `cardSourceParse.test.mjs` 那条「仓库里每一个 src/cards/user/*.tsx 解析结果与注册表逐个相同」就红。
   * 这里生成时就知道这个数，直接写死最省事，而且文件是生成的 —— 改了 LOOK 重跑一次就同步。
   */
  const loopSeconds = (() => {
    const m = /^ {2}loopSeconds:\s*(\d+(?:\.\d+)?)/m.exec(lookBody[1]);
    if (!m) throw new Error(`${key}: LOOK.loopSeconds is not a numeric literal, so it cannot be written into defaults`);
    return m[1];
  })();

  /*
   * 画幅：跟着项目走的那张用 `stage`（舞台画幅），没传就用下面这组兜底；
   * 不跟的那张直接用常量，省得生成出来的文件无谓地多两行。
   */
  const sizeLines = cfg.sizeFromStage
    ? '  // The aspect ratio follows the project (the two glows have a fixed pixel radius, so the composition is that of whatever size it is rendered at)\n'
      + '  const w = Math.max(2, Math.round(stage?.width ?? WIDTH));\n'
      + '  const h = Math.max(2, Math.round(stage?.height ?? HEIGHT));'
    : '  const w = WIDTH;\n  const h = HEIGHT;';
  const sizeArg = cfg.sizeFromStage ? ', stage' : '';
  const sizeDeps = cfg.sizeFromStage ? ', w, h' : '';

  const card = `/* This file is generated by scripts/login-art/make-card.mjs, do not edit by hand.
 * To change the visuals, edit ${cfg.src} (the on-screen version) and rerun the generator script,
 * so both sides draw the same GLSL. The generation time is not written into the file, to avoid pointless diffs on every rerun.
 *
 * This card exists for one purpose: to let PromptCut's own renderer **prerender it into a looping video** (user decision, 2026-10-24).
 * The visuals are written as a function of the frame clock t, with no frame loop of their own, in line with server/card-authoring-guide.md.
 * uLoop = the fractional part of (t / loop seconds); after a full cycle it returns to the start byte for byte, so the first and last frames join up.
 */
import { useLayoutEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

interface Params {
${params.map((p) => `  /** ${p.doc} */\n  ${p.key}: string;`).join('\n')}
  /** Seconds per loop */
  loopSeconds: number;
}

const WIDTH = ${W};
const HEIGHT = ${H};

const LOOK = {${lookBody[1]}
};

const VERT = \`${esc(VERT)}\`;

const FRAG = \`${esc(FRAG)}\`;

function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]${esc(FRAG)})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function ${Comp}({ params, t = 0${sizeArg} }: CardProps<Params>) {
  const ref = useRef<HTMLCanvasElement>(null);
${sizeLines}
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    // If WebGL2 fails to start, draw a solid background color so the whole card doesn't blow up
    if (!gl) {
      const c2 = canvas.getContext("2d");
      if (c2) { c2.fillStyle = params.${fallbackParam} || "#111016"; c2.fillRect(0, 0, w, h); }
      return;
    }
    const make = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, make(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);
    const at = (n: string) => gl.getUniformLocation(prog, n);

${floatUploads}
${colorUploads}${flattenUploads}
    gl.uniform2f(at("uRes"), w, h);
    gl.uniform1f(at("uPxScale"), 1);
    // After a full cycle it returns to the start: at t = loopSeconds the frame computes the same as the frame at t = 0
    const secs = Math.max(0.001, params.loopSeconds);
    gl.uniform1f(at("uLoop"), ((t % secs) + secs) % secs / secs);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.deleteProgram(prog);
  }, [t, ${params.map((p) => `params.${p.key}`).join(', ')}, params.loopSeconds${sizeDeps}]);
  return <canvas ref={ref} width={w} height={h} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}

export const ${cfg.exportName}: CardDef<Params> = {
  id: ${JSON.stringify(cfg.id)},
  name: ${JSON.stringify(cfg.name)},
  description: ${JSON.stringify(cfg.description)},
  source: "user",
  useWhen: ${JSON.stringify(cfg.useWhen)},
  tags: [${cfg.tags.map((t) => JSON.stringify(t)).join(", ")}],
  frameMode: "direct",
  defaults: { ${params.map((p) => `${p.key}: ${JSON.stringify(p.hex)}`).join(', ')}, loopSeconds: ${loopSeconds} },
  controls: [
${params.map((p) => `    { key: ${JSON.stringify(p.key)}, label: ${JSON.stringify(p.label)}, type: "color" },`).join('\n')}
    { key: "loopSeconds", label: "Loop seconds", type: "number", min: 4, max: 600, step: 1 },
  ],
  Component: ${Comp},
};
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, card, 'utf8');
  console.log(`Wrote ${cfg.out}`);
  console.log(`  GLSL ${FRAG.length} characters, ${floatUploads.split('\n').length} float uniforms and ${cfg.colors.length} colors uploaded automatically`);
  console.log(`  Canvas ${W}×${H}, loop ${/loopSeconds:\s*(\d+)/.exec(lookBody[1])?.[1] ?? '?'} s`);
}
