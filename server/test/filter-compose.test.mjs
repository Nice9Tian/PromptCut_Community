// 滤镜进导出和 see_frames 的 ffmpeg 链:链上的位置、逐帧命令的 sidecar,以及真跑一遍 ffmpeg
// (sendcmd 的 Windows 路径转义、lutrgb / colorchannelmixer / gblur 在链上能不能起来)。
// 跑法:node --test server/test/filter-compose.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildComposeArgs, composeLayers } from "../export-compose.mjs";
import { extractArgs, mediaLayersAt } from "../vision-compose.mjs";

const FILTERS = [
  { id: "fx-s", name: "冷调", ops: [{ kind: "saturate", value: 0.6 }, { kind: "hue", value: -20 }, { kind: "brightness", value: 1 }] },
  { id: "fx-a", name: "渐糊", ops: [{ kind: "blur", value: "4*p" }, { kind: "brightness", value: "1 + 0.5*t" }] },
];

function project() {
  return {
    width: 320, height: 180, fps: 10, filters: FILTERS,
    media: [{ id: "m", kind: "video", name: "m.mp4", url: "/media/m.mp4" }],
    tracks: [{ id: "t", name: "v", clips: [
      { id: "c1", cardId: "", params: {}, mediaId: "m", start: 0, end: 1, filter: { id: "fx-s" } },
      { id: "c2", cardId: "", params: {}, mediaId: "m", start: 1, end: 2, filter: { id: "fx-a" } },
      { id: "c3", cardId: "", params: {}, mediaId: "m", start: 2, end: 3, filter: { id: "fx-gone" } },
    ] }],
  };
}

function compose(p, sidecarDir) {
  const layers = composeLayers(p).map((l) => ({ ...l, src: "IN.mp4" }));
  return buildComposeArgs({ width: p.width, height: p.height, fps: p.fps, startFrame: 0, endFrame: 29, layers, cardsPattern: "cards/%06d.png", out: "o.mp4", sidecarDir });
}

// 输入编号:0 底色、1 卡片,素材从 2 起(没有毛玻璃遮罩)。c1 → 2,c2 → 3,c3 → 4
test("导出:常量滤镜接在 format=gbrap 之后、强调 / 不透明度之前;中性步骤不上链", () => {
  const { graph, sidecars } = compose(project(), "C:\\out dir");
  const c1 = graph.split(";").find((s) => s.startsWith("[2:v]"));
  assert.match(c1, /format=gbrap,colorchannelmixer=rr=[^,]+,colorchannelmixer=rr=[^,]+\[m2\]$/, "saturate + hue 两步,brightness 1 是中性不上链");
  assert.doesNotMatch(c1, /lutrgb/);
  // 删掉了定义的滤镜:按没滤镜合成,不报错
  const c3 = graph.split(";").find((s) => s.startsWith("[4:v]"));
  assert.match(c3, /format=gbrap\[m4\]$/);
  assert.equal(sidecars.length, 1);
});

test("导出:随时间变化的滤镜走 sendcmd,脚本按帧一行、路径转义冒号", () => {
  const { graph, sidecars } = compose(project(), "C:\\out dir");
  const c2 = graph.split(";").find((s) => s.startsWith("[3:v]"));
  assert.match(c2, /trim=start_pts=10:end_pts=20,.*format=gbrap,sendcmd=f='C\\:\/out dir\/filter-3\.cmd',premultiply/);
  // 模糊 4p 在最后一帧(p = 0.9)最大:σ 3.6 → 补边 ceil(10.8) = 11
  assert.match(c2, /premultiply=inplace=1,pad=iw\+22:ih\+22:11:11:color=black@0,gblur@fx3_0=sigma=0:steps=6,crop=iw-22:ih-22:11:11,unpremultiply=inplace=1,lutrgb@fx3_1=/);
  const [side] = sidecars;
  assert.equal(side.file, "C:/out dir/filter-3.cmd");
  const lines = side.text.trim().split("\n");
  assert.equal(lines.length, 10, "片段 1~2 秒,10fps 共 10 帧");
  assert.match(lines[0], /^0\.975 gblur@fx3_0 sigma 0, lutrgb@fx3_1 r val\*1\+0\.5,/);
  assert.match(lines[9], /^1\.875 gblur@fx3_0 sigma 3\.6, lutrgb@fx3_1 r val\*1\.45\+0\.5,/);
});

test("see_frames:这一刻的滤镜翻成常量,接在 rgba 之后、不透明度之前", () => {
  const layers = mediaLayersAt(project(), 1.5);
  assert.equal(layers.length, 1);
  assert.match(layers[0].filter, /^premultiply=inplace=1,pad=.*gblur=sigma=2:steps=6.*lutrgb=r=val\*1\.25\+0\.5/);
  const args = extractArgs({ file: "x.mp4", kind: "video", seconds: 0, width: 320, height: 180, opacity: 0.5, filter: layers[0].filter, out: "o.png" });
  const vf = args[args.indexOf("-vf") + 1];
  assert.match(vf, /format=rgba,premultiply=.*lutrgb=[^,]+,colorchannelmixer=aa=0\.5000$/);
  assert.equal(mediaLayersAt(project(), 2.5)[0].filter, undefined, "定义被删的滤镜不上链");
});

const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;

test("真跑 ffmpeg:整条导出链带逐帧滤镜能出片,sendcmd 真的改了参数", { skip: !hasFfmpeg && "没有 ffmpeg" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-fx-"));
  try {
    // 素材:一段纯中灰,好量亮度;卡片层:全透明 PNG 序列
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x808080:s=320x180:r=10:d=4", "-pix_fmt", "yuv444p", "-y", path.join(dir, "in.mp4")]);
    fs.mkdirSync(path.join(dir, "cards"));
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black@0:s=320x180:r=10:d=3,format=rgba", "-start_number", "0", "-y", path.join(dir, "cards", "%06d.png")]);
    const p = project();
    const layers = composeLayers(p).map((l) => ({ ...l, src: path.join(dir, "in.mp4"), colorSpace: "bt709" }));
    const { args, sidecars } = buildComposeArgs({
      width: 320, height: 180, fps: 10, startFrame: 0, endFrame: 29, layers,
      cardsPattern: path.join(dir, "cards", "%06d.png"), out: path.join(dir, "o.mp4"), sidecarDir: dir, background: "#000000",
    });
    for (const s of sidecars) fs.writeFileSync(s.file, s.text);
    // 出成逐帧 PNG 而不是 mp4:要量像素,不能让 yuv420 编码的误差混进来
    const k = args.indexOf("-c:v");
    const pngArgs = [...args.slice(0, k), "-frames:v", "30", "-y", path.join(dir, "f%02d.png")];
    const r = spawnSync("ffmpeg", pngArgs, { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr.slice(-800));
    const gray = (i) => {
      const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path.join(dir, `f${String(i + 1).padStart(2, "0")}.png`), "-vf", "crop=1:1:160:90,format=rgb24", "-f", "rawvideo", "-"]);
      return out[0];
    };
    // 片段 2(1~2 秒)亮度 1 + 0.5t:第 10 帧 t=0 → 128;第 19 帧 t=0.9 → 128×1.45 ≈ 186(中间像素离边远,模糊不影响)
    assert.ok(Math.abs(gray(10) - 128) <= 2, `第 10 帧 ${gray(10)}`);
    assert.ok(Math.abs(gray(19) - 186) <= 3, `第 19 帧 ${gray(19)},sendcmd 没把亮度改上去`);
    assert.ok(gray(15) > gray(11) && gray(19) > gray(15), "亮度应当逐帧上升");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
