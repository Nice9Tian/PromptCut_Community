// node --test server/test/export-compose.test.mjs
// 完整导出的素材合成:filter graph 拼得对不对。只验纯函数,真跑 ffmpeg 的对账见 docs/archive/topics/decoupling-plan.md 阶段 6。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildComposeArgs, clipFrameRange, composeLayers, emphasisOps, parseCssColor, placement } from "../export-compose.mjs";

const { emphasisFilter } = await import("../../src/kernel/emphasis.ts");
const { frameCss } = await import("../../src/kernel/layout.ts");
const { videoLayersAt } = await import("../../src/kernel/project.ts");

const project = {
  width: 1920, height: 1080, fps: 30, duration: 60,
  media: [
    { id: "v1", kind: "video", name: "a.mp4", url: "/@media/a.mp4" },
    { id: "v2", kind: "video", name: "b.mp4", url: "/@media/b.mp4" },
    { id: "i1", kind: "image", name: "c.png", url: "/@media/c.png" },
    { id: "s1", kind: "audio", name: "d.mp3", url: "/@media/d.mp3" },
  ],
  tracks: [
    { id: "t0", name: "卡片", clips: [{ id: "k1", cardId: "punch-pill", start: 0, end: 5, params: {} }] },
    { id: "t1", name: "上", clips: [
      { id: "c2", mediaId: "v2", start: 18, end: 40, mediaOffset: 300, fadeIn: 2, params: {} },
      { id: "c4", mediaId: "i1", start: 45, end: 50, params: {}, frame: { x: 960, y: 540, w: 400, h: 300, anchor: [0.5, 0.5], scale: 0.5, rotate: 90 }, emphasis: { kind: "outline" } },
    ] },
    { id: "t2", name: "下", clips: [
      { id: "c1", mediaId: "v1", start: 0, end: 20, mediaOffset: 100, fadeOut: 2, opacity: 0.8, params: {} },
      { id: "c3", mediaId: "s1", start: 0, end: 60, params: {} },
    ] },
    { id: "t3", name: "藏起来", hidden: true, clips: [{ id: "c5", mediaId: "v1", start: 0, end: 60, params: {} }] },
  ],
};

test("composeLayers:叠放顺序和 videoLayersAt 一致(靠上的序列在上层),音频、隐藏序列不算", () => {
  const order = composeLayers(project).map((l) => l.clip.id);
  assert.deepEqual(order, ["c1", "c2", "c4"]);
  // 任取几个时刻,videoLayersAt 给出的层序必须是 composeLayers 顺序的子序列
  for (const t of [1, 19, 30, 46]) {
    const ids = videoLayersAt(project, t).map((l) => l.clip.id);
    const filtered = order.filter((id) => ids.includes(id));
    assert.deepEqual(ids, filtered, `t=${t}`);
  }
});

test("clipFrameRange:和 ExportView 的 i/fps 判定逐帧一致,浮点边界不错格", () => {
  for (const [start, end] of [[2.68, 42.68], [0, 20], [18, 40], [1 / 3, 2 / 3], [10.0333333, 10.1]]) {
    const clip = { start, end };
    const want = [];
    for (let i = 0; i < 1800; i++) if (i / 30 >= start && i / 30 < end) want.push(i);
    const r = clipFrameRange(clip, 30, 0, 1799);
    assert.deepEqual(r, want.length ? [want[0], want.at(-1)] : null, `${start}-${end}`);
  }
  assert.deepEqual(clipFrameRange({ start: 5, end: 10 }, 30, 200, 250), [200, 250], "被导出区间截断");
  assert.equal(clipFrameRange({ start: 5, end: 10 }, 30, 300, 400), null, "不在区间里");
});

