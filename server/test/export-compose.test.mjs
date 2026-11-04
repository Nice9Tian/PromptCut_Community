// node --test server/test/export-compose.test.mjs
// Asset composition for full export: whether filter graph is assembled correctly.
// Only tests pure functions; for reconciliation running actual ffmpeg, see
// docs/archive/topics/decoupling-plan.md Phase 6.
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
    { id: "t0", name: "Cards", clips: [{ id: "k1", cardId: "punch-pill", start: 0, end: 5, params: {} }] },
    { id: "t1", name: "Upper", clips: [
      { id: "c2", mediaId: "v2", start: 18, end: 40, mediaOffset: 300, fadeIn: 2, params: {} },
      { id: "c4", mediaId: "i1", start: 45, end: 50, params: {}, frame: { x: 960, y: 540, w: 400, h: 300, anchor: [0.5, 0.5], scale: 0.5, rotate: 90 }, emphasis: { kind: "outline" } },
    ] },
    { id: "t2", name: "Lower", clips: [
      { id: "c1", mediaId: "v1", start: 0, end: 20, mediaOffset: 100, fadeOut: 2, opacity: 0.8, params: {} },
      { id: "c3", mediaId: "s1", start: 0, end: 60, params: {} },
    ] },
    { id: "t3", name: "Hidden", hidden: true, clips: [{ id: "c5", mediaId: "v1", start: 0, end: 60, params: {} }] },
  ],
};

test("composeLayers: the stacking order matches videoLayersAt (a higher track is on an upper layer); audio and hidden tracks do not count", () => {
  const order = composeLayers(project).map((l) => l.clip.id);
  assert.deepEqual(order, ["c1", "c2", "c4"]);
  // At any arbitrary moments, layer order given by videoLayersAt must be a subsequence of composeLayers order
  for (const t of [1, 19, 30, 46]) {
    const ids = videoLayersAt(project, t).map((l) => l.clip.id);
    const filtered = order.filter((id) => ids.includes(id));
    assert.deepEqual(ids, filtered, `t=${t}`);
  }
});

test("clipFrameRange: matches ExportView's i/fps check frame by frame, with no off-by-one at floating-point boundaries", () => {
  for (const [start, end] of [[2.68, 42.68], [0, 20], [18, 40], [1 / 3, 2 / 3], [10.0333333, 10.1]]) {
    const clip = { start, end };
    const want = [];
    for (let i = 0; i < 1800; i++) if (i / 30 >= start && i / 30 < end) want.push(i);
    const r = clipFrameRange(clip, 30, 0, 1799);
    assert.deepEqual(r, want.length ? [want[0], want.at(-1)] : null, `${start}-${end}`);
  }
  assert.deepEqual(clipFrameRange({ start: 5, end: 10 }, 30, 200, 250), [200, 250], "truncated by the export range");
  assert.equal(clipFrameRange({ start: 5, end: 10 }, 30, 300, 400), null, "not in the range");
});

test("placement: fills the whole output when there is no frame; with a frame, the center and size match what frameCss lays out", () => {
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
    // Compute transformed box center using CSS semantics: transform-origin at anchor point,
    // scale first then rotate (right side of transform string applies first)
    const [ox, oy] = [f.w * (f.anchor?.[0] ?? 0), f.h * (f.anchor?.[1] ?? 0)];
    const s = f.scale ?? 1;
    const th = ((f.rotate ?? 0) * Math.PI) / 180;
    const vx = (f.w / 2 - ox) * s, vy = (f.h / 2 - oy) * s;
    const cx = css.left + ox + vx * Math.cos(th) - vy * Math.sin(th);
    const cy = css.top + oy + vx * Math.sin(th) + vy * Math.cos(th);
    const p = placement(f, stage);
    assert.ok(Math.abs(p.x + p.ow / 2 - cx) <= 1 && Math.abs(p.y + p.oh / 2 - cy) <= 1, `center ${JSON.stringify(f)}: ${p.x + p.ow / 2},${p.y + p.oh / 2} vs ${cx},${cy}`);
    assert.equal(p.w, Math.round(f.w * s));
    assert.equal(p.h, Math.round(f.h * s));
  }
  const r = placement({ x: 960, y: 540, w: 400, h: 300, anchor: [0.5, 0.5], rotate: 90 }, stage);
  assert.equal(r.ow, 300, "rotated 90°: width and height swap");
  assert.equal(r.oh, 400);
});

