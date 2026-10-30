/**
 * 兼容旁路的素材合成:在显式 --media=ffmpeg 时，Chrome 只渲卡片透明层，视频 / 图片由 ffmpeg 合进成片。
 *
 * # 为什么不让 Chrome 连素材一起渲
 *
 * 以前导出页把每段素材都挂成 <video>,每一帧对画面里的每一层 seek 一次、等它 seek 完再截图
 * (ExportView 的 __pcSetT / __pcFrameReady)。1080p H.264 的一次 seek 要解码到目标帧,几十到几百毫秒,
 * 一帧里有交叉溶解就是两次;画面里有视频的帧也永远判不了静止(server/bakery/bake.mjs 的 isStatic)。
 * 而最后 ffmpeg 只是把 PNG 序列铺在灰底上 —— 视频像素是 Chrome 缩放好烤进 PNG 的。
 * see_frames 早就换成了「页面只渲卡片、素材 ffmpeg 抽帧」(vision-compose.mjs),这里把同一个思路搬到整条导出:
 * 素材层按 ExportView / 预览 MediaLayers 同一套规则拼成一张 filter graph,一趟 ffmpeg 解码、摆位、淡化、叠卡片、编码。
 *
 * # 和页面对齐的规则(每条都对应一处前端代码)
 *
 *   - 哪些段、谁压谁:kernel/project.ts 的 videoLayersAt —— 倒着走序列,靠上的序列在上层;隐藏序列、音频不算。
 *   - 某帧出不出现:和 ExportView 一样按 `i / fps` 判 `start <= t < end`,这里直接换算成帧号区间。
 *   - 不透明度:opacityAt = opacity × 淡入 × 淡出,分别用 colorchannelmixer(常数)和 fade alpha(线性)做。
 *   - 取素材的哪一帧:Chrome seek 到 currentTime 后显示「时间戳 ≤ currentTime 的最后一帧」,
 *     这里用 fps=round=up 把素材帧摆到导出帧的网格上,是同一个取法(round=near 会提前半帧换帧)。
 *     实测和旧导出(Chrome 逐帧 seek)逐帧比:wf-test 素材上取到的是同一帧;一个 B 帧很多的 B 站 mp4
 *     (has_b_frames=4)上旧导出比这条规则晚 1~2 帧 —— 是 Chrome 那边偏了,这里按规则取(不经 Chrome 单独验过)。
 *   - 摆位:预览 MediaLayers 的做法 —— 外层是 clip.frame 的框(frameCss 那套:锚点、缩放、平面旋转,
 *     overflow:hidden),里面素材 object-fit: cover 铺满。旧的导出页不认 frame(一律铺满全屏),
 *     导出和预览对不上;这里按预览的来。素材段不允许三维(kernel/envelope.ts 的 assertNo3dOnMedia)。
 *   - 强调(emphasis):见下面 emphasisOps 的注释。
 *   - 卡片上的毛玻璃(backdrop-filter):见 buildComposeArgs 的 mask 参数。
 *
 * 纯函数,不碰磁盘、不起进程,node --test 直接测(server/test/export-compose.test.mjs)。
 */

import { ffmpegChain, ffmpegStages, ffmpegStaticChain, filterOfClip, isAnimated, resolveOps, sendcmdScript } from "../src/kernel/filters.mjs";
import { clipSpeed, mediaTimeAt } from "../src/kernel/clipTime.mjs";

/** 和 ExportView / flattenOverlay 一个口径:从下到上所有画面素材段(视频 + 图片),不管时间 */
export function composeLayers(project) {
  const out = [];
  for (const tr of [...(project.tracks || [])].reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips || []) {
      if (!c.mediaId) continue;
      const media = (project.media || []).find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      // 滤镜定义是项目级的(project.filters),合成时只拿得到 layers —— 在这里把定义和这段的参数带上
      const def = filterOfClip(project, c);
      const pixelMap = c.pixelMap && (project.pixelMaps ?? []).find((x) => x.id === c.pixelMap.id);
      out.push({ clip: c, media, ...(def ? { filter: { def, params: c.filter.params } } : null), ...(pixelMap ? { pixelMap } : null) });
    }
  }
  return out;
}