test("placement:没有 frame 铺满;有 frame 时和 frameCss 摆出来的中心、尺寸一致", () => {
  assert.deepEqual(placement(undefined, { width: 1920, height: 1080 }), { w: 1920, h: 1080, ow: 1920, oh: 1080, x: 0, y: 0, rotate: 0, scale: 1 });
  const stage = { width: 1920, height: 1080 };
  const frames = [
    { x: 1400, y: 250, w: 800, h: 450, anchor: [0.5, 0.5], scale: 0.8, rotate: 6 },
    { x: 100, y: 100, w: 640, h: 360 },
    { x: 1920, y: 1080, w: 640, h: 360, anchor: [1, 1], scale: 1.5 },
    { x: 300, y: 700, w: 500, h: 500, anchor: [0, 0], rotate: -30, scale: 0.5 },
  ];
  for (const f of frames) {
    const css = frameCss(f, stage);
    // 用 CSS 的语义算变换后框中心:transform-origin 在锚点,先缩放后旋转(transform 串右边先作用)
    const [ox, oy] = [f.w * (f.anchor?.[0] ?? 0), f.h * (f.anchor?.[1] ?? 0)];
    const s = f.scale ?? 1;
    const th = ((f.rotate ?? 0) * Math.PI) / 180;
    const vx = (f.w / 2 - ox) * s, vy = (f.h / 2 - oy) * s;
    const cx = css.left + ox + vx * Math.cos(th) - vy * Math.sin(th);
    const cy = css.top + oy + vx * Math.sin(th) + vy * Math.cos(th);
    const p = placement(f, stage);
    assert.ok(Math.abs(p.x + p.ow / 2 - cx) <= 1 && Math.abs(p.y + p.oh / 2 - cy) <= 1, `中心 ${JSON.stringify(f)}: ${p.x + p.ow / 2},${p.y + p.oh / 2} vs ${cx},${cy}`);
    assert.equal(p.w, Math.round(f.w * s));
    assert.equal(p.h, Math.round(f.h * s));
  }
  const r = placement({ x: 960, y: 540, w: 400, h: 300, anchor: [0.5, 0.5], rotate: 90 }, stage);
  assert.equal(r.ow, 300, "转 90° 宽高对调");
  assert.equal(r.oh, 400);
});

test("parseCssColor:十六进制、rgb/rgba/hsl、颜色名;认不出返回 null", () => {
  assert.deepEqual(parseCssColor("#fff"), [255, 255, 255, 1]);
  assert.deepEqual(parseCssColor("#00000080"), [0, 0, 0, 128 / 255]);
  assert.deepEqual(parseCssColor("rgb(10 20 30)"), [10, 20, 30, 1]);
  assert.deepEqual(parseCssColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30, 0.5]);
  assert.deepEqual(parseCssColor("rgb(100% 0% 0% / 50%)"), [255, 0, 0, 0.5]);
  assert.deepEqual(parseCssColor("hsl(120, 100%, 50%)"), [0, 255, 0, 1]);
  assert.deepEqual(parseCssColor("White"), [255, 255, 255, 1]);
  assert.equal(parseCssColor("var(--pc-accent)"), null);
  assert.equal(parseCssColor(""), null);
});

