// Filters into export and see_frames ffmpeg chain: position in chain, per-frame command sidecar,
// and actually running ffmpeg once (sendcmd Windows path escaping, whether lutrgb /
// colorchannelmixer / gblur start up in the chain).
// How to run: node --test server/test/filter-compose.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildComposeArgs, composeLayers } from "../export-compose.mjs";
import { extractArgs, mediaLayersAt } from "../vision-compose.mjs";

const FILTERS = [
  { id: "fx-s", name: "Cool tone", ops: [{ kind: "saturate", value: 0.6 }, { kind: "hue", value: -20 }, { kind: "brightness", value: 1 }] },
  { id: "fx-a", name: "Gradual blur", ops: [{ kind: "blur", value: "4*p" }, { kind: "brightness", value: "1 + 0.5*t" }] },
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

// Input numbers: 0 background, 1 card; assets start at 2 (no frosted glass mask). c1 → 2, c2 → 3, c3 → 4
test("export: constant filters go after format=gbrap and before emphasis / opacity; neutral steps are not added to the chain", () => {
  const { graph, sidecars } = compose(project(), "C:\\out dir");
  const c1 = graph.split(";").find((s) => s.startsWith("[2:v]"));
  assert.match(c1, /format=gbrap,colorchannelmixer=rr=[^,]+,colorchannelmixer=rr=[^,]+\[m2\]$/, "saturate + hue are two steps; brightness 1 is neutral and is not added to the chain");
  assert.doesNotMatch(c1, /lutrgb/);
  // Defined filter deleted: composites as without filters, no error
  const c3 = graph.split(";").find((s) => s.startsWith("[4:v]"));
  assert.match(c3, /format=gbrap\[m4\]$/);
  assert.equal(sidecars.length, 1);
});

test("export: time-varying filters go through sendcmd, with one script line per frame and colons escaped in the path", () => {
  const { graph, sidecars } = compose(project(), "C:\\out dir");
  const c2 = graph.split(";").find((s) => s.startsWith("[3:v]"));
  assert.match(c2, /trim=start_pts=10:end_pts=20,.*format=gbrap,sendcmd=f='C\\:\/out dir\/filter-3\.cmd',premultiply/);
  // Blur 4p is max at last frame (p = 0.9): σ 3.6 → padding ceil(10.8) = 11
  assert.match(c2, /premultiply=inplace=1,pad=iw\+22:ih\+22:11:11:color=black@0,gblur@fx3_0=sigma=0:steps=6,crop=iw-22:ih-22:11:11,unpremultiply=inplace=1,lutrgb@fx3_1=/);
  const [side] = sidecars;
  assert.equal(side.file, "C:/out dir/filter-3.cmd");
  const lines = side.text.trim().split("\n");
  assert.equal(lines.length, 10, "clip spans 1~2 s, 10 frames in total at 10fps");
  assert.match(lines[0], /^0\.975 gblur@fx3_0 sigma 0, lutrgb@fx3_1 r val\*1\+0\.5,/);
  assert.match(lines[9], /^1\.875 gblur@fx3_0 sigma 3\.6, lutrgb@fx3_1 r val\*1\.45\+0\.5,/);
});

test("see_frames: the filters at this moment are translated into constants, placed after rgba and before opacity", () => {
  const layers = mediaLayersAt(project(), 1.5);
  assert.equal(layers.length, 1);
  assert.match(layers[0].filter, /^premultiply=inplace=1,pad=.*gblur=sigma=2:steps=6.*lutrgb=r=val\*1\.25\+0\.5/);
  const args = extractArgs({ file: "x.mp4", kind: "video", seconds: 0, width: 320, height: 180, opacity: 0.5, filter: layers[0].filter, out: "o.png" });
  const vf = args[args.indexOf("-vf") + 1];
  assert.match(vf, /format=rgba,premultiply=.*lutrgb=[^,]+,colorchannelmixer=aa=0\.5000$/);
  assert.equal(mediaLayersAt(project(), 2.5)[0].filter, undefined, "a filter whose definition was deleted is not added to the chain");
});

const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;

test("real ffmpeg run: the whole export chain with per-frame filters can produce a video, and sendcmd really changes the parameters", { skip: !hasFfmpeg && "No ffmpeg" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-fx-"));
  try {
    // Asset: pure mid-gray clip, easy to measure brightness; card layer: fully transparent PNG sequence
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
    // Outputs as frame-by-frame PNG instead of mp4: pixels must be measured; avoid yuv420 encoding errors
    const k = args.indexOf("-c:v");
    const pngArgs = [...args.slice(0, k), "-frames:v", "30", "-y", path.join(dir, "f%02d.png")];
    const r = spawnSync("ffmpeg", pngArgs, { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr.slice(-800));
    const gray = (i) => {
      const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path.join(dir, `f${String(i + 1).padStart(2, "0")}.png`), "-vf", "crop=1:1:160:90,format=rgb24", "-f", "rawvideo", "-"]);
      return out[0];
    };
    // Clip 2 (1-2s) brightness 1 + 0.5t: frame 10 t=0 → 128; frame 19 t=0.9 → 128×1.45 ≈ 186 (center pixels far from edge, blur has no effect)
    assert.ok(Math.abs(gray(10) - 128) <= 2, `frame 10: ${gray(10)}`);
    assert.ok(Math.abs(gray(19) - 186) <= 3, `frame 19: ${gray(19)}, sendcmd did not raise the brightness`);
    assert.ok(gray(15) > gray(11) && gray(19) > gray(15), "brightness should rise frame by frame");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