/**
 * 这段在导出的 [f0, f1] 帧里出现在哪些帧:第一帧和最后一帧(含),不出现返回 null。
 * 判定逐字照抄 ExportView:`sec = i / fps`,`sec >= start && sec < end`。先按乘法估再逐帧校正,
 * 免得 2.68 × 30 这种浮点末位把边界帧算错一格。
 */
export function clipFrameRange(clip, fps, f0, f1) {
  const inside = (i) => i / fps >= clip.start && i / fps < clip.end;
  let a = Math.max(f0, Math.ceil(clip.start * fps) - 1);
  while (a <= f1 && !inside(a)) {
    if (a / fps >= clip.end) return null;
    a++;
  }
  if (a > f1) return null;
  while (a - 1 >= f0 && inside(a - 1)) a--;
  let b = Math.min(f1, Math.max(a, Math.floor(clip.end * fps) + 1));
  while (b > a && !inside(b)) b--;
  while (b + 1 <= f1 && inside(b + 1)) b++;
  return [a, b];
}

/**
 * clip.frame 在舞台上的摆法,换算成 ffmpeg 要的整数:素材先 cover 进 w×h(已乘 scale)的框,
 * 绕框中心旋转成 ow×oh,左上角落在 (x, y)。
 *
 * 和 frameCss 同一串变换:框的左上角 = 锚点坐标 − 锚点在框内的偏移,缩放 / 旋转绕锚点
 * (transformOrigin = anchor%)。框中心相对锚点的向量先缩放再旋转,就是变换后框中心的位置;
 * ffmpeg 的 rotate 绕图像中心转、输出也以中心对齐,所以只要把输出的中心放到那里。
 * 旋转方向:CSS rotate(θ) 和 ffmpeg rotate=a 都是顺时针为正(y 轴朝下)。
 */
export function placement(frame, stage) {
  if (!frame) return { w: stage.width, h: stage.height, ow: stage.width, oh: stage.height, x: 0, y: 0, rotate: 0, scale: 1 };
  const w0 = frame.w ?? stage.width;
  const h0 = frame.h ?? stage.height;
  const [ax, ay] = frame.anchor ?? [0, 0];
  const s = frame.scale ?? 1;
  const rot = ((frame.rotate ?? 0) * Math.PI) / 180;
  const w = Math.max(1, Math.round(w0 * s));
  const h = Math.max(1, Math.round(h0 * s));
  // 框中心相对锚点:(0.5 − anchor) × 尺寸,先缩放再旋转
  const vx = (0.5 - ax) * w0 * s;
  const vy = (0.5 - ay) * h0 * s;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const cx = frame.x + vx * cos - vy * sin;
  const cy = frame.y + vx * sin + vy * cos;
  let ow = w;
  let oh = h;
  if (rot !== 0) {
    ow = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin) - 1e-9);
    oh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos) - 1e-9);
  }
  return { w, h, ow, oh, x: Math.round(cx - ow / 2), y: Math.round(cy - oh / 2), rotate: rot, scale: s };
}

/* ---------------------------------------------------------------------------------------------
 * 颜色:强调的颜色是任意 CSS 颜色串(kernel/emphasis.ts 不解析它,交给浏览器)。ffmpeg 要数值,
 * 这里认常见的几种写法;认不出来的返回 null,由调用方退回默认色并在 notes 里说清楚。
 * ------------------------------------------------------------------------------------------- */