/** 把 emphasisFilter 的 CSS 串拆回 [dx, dy, blur] 三元组 */
function cssShadows(s) {
  return [...s.matchAll(/drop-shadow\((-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px /g)].map((m) => m.slice(1, 4).map(Number));
}

test("emphasisOps:和 kernel/emphasis.ts 的 emphasisFilter 同一套数(偏移、模糊、层数、依次作用的顺序)", () => {
  const cases = [
    { kind: "shadow" },
    { kind: "shadow", color: "#123456", size: 10, opacity: 0.3, dx: -4, dy: 12 },
    { kind: "outline" },
    { kind: "outline", size: 3, color: "red" },
    { kind: "outline", size: 200, opacity: 2 }, // 越界要被夹住
  ];
  for (const e of cases) {
    for (const scale of [1, 0.5]) {
      const ops = emphasisOps(e, scale);
      assert.deepEqual(ops.map((o) => [o.dx, o.dy, o.blur]), cssShadows(emphasisFilter(e, scale)), JSON.stringify(e));
    }
  }
  assert.deepEqual(emphasisOps(null), []);
  assert.deepEqual(emphasisOps({ kind: "shadow", size: 0 }), []);
  assert.deepEqual(emphasisOps({ kind: "glow" }), []);
  // 颜色 × 不透明度(取整到百分比,和 tint 的 color-mix 一致)
  assert.deepEqual(emphasisOps({ kind: "shadow" })[0].color, [0, 0, 0, 0.55]);
  const notes = [];
  assert.deepEqual(emphasisOps({ kind: "outline", color: "var(--x)" }, 1, notes)[0].color, [255, 255, 255, 1]);
  assert.match(notes[0], /认不出来/);
});

function build(extra = {}) {
  const layers = composeLayers(project).map((l) => ({ ...l, src: `/m/${l.media.name}`, hasAlpha: l.media.kind === "image", colorSpace: "bt709" }));
  return buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 1799, cardsPattern: "f/%06d.png", layers, out: "o.mp4", ...extra });
}

test("buildComposeArgs:输入、定位、淡化、层序、卡片最后叠", () => {
  const { args, graph, used } = build();
  // 输入 0 灰底(和以前 preview.mp4 的灰底同一个串),1 卡片序列
  assert.equal(args[args.indexOf("-i") + 1], "color=c=#333333:s=1920x1080:r=30:d=60");
  const iIdx = args.reduce((acc, a, i) => (a === "-i" ? [...acc, i] : acc), []);
  assert.equal(args[iIdx[1] + 1], "f/%06d.png");
  // c1:素材第 100 秒起;往前多留 0.5 秒 → -ss 99.5,放在 -i 前面
  const c1 = iIdx[2];
  assert.deepEqual(args.slice(c1 - 4, c1 + 2), ["-ss", "99.5", "-t", String(+(600 / 30 + 0.5 + 0.5).toFixed(6)), "-i", "/m/a.mp4"]);
  // c2:18 秒进、素材 300 秒;-ss 299.5 → 时间戳平移 18 − 300 + 299.5 = 17.5
  assert.match(graph, /\[3:v\]setpts=PTS\+17\.5\/TB,fps=30:round=up,trim=start_pts=540:end_pts=1200,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=gbrap\[m3\]/);
  assert.match(graph, /\[m3\]fade=t=in:st=18:d=2:alpha=1\[m3t\]/);
  // c1:整体 0.8 + 淡出 18~20 秒
  assert.match(graph, /\[m2\]colorchannelmixer=aa=0\.8,fade=t=out:st=18:d=2:alpha=1\[m2t\]/);
  // 层序:c1 先叠(下),c2 叠在它上面,c4 最上
  assert.deepEqual(used.map((u) => u.clipId), ["c1", "c2", "c4"]);
  assert.ok(graph.indexOf("[b0][m2t]overlay") < graph.indexOf("[b2][m3t]overlay"));
  // 图片:循环输入,不带 -ss;有 frame → 缩放到 200×150、转 90°、强调八层依次叠
  const c4 = iIdx[4];
  assert.deepEqual(args.slice(c4 - 6, c4 + 2), ["-loop", "1", "-framerate", "30", "-t", String(+(151 / 30).toFixed(6)), "-i", "/m/c.png"]);
  assert.match(graph, /scale=200:150:force_original_aspect_ratio=increase,crop=200:150,format=gbrap\[m4\]/);
  // 描边八层在 alpha 平面上依次叠(screen = over 的 alpha 公式),叠完配色、原图压在上面,之后才旋转
  assert.equal((graph.match(/blend=all_mode=screen/g) || []).length, 8, "八层描边依次叠");
  assert.match(graph, /\[m4\]split=3\[e4top\]\[e4col\]\[e4src\];\[e4src\]alphaextract\[e4a0\]/, "第一层从素材本身的 alpha 起");
  // 描边 6px 的模糊半径 1.2px,框缩放 0.5 → 0.6px,sigma 取一半
  assert.match(graph, /\[e4a7\]split\[e4p7\]\[e4q7\];\[e4q7\]gblur=sigma=0\.3,pad=/, "第八层叠在第七层的结果上");
  assert.match(graph, /lut=c0=val\*1\[e4s7\];\[e4p7\]\[e4s7\]blend=all_mode=screen\[e4a8\]/);
  assert.match(graph, /\[e4col\]lutrgb=r=255:g=255:b=255\[e4rgb\];\[e4rgb\]\[e4a8\]alphamerge\[e4sh\];\[e4sh\]\[e4top\]overlay=format=gbrp:alpha=straight\[m4e\];\[m4e\]rotate=/);
  assert.match(graph, /rotate=a=1\.570796:ow=150:oh=200:c=none/);
  assert.match(graph, /overlay=x=885:y=440:eof_action=pass:format=gbrp\[b4\]/);
  // 卡片层最后叠,和以前一样按 overlay 默认的 yuv420 合、endall 收尾
  assert.match(graph, /\[b4\]format=yuv420p\[base\];\[1:v\]format=rgba\[cards\];\[base\]\[cards\]overlay=eof_action=endall\[out\]$/);
  // 每个输入都不许中途重建滤镜图(卡片 PNG 整帧不透明时会从 rgba 变成 rgb24)
  assert.equal(args.filter((a) => a === "-reinit_filter").length, iIdx.length);
  for (const i of iIdx) assert.ok(args.slice(Math.max(0, i - 12), i).includes("-reinit_filter"), `输入 ${args[i + 1]}`);
  assert.deepEqual(args.slice(-9), ["-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-frames:v", "1800", "o.mp4"]);
});

