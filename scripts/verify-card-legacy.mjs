/**
 * Acceptance check for unchanged legacy React cards through the real prerender Vite
 * configuration and Chrome beginFrame exporter.  Evidence PNGs + hashes are kept in
 * work/card-legacy so this script never changes product cards or fixtures.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { PNG } from "pngjs";
import { openBakery, bakeFrames } from "../server/bakery/index.mjs";

process.env.PROMPTCUT_ROLE = "prerender";
const root = process.cwd(), output = path.join(root, "work", "card-legacy");
await fs.mkdir(output, { recursive: true });
const port = 5201, origin = `http://127.0.0.1:${port}`;
const base = { id: "legacy-card-acceptance", name: "legacy acceptance", width: 640, height: 360, fps: 10, duration: 2,
  themeId: "default", media: [], style: {}, tracks: [{ id: "legacy", name: "legacy", clips: [] }] };
const clip = (id, cardId, params = {}) => ({ id, cardId, start: 0, end: 2, params });
const timelineUrl = (project) => `${origin}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify(project))}`)}`;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const changedPixels = (a, b) => {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b); assert.deepEqual([pa.width, pa.height], [pb.width, pb.height]);
  let changed = 0; for (let i = 0; i < pa.data.length; i += 4) if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2]) changed++;
  return changed;
};
const server = await createServer({ configFile: path.join(root, "vite.prerender.config.ts"), server: { host: "127.0.0.1", port, strictPort: true } });
let bakery;
try {
  await server.listen();
  bakery = await openBakery({ url: timelineUrl(base) });
  const capture = async (name, project, frame) => {
    await bakery.reset(project, timelineUrl(project), { deferCards: true });
    let image;
    await bakeFrames(bakery, { out: output, targetFrames: [frame], fullFrame: true, writeFrames: false, onFrame: (_n, png) => { image = png; } });
    assert.ok(image, `${name}: no PNG returned`); await fs.writeFile(path.join(output, `${name}.png`), image); return image;
  };

  // Existing `caption-track` declares frameMode:'direct'. Two cold, random seeks must be byte-identical.
  const direct = { ...base, tracks: [{ ...base.tracks[0], clips: [clip("direct", "caption-track", { lines: "0|2|直接随机访问|", showEn: false, strokeOn: false, strokeW: 0, strokeColor: "#000", position: "bottom" })] }] };
  const directLateA = await capture("direct-frame18-a", direct, 18);
  await capture("direct-frame3", direct, 3);
  const directLateB = await capture("direct-frame18-b", direct, 18);
  assert.deepEqual(directLateA, directLateB, "direct React card changed after an out-of-order seek");

  // Existing _probe deliberately uses Motion, CSS keyframes and rAF; it must replay history for every cold seek.
  const stateful = { ...base, tracks: [{ ...base.tracks[0], clips: [clip("probe", "probe")] }] };
  const stateLateA = await capture("stateful-frame15-a", stateful, 15);
  await capture("stateful-frame8", stateful, 8);
  const stateLateB = await capture("stateful-frame15-b", stateful, 15);
  assert.deepEqual(stateLateA, stateLateB, "stateful React card changed after rewind/replay");

  // Existing hud-glass (`blur-text`) sits over the existing colourful punch-pill.  Full-scene
  // captures must retain lower-layer pixels under the glass; this is not an isolated-card render.
  const glassBase = { ...base, tracks: [{ ...base.tracks[0], clips: [clip("glass", "blur-text", { text: "玻璃|仍能读取|背景", staggerMs: 0, position: "center" })] }] };
  const glassScene = { ...base, tracks: [{ ...base.tracks[0], clips: [clip("pill", "punch-pill", { text: "背景", position: "center" }), clip("glass", "blur-text", { text: "玻璃|仍能读取|背景", staggerMs: 0, position: "center" })] }] };
  const withoutBackground = await capture("glass-without-background", glassBase, 15);
  const withBackground = await capture("glass-fullscene-background", glassScene, 15);
  const changed = changedPixels(withoutBackground, withBackground);
  assert.ok(changed > 2_000, `glass full scene did not retain a meaningful lower background (${changed} pixels changed)`);

  const evidence = { direct: { frame: 18, sha256: hash(directLateA) }, stateful: { frame: 15, sha256: hash(stateLateA) }, glass: { frame: 15, changedPixels: changed, without: hash(withoutBackground), fullscene: hash(withBackground) } };
  await fs.writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("PASS legacy cards", JSON.stringify(evidence));
} finally { await bakery?.close(); await server.close(); }