const NAMED = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], lime: [0, 255, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], aqua: [0, 255, 255], magenta: [255, 0, 255],
  fuchsia: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  maroon: [128, 0, 0], olive: [128, 128, 0], teal: [0, 128, 128], navy: [0, 0, 128], purple: [128, 0, 128],
  orange: [255, 165, 0], pink: [255, 192, 203], gold: [255, 215, 0], transparent: [0, 0, 0, 0],
};

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** CSS 颜色 → [r, g, b, a](0~255,a 是 0~1)。认不出来返回 null */
export function parseCssColor(str) {
  const s = String(str || "").trim().toLowerCase();
  if (!s) return null;
  if (NAMED[s]) {
    const [r, g, b, a = 1] = NAMED[s];
    return [r, g, b, a];
  }
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const v = [...h].map((c) => parseInt(c + c, 16));
      return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].slice(0, h.length / 2).map((i) => parseInt(h.slice(i, i + 2), 16));
      return [v[0], v[1], v[2], h.length === 8 ? v[3] / 255 : 1];
    }
    return null;
  }
  m = s.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (p, scale) => (p.endsWith("%") ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const alpha = parts[3] !== undefined ? num(parts[3], 1) : 1;
  let rgb;
  if (m[1].startsWith("rgb")) rgb = parts.slice(0, 3).map((p) => num(p, 255));
  else rgb = hslToRgb(parseFloat(parts[0]), num(parts[1].endsWith("%") ? parts[1] : parts[1] + "%", 1), num(parts[2].endsWith("%") ? parts[2] : parts[2] + "%", 1));
  if ([...rgb, alpha].some((v) => !Number.isFinite(v))) return null;
  return [...rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))), Math.max(0, Math.min(1, alpha))];
}

/* ---------------------------------------------------------------------------------------------
 * 强调(阴影 / 描边)。和 kernel/emphasis.ts 的 emphasisFilter 同一套数(那边是 TS,导出脚本是裸 node 跑的
 * .mjs,所以这里照抄一份;单测拿两边的输出互相对账,改一边另一边的测试会红)。
 *
 * CSS 的 `filter: drop-shadow(a) drop-shadow(b) …` 是**依次**作用的:第二个影子投的是「原图 + 第一个影子」,
 * 描边那八个方向因此会互相叠出一圈比线宽更粗的边。这里按同样的顺序一层层叠,不是八个影子并排。
 * 模糊:drop-shadow 的模糊半径按规范是标准差的两倍,gblur 的 sigma 取半径的一半。
 *
 * 什么时候看得见:预览里 filter 挂在素材元素上、外面一层框 overflow:hidden,而素材 cover 铺满这个框 ——
 * **不透明的素材(普通视频、jpg)投出去的影子全落在框外被裁掉,框内又被素材自己盖住,画面上一个像素都不变。**
 * 只有带透明通道的素材(抠好的 png、带 alpha 的视频)才看得出强调。所以调用方告诉这里素材有没有 alpha,
 * 没有就整个跳过 —— 结果和算了一样,省下每帧八趟全尺寸模糊。
 * ------------------------------------------------------------------------------------------- */
const EMPHASIS_DEFAULTS = {
  shadow: { color: "#000000", size: 18, opacity: 0.55, dx: 0, dy: 8 },
  outline: { color: "#ffffff", size: 6, opacity: 1, dx: 0, dy: 0 },
};
const clampNum = (v, lo, hi, d) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/**
 * 一串依次作用的 drop-shadow:[{ dx, dy, blur, color: [r,g,b,a] }](舞台像素,已乘 scale)。
 * 没有强调 / 参数无效返回 []。notes 用来回报颜色认不出来之类的降级。
 */