test("buildComposeArgs:导出一段(--frames)—— 层内按绝对时间淡化裁剪,最后整体挪到段首;不在段里的素材不开输入", () => {
  const { args, graph, used } = build({ startFrame: 900, endFrame: 1049 });
  assert.deepEqual(used.map((u) => u.clipId), ["c2"], "30~35 秒只有 c2");
  assert.equal(args.filter((a) => a === "-i").length, 3);
  // 段首 30 秒 → 素材 312 秒;-ss 311.5 → 摆到绝对时间 18 − 300 + 311.5 = 29.5
  assert.match(graph, /setpts=PTS\+29\.5\/TB,fps=30:round=up,trim=start_pts=900:end_pts=1050/);
  // 淡入的起点是片段自己的 18 秒,不会因为段首在 30 秒变成负数(fade 不收负的 st)
  assert.match(graph, /fade=t=in:st=18:d=2:alpha=1,setpts=PTS-30\/TB\[m2t\]/);
  assert.ok(!/st=-/.test(graph));
  assert.equal(args[args.indexOf("-i") + 1], "color=c=#333333:s=1920x1080:r=30:d=5");
});

test("buildComposeArgs:不透明素材的强调不合成(框外被裁、框内被盖),带 alpha 的才合成;没有文件的段跳过并说明", () => {
  const layers = composeLayers(project).map((l) => ({ ...l, src: l.clip.id === "c2" ? null : `/m/${l.media.name}`, hasAlpha: false, colorSpace: "unknown" }));
  const { graph, notes, used } = buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 1799, cardsPattern: "f/%06d.png", layers, out: "o.mp4" });
  assert.ok(!graph.includes("lutrgb"), "没有 alpha 就不算影子");
  assert.ok(notes.some((n) => /c4 的强调没有合成/.test(n)));
  assert.ok(notes.some((n) => /b\.mp4.*没有画面/.test(n)));
  assert.deepEqual(used.map((u) => u.clipId), ["c1", "c4"]);
  // 没标色彩空间的视频按 bt709 解
  assert.match(graph, /in_color_matrix=bt709/);
});