test("parseCssColor: hex, rgb/rgba/hsl, color names; unrecognized input returns null", () => {
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

/** Unpack CSS string of emphasisFilter back into [dx, dy, blur] tuple */
function cssShadows(s) {
  return [...s.matchAll(/drop-shadow\((-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px /g)].map((m) => m.slice(1, 4).map(Number));
}

test("emphasisOps: the same numbers as emphasisFilter in kernel/emphasis.ts (offset, blur, layer count, order of application)", () => {
  const cases = [
    { kind: "shadow" },
    { kind: "shadow", color: "#123456", size: 10, opacity: 0.3, dx: -4, dy: 12 },
    { kind: "outline" },
    { kind: "outline", size: 3, color: "red" },
    { kind: "outline", size: 200, opacity: 2 }, // Out-of-bounds must be clamped
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
  // Color × opacity (rounded to percentage, consistent with tint color-mix)
  assert.deepEqual(emphasisOps({ kind: "shadow" })[0].color, [0, 0, 0, 0.55]);
  const notes = [];
  assert.deepEqual(emphasisOps({ kind: "outline", color: "var(--x)" }, 1, notes)[0].color, [255, 255, 255, 1]);
  assert.match(notes[0], /not recognized/);
});

function build(extra = {}) {
  const layers = composeLayers(project).map((l) => ({ ...l, src: `/m/${l.media.name}`, hasAlpha: l.media.kind === "image", colorSpace: "bt709" }));
  return buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 1799, cardsPattern: "f/%06d.png", layers, out: "o.mp4", ...extra });
}

test("buildComposeArgs: inputs, positioning, fades, layer order, cards stacked last", () => {
  const { args, graph, used } = build();
  // Input 0 gray background (same string as previous preview.mp4 gray background), 1 card sequence
  assert.equal(args[args.indexOf("-i") + 1], "color=c=#333333:s=1920x1080:r=30:d=60");
  const iIdx = args.reduce((acc, a, i) => (a === "-i" ? [...acc, i] : acc), []);
  assert.equal(args[iIdx[1] + 1], "f/%06d.png");
  // c1: asset starts at second 100; leave 0.5s padding ahead → -ss 99.5, placed before -i
  const c1 = iIdx[2];
  assert.deepEqual(args.slice(c1 - 4, c1 + 2), ["-ss", "99.5", "-t", String(+(600 / 30 + 0.5 + 0.5).toFixed(6)), "-i", "/m/a.mp4"]);
  // c2: enters at 18s, asset 300s; -ss 299.5 → timestamp shift 18 − 300 + 299.5 = 17.5
  assert.match(graph, /\[3:v\]setpts=PTS\+17\.5\/TB,fps=30:round=up,trim=start_pts=540:end_pts=1200,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=gbrap\[m3\]/);
  assert.match(graph, /\[m3\]fade=t=in:st=18:d=2:alpha=1\[m3t\]/);
  // c1: overall 0.8 + fade out 18–20s
  assert.match(graph, /\[m2\]colorchannelmixer=aa=0\.8,fade=t=out:st=18:d=2:alpha=1\[m2t\]/);
  // Layer order: c1 layered first (bottom), c2 layered on top of it, c4 on top
  assert.deepEqual(used.map((u) => u.clipId), ["c1", "c2", "c4"]);
  assert.ok(graph.indexOf("[b0][m2t]overlay") < graph.indexOf("[b2][m3t]overlay"));
  // Image: loop input, without -ss; has frame → scaled to 200×150, rotated 90°,
  // eight emphasis layers stacked in order
  const c4 = iIdx[4];
  assert.deepEqual(args.slice(c4 - 6, c4 + 2), ["-loop", "1", "-framerate", "30", "-t", String(+(151 / 30).toFixed(6)), "-i", "/m/c.png"]);
  assert.match(graph, /scale=200:150:force_original_aspect_ratio=increase,crop=200:150,format=gbrap\[m4\]/);
  // Eight stroke layers stacked sequentially on alpha plane (screen = over alpha formula);
  // colored after stacking, original image pressed on top, rotated afterwards
  assert.equal((graph.match(/blend=all_mode=screen/g) || []).length, 8, "eight outline layers stacked in turn");
  assert.match(graph, /\[m4\]split=3\[e4top\]\[e4col\]\[e4src\];\[e4src\]alphaextract\[e4a0\]/, "the first layer starts from the media's own alpha");
  // 6px stroke has blur radius 1.2px, box scale 0.5 → 0.6px, sigma halved
  assert.match(graph, /\[e4a7\]split\[e4p7\]\[e4q7\];\[e4q7\]gblur=sigma=0\.3,pad=/, "the eighth layer is stacked on the result of the seventh layer");
  assert.match(graph, /lut=c0=val\*1\[e4s7\];\[e4p7\]\[e4s7\]blend=all_mode=screen\[e4a8\]/);
  assert.match(graph, /\[e4col\]lutrgb=r=255:g=255:b=255\[e4rgb\];\[e4rgb\]\[e4a8\]alphamerge\[e4sh\];\[e4sh\]\[e4top\]overlay=format=gbrp:alpha=straight\[m4e\];\[m4e\]rotate=/);
  assert.match(graph, /rotate=a=1\.570796:ow=150:oh=200:c=none/);
  assert.match(graph, /overlay=x=885:y=440:eof_action=pass:format=gbrp\[b4\]/);
  // Card layer stacked last, merged via overlay default yuv420 as before, finalized with endall
  assert.match(graph, /\[b4\]format=yuv420p\[base\];\[1:v\]format=rgba\[cards\];\[base\]\[cards\]overlay=eof_action=endall\[out\]$/);
  // No input may rebuild filter graph midway (card PNG turns from rgba to rgb24 when entire frame is opaque)
  assert.equal(args.filter((a) => a === "-reinit_filter").length, iIdx.length);
  for (const i of iIdx) assert.ok(args.slice(Math.max(0, i - 12), i).includes("-reinit_filter"), `input ${args[i + 1]}`);
  assert.deepEqual(args.slice(-9), ["-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-frames:v", "1800", "o.mp4"]);
});

test("buildComposeArgs: export one segment (--frames): within a layer, fading and trimming follow absolute time, and everything is shifted to the segment start at the end; media outside the segment opens no input", () => {
  const { args, graph, used } = build({ startFrame: 900, endFrame: 1049 });
  assert.deepEqual(used.map((u) => u.clipId), ["c2"], "only c2 in 30~35 s");
  assert.equal(args.filter((a) => a === "-i").length, 3);
  // Clip start 30s → asset 312s; -ss 311.5 → placed at absolute time 18 − 300 + 311.5 = 29.5
  assert.match(graph, /setpts=PTS\+29\.5\/TB,fps=30:round=up,trim=start_pts=900:end_pts=1050/);
  // Fade-in start is clip's own 18s, will not become negative because clip start is at 30s
  // (fade does not accept negative st)
  assert.match(graph, /fade=t=in:st=18:d=2:alpha=1,setpts=PTS-30\/TB\[m2t\]/);
  assert.ok(!/st=-/.test(graph));
  assert.equal(args[args.indexOf("-i") + 1], "color=c=#333333:s=1920x1080:r=30:d=5");
});

test("buildComposeArgs: emphasis on opaque media is not composited (it is cropped outside the frame and covered inside the frame), only media with alpha is composited; a clip without a file is skipped with a note", () => {
  const layers = composeLayers(project).map((l) => ({ ...l, src: l.clip.id === "c2" ? null : `/m/${l.media.name}`, hasAlpha: false, colorSpace: "unknown" }));
  const { graph, notes, used } = buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 1799, cardsPattern: "f/%06d.png", layers, out: "o.mp4" });
  assert.ok(!graph.includes("lutrgb"), "without alpha, no shadow is computed");
  assert.ok(notes.some((n) => /Emphasis of clip c4 was not composited/.test(n)));
  assert.ok(notes.some((n) => /b\.mp4.*no picture/.test(n)));
  assert.deepEqual(used.map((u) => u.clipId), ["c1", "c4"]);
  // Videos without labeled color space decoded as bt709
  assert.match(graph, /in_color_matrix=bt709/);
});

test("buildComposeArgs: frosted glass mask: blur one copy of the whole frame, blend it back by the mask's alpha, then stack the cards", () => {
  const { args, graph } = build({ mask: { pattern: "k/%06d.png", blur: 24 } });
  const iIdx = args.reduce((acc, a, i) => (a === "-i" ? [...acc, i] : acc), []);
  assert.equal(args[iIdx[2] + 1], "k/%06d.png");
  assert.match(graph, /\[b5\]split\[gA\]\[gB\];\[gB\]gblur=sigma=24\[gBl\];\[2:v\]format=rgba,alphaextract,format=gbrp\[gM\];\[gA\]\[gBl\]\[gM\]maskedmerge\[gOut\];\[gOut\]format=yuv420p\[base\]/);
});

test("buildComposeArgs: with no media, it is a gray background + cards", () => {
  const { graph } = buildComposeArgs({ width: 1280, height: 720, fps: 25, startFrame: 0, endFrame: 99, cardsPattern: "f/%06d.png", layers: [], out: "o.mp4" });
  assert.equal(graph, "[0:v]format=gbrp[b0];[b0]format=yuv420p[base];[1:v]format=rgba[cards];[base][cards]overlay=eof_action=endall[out]");
});

test("buildComposeArgs: an explicit confirmed-missing goes through the text proxy in the original box and keeps the fade", () => {
  const media = { ...project.media[0], kind: "video", name: "采访.mp4", url: "/@media/a.mp4", missingMaterial: { v: 1, mediaId: "v1", original: { kind: "video", name: "采访.mp4", url: "/@media/a.mp4" }, reason: "confirmed-missing", visual: true, audio: true } };
  const layers = [{ clip: { id: "lost", mediaId: "v1", start: 1, end: 3, opacity: .6, fadeIn: .5, fadeOut: .25,
    frame: { x: 12, y: 20, w: 640, h: 360, anchor: [0, 0], scale: 1, rotate: 0 } }, media, src: null, missingMaterial: true }];
  const { args, graph, notes, used, sidecars } = buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 89, cardsPattern: "f/%06d.png", layers, out: "o.mp4", sidecarDir: "tmp", fontFile: "C:/Windows/Fonts/msyh.ttc" });
  assert.ok(args.includes("color=c=0x20242b:s=640x360:r=30:d=2.033333333333333"));
  assert.match(graph, /drawtext=textfile='tmp\/missing-2\.txt':fontfile='C\\:\/Windows\/Fonts\/msyh\.ttc'/);
  assert.match(graph, /colorchannelmixer=aa=0\.6/);
  assert.match(graph, /fade=t=in/); assert.match(graph, /fade=t=out/);
  assert.deepEqual(used.map((x) => x.clipId), ["lost"]);
  assert.deepEqual(sidecars, [{ file: "tmp/missing-2.txt", text: "Media not found: 采访.mp4" }]);
  assert.deepEqual(notes, []);
});

test("buildComposeArgs: without an explicit font, the confirmed-missing text proxy is not silently omitted", () => {
  const media = { ...project.media[0], kind: "video", name: "lost.mp4", url: "/@media/a.mp4", missingMaterial: { v: 1, mediaId: "v1", original: { kind: "video", name: "lost.mp4", url: "/@media/a.mp4" }, reason: "confirmed-missing", visual: true, audio: true } };
  const layers = [{ clip: { id: "lost", mediaId: "v1", start: 0, end: 1, frame: { x: 0, y: 0, w: 640, h: 360, anchor: [0, 0], scale: 1, rotate: 0 } }, media, src: null, missingMaterial: true }];
  assert.throws(() => buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 29, cardsPattern: "f/%06d.png", layers, out: "o.mp4" }), /requires an explicit Chinese font file/);
});