export function emphasisOps(raw, scale = 1, notes = []) {
  if (!raw || (raw.kind !== "shadow" && raw.kind !== "outline")) return [];
  const d = EMPHASIS_DEFAULTS[raw.kind];
  const n = {
    color: typeof raw.color === "string" && raw.color.trim() ? raw.color.trim() : d.color,
    size: clampNum(raw.size, 0, 80, d.size),
    opacity: clampNum(raw.opacity, 0, 1, d.opacity),
    dx: clampNum(raw.dx, -200, 200, d.dx),
    dy: clampNum(raw.dy, -200, 200, d.dy),
  };
  if (n.size <= 0 || n.opacity <= 0) return [];
  let rgba = parseCssColor(n.color);
  if (!rgba) {
    notes.push(`强调颜色「${n.color}」认不出来,按默认色 ${d.color} 合成`);
    rgba = parseCssColor(d.color);
  }
  // 和 emphasis.ts 的 tint 一样:不透明度取整到百分比,叠在颜色自己的 alpha 上
  const color = [rgba[0], rgba[1], rgba[2], n.opacity >= 1 ? rgba[3] : rgba[3] * (Math.round(n.opacity * 100) / 100)];
  // + 0 把 -0 变成 0:emphasis.ts 拼串时 -0 本来就写成 "0px"
  const px = (v) => +(v * scale).toFixed(2) + 0;
  if (raw.kind === "shadow") return [{ dx: px(n.dx), dy: px(n.dy), blur: px(n.size), color }];
  const r = n.size;
  const blur = r > 4 ? r * 0.2 : 0;
  const ops = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * 2 * Math.PI) / 8;
    ops.push({ dx: px(Math.cos(a) * r), dy: px(Math.sin(a) * r), blur: px(blur), color });
  }
  return ops;
}

const f3 = (v) => String(+Number(v).toFixed(6));

/**
 * 一串依次作用的 drop-shadow,在 w×h 的 gbrap 画面上。
 *
 * 同一个强调里每个影子的颜色、不透明度、模糊都一样(emphasisOps 保证),只有偏移不同,所以不必每层都在四个平面上
 * 叠一遍(实测八层描边这样做把整条合成从 55 fps 拖到 20 fps):
 *   - 只在 alpha 平面(灰度)上依次叠:第 k 层 = 上一层 over 它自己的影子。影子的 alpha = 模糊、平移后的上一层 alpha × 颜色 alpha,
 *     「over」的 alpha 公式 a + s(1 − a) 恰好就是 blend 的 screen 模式;
 *   - 叠完得到总的 alpha,配上纯色做成一整张影子,原图压在上面。
 * 和逐层全彩叠的差别只在原图半透明的边缘(那里算出来的影子略实一点),肉眼看不出。
 */
function emphasisChain(inLabel, outLabel, ops, w, h, k) {
  const [r, g, b, ca] = ops[0].color;
  const sigma = ops[0].blur > 0 ? ops[0].blur / 2 : 0;
  const L = (s) => `e${k}${s}`;
  const lines = [`[${inLabel}]split=3[${L("top")}][${L("col")}][${L("src")}]`, `[${L("src")}]alphaextract[${L("a0")}]`];
  ops.forEach((op, j) => {
    const dx = Math.round(op.dx);
    const dy = Math.round(op.dy);
    const pad = Math.max(Math.abs(dx), Math.abs(dy));
    const s = [];
    if (sigma > 0) s.push(`gblur=sigma=${f3(sigma)}`);
    if (pad > 0) s.push(`pad=${w + 2 * pad}:${h + 2 * pad}:${pad + dx}:${pad + dy}:color=black`, `crop=${w}:${h}:${pad}:${pad}`);
    s.push(`lut=c0=val*${f3(ca)}`);
    lines.push(
      `[${L(`a${j}`)}]split[${L(`p${j}`)}][${L(`q${j}`)}]`,
      `[${L(`q${j}`)}]${s.join(",")}[${L(`s${j}`)}]`,
      `[${L(`p${j}`)}][${L(`s${j}`)}]blend=all_mode=screen[${L(`a${j + 1}`)}]`,
    );
  });
  lines.push(
    `[${L("col")}]lutrgb=r=${r}:g=${g}:b=${b}[${L("rgb")}]`,
    `[${L("rgb")}][${L(`a${ops.length}`)}]alphamerge[${L("sh")}]`,
    // 影子在下、原图在上。overlay 在主画面带 alpha 时会一并合成 alpha
    `[${L("sh")}][${L("top")}]overlay=format=gbrp:alpha=straight[${outLabel}]`,
  );
  return lines;
}