test("buildComposeArgs:毛玻璃遮罩 —— 整幅模糊一份,按遮罩的 alpha 混回去,再叠卡片", () => {
  const { args, graph } = build({ mask: { pattern: "k/%06d.png", blur: 24 } });
  const iIdx = args.reduce((acc, a, i) => (a === "-i" ? [...acc, i] : acc), []);
  assert.equal(args[iIdx[2] + 1], "k/%06d.png");
  assert.match(graph, /\[b5\]split\[gA\]\[gB\];\[gB\]gblur=sigma=24\[gBl\];\[2:v\]format=rgba,alphaextract,format=gbrp\[gM\];\[gA\]\[gBl\]\[gM\]maskedmerge\[gOut\];\[gOut\]format=yuv420p\[base\]/);
});

test("buildComposeArgs:没有素材时就是灰底 + 卡片", () => {
  const { graph } = buildComposeArgs({ width: 1280, height: 720, fps: 25, startFrame: 0, endFrame: 99, cardsPattern: "f/%06d.png", layers: [], out: "o.mp4" });
  assert.equal(graph, "[0:v]format=gbrp[b0];[b0]format=yuv420p[base];[1:v]format=rgba[cards];[base][cards]overlay=eof_action=endall[out]");
});

test("buildComposeArgs:显式 confirmed-missing 走原框文字代理并保留淡化", () => {
  const media = { ...project.media[0], kind: "video", name: "采访.mp4", url: "/@media/a.mp4", missingMaterial: { v: 1, mediaId: "v1", original: { kind: "video", name: "采访.mp4", url: "/@media/a.mp4" }, reason: "confirmed-missing", visual: true, audio: true } };
  const layers = [{ clip: { id: "lost", mediaId: "v1", start: 1, end: 3, opacity: .6, fadeIn: .5, fadeOut: .25,
    frame: { x: 12, y: 20, w: 640, h: 360, anchor: [0, 0], scale: 1, rotate: 0 } }, media, src: null, missingMaterial: true }];
  const { args, graph, notes, used, sidecars } = buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 89, cardsPattern: "f/%06d.png", layers, out: "o.mp4", sidecarDir: "tmp", fontFile: "C:/Windows/Fonts/msyh.ttc" });
  assert.ok(args.includes("color=c=0x20242b:s=640x360:r=30:d=2.033333333333333"));
  assert.match(graph, /drawtext=textfile='tmp\/missing-2\.txt':fontfile='C\\:\/Windows\/Fonts\/msyh\.ttc'/);
  assert.match(graph, /colorchannelmixer=aa=0\.6/);
  assert.match(graph, /fade=t=in/); assert.match(graph, /fade=t=out/);
  assert.deepEqual(used.map((x) => x.clipId), ["lost"]);
  assert.deepEqual(sidecars, [{ file: "tmp/missing-2.txt", text: "找不到素材采访.mp4" }]);
  assert.deepEqual(notes, []);
});

test("buildComposeArgs:缺少显式字体时不静默省略 confirmed-missing 文字代理", () => {
  const media = { ...project.media[0], kind: "video", name: "lost.mp4", url: "/@media/a.mp4", missingMaterial: { v: 1, mediaId: "v1", original: { kind: "video", name: "lost.mp4", url: "/@media/a.mp4" }, reason: "confirmed-missing", visual: true, audio: true } };
  const layers = [{ clip: { id: "lost", mediaId: "v1", start: 0, end: 1, frame: { x: 0, y: 0, w: 640, h: 360, anchor: [0, 0], scale: 1, rotate: 0 } }, media, src: null, missingMaterial: true }];
  assert.throws(() => buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 29, cardsPattern: "f/%06d.png", layers, out: "o.mp4" }), /需要显式中文字体文件/);
});