/**
 * 拼整条 ffmpeg 参数。
 *
 * opts:
 *   width / height / fps / startFrame / endFrame —— 导出的画幅和帧区间(和 bakeFrames 的一致)
 *   cardsPattern —— 卡片透明层 PNG 序列(%06d),编号从 startFrame 起
 *   layers —— composeLayers 的结果,每项再补上:
 *       src: ffmpeg 能读的路径或 URL;没有就跳过(notes 里说明)
 *       hasAlpha: 素材有没有透明通道(决定强调算不算)
 *       colorSpace: ffprobe 的 color_space,未标注时按 untaggedMatrix 解
 *       decoder: 可选,强制解码器(带 alpha 的 VP9 要 libvpx-vp9 才解得出 alpha)
 *   mask —— 可选 { pattern, blur }:卡片毛玻璃(backdrop-filter)的遮罩序列。
 *       页面只渲卡片时,玻璃背后是透明的,模糊不到视频;这里把「灰底 + 素材」整幅按 blur 模糊一份,
 *       用遮罩(玻璃区域白、带着玻璃自己的不透明度)混回去,再叠卡片 —— 玻璃的底色、描边都在卡片层里。
 *   background —— 底色,默认 #333333(和以前 preview.mp4 的灰底一致)
 *   untaggedMatrix —— 没标色彩空间的视频按什么矩阵转 RGB,默认 bt709
 *   out —— 输出 mp4
 *
 * 返回 { args, graph, notes, used }:graph 单独给出,太长时调用方可以改用文件传。
 */
export function buildComposeArgs(opts) {
  const { width, height, fps, startFrame, endFrame, cardsPattern, out } = opts;
  const pixelLayer = (opts.layers || []).find((layer) => layer.pixelMap && !layer.missingMaterial);
  if (pixelLayer) throw new Error(`片段 ${pixelLayer.clip?.id || "(未知)"} 使用了像素映射,请用默认的 Chrome 导出(--media chrome);ffmpeg 兼容旁路不支持像素级映射`);
  const bg = opts.background || "#333333";
  const untagged = opts.untaggedMatrix || "bt709";
  const notes = [];
  const frames = endFrame - startFrame + 1;
  const dur = +(frames / fps).toFixed(3);
  const t0 = startFrame / fps;
  const args = ["-y", "-hide_banner", "-nostdin"];
  /*
   * 每个输入都带 -reinit_filter 0:输入帧的格式中途变了,不要重建整张滤镜图。
   * 实测卡片 PNG 会中途变格式 —— 整帧不透明时(比如一张铺满全屏的卡)Chrome 编出来的 PNG 省掉 alpha,
   * 从 rgba 变成 rgb24。ffmpeg 默认遇到这种变化就拆掉重建滤镜图:fps / trim / 各个 overlay 的同步状态全丢,
   * 实测一段 240 帧少掉 1~4 帧(每次不一样),整趟 60 秒的图还会在那一帧附近卡死。不重建时,
   * 接在输入后面的格式转换会按帧重新配置,画面是对的(和重建时逐像素比,均差 1.5/255 以内,是编码误差)。
   * 卡片 / 遮罩后面再显式接一个 format=rgba:第一帧恰好是 rgb24 时,协商出来的格式就不带 alpha,后面透明的帧会被压成不透明。
   */
  const R = ["-reinit_filter", "0"];
  // 输入 0:底色;1:卡片(或已经流式编码好的卡片视频);2:遮罩(可选);之后每段素材一个输入
  args.push(...R, "-f", "lavfi", "-i", `color=c=${bg}:s=${width}x${height}:r=${fps}:d=${dur}`);
  if (opts.cardsVideo) args.push(...R, "-i", opts.cardsVideo);
  else args.push(...R, "-framerate", String(fps), "-start_number", String(startFrame), "-i", cardsPattern);
  let next = 2;
  let maskIn = -1;
  if (opts.mask) {
    maskIn = next++;
    args.push(...R, "-framerate", String(fps), "-start_number", String(startFrame), "-i", opts.mask.pattern);
  }
  const graph = [];
  const used = [];
  // 随时间变化的滤镜要一份 sendcmd 脚本:这里只给出路径和内容,由调用方写盘(这个模块不碰磁盘)
  const sidecars = [];
  let base = "b0";
  graph.push(`[0:v]format=gbrp[b0]`);
  const stage = { width, height };
  for (const layer of opts.layers || []) {
    const { clip, media } = layer;
    const range = clipFrameRange(clip, fps, startFrame, endFrame);
    if (!range) continue;
    if (!layer.src && !layer.missingMaterial) {
      notes.push(`素材「${media.name || media.id}」找不到文件,片段 ${clip.id} 这一层没有画面`);
      continue;
    }
    const [a, b] = range;
    const ta = a / fps;
    const off = clip.mediaOffset ?? 0;
    const k = next++;
    const isMissing = !!layer.missingMaterial;
    const isImage = isMissing || media.kind === "image";
    const p = placement(clip.frame, stage);
    /*
     * 这一层先摆在**整条时间轴的绝对时间**上(帧号 = 导出帧号),淡入淡出、裁剪都按绝对时间写,最后才整体
     * 挪到段首 t0。反过来先挪的话,导出一段(--frames)时淡入的起点会是负数,fade 不收负的 st。
     */
    let shift;
    /** 变速的视频段:素材时间戳除以它(= 片段速度);其余为 1,setpts 的写法不变 */
    let ptsScale = 1;
    // 只要画面:素材自带的声音 / 字幕 / 数据流在解复用时就丢掉(声音由 mux-audio 另外混)
    args.push(...R, "-an", "-sn", "-dn");
    if (isMissing) {
      if (!opts.fontFile) throw new Error("确认缺失素材需要显式中文字体文件，不能跳过文字代理。");
      const len = (b - a + 2) / fps;
      args.push(...R, "-f", "lavfi", "-i", `color=c=0x20242b:s=${p.w}x${p.h}:r=${fps}:d=${len}`);
      shift = ta;
    } else if (isImage) {
      // 图片:循环成一段 fps 的流,第一帧摆在 a 帧上
      const len = (b - a + 2) / fps;
      args.push("-loop", "1", "-framerate", String(fps), "-t", f3(len), "-i", layer.src);
      shift = ta;
    } else {
      // 视频:-ss 放在 -i 前面快速定位;往前多留 0.5 秒,保证「≤ 目标时刻的最后一帧」也被解出来
      // (精确 seek 会丢掉 -ss 之前的帧,Chrome 在 a 帧显示的恰恰可能是它)。
      // -ss S 之后素材时刻 m 的时间戳是 m − S,落到时间轴上是 clip.start + (m − off) / speed(kernel/clipTime.mjs)。
      // 变速段:读的素材长度乘倍率,时间戳先除以倍率再平移;缺省 1 时下面每个式子和原来逐位相同
      const speed = clipSpeed(clip);
      const mt = mediaTimeAt(clip, ta);
      const ss = Math.max(0, mt - 0.5);
      const len = (b - a + 1) / fps * speed + (mt - ss) + 0.5;
      if (layer.decoder) args.push("-c:v", layer.decoder);
      args.push("-ss", f3(ss), "-t", f3(len), "-i", layer.src);
      shift = speed === 1 ? clip.start - off + ss : clip.start + (ss - off) / speed;
      if (speed !== 1) ptsScale = speed;
    }
    const chain = [
      ptsScale === 1 ? `setpts=PTS+${f3(shift)}/TB` : `setpts=PTS/${f3(ptsScale)}+${f3(shift)}/TB`,
      `fps=${fps}:round=up`,
      `trim=start_pts=${a}:end_pts=${b + 1}`,
    ];
    // cover:等比放大到盖满框,再居中裁。视频没标色彩空间时按 untagged 解(和 Chrome 对 HD 素材的假设一致)
    const matrix = !isImage && (!layer.colorSpace || layer.colorSpace === "unknown") ? `:in_color_matrix=${untagged}` : "";
    chain.push(`scale=${p.w}:${p.h}:force_original_aspect_ratio=increase${matrix}`, `crop=${p.w}:${p.h}`, "format=gbrap");
    if (isMissing) {
      const file = `${String(opts.sidecarDir || ".").replace(/\\/g, "/")}/missing-${k}.txt`;
      const name = String(layer.missingMaterialName || media.missingMaterial?.original?.name || media.name || media.id).replace(/[\r\n\u0000-\u001f]/g, " ")
        // 素材库里给缺失素材名字加的「(缺失) 」标记不上画面,只显示原来的名字(与 src/audio/missingMaterial.ts 的 missingMaterialLabel 一致)
        .replace(/^\(缺失\) (?=.)/, "");
      sidecars.push({ file, text: `找不到素材${name}` });
      const escapeFilterPath = (value) => String(value).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
      const quoted = escapeFilterPath(file);
      const font = escapeFilterPath(opts.fontFile);
      chain.push(`drawtext=textfile='${quoted}':fontfile='${font}':fontcolor=white:fontsize=${Math.max(16, Math.round(Math.min(p.w, p.h) / 16))}:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=0x20242b:boxborderw=18`);
    }
    /*
     * 滤镜(kernel/filters.mjs,和预览、see_frames 同一份数值):摆框之后、强调和不透明度之前 ——
     * CSS 里 filter 先于 opacity,强调的 drop-shadow 和滤镜写在同一个 filter 里、排在滤镜后面。
     * 模糊按框缩放之后的像素算(预览里 blur 写在框里、跟着框的 scale 一起缩放),和强调乘 p.scale 一个口径。
     */
    if (layer.filter) {
      const { def, params } = layer.filter;
      const d = clip.end - clip.start;
      if (isAnimated(def)) {
        // 逐帧改参数:sendcmd 接在 trim 之后,这里的时间戳就是时间轴的绝对时间(帧 i = i/fps)
        const tag = `fx${k}`;
        const frames = [];
        for (let i = a; i <= b; i++) frames.push({ ts: i / fps, t: i / fps - clip.start });
        const { script, blurPad } = sendcmdScript(def, params, d, frames, tag, p.scale, fps);
        const file = `${String(opts.sidecarDir || ".").replace(/\\/g, "/")}/filter-${k}.cmd`;
        sidecars.push({ file, text: script });
        // Windows 路径里的冒号是滤镜参数的分隔符:单引号 + \: 转义(和 subtitles 滤镜传路径同一个写法)。
        // 路径里的单引号会提前闭合引号,后面整条链都被当成 sendcmd 的选项(实测「Option not found」):
        // 关引号、\' 转义、再开引号。空格和中文实测都不用管
        const quoted = file.replace(/:/g, "\\:").replace(/'/g, "'\\''");
        chain.push(`sendcmd=f='${quoted}'`, ffmpegChain(ffmpegStages(resolveOps(def, params, ta - clip.start, d), p.scale), tag, blurPad));
      } else {
        const fx = ffmpegStaticChain(resolveOps(def, params, 0, d), p.scale);
        if (fx) chain.push(fx);
      }
    }
    const lines = [];
    let cur = `m${k}`;
    lines.push(`[${k}:v]${chain.join(",")}[${cur}]`);
    // 强调:只有带 alpha 的素材才看得见(理由见 emphasisOps 上面的注释)
    const ops = emphasisOps(clip.emphasis, p.scale, notes);
    if (ops.length) {
      if (layer.hasAlpha) {
        lines.push(...emphasisChain(cur, `m${k}e`, ops, p.w, p.h, k));
        cur = `m${k}e`;
      } else {
        notes.push(`片段 ${clip.id} 的强调没有合成:素材不透明,影子全在框外被裁掉,预览里同样看不见`);
      }
    }
    const tail = [];
    const opacity = clip.opacity ?? 1;
    if (opacity < 1) tail.push(`colorchannelmixer=aa=${f3(Math.max(0, opacity))}`);
    const fin = clip.fadeIn ?? 0;
    const fout = clip.fadeOut ?? 0;
    if (fin > 0) tail.push(`fade=t=in:st=${f3(Math.max(0, clip.start))}:d=${f3(fin)}:alpha=1`);
    if (fout > 0) tail.push(`fade=t=out:st=${f3(Math.max(0, clip.end - fout))}:d=${f3(fout)}:alpha=1`);
    if (p.rotate !== 0) tail.push(`rotate=a=${f3(p.rotate)}:ow=${p.ow}:oh=${p.oh}:c=none:bilinear=1`);
    // 摆回段首(见上面「绝对时间」那段)
    if (startFrame > 0) tail.push(`setpts=PTS-${f3(t0)}/TB`);
    if (tail.length) {
      lines.push(`[${cur}]${tail.join(",")}[m${k}t]`);
      cur = `m${k}t`;
    }
    const nb = `b${k}`;
    // eof_action=pass:这段放完之后主画面照常往下走;还没开始之前 overlay 本来就原样放行主画面
    lines.push(`[${base}][${cur}]overlay=x=${p.x}:y=${p.y}:eof_action=pass:format=gbrp[${nb}]`);
    graph.push(...lines);
    base = nb;
    used.push({ clipId: clip.id, input: k, frames: [a, b], x: p.x, y: p.y, w: p.w, h: p.h });
  }
  if (maskIn >= 0) {
    const sigma = Math.max(0, Number(opts.mask.blur) || 0);
    graph.push(
      `[${base}]split[gA][gB]`,
      `[gB]gblur=sigma=${f3(sigma)}[gBl]`,
      `[${maskIn}:v]format=rgba,alphaextract,format=gbrp[gM]`,
      `[gA][gBl][gM]maskedmerge[gOut]`,
    );
    base = "gOut";
  }
  // 卡片层照以前的方式叠:转成 yuv420p 之后按 overlay 默认的 yuv420 合 ——
  // 只有卡片、没有素材的地方和以前的 preview.mp4 逐像素一致
  graph.push(`[${base}]format=yuv420p[base]`, `[1:v]format=rgba[cards]`, `[base][cards]overlay=eof_action=endall[out]`);
  const g = graph.join(";");
  // 帧数用 -frames:v 卡死:按秒截(-t)时时长在三位小数取整,会多出或少一帧
  /*
   * 滤镜图太长就写成文件再用 -/filter_complex 读(ffmpeg 7 起的写法;-filter_complex_script 在 9 里已经没了):
   * Windows 的命令行上限是 32767 个字符,几段素材各挂一条 33 点的曲线就能逼近它。
   */
  const LONG_GRAPH = 12000;
  if (g.length > LONG_GRAPH) {
    const file = `${String(opts.sidecarDir || ".").replace(/\\/g, "/")}/filter-graph.txt`;
    sidecars.push({ file, text: g });
    args.push("-/filter_complex", file);
  } else args.push("-filter_complex", g);
  args.push("-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-frames:v", String(frames), out);
  return { args, graph: g, notes, used, sidecars };
}
